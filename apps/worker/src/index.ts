import { AiTurnJobSchema } from "@drawguessai/ai-adapters";
import { CreateRoomRequestSchema, JoinRoomRequestSchema } from "@drawguessai/network-protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import type { Env } from "./env";
import { featuredReplayAssetPath } from "./featured-replays";
import { RoomObject } from "./room";
import {
  configuredServerProfilesWithDiagnostics,
  executeServerProfile,
  publicServerProfiles
} from "./server-ai";
import { randomRoomCode } from "./tokens";

export { RoomObject };

const app = new Hono<{ Bindings: Env }>();
const MAX_API_BODY_BYTES = 2 * 1024 * 1024;

export const RoomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);

const ReplayTokenSchema = z
  .string()
  .regex(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}\.[A-Za-z0-9_-]{22}$/);

const ParticipantAuthSchema = z
  .object({
    roomId: RoomCodeSchema,
    participantId: z.string().min(1).max(80),
    reconnectToken: z.string().min(20).max(128)
  })
  .strict();

function configuredOrigin(value: string | undefined, requestUrl: string): string {
  const configured = value?.trim();
  const origin =
    configured === undefined || configured === "" ? new URL(requestUrl).origin : configured;
  const parsed = new URL(origin);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin !== parsed.href.replace(/\/$/, "")
  ) {
    throw new Error("APP_ORIGIN must be an HTTP origin without a path");
  }
  return parsed.origin;
}

function requestNetworkKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local-or-unknown";
}

async function rateLimitAllows(binding: RateLimit | undefined, key: string): Promise<boolean> {
  if (binding === undefined) return true;
  return (await binding.limit({ key })).success;
}

function rateLimitedResponse(): Response {
  return Response.json(
    { error: "rate-limited", message: "Too many requests; please try again shortly" },
    { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } }
  );
}

app.use("*", async (context, next) => {
  await next();
  context.header("x-content-type-options", "nosniff");
  context.header("referrer-policy", "no-referrer");
  context.header("x-frame-options", "DENY");
  context.header("cross-origin-opener-policy", "same-origin");
  context.header("cross-origin-resource-policy", "same-origin");
  context.header(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  );
  context.header(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https: http: ws: wss:; worker-src 'self' blob:"
  );
  if (new URL(context.req.url).protocol === "https:") {
    context.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  if (context.req.path.startsWith("/api/")) context.header("cache-control", "no-store");
});

app.use(
  "/api/*",
  bodyLimit({
    maxSize: MAX_API_BODY_BYTES,
    onError: (context) =>
      context.json(
        { error: "request-too-large", message: "Request body exceeds the API limit" },
        413
      )
  })
);

app.onError((error, context) => {
  const isValidation = error instanceof z.ZodError;
  return context.json(
    {
      error: isValidation ? "invalid-request" : "request-failed",
      message: isValidation
        ? "Request data did not match the protocol"
        : "The request could not be completed"
    },
    isValidation ? 400 : 500
  );
});

app.get("/api/health", (context) =>
  context.json({ ok: true, version: context.env.APP_VERSION, time: Date.now() })
);

app.get("/api/config", (context) => {
  const configuration = configuredServerProfilesWithDiagnostics(context.env);
  return context.json({
    version: context.env.APP_VERSION,
    serverAiProfiles: publicServerProfiles(
      configuration.profiles,
      context.env.AI !== undefined,
      configuration.workersAiProfiles
    ),
    serverAiConfigIssues: configuration.issues,
    turnConfigured:
      context.env.TURN_KEY_ID !== undefined && context.env.TURN_KEY_API_TOKEN !== undefined,
    replayDays: 7
  });
});

app.post("/api/rooms", async (context) => {
  if (
    !(await rateLimitAllows(
      context.env.ROOM_CREATION_RATE_LIMITER,
      requestNetworkKey(context.req.raw)
    ))
  ) {
    return rateLimitedResponse();
  }
  const request = CreateRoomRequestSchema.parse(await context.req.json());
  const origin = configuredOrigin(context.env.APP_ORIGIN, context.req.url);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const roomCode = randomRoomCode();
    const stub = context.env.ROOMS.getByName(roomCode);
    const response = await stub.fetch("https://room.internal/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomCode, origin, request })
    });
    if (response.status === 409) continue;
    if (!response.ok) return response;
    const body = (await response.json()) as Record<string, unknown>;
    return context.json({ ...body, inviteUrl: `${origin}/?room=${roomCode}` }, 201);
  }
  return context.json({ error: "room-code-unavailable" }, 503);
});

