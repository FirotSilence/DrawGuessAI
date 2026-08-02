import {
  AiPersonaCustomizationSchema,
  AiTurnJobSchema,
  AiTurnResultSchema,
  ModelCapabilitiesSchema
} from "@drawguessai/ai-adapters";
import {
  CanvasCommandSchema,
  CanvasMarkCommandSchema,
  PointSchema
} from "@drawguessai/canvas-protocol";
import {
  GameConfigSchema,
  POST_GAME_REVIEW_GENERATED_TEXT_LIMIT,
  PostGameReviewSchema,
  PromptMetadataSchema,
  QuickReactionSchema,
  TimelineSlotSchema
} from "@drawguessai/game-core";
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const VisibilitySchema = z.enum([
  "public",
  "active",
  "acted",
  "spectators",
  "reveal",
  "ai-executor"
]);

export const GameEnvelopeSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    roomId: z.string().min(1).max(100),
    seq: z.number().int().nonnegative(),
    eventId: z.string().min(1).max(100),
    actorId: z.string().min(1).max(100),
    visibility: VisibilitySchema,
    type: z.string().min(1).max(100),
    payload: z.unknown(),
    sentAt: z.number().int().nonnegative()
  })
  .strict();

export const PublicAiSeatSchema = z
  .object({
    seatId: z.string().min(1).max(80),
    profileId: z.string().min(1).max(80),
    displayName: z.string().min(1).max(40),
    personaId: z.string().min(1).max(60),
    personaCustomization: AiPersonaCustomizationSchema.optional(),
    capabilities: ModelCapabilitiesSchema,
    execution: z.enum(["local", "server", "demo"]),
    ready: z.boolean()
  })
  .strict();

export const AiActivitySchema = z
  .object({
    jobId: z.string().min(1).max(100),
    seatId: z.string().min(1).max(80),
    modelLabel: z.string().min(1).max(80),
    role: z.enum(["prompt", "draw", "guess"]),
    stage: z.enum([
      "queued",
      "planning",
      "requesting",
      "retrying",
      "inspecting",
      "refining",
      "validating",
      "complete"
    ]),
    observationIndex: z.number().int().min(0).max(2),
    observationLimit: z.number().int().min(0).max(2),
    strokeCount: z.number().int().min(0).max(120),
    deadlineAt: z.number().int().nonnegative()
  })
  .strict();

export const CreateRoomRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(24),
    config: GameConfigSchema,
    aiSeats: z.array(PublicAiSeatSchema).min(1).max(12)
  })
  .strict();

export const CreateRoomResponseSchema = z
  .object({
    roomId: z.string(),
    roomCode: z.string().length(8),
    inviteUrl: z.string(),
    participantId: z.string(),
    reconnectToken: z.string(),
    hostToken: z.string()
  })
  .strict();

export const JoinRoomRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(24),
    joinAs: z.enum(["player", "spectator"])
  })
  .strict();

export const JoinRoomResponseSchema = z
  .object({
    roomId: z.string(),
    participantId: z.string(),
    reconnectToken: z.string(),
    websocketUrl: z.string()
  })
  .strict();

