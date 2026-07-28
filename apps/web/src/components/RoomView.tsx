import {
  AiTurnResultSchema,
  modelSupportsRole,
  type AiTurnJob,
  type AiTurnResult
} from "@drawguessai/ai-adapters";
import {
  activeStrokeCommands,
  hasVisibleCanvasContent,
  type CanvasCommand,
  type CanvasMarkCommand,
  type StrokeCommand
} from "@drawguessai/canvas-protocol";
import {
  GameEventSchema,
  applyGameEvent,
  postGameReviewId,
  type GameState,
  type PostGameReview,
  type TimelineSlot
} from "@drawguessai/game-core";
import type { AiActivity, ClientMessage, ServerMessage } from "@drawguessai/network-protocol";
import { AlertTriangle, ArrowLeft, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { aiExecutionErrorCode, executeAiPipeline } from "../lib/ai-executor";
import { fetchAutomatedRoom } from "../lib/api";
import { commandPlaybackWeight, strokeAtPlaybackProgress } from "../lib/canvas-playback";
import { commandsToAiImageDataUrl } from "../lib/canvas-renderer";
import type { StoredModelProfile } from "../lib/model-store";
import {
  buildPostGameReviewContext,
  departedReviewText,
  humanDrawingForReviewer,
  isUsablePostGameReviewResult,
  normalizeReviewText,
  reviewActorsForState,
  reviewRoleForActor,
  resolvePostGameActions
} from "../lib/postgame-review";
import { RoomClient } from "../lib/room-client";
import { saveRoomSession, type RoomSession } from "../lib/session-store";
import { GameScreen } from "./GameScreen";
import { LobbyScreen } from "./LobbyScreen";
import { RevealScreen } from "./RevealScreen";

interface RoomViewProps {
  initialSession: RoomSession;
  profiles: readonly StoredModelProfile[];
  turnConfigured: boolean;
  onLeave: () => void;
}

const MAX_PREVIEW_STROKES = 120;
const POST_GAME_REVIEW_TIMEOUT_SECONDS = 15;
const POST_GAME_REVIEW_ACK_TIMEOUT_MS = 1_500;
const POST_GAME_REVIEW_RETRY_DELAY_MS = 400;

type AiCompletionMessage =
  Extract<ClientMessage, { type: "ai.result" }> | Extract<ClientMessage, { type: "ai.failure" }>;

function rememberAiCompletion(
  completions: Map<string, AiCompletionMessage>,
  jobId: string,
  message: AiCompletionMessage
): void {
  completions.set(jobId, message);
  while (completions.size > 32) {
    const oldest = completions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    completions.delete(oldest);
  }
}

function upsertPreviewMark(
  commands: readonly CanvasCommand[],
  command: CanvasMarkCommand
): CanvasCommand[] {
  const index = commands.findIndex((candidate) => candidate.id === command.id);
  if (index >= 0) {
    const next = [...commands];
    next[index] = command;
    return next;
  }
  return [...commands.slice(-(MAX_PREVIEW_STROKES - 1)), command];
}

function previewFramesPerStroke(strokeCount: number): number {
  if (strokeCount > 40) return 1;
  if (strokeCount > 20) return 2;
  if (strokeCount > 8) return 3;
  return 5;
}

function waitForPreviewFrame(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function uniqueAiReviewSlots(state: Pick<GameState, "timeline">): TimelineSlot[] {
  return [
    ...new Map(
      state.timeline
        .filter((slot) => slot.actorType === "ai")
        .map((slot) => [slot.actorId, slot] as const)
    ).values()
  ];
}

function reviewDraftKey(roomId: string, seed: string, seatId: string): string {
  return `${roomId}:${seed}:${seatId}`;
}

function departedPostGameReview(
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
    text: departedReviewText(state.config.locale),
    score: 1,
    reaction: "confused",
    status: "departed",
    errorCode,
    at: Date.now()
  };
}

async function createPostGameReviewDraft(
  state: GameState,
  slot: TimelineSlot,
  profiles: readonly StoredModelProfile[],
  session: RoomSession,
  published: readonly PostGameReview[]
): Promise<PostGameReview> {
  const profileId = session.seatProfiles[slot.actorId] ?? session.seatProfiles["ai-1"];
  const record =
    profileId === undefined
      ? undefined
      : profiles.find((candidate) => candidate.profile.id === profileId);
  const modelLabel = record?.profile.label ?? slot.displayName;
  try {
    const humanDrawing = humanDrawingForReviewer(state, slot.actorId);
    const canInspectHumanDrawing =
      humanDrawing !== undefined && record?.profile.capabilities.vision === true;
    const reviewContextLines = [
      ...(canInspectHumanDrawing
        ? [
            `ATTACHED REVIEW IMAGE: T${humanDrawing.slot.index + 1} by actorId=${humanDrawing.slot.actorId}, name=${JSON.stringify(humanDrawing.slot.displayName)}`
          ]
        : []),
      buildPostGameReviewContext(state, slot.actorId, published)
    ].flatMap((line) => line.split("\n"));
    while (reviewContextLines.join("\n").length > 6_000) reviewContextLines.pop();
    const reviewContext = reviewContextLines.join("\n");
    const job: AiTurnJob = {
      jobId: postGameReviewId(state, slot.actorId),
      roomId: state.roomId,
      turnIndex: -1,
      role: "review",
      locale: state.config.locale,
      personaId: slot.personaId ?? "maestro",
      ...(session.seatPersonaCustomizations[slot.actorId] === undefined
        ? {}
        : { personaCustomization: session.seatPersonaCustomizations[slot.actorId] }),
      actorId: slot.actorId,
      reviewRole: reviewRoleForActor(state, slot.actorId),
      reviewActors: reviewActorsForState(state),
      inputText: reviewContext,
      ...(canInspectHumanDrawing
        ? { imageDataUrl: commandsToAiImageDataUrl(humanDrawing.artifact.commands) }
        : {}),
      observationIndex: 0,
      observationLimit: 0,
      timeLimitSeconds: Math.min(
        POST_GAME_REVIEW_TIMEOUT_SECONDS,
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
    let result: AiTurnResult | undefined;
    let failureCode = "missing-profile";
    if (record?.profile.protocol === "demo") {
      failureCode = "programmatic-profile";
    } else if (record !== undefined && modelSupportsRole(record.profile.capabilities, "review")) {
      try {
        result = await executeAiPipeline(record, session, job, {
          timeoutMs: job.timeLimitSeconds * 1_000
        });
        failureCode = result.errorCode ?? "invalid-review";
      } catch {
        failureCode = "review-execution-error";
      }
    } else if (record !== undefined) {
      failureCode = "unsupported-review";
    }
    const usableResult = isUsablePostGameReviewResult(result) ? result : undefined;
    const resolvedActions = resolvePostGameActions(
      state,
      slot.actorId,
      usableResult?.review.actions
    );
    const generatedResult =
      usableResult !== undefined && resolvedActions.length > 0 ? usableResult : undefined;
    if (usableResult !== undefined && resolvedActions.length === 0) {
      failureCode = "invalid-review-actions";
    }
    if (generatedResult === undefined) {
      return departedPostGameReview(state, slot, modelLabel, failureCode);
    }

    const reviewed = generatedResult.review;
    const replyActorId = reviewed.replyToActorId;
    const requestedReply = published.find(
      (review) => review.status !== "departed" && review.seatId === replyActorId
    );
    return {
      id: job.jobId,
      seatId: slot.actorId,
      personaId: job.personaId,
      displayName: slot.displayName,
      modelLabel,
      text: normalizeReviewText(reviewed.text),
      score: reviewed.score,
      reaction: generatedResult.reaction.kind,
      status: "generated",
      ...(requestedReply === undefined ? {} : { replyToSeatId: requestedReply.seatId }),
      actions: resolvedActions,
      at: Date.now()
    };
  } catch {
    return departedPostGameReview(state, slot, modelLabel, "review-preparation-error");
  }
}

function postGameReviewMessage(
  review: PostGameReview,
  hostToken: string
): Extract<ClientMessage, { type: "postgame.review" }> {
  return {
    type: "postgame.review",
    review: {
      id: review.id,
      seatId: review.seatId,
      personaId: review.personaId,
      displayName: review.displayName,
      modelLabel: review.modelLabel,
      text: review.text,
      score: review.score,
      reaction: review.reaction,
      ...(review.status === undefined ? {} : { status: review.status }),
      ...(review.errorCode === undefined ? {} : { errorCode: review.errorCode }),
      ...(review.replyToSeatId === undefined ? {} : { replyToSeatId: review.replyToSeatId }),
      ...(review.actions === undefined ? {} : { actions: review.actions })
    },
    hostToken
  };
}

async function waitForPostGameReview(
  stateRef: { readonly current: GameState | undefined },
  roomId: string,
  seatId: string
): Promise<PostGameReview | undefined> {
  const deadline = Date.now() + POST_GAME_REVIEW_ACK_TIMEOUT_MS;
  do {
    const current = stateRef.current;
    const review =
      current?.roomId === roomId
        ? current.postGameReviews?.find((candidate) => candidate.seatId === seatId)
        : undefined;
    if (review !== undefined) return review;
    await waitForPreviewFrame(50);
  } while (Date.now() < deadline);
  return undefined;
}

export function RoomView({ initialSession, profiles, turnConfigured, onLeave }: RoomViewProps) {
  const { t } = useTranslation();
  const [session, setSession] = useState(initialSession);
  const sessionRef = useRef(initialSession);
  const [state, setState] = useState<GameState>();
  const [connection, setConnection] = useState<"connecting" | "direct" | "fallback" | "offline">(
    "connecting"
  );
  const [automatedRoom, setAutomatedRoom] = useState(false);
  const [automatedNextRunAt, setAutomatedNextRunAt] = useState<number>();
  const [remoteCursors, setRemoteCursors] = useState<
    Record<string, { x: number; y: number } | null>
  >({});
  const [remotePreviewCommands, setRemotePreviewCommands] = useState<CanvasCommand[]>([]);
  const [aiActivity, setAiActivity] = useState<AiActivity>();
  const [error, setError] = useState("");
  const [reviewRetryNonce, setReviewRetryNonce] = useState(0);
  const clientRef = useRef<RoomClient | undefined>(undefined);
  const processedJobs = useRef(new Set<string>());
  const completedJobs = useRef(new Map<string, AiCompletionMessage>());
  const reviewRunRoom = useRef<string | undefined>(undefined);
  const reviewDrafts = useRef(new Map<string, PostGameReview>());
  const reviewPublishAttempts = useRef(new Map<string, number>());
  const reviewRetryTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const stateRef = useRef<GameState | undefined>(undefined);
  const previewGenerations = useRef(new Map<string, number>());
  const aiPreviewRun = useRef(0);
  const previewTurnIndex = useRef<number | undefined>(undefined);

  const commitSession = useCallback((next: RoomSession) => {
    sessionRef.current = next;
    setSession(next);
    saveRoomSession(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (reviewRetryTimer.current !== undefined) {
        window.clearTimeout(reviewRetryTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!automatedRoom) {
      setAutomatedNextRunAt(undefined);
      return;
    }
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const status = await fetchAutomatedRoom();
        if (active) setAutomatedNextRunAt(status.nextRunAt);
      } catch {
        // The room socket remains authoritative while status polling is unavailable.
      }
      if (active) timer = window.setTimeout(() => void poll(), 15_000);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [automatedRoom]);

  const handleAiJob = useCallback(
    async (message: Extract<ServerMessage, { type: "ai.job" }>) => {
      const role = message.job.role;
      if (role === "review") return;
      const completed = completedJobs.current.get(message.job.jobId);
      if (completed !== undefined) {
        clientRef.current?.send(completed);
        return;
      }
      if (processedJobs.current.has(message.job.jobId)) return;
      processedJobs.current.add(message.job.jobId);
      setError("");
      const activeSession = sessionRef.current;
      const profileId =
        activeSession.seatProfiles[message.seatId] ?? activeSession.seatProfiles["ai-1"];
      const record =
        profileId === undefined
          ? undefined
          : profiles.find((candidate) => candidate.profile.id === profileId);
      if (record === undefined) {
        const failure: AiCompletionMessage = {
          type: "ai.failure",
          jobId: message.job.jobId,
          errorCode: "missing-executor-profile"
        };
        rememberAiCompletion(completedJobs.current, message.job.jobId, failure);
        clientRef.current?.send(failure);
        setError(t("missingExecutorProfile"));
        return;
      }
      const previewRun = ++aiPreviewRun.current;
      const clearAiPreview = () => {
        if (aiPreviewRun.current !== previewRun) return;
        setRemotePreviewCommands([]);
        clientRef.current?.sendPreviewClear();
      };
      if (role === "draw") clearAiPreview();
      try {
        const deadlineAt = Date.now() + message.job.timeLimitSeconds * 1_000;
        const publishActivity = (
          activity: Omit<AiActivity, "jobId" | "seatId" | "modelLabel" | "role" | "deadlineAt">
        ) => {
          const next: AiActivity = {
            ...activity,
            jobId: message.job.jobId,
            seatId: message.seatId,
            modelLabel: record.profile.label,
            role,
            deadlineAt
          };
          setAiActivity(next);
          clientRef.current?.send({ type: "ai.activity", activity: next });
        };
        const result = await executeAiPipeline(record, activeSession, message.job, {
          timeoutMs: message.job.timeLimitSeconds * 1_000,
          onActivity: publishActivity,
          onInspect: () => clientRef.current?.send({ type: "turn.inspect" }),
          onResume: () => clientRef.current?.send({ type: "turn.resume" }),
          onClearCanvas: clearAiPreview,
          onPreviewCommands: async (batch, accumulated) => {
            clientRef.current?.send({ type: "turn.save-drawing", commands: [...accumulated] });
            const replaysActiveCanvas = batch.some((command) => command.type === "undo");
            if (replaysActiveCanvas) clearAiPreview();
            const strokes = replaysActiveCanvas
              ? activeStrokeCommands(accumulated)
              : batch.filter((command): command is StrokeCommand => command.type === "stroke");
            if (strokes.length === 0) return;

            const frameCount = previewFramesPerStroke(strokes.length);
            const frames = strokes.flatMap((stroke, index) => {
              const actionWeight = commandPlaybackWeight(stroke, strokes.length - index);
              return Array.from({ length: frameCount }, (_, frameIndex) => ({
                command: strokeAtPlaybackProgress(stroke, (frameIndex + 1) / frameCount)!,
                weight: actionWeight / frameCount
              }));
            });
            const totalWeight = frames.reduce((sum, frame) => sum + frame.weight, 0);
            const totalDurationMs = Math.min(3_200, Math.max(1_200, strokes.length * 70));
            for (const frame of frames) {
              if (aiPreviewRun.current !== previewRun) return;
              setRemotePreviewCommands((current) => upsertPreviewMark(current, frame.command));
              clientRef.current?.sendPreviewStroke(frame.command);
              const delayMs = Math.max(
                20,
                Math.min(320, (totalDurationMs * frame.weight) / totalWeight)
              );
              await waitForPreviewFrame(delayMs);
            }
          }
        });
        if (
          role === "draw" &&
          (result.commands === undefined || !hasVisibleCanvasContent(result.commands))
        ) {
          const errorCode = (result.errorCode ?? "empty-drawing")
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 80);
          const failure: AiCompletionMessage = {
            type: "ai.failure",
            jobId: message.job.jobId,
            errorCode: errorCode === "" ? "model-error" : errorCode
          };
          rememberAiCompletion(completedJobs.current, message.job.jobId, failure);
          clientRef.current?.send(failure);
          return;
        }
        if (result.status === "fallback") {
          setError(t("aiTurnFallback", { code: result.errorCode ?? "unknown" }));
        }
        const completion: AiCompletionMessage = {
          type: "ai.result",
          result: AiTurnResultSchema.parse(result)
        };
        rememberAiCompletion(completedJobs.current, message.job.jobId, completion);
        clientRef.current?.send(completion);
      } catch (cause) {
        const rawErrorCode = aiExecutionErrorCode(cause)
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 80);
        const failure: AiCompletionMessage = {
          type: "ai.failure",
          jobId: message.job.jobId,
          errorCode: rawErrorCode === "" ? "execution-error" : rawErrorCode
        };
        rememberAiCompletion(completedJobs.current, message.job.jobId, failure);
        clientRef.current?.send(failure);
        setError(cause instanceof Error ? cause.message : t("roomError"));
      }
    },
    [profiles, t]
  );

  useEffect(() => {
    const syncPreviewTurn = (turnIndex: number) => {
      if (previewTurnIndex.current === turnIndex) return;
      previewTurnIndex.current = turnIndex;
      aiPreviewRun.current += 1;
      setRemotePreviewCommands([]);
      setRemoteCursors({});
      previewGenerations.current.clear();
      setAiActivity(undefined);
    };
    const client = new RoomClient(sessionRef.current, "all", {
      onConnection: setConnection,
      onPreview: (peerId, packet) => {
        const currentState = stateRef.current;
        const me = currentState?.participants.find(
          (participant) => participant.id === sessionRef.current.participantId
        );
        const canReceive =
          currentState?.config.mode === "ai-theatre" ||
          me?.roomRole === "spectator" ||
          me?.hasActed === true ||
          (me?.roomRole === "host" &&
            !currentState?.timeline.some((slot) => slot.actorId === me.id)) ||
          currentState?.timeline[currentState.turnIndex]?.actorId ===
            sessionRef.current.participantId;
        if (!canReceive) return;
        if (packet.type === "cursor") {
          setRemoteCursors((current) => ({ ...current, [peerId]: packet.point }));
        } else if (packet.type === "clear") {
          const generation = previewGenerations.current.get(peerId) ?? 0;
          if (packet.generation > generation) {
            previewGenerations.current.set(peerId, packet.generation);
            setRemotePreviewCommands([]);
          }
        } else {
          const generation = previewGenerations.current.get(peerId) ?? 0;
          if (packet.generation < generation) return;
          if (packet.generation > generation) {
            previewGenerations.current.set(peerId, packet.generation);
            setRemotePreviewCommands([packet.command]);
            return;
          }
          setRemotePreviewCommands((current) => upsertPreviewMark(current, packet.command));
        }
      },
      onMessage: (message) => {
        if (message.type === "room.snapshot") {
          const nextState = message.state as GameState;
          let currentSession = sessionRef.current;
          setAutomatedRoom(message.automated === true);
          setAutomatedNextRunAt(message.automatedNextRunAt);
          syncPreviewTurn(nextState.turnIndex);
          stateRef.current = nextState;
          setState(nextState);
          if (message.aiSeats !== undefined) {
            const seatPersonas = Object.fromEntries(
              message.aiSeats.map((seat) => [seat.seatId, seat.personaId])
            );
            const seatProfiles = Object.fromEntries(
              message.aiSeats.flatMap((seat) =>
                profiles.some((record) => record.profile.id === seat.profileId)
                  ? [[seat.seatId, seat.profileId]]
                  : []
              )
            );
            const seatNames = Object.fromEntries(
              message.aiSeats.map((seat) => [seat.seatId, seat.displayName])
            );
            const seatPersonaCustomizations = Object.fromEntries(
              message.aiSeats.flatMap((seat) =>
                seat.personaCustomization === undefined
                  ? []
                  : [[seat.seatId, seat.personaCustomization]]
              )
            );
            const currentAiConfiguration = JSON.stringify({
              seatPersonas: currentSession.seatPersonas,
              seatProfiles: currentSession.seatProfiles,
              seatNames: currentSession.seatNames,
              seatPersonaCustomizations: currentSession.seatPersonaCustomizations
            });
            const nextAiConfiguration = JSON.stringify({
              seatPersonas,
              seatProfiles: { ...currentSession.seatProfiles, ...seatProfiles },
              seatNames,
              seatPersonaCustomizations
            });
            if (currentAiConfiguration !== nextAiConfiguration) {
              const nextSession = {
                ...currentSession,
                seatPersonas,
                seatProfiles: { ...currentSession.seatProfiles, ...seatProfiles },
                seatNames,
                seatPersonaCustomizations
              };
              commitSession(nextSession);
              currentSession = nextSession;
            }
          }
          clientRef.current?.setIcePolicy(nextState.config.icePolicy);
          const previewRecipients =
            nextState.config.mode === "ai-theatre"
              ? nextState.participants.map((participant) => participant.id)
              : nextState.participants
                  .filter(
                    (participant) =>
                      participant.hasActed ||
                      participant.roomRole === "spectator" ||
                      (participant.roomRole === "host" &&
                        !nextState.timeline.some((slot) => slot.actorId === participant.id))
                  )
                  .map((participant) => participant.id);
          clientRef.current?.setPreviewRecipients(previewRecipients);
          const mine = nextState.participants.find(
            (participant) => participant.id === currentSession.participantId
          );
          if (mine?.roomRole !== "host" && currentSession.hostToken !== undefined) {
            const withoutHost = structuredClone(currentSession);
            delete withoutHost.hostToken;
            commitSession(withoutHost);
          }
          return;
        }
        if (message.type === "room.event") {
          const parsed = GameEventSchema.safeParse(message.envelope.payload);
          if (parsed.success) {
            const current = stateRef.current;
            if (current !== undefined) {
              const next = applyGameEvent(current, parsed.data);
              syncPreviewTurn(next.turnIndex);
              stateRef.current = next;
              setState(next);
            }
          }
          return;
        }
        if (message.type === "room.error") {
          setError(message.message);
          return;
        }
        if (message.type === "room.host-token") {
          commitSession({ ...sessionRef.current, hostToken: message.hostToken });
          return;
        }
        if (message.type === "ai.activity") {
          setAiActivity(message.activity);
          return;
        }
        if (message.type === "ai.job") void handleAiJob(message);
      }
    });
    clientRef.current = client;
    void client.connect();
    return () => {
      aiPreviewRun.current += 1;
      client.close();
      if (clientRef.current === client) clientRef.current = undefined;
    };
  }, [
    commitSession,
    handleAiJob,
    initialSession.participantId,
    initialSession.reconnectToken,
    initialSession.roomId,
    profiles
  ]);

  useEffect(() => {
    if (
      state === undefined ||
      (state.phase !== "reveal" && state.phase !== "complete") ||
      session.hostToken === undefined ||
      connection === "connecting" ||
      connection === "offline" ||
      reviewRunRoom.current === `${state.roomId}:${state.seed}`
    ) {
      return;
    }
    const aiSlots = uniqueAiReviewSlots(state);
    if (
      aiSlots.every((slot) =>
        (state.postGameReviews ?? []).some((review) => review.seatId === slot.actorId)
      )
    ) {
      return;
    }

    const roomId = state.roomId;
    const matchKey = `${state.roomId}:${state.seed}`;
    reviewRunRoom.current = matchKey;
    const hostToken = session.hostToken;
    const published = [...(state.postGameReviews ?? [])];
    void (async () => {
      try {
        for (const slot of aiSlots) {
          const existing = stateRef.current?.postGameReviews?.find(
            (review) => review.seatId === slot.actorId
          );
          if (existing !== undefined) {
            if (!published.some((review) => review.seatId === slot.actorId)) {
              published.push(existing);
            }
            reviewDrafts.current.delete(reviewDraftKey(roomId, state.seed, slot.actorId));
            reviewPublishAttempts.current.delete(reviewDraftKey(roomId, state.seed, slot.actorId));
            continue;
          }

          const draftKey = reviewDraftKey(roomId, state.seed, slot.actorId);
          let draft = reviewDrafts.current.get(draftKey);
          if (draft === undefined) {
            draft = await createPostGameReviewDraft(state, slot, profiles, session, published);
            reviewDrafts.current.set(draftKey, draft);
          }
          if (clientRef.current?.send(postGameReviewMessage(draft, hostToken)) !== true) break;

          const acknowledged = await waitForPostGameReview(stateRef, roomId, slot.actorId);
          if (acknowledged === undefined) {
            const attempts = (reviewPublishAttempts.current.get(draftKey) ?? 0) + 1;
            reviewPublishAttempts.current.set(draftKey, attempts);
            if (attempts >= 3 && draft.status !== "departed") {
              reviewDrafts.current.set(
                draftKey,
                departedPostGameReview(state, slot, draft.modelLabel, "review-publish-timeout")
              );
            }
            break;
          }
          reviewDrafts.current.delete(draftKey);
          reviewPublishAttempts.current.delete(draftKey);
          if (!published.some((review) => review.seatId === slot.actorId)) {
            published.push(acknowledged);
          }
        }
      } finally {
        if (reviewRunRoom.current === matchKey) reviewRunRoom.current = undefined;
        const latest = stateRef.current;
        const incomplete =
          latest?.roomId === roomId &&
          latest.seed === state.seed &&
          aiSlots.some(
            (slot) =>
              !(latest.postGameReviews ?? []).some((review) => review.seatId === slot.actorId)
          );
        if (incomplete && mounted.current) {
          if (reviewRetryTimer.current !== undefined) {
            window.clearTimeout(reviewRetryTimer.current);
          }
          reviewRetryTimer.current = window.setTimeout(() => {
            reviewRetryTimer.current = undefined;
            if (mounted.current) setReviewRetryNonce((current) => current + 1);
          }, POST_GAME_REVIEW_RETRY_DELAY_MS);
        }
      }
    })();
  }, [connection, profiles, reviewRetryNonce, session, state]);

  const send = (message: ClientMessage) => clientRef.current?.send(message);
  const changeSession = (next: RoomSession) => {
    commitSession(next);
  };
  const leaveLobby = () => {
    const sent = clientRef.current?.send({ type: "room.leave" }) === true;
    if (sent) {
      window.setTimeout(onLeave, 80);
    } else {
      onLeave();
    }
  };
  const restartRelay = () => {
    if (session.hostToken === undefined) return;
    clientRef.current?.send({ type: "game.restart", hostToken: session.hostToken });
  };
  const leaveAutomatedRoom = () => {
    const sent = clientRef.current?.send({ type: "room.leave" }) === true;
    if (sent) {
      window.setTimeout(onLeave, 80);
    } else {
      onLeave();
    }
  };

  if (state === undefined) {
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" size={34} />
        <strong>{t("reconnecting")}</strong>
        {error !== "" && <p className="form-error">{error}</p>}
      </main>
    );
  }

  return (
    <>
      {error !== "" && (
        <div
          className={`error-banner${
            state.phase === "lobby" ||
            state.phase === "failed" ||
            state.phase === "reveal" ||
            state.phase === "complete"
              ? ""
              : " is-game"
          }`}
          role="alert"
        >
          <AlertTriangle size={17} />
          <span title={error}>{error}</span>
          <button type="button" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {state.phase === "lobby" ? (
        <LobbyScreen
          state={state}
          session={session}
          profiles={profiles}
          turnConfigured={turnConfigured}
          connection={connection}
          send={send}
          onSessionChange={changeSession}
          onLeave={leaveLobby}
          {...(automatedRoom && automatedNextRunAt !== undefined ? { automatedNextRunAt } : {})}
        />
      ) : state.phase === "failed" ? (
        <ModelFaultScreen
          state={state}
          onBack={automatedRoom ? leaveAutomatedRoom : onLeave}
          onRestart={session.hostToken === undefined ? undefined : restartRelay}
        />
      ) : state.phase === "complete" || state.phase === "reveal" ? (
        <RevealScreen
          state={state}
          automatedRoom={automatedRoom}
          onBack={automatedRoom ? leaveAutomatedRoom : onLeave}
          onRestart={session.hostToken === undefined ? undefined : restartRelay}
        />
      ) : (
        <GameScreen
          state={state}
          session={session}
          connection={connection}
          remoteCursors={remoteCursors}
          remotePreviewCommands={remotePreviewCommands}
          aiActivity={aiActivity}
          send={send}
          sendPreview={(point) => clientRef.current?.sendPreview(point)}
          sendPreviewStroke={(command) => clientRef.current?.sendPreviewStroke(command)}
        />
      )}
    </>
  );
}

function ModelFaultScreen({
  state,
  onBack,
  onRestart
}: {
  state: GameState;
  onBack: () => void;
  onRestart?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const failure = state.failure;
  const errorCode = failure?.errorCode ?? "model-error";
  const tokenPlanWindowExhausted = errorCode === "token-plan-window-exhausted";
  const quotaExhausted = errorCode === "quota-exhausted" || errorCode === "http-402";
  const rateLimited = errorCode === "rate-limited" || errorCode === "http-429";
  const eyebrow =
    tokenPlanWindowExhausted || quotaExhausted || rateLimited
      ? t("modelFaultServiceEyebrow")
      : t("modelFaultEyebrow");
  const title = tokenPlanWindowExhausted
    ? t("modelFaultTokenWindowTitle")
    : quotaExhausted
      ? t("modelFaultQuotaTitle")
      : rateLimited
        ? t("modelFaultRateTitle")
        : t("modelFaultTitle");
  const detail = tokenPlanWindowExhausted
    ? t("modelFaultTokenWindowDetail")
    : quotaExhausted
      ? t("modelFaultQuotaDetail")
      : rateLimited
        ? t("modelFaultRateDetail")
        : t("modelFaultDetail");
  const actor =
    state.timeline.find((slot) => slot.actorId === failure?.actorId)?.displayName ??
    failure?.actorId ??
    t("waiting");
  return (
    <main
      className="model-fault-screen"
      data-fault-kind={
        tokenPlanWindowExhausted
          ? "token-window"
          : quotaExhausted
            ? "quota"
            : rateLimited
              ? "rate-limit"
              : "drawing"
      }
    >
      <section className="model-fault-content" role="alert">
        <span className="model-fault-icon">
          <AlertTriangle size={34} />
        </span>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{detail}</p>
        <dl className="model-fault-facts">
          <div>
            <dt>{t("modelFaultActor")}</dt>
            <dd>{actor}</dd>
          </div>
          <div>
            <dt>{t("modelFaultCode")}</dt>
            <dd>
              <code>{errorCode}</code>
            </dd>
          </div>
        </dl>
        <div className="model-fault-actions">
          {onRestart !== undefined && (
            <button className="secondary-button" type="button" onClick={onRestart}>
              {t("playAgain")}
            </button>
          )}
          <button className="primary-button" type="button" onClick={onBack}>
            <ArrowLeft size={17} />
            {t("backToHome")}
          </button>
        </div>
      </section>
    </main>
  );
}