app.post("/api/rooms/:roomCode/join", async (context) => {
  const parsedRoomCode = RoomCodeSchema.safeParse(context.req.param("roomCode"));
  if (!parsedRoomCode.success) return context.json({ error: "room-not-found" }, 404);
  const roomCode = parsedRoomCode.data;
  if (
    !(await rateLimitAllows(
      context.env.ROOM_JOIN_RATE_LIMITER,
      `${requestNetworkKey(context.req.raw)}:${roomCode}`
    ))
  ) {
    return rateLimitedResponse();
  }
  const request = JoinRoomRequestSchema.parse(await context.req.json());
  const stub = context.env.ROOMS.getByName(roomCode);
  return stub.fetch(`${new URL(context.req.url).origin}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
});

app.get("/api/rooms/:roomCode/ws", async (context) => {
  const parsedRoomCode = RoomCodeSchema.safeParse(context.req.param("roomCode"));
  if (!parsedRoomCode.success) return context.json({ error: "room-not-found" }, 404);
  const roomCode = parsedRoomCode.data;
  if (
    !(await rateLimitAllows(
      context.env.ROOM_JOIN_RATE_LIMITER,
      `${requestNetworkKey(context.req.raw)}:${roomCode}:ws`
    ))
  ) {
    return rateLimitedResponse();
  }
  return context.env.ROOMS.getByName(roomCode).fetch(context.req.raw);
});

app.post("/api/turn-credentials", async (context) => {
  const body = ParticipantAuthSchema.parse(await context.req.json());
  if (
    !(await rateLimitAllows(
      context.env.CREDENTIAL_RATE_LIMITER,
      requestNetworkKey(context.req.raw)
    ))
  ) {
    return rateLimitedResponse();
  }
  const stub = context.env.ROOMS.getByName(body.roomId);
  const validation = await stub.fetch("https://room.internal/validate-participant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!(await validation.json<{ ok: boolean }>()).ok)
    return context.json({ error: "unauthorized" }, 401);

  if (context.env.TURN_KEY_ID === undefined || context.env.TURN_KEY_API_TOKEN === undefined) {
    return context.json({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] });
  }
  let response: Response;
  try {
    response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(context.env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${context.env.TURN_KEY_API_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ ttl: 3600 }),
        signal: AbortSignal.timeout(5_000)
      }
    );
  } catch {
    return context.json({ error: "turn-unavailable" }, 502);
  }
  if (!response.ok) return context.json({ error: "turn-unavailable" }, 502);
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
});

app.post("/api/server-ai/:profileId", async (context) => {
  const body = z
    .object({
      roomId: RoomCodeSchema,
      participantId: z.string().min(1).max(80),
      reconnectToken: z.string().min(20).max(128),
      hostToken: z.string().min(20).max(128).optional(),
      job: AiTurnJobSchema
    })
    .strict()
    .parse(await context.req.json());
  if (!(await rateLimitAllows(context.env.AI_RATE_LIMITER, requestNetworkKey(context.req.raw)))) {
    return rateLimitedResponse();
  }
  const stub = context.env.ROOMS.getByName(body.roomId);
  const authorization = await stub.fetch("https://room.internal/authorize-ai-job", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      participantId: body.participantId,
      reconnectToken: body.reconnectToken,
      jobId: body.job.jobId,
      role: body.job.role,
      profileId: context.req.param("profileId"),
      job: body.job,
      ...(body.hostToken === undefined ? {} : { hostToken: body.hostToken })
    })
  });
  if (!(await authorization.json<{ ok: boolean }>()).ok) {
    const status = authorization.status === 429 ? 429 : 401;
    return context.json(
      { error: status === 429 ? "ai-call-limit" : "unauthorized-ai-job" },
      status
    );
  }
  const configuration = configuredServerProfilesWithDiagnostics(context.env);
  const result = await executeServerProfile(
    configuration.profiles,
    context.env.AI,
    context.req.param("profileId"),
    body.job,
    configuration.workersAiProfiles
  );
  return context.json(result);
});

app.get("/api/replays/:token", async (context) => {
  const parsedToken = ReplayTokenSchema.safeParse(context.req.param("token"));
  if (!parsedToken.success) return context.json({ error: "not-found" }, 404);
  const token = parsedToken.data;
  const featuredAssetPath = featuredReplayAssetPath(token);
  if (featuredAssetPath !== undefined) {
    const assetUrl = new URL(featuredAssetPath, context.req.url);
    const assetResponse = await context.env.ASSETS.fetch(
      new Request(assetUrl, { headers: { accept: "application/json" } })
    );
    if (
      assetResponse.ok &&
      assetResponse.headers.get("content-type")?.includes("application/json")
    ) {
      return new Response(assetResponse.body, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  }
  const roomId = token.slice(0, 8);
  return context.env.ROOMS.getByName(roomId).fetch(
    `https://room.internal/replay?token=${encodeURIComponent(token)}`
  );
});

app.delete("/api/replays/:token", async (context) => {
  const parsedToken = ReplayTokenSchema.safeParse(context.req.param("token"));
  if (!parsedToken.success) return context.json({ error: "not-found" }, 404);
  const roomId = parsedToken.data.slice(0, 8);
  const body = z
    .object({ hostToken: z.string().min(20).max(128) })
    .strict()
    .parse(await context.req.json());
  return context.env.ROOMS.getByName(roomId).fetch("https://room.internal/replay", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
});

app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

export default app;
