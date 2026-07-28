import { CanvasCommandSchema, type CanvasCommand } from "@drawguessai/canvas-protocol";
import { z } from "zod";

import { GameConfigSchema, type GameConfig } from "./config";
import { TimelineSlotSchema, type TimelineSlot } from "./schedule";

export const PromptKindSchema = z.enum([
  "word",
  "phrase",
  "idiom",
  "proverb",
  "poem-line",
  "xiehouyu"
]);

export const PROMPT_TOPICS = [
  "daily-object",
  "animal",
  "person",
  "action",
  "daily-life",
  "nature",
  "weather",
  "sport",
  "food",
  "fruit",
  "transport",
  "travel",
  "festival",
  "culture",
  "history",
  "emotion",
  "learning",
  "wisdom",
  "other"
] as const;

export const PromptTopicSchema = z.enum(PROMPT_TOPICS);

export const PromptMetadataSchema = z
  .object({
    language: z.enum(["zh-CN", "en"]),
    kind: PromptKindSchema,
    length: z.number().int().min(1).max(80),
    topic: PromptTopicSchema.optional()
  })
  .strict();

export type PromptKind = z.infer<typeof PromptKindSchema>;
export type PromptTopic = z.infer<typeof PromptTopicSchema>;
export type PromptMetadata = z.infer<typeof PromptMetadataSchema>;

export function createPromptMetadata(
  text: string,
  language: PromptMetadata["language"],
  kind: PromptKind = "phrase",
  topic?: PromptTopic
): PromptMetadata {
  const compact = text.trim();
  const length =
    language === "zh-CN"
      ? Array.from(compact.replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()《》〈〉]/g, "")).length
      : compact.split(/\s+/).filter(Boolean).length;
  return PromptMetadataSchema.parse({
    language,
    kind,
    length: Math.max(1, length),
    ...(topic === undefined ? {} : { topic })
  });
}

export function applyTopicHintSetting(
  metadata: PromptMetadata,
  showTopicHint: boolean
): PromptMetadata {
  if (showTopicHint || metadata.topic === undefined) return metadata;
  return {
    language: metadata.language,
    kind: metadata.kind,
    length: metadata.length
  };
}

export const GamePhaseSchema = z.enum([
  "lobby",
  "prompt",
  "turn",
  "inspect",
  "reaction",
  "reveal",
  "complete",
  "failed"
]);

export const GameFailureSchema = z
  .object({
    actorId: z.string().min(1).max(80),
    turnIndex: z.number().int().min(0).max(11),
    errorCode: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .min(1)
      .max(80),
    at: z.number().int().nonnegative()
  })
  .strict();

export const ParticipantSchema = z
  .object({
    id: z.string().min(1).max(80),
    displayName: z.string().min(1).max(40),
    roomRole: z.enum(["host", "player", "spectator"]),
    connected: z.boolean(),
    hasActed: z.boolean()
  })
  .strict();

export const GameArtifactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prompt"),
      turnIndex: z.literal(-1),
      actorId: z.string().min(1).max(80),
      text: z.string().min(1).max(160),
      metadata: PromptMetadataSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("drawing"),
      turnIndex: z.number().int().min(0).max(11),
      actorId: z.string().min(1).max(80),
      commands: z.array(CanvasCommandSchema).max(132),
      canvasHash: z.string().length(8)
    })
    .strict(),
  z
    .object({
      kind: z.literal("guess"),
      turnIndex: z.number().int().min(0).max(11),
      actorId: z.string().min(1).max(80),
      text: z.string().min(1).max(80)
    })
    .strict()
]);

export const QuickReactionSchema = z.enum([
  "applause",
  "egg",
  "laugh",
  "confused",
  "spark",
  "heart"
]);

export const ReactionRecordSchema = z
  .object({
    id: z.string().min(1).max(80),
    actorId: z.string().min(1).max(80),
    turnIndex: z.number().int().min(0).max(11),
    reaction: QuickReactionSchema,
    text: z.string().max(80).optional(),
    at: z.number().int().nonnegative()
  })
  .strict();

export const PostGameActionSchema = z
  .object({
    targetSeatId: z.string().min(1).max(80),
    targetDisplayName: z.string().min(1).max(40),
    targetTurnIndex: z.number().int().min(0).max(11).optional(),
    reaction: QuickReactionSchema,
    text: z.string().min(1).max(80)
  })
  .strict();

