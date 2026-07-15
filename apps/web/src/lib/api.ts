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
    replayDays: z.number().int()
  })
  .strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;

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
  return jsonRequest<unknown>(`/api/replays/${encodeURIComponent(token)}`);
}
