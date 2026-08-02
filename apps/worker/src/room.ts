import {
  AI_DISPLAY_NAMES,
  AI_PERSONAS,
  AiTurnJobSchema,
  AiTurnResultSchema,
  buildReviewConversationContext,
  createDemoTurnResult,
  isLiveReactionSpoilerFree,
  modelSupportsRole,
  observationPassLimitForRole,
  reviewActionRespectsTargetRole,
  type AiSocialAction,
  type AiTurnJob,
  type AiTurnResult
} from "@drawguessai/ai-adapters";
import {
  hashCanvasCommands,
  hasVisibleCanvasContent,
  validateCanvasCommands,
  type CanvasCommand
} from "@drawguessai/canvas-protocol";
import {
  GameConfigSchema,
  GameEventSchema,
  DEFAULT_GAME_CONFIG,
  applyTopicHintSetting,
  aiPlaybackDurationMs,
  applyGameEvent,
  buildAiTheatreTimeline,
  buildBlindTimeline,
  createInitialGameState,
  createPromptMetadata,
  postGameReviewId,
  shuffleWithSeed,
  type GameEvent,
  type GameState,
  type Participant,
  type PostGameAction,
  type PostGameReview,
  type ReactionRecord,
  type TimelineSlot
} from "@drawguessai/game-core";
import {
  ClientMessageSchema,
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  PROTOCOL_VERSION,
  canView,
  type ClientMessage,
  type GameEnvelope,
  type PublicAiSeat,
  type ServerMessage,
  type Visibility
} from "@drawguessai/network-protocol";
import { selectPrompt, validatePlayablePromptText, type PromptEntry } from "@drawguessai/word-bank";
import { z } from "zod";

import type { Env } from "./env";
import { AUTOMATED_ROOM_CODE } from "./auto-room";
import { commandsToServerAiImageDataUrl } from "./canvas-image";
import { finalizeDrawingDraft, validateDrawingDraft } from "./drawing-draft";
import {
  configuredServerProfilesWithDiagnostics,
  executeServerProfile,
  selectAutomatedServerProfile
} from "./server-ai";
import { hashToken, randomToken, tokenMatches } from "./tokens";

interface ParticipantCredential {
  reconnectHash: string;
}

interface RoomCredentials {
  hostHash: string;
  participants: Record<string, ParticipantCredential>;
}

interface PendingAiJob {
  seatId: string;
  job: AiTurnJob;
  createdAt: number;
}

interface ArchivedAutomatedRoundtable {
  token: string;
  startedAt: number;
  completedAt: number;
  expiresAt: number;
}

interface ArchivedMatchEnvelope {
  summary: {
    token: string;
    roomId: string;
    startedAt: number;
    completedAt: number;
    expiresAt: number;
    mode: GameState["config"]["mode"];
    locale: GameState["config"]["locale"];
    prompt: string;
    playerCount: number;
    turnCount: number;
  };
  payload: {
    protocolVersion: typeof PROTOCOL_VERSION;
    roomId: string;
    expiresAt: number;
    state: GameState;
    events: readonly unknown[];
  };
}

interface PendingMatchArchiveRow {
  [key: string]: string | number;
  token: string;
  envelope: string;
  attempts: number;
  next_attempt_at: number;
}

interface RoomMeta {
  roomCode: string;
  aiSeats: PublicAiSeat[];
  aiExecutorId: string;
  pendingAiJob?: PendingAiJob;
  replayTokenHash?: string;
  replayExpiresAt?: number;
  roundEventStartSeq?: number;
  roundStartedAt?: number;
  automated?: boolean;
  automatedExecutionVersion?: number;
  automatedNameSeed?: string;
  turnExpiresAt?: number;
  promptExpiresAt?: number;
  generatedPromptAttempts?: number;
  executorReconnectDeadline?: number;
  automatedRoundtableAt?: number;
  automatedArchivedRoundtable?: ArchivedAutomatedRoundtable;
  automatedArchivedRoundtableAt?: number;
  lastReactionAt: Record<string, number>;
  reactionCountByTurn?: Record<string, number>;
  authorizedReviewJobIds?: string[];
  serverAiCalls?: Record<string, { count: number; profileId: string }>;
  automatedSpectatorDisconnects?: Record<string, number>;
  idleExpiresAt?: number;
  drawingDraft?: {
    turnIndex: number;
    actorId: string;
    commands: CanvasCommand[];
  };
}

interface SocketAttachment {
  participantId: string;
}

interface InitializePayload {
  roomCode: string;
  origin: string;
  request: unknown;
}

interface AuthPayload {
  participantId: string;
  reconnectToken: string;
  jobId?: string;
  role?: string;
  hostToken?: string;
  profileId?: string;
  job?: unknown;
}

const STATE_KEY = "room:state";
const META_KEY = "room:meta";
const CREDENTIALS_KEY = "room:credentials";
const MAX_ROOM_MEMBERS = 12;
const MAX_PLAYERS = 8;
const MAX_CLIENT_MESSAGE_BYTES = 180_000;
export const AUTOMATED_AI_TURN_TIMEOUT_SECONDS = 120;
export const AUTOMATED_SERVER_AI_TIMEOUT_MS = AUTOMATED_AI_TURN_TIMEOUT_SECONDS * 1_000;
export const AUTOMATED_DRAW_ATTEMPT_TIMEOUT_MS = 60_000;
export const AUTOMATED_GUESS_ATTEMPT_TIMEOUT_MS = 15_000;
const AUTOMATED_REAL_DRAWING_VERSION = 3;
const AUTOMATED_EXECUTION_VERSION = 8;
export const AUTOMATED_POST_GAME_REVIEW_TIMEOUT_SECONDS = 15;
const AUTOMATED_SPECTATOR_RECONNECT_GRACE_MS = 120_000;
const AUTOMATED_ROUNDTABLE_STEP_DELAY_MS = 200;
const AUTOMATED_ARCHIVE_RETRY_DELAY_MS = 10_000;
const MATCH_ARCHIVE_MAX_RETRY_DELAY_MS = 300_000;
const MATCH_ARCHIVE_DELIVERY_BATCH = 3;
export const AUTOMATED_AI_SEAT_COUNT = 8;

const AutomatedRoundtableRepairRequestSchema = z
  .object({
    token: z
      .string()
      .min(AUTOMATED_ROOM_CODE.length + 23)
      .max(200)
      .refine((token) => token.startsWith(`${AUTOMATED_ROOM_CODE}.`))
  })
  .strict();

const ArchivedAutomatedReplaySchema = z
  .object({
    roomId: z.literal(AUTOMATED_ROOM_CODE),
    expiresAt: z.number().int().nonnegative().optional(),
    state: z
      .object({
        roomId: z.literal(AUTOMATED_ROOM_CODE),
        replayToken: z.string().min(20).max(200),
        phase: z.literal("complete"),
        timeline: z
          .array(
            z
              .object({
                actorId: z.string().min(1).max(100),
                actorType: z.enum(["ai", "human"])
              })
              .passthrough()
          )
          .min(1),
        postGameReviews: z.array(z.object({ seatId: z.string().min(1).max(100) }).passthrough())
      })
      .passthrough(),
    events: z.array(z.unknown())
  })
  .passthrough();

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertDistinctAiSeats(aiSeats: readonly PublicAiSeat[]): void {
  if (new Set(aiSeats.map((seat) => seat.seatId)).size !== aiSeats.length) {
    throw new Error("Every AI seat id must be unique");
  }
}