export const POST_GAME_REVIEW_TEXT_LIMIT = 1_000;

export const PostGameReviewSchema = z
  .object({
    id: z.string().min(1).max(100),
    seatId: z.string().min(1).max(80),
    personaId: z.string().min(1).max(60),
    displayName: z.string().min(1).max(40),
    modelLabel: z.string().min(1).max(80),
    text: z.string().min(1).max(POST_GAME_REVIEW_TEXT_LIMIT),
    score: z.number().int().min(1).max(5),
    reaction: QuickReactionSchema,
    status: z.enum(["generated", "departed"]).optional(),
    errorCode: z.string().min(1).max(80).optional(),
    replyToSeatId: z.string().min(1).max(80).optional(),
    actions: z.array(PostGameActionSchema).max(3).optional(),
    at: z.number().int().nonnegative()
  })
  .strict();

export const GameEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("player.joined"),
      id: z.string(),
      at: z.number().int(),
      participant: ParticipantSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("player.left"),
      id: z.string(),
      at: z.number().int(),
      participantId: z.string().min(1).max(80)
    })
    .strict(),
  z
    .object({
      type: z.literal("player.connection"),
      id: z.string(),
      at: z.number().int(),
      participantId: z.string(),
      connected: z.boolean()
    })
    .strict(),
  z
    .object({
      type: z.literal("player.host-transferred"),
      id: z.string(),
      at: z.number().int(),
      fromParticipantId: z.string(),
      toParticipantId: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal("room.configured"),
      id: z.string(),
      at: z.number().int(),
      config: GameConfigSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("timeline.configured"),
      id: z.string(),
      at: z.number().int(),
      timeline: z.array(TimelineSlotSchema).min(4).max(12)
    })
    .strict(),
  z.object({ type: z.literal("game.started"), id: z.string(), at: z.number().int() }).strict(),
  z
    .object({
      type: z.literal("prompt.selected"),
      id: z.string(),
      at: z.number().int(),
      actorId: z.string(),
      text: z.string().min(1).max(160),
      metadata: PromptMetadataSchema.optional()
    })
    .strict(),
  z.object({ type: z.literal("turn.inspect"), id: z.string(), at: z.number().int() }).strict(),
  z.object({ type: z.literal("turn.resumed"), id: z.string(), at: z.number().int() }).strict(),
  z
    .object({
      type: z.literal("drawing.submitted"),
      id: z.string(),
      at: z.number().int(),
      actorId: z.string(),
      commands: z.array(CanvasCommandSchema),
      canvasHash: z.string().length(8)
    })
    .strict(),
  z
    .object({
      type: z.literal("guess.submitted"),
      id: z.string(),
      at: z.number().int(),
      actorId: z.string(),
      text: z.string().min(1).max(80)
    })
    .strict(),
  z
    .object({
      type: z.literal("reaction.sent"),
      id: z.string(),
      at: z.number().int(),
      reaction: ReactionRecordSchema
    })
    .strict(),
  z.object({ type: z.literal("turn.advanced"), id: z.string(), at: z.number().int() }).strict(),
  z.object({ type: z.literal("game.revealed"), id: z.string(), at: z.number().int() }).strict(),
  z
    .object({
      type: z.literal("game.failed"),
      id: z.string(),
      at: z.number().int().nonnegative(),
      actorId: z.string().min(1).max(80),
      turnIndex: z.number().int().min(0).max(11),
      errorCode: z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .min(1)
        .max(80)
    })
    .strict(),
  z
    .object({
      type: z.literal("postgame.reviewed"),
      id: z.string(),
      at: z.number().int(),
      review: PostGameReviewSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("game.completed"),
      id: z.string(),
      at: z.number().int(),
      replayToken: z.string().min(20).max(200)
    })
    .strict(),
  z
    .object({
      type: z.literal("game.restarted"),
      id: z.string(),
      at: z.number().int(),
      seed: z.string().min(1).max(120)
    })
    .strict()
]);

