import {
  AiTurnJobSchema,
  AiTurnResultSchema,
  isLiveReactionSpoilerFree,
  modelSupportsRole,
  observationPassLimitForRole,
  type AiTurnJob
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
  applyTopicHintSetting,
  aiPlaybackDurationMs,
  applyGameEvent,
  buildAiTheatreTimeline,
  buildBlindTimeline,
  createInitialGameState,
  createPromptMetadata,
  type GameEvent,
  type GameState,
  type Participant,
  type PostGameReview,
  type PromptKind,
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
import { finalizeDrawingDraft, validateDrawingDraft } from "./drawing-draft";
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

interface RoomMeta {
  roomCode: string;
  aiSeats: PublicAiSeat[];
  aiExecutorId: string;
  pendingAiJob?: PendingAiJob;
  replayTokenHash?: string;
  replayExpiresAt?: number;
  turnExpiresAt?: number;
  promptExpiresAt?: number;
  generatedPromptAttempts?: number;
  executorReconnectDeadline?: number;
  lastReactionAt: Record<string, number>;
  reactionCountByTurn?: Record<string, number>;
  authorizedReviewJobIds?: string[];
  serverAiCalls?: Record<string, { count: number; profileId: string }>;
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

function promptKindForEntry(entry: PromptEntry): PromptKind {
  if (entry.category === "idioms") return "idiom";
  if (entry.category === "proverbs") return "proverb";
  if (entry.category === "poem-lines") return "poem-line";
  if (entry.category === "xiehouyu") return "xiehouyu";
  if (entry.category === "objects" || entry.category === "animals") return "word";
  return "phrase";
}

function promptMetadataForEntry(entry: PromptEntry, locale: GameState["config"]["locale"]) {
  return createPromptMetadata(entry.texts[locale], locale, promptKindForEntry(entry), entry.topic);
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

export class RoomObject {
  private readonly idleRoomMs: number;
  private readonly turnConfigured: boolean;
  private readonly transientRateWindows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly objectState: DurableObjectState,
    env: Env
  ) {
    const configuredIdleSeconds = Number(env.ROOM_IDLE_SECONDS);
    const idleSeconds =
      Number.isFinite(configuredIdleSeconds) && configuredIdleSeconds >= 300
        ? Math.min(configuredIdleSeconds, 86_400)
        : 7_200;
    this.idleRoomMs = idleSeconds * 1_000;
    this.turnConfigured = env.TURN_KEY_ID !== undefined && env.TURN_KEY_API_TOKEN !== undefined;
    this.objectState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_events (
        seq INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
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
    await this.objectState.storage.setAlarm(idleExpiresAt);
    return jsonResponse({
      roomId: payload.roomCode,
      roomCode: payload.roomCode,
      participantId,
      reconnectToken,
      hostToken
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
    if (state.phase !== "lobby") return jsonResponse({ error: "game-started" }, 409);
    if (request.joinAs === "spectator" && !state.config.allowSpectators) {
      return jsonResponse({ error: "spectators-disabled" }, 403);
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
    const meta = await this.loadMeta();
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
    await this.objectState.storage.setAlarm(meta.idleExpiresAt);
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
      reviewSlot === undefined
        ? undefined
        : `review_${state.roomId}_${reviewSlot.actorId}`.slice(0, 100);
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
    if (
      !connected &&
      connectionMeta.aiExecutorId === participantId &&
      connectionMeta.pendingAiJob !== undefined
    ) {
      connectionMeta.executorReconnectDeadline = Date.now() + 60_000;
      await this.objectState.storage.put(META_KEY, connectionMeta);
      await this.objectState.storage.setAlarm(connectionMeta.executorReconnectDeadline);
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
        if (state.phase !== "lobby") {
          throw new Error("A participant can only leave explicitly from the lobby");
        }
        const meta = await this.loadMeta();
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
        await this.objectState.storage.setAlarm(meta.idleExpiresAt);
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
        await this.objectState.storage.setAlarm(meta.idleExpiresAt);
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
          !validatePlayablePromptText(requestedPrompt.text).ok
        ) {
          throw new Error("Prompt must be a short, all-ages word or phrase");
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
          const prompt = selectPrompt({ seed: `${state.seed}:${state.seq}` });
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
        if (!validatePlayablePromptText(message.text).ok)
          throw new Error("Prompt must be a short, all-ages word or phrase");
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
        await this.clearTurnDeadline();
        await this.objectState.storage.setAlarm(Date.now() + 2_200);
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
        await this.clearTurnDeadline();
        await this.objectState.storage.setAlarm(Date.now() + 2_200);
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
          await this.objectState.storage.put(META_KEY, meta);
          await this.objectState.storage.setAlarm(meta.replayExpiresAt);
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
          const prompt = selectPrompt({ seed: `${state.seed}:prompt-failure:${state.seq}` });
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
          const reactionIsSafe = isLiveReactionSpoilerFree(result, meta.pendingAiJob.job);
          if (
            (generated === undefined ||
              !validatePlayablePromptText(generated).ok ||
              !reactionIsSafe) &&
            (meta.generatedPromptAttempts ?? 1) < 3
          ) {
            delete meta.pendingAiJob;
            delete meta.promptExpiresAt;
            await this.issuePromptJob(state, meta);
            return;
          }
          const generatedIsValid =
            reactionIsSafe && generated !== undefined && validatePlayablePromptText(generated).ok;
          const fallbackPrompt = generatedIsValid
            ? undefined
            : selectPrompt({ seed: `${state.seed}:generated-fallback:${state.seq}` });
          const text = generatedIsValid ? generated! : fallbackPrompt!.texts[state.config.locale];
          const metadata = generatedIsValid
            ? createPromptMetadata(
                text,
                state.config.locale,
                result.promptKind ?? "phrase",
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
        await this.objectState.storage.setAlarm(Date.now() + playbackDelayMs);
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
  ): Promise<void> {
    await this.applyAndBroadcast(
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
    await this.objectState.storage.setAlarm(meta.idleExpiresAt);
    await this.broadcastSnapshots();
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
    await this.objectState.storage.setAlarm(meta.turnExpiresAt);
  }

  private async clearTurnDeadline(): Promise<void> {
    const meta = await this.loadMeta();
    delete meta.turnExpiresAt;
    delete meta.drawingDraft;
    await this.objectState.storage.put(META_KEY, meta);
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
    await this.objectState.storage.setAlarm(meta.promptExpiresAt);
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
    const peers = state.participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName,
      role: participant.roomRole
    }));
    socket.send(
      JSON.stringify({
        type: "room.snapshot",
        state: this.visibleState(state, participantId, meta),
        peers,
        aiSeats: meta.aiSeats
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
    let state = await this.objectState.storage.get<GameState>(STATE_KEY);
    const meta = await this.objectState.storage.get<RoomMeta>(META_KEY);
    const now = Date.now();
    if (
      state !== undefined &&
      meta?.idleExpiresAt !== undefined &&
      (state.phase === "lobby" || state.phase === "failed") &&
      now >= meta.idleExpiresAt
    ) {
      for (const socket of this.objectState.getWebSockets()) socket.close(1001, "Room expired");
      await this.objectState.storage.deleteAll();
      return;
    }
    if (meta?.executorReconnectDeadline !== undefined) {
      if (now < meta.executorReconnectDeadline) {
        await this.objectState.storage.setAlarm(meta.executorReconnectDeadline);
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
      if (nextAlarm !== undefined) await this.objectState.storage.setAlarm(nextAlarm);
      return;
    }
    if (state?.phase === "prompt" && meta?.promptExpiresAt !== undefined) {
      if (now < meta.promptExpiresAt) {
        await this.objectState.storage.setAlarm(meta.promptExpiresAt);
        return;
      }
      const prompt = selectPrompt({ seed: `${state.seed}:prompt-timeout:${state.seq}` });
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
        await this.objectState.storage.setAlarm(meta.turnExpiresAt);
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
      await this.objectState.storage.setAlarm(now + 2_200);
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
        await this.objectState.storage.put(META_KEY, meta);
        await this.objectState.storage.setAlarm(meta.replayExpiresAt);
      } else {
        await this.prepareTurn(state);
      }
      await this.broadcastSnapshots();
      return;
    }
    if (meta?.replayExpiresAt !== undefined && Date.now() >= meta.replayExpiresAt) {
      for (const socket of this.objectState.getWebSockets()) socket.close(1001, "Replay expired");
      await this.objectState.storage.deleteAll();
    }
  }
}
