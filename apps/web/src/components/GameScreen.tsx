import {
  activeStrokeCommands,
  normalizeCanvasCommandOffsets,
  type CanvasCommand,
  type CanvasMarkCommand,
  type Point
} from "@drawguessai/canvas-protocol";
import { getPersona } from "@drawguessai/ai-adapters";
import {
  aiPlaybackDurationMs,
  createPromptMetadata,
  PROMPT_TOPICS,
  type GameArtifact,
  type GameLocale,
  type GameState,
  type PromptKind,
  type PromptTopic
} from "@drawguessai/game-core";
import type { AiActivity, ClientMessage } from "@drawguessai/network-protocol";
import {
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Eye,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  Tags as TagsIcon,
  UserRound
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { RoomSession } from "../lib/session-store";
import { PROMPT_TOPIC_KEYS } from "../lib/prompt-topics";
import { reactionTone } from "../lib/reaction-tone";
import { CanvasBoard } from "./CanvasBoard";
import { PersonaAvatar } from "./PersonaAvatar";
import { PromptTags } from "./PromptTags";
import { ReactionBar, ReactionIcon } from "./ReactionBar";
import { SourceLink } from "./SourceLink";
import { Timeline } from "./Timeline";

interface GameScreenProps {
  state: GameState;
  session: RoomSession;
  connection: "connecting" | "direct" | "fallback" | "offline";
  remoteCursors: Readonly<Record<string, Point | null>>;
  remotePreviewCommands: readonly CanvasCommand[];
  aiActivity: AiActivity | undefined;
  send: (message: ClientMessage) => void;
  sendPreview: (point: Point | null) => void;
  sendPreviewStroke: (command: CanvasMarkCommand) => void;
}

function mergeCommands(...groups: readonly (readonly CanvasCommand[])[]): CanvasCommand[] {
  const seen = new Set<string>();
  return groups.flatMap((group) =>
    group.filter((command) => {
      if (seen.has(command.id)) return false;
      seen.add(command.id);
      return true;
    })
  );
}

function previousArtifact(state: GameState): GameArtifact | undefined {
  return state.artifacts.at(-1);
}

function currentRelayClue(state: GameState): string | undefined {
  return state.artifacts
    .filter(
      (artifact): artifact is Extract<GameArtifact, { kind: "prompt" | "guess" }> =>
        (artifact.kind === "prompt" || artifact.kind === "guess") &&
        artifact.turnIndex < state.turnIndex
    )
    .at(-1)?.text;
}

function drawingForActiveSlot(
  state: GameState
): Extract<GameArtifact, { kind: "drawing" }> | undefined {
  const active = state.timeline[state.turnIndex];
  if (active === undefined) return undefined;
  for (let index = state.artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = state.artifacts[index];
    if (
      artifact?.kind === "drawing" &&
      (active.role === "draw"
        ? artifact.turnIndex === active.index
        : artifact.turnIndex < active.index)
    ) {
      return artifact;
    }
  }
  return undefined;
}

export function GameScreen({
  state,
  session,
  connection,
  remoteCursors,
  remotePreviewCommands,
  aiActivity,
  send,
  sendPreview,
  sendPreviewStroke
}: GameScreenProps) {
  const { t, i18n } = useTranslation();
  const [commands, setCommands] = useState<CanvasCommand[]>([]);
  const [guess, setGuess] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptLanguage, setPromptLanguage] = useState<GameLocale>(state.config.locale);
  const [promptKind, setPromptKind] = useState<PromptKind>("phrase");
  const [promptTopic, setPromptTopic] = useState<PromptTopic>("other");
  const [spoilersUnlocked, setSpoilersUnlocked] = useState(false);
  const [deadline, setDeadline] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [retainedDrawing, setRetainedDrawing] = useState<CanvasCommand[]>([]);
  const active = state.timeline[state.turnIndex];
  const activePersona =
    active?.actorType === "ai" ? getPersona(active.personaId ?? "maestro") : undefined;
  const me = state.participants.find((participant) => participant.id === session.participantId);
  const ownsTurn = active?.actorType === "human" && active.actorId === session.participantId;
  const last = previousArtifact(state);
  const activeArtifact = state.artifacts.find((artifact) => artifact.turnIndex === state.turnIndex);
  const promptArtifact = state.artifacts.find(
    (artifact): artifact is Extract<GameArtifact, { kind: "prompt" }> => artifact.kind === "prompt"
  );
  const isNonPlayingHost =
    me?.roomRole === "host" && !state.timeline.some((slot) => slot.actorId === me.id);

  useEffect(() => {
    setCommands([]);
    setGuess("");
    const seconds =
      active?.role === "draw" ? state.config.rules.drawSeconds : state.config.rules.guessSeconds;
    const startedAt = Date.now();
    setNow(startedAt);
    setDeadline(startedAt + seconds * 1_000);
  }, [
    active?.index,
    active?.role,
    state.config.rules.drawSeconds,
    state.config.rules.guessSeconds
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => setNow(Date.now()), [aiActivity?.deadlineAt, aiActivity?.jobId]);

  const visibleDrawing = useMemo(() => drawingForActiveSlot(state)?.commands ?? [], [state]);
  const activityMatchesTurn =
    active?.actorType === "ai" &&
    aiActivity?.seatId === active.actorId &&
    aiActivity.role === active.role;
  const remaining =
    state.phase === "reaction"
      ? 0
      : Math.max(
          0,
          Math.ceil(
            ((activityMatchesTurn && aiActivity !== undefined ? aiActivity.deadlineAt : deadline) -
              now) /
              1_000
          )
        );
  const livePreviewCommands = useMemo(
    () => mergeCommands(remotePreviewCommands),
    [remotePreviewCommands]
  );
  const drawingAlreadyPreviewed = useMemo(() => {
    const visibleStrokes = activeStrokeCommands(visibleDrawing);
    if (visibleStrokes.length === 0) return false;
    const previewIds = new Set(
      activeStrokeCommands(livePreviewCommands).map((command) => command.id)
    );
    return visibleStrokes.every((command) => previewIds.has(command.id));
  }, [livePreviewCommands, visibleDrawing]);

  useEffect(() => {
    if (visibleDrawing.length > 0) {
      setRetainedDrawing([...visibleDrawing]);
    } else if (active?.role === "draw" && state.phase === "turn") {
      setRetainedDrawing([]);
    }
  }, [active?.index, active?.role, state.phase, visibleDrawing]);

  const guessCanvasCommands = visibleDrawing.length > 0 ? visibleDrawing : retainedDrawing;
  const playbackMs =
    active?.actorType === "ai" &&
    active.role === "draw" &&
    state.phase === "reaction" &&
    !drawingAlreadyPreviewed
      ? aiPlaybackDurationMs(
          visibleDrawing.filter((command) => command.type === "stroke").length,
          state.config.rules.aiPlaybackSeconds
        )
      : undefined;

  if (state.phase === "prompt") {
    const hostCanPrompt = session.hostToken !== undefined && state.config.promptSource === "custom";
    return (
      <main className="game-screen prompt-stage">
        <GameHeader state={state} connection={connection} />
        <section className="prompt-workbench">
          <span className="workbench-icon">
            <LockKeyhole size={28} />
          </span>
          <span className="eyebrow">{t("customPrompt")}</span>
          <h1>{hostCanPrompt ? t("promptNeeded") : t("waitingPrompt")}</h1>
          {hostCanPrompt ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (prompt.trim() !== "" && session.hostToken !== undefined) {
                  send({
                    type: "prompt.select",
                    text: prompt.trim(),
                    metadata: createPromptMetadata(
                      prompt.trim(),
                      promptLanguage,
                      promptKind,
                      promptTopic
                    ),
                    hostToken: session.hostToken
                  });
                }
              }}
            >
              <div className="custom-prompt-fields">
                <input
                  required
                  maxLength={promptLanguage === "en" ? 80 : 16}
                  value={prompt}
                  placeholder={t("promptPlaceholder")}
                  onChange={(event) => setPrompt(event.target.value)}
                />
                <label>
                  <span>{t("promptLanguage")}</span>
                  <select
                    value={promptLanguage}
                    onChange={(event) => setPromptLanguage(event.target.value as GameLocale)}
                  >
                    <option value="zh-CN">{t("promptLanguageChinese")}</option>
                    <option value="en">{t("promptLanguageEnglish")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("promptType")}</span>
                  <select
                    value={promptKind}
                    onChange={(event) => setPromptKind(event.target.value as PromptKind)}
                  >
                    <option value="word">{t("promptKindWord")}</option>
                    <option value="phrase">{t("promptKindPhrase")}</option>
                    <option value="idiom">{t("promptKindIdiom")}</option>
                    <option value="proverb">{t("promptKindProverb")}</option>
                    <option value="poem-line">{t("promptKindPoemLine")}</option>
                    <option value="xiehouyu">{t("promptKindXiehouyu")}</option>
                  </select>
                </label>
                {state.config.showTopicHint !== false && (
                  <label>
                    <span>{t("promptTopic")}</span>
                    <select
                      value={promptTopic}
                      onChange={(event) => setPromptTopic(event.target.value as PromptTopic)}
                    >
                      {PROMPT_TOPICS.map((topic) => (
                        <option key={topic} value={topic}>
                          {t(PROMPT_TOPIC_KEYS[topic])}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {prompt.trim() !== "" && (
                  <PromptTags
                    text={prompt.trim()}
                    metadata={createPromptMetadata(
                      prompt.trim(),
                      promptLanguage,
                      promptKind,
                      promptTopic
                    )}
                    fallbackLanguage={promptLanguage}
                    showTopic={state.config.showTopicHint !== false}
                  />
                )}
              </div>
              <button className="primary-button" type="submit">
                {t("submitPrompt")}
              </button>
            </form>
          ) : state.config.promptSource === "generated" && aiActivity !== undefined ? (
            <AiActivityPanel activity={aiActivity} now={now} />
          ) : (
            <LoaderCircle className="spin" size={30} />
          )}
        </section>
      </main>
    );
  }

  const waitingBlind =
    state.config.mode === "blind-relay" &&
    me?.roomRole !== "spectator" &&
    !isNonPlayingHost &&
    !me?.hasActed &&
    !ownsTurn;
  const canUnlockSpoilers =
    state.config.mode === "ai-theatre" ||
    me?.roomRole === "spectator" ||
    me?.hasActed === true ||
    isNonPlayingHost;

  return (
    <main className="game-screen">
      <GameHeader
        state={state}
        connection={connection}
        {...(canUnlockSpoilers
          ? {
              spoilersUnlocked,
              onToggleSpoilers: () => setSpoilersUnlocked((current) => !current)
            }
          : {})}
      />
      <section className="game-timeline-band">
        <Timeline slots={state.timeline} currentIndex={state.turnIndex} />
      </section>
      {spoilersUnlocked && canUnlockSpoilers && (
        <section className="mobile-spoiler-log">
          <SpoilerLog state={state} promptArtifact={promptArtifact} />
        </section>
      )}

      <div className="game-layout">
        <aside className="turn-panel">
          <div className="turn-kicker">
            {t("turnOf")} {state.turnIndex + 1}/{state.timeline.length}
          </div>
          <span className={`actor-medallion ${active?.actorType === "ai" ? "is-ai" : ""}`}>
            {active?.actorType === "ai" ? (
              <PersonaAvatar
                personaId={active.personaId ?? "maestro"}
                size="large"
                label={active.displayName}
              />
            ) : (
              <UserRound size={24} />
            )}
          </span>
          <h2>{active?.displayName ?? t("waiting")}</h2>
          <div className="actor-status-row">
            {activePersona !== undefined && (
              <span className="active-persona-tag">
                {active?.personaName ??
                  activePersona.names[i18n.language === "en" ? "en" : "zh-CN"]}
              </span>
            )}
            <span className="role-label">
              {active?.role === "draw" ? <Eye size={16} /> : <Search size={16} />}
              {t(active?.role === "draw" ? "drawing" : "guessing")}
            </span>
          </div>
          <div className="timer-readout">
            <Clock3 size={18} />
            <strong>{remaining}</strong>
            <span>s</span>
          </div>
          <div className="turn-progress">
            <span style={{ width: `${((state.turnIndex + 1) / state.timeline.length) * 100}%` }} />
          </div>
          <ReactionBar onReact={(reaction) => send({ type: "reaction.send", reaction })} />
        </aside>

        <section className="play-surface">
          {waitingBlind ? (
            <div className="blind-wait-state">
              <LockKeyhole size={32} />
              <h2>{t("blindWaiting")}</h2>
              <p>{t("blindWaitingDetail")}</p>
              <div className="dot-progress" aria-label={t("thinking")}>
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : active?.role === "draw" ? (
            <>
              {ownsTurn &&
                last !== undefined &&
                (last.kind === "prompt" || last.kind === "guess") && (
                  <div className="input-clue">
                    <span>{t("yourClue")}</span>
                    <strong>{last.text}</strong>
                  </div>
                )}
              <div
                className={`draw-workbench${active?.actorType === "ai" ? " has-ai-activity" : ""}`}
              >
                <CanvasBoard
                  commands={
                    ownsTurn
                      ? commands
                      : state.phase === "reaction"
                        ? visibleDrawing
                        : livePreviewCommands
                  }
                  editable={ownsTurn && state.phase === "turn"}
                  colorCount={state.config.rules.colorCount}
                  maxStrokes={state.config.rules.maxStrokes}
                  maxUndos={state.config.rules.maxUndos}
                  remoteCursors={remoteCursors}
                  onChange={(nextCommands) => {
                    setCommands(nextCommands);
                    send({ type: "turn.save-drawing", commands: nextCommands });
                  }}
                  onPreview={sendPreview}
                  onStrokePreview={sendPreviewStroke}
                  playbackKey={`${state.roomId}:${state.turnIndex}`}
                  commandClockKey={`${state.roomId}:${state.turnIndex}`}
                  livePlayback={
                    !ownsTurn &&
                    active?.actorType === "ai" &&
                    state.phase !== "reaction" &&
                    livePreviewCommands.length > 0
                  }
                  {...(playbackMs === undefined ? {} : { playbackMs })}
                  {...(ownsTurn
                    ? {
                        onFinish: (offsetMs: number) => {
                          const finish: CanvasCommand = {
                            type: "finish",
                            id: crypto.randomUUID(),
                            offsetMs
                          };
                          send({
                            type: "turn.submit-drawing",
                            commands: normalizeCanvasCommandOffsets([...commands, finish])
                          });
                        }
                      }
                    : {})}
                />
                {!ownsTurn && active?.actorType === "ai" && (
                  <aside className="ai-observation-drawer">
                    {state.phase === "inspect" && (
                      <div className="inspect-banner" role="status">
                        <Eye size={18} />
                        <span>
                          <strong>{t("inspectMode")}</strong>
                          <small>{t("inspectDetail")}</small>
                        </span>
                      </div>
                    )}
                    {aiActivity === undefined ? (
                      <div className="ai-status-line">
                        <LoaderCircle className="spin" size={18} />
                        {t("thinking")}
                      </div>
                    ) : (
                      <AiActivityPanel activity={aiActivity} now={now} />
                    )}
                  </aside>
                )}
              </div>
            </>
          ) : (
            <div
              className={`guess-workbench${active?.actorType === "ai" ? " has-ai-activity" : ""}`}
            >
              <div className="guess-canvas-column">
                <CanvasBoard commands={guessCanvasCommands} compact />
              </div>
              {ownsTurn && state.phase === "turn" ? (
                <form
                  className="guess-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (guess.trim() !== "")
                      send({ type: "turn.submit-guess", text: guess.trim() });
                  }}
                >
                  <Search size={19} />
                  <input
                    autoFocus
                    required
                    maxLength={80}
                    value={guess}
                    placeholder={t("guessPlaceholder")}
                    onChange={(event) => setGuess(event.target.value)}
                  />
                  <button className="primary-button" type="submit">
                    {t("submitGuess")}
                  </button>
                </form>
              ) : (
                <aside className="ai-observation-drawer">
                  <div className="ai-status-line">
                    {state.phase === "reaction" || activeArtifact !== undefined ? (
                      <span>{t("turnComplete")}</span>
                    ) : (
                      <>
                        <LoaderCircle className="spin" size={18} />
                        {t("thinking")}
                      </>
                    )}
                  </div>
                  {active?.actorType === "ai" && aiActivity !== undefined && (
                    <AiActivityPanel activity={aiActivity} now={now} />
                  )}
                </aside>
              )}
            </div>
          )}
        </section>

        <aside className="reaction-feed">
          {spoilersUnlocked && canUnlockSpoilers && (
            <SpoilerLog state={state} promptArtifact={promptArtifact} />
          )}
          <h2>{t("reactions")}</h2>
          {state.reactions.slice(-6).map((reaction) => {
            const actor =
              state.participants.find((participant) => participant.id === reaction.actorId)
                ?.displayName ??
              state.timeline.find((slot) => slot.actorId === reaction.actorId)?.displayName ??
              reaction.actorId;
            return (
              <div
                className={`reaction-note reaction-tone-${reactionTone(reaction.reaction)}`}
                key={reaction.id}
              >
                <span className="reaction-note-icon" aria-hidden="true">
                  <ReactionIcon reaction={reaction.reaction} size={16} />
                </span>
                <strong>{actor}</strong>
                <span>
                  {reaction.text ??
                    t(
                      `reaction${reaction.reaction[0]!.toUpperCase()}${reaction.reaction.slice(1)}`
                    )}
                </span>
              </div>
            );
          })}
          {state.reactions.length === 0 && <p className="muted-copy">{t("noReactions")}</p>}
        </aside>
      </div>
    </main>
  );
}

const activityStages: readonly AiActivity["stage"][] = [
  "queued",
  "planning",
  "requesting",
  "inspecting",
  "refining",
  "validating",
  "complete"
];

function AiActivityPanel({ activity, now }: { activity: AiActivity; now: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const visibleStages =
    activity.role === "draw" && activity.observationLimit > 0
      ? activityStages
      : activityStages.filter(
          (stage) =>
            stage !== "inspecting" &&
            stage !== "refining" &&
            (activity.role === "draw" || stage !== "planning")
        );
  const trackedStage =
    activity.stage === "retrying"
      ? activity.observationIndex > 0
        ? "refining"
        : "requesting"
      : activity.stage;
  const stageIndex = visibleStages.indexOf(trackedStage);
  const secondsLeft = Math.max(0, Math.ceil((activity.deadlineAt - now) / 1_000));
  const timeLabel = activity.stage === "complete" ? t("aiActivityDone") : `${secondsLeft}s`;
  const observationLabel =
    activity.observationLimit === 0
      ? t("aiActivityPassNone")
      : activity.observationIndex === 0
        ? t("aiActivityPassPlanned", { count: activity.observationLimit })
        : `${activity.observationIndex}/${activity.observationLimit}`;

  useEffect(() => setOpen(false), [activity.jobId]);
  useEffect(() => {
    if (
      activity.stage === "retrying" ||
      activity.stage === "inspecting" ||
      activity.stage === "refining"
    ) {
      setOpen(true);
    }
  }, [activity.stage]);

  const StageIcon =
    activity.stage === "complete"
      ? CheckCircle2
      : activity.stage === "retrying"
        ? RefreshCw
        : activity.stage === "inspecting" || activity.stage === "refining"
          ? Eye
          : BrainCircuit;

  return (
    <details
      className={`ai-activity-panel ai-activity-${activity.stage}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="ai-activity-icon">
          <StageIcon size={18} />
        </span>
        <span className="ai-activity-title">
          <strong>
            {t(`aiStage${activity.stage[0]!.toUpperCase()}${activity.stage.slice(1)}`)}
          </strong>
          <small>{activity.modelLabel}</small>
        </span>
        <span className="ai-activity-countdown">{timeLabel}</span>
        <ChevronDown className="ai-activity-chevron" size={17} />
      </summary>
      <div className="ai-activity-body">
        <dl className="ai-activity-metrics">
          <div>
            <dt>{t("aiActivityPass")}</dt>
            <dd>{observationLabel}</dd>
          </div>
          <div>
            <dt>{t("aiActivityStrokes")}</dt>
            <dd>{activity.strokeCount}</dd>
          </div>
          <div>
            <dt>{t("aiActivityTime")}</dt>
            <dd>{timeLabel}</dd>
          </div>
        </dl>
        <ol className={`ai-activity-steps${visibleStages.length === 4 ? " is-compact" : ""}`}>
          {visibleStages.map((stage, index) => (
            <li
              key={stage}
              className={index < stageIndex ? "is-done" : index === stageIndex ? "is-current" : ""}
            >
              {index < stageIndex ? <CheckCircle2 size={14} /> : <span />}
              {t(`aiStage${stage[0]!.toUpperCase()}${stage.slice(1)}`)}
            </li>
          ))}
        </ol>
        <p className="ai-activity-disclosure">
          <ShieldCheck size={15} />
          {t("aiActivityDisclosure")}
        </p>
      </div>
    </details>
  );
}

function GameHeader({
  state,
  connection,
  spoilersUnlocked,
  onToggleSpoilers
}: {
  state: GameState;
  connection: GameScreenProps["connection"];
  spoilersUnlocked?: boolean;
  onToggleSpoilers?: () => void;
}) {
  const { t } = useTranslation();
  const revealedClue = spoilersUnlocked === true ? currentRelayClue(state) : undefined;
  return (
    <header className="game-header">
      <a className="brand-lockup" href="/">
        <span className="brand-dot" />
        DrawGuessAI
      </a>
      <section className="game-prompt-spec" aria-label={t("promptFormatHint")}>
        <span className="game-prompt-spec-title">
          <TagsIcon size={17} />
          <strong>{t("promptFormatHint")}</strong>
        </span>
        {state.promptMetadata === undefined ? (
          <span className="game-prompt-spec-pending">{t("mysteryPrompt")}</span>
        ) : (
          <PromptTags
            text="prompt"
            metadata={state.promptMetadata}
            fallbackLanguage={state.config.locale}
            showTopic={state.config.showTopicHint !== false}
          />
        )}
        {revealedClue !== undefined && (
          <span className="game-prompt-current">
            <small>{t("currentRelayClue")}</small>
            <strong title={revealedClue}>{revealedClue}</strong>
          </span>
        )}
        {onToggleSpoilers !== undefined && (
          <button
            className={`secondary-button spoiler-toggle${spoilersUnlocked === true ? " is-unlocked" : ""}`}
            type="button"
            title={t(spoilersUnlocked === true ? "lockSpoilers" : "unlockSpoilers")}
            aria-pressed={spoilersUnlocked === true}
            onClick={onToggleSpoilers}
          >
            {spoilersUnlocked === true ? <Eye size={16} /> : <LockKeyhole size={16} />}
            <span>{t(spoilersUnlocked === true ? "lockSpoilers" : "unlockSpoilers")}</span>
          </button>
        )}
      </section>
      <div className="game-header-status">
        <SourceLink compact />
        <span className="room-tag">{state.roomId}</span>
        <span className={`connection-dot is-${connection}`}>
          <span />
          {connection === "direct" ? t("connectionDirect") : t("connectionFallback")}
        </span>
      </div>
    </header>
  );
}

function SpoilerLog({
  state,
  promptArtifact
}: {
  state: GameState;
  promptArtifact: Extract<GameArtifact, { kind: "prompt" }> | undefined;
}) {
  const { t } = useTranslation();
  const guesses = state.artifacts.filter(
    (artifact): artifact is Extract<GameArtifact, { kind: "guess" }> => artifact.kind === "guess"
  );

  return (
    <div className="spoiler-log" role="region" aria-label={t("spoilerLog")}>
      <header>
        <Eye size={17} />
        <h2>{t("spoilerLog")}</h2>
      </header>
      {promptArtifact === undefined ? (
        <p className="muted-copy">{t("mysteryPrompt")}</p>
      ) : (
        <article className="spoiler-prompt">
          <small>{t("originalPrompt")}</small>
          <strong>{promptArtifact.text}</strong>
          <PromptTags
            text={promptArtifact.text}
            metadata={promptArtifact.metadata ?? state.promptMetadata}
            fallbackLanguage={state.config.locale}
            showTopic={state.config.showTopicHint !== false}
          />
        </article>
      )}
      <ol>
        {guesses.map((artifact) => {
          const slot = state.timeline[artifact.turnIndex];
          return (
            <li key={`${artifact.turnIndex}:${artifact.actorId}`}>
              <span>{artifact.turnIndex + 1}</span>
              <div>
                <small>{slot?.displayName ?? artifact.actorId}</small>
                <strong>{artifact.text}</strong>
              </div>
            </li>
          );
        })}
      </ol>
      {guesses.length === 0 && <p className="muted-copy">{t("noGuessesYet")}</p>}
    </div>
  );
}