export interface GameState {
  protocolVersion: 1;
  roomId: string;
  seed: string;
  config: GameConfig;
  phase: z.infer<typeof GamePhaseSchema>;
  seq: number;
  participants: z.infer<typeof ParticipantSchema>[];
  timeline: TimelineSlot[];
  turnIndex: number;
  artifacts: z.infer<typeof GameArtifactSchema>[];
  promptMetadata?: PromptMetadata;
  reactions: z.infer<typeof ReactionRecordSchema>[];
  postGameReviews: z.infer<typeof PostGameReviewSchema>[];
  appliedEventIds: string[];
  replayToken?: string;
  failure?: z.infer<typeof GameFailureSchema>;
  createdAt: number;
  updatedAt: number;
}

export type Participant = z.infer<typeof ParticipantSchema>;
export type GameArtifact = z.infer<typeof GameArtifactSchema>;
export type QuickReaction = z.infer<typeof QuickReactionSchema>;
export type ReactionRecord = z.infer<typeof ReactionRecordSchema>;
export type PostGameAction = z.infer<typeof PostGameActionSchema>;
export type PostGameReview = z.infer<typeof PostGameReviewSchema>;
export type GameEvent = z.infer<typeof GameEventSchema>;

export function postGameReviewId(
  state: Pick<GameState, "roomId" | "seed">,
  actorId: string
): string {
  return `review_${state.roomId}_${state.seed}_${actorId}`.slice(0, 100);
}

export function createInitialGameState(
  roomId: string,
  seed: string,
  config: GameConfig,
  createdAt: number
): GameState {
  return {
    protocolVersion: 1,
    roomId,
    seed,
    config: GameConfigSchema.parse(config),
    phase: "lobby",
    seq: 0,
    participants: [],
    timeline: [],
    turnIndex: 0,
    artifacts: [],
    reactions: [],
    postGameReviews: [],
    appliedEventIds: [],
    createdAt,
    updatedAt: createdAt
  };
}

function ensurePhase(state: GameState, allowed: GameState["phase"][], event: GameEvent): void {
  if (!allowed.includes(state.phase)) {
    throw new Error(`Event ${event.type} is invalid during ${state.phase}`);
  }
}

function markActorAsActed(participants: Participant[], actorId: string): Participant[] {
  return participants.map((participant) =>
    participant.id === actorId ? { ...participant, hasActed: true } : participant
  );
}