export function authorizedTurnDerivative(base: AiTurnJob, candidate: AiTurnJob): boolean {
  if (
    candidate.jobId !== base.jobId ||
    candidate.roomId !== base.roomId ||
    candidate.turnIndex !== base.turnIndex ||
    candidate.role !== base.role ||
    candidate.locale !== base.locale ||
    candidate.personaId !== base.personaId ||
    !sameValue(candidate.personaCustomization, base.personaCustomization) ||
    candidate.actorId !== base.actorId ||
    candidate.reviewRole !== base.reviewRole ||
    !sameValue(candidate.reviewActors, base.reviewActors) ||
    candidate.inputText !== base.inputText ||
    !sameValue(candidate.promptMetadata, base.promptMetadata) ||
    candidate.timeLimitSeconds > base.timeLimitSeconds ||
    candidate.observationLimit > base.observationLimit ||
    candidate.observationIndex > candidate.observationLimit ||
    candidate.budget.maxStrokes !== base.budget.maxStrokes ||
    candidate.budget.maxUndos !== base.budget.maxUndos ||
    candidate.budget.colorCount !== base.budget.colorCount ||
    candidate.budget.remainingStrokes > base.budget.maxStrokes ||
    candidate.budget.remainingUndos > base.budget.maxUndos
  ) {
    return false;
  }
  if (base.role !== "draw") {
    return (
      candidate.observationIndex === 0 &&
      candidate.observationLimit === 0 &&
      candidate.drawPhase === undefined &&
      candidate.drawingPlan === undefined &&
      candidate.sourceCommands === undefined &&
      candidate.validationFeedback === undefined &&
      sameValue(candidate.inputCommands, base.inputCommands) &&
      (base.role === "guess" || candidate.imageDataUrl === undefined)
    );
  }
  if (candidate.drawPhase === "plan") {
    return (
      candidate.observationIndex === 0 &&
      candidate.imageDataUrl === undefined &&
      candidate.inputCommands === undefined &&
      candidate.sourceCommands === undefined &&
      candidate.validationFeedback === undefined
    );
  }
  if (candidate.drawPhase === "render") {
    return candidate.observationIndex === 0 && candidate.imageDataUrl === undefined;
  }
  return candidate.drawPhase === "inspect" && candidate.observationIndex > 0;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function errorMessage(code: string, message: string, recoverable = true): ServerMessage {
  return { type: "room.error", code, message, recoverable };
}

function eventId(): string {
  return crypto.randomUUID();
}

function normalizedAiErrorCode(value: string | undefined): string {
  const normalized = value
    ?.toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return normalized === undefined || normalized === "" ? "model-error" : normalized;
}

function promptMetadataForEntry(entry: PromptEntry, locale: GameState["config"]["locale"]) {
  return createPromptMetadata(entry.texts[locale], locale, entry.kind, entry.topic);
}

function promptMetadataForGuess(
  state: GameState,
  metadata: NonNullable<GameState["promptMetadata"]>
) {
  return applyTopicHintSetting(metadata, state.config.showTopicHint !== false);
}

function isNonPlayingHost(state: GameState, participant: Participant): boolean {
  return (
    participant.roomRole === "host" &&
    !state.timeline.some((slot) => slot.actorId === participant.id)
  );
}

function automatedReviewRole(
  state: Pick<GameState, "timeline">,
  actorId: string
): NonNullable<AiTurnJob["reviewRole"]> {
  const roles = new Set(
    state.timeline.filter((slot) => slot.actorId === actorId).map((slot) => slot.role)
  );
  if (roles.has("draw") && roles.has("guess")) return "mixed";
  return roles.has("guess") ? "guess" : "draw";
}

function automatedReviewActors(state: Pick<GameState, "timeline">) {
  return [...new Map(state.timeline.map((slot) => [slot.actorId, slot] as const)).values()].map(
    (slot) => ({
      actorId: slot.actorId,
      displayName: slot.displayName,
      actorType: slot.actorType,
      turns: state.timeline
        .filter((turn) => turn.actorId === slot.actorId)
        .map((turn) => ({ index: turn.index, role: turn.role }))
    })
  );
}

function artifactForTurn(state: GameState, turnIndex: number) {
  return state.artifacts.find((artifact) => artifact.turnIndex === turnIndex);
}

function incomingTextForTurn(state: GameState, turnIndex: number): string | undefined {
  if (turnIndex === 0) {
    const prompt = state.artifacts.find((artifact) => artifact.kind === "prompt");
    return prompt?.kind === "prompt" ? prompt.text : undefined;
  }
  const artifact = artifactForTurn(state, turnIndex - 1);
  return artifact?.kind === "guess" ? artifact.text : undefined;
}

function expectedGuessTextForTurn(state: GameState, turnIndex: number): string | undefined {
  return turnIndex <= 0 ? undefined : incomingTextForTurn(state, turnIndex - 1);
}

function reviewValuesMatch(left: string | undefined, right: string | undefined): boolean {
  const normalize = (value: string | undefined) =>
    (value ?? "").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft !== "" && normalizedRight !== "" && normalizedLeft === normalizedRight;
}

function automatedContributionSucceeded(state: GameState, slot: TimelineSlot): boolean {
  if (slot.role === "draw") {
    const downstream = artifactForTurn(state, slot.index + 1);
    return reviewValuesMatch(
      incomingTextForTurn(state, slot.index),
      downstream?.kind === "guess" ? downstream.text : undefined
    );
  }
  const ownGuess = artifactForTurn(state, slot.index);
  return reviewValuesMatch(
    expectedGuessTextForTurn(state, slot.index),
    ownGuess?.kind === "guess" ? ownGuess.text : undefined
  );
}

function resolveAutomatedReviewActions(
  state: GameState,
  actorId: string,
  requested: readonly AiSocialAction[] | undefined
): PostGameAction[] {
  if (requested === undefined || requested.length === 0) return [];
  const actors = [...new Map(state.timeline.map((slot) => [slot.actorId, slot] as const)).values()];
  const positiveReactions = new Set(["applause", "heart", "spark"]);
  const actions: PostGameAction[] = [];
  const seen = new Set<string>();
  for (const action of requested) {
    const target = actors.find((candidate) => candidate.actorId === action.targetActorId);
    if (target === undefined || target.actorId === actorId || seen.has(target.actorId)) continue;
    const targetTurns = state.timeline.filter((slot) => slot.actorId === target.actorId);
    const targetTurn =
      action.targetTurnIndex === undefined
        ? targetTurns.length === 1
          ? targetTurns[0]
          : undefined
        : targetTurns.find((slot) => slot.index === action.targetTurnIndex);
    if (
      targetTurn === undefined ||
      !reviewActionRespectsTargetRole(action.text, targetTurn.role) ||
      (positiveReactions.has(action.kind) && !automatedContributionSucceeded(state, targetTurn))
    ) {
      continue;
    }
    seen.add(target.actorId);
    actions.push({
      targetSeatId: target.actorId,
      targetDisplayName: target.displayName,
      targetTurnIndex: targetTurn.index,
      reaction: action.kind,
      text: action.text.replace(/\s+/g, " ").trim().slice(0, 80)
    });
    if (actions.length === 3) break;
  }
  return actions;
}

function fallbackAutomatedReviewActions(state: GameState, actorId: string): PostGameAction[] {
  const ownIndex = state.timeline.findIndex((slot) => slot.actorId === actorId);
  const target = ownIndex < 0 ? undefined : state.timeline[(ownIndex + 1) % state.timeline.length];
  if (target === undefined) return [];
  const succeeded = automatedContributionSucceeded(state, target);
  const isDrawing = target.role === "draw";
  return [
    {
      targetSeatId: target.actorId,
      targetDisplayName: target.displayName,
      targetTurnIndex: target.index,
      reaction: succeeded ? "applause" : "confused",
      text:
        state.config.locale === "zh-CN"
          ? isDrawing
            ? succeeded
              ? "这幅画把意思接住了。"
              : "这幅画把接力带偏了。"
            : succeeded
              ? "这手猜词接住了。"
              : "这手猜词把方向带偏了。"
          : isDrawing
            ? succeeded
              ? "That drawing carried the idea through."
              : "That drawing sent the relay sideways."
            : succeeded
              ? "That guess caught the handoff."
              : "That guess sent the relay sideways."
    }
  ];
}

function automatedReviewContext(
  state: GameState,
  actorId: string,
  published: readonly PostGameReview[]
): string {
  const prompt = state.artifacts.find((artifact) => artifact.kind === "prompt");
  const originalPrompt = prompt?.kind === "prompt" ? prompt.text : "?";
  const finalArtifact = state.artifacts.at(-1);
  const finalResult =
    finalArtifact?.kind === "guess"
      ? finalArtifact.text
      : finalArtifact === undefined
        ? "?"
        : (incomingTextForTurn(state, finalArtifact.turnIndex) ?? "?");
  const ownRole = automatedReviewRole(state, actorId);
  const players = automatedReviewActors(state).map(
    (actor) =>
      `actorId=${actor.actorId},name=${JSON.stringify(actor.displayName)},roles=${actor.turns
        .map((turn) => `T${turn.index + 1}:${turn.role}`)
        .join(",")}${actor.actorId === actorId ? ",YOU" : ""}`
  );
  const handoffs = state.timeline
    .filter((slot) => slot.role === "draw")
    .map((drawer) => {
      const guesser = state.timeline[drawer.index + 1];
      const output = artifactForTurn(state, drawer.index + 1);
      return `T${drawer.index + 1} DRAW actorId=${drawer.actorId} input=${JSON.stringify(incomingTextForTurn(state, drawer.index) ?? "?")} -> T${guesser?.index === undefined ? "?" : guesser.index + 1} GUESS actorId=${guesser?.actorId ?? "?"} output=${JSON.stringify(output?.kind === "guess" ? output.text : "?")}`;
    });
  const ownTurns = state.timeline
    .filter((slot) => slot.actorId === actorId)
    .map((slot) => {
      const artifact = artifactForTurn(state, slot.index);
      return `T${slot.index + 1}:${slot.role} output=${JSON.stringify(artifact?.kind === "guess" ? artifact.text : "[drawing]")}`;
    });
  return [
    `SELF_ACTOR_ID=${actorId}`,
    `SELF ROLE: ${ownRole.toUpperCase()}`,
    ownRole === "draw"
      ? "ROLE OWNERSHIP: YOU created a drawing; the downstream guess belongs to another player."
      : "ROLE OWNERSHIP: YOU submitted a guess; the upstream drawing belongs to another player.",
    "PLAYERS:",
    ...players,
    `ORIGINAL PROMPT: ${JSON.stringify(originalPrompt)}`,
    `FINAL RESULT: ${JSON.stringify(finalResult)}`,
    "HANDOFFS:",
    ...handoffs,
    `YOUR TURNS: ${ownTurns.join(" | ")}`,
    ...buildReviewConversationContext(published, actorId)
  ]
    .join("\n")
    .slice(0, 5_600);
}

function departedAutomatedReview(
  state: GameState,
  slot: TimelineSlot,
  modelLabel: string,
  errorCode: string
): PostGameReview {
  return {
    id: postGameReviewId(state, slot.actorId),
    seatId: slot.actorId,
    personaId: slot.personaId ?? "maestro",
    displayName: slot.displayName,
    modelLabel,
    text:
      state.config.locale === "zh-CN"
        ? "AI无言以对,已退出房间(掉线/报错)"
        : "AI had nothing to say and left the room (offline/error).",
    score: 1,
    reaction: "confused",
    status: "departed",
    errorCode: normalizedAiErrorCode(errorCode),
    at: Date.now()
  };
}

export function automatedRoomConfig() {
  return GameConfigSchema.parse({
    ...DEFAULT_GAME_CONFIG,
    mode: "ai-theatre",
    locale: "zh-CN",
    promptSource: "curated",
    allowSpectators: true,
    rules: {
      ...DEFAULT_GAME_CONFIG.rules,
      chainLength: AUTOMATED_AI_SEAT_COUNT,
      guessSeconds: 30,
      aiObservationPasses: 0,
      aiPlaybackSeconds: 10,
      aiRequestTimeoutSeconds: AUTOMATED_AI_TURN_TIMEOUT_SECONDS
    }
  });
}

export function automatedAiDisplayNames(seed: string): string[] {
  return shuffleWithSeed(
    AI_DISPLAY_NAMES["zh-CN"],
    `${AUTOMATED_ROOM_CODE}:display-names:${seed}`
  ).slice(0, AUTOMATED_AI_SEAT_COUNT);
}

export class RoomObject {
  private readonly idleRoomMs: number;
  private readonly turnConfigured: boolean;
  private readonly transientRateWindows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly objectState: DurableObjectState,
    private readonly env: Env
  ) {
    const configuredIdleSeconds = Number(this.env.ROOM_IDLE_SECONDS);
    const idleSeconds =
      Number.isFinite(configuredIdleSeconds) && configuredIdleSeconds >= 300
        ? Math.min(configuredIdleSeconds, 86_400)
        : 7_200;
    this.idleRoomMs = idleSeconds * 1_000;
    this.turnConfigured =
      this.env.TURN_KEY_ID !== undefined && this.env.TURN_KEY_API_TOKEN !== undefined;
    this.objectState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_events (
        seq INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      )
    `);
    this.objectState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_match_archives (
        token TEXT PRIMARY KEY,
        envelope TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_error_code TEXT
      )
    `);
    this.objectState.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS pending_match_archives_due
      ON pending_match_archives (next_attempt_at, created_at)
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/automated/ensure") && request.method === "POST") {
      return this.ensureAutomatedRoom();
    }
    if (url.pathname.endsWith("/automated/run") && request.method === "POST") {
      return this.runAutomatedMatch();
    }
    if (url.pathname.endsWith("/automated/repair-roundtable") && request.method === "POST") {
      return this.repairArchivedAutomatedRoundtable(await request.json());
    }
    if (url.pathname.endsWith("/initialize") && request.method === "POST") {
      return this.initialize((await request.json()) as InitializePayload);
    }
    if (url.pathname.endsWith("/join") && request.method === "POST") {
      return this.join((await request.json()) as unknown, url.origin);
    }
    if (url.pathname.endsWith("/validate-participant") && request.method === "POST") {
      return this.validateParticipant((await request.json()) as AuthPayload);
    }
    if (url.pathname.endsWith("/authorize-ai-job") && request.method === "POST") {
      return this.authorizeAiJob((await request.json()) as AuthPayload);
    }
    if (url.pathname.endsWith("/replay") && request.method === "GET") {
      return this.getReplay(url.searchParams.get("token") ?? "");
    }
    if (url.pathname.endsWith("/replay") && request.method === "DELETE") {
      return this.deleteReplay((await request.json()) as { hostToken?: string });
    }
    if (url.pathname.endsWith("/ws")) {
      return this.connectWebSocket(request, url);
    }
    return jsonResponse({ error: "not-found" }, 404);
  }

  private async loadState(): Promise<GameState> {
    const state = await this.objectState.storage.get<GameState>(STATE_KEY);
    if (state === undefined) throw new Error("Room is not initialized");
    return state;
  }

  private async loadMeta(): Promise<RoomMeta> {
    const meta = await this.objectState.storage.get<RoomMeta>(META_KEY);
    if (meta === undefined) throw new Error("Room metadata is missing");
    return meta;
  }

  private async loadCredentials(): Promise<RoomCredentials> {
    const credentials = await this.objectState.storage.get<RoomCredentials>(CREDENTIALS_KEY);
    if (credentials === undefined) throw new Error("Room credentials are missing");
    return credentials;
  }

  private pendingArchiveAlarmAt(): number | undefined {
    const next = this.objectState.storage.sql
      .exec<{ next_attempt_at: number | null }>(
        "SELECT MIN(next_attempt_at) AS next_attempt_at FROM pending_match_archives"
      )
      .toArray()[0]?.next_attempt_at;
    return typeof next === "number" ? next : undefined;
  }

  private roomAlarmAt(meta: RoomMeta, preferred?: number): number | undefined {
    const pendingArchiveAt = this.pendingArchiveAlarmAt();
    const includeIdle = meta.automated !== true && pendingArchiveAt === undefined;
    const includePreferred =
      preferred !== undefined && (preferred !== meta.idleExpiresAt || includeIdle);
    const deadlines = [
      ...(includePreferred ? [preferred] : []),
      ...(includeIdle ? [meta.idleExpiresAt] : []),
      meta.executorReconnectDeadline,
      meta.turnExpiresAt,
      meta.promptExpiresAt,
      meta.automatedRoundtableAt,
      meta.automatedArchivedRoundtableAt,
      ...Object.values(meta.automatedSpectatorDisconnects ?? {}),
      pendingArchiveAt
    ].filter((deadline): deadline is number => typeof deadline === "number" && deadline > 0);
    return deadlines.length === 0 ? undefined : Math.min(...deadlines);
  }

  private async scheduleRoomAlarm(meta: RoomMeta, preferred?: number): Promise<void> {
    const deadline = this.roomAlarmAt(meta, preferred);
    if (deadline !== undefined) await this.objectState.storage.setAlarm(deadline);
  }

  private async scheduleAutomatedRoomAlarm(meta: RoomMeta): Promise<void> {
    await this.scheduleRoomAlarm(meta);
  }

  private automatedRoundtableHasMissingReviews(state: GameState): boolean {
    const reviewedSeats = new Set((state.postGameReviews ?? []).map((review) => review.seatId));
    return state.timeline.some(
      (slot) => slot.actorType === "ai" && !reviewedSeats.has(slot.actorId)
    );
  }

  private automatedRoundtableRequiresSettlement(state: GameState, meta: RoomMeta): boolean {
    return (
      meta.automated === true &&
      (state.phase === "reveal" ||
        (state.phase === "complete" && this.automatedRoundtableHasMissingReviews(state)))
    );
  }

  private async queueAutomatedRoundtable(meta: RoomMeta, at = Date.now()): Promise<void> {
    meta.automatedRoundtableAt = at;
    await this.objectState.storage.put(META_KEY, meta);
    await this.scheduleAutomatedRoomAlarm(meta);
  }

  private async queueArchivedAutomatedRoundtable(meta: RoomMeta, at = Date.now()): Promise<void> {
    meta.automatedArchivedRoundtableAt = at;
    await this.objectState.storage.put(META_KEY, meta);
    await this.scheduleAutomatedRoomAlarm(meta);
  }

  private async pruneAutomatedParticipants(
    state: GameState,
    meta: RoomMeta,
    now = Date.now(),
    forceDisconnected = false
  ): Promise<{ state: GameState; removed: boolean }> {
    if (!meta.automated) return { state, removed: false };
    const disconnects = { ...(meta.automatedSpectatorDisconnects ?? {}) };
    const expiredIds = state.participants
      .filter(
        (participant) =>
          (participant.id !== "system-auto-host" && participant.roomRole !== "spectator") ||
          (participant.roomRole === "spectator" &&
            !participant.connected &&
            (forceDisconnected || (disconnects[participant.id] ?? 0) <= now))
      )
      .map((participant) => participant.id);
    if (expiredIds.length === 0) return { state, removed: false };
    const credentials = await this.loadCredentials();
    for (const participantId of expiredIds) {
      state = await this.applyAndPersist(state, {
        type: "player.left",
        id: eventId(),
        at: now,
        participantId
      });
      delete credentials.participants[participantId];
      delete disconnects[participantId];
      for (const socket of this.objectState.getWebSockets(participantId)) {
        socket.close(1008, "Automated rooms are spectator-only");
      }
    }
    const activeParticipantIds = new Set(state.participants.map((participant) => participant.id));
    for (const participantId of Object.keys(disconnects)) {
      if (!activeParticipantIds.has(participantId)) delete disconnects[participantId];
    }
    if (Object.keys(disconnects).length === 0) {
      delete meta.automatedSpectatorDisconnects;
    } else {
      meta.automatedSpectatorDisconnects = disconnects;
    }
    await this.objectState.storage.put({
      [META_KEY]: meta,
      [CREDENTIALS_KEY]: credentials
    });
    return { state, removed: true };
  }

  private async initialize(payload: InitializePayload): Promise<Response> {
    if ((await this.objectState.storage.get(STATE_KEY)) !== undefined) {
      return jsonResponse({ error: "room-exists" }, 409);
    }
    const request = CreateRoomRequestSchema.parse(payload.request);
    if (request.config.icePolicy === "relay" && !this.turnConfigured) {
      return jsonResponse({ error: "turn-not-configured" }, 400);
    }
    assertDistinctAiSeats(request.aiSeats);
    const participatingHumans =
      request.config.mode === "blind-relay" && request.config.promptSource !== "custom" ? 1 : 0;
    const requiredAiSeats = request.config.rules.chainLength - participatingHumans;
    if (request.aiSeats.length < requiredAiSeats) {
      return jsonResponse({ error: "insufficient-ai-seats" }, 400);
    }
    const now = Date.now();
    const participantId = `p_${randomToken(12)}`;
    const reconnectToken = randomToken();
    const hostToken = randomToken();
    let state = createInitialGameState(payload.roomCode, randomToken(12), request.config, now);
    const host: Participant = {
      id: participantId,
      displayName: request.displayName,
      roomRole: "host",
      connected: false,
      hasActed: false
    };
    state = await this.applyAndPersist(state, {
      type: "player.joined",
      id: eventId(),
      at: now,
      participant: host
    });
    const timeline = this.defaultTimeline(state, request.aiSeats);
    state = await this.applyAndPersist(state, {
      type: "timeline.configured",
      id: eventId(),
      at: now,
      timeline
    });

    const idleExpiresAt = now + this.idleRoomMs;
    const meta: RoomMeta = {
      roomCode: payload.roomCode,
      aiSeats: request.aiSeats,
      aiExecutorId: participantId,
      lastReactionAt: {},
      idleExpiresAt
    };
    const credentials: RoomCredentials = {
      hostHash: await hashToken(hostToken),
      participants: {
        [participantId]: { reconnectHash: await hashToken(reconnectToken) }
      }
    };
    await this.objectState.storage.put({
      [STATE_KEY]: state,
      [META_KEY]: meta,
      [CREDENTIALS_KEY]: credentials
    });
    await this.scheduleRoomAlarm(meta, idleExpiresAt);
    return jsonResponse({
      roomId: payload.roomCode,
      roomCode: payload.roomCode,
      participantId,
      reconnectToken,
      hostToken
    });
  }

  private automatedDemoModeEnabled(): boolean {
    return this.env.AUTOMATED_DEMO_MODE?.trim().toLowerCase() === "true";
  }

  private automatedAiSeats(nameSeed: string): PublicAiSeat[] | undefined {
    const configuration = configuredServerProfilesWithDiagnostics(this.env);
    const serverProfile = selectAutomatedServerProfile(
      configuration.profiles,
      this.env.AI !== undefined,
      configuration.workersAiProfiles
    );
    const profile =
      serverProfile ??
      (this.automatedDemoModeEnabled()
        ? {
            id: "demo",
            label: "DrawGuessAI Demo",
            execution: "demo" as const,
            capabilities: {
              vision: true,
              structuredOutput: "none" as const,
              observationMode: "one-shot" as const,
              maxObservationPasses: 0,
              drawingPlanMode: "inline" as const,
              supportedRoles: ["prompt", "draw", "guess", "review"] as const
            }
          }
        : undefined);
    if (profile === undefined) return undefined;
    const displayNames = automatedAiDisplayNames(nameSeed);
    return Array.from({ length: AUTOMATED_AI_SEAT_COUNT }, (_, index) => {
      const persona = AI_PERSONAS[index % AI_PERSONAS.length]!;
      return {
        seatId: `auto-ai-${index + 1}`,
        profileId: profile.id,
        displayName: displayNames[index]!,
        personaId: persona.id,
        capabilities: profile.capabilities,
        execution: profile.execution,
        ready: true
      };
    });
  }

  private async purgeLegacyAutomatedMatches(): Promise<void> {
    try {
      await this.env.MATCHES.getByName("global").fetch("https://matches.internal/purge-room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: AUTOMATED_ROOM_CODE })
      });
    } catch {
      // A stale archive entry should not prevent the room from moving to real AI execution.
    }
  }

  private async ensureAutomatedRoom(): Promise<Response> {
    const existing = await this.objectState.storage.get<GameState>(STATE_KEY);
    if (existing !== undefined) {
      let state = existing;
      const meta = await this.loadMeta();
      if (!meta.automated) return jsonResponse({ error: "room-not-automated" }, 409);
      state = (await this.pruneAutomatedParticipants(state, meta)).state;
      const nameSeed = meta.automatedNameSeed ?? randomToken(12);
      const aiSeats = this.automatedAiSeats(nameSeed);
      if (aiSeats === undefined) return jsonResponse({ error: "automated-ai-unavailable" }, 503);
      const config = automatedRoomConfig();
      const canRefreshAiSeats =
        state.phase === "lobby" || state.phase === "complete" || state.phase === "failed";
      if (canRefreshAiSeats) {
        const requiresNameSeedUpgrade = meta.automatedNameSeed !== nameSeed;
        const previousExecutionVersion = meta.automatedExecutionVersion ?? 0;
        const requiresExecutionUpgrade =
          !this.automatedDemoModeEnabled() &&
          meta.automatedExecutionVersion !== AUTOMATED_EXECUTION_VERSION;
        const requiresRelayShapeUpgrade =
          !sameValue(state.config, config) ||
          state.timeline.length !== AUTOMATED_AI_SEAT_COUNT ||
          state.timeline.some((slot, index) => {
            const seat = aiSeats[index];
            return (
              seat === undefined ||
              slot.actorType !== "ai" ||
              slot.actorId !== seat.seatId ||
              slot.displayName !== seat.displayName ||
              slot.personaId !== seat.personaId
            );
          });
        if (
          !sameValue(meta.aiSeats, aiSeats) ||
          requiresExecutionUpgrade ||
          requiresNameSeedUpgrade
        ) {
          meta.aiSeats = aiSeats;
          meta.automatedExecutionVersion = AUTOMATED_EXECUTION_VERSION;
          meta.automatedNameSeed = nameSeed;
          await this.objectState.storage.put(META_KEY, meta);
        }
        if (requiresExecutionUpgrade && previousExecutionVersion < AUTOMATED_REAL_DRAWING_VERSION) {
          await this.purgeLegacyAutomatedMatches();
        }
        if (this.automatedRoundtableRequiresSettlement(state, meta)) {
          await this.queueAutomatedRoundtable(meta);
          return jsonResponse({
            roomCode: state.roomId,
            phase: state.phase,
            created: false,
            ...(state.replayToken === undefined ? {} : { replayToken: state.replayToken })
          });
        }
        if (
          (requiresExecutionUpgrade || requiresRelayShapeUpgrade) &&
          (state.phase === "complete" || state.phase === "failed")
        ) {
          state = await this.restartRoom(state, meta, "system-auto-host");
        }
        if (state.phase === "lobby" && requiresRelayShapeUpgrade) {
          state = await this.applyAndBroadcast(
            state,
            { type: "room.configured", id: eventId(), at: Date.now(), config },
            "public",
            "system-auto-host"
          );
          state = await this.applyAndBroadcast(
            state,
            {
              type: "timeline.configured",
              id: eventId(),
              at: Date.now(),
              timeline: this.defaultTimeline(state, aiSeats)
            },
            "public",
            "system-auto-host"
          );
        }
      }
      return jsonResponse({
        roomCode: state.roomId,
        phase: state.phase,
        created: false,
        ...(state.replayToken === undefined ? {} : { replayToken: state.replayToken })
      });
    }
    const nameSeed = randomToken(12);
    const aiSeats = this.automatedAiSeats(nameSeed);
    if (aiSeats === undefined) return jsonResponse({ error: "automated-ai-unavailable" }, 503);
    const now = Date.now();
    const config = automatedRoomConfig();
    let state = createInitialGameState(AUTOMATED_ROOM_CODE, randomToken(12), config, now);
    const host: Participant = {
      id: "system-auto-host",
      displayName: "DrawGuessAI Auto Host",
      roomRole: "host",
      connected: false,
      hasActed: false
    };
    state = await this.applyAndPersist(state, {
      type: "player.joined",
      id: eventId(),
      at: now,
      participant: host
    });
    state = await this.applyAndPersist(state, {
      type: "timeline.configured",
      id: eventId(),
      at: now,
      timeline: this.defaultTimeline(state, aiSeats)
    });
    const hostToken = randomToken();
    await this.objectState.storage.put({
      [META_KEY]: {
        roomCode: AUTOMATED_ROOM_CODE,
        aiSeats,
        aiExecutorId: host.id,
        lastReactionAt: {},
        automated: true,
        automatedExecutionVersion: AUTOMATED_EXECUTION_VERSION,
        automatedNameSeed: nameSeed
      } satisfies RoomMeta,
      [CREDENTIALS_KEY]: {
        hostHash: await hashToken(hostToken),
        participants: {
          [host.id]: { reconnectHash: await hashToken(randomToken()) }
        }
      } satisfies RoomCredentials
    });
    return jsonResponse({ roomCode: state.roomId, phase: state.phase, created: true });
  }

  private async repairArchivedAutomatedRoundtable(raw: unknown): Promise<Response> {
    const { token } = AutomatedRoundtableRepairRequestSchema.parse(raw);
    if ((await this.objectState.storage.get<GameState>(STATE_KEY)) === undefined) {
      const ensured = await this.ensureAutomatedRoom();
      if (!ensured.ok) return ensured;
    }
    const meta = await this.loadMeta();
    if (!meta.automated) return jsonResponse({ error: "room-not-automated" }, 409);
    if (meta.automatedArchivedRoundtable !== undefined) {
      return jsonResponse({
        pending: true,
        token: meta.automatedArchivedRoundtable.token
      });
    }

    const response = await this.env.MATCHES.getByName("global").fetch(
      `https://matches.internal/replay/${encodeURIComponent(token)}`
    );
    if (!response.ok) return jsonResponse({ pending: false, error: "replay-not-found" }, 404);
    const parsed = ArchivedAutomatedReplaySchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.state.replayToken !== token) {
      return jsonResponse({ pending: false, error: "invalid-automated-replay" }, 409);
    }
    const state = parsed.data.state as unknown as GameState;
    if (!this.automatedRoundtableHasMissingReviews(state)) {
      return jsonResponse({ pending: false, complete: true });
    }

    const now = Date.now();
    meta.automatedArchivedRoundtable = {
      token,
      startedAt: Number.isSafeInteger(state.createdAt) ? state.createdAt : now,
      completedAt: Number.isSafeInteger(state.updatedAt) ? state.updatedAt : now,
      expiresAt: parsed.data.expiresAt ?? now + Math.max(1, state.config.replayDays) * 86_400_000
    };
    await this.queueArchivedAutomatedRoundtable(meta);
    return jsonResponse({ pending: true, token });
  }

  private async startAutomatedRelay(state: GameState, meta: RoomMeta): Promise<GameState> {
    delete meta.automatedRoundtableAt;
    meta.roundEventStartSeq = state.seq + 1;
    meta.roundStartedAt = Date.now();
    await this.objectState.storage.put(META_KEY, meta);
    state = await this.applyAndBroadcast(
      state,
      { type: "game.started", id: eventId(), at: Date.now() },
      "public",
      "system-auto-host"
    );
    const prompt = selectPrompt({
      seed: `${state.seed}:${state.seq}`,
      locale: state.config.locale
    });
    state = await this.applyAndBroadcast(
      state,
      {
        type: "prompt.selected",
        id: eventId(),
        at: Date.now(),
        actorId: "system-auto-host",
        text: prompt.texts[state.config.locale],
        metadata: promptMetadataForEntry(prompt, state.config.locale)
      },
      "public",
      "system-auto-host"
    );
    await this.prepareTurn(state);
    return state;
  }

  private async executeAutomatedJob(seat: PublicAiSeat, job: AiTurnJob): Promise<AiTurnResult> {
    if (seat.execution !== "server") {
      if (seat.execution === "demo" && this.automatedDemoModeEnabled()) {
        return createDemoTurnResult(job);
      }
      throw new Error("automated-ai-unavailable");
    }
    if (job.role === "guess" && !seat.capabilities.vision) {
      throw new Error("automated-ai-vision-unavailable");
    }
    const configuration = configuredServerProfilesWithDiagnostics(this.env);
    const serverJob =
      job.role === "guess" && job.inputCommands !== undefined && job.imageDataUrl === undefined
        ? { ...job, imageDataUrl: commandsToServerAiImageDataUrl(job.inputCommands) }
        : job;
    const timeoutMs = Math.min(AUTOMATED_SERVER_AI_TIMEOUT_MS, job.timeLimitSeconds * 1_000);
    const attemptTimeoutMs =
      job.role === "draw"
        ? Math.min(AUTOMATED_DRAW_ATTEMPT_TIMEOUT_MS, timeoutMs)
        : job.role === "guess"
          ? Math.min(AUTOMATED_GUESS_ATTEMPT_TIMEOUT_MS, timeoutMs)
          : undefined;
    const result = await executeServerProfile(
      configuration.profiles,
      this.env.AI,
      seat.profileId,
      serverJob,
      configuration.workersAiProfiles,
      timeoutMs,
      attemptTimeoutMs,
      job.role === "draw" ? { requireDrawingFinish: true } : undefined
    );
    if (result.status !== "ok") throw new Error(result.errorCode ?? "automated-ai-fallback");
    return result;
  }

  private automatedModelLabel(seat: PublicAiSeat): string {
    const configuration = configuredServerProfilesWithDiagnostics(this.env);
    return (
      configuration.profiles.find((record) => record.profile.id === seat.profileId)?.profile
        .label ??
      configuration.workersAiProfiles.find((profile) => profile.id === seat.profileId)?.label ??
      seat.profileId
    );
  }

  private async createAutomatedPostGameReview(
    state: GameState,
    slot: TimelineSlot,
    seat: PublicAiSeat,
    published: readonly PostGameReview[]
  ): Promise<PostGameReview> {
    const modelLabel = this.automatedModelLabel(seat);
    const job: AiTurnJob = {
      jobId: postGameReviewId(state, slot.actorId),
      roomId: state.roomId,
      turnIndex: -1,
      role: "review",
      locale: state.config.locale,
      personaId: slot.personaId ?? seat.personaId,
      ...(seat.personaCustomization === undefined
        ? {}
        : { personaCustomization: seat.personaCustomization }),
      actorId: slot.actorId,
      reviewRole: automatedReviewRole(state, slot.actorId),
      reviewActors: automatedReviewActors(state),
      inputText: automatedReviewContext(state, slot.actorId, published),
      observationIndex: 0,
      observationLimit: 0,
      timeLimitSeconds: Math.min(
        AUTOMATED_POST_GAME_REVIEW_TIMEOUT_SECONDS,
        state.config.rules.aiRequestTimeoutSeconds
      ),
      budget: {
        maxStrokes: state.config.rules.maxStrokes,
        maxUndos: state.config.rules.maxUndos,
        colorCount: state.config.rules.colorCount,
        remainingStrokes: state.config.rules.maxStrokes,
        remainingUndos: state.config.rules.maxUndos
      }
    };
    let result: AiTurnResult;
    try {
      result = await this.executeAutomatedJob(seat, job);
    } catch (cause) {
      return departedAutomatedReview(
        state,
        slot,
        modelLabel,
        cause instanceof Error ? cause.message : "review-execution-error"
      );
    }
    if (result.review === undefined || result.review.text.trim() === "") {
      return departedAutomatedReview(state, slot, modelLabel, result.errorCode ?? "invalid-review");
    }
    const resolvedActions = resolveAutomatedReviewActions(
      state,
      slot.actorId,
      result.review.actions
    );
    const actions =
      resolvedActions.length > 0
        ? resolvedActions
        : fallbackAutomatedReviewActions(state, slot.actorId);
    if (actions.length === 0) {
      return departedAutomatedReview(state, slot, modelLabel, "invalid-review-actions");
    }
    const requestedReply = published.find(
      (review) => review.status !== "departed" && review.seatId === result.review?.replyToActorId
    );
    return {
      id: job.jobId,
      seatId: slot.actorId,
      personaId: slot.personaId ?? seat.personaId,
      displayName: slot.displayName,
      modelLabel,
      text: result.review.text.replace(/\s+/g, " ").trim(),
      score: result.review.score,
      reaction: result.reaction.kind,
      status: "generated",
      ...(requestedReply === undefined ? {} : { replyToSeatId: requestedReply.seatId }),
      actions,
      at: Date.now()
    };
  }

  private async advanceAutomatedRoundtable(state: GameState, meta: RoomMeta): Promise<GameState> {
    const slot = state.timeline.find(
      (candidate) =>
        candidate.actorType === "ai" &&
        !(state.postGameReviews ?? []).some((review) => review.seatId === candidate.actorId)
    );
    if (slot !== undefined) {
      const seat = meta.aiSeats.find((candidate) => candidate.seatId === slot.actorId);
      const review =
        seat === undefined
          ? departedAutomatedReview(state, slot, "AI", "missing-review-seat")
          : await this.createAutomatedPostGameReview(
              state,
              slot,
              seat,
              state.postGameReviews ?? []
            );
      state = await this.applyAndBroadcast(
        state,
        {
          type: "postgame.reviewed",
          id: review.id,
          at: review.at,
          review
        },
        "reveal",
        review.seatId
      );
    }
    if (this.automatedRoundtableHasMissingReviews(state)) {
      await this.queueAutomatedRoundtable(meta, Date.now() + AUTOMATED_ROUNDTABLE_STEP_DELAY_MS);
      return state;
    }
    delete meta.automatedRoundtableAt;
    await this.objectState.storage.put(META_KEY, meta);
    if (state.phase === "reveal") return this.completeMatch(state, meta);
    if (state.phase === "complete") await this.archiveCurrentMatch(state, meta);
    return state;
  }

  private async advanceArchivedAutomatedRoundtable(meta: RoomMeta): Promise<void> {
    const archived = meta.automatedArchivedRoundtable;
    if (archived === undefined) return;
    const response = await this.env.MATCHES.getByName("global").fetch(
      `https://matches.internal/replay/${encodeURIComponent(archived.token)}`
    );
    if (!response.ok) {
      if (response.status === 404) {
        delete meta.automatedArchivedRoundtable;
        delete meta.automatedArchivedRoundtableAt;
        await this.objectState.storage.put(META_KEY, meta);
        await this.scheduleAutomatedRoomAlarm(meta);
      } else {
        await this.queueArchivedAutomatedRoundtable(
          meta,
          Date.now() + AUTOMATED_ARCHIVE_RETRY_DELAY_MS
        );
      }
      return;
    }
    const parsed = ArchivedAutomatedReplaySchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.state.replayToken !== archived.token) {
      delete meta.automatedArchivedRoundtable;
      delete meta.automatedArchivedRoundtableAt;
      await this.objectState.storage.put(META_KEY, meta);
      await this.scheduleAutomatedRoomAlarm(meta);
      return;
    }
    let state = parsed.data.state as unknown as GameState;
    if (!this.automatedRoundtableHasMissingReviews(state)) {
      delete meta.automatedArchivedRoundtable;
      delete meta.automatedArchivedRoundtableAt;
      await this.objectState.storage.put(META_KEY, meta);
      await this.scheduleAutomatedRoomAlarm(meta);
      return;
    }
    const persistedReviewIds = new Set((state.postGameReviews ?? []).map((review) => review.id));
    const events = parsed.data.events.filter((candidate) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return true;
      }
      const event = candidate as { type?: unknown; review?: { id?: unknown } };
      return (
        event.type !== "postgame.reviewed" ||
        (typeof event.review?.id === "string" && persistedReviewIds.has(event.review.id))
      );
    });
    const slot = state.timeline.find(
      (candidate) =>
        candidate.actorType === "ai" &&
        !(state.postGameReviews ?? []).some((review) => review.seatId === candidate.actorId)
    );
    if (slot !== undefined) {
      const seat = meta.aiSeats.find((candidate) => candidate.seatId === slot.actorId);
      const review =
        seat === undefined
          ? departedAutomatedReview(state, slot, "AI", "missing-review-seat")
          : await this.createAutomatedPostGameReview(
              state,
              slot,
              seat,
              state.postGameReviews ?? []
            );
      const event: GameEvent = {
        type: "postgame.reviewed",
        id: review.id,
        at: review.at,
        review
      };
      state = applyGameEvent(state, event);
      events.push(event);
    }
    const saved = await this.upsertArchivedMatch(state, events, archived);
    if (!saved) {
      await this.queueArchivedAutomatedRoundtable(
        meta,
        Date.now() + AUTOMATED_ARCHIVE_RETRY_DELAY_MS
      );
      return;
    }
    if (!this.automatedRoundtableHasMissingReviews(state)) {
      delete meta.automatedArchivedRoundtable;
      delete meta.automatedArchivedRoundtableAt;
      await this.objectState.storage.put(META_KEY, meta);
      await this.scheduleAutomatedRoomAlarm(meta);
      return;
    }
    await this.queueArchivedAutomatedRoundtable(
      meta,
      Date.now() + AUTOMATED_ROUNDTABLE_STEP_DELAY_MS
    );
  }

  private async executeAutomatedTurn(state: GameState): Promise<GameState> {
    const slot = state.timeline[state.turnIndex];
    if (state.phase !== "turn" || slot?.actorType !== "ai") {
      throw new Error("Automated room has no AI turn to execute");
    }
    let meta = await this.loadMeta();
    if (meta.pendingAiJob === undefined) {
      await this.issueAiJobIfNeeded(state);
      meta = await this.loadMeta();
    }
    const pending = meta.pendingAiJob;
    const seat = meta.aiSeats.find((candidate) => candidate.seatId === slot.actorId);
    if (pending === undefined || seat === undefined) throw new Error("Automated AI job is missing");
    let result: AiTurnResult;
    try {
      result = await this.executeAutomatedJob(seat, pending.job);
    } catch (cause) {
      return this.abortAiTurn(
        state,
        meta,
        slot.actorId,
        cause instanceof Error ? cause.message : "automated-ai-error"
      );
    }
    if (!isLiveReactionSpoilerFree(result, pending.job)) {
      return this.abortAiTurn(state, meta, slot.actorId, "unsafe-reaction");
    }

    if (slot.role === "draw") {
      const validation =
        result.commands === undefined
          ? undefined
          : validateCanvasCommands(
              result.commands,
              {
                maxStrokes: state.config.rules.maxStrokes,
                maxUndos: state.config.rules.maxUndos,
                colorCount: state.config.rules.colorCount,
                maxTotalPoints: 4096
              },
              { requireFinish: true }
            );
      if (
        validation === undefined ||
        !validation.ok ||
        !hasVisibleCanvasContent(validation.commands)
      ) {
        return this.abortAiTurn(state, meta, slot.actorId, "invalid-drawing");
      }
      const fallbackValidation = validateCanvasCommands(
        result.commands ?? [],
        {
          maxStrokes: state.config.rules.maxStrokes,
          maxUndos: state.config.rules.maxUndos,
          colorCount: state.config.rules.colorCount,
          maxTotalPoints: 4096
        },
        { requireFinish: true }
      );
      if (!fallbackValidation.ok || !hasVisibleCanvasContent(fallbackValidation.commands)) {
        return this.abortAiTurn(state, meta, slot.actorId, "invalid-drawing");
      }
      state = await this.applyAndBroadcast(
        state,
        {
          type: "drawing.submitted",
          id: eventId(),
          at: Date.now(),
          actorId: slot.actorId,
          commands: fallbackValidation.commands,
          canvasHash: hashCanvasCommands(fallbackValidation.commands)
        },
        "acted",
        slot.actorId
      );
    } else {
      if (result.guess === undefined || result.guess.trim() === "") {
        return this.abortAiTurn(state, meta, slot.actorId, "invalid-guess");
      }
      state = await this.applyAndBroadcast(
        state,
        {
          type: "guess.submitted",
          id: eventId(),
          at: Date.now(),
          actorId: slot.actorId,
          text: result.guess ?? ""
        },
        "acted",
        slot.actorId
      );
    }
    const reaction: ReactionRecord = {
      id: eventId(),
      actorId: slot.actorId,
      turnIndex: state.turnIndex,
      reaction: result.reaction.kind,
      text: result.reaction.text,
      at: Date.now()
    };
    state = await this.applyAndBroadcast(
      state,
      { type: "reaction.sent", id: eventId(), at: Date.now(), reaction },
      "public",
      slot.actorId
    );
    delete meta.pendingAiJob;
    delete meta.turnExpiresAt;
    delete meta.drawingDraft;
    await this.objectState.storage.put(META_KEY, meta);
    state = await this.applyAndBroadcast(
      state,
      { type: "turn.advanced", id: eventId(), at: Date.now() },
      "public",
      "system-auto-host"
    );
    if (state.phase === "reveal") {
      state = await this.completeMatch(state, meta);
    } else {
      await this.prepareTurn(state);
    }
    return state;
  }

  private async runAutomatedMatch(): Promise<Response> {
    if ((await this.objectState.storage.get<GameState>(STATE_KEY)) === undefined) {
      await this.ensureAutomatedRoom();
    }
    let state = await this.loadState();
    let meta = await this.loadMeta();
    if (!meta.automated) return jsonResponse({ error: "room-not-automated" }, 409);
    state = (await this.pruneAutomatedParticipants(state, meta)).state;
    if (
      !this.automatedDemoModeEnabled() &&
      meta.aiSeats.some((seat) => seat.execution !== "server")
    ) {
      return jsonResponse({ error: "automated-ai-unavailable" }, 503);
    }
    if (this.automatedRoundtableRequiresSettlement(state, meta)) {
      if (meta.automatedRoundtableAt === undefined) await this.queueAutomatedRoundtable(meta);
      return jsonResponse({ started: false, phase: state.phase, settling: true });
    }
    if (meta.automatedArchivedRoundtable !== undefined) {
      if (meta.automatedArchivedRoundtableAt === undefined) {
        await this.queueArchivedAutomatedRoundtable(meta);
      }
      return jsonResponse({ started: false, phase: state.phase, repairingReplay: true });
    }
    if (state.phase === "complete" || state.phase === "failed") {
      state = await this.restartRoom(state, meta, "system-auto-host");
      meta = await this.loadMeta();
    }
    if (state.phase !== "lobby") {
      return jsonResponse({ started: false, phase: state.phase });
    }
    state = await this.startAutomatedRelay(state, meta);
    for (let turn = 0; turn < state.timeline.length && state.phase === "turn"; turn += 1) {
      state = await this.executeAutomatedTurn(state);
    }
    await this.broadcastSnapshots();
    return jsonResponse({
      started: true,
      phase: state.phase,
      replayToken: state.replayToken
    });
  }

  private defaultTimeline(state: GameState, aiSeats: PublicAiSeat[]): TimelineSlot[] {
    const aiActors = aiSeats.map((seat) => ({
      id: seat.seatId,
      displayName: seat.displayName,
      personaId: seat.personaId,
      ...(seat.personaCustomization === undefined
        ? {}
        : { personaName: seat.personaCustomization.name })
    }));
    if (state.config.mode === "ai-theatre") {
      return buildAiTheatreTimeline(aiActors, state.config.rules.chainLength);
    }
    const humans = state.participants
      .filter(
        (participant) =>
          (participant.roomRole === "player" ||
            (participant.roomRole === "host" &&
              state.timeline.some((slot) => slot.actorId === participant.id)) ||
            (participant.roomRole === "host" && state.timeline.length === 0)) &&
          !(state.config.promptSource === "custom" && participant.roomRole === "host")
      )
      .map((participant) => ({ id: participant.id, displayName: participant.displayName }));
    return buildBlindTimeline({
      humans,
      aiSeats: aiActors,
      chainLength: state.config.rules.chainLength,
      seed: `${state.seed}:${state.participants.length}`
    });
  }

  private canonicalTimeline(
    state: GameState,
    config: GameState["config"],
    timeline: readonly TimelineSlot[],
    aiSeats: readonly PublicAiSeat[]
  ): TimelineSlot[] {
    assertDistinctAiSeats(aiSeats);
    if (timeline.length !== config.rules.chainLength) {
      throw new Error("Timeline length must match the configured chain length");
    }
    if (new Set(timeline.map((slot) => slot.actorId)).size !== timeline.length) {
      throw new Error("Every relay turn requires a distinct actor");
    }

    const participants = new Map(
      state.participants.map((participant) => [participant.id, participant])
    );
    const seats = new Map(aiSeats.map((seat) => [seat.seatId, seat]));
    const previousHumanIds = new Set(
      state.timeline.filter((slot) => slot.actorType === "human").map((slot) => slot.actorId)
    );
    const expectedHumanIds = new Set(
      config.mode === "ai-theatre"
        ? []
        : state.participants
            .filter(
              (participant) =>
                participant.roomRole === "player" ||
                (participant.roomRole === "host" &&
                  (previousHumanIds.has(participant.id) ||
                    (state.config.promptSource === "custom" && config.promptSource !== "custom")))
            )
            .filter(
              (participant) =>
                !(config.promptSource === "custom" && participant.roomRole === "host")
            )
            .map((participant) => participant.id)
    );
    const configuredHumanIds = new Set(
      timeline.filter((slot) => slot.actorType === "human").map((slot) => slot.actorId)
    );
    if (
      expectedHumanIds.size !== configuredHumanIds.size ||
      [...expectedHumanIds].some((participantId) => !configuredHumanIds.has(participantId))
    ) {
      throw new Error("Every participating human must occupy exactly one relay turn");
    }

    return timeline.map((slot, index) => {
      const expectedRole = index % 2 === 0 ? "draw" : "guess";
      if (slot.index !== index || slot.role !== expectedRole) {
        throw new Error("Timeline indices and draw/guess roles must alternate in order");
      }
      if (slot.actorType === "human") {
        const participant = participants.get(slot.actorId);
        if (participant === undefined || !expectedHumanIds.has(participant.id)) {
          throw new Error("Timeline contains an unknown or non-playing human");
        }
        return {
          index,
          role: expectedRole,
          actorType: "human" as const,
          actorId: participant.id,
          displayName: participant.displayName
        };
      }
      const seat = seats.get(slot.actorId);
      if (seat === undefined) throw new Error("Timeline contains an unknown AI seat");
      if (!modelSupportsRole(seat.capabilities, expectedRole)) {
        throw new Error(`${seat.displayName} does not support its assigned ${expectedRole} turn`);
      }
      return {
        index,
        role: expectedRole,
        actorType: "ai" as const,
        actorId: seat.seatId,
        displayName: seat.displayName,
        personaId: seat.personaId,
        ...(seat.personaCustomization !== undefined
          ? { personaName: seat.personaCustomization.name }
          : slot.personaName === undefined
            ? {}
            : { personaName: slot.personaName })
      };
    });
  }

  private async join(raw: unknown, origin: string): Promise<Response> {
    const request = JoinRoomRequestSchema.parse(raw);
    let state = await this.objectState.storage.get<GameState>(STATE_KEY);
    if (state === undefined) return jsonResponse({ error: "room-not-found" }, 404);
    const meta = await this.loadMeta();
    if (meta.automated === true && request.joinAs !== "spectator") {
      return jsonResponse({ error: "automated-room-spectators-only" }, 403);
    }
    const canWatchAutomatedRoom = meta.automated === true && request.joinAs === "spectator";
    if (state.phase !== "lobby" && !canWatchAutomatedRoom) {
      return jsonResponse({ error: "game-started" }, 409);
    }
    if (request.joinAs === "spectator" && !state.config.allowSpectators) {
      return jsonResponse({ error: "spectators-disabled" }, 403);
    }
    if (meta.automated === true) {
      state = (await this.pruneAutomatedParticipants(state, meta)).state;
      if (state.participants.length >= MAX_ROOM_MEMBERS) {
        state = (await this.pruneAutomatedParticipants(state, meta, Date.now(), true)).state;
      }
    }
    if (state.participants.length >= MAX_ROOM_MEMBERS) {
      return jsonResponse({ error: "room-full" }, 409);
    }
    const humanCount = state.timeline.filter((slot) => slot.actorType === "human").length;
    if (
      request.joinAs === "player" &&
      (humanCount >= MAX_PLAYERS || humanCount >= state.config.rules.chainLength)
    ) {
      return jsonResponse({ error: "room-full" }, 409);
    }
    const participantId = `p_${randomToken(12)}`;
    const reconnectToken = randomToken();
    const participant: Participant = {
      id: participantId,
      displayName: request.displayName,
      roomRole: request.joinAs,
      connected: false,
      hasActed: false
    };
    state = await this.applyAndPersist(state, {
      type: "player.joined",
      id: eventId(),
      at: Date.now(),
      participant
    });
    if (state.config.mode === "blind-relay" && request.joinAs === "player") {
      const timeline = this.defaultTimeline(state, meta.aiSeats);
      state = await this.applyAndPersist(state, {
        type: "timeline.configured",
        id: eventId(),
        at: Date.now(),
        timeline
      });
    }
    const credentials = await this.loadCredentials();
    credentials.participants[participantId] = { reconnectHash: await hashToken(reconnectToken) };
    await this.objectState.storage.put(CREDENTIALS_KEY, credentials);
    meta.idleExpiresAt = Date.now() + this.idleRoomMs;
    await this.objectState.storage.put(META_KEY, meta);
    if (meta.automated) {
      await this.scheduleAutomatedRoomAlarm(meta);
    } else {
      await this.scheduleRoomAlarm(meta, meta.idleExpiresAt);
    }
    const wsOrigin = origin.replace(/^http/, "ws");
    return jsonResponse({
      roomId: state.roomId,
      participantId,
      reconnectToken,
      websocketUrl: `${wsOrigin}/api/rooms/${state.roomId}/ws?participantId=${encodeURIComponent(participantId)}`
    });
  }

  private async authenticate(participantId: string, token: string): Promise<boolean> {
    const credentials = await this.objectState.storage.get<RoomCredentials>(CREDENTIALS_KEY);
    if (credentials === undefined) return false;
    const credential = credentials.participants[participantId];
    return credential !== undefined && tokenMatches(token, credential.reconnectHash);
  }

  private async validateParticipant(payload: AuthPayload): Promise<Response> {
    return jsonResponse({
      ok: await this.authenticate(payload.participantId, payload.reconnectToken)
    });
  }

  private async authorizeAiJob(payload: AuthPayload): Promise<Response> {
    if (!(await this.authenticate(payload.participantId, payload.reconnectToken))) {
      return jsonResponse({ ok: false }, 401);
    }
    const parsedJob = AiTurnJobSchema.safeParse(payload.job);
    if (!parsedJob.success || payload.profileId === undefined) {
      return jsonResponse({ ok: false }, 400);
    }
    const job = parsedJob.data;
    const meta = await this.loadMeta();
    const assignedSeat = meta.aiSeats.find(
      (seat) => seat.seatId === (job.role === "review" ? job.actorId : meta.pendingAiJob?.seatId)
    );
    if (assignedSeat?.profileId !== payload.profileId) {
      return jsonResponse({ ok: false }, 403);
    }
    const pendingJob = meta.pendingAiJob?.job;
    if (
      pendingJob !== undefined &&
      meta.aiExecutorId === payload.participantId &&
      pendingJob.jobId === payload.jobId &&
      job.jobId === payload.jobId &&
      authorizedTurnDerivative(pendingJob, job)
    ) {
      const usage = meta.serverAiCalls?.[job.jobId];
      const maximumCalls = job.role === "draw" ? 1 + (pendingJob.observationLimit + 1) * 4 : 1;
      if (
        usage !== undefined &&
        (usage.profileId !== payload.profileId || usage.count >= maximumCalls)
      ) {
        return jsonResponse({ ok: false }, 429);
      }
      meta.serverAiCalls = {
        ...(meta.serverAiCalls ?? {}),
        [job.jobId]: { count: (usage?.count ?? 0) + 1, profileId: payload.profileId }
      };
      await this.objectState.storage.put(META_KEY, meta);
      return jsonResponse({ ok: true });
    }
    const state = await this.loadState();
    const participant = state.participants.find((item) => item.id === payload.participantId);
    const credentials = await this.loadCredentials();
    const reviewSlot = state.timeline.find(
      (slot) => slot.actorType === "ai" && slot.actorId === job.actorId
    );
    const expectedReviewJobId =
      reviewSlot === undefined ? undefined : postGameReviewId(state, reviewSlot.actorId);
    const reviewRoles = new Set(
      state.timeline.filter((slot) => slot.actorId === job.actorId).map((slot) => slot.role)
    );
    const expectedReviewRole =
      reviewRoles.has("draw") && reviewRoles.has("guess")
        ? "mixed"
        : reviewRoles.has("guess")
          ? "guess"
          : "draw";
    const canReview =
      payload.role === "review" &&
      job.role === "review" &&
      payload.jobId === expectedReviewJobId &&
      job.jobId === expectedReviewJobId &&
      job.roomId === state.roomId &&
      job.turnIndex === -1 &&
      job.locale === state.config.locale &&
      job.actorId === reviewSlot?.actorId &&
      job.personaId === reviewSlot?.personaId &&
      sameValue(job.personaCustomization, assignedSeat?.personaCustomization) &&
      job.reviewRole === expectedReviewRole &&
      job.observationIndex === 0 &&
      job.observationLimit === 0 &&
      job.timeLimitSeconds <= 15 &&
      job.budget.maxStrokes === state.config.rules.maxStrokes &&
      job.budget.maxUndos === state.config.rules.maxUndos &&
      job.budget.colorCount === state.config.rules.colorCount &&
      (job.imageDataUrl === undefined || assignedSeat?.capabilities.vision === true) &&
      assignedSeat !== undefined &&
      modelSupportsRole(assignedSeat.capabilities, "review") &&
      (state.phase === "reveal" || state.phase === "complete") &&
      participant?.roomRole === "host" &&
      payload.hostToken !== undefined &&
      (await tokenMatches(payload.hostToken, credentials.hostHash)) &&
      !(state.postGameReviews ?? []).some((review) => review.seatId === reviewSlot?.actorId) &&
      !(meta.authorizedReviewJobIds ?? []).includes(job.jobId);
    if (canReview && payload.jobId !== undefined) {
      meta.authorizedReviewJobIds = [
        ...(meta.authorizedReviewJobIds ?? []).slice(-23),
        payload.jobId
      ];
      await this.objectState.storage.put(META_KEY, meta);
    }
    return jsonResponse({
      ok: canReview
    });
  }

  private async connectWebSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "upgrade-required" }, 426);
    }
    const participantId = url.searchParams.get("participantId") ?? "";
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim());
    const authProtocol = protocols.find((protocol) => protocol.startsWith("drawguessai.auth."));
    const token = authProtocol?.slice("drawguessai.auth.".length) ?? "";
    if (!(await this.authenticate(participantId, token))) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const [state, meta] = await Promise.all([this.loadState(), this.loadMeta()]);
    const participant = state.participants.find((candidate) => candidate.id === participantId);
    if (
      meta.automated === true &&
      (participant === undefined || participant.roomRole !== "spectator")
    ) {
      return jsonResponse({ error: "automated-room-spectators-only" }, 403);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.serializeAttachment({ participantId } satisfies SocketAttachment);
    this.objectState.acceptWebSocket(server, [participantId]);
    await this.setConnection(participantId, true);
    await this.sendSnapshot(server);
    await this.sendPendingJob(server);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "drawguessai.v1" }
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (
        attachment === null ||
        !this.transientRateAllows(attachment.participantId, "messages", 300, 1_000)
      ) {
        socket.close(1008, "Room message rate exceeded");
        return;
      }
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (new TextEncoder().encode(text).byteLength > MAX_CLIENT_MESSAGE_BYTES) {
        socket.close(1009, "Message exceeds the room protocol limit");
        return;
      }
      const parsed = ClientMessageSchema.parse(JSON.parse(text));
      await this.handleClientMessage(socket, parsed);
    } catch (error) {
      const messageText =
        error instanceof z.ZodError || error instanceof SyntaxError
          ? "Request data did not match the room protocol"
          : error instanceof Error
            ? error.message.slice(0, 240)
            : "Invalid message";
      socket.send(JSON.stringify(errorMessage("invalid-message", messageText)));
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null) return;
    const hasAnotherOpenSocket = this.objectState
      .getWebSockets(attachment.participantId)
      .some((candidate) => candidate !== socket && candidate.readyState === WebSocket.OPEN);
    if (!hasAnotherOpenSocket) await this.setConnection(attachment.participantId, false);
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Room connection error");
  }

  private socketIdentity(socket: WebSocket): SocketAttachment {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null) throw new Error("Socket identity is missing");
    return attachment;
  }

  private async setConnection(participantId: string, connected: boolean): Promise<void> {
    let state = await this.objectState.storage.get<GameState>(STATE_KEY);
    if (state === undefined) return;
    const currentParticipant = state.participants.find(
      (participant) => participant.id === participantId
    );
    if (currentParticipant === undefined || currentParticipant.connected === connected) return;
    state = await this.applyAndPersist(state, {
      type: "player.connection",
      id: eventId(),
      at: Date.now(),
      participantId,
      connected
    });
    const connectionMeta = await this.loadMeta();
    if (connectionMeta.automated && currentParticipant.roomRole === "spectator") {
      const disconnects = { ...(connectionMeta.automatedSpectatorDisconnects ?? {}) };
      if (connected) {
        delete disconnects[participantId];
      } else {
        disconnects[participantId] = Date.now() + AUTOMATED_SPECTATOR_RECONNECT_GRACE_MS;
      }
      if (Object.keys(disconnects).length === 0) {
        delete connectionMeta.automatedSpectatorDisconnects;
      } else {
        connectionMeta.automatedSpectatorDisconnects = disconnects;
      }
      await this.objectState.storage.put(META_KEY, connectionMeta);
      if (!connected) await this.scheduleAutomatedRoomAlarm(connectionMeta);
    }
    if (
      !connected &&
      connectionMeta.aiExecutorId === participantId &&
      connectionMeta.pendingAiJob !== undefined
    ) {
      connectionMeta.executorReconnectDeadline = Date.now() + 60_000;
      await this.objectState.storage.put(META_KEY, connectionMeta);
      await this.scheduleRoomAlarm(connectionMeta, connectionMeta.executorReconnectDeadline);
    } else if (connected && connectionMeta.aiExecutorId === participantId) {
      delete connectionMeta.executorReconnectDeadline;
      await this.objectState.storage.put(META_KEY, connectionMeta);
    }
    const disconnectedHost = state.participants.find(
      (participant) => participant.id === participantId && participant.roomRole === "host"
    );
    if (!connected && disconnectedHost !== undefined) {
      const successor = state.participants.find(
        (participant) => participant.id !== participantId && participant.connected
      );
      if (successor !== undefined) {
        await this.transferHost(state, participantId, successor.id);
      }
    }
    await this.broadcastSnapshots();
  }

  private async handleClientMessage(socket: WebSocket, message: ClientMessage): Promise<void> {
    const { participantId } = this.socketIdentity(socket);
    let state = await this.loadState();
    const participant = state.participants.find((item) => item.id === participantId);
    if (participant === undefined) throw new Error("Participant is no longer in this room");

    switch (message.type) {
      case "room.resume":
        await this.sendSnapshot(socket);
        await this.sendPendingJob(socket);
        return;
      case "room.leave": {
        const meta = await this.loadMeta();
        const canLeaveAutomatedSpectator =
          meta.automated === true && participant.roomRole === "spectator";
        if (state.phase !== "lobby" && !canLeaveAutomatedSpectator) {
          throw new Error("A participant can only leave explicitly from the lobby");
        }
        const credentials = await this.loadCredentials();
        if (participant.roomRole === "host") {
          const successor = state.participants.find(
            (candidate) => candidate.id !== participantId && candidate.connected
          );
          if (successor === undefined) {
            for (const roomSocket of this.objectState.getWebSockets()) {
              roomSocket.close(1000, "Room closed by host");
            }
            await this.objectState.storage.deleteAll();
            return;
          }
          await this.transferHost(state, participantId, successor.id);
          state = await this.loadState();
          meta.aiExecutorId = successor.id;
        }
        state = await this.applyAndPersist(state, {
          type: "player.left",
          id: eventId(),
          at: Date.now(),
          participantId
        });
        delete credentials.participants[participantId];
        if (meta.automatedSpectatorDisconnects !== undefined) {
          delete meta.automatedSpectatorDisconnects[participantId];
          if (Object.keys(meta.automatedSpectatorDisconnects).length === 0) {
            delete meta.automatedSpectatorDisconnects;
          }
        }
        if (meta.aiExecutorId === participantId) {
          meta.aiExecutorId = state.participants.find((candidate) => candidate.connected)?.id ?? "";
        }
        if (state.config.mode === "blind-relay" && participant.roomRole !== "spectator") {
          state = await this.applyAndPersist(state, {
            type: "timeline.configured",
            id: eventId(),
            at: Date.now(),
            timeline: this.defaultTimeline(state, meta.aiSeats)
          });
        }
        meta.idleExpiresAt = Date.now() + this.idleRoomMs;
        await this.objectState.storage.put({
          [CREDENTIALS_KEY]: credentials,
          [META_KEY]: meta
        });
        if (!meta.automated) await this.scheduleRoomAlarm(meta, meta.idleExpiresAt);
        await this.broadcastSnapshots();
        for (const roomSocket of this.objectState.getWebSockets(participantId)) {
          roomSocket.close(1000, "Participant left room");
        }
        return;
      }
      case "room.configure": {
        await this.requireHost(participant, message.hostToken);
        if (state.phase !== "lobby") throw new Error("Room can only be configured in the lobby");
        const config = GameConfigSchema.parse(message.config);
        if (config.icePolicy === "relay" && !this.turnConfigured) {
          throw new Error("TURN relay-only mode is not configured on this deployment");
        }
        const meta = await this.loadMeta();
        const aiSeats = message.aiSeats ?? meta.aiSeats;
        const timeline = this.canonicalTimeline(state, config, message.timeline, aiSeats);
        state = await this.applyAndPersist(state, {
          type: "room.configured",
          id: eventId(),
          at: Date.now(),
          config
        });
        state = await this.applyAndPersist(state, {
          type: "timeline.configured",
          id: eventId(),
          at: Date.now(),
          timeline
        });
        if (message.aiSeats !== undefined) {
          meta.aiSeats = message.aiSeats;
        }
        meta.idleExpiresAt = Date.now() + this.idleRoomMs;
        await this.objectState.storage.put(META_KEY, meta);
        await this.scheduleRoomAlarm(meta, meta.idleExpiresAt);
        await this.broadcastSnapshots();
        return;
      }
      case "room.transfer-host": {
        await this.requireHost(participant, message.hostToken);
        const successor = state.participants.find(
          (candidate) => candidate.id === message.participantId && candidate.connected
        );
        if (successor === undefined || successor.id === participantId) {
          throw new Error("The new host must be another connected room member");
        }
        await this.transferHost(state, participantId, successor.id);
        await this.broadcastSnapshots();
        return;
      }
      case "game.restart": {
        await this.requireHost(participant, message.hostToken);
        if (state.phase !== "complete" && state.phase !== "failed") {
          throw new Error("A new relay can only start after the current relay ends");
        }
        await this.restartRoom(state, await this.loadMeta(), participantId);
        await this.broadcastSnapshots();
        return;
      }
      case "game.start": {
        await this.requireHost(participant, message.hostToken);
        const meta = await this.loadMeta();
        const disconnectedPlayerIds = new Set(
          state.timeline
            .filter((slot) => slot.actorType === "human")
            .map((slot) => slot.actorId)
            .filter(
              (actorId) =>
                state.participants.find((candidate) => candidate.id === actorId)?.connected !== true
            )
        );
        if (disconnectedPlayerIds.size > 0) {
          const credentials = await this.loadCredentials();
          for (const disconnectedId of disconnectedPlayerIds) {
            state = await this.applyAndBroadcast(
              state,
              {
                type: "player.left",
                id: eventId(),
                at: Date.now(),
                participantId: disconnectedId
              },
              "public",
              "system"
            );
            delete credentials.participants[disconnectedId];
          }
          state = await this.applyAndBroadcast(
            state,
            {
              type: "timeline.configured",
              id: eventId(),
              at: Date.now(),
              timeline: this.defaultTimeline(state, meta.aiSeats)
            },
            "public",
            "system"
          );
          await this.objectState.storage.put(CREDENTIALS_KEY, credentials);
        }
        const executor = state.participants.find((candidate) => candidate.id === meta.aiExecutorId);
        if (executor?.connected !== true) {
          meta.aiExecutorId = participantId;
          delete meta.executorReconnectDeadline;
          await this.objectState.storage.put(META_KEY, meta);
        }
        const requestedPrompt = message.prompt;
        const promptSource = requestedPrompt?.source ?? state.config.promptSource;
        if (state.config.promptSource !== promptSource) {
          state = await this.applyAndBroadcast(
            state,
            {
              type: "room.configured",
              id: eventId(),
              at: Date.now(),
              config: { ...state.config, promptSource }
            },
            "public",
            participantId
          );
        }
        const usedAiSeatIds = new Set(
          state.timeline.filter((slot) => slot.actorType === "ai").map((slot) => slot.actorId)
        );
        if (meta.aiSeats.some((seat) => usedAiSeatIds.has(seat.seatId) && !seat.ready)) {
          throw new Error("Every AI seat used by the timeline must be configured");
        }
        if (
          state.config.mode === "blind-relay" &&
          promptSource === "custom" &&
          state.timeline.some((slot) => slot.actorId === participantId)
        ) {
          throw new Error("A participating host cannot set the hidden custom prompt");
        }
        if (
          requestedPrompt?.source === "custom" &&
          !validatePlayablePromptText(
            requestedPrompt.text,
            requestedPrompt.metadata.kind,
            requestedPrompt.metadata.language
          ).ok
        ) {
          throw new Error("Prompt must be a compact, all-ages lexical entry or established saying");
        }
        const incapableTurn = state.timeline.find((slot) => {
          if (slot.actorType !== "ai") return false;
          const seat = meta.aiSeats.find((candidate) => candidate.seatId === slot.actorId);
          return seat === undefined || !modelSupportsRole(seat.capabilities, slot.role);
        });
        if (incapableTurn !== undefined) {
          throw new Error(
            `${incapableTurn.displayName} does not support its assigned ${incapableTurn.role} turn`
          );
        }
        if (
          promptSource === "generated" &&
          !meta.aiSeats.some((seat) => seat.ready && modelSupportsRole(seat.capabilities, "prompt"))
        ) {
          throw new Error("No configured AI seat supports prompt generation");
        }
        meta.roundEventStartSeq = state.seq + 1;
        meta.roundStartedAt = Date.now();
        await this.objectState.storage.put(META_KEY, meta);
        state = await this.applyAndBroadcast(
          state,
          {
            type: "game.started",
            id: eventId(),
            at: Date.now()
          },
          "public",
          participantId
        );
        if (promptSource === "curated") {
          const prompt = selectPrompt({
            seed: `${state.seed}:${state.seq}`,
            locale: state.config.locale
          });
          state = await this.applyAndBroadcast(
            state,
            {
              type: "prompt.selected",
              id: eventId(),
              at: Date.now(),
              actorId: "system",
              text: prompt.texts[state.config.locale],
              metadata: promptMetadataForEntry(prompt, state.config.locale)
            },
            state.config.mode === "blind-relay" ? "active" : "public",
            "system"
          );
          await this.prepareTurn(state);
        } else if (promptSource === "generated") {
          await this.issuePromptJob(state, meta);
        } else if (requestedPrompt?.source === "custom") {
          state = await this.applyAndBroadcast(
            state,
            {
              type: "prompt.selected",
              id: eventId(),
              at: Date.now(),
              actorId: participantId,
              text: requestedPrompt.text,
              metadata: createPromptMetadata(
                requestedPrompt.text,
                requestedPrompt.metadata.language,
                requestedPrompt.metadata.kind,
                requestedPrompt.metadata.topic
              )
            },
            state.config.mode === "blind-relay" ? "active" : "public",
            participantId
          );
          await this.prepareTurn(state);
        }
        await this.broadcastSnapshots();
        return;
      }
      case "prompt.select": {
        if (participant.roomRole !== "host") throw new Error("Only the host can submit a prompt");
        if (
          !validatePlayablePromptText(
            message.text,
            message.metadata.kind,
            message.metadata.language
          ).ok
        )
          throw new Error("Prompt must be a compact, all-ages lexical entry or established saying");
        if (
          state.config.mode === "blind-relay" &&
          state.config.promptSource === "custom" &&
          state.timeline.some((slot) => slot.actorId === participantId)
        ) {
          throw new Error("A participating host cannot set the hidden custom prompt");
        }
        state = await this.applyAndBroadcast(
          state,
          {
            type: "prompt.selected",
            id: eventId(),
            at: Date.now(),
            actorId: participantId,
            text: message.text,
            metadata: createPromptMetadata(
              message.text,
              message.metadata.language,
              message.metadata.kind,
              message.metadata.topic
            )
          },
          state.config.mode === "blind-relay" ? "active" : "public",
          participantId
        );
        await this.prepareTurn(state);
        await this.broadcastSnapshots();
        return;
      }
      case "turn.inspect":
        this.requireAiExecutor(participantId, await this.loadMeta());
        state = await this.applyAndBroadcast(
          state,
          { type: "turn.inspect", id: eventId(), at: Date.now() },
          state.config.mode === "ai-theatre" ? "public" : "acted",
          participantId
        );
        await this.broadcastSnapshots();
        return;
      case "turn.resume":
        this.requireAiExecutor(participantId, await this.loadMeta());
        state = await this.applyAndBroadcast(
          state,
          { type: "turn.resumed", id: eventId(), at: Date.now() },
          state.config.mode === "ai-theatre" ? "public" : "acted",
          participantId
        );
        await this.broadcastSnapshots();
        return;
      case "turn.save-drawing": {
        const slot = state.timeline[state.turnIndex];
        const meta = await this.loadMeta();
        const canSaveHuman =
          state.phase === "turn" &&
          slot?.actorType === "human" &&
          slot.role === "draw" &&
          slot.actorId === participantId;
        const canSaveAi =
          (state.phase === "turn" || state.phase === "inspect") &&
          slot?.actorType === "ai" &&
          slot.role === "draw" &&
          meta.aiExecutorId === participantId &&
          meta.pendingAiJob?.seatId === slot.actorId;
        if (!canSaveHuman && !canSaveAi) {
          throw new Error("This participant cannot save the active drawing draft");
        }
        const commands = validateDrawingDraft(message.commands, {
          maxStrokes: state.config.rules.maxStrokes,
          maxUndos: state.config.rules.maxUndos,
          colorCount: state.config.rules.colorCount,
          maxTotalPoints: 4096
        });
        if (commands === undefined) throw new Error("Drawing draft is invalid");
        meta.drawingDraft = {
          turnIndex: state.turnIndex,
          actorId: slot.actorId,
          commands
        };
        await this.objectState.storage.put(META_KEY, meta);
        return;
      }
      case "turn.submit-drawing": {
        this.requireActiveHuman(state, participantId, "draw");
        const validation = validateCanvasCommands(
          message.commands,
          {
            maxStrokes: state.config.rules.maxStrokes,
            maxUndos: state.config.rules.maxUndos,
            colorCount: state.config.rules.colorCount,
            maxTotalPoints: 4096
          },
          { requireFinish: true }
        );
        if (!validation.ok)
          throw new Error(validation.issues.map((issue) => issue.message).join("; "));
        state = await this.applyAndBroadcast(
          state,
          {
            type: "drawing.submitted",
            id: eventId(),
            at: Date.now(),
            actorId: participantId,
            commands: validation.commands,
            canvasHash: hashCanvasCommands(validation.commands)
          },
          "acted",
          participantId
        );
        const meta = await this.clearTurnDeadline();
        await this.scheduleRoomAlarm(meta, Date.now() + 2_200);
        await this.broadcastSnapshots();
        return;
      }
      case "turn.submit-guess": {
        this.requireActiveHuman(state, participantId, "guess");
        state = await this.applyAndBroadcast(
          state,
          {
            type: "guess.submitted",
            id: eventId(),
            at: Date.now(),
            actorId: participantId,
            text: message.text
          },
          "acted",
          participantId
        );
        const meta = await this.clearTurnDeadline();
        await this.scheduleRoomAlarm(meta, Date.now() + 2_200);
        await this.broadcastSnapshots();
        return;
      }
      case "turn.advance": {
        if (participant.roomRole !== "host") throw new Error("Only the host advances the timeline");
        state = await this.applyAndBroadcast(
          state,
          { type: "turn.advanced", id: eventId(), at: Date.now() },
          "public",
          participantId
        );
        const meta = await this.loadMeta();
        delete meta.pendingAiJob;
        await this.objectState.storage.put(META_KEY, meta);
        if (state.phase === "reveal") {
          state = await this.completeMatch(state, meta);
        } else {
          await this.prepareTurn(state);
        }
        await this.broadcastSnapshots();
        return;
      }
      case "reaction.send": {
        const meta = await this.loadMeta();
        const now = Date.now();
        if (now - (meta.lastReactionAt[participantId] ?? 0) < 1_000) return;
        const countKey = `${participantId}:${state.turnIndex}`;
        const reactionCount = meta.reactionCountByTurn?.[countKey] ?? 0;
        if (reactionCount >= 6) return;
        meta.lastReactionAt[participantId] = now;
        meta.reactionCountByTurn = {
          ...(meta.reactionCountByTurn ?? {}),
          [countKey]: reactionCount + 1
        };
        await this.objectState.storage.put(META_KEY, meta);
        const reaction: ReactionRecord = {
          id: eventId(),
          actorId: participantId,
          turnIndex: state.turnIndex,
          reaction: message.reaction,
          at: now
        };
        await this.applyAndBroadcast(
          state,
          { type: "reaction.sent", id: eventId(), at: now, reaction },
          state.config.mode === "ai-theatre" ? "public" : "acted",
          participantId
        );
        return;
      }
      case "postgame.review": {
        await this.requireHost(participant, message.hostToken);
        if (state.phase !== "reveal" && state.phase !== "complete") {
          throw new Error("Post-game reviews are only accepted after the relay");
        }
        if (
          (state.postGameReviews ?? []).some((review) => review.seatId === message.review.seatId)
        ) {
          await this.broadcastSnapshots();
          return;
        }
        const slot = state.timeline.find(
          (candidate) => candidate.actorType === "ai" && candidate.actorId === message.review.seatId
        );
        if (slot === undefined) throw new Error("Review seat is not part of this relay");
        const replyExists = (state.postGameReviews ?? []).some(
          (review) => review.seatId === message.review.replyToSeatId
        );
        const {
          replyToSeatId: requestedReplyToSeatId,
          actions: requestedActions,
          ...reviewPayload
        } = message.review;
        const actionTargets = new Set<string>();
        const actions = (requestedActions ?? []).flatMap((action) => {
          const target = state.timeline.find(
            (candidate) =>
              candidate.actorId === action.targetSeatId && candidate.actorId !== slot.actorId
          );
          if (target === undefined || actionTargets.has(target.actorId)) return [];
          actionTargets.add(target.actorId);
          return [
            {
              ...action,
              targetSeatId: target.actorId,
              targetDisplayName: target.displayName
            }
          ];
        });
        if (message.review.status !== "departed" && actions.length === 0) {
          throw new Error("Generated post-game reviews require a directed player interaction");
        }
        const review: PostGameReview = {
          ...reviewPayload,
          personaId: slot.personaId ?? message.review.personaId,
          displayName: slot.displayName,
          ...(replyExists && requestedReplyToSeatId !== undefined
            ? { replyToSeatId: requestedReplyToSeatId }
            : {}),
          ...(actions.length === 0 ? {} : { actions }),
          at: Date.now()
        };
        state = await this.applyAndBroadcast(
          state,
          {
            type: "postgame.reviewed",
            id: review.id,
            at: review.at,
            review
          },
          "reveal",
          review.seatId
        );
        if (state.phase === "complete")
          await this.archiveCurrentMatch(state, await this.loadMeta());
        await this.broadcastSnapshots();
        return;
      }
      case "ai.claim": {
        const meta = await this.loadMeta();
        if (meta.pendingAiJob?.job.jobId !== message.jobId)
          throw new Error("AI job is no longer active");
        const currentExecutor = state.participants.find((item) => item.id === meta.aiExecutorId);
        if (currentExecutor?.connected === true && meta.aiExecutorId !== participantId) {
          throw new Error("The current AI executor is still connected");
        }
        if ((meta.executorReconnectDeadline ?? 0) > Date.now()) {
          throw new Error("The disconnected AI executor still has time to reconnect");
        }
        meta.aiExecutorId = participantId;
        delete meta.executorReconnectDeadline;
        await this.objectState.storage.put(META_KEY, meta);
        await this.sendPendingJob(socket);
        await this.broadcastSnapshots();
        return;
      }
      case "ai.release": {
        const meta = await this.loadMeta();
        if (meta.aiExecutorId === participantId && meta.pendingAiJob?.job.jobId === message.jobId) {
          const successor = state.participants.find(
            (candidate) => candidate.id !== participantId && candidate.connected
          );
          if (successor !== undefined) {
            meta.aiExecutorId = successor.id;
            delete meta.executorReconnectDeadline;
            await this.objectState.storage.put(META_KEY, meta);
            for (const successorSocket of this.objectState.getWebSockets(successor.id)) {
              await this.sendPendingJob(successorSocket);
            }
            await this.broadcastSnapshots();
          }
        }
        return;
      }
      case "ai.activity": {
        const meta = await this.loadMeta();
        this.requireAiExecutor(participantId, meta);
        if (meta.pendingAiJob?.job.jobId !== message.activity.jobId) {
          throw new Error("AI activity is stale");
        }
        await this.broadcastAiActivity(message.activity);
        return;
      }
      case "ai.failure": {
        const meta = await this.loadMeta();
        this.requireAiExecutor(participantId, meta);
        if (meta.pendingAiJob?.job.jobId !== message.jobId) {
          throw new Error("AI failure is stale");
        }
        if (meta.pendingAiJob.job.role === "prompt") {
          const prompt = selectPrompt({
            seed: `${state.seed}:prompt-failure:${state.seq}`,
            locale: state.config.locale
          });
          state = await this.applyAndBroadcast(
            state,
            {
              type: "prompt.selected",
              id: eventId(),
              at: Date.now(),
              actorId: "system-fallback",
              text: prompt.texts[state.config.locale],
              metadata: promptMetadataForEntry(prompt, state.config.locale)
            },
            state.config.mode === "blind-relay" ? "active" : "public",
            "system"
          );
          delete meta.pendingAiJob;
          delete meta.promptExpiresAt;
          delete meta.generatedPromptAttempts;
          await this.objectState.storage.put(META_KEY, meta);
          await this.prepareTurn(state);
          await this.broadcastSnapshots();
          return;
        }
        const activeSlot = state.timeline[state.turnIndex];
        if (activeSlot?.actorType !== "ai" || activeSlot.actorId !== meta.pendingAiJob.seatId) {
          throw new Error("No matching AI turn can be failed");
        }
        await this.abortAiTurn(state, meta, activeSlot.actorId, message.errorCode);
        return;
      }
      case "ai.result": {
        const meta = await this.loadMeta();
        this.requireAiExecutor(participantId, meta);
        const result = AiTurnResultSchema.parse(message.result);
        if (meta.pendingAiJob?.job.jobId !== result.jobId) throw new Error("AI result is stale");
        if (meta.pendingAiJob.job.role === "prompt") {
          const generated = result.prompt;
          const generatedKind = result.promptKind ?? "phrase";
          const generatedIsPlayable =
            generated !== undefined &&
            validatePlayablePromptText(generated, generatedKind, state.config.locale).ok;
          const reactionIsSafe = isLiveReactionSpoilerFree(result, meta.pendingAiJob.job);
          if (
            (!generatedIsPlayable || !reactionIsSafe) &&
            (meta.generatedPromptAttempts ?? 1) < 3
          ) {
            delete meta.pendingAiJob;
            delete meta.promptExpiresAt;
            await this.issuePromptJob(state, meta);
            return;
          }
          const generatedIsValid = reactionIsSafe && generatedIsPlayable;
          const fallbackPrompt = generatedIsValid
            ? undefined
            : selectPrompt({
                seed: `${state.seed}:generated-fallback:${state.seq}`,
                locale: state.config.locale
              });
          const text = generatedIsValid ? generated! : fallbackPrompt!.texts[state.config.locale];
          const metadata = generatedIsValid
            ? createPromptMetadata(
                text,
                state.config.locale,
                generatedKind,
                result.promptTopic ?? "other"
              )
            : promptMetadataForEntry(fallbackPrompt!, state.config.locale);
          state = await this.applyAndBroadcast(
            state,
            {
              type: "prompt.selected",
              id: eventId(),
              at: Date.now(),
              actorId: meta.pendingAiJob.seatId,
              text,
              metadata
            },
            state.config.mode === "blind-relay" ? "active" : "public",
            meta.pendingAiJob.seatId
          );
          delete meta.pendingAiJob;
          delete meta.promptExpiresAt;
          delete meta.generatedPromptAttempts;
          await this.objectState.storage.put(META_KEY, meta);
          await this.prepareTurn(state);
          await this.broadcastSnapshots();
          return;
        }
        const activeSlot = state.timeline[state.turnIndex];
        if (activeSlot?.actorType !== "ai") throw new Error("No AI turn is active");
        if (!isLiveReactionSpoilerFree(result, meta.pendingAiJob.job)) {
          await this.abortAiTurn(state, meta, activeSlot.actorId, "unsafe-reaction");
          return;
        }
        if (activeSlot.role === "draw") {
          if (result.commands === undefined) {
            await this.abortAiTurn(state, meta, activeSlot.actorId, "invalid-result");
            return;
          }
          const validation = validateCanvasCommands(
            result.commands,
            {
              maxStrokes: state.config.rules.maxStrokes,
              maxUndos: state.config.rules.maxUndos,
              colorCount: state.config.rules.colorCount,
              maxTotalPoints: 4096
            },
            { requireFinish: true }
          );
          if (!validation.ok) {
            await this.abortAiTurn(state, meta, activeSlot.actorId, "invalid-canvas");
            return;
          }
          if (!hasVisibleCanvasContent(validation.commands)) {
            await this.abortAiTurn(
              state,
              meta,
              activeSlot.actorId,
              normalizedAiErrorCode(result.errorCode ?? "empty-drawing")
            );
            return;
          }
          state = await this.applyAndBroadcast(
            state,
            {
              type: "drawing.submitted",
              id: eventId(),
              at: Date.now(),
              actorId: activeSlot.actorId,
              commands: validation.commands,
              canvasHash: hashCanvasCommands(validation.commands)
            },
            "acted",
            activeSlot.actorId
          );
        } else {
          if (result.guess === undefined) throw new Error("AI guess result is missing text");
          state = await this.applyAndBroadcast(
            state,
            {
              type: "guess.submitted",
              id: eventId(),
              at: Date.now(),
              actorId: activeSlot.actorId,
              text: result.guess
            },
            "acted",
            activeSlot.actorId
          );
        }
        const reaction: ReactionRecord = {
          id: eventId(),
          actorId: activeSlot.actorId,
          turnIndex: state.turnIndex,
          reaction: result.reaction.kind,
          text: result.reaction.text,
          at: Date.now()
        };
        state = await this.applyAndBroadcast(
          state,
          { type: "reaction.sent", id: eventId(), at: Date.now(), reaction },
          state.config.mode === "ai-theatre" ? "public" : "acted",
          activeSlot.actorId
        );
        delete meta.pendingAiJob;
        delete meta.turnExpiresAt;
        delete meta.executorReconnectDeadline;
        delete meta.drawingDraft;
        await this.objectState.storage.put(META_KEY, meta);
        const playbackDelayMs =
          activeSlot.role === "draw"
            ? aiPlaybackDurationMs(
                result.commands?.filter((command) => command.type === "stroke").length ?? 0,
                state.config.rules.aiPlaybackSeconds
              )
            : 2_200;
        await this.scheduleRoomAlarm(meta, Date.now() + playbackDelayMs);
        await this.broadcastSnapshots();
        return;
      }
      case "signal.offer":
      case "signal.answer":
      case "signal.ice": {
        if (!this.transientRateAllows(participantId, "signals", 600, 60_000)) return;
        if (
          message.peerId === participantId ||
          !state.participants.some(
            (candidate) => candidate.id === message.peerId && candidate.connected
          )
        ) {
          throw new Error("WebRTC signal target is not a connected room member");
        }
        this.forwardToPeer(message.peerId, { ...message, peerId: participantId });
        return;
      }
      case "preview.cursor":
        await this.broadcastPreview(participantId, message.point);
        return;
      case "preview.stroke":
        await this.broadcastStrokePreview(participantId, message.command, message.generation);
        return;
      case "preview.clear":
        await this.broadcastPreviewClear(participantId, message.generation);
        return;
      case "ping":
        socket.send(
          JSON.stringify({
            type: "pong",
            nonce: message.nonce,
            serverTime: Date.now()
          } satisfies ServerMessage)
        );
        return;
    }
  }

  private requireActiveHuman(
    state: GameState,
    participantId: string,
    role: "draw" | "guess"
  ): void {
    const slot = state.timeline[state.turnIndex];
    if (
      state.phase !== "turn" ||
      slot?.actorType !== "human" ||
      slot.role !== role ||
      slot.actorId !== participantId
    ) {
      throw new Error("This participant does not own the active turn");
    }
  }

  private transientRateAllows(
    participantId: string,
    bucket: string,
    limit: number,
    windowMs: number
  ): boolean {
    const now = Date.now();
    const key = `${participantId}:${bucket}`;
    const current = this.transientRateWindows.get(key);
    if (current === undefined || now - current.startedAt >= windowMs) {
      if (this.transientRateWindows.size > 64) {
        for (const [candidateKey, candidate] of this.transientRateWindows) {
          if (now - candidate.startedAt >= 60_000) {
            this.transientRateWindows.delete(candidateKey);
          }
        }
      }
      this.transientRateWindows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  private requireAiExecutor(participantId: string, meta: RoomMeta): void {
    if (meta.aiExecutorId !== participantId)
      throw new Error("This participant is not the AI executor");
  }

  private async abortAiTurn(
    state: GameState,
    meta: RoomMeta,
    actorId: string,
    errorCode: string
  ): Promise<GameState> {
    const next = await this.applyAndBroadcast(
      state,
      {
        type: "game.failed",
        id: eventId(),
        at: Date.now(),
        actorId,
        turnIndex: state.turnIndex,
        errorCode: normalizedAiErrorCode(errorCode)
      },
      "public",
      actorId
    );
    delete meta.pendingAiJob;
    delete meta.turnExpiresAt;
    delete meta.promptExpiresAt;
    delete meta.executorReconnectDeadline;
    delete meta.drawingDraft;
    meta.idleExpiresAt = Date.now() + this.idleRoomMs;
    await this.objectState.storage.put(META_KEY, meta);
    await this.scheduleRoomAlarm(meta, meta.idleExpiresAt);
    await this.broadcastSnapshots();
    return next;
  }

  private async restartRoom(state: GameState, meta: RoomMeta, actorId: string): Promise<GameState> {
    const next = await this.applyAndBroadcast(
      state,
      {
        type: "game.restarted",
        id: eventId(),
        at: Date.now(),
        seed: randomToken(12)
      },
      "public",
      actorId
    );
    delete meta.pendingAiJob;
    delete meta.replayTokenHash;
    delete meta.replayExpiresAt;
    delete meta.roundEventStartSeq;
    delete meta.roundStartedAt;
    delete meta.turnExpiresAt;
    delete meta.promptExpiresAt;
    delete meta.generatedPromptAttempts;
    delete meta.executorReconnectDeadline;
    delete meta.automatedRoundtableAt;
    delete meta.drawingDraft;
    delete meta.authorizedReviewJobIds;
    delete meta.serverAiCalls;
    meta.lastReactionAt = {};
    delete meta.reactionCountByTurn;
    meta.idleExpiresAt = Date.now() + this.idleRoomMs;
    await this.objectState.storage.put(META_KEY, meta);
    if (!meta.automated) await this.scheduleRoomAlarm(meta, meta.idleExpiresAt);
    return next;
  }

  private async completeMatch(state: GameState, meta: RoomMeta): Promise<GameState> {
    if (state.phase !== "reveal") return state;
    if (meta.automated === true && this.automatedRoundtableHasMissingReviews(state)) {
      await this.queueAutomatedRoundtable(meta);
      return state;
    }
    state = await this.applyAndPersist(state, {
      type: "game.revealed",
      id: eventId(),
      at: Date.now()
    });
    const rawReplayToken = `${state.roomId}.${randomToken(16)}`;
    state = await this.applyAndPersist(state, {
      type: "game.completed",
      id: eventId(),
      at: Date.now(),
      replayToken: rawReplayToken
    });
    meta.replayTokenHash = await hashToken(rawReplayToken);
    meta.replayExpiresAt = Date.now() + state.config.replayDays * 86_400_000;
    meta.idleExpiresAt = Date.now() + this.idleRoomMs;
    delete meta.automatedRoundtableAt;
    await this.objectState.storage.put(META_KEY, meta);
    await this.archiveCurrentMatch(state, meta);
    if (!meta.automated) await this.scheduleRoomAlarm(meta, meta.idleExpiresAt);
    return state;
  }

  private async archiveCurrentMatch(state: GameState, meta: RoomMeta): Promise<boolean> {
    try {
      if (meta.replayExpiresAt === undefined) return false;
      const rows = this.objectState.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM room_events WHERE seq >= ? ORDER BY seq ASC",
          meta.roundEventStartSeq ?? 0
        )
        .toArray();
      return this.upsertArchivedMatch(
        state,
        rows.map((row) => JSON.parse(row.payload) as unknown),
        {
          startedAt: meta.roundStartedAt ?? state.createdAt,
          completedAt: state.updatedAt,
          expiresAt: meta.replayExpiresAt
        }
      );
    } catch {
      return false;
    }
  }

  private async upsertArchivedMatch(
    state: GameState,
    events: readonly unknown[],
    summary: Pick<ArchivedAutomatedRoundtable, "startedAt" | "completedAt" | "expiresAt">
  ): Promise<boolean> {
    if (state.replayToken === undefined) return false;
    const prompt = state.artifacts.find((artifact) => artifact.kind === "prompt")?.text;
    if (prompt === undefined) return false;
    const envelope: ArchivedMatchEnvelope = {
      summary: {
        token: state.replayToken,
        roomId: state.roomId,
        startedAt: summary.startedAt,
        completedAt: summary.completedAt,
        expiresAt: summary.expiresAt,
        mode: state.config.mode,
        locale: state.config.locale,
        prompt,
        playerCount: state.timeline.length,
        turnCount: state.timeline.length
      },
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        roomId: state.roomId,
        expiresAt: summary.expiresAt,
        state,
        events
      }
    };
    const now = Date.now();
    this.objectState.storage.sql.exec(
      `
        INSERT INTO pending_match_archives (
          token, envelope, attempts, next_attempt_at, created_at, last_error_code
        ) VALUES (?, ?, 0, ?, ?, NULL)
        ON CONFLICT(token) DO UPDATE SET
          envelope = excluded.envelope,
          next_attempt_at = excluded.next_attempt_at,
          last_error_code = NULL
      `,
      envelope.summary.token,
      JSON.stringify(envelope),
      now,
      now
    );
    return this.deliverPendingArchive(envelope.summary.token, now);
  }

  private archiveRetryAt(token: string, attempts: number, now: number): number {
    const exponentialDelay = Math.min(
      AUTOMATED_ARCHIVE_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1),
      MATCH_ARCHIVE_MAX_RETRY_DELAY_MS
    );
    const jitterMs =
      [...token].reduce((sum, character) => sum + character.charCodeAt(0), attempts) % 1_000;
    return now + exponentialDelay + jitterMs;
  }

  private pendingArchive(token: string): PendingMatchArchiveRow | undefined {
    return this.objectState.storage.sql
      .exec<PendingMatchArchiveRow>(
        `
          SELECT token, envelope, attempts, next_attempt_at
          FROM pending_match_archives
          WHERE token = ?
          LIMIT 1
        `,
        token
      )
      .toArray()[0];
  }

  private async deliverArchiveRow(row: PendingMatchArchiveRow, now = Date.now()): Promise<boolean> {
    let errorCode = "archive-fetch-failed";
    try {
      const envelope = JSON.parse(row.envelope) as ArchivedMatchEnvelope;
      const response = await this.env.MATCHES.getByName("global").fetch(
        "https://matches.internal/upsert",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope)
        }
      );
      if (response.ok) {
        this.objectState.storage.sql.exec(
          "DELETE FROM pending_match_archives WHERE token = ?",
          row.token
        );
        return true;
      }
      errorCode = `archive-http-${response.status}`;
    } catch (error) {
      errorCode =
        error instanceof SyntaxError
          ? "invalid-archive-envelope"
          : error instanceof Error && error.name === "TimeoutError"
            ? "archive-timeout"
            : "archive-fetch-failed";
    }
    const attempts = row.attempts + 1;
    this.objectState.storage.sql.exec(
      `
        UPDATE pending_match_archives
        SET attempts = ?, next_attempt_at = ?, last_error_code = ?
        WHERE token = ?
      `,
      attempts,
      this.archiveRetryAt(row.token, attempts, now),
      errorCode,
      row.token
    );
    return false;
  }

  private async deliverPendingArchive(token: string, now = Date.now()): Promise<boolean> {
    const row = this.pendingArchive(token);
    if (row === undefined) return true;
    const delivered = await this.deliverArchiveRow(row, now);
    const meta = await this.objectState.storage.get<RoomMeta>(META_KEY);
    if (meta !== undefined) await this.scheduleRoomAlarm(meta);
    return delivered;
  }

  private async deliverDueMatchArchives(now = Date.now()): Promise<void> {
    const rows = this.objectState.storage.sql
      .exec<PendingMatchArchiveRow>(
        `
          SELECT token, envelope, attempts, next_attempt_at
          FROM pending_match_archives
          WHERE next_attempt_at <= ?
          ORDER BY next_attempt_at ASC, created_at ASC
          LIMIT ?
        `,
        now,
        MATCH_ARCHIVE_DELIVERY_BATCH
      )
      .toArray();
    for (const row of rows) await this.deliverArchiveRow(row, now);
  }

  private hasPendingMatchArchives(): boolean {
    return (
      this.objectState.storage.sql
        .exec<{ token: string }>("SELECT token FROM pending_match_archives LIMIT 1")
        .toArray().length > 0
    );
  }

  private async requireHost(participant: Participant, token: string): Promise<void> {
    if (participant.roomRole !== "host") throw new Error("Host permission required");
    const credentials = await this.loadCredentials();
    if (!(await tokenMatches(token, credentials.hostHash)))
      throw new Error("Host token is invalid");
  }

  private async transferHost(
    state: GameState,
    fromParticipantId: string,
    toParticipantId: string
  ): Promise<void> {
    const nextToken = randomToken();
    const credentials = await this.loadCredentials();
    credentials.hostHash = await hashToken(nextToken);
    await this.objectState.storage.put(CREDENTIALS_KEY, credentials);
    await this.applyAndBroadcast(
      state,
      {
        type: "player.host-transferred",
        id: eventId(),
        at: Date.now(),
        fromParticipantId,
        toParticipantId
      },
      "public",
      fromParticipantId
    );
    for (const socket of this.objectState.getWebSockets(toParticipantId)) {
      socket.send(
        JSON.stringify({ type: "room.host-token", hostToken: nextToken } satisfies ServerMessage)
      );
    }
  }

  private async issueAiJobIfNeeded(state: GameState): Promise<void> {
    if (state.phase !== "turn") return;
    const slot = state.timeline[state.turnIndex];
    if (slot?.actorType !== "ai") return;
    const meta = await this.loadMeta();
    delete meta.drawingDraft;
    const seat = meta.aiSeats.find((candidate) => candidate.seatId === slot.actorId);
    if (seat === undefined) throw new Error("AI seat configuration is missing");
    if (!seat.ready || !modelSupportsRole(seat.capabilities, slot.role)) {
      throw new Error(`AI seat does not support its assigned ${slot.role} turn`);
    }
    const previous = state.artifacts.at(-1);
    const promptMetadata =
      state.promptMetadata ??
      state.artifacts.find((artifact) => artifact.kind === "prompt")?.metadata;
    const job: AiTurnJob = {
      jobId: `job_${randomToken(12)}`,
      roomId: state.roomId,
      turnIndex: state.turnIndex,
      role: slot.role,
      locale: state.config.locale,
      personaId: seat.personaId,
      ...(seat.personaCustomization === undefined
        ? {}
        : { personaCustomization: seat.personaCustomization }),
      inputText:
        previous?.kind === "prompt" || previous?.kind === "guess" ? previous.text : undefined,
      ...(slot.role === "guess" && promptMetadata !== undefined
        ? { promptMetadata: promptMetadataForGuess(state, promptMetadata) }
        : {}),
      inputCommands: previous?.kind === "drawing" ? previous.commands : undefined,
      observationIndex: 0,
      observationLimit: observationPassLimitForRole(
        slot.role,
        state.config.rules.aiObservationPasses,
        seat.capabilities
      ),
      timeLimitSeconds:
        slot.role === "draw"
          ? state.config.rules.aiRequestTimeoutSeconds
          : state.config.rules.guessSeconds,
      budget: {
        maxStrokes: state.config.rules.maxStrokes,
        maxUndos: state.config.rules.maxUndos,
        colorCount: state.config.rules.colorCount,
        remainingStrokes: state.config.rules.maxStrokes,
        remainingUndos: state.config.rules.maxUndos
      }
    };
    meta.pendingAiJob = { seatId: seat.seatId, job, createdAt: Date.now() };
    await this.objectState.storage.put(META_KEY, meta);
    for (const socket of this.objectState.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.participantId === meta.aiExecutorId) {
        socket.send(
          JSON.stringify({ type: "ai.job", seatId: seat.seatId, job } satisfies ServerMessage)
        );
      }
    }
  }

  private async prepareTurn(state: GameState): Promise<void> {
    if (state.phase !== "turn") return;
    await this.issueAiJobIfNeeded(state);
    const slot = state.timeline[state.turnIndex];
    if (slot === undefined) return;
    const meta = await this.loadMeta();
    const seconds =
      slot.actorType === "ai"
        ? (meta.pendingAiJob?.job.timeLimitSeconds ?? state.config.rules.aiRequestTimeoutSeconds)
        : slot.role === "draw"
          ? state.config.rules.drawSeconds
          : state.config.rules.guessSeconds;
    meta.turnExpiresAt = Date.now() + seconds * 1_000 + (slot.actorType === "ai" ? 2_500 : 0);
    await this.objectState.storage.put(META_KEY, meta);
    await this.scheduleRoomAlarm(meta, meta.turnExpiresAt);
  }

  private async clearTurnDeadline(): Promise<RoomMeta> {
    const meta = await this.loadMeta();
    delete meta.turnExpiresAt;
    delete meta.drawingDraft;
    await this.objectState.storage.put(META_KEY, meta);
    return meta;
  }

  private async issuePromptJob(state: GameState, meta: RoomMeta): Promise<void> {
    const seat = meta.aiSeats.find(
      (candidate) => candidate.ready && modelSupportsRole(candidate.capabilities, "prompt")
    );
    if (seat === undefined) throw new Error("No AI seat is available to generate a prompt");
    const job: AiTurnJob = {
      jobId: `job_${randomToken(12)}`,
      roomId: state.roomId,
      turnIndex: -1,
      role: "prompt",
      locale: state.config.locale,
      personaId: seat.personaId,
      ...(seat.personaCustomization === undefined
        ? {}
        : { personaCustomization: seat.personaCustomization }),
      observationIndex: 0,
      observationLimit: 0,
      timeLimitSeconds: state.config.rules.aiRequestTimeoutSeconds,
      budget: {
        maxStrokes: state.config.rules.maxStrokes,
        maxUndos: state.config.rules.maxUndos,
        colorCount: state.config.rules.colorCount,
        remainingStrokes: state.config.rules.maxStrokes,
        remainingUndos: state.config.rules.maxUndos
      }
    };
    meta.pendingAiJob = { seatId: seat.seatId, job, createdAt: Date.now() };
    meta.generatedPromptAttempts = (meta.generatedPromptAttempts ?? 0) + 1;
    meta.promptExpiresAt = Date.now() + job.timeLimitSeconds * 1_000 + 2_500;
    await this.objectState.storage.put(META_KEY, meta);
    await this.scheduleRoomAlarm(meta, meta.promptExpiresAt);
    for (const socket of this.objectState.getWebSockets(meta.aiExecutorId)) {
      socket.send(
        JSON.stringify({ type: "ai.job", seatId: seat.seatId, job } satisfies ServerMessage)
      );
    }
  }

  private async sendPendingJob(socket: WebSocket): Promise<void> {
    const attachment = this.socketIdentity(socket);
    const meta = await this.loadMeta();
    if (meta.aiExecutorId === attachment.participantId && meta.pendingAiJob !== undefined) {
      socket.send(
        JSON.stringify({
          type: "ai.job",
          seatId: meta.pendingAiJob.seatId,
          job: meta.pendingAiJob.job
        } satisfies ServerMessage)
      );
    }
  }

  private forwardToPeer(peerId: string, message: ServerMessage): void {
    for (const socket of this.objectState.getWebSockets(peerId)) {
      socket.send(JSON.stringify(message));
    }
  }

  private async broadcastPreview(
    actorId: string,
    point: { x: number; y: number } | null
  ): Promise<void> {
    const state = await this.loadState();
    const activeId = state.timeline[state.turnIndex]?.actorId;
    if (activeId !== actorId) return;
    for (const socket of this.objectState.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      const participant = state.participants.find((item) => item.id === attachment?.participantId);
      if (participant === undefined) continue;
      const visible =
        state.config.mode === "ai-theatre" ||
        participant.hasActed ||
        participant.roomRole === "spectator" ||
        isNonPlayingHost(state, participant) ||
        participant.id === actorId;
      if (visible) {
        socket.send(
          JSON.stringify({ type: "preview.cursor", peerId: actorId, point } satisfies ServerMessage)
        );
      }
    }
  }

  private async broadcastStrokePreview(
    actorId: string,
    command: Extract<ClientMessage, { type: "preview.stroke" }>["command"],
    generation: number
  ): Promise<void> {
    const state = await this.loadState();
    const activeId = state.timeline[state.turnIndex]?.actorId;
    const meta = await this.loadMeta();
    const activeSlot = state.timeline[state.turnIndex];
    const canPublish =
      activeId === actorId || (activeSlot?.actorType === "ai" && meta.aiExecutorId === actorId);
    if ((state.phase !== "turn" && state.phase !== "inspect") || !canPublish) return;
    for (const socket of this.objectState.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      const participant = state.participants.find((item) => item.id === attachment?.participantId);
      if (participant === undefined) continue;
      const visible =
        state.config.mode === "ai-theatre" ||
        participant.hasActed ||
        participant.roomRole === "spectator" ||
        isNonPlayingHost(state, participant) ||
        participant.id === activeId;
      if (visible) {
        socket.send(
          JSON.stringify({
            type: "preview.stroke",
            peerId: actorId,
            command,
            generation
          } satisfies ServerMessage)
        );
      }
    }
  }

  private async broadcastPreviewClear(actorId: string, generation: number): Promise<void> {
    const state = await this.loadState();
    const meta = await this.loadMeta();
    const activeSlot = state.timeline[state.turnIndex];
    const activeId = activeSlot?.actorId;
    const canPublish =
      activeId === actorId || (activeSlot?.actorType === "ai" && meta.aiExecutorId === actorId);
    if ((state.phase !== "turn" && state.phase !== "inspect") || !canPublish) return;
    for (const socket of this.objectState.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      const participant = state.participants.find((item) => item.id === attachment?.participantId);
      if (participant === undefined) continue;
      const visible =
        state.config.mode === "ai-theatre" ||
        participant.hasActed ||
        participant.roomRole === "spectator" ||
        isNonPlayingHost(state, participant) ||
        participant.id === activeId;
      if (visible) {
        socket.send(
          JSON.stringify({
            type: "preview.clear",
            peerId: actorId,
            generation
          } satisfies ServerMessage)
        );
      }
    }
  }

  private async broadcastAiActivity(
    activity: Extract<ClientMessage, { type: "ai.activity" }>["activity"]
  ): Promise<void> {
    const state = await this.loadState();
    const meta = await this.loadMeta();
    for (const socket of this.objectState.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      const participant = state.participants.find((item) => item.id === attachment?.participantId);
      if (participant === undefined) continue;
      const visible =
        state.config.mode === "ai-theatre" ||
        participant.hasActed ||
        participant.roomRole === "spectator" ||
        isNonPlayingHost(state, participant) ||
        meta.aiExecutorId === participant.id;
      if (visible) {
        socket.send(JSON.stringify({ type: "ai.activity", activity } satisfies ServerMessage));
      }
    }
  }

  private async applyAndPersist(state: GameState, event: GameEvent): Promise<GameState> {
    const parsed = GameEventSchema.parse(event);
    const next = applyGameEvent(state, parsed);
    await this.objectState.storage.put(STATE_KEY, next);
    this.objectState.storage.sql.exec(
      "INSERT OR IGNORE INTO room_events (seq, event_id, event_type, created_at, payload) VALUES (?, ?, ?, ?, ?)",
      next.seq,
      parsed.id,
      parsed.type,
      parsed.at,
      JSON.stringify(parsed)
    );
    return next;
  }

  private async applyAndBroadcast(
    state: GameState,
    event: GameEvent,
    visibility: Visibility,
    actorId: string
  ): Promise<GameState> {
    const next = await this.applyAndPersist(state, event);
    const envelope: GameEnvelope = {
      v: PROTOCOL_VERSION,
      roomId: state.roomId,
      seq: next.seq,
      eventId: event.id,
      actorId,
      visibility,
      type: event.type,
      payload: event,
      sentAt: Date.now()
    };
    await this.broadcastEnvelope(envelope, next);
    return next;
  }

  private async broadcastEnvelope(envelope: GameEnvelope, state: GameState): Promise<void> {
    const meta = await this.loadMeta();
    const activeParticipantId = state.timeline[state.turnIndex]?.actorId;
    for (const socket of this.objectState.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      const participant = state.participants.find((item) => item.id === attachment?.participantId);
      if (participant === undefined) continue;
      if (
        canView(
          envelope.visibility,
          {
            participantId: participant.id,
            roomRole: isNonPlayingHost(state, participant) ? "spectator" : participant.roomRole,
            hasActed: participant.hasActed,
            isAiExecutor: meta.aiExecutorId === participant.id
          },
          {
            ...(activeParticipantId === undefined ? {} : { activeParticipantId }),
            phase: state.phase
          }
        )
      ) {
        socket.send(JSON.stringify({ type: "room.event", envelope } satisfies ServerMessage));
      }
    }
  }

  private visibleState(state: GameState, participantId: string, meta: RoomMeta): GameState {
    const participant = state.participants.find((item) => item.id === participantId);
    if (participant === undefined) throw new Error("Participant not found");
    const activeId = state.timeline[state.turnIndex]?.actorId;
    const seesAll =
      state.config.mode === "ai-theatre" ||
      state.phase === "reveal" ||
      state.phase === "complete" ||
      participant.roomRole === "spectator" ||
      isNonPlayingHost(state, participant) ||
      participant.hasActed ||
      meta.aiExecutorId === participantId;
    if (seesAll) return state;
    const isActive = activeId === participantId;
    const { promptMetadata, ...publicState } = state;
    return {
      ...publicState,
      ...(isActive && promptMetadata !== undefined ? { promptMetadata } : {}),
      artifacts: isActive ? state.artifacts.slice(-1) : [],
      reactions: []
    };
  }

  private async sendSnapshot(socket: WebSocket): Promise<void> {
    const state = await this.loadState();
    const meta = await this.loadMeta();
    const { participantId } = this.socketIdentity(socket);
    if (!state.participants.some((participant) => participant.id === participantId)) {
      socket.close(1008, "Participant is no longer in this room");
      return;
    }
    const peers = state.participants
      .filter((participant) => participant.connected)
      .map((participant) => ({
        id: participant.id,
        displayName: participant.displayName,
        role: participant.roomRole
      }));
    socket.send(
      JSON.stringify({
        type: "room.snapshot",
        state: this.visibleState(state, participantId, meta),
        peers,
        aiSeats: meta.aiSeats,
        ...(meta.automated === true ? { automated: true } : {})
      } satisfies ServerMessage)
    );
  }

  private async broadcastSnapshots(): Promise<void> {
    for (const socket of this.objectState.getWebSockets()) {
      await this.sendSnapshot(socket);
    }
  }

  private async getReplay(token: string): Promise<Response> {
    const [state, meta] = await Promise.all([
      this.objectState.storage.get<GameState>(STATE_KEY),
      this.objectState.storage.get<RoomMeta>(META_KEY)
    ]);
    if (
      state === undefined ||
      meta === undefined ||
      meta.replayTokenHash === undefined ||
      meta.replayExpiresAt === undefined ||
      Date.now() >= meta.replayExpiresAt ||
      !(await tokenMatches(token, meta.replayTokenHash))
    ) {
      return jsonResponse({ error: "replay-not-found" }, 404);
    }
    const rows = this.objectState.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM room_events ORDER BY seq ASC")
      .toArray();
    return jsonResponse({
      protocolVersion: PROTOCOL_VERSION,
      roomId: state.roomId,
      expiresAt: meta.replayExpiresAt,
      state,
      events: rows.map((row) => JSON.parse(row.payload) as unknown)
    });
  }

  private async deleteReplay(payload: { hostToken?: string }): Promise<Response> {
    if (payload.hostToken === undefined) return jsonResponse({ error: "unauthorized" }, 401);
    const credentials = await this.objectState.storage.get<RoomCredentials>(CREDENTIALS_KEY);
    if (credentials === undefined) return jsonResponse({ error: "not-found" }, 404);
    if (!(await tokenMatches(payload.hostToken, credentials.hostHash))) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    await this.objectState.storage.deleteAll();
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.deliverDueMatchArchives(now);
    let state = await this.objectState.storage.get<GameState>(STATE_KEY);
    const meta = await this.objectState.storage.get<RoomMeta>(META_KEY);
    if (meta !== undefined) await this.scheduleRoomAlarm(meta);
    if (state !== undefined && meta?.automated === true) {
      const pruned = await this.pruneAutomatedParticipants(state, meta, now);
      state = pruned.state;
      if (this.automatedRoundtableRequiresSettlement(state, meta)) {
        if (meta.automatedRoundtableAt === undefined) {
          await this.queueAutomatedRoundtable(meta);
        } else if (now >= meta.automatedRoundtableAt) {
          state = await this.advanceAutomatedRoundtable(state, meta);
          await this.broadcastSnapshots();
        } else {
          await this.scheduleRoomAlarm(meta, meta.automatedRoundtableAt);
        }
        return;
      }
      if (meta.automatedArchivedRoundtable !== undefined) {
        if (meta.automatedArchivedRoundtableAt === undefined) {
          await this.queueArchivedAutomatedRoundtable(meta);
        } else if (now >= meta.automatedArchivedRoundtableAt) {
          await this.advanceArchivedAutomatedRoundtable(meta);
        } else {
          await this.scheduleRoomAlarm(meta, meta.automatedArchivedRoundtableAt);
        }
        return;
      }
      const nextDeadline = this.roomAlarmAt(meta);
      if (pruned.removed) await this.broadcastSnapshots();
      if (nextDeadline !== undefined && now < nextDeadline) {
        await this.scheduleRoomAlarm(meta, nextDeadline);
        return;
      }
    }
    if (
      state !== undefined &&
      meta?.automated !== true &&
      meta?.idleExpiresAt !== undefined &&
      (state.phase === "lobby" || state.phase === "failed" || state.phase === "complete") &&
      now >= meta.idleExpiresAt
    ) {
      for (const socket of this.objectState.getWebSockets()) socket.close(1001, "Room expired");
      if (this.hasPendingMatchArchives()) {
        await this.scheduleRoomAlarm(meta);
        return;
      }
      await this.objectState.storage.deleteAll();
      return;
    }
    if (meta?.executorReconnectDeadline !== undefined) {
      if (now < meta.executorReconnectDeadline) {
        await this.scheduleRoomAlarm(meta, meta.executorReconnectDeadline);
        return;
      }
      const executor = state?.participants.find(
        (participant) => participant.id === meta.aiExecutorId
      );
      if (executor?.connected !== true && meta.pendingAiJob !== undefined) {
        const successor = state?.participants.find((participant) => participant.connected);
        if (successor !== undefined) {
          meta.aiExecutorId = successor.id;
          for (const socket of this.objectState.getWebSockets(successor.id)) {
            socket.send(
              JSON.stringify({
                type: "ai.job",
                seatId: meta.pendingAiJob.seatId,
                job: meta.pendingAiJob.job
              } satisfies ServerMessage)
            );
          }
        }
      }
      delete meta.executorReconnectDeadline;
      await this.objectState.storage.put(META_KEY, meta);
      const nextAlarm = meta.turnExpiresAt ?? meta.promptExpiresAt;
      if (nextAlarm !== undefined) await this.scheduleRoomAlarm(meta, nextAlarm);
      return;
    }
    if (state?.phase === "prompt" && meta?.promptExpiresAt !== undefined) {
      if (now < meta.promptExpiresAt) {
        await this.scheduleRoomAlarm(meta, meta.promptExpiresAt);
        return;
      }
      const prompt = selectPrompt({
        seed: `${state.seed}:prompt-timeout:${state.seq}`,
        locale: state.config.locale
      });
      state = await this.applyAndBroadcast(
        state,
        {
          type: "prompt.selected",
          id: eventId(),
          at: now,
          actorId: "system-timeout",
          text: prompt.texts[state.config.locale],
          metadata: promptMetadataForEntry(prompt, state.config.locale)
        },
        state.config.mode === "blind-relay" ? "active" : "public",
        "system"
      );
      delete meta.pendingAiJob;
      delete meta.promptExpiresAt;
      delete meta.generatedPromptAttempts;
      await this.objectState.storage.put(META_KEY, meta);
      await this.prepareTurn(state);
      await this.broadcastSnapshots();
      return;
    }
    if (
      (state?.phase === "turn" || state?.phase === "inspect") &&
      meta?.turnExpiresAt !== undefined
    ) {
      if (now < meta.turnExpiresAt) {
        await this.scheduleRoomAlarm(meta, meta.turnExpiresAt);
        return;
      }
      const slot = state.timeline[state.turnIndex];
      if (slot === undefined) return;
      if (slot.role === "draw") {
        const draft =
          meta.drawingDraft?.turnIndex === state.turnIndex &&
          meta.drawingDraft.actorId === slot.actorId
            ? finalizeDrawingDraft(
                meta.drawingDraft.commands,
                {
                  maxStrokes: state.config.rules.maxStrokes,
                  maxUndos: state.config.rules.maxUndos,
                  colorCount: state.config.rules.colorCount,
                  maxTotalPoints: 4096
                },
                `timeout-${state.turnIndex}`
              )
            : undefined;
        if (slot.actorType === "ai" && draft === undefined) {
          await this.abortAiTurn(state, meta, slot.actorId, "timeout");
          return;
        }
        const commands =
          draft ??
          ([
            { type: "finish" as const, id: `timeout-${state.turnIndex}`, offsetMs: 0 }
          ] satisfies CanvasCommand[]);
        state = await this.applyAndBroadcast(
          state,
          {
            type: "drawing.submitted",
            id: eventId(),
            at: now,
            actorId: slot.actorId,
            commands,
            canvasHash: hashCanvasCommands(commands)
          },
          "acted",
          slot.actorId
        );
      } else {
        state = await this.applyAndBroadcast(
          state,
          {
            type: "guess.submitted",
            id: eventId(),
            at: now,
            actorId: slot.actorId,
            text:
              state.config.locale === "zh-CN"
                ? "时间到了，我决定相信直觉"
                : "Time ran out, so I trusted instinct"
          },
          "acted",
          slot.actorId
        );
      }
      const reaction: ReactionRecord = {
        id: eventId(),
        actorId: slot.actorId,
        turnIndex: state.turnIndex,
        reaction: "egg",
        text: state.config.locale === "zh-CN" ? "这次是计时器赢了。" : "The timer won this round.",
        at: now
      };
      state = await this.applyAndBroadcast(
        state,
        { type: "reaction.sent", id: eventId(), at: now, reaction },
        state.config.mode === "ai-theatre" ? "public" : "acted",
        slot.actorId
      );
      delete meta.pendingAiJob;
      delete meta.turnExpiresAt;
      delete meta.drawingDraft;
      await this.objectState.storage.put(META_KEY, meta);
      await this.scheduleRoomAlarm(meta, now + 2_200);
      await this.broadcastSnapshots();
      return;
    }
    if (state?.phase === "reaction" && meta !== undefined) {
      state = await this.applyAndBroadcast(
        state,
        { type: "turn.advanced", id: eventId(), at: Date.now() },
        "public",
        "system"
      );
      delete meta.pendingAiJob;
      delete meta.drawingDraft;
      await this.objectState.storage.put(META_KEY, meta);
      if (state.phase === "reveal") {
        state = await this.completeMatch(state, meta);
      } else {
        await this.prepareTurn(state);
      }
      await this.broadcastSnapshots();
      return;
    }
  }
}
