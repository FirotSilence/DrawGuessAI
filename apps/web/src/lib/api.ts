import {
  AiTurnResultSchema,
  ModelCapabilitiesSchema,
  type AiTurnJob,
  type AiTurnResult
} from "@drawguessai/ai-adapters";
import {
  CreateRoomResponseSchema,
  JoinRoomResponseSchema,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type JoinRoomRequest,
  type JoinRoomResponse
} from "@drawguessai/network-protocol";
import { z } from "zod";

export const AppConfigSchema = z
  .object({
    version: z.string(),
    serverAiProfiles: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        capabilities: ModelCapabilitiesSchema,
        execution: z.literal("server")
      })
    ),
    serverAiConfigIssues: z
      .array(
        z
          .object({
            source: z.enum(["scalar", "profiles-json", "legacy-minimax", "workers-ai-json"]),
            code: z.string().min(1).max(80),
            index: z.number().int().min(0).optional(),
            path: z.string().max(120).optional()
          })
          .strict()
      )
      .default([]),
    turnConfigured: z.boolean(),
    replayDays: z.number().int(),
    automatedRoomCode: z.string().length(8).optional()
  })
  .strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const MatchSummarySchema = z
  .object({
    token: z.string().min(20).max(200),
    roomId: z.string().min(1).max(100),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().optional(),
    permanent: z.boolean(),
    likeCount: z.number().int().nonnegative(),
    liked: z.boolean(),
    mode: z.enum(["ai-theatre", "blind-relay"]),
    locale: z.enum(["zh-CN", "en"]),
    prompt: z.string().min(1).max(160),
    playerCount: z.number().int().min(1).max(12),
    turnCount: z.number().int().min(1).max(12)
  })
  .strict();

export const MatchPageSchema = z
  .object({
    items: z.array(MatchSummarySchema),
    nextCursor: z.string().optional()
  })
  .strict();

export const AutomatedRoomSchema = z
  .object({
    roomCode: z.string().length(8),
    available: z.boolean(),
    status: z.enum(["not-initialized", "scheduled", "running", "retrying", "settling"]),
    nextRunAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative().optional(),
    attempt: z.number().int().positive().optional(),
    error: z.string().optional(),
    phase: z.string().optional(),
    replayToken: z.string().min(20).max(200).optional()
  })
  .strict();

export type MatchSummary = z.infer<typeof MatchSummarySchema>;
export type MatchPage = z.infer<typeof MatchPageSchema>;
export type AutomatedRoom = z.infer<typeof AutomatedRoomSchema>;

const MATCH_VIEWER_ID_KEY = "drawguessai:match-viewer-id";

function matchViewerId(): string {
  let storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  try {
    const candidate = globalThis.localStorage;
    if (typeof candidate?.getItem === "function" && typeof candidate?.setItem === "function") {
      storage = candidate;
    }
  } catch {
    storage = undefined;
  }
  const existing = storage?.getItem(MATCH_VIEWER_ID_KEY) ?? null;
  if (existing !== null && /^[A-Za-z0-9_-]{16,96}$/.test(existing)) return existing;
  const value = crypto.randomUUID();
  storage?.setItem(MATCH_VIEWER_ID_KEY, value);
  return value;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
    };
    throw new ApiRequestError(
      response.status,
      payload.error,
      payload.message ?? payload.error ?? `Request failed with ${response.status}`
    );
  }
  return (await response.json()) as T;
}

export async function fetchAppConfig(): Promise<AppConfig> {
  return AppConfigSchema.parse(await jsonRequest<unknown>("/api/config"));
}

export async function createRoom(request: CreateRoomRequest): Promise<CreateRoomResponse> {
  return CreateRoomResponseSchema.parse(
    await jsonRequest<unknown>("/api/rooms", { method: "POST", body: JSON.stringify(request) })
  );
}

export async function joinRoom(
  roomCode: string,
  request: JoinRoomRequest
): Promise<JoinRoomResponse> {
  return JoinRoomResponseSchema.parse(
    await jsonRequest<unknown>(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
      method: "POST",
      body: JSON.stringify(request)
    })
  );
}

export async function fetchIceServers(session: {
  roomId: string;
  participantId: string;
  reconnectToken: string;
}): Promise<RTCIceServer[]> {
  const result = await jsonRequest<{ iceServers: RTCIceServer[] }>("/api/turn-credentials", {
    method: "POST",
    body: JSON.stringify({
      roomId: session.roomId,
      participantId: session.participantId,
      reconnectToken: session.reconnectToken
    }),
    signal: AbortSignal.timeout(5_000)
  });
  return result.iceServers;
}

export async function executeServerAi(
  profileId: string,
  session: {
    roomId: string;
    participantId: string;
    reconnectToken: string;
    hostToken?: string;
  },
  job: AiTurnJob,
  signal?: AbortSignal
): Promise<AiTurnResult> {
  return AiTurnResultSchema.parse(
    await jsonRequest<unknown>(`/api/server-ai/${encodeURIComponent(profileId)}`, {
      method: "POST",
      body: JSON.stringify({
        roomId: session.roomId,
        participantId: session.participantId,
        reconnectToken: session.reconnectToken,
        ...(job.role !== "review" || session.hostToken === undefined
          ? {}
          : { hostToken: session.hostToken }),
        job
      }),
      ...(signal === undefined ? {} : { signal })
    })
  );
}

export async function fetchReplay(token: string): Promise<unknown> {
  const query = new URLSearchParams({ viewerId: matchViewerId() });
  return jsonRequest<unknown>(`/api/replays/${encodeURIComponent(token)}?${query.toString()}`);
}

export async function fetchMatches(options?: {
  limit?: number;
  cursor?: string;
}): Promise<MatchPage> {
  const query = new URLSearchParams({ viewerId: matchViewerId() });
  if (options?.limit !== undefined) query.set("limit", String(options.limit));
  if (options?.cursor !== undefined) query.set("cursor", options.cursor);
  return MatchPageSchema.parse(await jsonRequest<unknown>(`/api/matches?${query.toString()}`));
}

export async function likeMatch(token: string): Promise<MatchSummary> {
  return MatchSummarySchema.parse(
    await jsonRequest<unknown>(`/api/matches/${encodeURIComponent(token)}/like`, {
      method: "POST",
      body: JSON.stringify({ viewerId: matchViewerId() })
    })
  );
}

export async function fetchAutomatedRoom(): Promise<AutomatedRoom> {
  return AutomatedRoomSchema.parse(await jsonRequest<unknown>("/api/automated-room/status"));
}