export function applyGameEvent(state: GameState, rawEvent: GameEvent): GameState {
  const event = GameEventSchema.parse(rawEvent);
  if (state.appliedEventIds.includes(event.id)) {
    return state;
  }

  const next: GameState = {
    ...state,
    seq: state.seq + 1,
    updatedAt: event.at,
    participants: [...state.participants],
    timeline: [...state.timeline],
    artifacts: [...state.artifacts],
    reactions: [...state.reactions],
    postGameReviews: [...(state.postGameReviews ?? [])],
    appliedEventIds: [...state.appliedEventIds.slice(-511), event.id]
  };

  switch (event.type) {
    case "player.joined": {
      if (state.phase !== "lobby" && event.participant.roomRole !== "spectator") {
        ensurePhase(state, ["lobby"], event);
      }
      const existing = next.participants.findIndex(
        (participant) => participant.id === event.participant.id
      );
      if (existing >= 0) {
        next.participants[existing] = event.participant;
      } else {
        next.participants.push(event.participant);
      }
      return next;
    }
    case "player.left": {
      const departing = state.participants.find(
        (participant) => participant.id === event.participantId
      );
      if (state.phase !== "lobby" && departing?.roomRole !== "spectator") {
        ensurePhase(state, ["lobby"], event);
      }
      next.participants = next.participants.filter(
        (participant) => participant.id !== event.participantId
      );
      next.timeline = next.timeline.filter((slot) => slot.actorId !== event.participantId);
      return next;
    }
    case "player.connection": {
      next.participants = next.participants.map((participant) =>
        participant.id === event.participantId
          ? { ...participant, connected: event.connected }
          : participant
      );
      return next;
    }
    case "player.host-transferred": {
      next.participants = next.participants.map((participant) => {
        if (participant.id === event.fromParticipantId) {
          return { ...participant, roomRole: "player" as const };
        }
        if (participant.id === event.toParticipantId) {
          return { ...participant, roomRole: "host" as const };
        }
        return participant;
      });
      return next;
    }
    case "room.configured": {
      ensurePhase(state, ["lobby"], event);
      next.config = event.config;
      return next;
    }
    case "timeline.configured": {
      ensurePhase(state, ["lobby"], event);
      next.timeline = event.timeline;
      return next;
    }
    case "game.started": {
      ensurePhase(state, ["lobby"], event);
      if (state.timeline.length !== state.config.rules.chainLength) {
        throw new Error("Timeline must match configured chain length");
      }
      next.phase = "prompt";
      return next;
    }
    case "prompt.selected": {
      ensurePhase(state, ["prompt"], event);
      next.artifacts.push({
        kind: "prompt",
        turnIndex: -1,
        actorId: event.actorId,
        text: event.text,
        ...(event.metadata === undefined ? {} : { metadata: event.metadata })
      });
      if (event.metadata !== undefined) next.promptMetadata = event.metadata;
      next.phase = "turn";
      return next;
    }
    case "turn.inspect": {
      ensurePhase(state, ["turn"], event);
      next.phase = "inspect";
      return next;
    }
    case "turn.resumed": {
      ensurePhase(state, ["inspect"], event);
      next.phase = "turn";
      return next;
    }
    case "drawing.submitted": {
      ensurePhase(state, ["turn", "inspect"], event);
      const slot = state.timeline[state.turnIndex];
      if (slot?.role !== "draw" || slot.actorId !== event.actorId) {
        throw new Error("Drawing submission does not match the active slot");
      }
      next.artifacts.push({
        kind: "drawing",
        turnIndex: state.turnIndex,
        actorId: event.actorId,
        commands: event.commands as CanvasCommand[],
        canvasHash: event.canvasHash
      });
      next.participants = markActorAsActed(next.participants, event.actorId);
      next.phase = "reaction";
      return next;
    }
    case "guess.submitted": {
      ensurePhase(state, ["turn"], event);
      const slot = state.timeline[state.turnIndex];
      if (slot?.role !== "guess" || slot.actorId !== event.actorId) {
        throw new Error("Guess submission does not match the active slot");
      }
      next.artifacts.push({
        kind: "guess",
        turnIndex: state.turnIndex,
        actorId: event.actorId,
        text: event.text
      });
      next.participants = markActorAsActed(next.participants, event.actorId);
      next.phase = "reaction";
      return next;
    }
    case "reaction.sent": {
      ensurePhase(state, ["turn", "inspect", "reaction", "reveal"], event);
      next.reactions.push(event.reaction);
      return next;
    }
    case "turn.advanced": {
      ensurePhase(state, ["reaction"], event);
      if (state.turnIndex + 1 >= state.timeline.length) {
        next.phase = "reveal";
      } else {
        next.turnIndex = state.turnIndex + 1;
        next.phase = "turn";
      }
      return next;
    }
    case "game.revealed": {
      ensurePhase(state, ["reveal"], event);
      return next;
    }
    case "game.failed": {
      ensurePhase(state, ["turn", "inspect"], event);
      next.phase = "failed";
      next.failure = {
        actorId: event.actorId,
        turnIndex: event.turnIndex,
        errorCode: event.errorCode,
        at: event.at
      };
      return next;
    }
    case "postgame.reviewed": {
      ensurePhase(state, ["reveal", "complete"], event);
      if (!next.postGameReviews.some((review) => review.seatId === event.review.seatId)) {
        next.postGameReviews.push(event.review);
      }
      return next;
    }
    case "game.completed": {
      ensurePhase(state, ["reveal"], event);
      next.phase = "complete";
      next.replayToken = event.replayToken;
      return next;
    }
    case "game.restarted": {
      ensurePhase(state, ["complete", "failed"], event);
      next.seed = event.seed;
      next.phase = "lobby";
      next.turnIndex = 0;
      next.artifacts = [];
      delete next.promptMetadata;
      next.reactions = [];
      next.postGameReviews = [];
      next.participants = next.participants.map((participant) => ({
        ...participant,
        hasActed: false
      }));
      delete next.replayToken;
      delete next.failure;
      return next;
    }
  }
}

export function replayGame(initial: GameState, events: readonly GameEvent[]): GameState {
  return events.reduce(applyGameEvent, initial);
}

export function hashGameState(state: GameState): string {
  const normalized = JSON.stringify({ ...state, appliedEventIds: [] });
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