export const GameStartPromptSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("curated") }).strict(),
  z.object({ source: z.literal("generated") }).strict(),
  z
    .object({
      source: z.literal("custom"),
      text: z.string().trim().min(1).max(160),
      metadata: PromptMetadataSchema
    })
    .strict()
]);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("room.resume"), reconnectToken: z.string() }).strict(),
  z.object({ type: z.literal("room.leave") }).strict(),
  z
    .object({
      type: z.literal("room.configure"),
      config: GameConfigSchema,
      timeline: z.array(TimelineSlotSchema).min(4).max(12),
      aiSeats: z.array(PublicAiSeatSchema).min(1).max(12).optional(),
      hostToken: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal("room.transfer-host"),
      participantId: z.string(),
      hostToken: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal("game.start"),
      hostToken: z.string(),
      prompt: GameStartPromptSchema.optional()
    })
    .strict(),
  z.object({ type: z.literal("game.restart"), hostToken: z.string() }).strict(),
  z
    .object({
      type: z.literal("prompt.select"),
      text: z.string().min(1).max(160),
      metadata: PromptMetadataSchema,
      hostToken: z.string()
    })
    .strict(),
  z.object({ type: z.literal("turn.inspect") }).strict(),
  z.object({ type: z.literal("turn.resume") }).strict(),
  z
    .object({
      type: z.literal("turn.submit-drawing"),
      commands: z.array(CanvasCommandSchema).max(132)
    })
    .strict(),
  z
    .object({
      type: z.literal("turn.save-drawing"),
      commands: z.array(CanvasCommandSchema).max(131)
    })
    .strict(),
  z
    .object({ type: z.literal("turn.submit-guess"), text: z.string().trim().min(1).max(80) })
    .strict(),
  z.object({ type: z.literal("turn.advance") }).strict(),
  z.object({ type: z.literal("reaction.send"), reaction: QuickReactionSchema }).strict(),
  z
    .object({
      type: z.literal("postgame.review"),
      review: PostGameReviewSchema.omit({ at: true }).extend({
        text: z.string().min(1).max(POST_GAME_REVIEW_GENERATED_TEXT_LIMIT)
      }),
      hostToken: z.string()
    })
    .strict(),
  z.object({ type: z.literal("ai.claim"), jobId: z.string() }).strict(),
  z.object({ type: z.literal("ai.release"), jobId: z.string() }).strict(),
  z.object({ type: z.literal("ai.activity"), activity: AiActivitySchema }).strict(),
  z
    .object({
      type: z.literal("ai.failure"),
      jobId: z.string().min(1).max(100),
      errorCode: z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .min(1)
        .max(80)
    })
    .strict(),
  z.object({ type: z.literal("ai.result"), result: AiTurnResultSchema }).strict(),
  z
    .object({ type: z.literal("signal.offer"), peerId: z.string(), sdp: z.string().max(100_000) })
    .strict(),
  z
    .object({ type: z.literal("signal.answer"), peerId: z.string(), sdp: z.string().max(100_000) })
    .strict(),
  z
    .object({
      type: z.literal("signal.ice"),
      peerId: z.string(),
      candidate: z.string().max(10_000),
      sdpMid: z.string().nullable(),
      sdpMLineIndex: z.number().int().nullable()
    })
    .strict(),
  z.object({ type: z.literal("preview.cursor"), point: PointSchema.nullable() }).strict(),
  z
    .object({
      type: z.literal("preview.stroke"),
      command: CanvasMarkCommandSchema,
      generation: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({ type: z.literal("preview.clear"), generation: z.number().int().nonnegative() })
    .strict(),
  z.object({ type: z.literal("ping"), nonce: z.string().max(80) }).strict()
]);

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("room.snapshot"),
      state: z.unknown(),
      peers: z.array(z.object({ id: z.string(), displayName: z.string(), role: z.string() })),
      aiSeats: z.array(PublicAiSeatSchema).max(12).optional(),
      automated: z.boolean().optional(),
      automatedNextRunAt: z.number().int().nonnegative().optional()
    })
    .strict(),
  z.object({ type: z.literal("room.event"), envelope: GameEnvelopeSchema }).strict(),
  z.object({ type: z.literal("room.ack"), eventId: z.string(), seq: z.number().int() }).strict(),
  z
    .object({
      type: z.literal("room.error"),
      code: z.string(),
      message: z.string(),
      recoverable: z.boolean()
    })
    .strict(),
  z.object({ type: z.literal("room.host-token"), hostToken: z.string() }).strict(),
  z.object({ type: z.literal("signal.offer"), peerId: z.string(), sdp: z.string() }).strict(),
  z.object({ type: z.literal("signal.answer"), peerId: z.string(), sdp: z.string() }).strict(),
  z
    .object({
      type: z.literal("signal.ice"),
      peerId: z.string(),
      candidate: z.string(),
      sdpMid: z.string().nullable(),
      sdpMLineIndex: z.number().int().nullable()
    })
    .strict(),
  z
    .object({
      type: z.literal("preview.cursor"),
      peerId: z.string(),
      point: PointSchema.nullable()
    })
    .strict(),
  z
    .object({
      type: z.literal("preview.stroke"),
      peerId: z.string(),
      command: CanvasMarkCommandSchema,
      generation: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      type: z.literal("preview.clear"),
      peerId: z.string(),
      generation: z.number().int().nonnegative()
    })
    .strict(),
  z.object({ type: z.literal("ai.activity"), activity: AiActivitySchema }).strict(),
  z.object({ type: z.literal("ai.job"), seatId: z.string(), job: AiTurnJobSchema }).strict(),
  z.object({ type: z.literal("pong"), nonce: z.string(), serverTime: z.number().int() }).strict()
]);

export type Visibility = z.infer<typeof VisibilitySchema>;
export type GameEnvelope = z.infer<typeof GameEnvelopeSchema>;
export type PublicAiSeat = z.infer<typeof PublicAiSeatSchema>;
export type AiActivity = z.infer<typeof AiActivitySchema>;
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;
export type JoinRoomRequest = z.infer<typeof JoinRoomRequestSchema>;
export type JoinRoomResponse = z.infer<typeof JoinRoomResponseSchema>;
export type GameStartPrompt = z.infer<typeof GameStartPromptSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
