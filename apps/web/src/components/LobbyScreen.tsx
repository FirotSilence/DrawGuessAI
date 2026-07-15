import {
  AI_PERSONAS,
  AiPersonaCustomizationSchema,
  getPersona,
  modelObservationPassLimit,
  modelSupportsRole,
  type AiPersona,
  type AiPersonaCustomization,
  type ModelCapabilities
} from "@drawguessai/ai-adapters";
import {
  buildAiTheatreTimeline,
  buildBlindTimeline,
  createPromptMetadata,
  PROMPT_TOPICS,
  type GameConfig,
  type GameLocale,
  type GameState,
  type PromptKind,
  type PromptTopic,
  type TimelineSlot
} from "@drawguessai/game-core";
import type { ClientMessage, GameStartPrompt, PublicAiSeat } from "@drawguessai/network-protocol";
import { validatePlayablePromptText } from "@drawguessai/word-bank";
import {
  ArrowLeft,
  Check,
  Copy,
  Crown,
  Pencil,
  Play,
  ReplaceAll,
  RotateCcw,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { isModelProfileReady, type StoredModelProfile } from "../lib/model-store";
import {
  AI_SEAT_IDS,
  completeAiSeatNames,
  completeAiSeatPersonas,
  createAiSeatNames,
  swapAiSeatPersona
} from "../lib/ai-seats";
import { saveRoomSession, type RoomSession } from "../lib/session-store";
import { PROMPT_TOPIC_KEYS } from "../lib/prompt-topics";
import { PersonaAvatar } from "./PersonaAvatar";
import { SourceLink } from "./SourceLink";
import { PromptTags } from "./PromptTags";
import { RulesEditor } from "./RulesEditor";
import { Timeline } from "./Timeline";

interface LobbyScreenProps {
  state: GameState;
  session: RoomSession;
  profiles: readonly StoredModelProfile[];
  turnConfigured: boolean;
  connection: "connecting" | "direct" | "fallback" | "offline";
  send: (message: ClientMessage) => void;
  onSessionChange: (session: RoomSession) => void;
  onLeave: () => void;
}

function buildConfiguredTimeline(
  config: GameConfig,
  seats: readonly PublicAiSeat[],
  participants: GameState["participants"],
  localParticipantId: string,
  seed: string
): TimelineSlot[] {
  const actors = seats.map((seat) => ({
    id: seat.seatId,
    displayName: seat.displayName,
    personaId: seat.personaId,
    ...(seat.personaCustomization === undefined
      ? {}
      : { personaName: seat.personaCustomization.name })
  }));
  if (config.mode === "ai-theatre") {
    return buildAiTheatreTimeline(actors, config.rules.chainLength);
  }
  const humans = participants
    .filter(
      (participant) =>
        participant.roomRole !== "spectator" &&
        !(config.promptSource === "custom" && participant.id === localParticipantId)
    )
    .map((participant) => ({ id: participant.id, displayName: participant.displayName }));
  return buildBlindTimeline({
    humans,
    aiSeats: actors,
    chainLength: Math.max(config.rules.chainLength, humans.length),
    seed
  });
}

function defaultPersonaCustomization(
  persona: AiPersona,
  locale: GameLocale
): AiPersonaCustomization {
  return {
    name: persona.names[locale],
    description: persona.descriptions[locale],
    turnPrompt: persona.instruction,
    reviewPrompt: persona.reviewInstruction
  };
}

function restoreBasePersonaName(slot: TimelineSlot): TimelineSlot {
  const restored = { ...slot };
  delete restored.personaName;
  return restored;
}

function PersonaEditorDialog({
  persona,
  locale,
  value,
  onSave,
  onReset,
  onClose
}: {
  persona: AiPersona;
  locale: GameLocale;
  value: AiPersonaCustomization | undefined;
  onSave: (value: AiPersonaCustomization) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AiPersonaCustomization>(
    value ?? defaultPersonaCustomization(persona, locale)
  );
  const parsed = AiPersonaCustomizationSchema.safeParse(draft);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal persona-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="persona-editor-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="persona-editor-title">{t("editPersona")}</h2>
          <button className="icon-button" type="button" title={t("close")} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <form
          className="persona-editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed.success) onSave(parsed.data);
          }}
        >
          <div className="persona-editor-base">
            <PersonaAvatar personaId={persona.id} size="medium" />
            <span>
              <small>{t("basePersona")}</small>
              <strong>{persona.names[locale]}</strong>
            </span>
          </div>
          <div className="persona-editor-meta">
            <label>
              <span>{t("personaName")}</span>
              <input
                required
                maxLength={24}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label>
              <span>{t("personaDescription")}</span>
              <input
                maxLength={80}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
          </div>
          <label className="persona-prompt-field">
            <span>
              {t("turnPersonaPrompt")}
              <small>{draft.turnPrompt.trim().length}/1500</small>
            </span>
            <textarea
              required
              maxLength={1500}
              rows={7}
              value={draft.turnPrompt}
              onChange={(event) => setDraft({ ...draft, turnPrompt: event.target.value })}
            />
          </label>
          <label className="persona-prompt-field">
            <span>
              {t("reviewPersonaPrompt")}
              <small>{draft.reviewPrompt.trim().length}/1500</small>
            </span>
            <textarea
              required
              maxLength={1500}
              rows={7}
              value={draft.reviewPrompt}
              onChange={(event) => setDraft({ ...draft, reviewPrompt: event.target.value })}
            />
          </label>
          <p className="persona-editor-notice">{t("personaPromptNotice")}</p>
          <footer className="persona-editor-actions">
            <span>
              {value !== undefined && (
                <button className="text-button" type="button" onClick={onReset}>
                  <RotateCcw size={16} />
                  {t("resetPersona")}
                </button>
              )}
            </span>
            <span>
              <button className="secondary-button" type="button" onClick={onClose}>
                {t("cancel")}
              </button>
              <button className="primary-button" type="submit" disabled={!parsed.success}>
                {t("savePersona")}
              </button>
            </span>
          </footer>
        </form>
      </section>
    </div>
  );
}

function PromptStartDialog({
  locale,
  showTopicHint,
  generatedAvailable,
  customMakesHostSpectator,
  onSelect,
  onClose
}: {
  locale: GameLocale;
  showTopicHint: boolean;
  generatedAvailable: boolean;
  customMakesHostSpectator: boolean;
  onSelect: (prompt: GameStartPrompt) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [promptLanguage, setPromptLanguage] = useState<GameLocale>(locale);
  const [promptKind, setPromptKind] = useState<PromptKind>("phrase");
  const [promptTopic, setPromptTopic] = useState<PromptTopic>("other");
  const normalizedText = text.trim();
  const customIsValid = validatePlayablePromptText(normalizedText).ok;
  const metadata = createPromptMetadata(normalizedText, promptLanguage, promptKind, promptTopic);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal prompt-start-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-start-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{t("promptSourceDialogEyebrow")}</span>
            <h2 id="prompt-start-title">{t("promptSourceDialogTitle")}</h2>
          </div>
          <button className="icon-button" type="button" title={t("close")} onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <div className="prompt-start-body">
          <form
            className="prompt-start-custom"
            onSubmit={(event) => {
              event.preventDefault();
              if (!customIsValid) return;
              onSelect({ source: "custom", text: normalizedText, metadata });
            }}
          >
            <label className="prompt-start-input">
              <span>{t("customPrompt")}</span>
              <input
                required
                autoFocus
                maxLength={promptLanguage === "en" ? 80 : 16}
                value={text}
                placeholder={t("promptPlaceholder")}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
            <div className="prompt-start-meta">
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
              {showTopicHint && (
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
            </div>
            {normalizedText !== "" && (
              <PromptTags
                text={normalizedText}
                metadata={metadata}
                fallbackLanguage={promptLanguage}
                showTopic={showTopicHint}
              />
            )}
            {customMakesHostSpectator && (
              <p className="prompt-start-notice">{t("customPromptObserverNote")}</p>
            )}
            <button className="primary-button" type="submit" disabled={!customIsValid}>
              <Check size={17} />
              {t("submitPrompt")}
            </button>
          </form>

          <div className="prompt-start-alternatives">
            <button
              className="prompt-source-option"
              type="button"
              onClick={() => onSelect({ source: "curated" })}
            >
              <Shuffle size={22} />
              <strong>{t("randomPrompt")}</strong>
            </button>
            <button
              className="prompt-source-option"
              type="button"
              disabled={!generatedAvailable}
              title={generatedAvailable ? undefined : t("generatedPromptUnavailable")}
              onClick={() => onSelect({ source: "generated" })}
            >
              <Sparkles size={22} />
              <strong>{t("generatedPrompt")}</strong>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function LeaveRoomDialog({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal leave-room-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="leave-room-title"
        aria-describedby="leave-room-detail"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="leave-room-title">{t("abandonGameTitle")}</h2>
          <button className="icon-button" type="button" title={t("close")} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="leave-room-body">
          <p id="leave-room-detail">{t("abandonGameDetail")}</p>
          <div className="leave-room-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              {t("cancel")}
            </button>
            <button className="danger-button" type="button" onClick={onConfirm}>
              {t("abandonGameConfirm")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function LobbyScreen({
  state,
  session,
  profiles,
  turnConfigured,
  connection,
  send,
  onSessionChange,
  onLeave
}: LobbyScreenProps) {
  const { t, i18n } = useTranslation();
  const [timeline, setTimeline] = useState<TimelineSlot[]>(state.timeline);
  const [config, setConfig] = useState<GameConfig>(state.config);
  const [copied, setCopied] = useState(false);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [advancedOptionsOpen, setAdvancedOptionsOpen] = useState(false);
  const [editingPersonaSeatId, setEditingPersonaSeatId] = useState<string>();
  const [bulkProfileId, setBulkProfileId] = useState(
    session.seatProfiles[AI_SEAT_IDS[0]!] ?? profiles[0]?.profile.id ?? ""
  );
  const [bulkAssignment, setBulkAssignment] = useState<
    { applied: number; skipped: number; model: string } | undefined
  >();
  const syncedAiSeats = useRef("");
  const isHost = session.hostToken !== undefined;
  const locale = i18n.language === "en" ? "en" : "zh-CN";
  const fallbackSeatNames = useMemo(
    () => createAiSeatNames(state.config.locale),
    [state.config.locale]
  );

  useEffect(() => setTimeline(state.timeline), [state.timeline]);
  useEffect(() => setConfig(state.config), [state.config]);

  const activeAiSeatIds = useMemo(
    () => [
      ...new Set(timeline.filter((slot) => slot.actorType === "ai").map((slot) => slot.actorId))
    ],
    [timeline]
  );

  const profileForSeat = (
    seatId: string,
    seatProfiles = session.seatProfiles
  ): StoredModelProfile => {
    const profileId =
      seatProfiles[seatId] ?? seatProfiles[AI_SEAT_IDS[0]!] ?? profiles[0]?.profile.id;
    return profiles.find((record) => record.profile.id === profileId) ?? profiles[0]!;
  };

  const personaForSeat = (seatId: string, index: number, seatPersonas = session.seatPersonas) => {
    const timelinePersonas = Object.fromEntries(
      timeline.flatMap((slot) =>
        slot.actorType === "ai" && slot.personaId !== undefined
          ? [[slot.actorId, slot.personaId]]
          : []
      )
    );
    const normalizedPersonas = completeAiSeatPersonas({ ...timelinePersonas, ...seatPersonas });
    return getPersona(normalizedPersonas[seatId] ?? AI_PERSONAS[index % AI_PERSONAS.length]!.id);
  };

  const namesForSeats = (
    sourceTimeline = timeline,
    seatNames: Readonly<Record<string, string>> = session.seatNames
  ) => {
    const timelineNames = Object.fromEntries(
      sourceTimeline.flatMap((slot) =>
        slot.actorType === "ai" ? [[slot.actorId, slot.displayName]] : []
      )
    );
    return completeAiSeatNames(
      { ...fallbackSeatNames, ...timelineNames, ...seatNames },
      state.config.locale
    );
  };

  const publicAiSeats = (
    seatProfiles = session.seatProfiles,
    seatPersonas = session.seatPersonas,
    sourceTimeline = timeline,
    seatNames = session.seatNames,
    seatPersonaCustomizations = session.seatPersonaCustomizations
  ): PublicAiSeat[] => {
    const timelinePersonas = Object.fromEntries(
      sourceTimeline.flatMap((slot) =>
        slot.actorType === "ai" && slot.personaId !== undefined
          ? [[slot.actorId, slot.personaId]]
          : []
      )
    );
    const normalizedPersonas = completeAiSeatPersonas({ ...timelinePersonas, ...seatPersonas });
    const normalizedNames = namesForSeats(sourceTimeline, seatNames);
    return AI_SEAT_IDS.map((seatId, index) => {
      const record = profileForSeat(seatId, seatProfiles);
      const personaId =
        normalizedPersonas[seatId] ??
        sourceTimeline.find((slot) => slot.actorId === seatId)?.personaId ??
        AI_PERSONAS[index % AI_PERSONAS.length]!.id;
      const persona = getPersona(personaId);
      const personaCustomization = seatPersonaCustomizations[seatId];
      return {
        seatId,
        profileId: record.profile.id,
        displayName: normalizedNames[seatId] ?? `AI ${index + 1}`,
        personaId: persona.id,
        ...(personaCustomization === undefined ? {} : { personaCustomization }),
        capabilities: record.profile.capabilities,
        execution:
          record.profile.protocol === "demo"
            ? "demo"
            : record.profile.execution === "server"
              ? "server"
              : "local",
        ready: isModelProfileReady(record)
      };
    });
  };

  const sendConfiguration = (
    nextConfig: GameConfig,
    nextTimeline: TimelineSlot[],
    seatProfiles = session.seatProfiles,
    seatPersonas = session.seatPersonas,
    seatNames = session.seatNames,
    seatPersonaCustomizations = session.seatPersonaCustomizations
  ) => {
    if (session.hostToken === undefined) return;
    const seats = publicAiSeats(
      seatProfiles,
      seatPersonas,
      nextTimeline,
      seatNames,
      seatPersonaCustomizations
    );
    send({
      type: "room.configure",
      config: nextConfig,
      timeline: nextTimeline,
      ...(seats.length === 0 ? {} : { aiSeats: seats }),
      hostToken: session.hostToken
    });
  };

  const rebuildTimeline = (nextConfig: GameConfig, randomSeed = crypto.randomUUID()) => {
    return buildConfiguredTimeline(
      nextConfig,
      publicAiSeats(),
      state.participants,
      session.participantId,
      randomSeed
    );
  };

  const aiSeatSignature = JSON.stringify(publicAiSeats());
  const aiActorIds = timeline.filter((slot) => slot.actorType === "ai").map((slot) => slot.actorId);
  const hasDuplicateAiActors = new Set(aiActorIds).size !== aiActorIds.length;

  useEffect(() => {
    if (!isHost || session.hostToken === undefined || !hasDuplicateAiActors) return;
    const seats = JSON.parse(aiSeatSignature) as PublicAiSeat[];
    const nextTimeline = buildConfiguredTimeline(
      config,
      seats,
      state.participants,
      session.participantId,
      `${state.seed}:distinct-ai-actors`
    );
    syncedAiSeats.current = aiSeatSignature;
    setTimeline(nextTimeline);
    send({
      type: "room.configure",
      config,
      timeline: nextTimeline,
      aiSeats: seats,
      hostToken: session.hostToken
    });
  }, [
    aiSeatSignature,
    config,
    hasDuplicateAiActors,
    isHost,
    send,
    session.hostToken,
    session.participantId,
    state.participants,
    state.seed
  ]);

  useEffect(() => {
    if (
      !isHost ||
      hasDuplicateAiActors ||
      session.hostToken === undefined ||
      syncedAiSeats.current === aiSeatSignature
    ) {
      return;
    }
    syncedAiSeats.current = aiSeatSignature;
    send({
      type: "room.configure",
      config,
      timeline,
      aiSeats: JSON.parse(aiSeatSignature) as PublicAiSeat[],
      hostToken: session.hostToken
    });
  }, [aiSeatSignature, config, hasDuplicateAiActors, isHost, send, session.hostToken, timeline]);

  const normalizeRulesConfig = (nextConfig: GameConfig): GameConfig => {
    const humanCount = state.participants.filter(
      (participant) =>
        participant.roomRole !== "spectator" &&
        !(nextConfig.promptSource === "custom" && participant.id === session.participantId)
    ).length;
    return {
      ...nextConfig,
      rules: {
        ...nextConfig.rules,
        chainLength: Math.max(nextConfig.rules.chainLength, humanCount)
      }
    };
  };

  const changeRules = (nextConfig: GameConfig) => {
    const normalized = normalizeRulesConfig(nextConfig);
    if (normalized.rules.chainLength !== config.rules.chainLength) {
      setTimeline(rebuildTimeline(normalized));
    }
    setConfig(normalized);
  };

  const saveRules = (nextConfig: GameConfig) => {
    const normalized = normalizeRulesConfig(nextConfig);
    const nextTimeline =
      normalized.rules.chainLength === config.rules.chainLength
        ? timeline
        : rebuildTimeline(normalized);
    setConfig(normalized);
    setTimeline(nextTimeline);
    sendConfiguration(normalized, nextTimeline);
  };

  const assignProfile = (seatId: string, profileId: string) => {
    const next = {
      ...session,
      seatProfiles: { ...session.seatProfiles, [seatId]: profileId }
    };
    saveRoomSession(next);
    onSessionChange(next);
    sendConfiguration(config, timeline, next.seatProfiles);
  };

  const assignPersona = (seatId: string, personaId: string) => {
    const nextPersonas = swapAiSeatPersona(session.seatPersonas, seatId, personaId);
    const nextPersonaCustomizations = { ...session.seatPersonaCustomizations };
    delete nextPersonaCustomizations[seatId];
    const nextTimeline = timeline.map((slot) => {
      if (slot.actorType !== "ai") return slot;
      const index = Math.max(0, AI_SEAT_IDS.indexOf(slot.actorId));
      return {
        ...restoreBasePersonaName(slot),
        personaId: nextPersonas[slot.actorId] ?? AI_PERSONAS[index % AI_PERSONAS.length]!.id
      };
    });
    const next = {
      ...session,
      seatPersonas: nextPersonas,
      seatPersonaCustomizations: nextPersonaCustomizations
    };
    setTimeline(nextTimeline);
    saveRoomSession(next);
    onSessionChange(next);
    sendConfiguration(
      config,
      nextTimeline,
      next.seatProfiles,
      next.seatPersonas,
      next.seatNames,
      next.seatPersonaCustomizations
    );
  };

  const savePersonaCustomization = (seatId: string, customization: AiPersonaCustomization) => {
    const nextPersonaCustomizations = {
      ...session.seatPersonaCustomizations,
      [seatId]: AiPersonaCustomizationSchema.parse(customization)
    };
    const nextTimeline = timeline.map((slot) =>
      slot.actorType === "ai" && slot.actorId === seatId
        ? { ...slot, personaName: customization.name.trim() }
        : slot
    );
    const next = {
      ...session,
      seatPersonaCustomizations: nextPersonaCustomizations
    };
    setEditingPersonaSeatId(undefined);
    setTimeline(nextTimeline);
    saveRoomSession(next);
    onSessionChange(next);
    sendConfiguration(
      config,
      nextTimeline,
      next.seatProfiles,
      next.seatPersonas,
      next.seatNames,
      next.seatPersonaCustomizations
    );
  };

  const resetPersonaCustomization = (seatId: string) => {
    const nextPersonaCustomizations = { ...session.seatPersonaCustomizations };
    delete nextPersonaCustomizations[seatId];
    const nextTimeline = timeline.map((slot) => {
      if (slot.actorType !== "ai" || slot.actorId !== seatId) return slot;
      return restoreBasePersonaName(slot);
    });
    const next = {
      ...session,
      seatPersonaCustomizations: nextPersonaCustomizations
    };
    setEditingPersonaSeatId(undefined);
    setTimeline(nextTimeline);
    saveRoomSession(next);
    onSessionChange(next);
    sendConfiguration(
      config,
      nextTimeline,
      next.seatProfiles,
      next.seatPersonas,
      next.seatNames,
      next.seatPersonaCustomizations
    );
  };

  const randomizeAiNames = () => {
    const nextNames = createAiSeatNames(state.config.locale);
    const nextTimeline = timeline.map((slot) =>
      slot.actorType === "ai"
        ? { ...slot, displayName: nextNames[slot.actorId] ?? slot.displayName }
        : slot
    );
    const next = { ...session, seatNames: nextNames };
    setTimeline(nextTimeline);
    saveRoomSession(next);
    onSessionChange(next);
    sendConfiguration(config, nextTimeline, next.seatProfiles, next.seatPersonas, next.seatNames);
  };

  const profileSupportsSeat = (seatId: string, capabilities: ModelCapabilities) =>
    timeline
      .filter((slot) => slot.actorType === "ai" && slot.actorId === seatId)
      .every((slot) => modelSupportsRole(capabilities, slot.role));

  const bulkProfile = profiles.find((record) => record.profile.id === bulkProfileId);
  const bulkCompatibleSeatIds =
    bulkProfile === undefined
      ? []
      : activeAiSeatIds.filter((seatId) =>
          profileSupportsSeat(seatId, bulkProfile.profile.capabilities)
        );

  const assignProfileInBulk = () => {
    if (bulkProfile === undefined || bulkCompatibleSeatIds.length === 0) return;
    const nextSeatProfiles = { ...session.seatProfiles };
    for (const seatId of bulkCompatibleSeatIds) nextSeatProfiles[seatId] = bulkProfile.profile.id;
    const next = { ...session, seatProfiles: nextSeatProfiles };
    saveRoomSession(next);
    onSessionChange(next);
    sendConfiguration(config, timeline, next.seatProfiles);
    setBulkAssignment({
      applied: bulkCompatibleSeatIds.length,
      skipped: activeAiSeatIds.length - bulkCompatibleSeatIds.length,
      model: bulkProfile.profile.label
    });
  };

  const invalidSeats = publicAiSeats().filter(
    (seat) =>
      activeAiSeatIds.includes(seat.seatId) &&
      (!seat.ready || !profileSupportsSeat(seat.seatId, seat.capabilities))
  );
  const generatedPromptAvailable = publicAiSeats().some(
    (seat) => seat.ready && modelSupportsRole(seat.capabilities, "prompt")
  );
  const editingPersonaIndex =
    editingPersonaSeatId === undefined ? -1 : AI_SEAT_IDS.indexOf(editingPersonaSeatId);
  const editingPersona =
    editingPersonaSeatId === undefined
      ? undefined
      : personaForSeat(editingPersonaSeatId, Math.max(0, editingPersonaIndex));

  const startWithPrompt = (prompt: GameStartPrompt) => {
    if (session.hostToken === undefined) return;
    const nextConfig = normalizeRulesConfig({ ...config, promptSource: prompt.source });
    const hostIsPlaying = timeline.some((slot) => slot.actorId === session.participantId);
    const hostShouldPlay = prompt.source !== "custom";
    const customParticipationChanged =
      nextConfig.mode === "blind-relay" && hostIsPlaying !== hostShouldPlay;
    const nextTimeline = customParticipationChanged
      ? buildConfiguredTimeline(
          nextConfig,
          publicAiSeats(),
          state.participants,
          session.participantId,
          crypto.randomUUID()
        )
      : timeline;
    setPromptDialogOpen(false);
    setConfig(nextConfig);
    setTimeline(nextTimeline);
    sendConfiguration(nextConfig, nextTimeline);
    send({ type: "game.start", hostToken: session.hostToken, prompt });
  };

  const copyInvite = async () => {
    await navigator.clipboard.writeText(
      session.inviteUrl ?? `${location.origin}/?room=${state.roomId}`
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <main className="lobby-screen">
      <header className="room-header">
        <button
          className="icon-button lobby-back-button"
          type="button"
          title={t("backToHome")}
          onClick={() => setLeaveDialogOpen(true)}
        >
          <ArrowLeft size={19} />
        </button>
        <div>
          <span className="eyebrow">{t("lobby")}</span>
          <h1>{t(state.config.mode === "ai-theatre" ? "aiTheatre" : "blindRelay")}</h1>
        </div>
        <div className="room-header-meta">
          <div className="room-code-block">
            <span>{t("roomCode")}</span>
            <strong>{state.roomId}</strong>
            <button
              className="icon-button"
              type="button"
              title={t("copyInvite")}
              onClick={() => void copyInvite()}
            >
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
          </div>
          <span className={`connection-pill connection-${connection}`}>
            {connection === "direct" ? <Wifi size={15} /> : <WifiOff size={15} />}
            {connection === "direct" ? t("connectionDirect") : t("connectionFallback")}
          </span>
          <SourceLink compact />
        </div>
      </header>

      <section className="lobby-band timeline-band">
        <div className="section-heading">
          <h2>{t("timeline")}</h2>
          {isHost && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                const next = rebuildTimeline(config);
                setTimeline(next);
                sendConfiguration(config, next);
              }}
            >
              <Shuffle size={17} />
              {t("randomize")}
            </button>
          )}
        </div>
        <Timeline
          slots={timeline}
          editable={isHost}
          onChange={(next) => {
            setTimeline(next);
            sendConfiguration(config, next);
          }}
        />
      </section>

      <div className="lobby-columns">
        <section className="participant-panel">
          <div className="section-heading">
            <h2>{t("playerCount")}</h2>
            <span>{state.participants.length}/8</span>
          </div>
          <ul className="participant-list">
            {state.participants.map((participant) => (
              <li key={participant.id}>
                <span className="avatar-chip">
                  <UserRound size={16} />
                </span>
                <strong>{participant.displayName}</strong>
                <small>
                  {participant.roomRole === "host"
                    ? t("host")
                    : t(participant.roomRole === "spectator" ? "spectator" : "participant")}
                </small>
                <span className={participant.connected ? "presence is-online" : "presence"}>
                  {participant.connected ? t("online") : t("disconnected")}
                </span>
                {isHost && participant.id !== session.participantId && participant.connected && (
                  <button
                    className="icon-button transfer-host"
                    type="button"
                    title={t("transferHost")}
                    onClick={() =>
                      send({
                        type: "room.transfer-host",
                        participantId: participant.id,
                        hostToken: session.hostToken!
                      })
                    }
                  >
                    <Crown size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="ai-seat-panel">
          <div className="section-heading">
            <h2>{t("aiSeats")}</h2>
            <span className="section-heading-actions">
              <span>{activeAiSeatIds.length}</span>
              {isHost && (
                <button
                  className="icon-button"
                  type="button"
                  title={t("randomizeAiNames")}
                  onClick={randomizeAiNames}
                >
                  <Shuffle size={16} />
                </button>
              )}
            </span>
          </div>
          {isHost && (
            <>
              <div className="ai-seat-bulk-controls">
                <select
                  aria-label={t("bulkModelProfile")}
                  value={bulkProfileId}
                  onChange={(event) => {
                    setBulkProfileId(event.target.value);
                    setBulkAssignment(undefined);
                  }}
                >
                  {profiles.map((record) => {
                    const compatible = activeAiSeatIds.filter((seatId) =>
                      profileSupportsSeat(seatId, record.profile.capabilities)
                    ).length;
                    return (
                      <option
                        key={record.profile.id}
                        value={record.profile.id}
                        disabled={compatible === 0}
                      >
                        {t("bulkModelOption", {
                          model: record.profile.label,
                          compatible,
                          total: activeAiSeatIds.length
                        })}
                      </option>
                    );
                  })}
                </select>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={bulkCompatibleSeatIds.length === 0}
                  onClick={assignProfileInBulk}
                >
                  <ReplaceAll size={16} />
                  {t("bulkReplaceModels")}
                </button>
              </div>
              {bulkAssignment !== undefined && (
                <p className="ai-seat-bulk-status" role="status">
                  {t("bulkModelResult", bulkAssignment)}
                </p>
              )}
            </>
          )}
          <div className="ai-seat-list">
            {activeAiSeatIds.map((seatId, index) => {
              const record = profileForSeat(seatId);
              const persona = personaForSeat(seatId, index);
              const personaCustomization = session.seatPersonaCustomizations[seatId];
              const personaName = personaCustomization?.name ?? persona.names[locale];
              const personaDescription =
                personaCustomization?.description ?? persona.descriptions[locale];
              const seatName = namesForSeats()[seatId] ?? `AI ${index + 1}`;
              const modelObservationLimit = modelObservationPassLimit(record.profile.capabilities);
              const effectiveObservationLimit = Math.min(
                config.rules.aiObservationPasses,
                modelObservationLimit
              );
              return (
                <div key={seatId} className="ai-seat-control">
                  <PersonaAvatar
                    personaId={persona.id}
                    size="small"
                    label={`${seatName}, ${personaName}`}
                  />
                  <span className="ai-seat-identity">
                    <strong>{seatName}</strong>
                    <small
                      className={`persona-tag${personaCustomization === undefined ? "" : " is-custom"}`}
                      title={personaDescription}
                    >
                      {personaName}
                    </small>
                  </span>
                  <span className="seat-persona-control">
                    <select
                      className="seat-persona-select"
                      aria-label={`${t("persona")} ${index + 1}`}
                      disabled={!isHost}
                      value={persona.id}
                      onChange={(event) => assignPersona(seatId, event.target.value)}
                    >
                      {AI_PERSONAS.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.names[i18n.language === "en" ? "en" : "zh-CN"]}
                        </option>
                      ))}
                    </select>
                    <button
                      className={`icon-button persona-edit-button${personaCustomization === undefined ? "" : " is-custom"}`}
                      type="button"
                      disabled={!isHost}
                      title={t(
                        personaCustomization === undefined ? "editPersona" : "editCustomPersona"
                      )}
                      aria-label={`${t("editPersona")} ${seatName}`}
                      onClick={() => setEditingPersonaSeatId(seatId)}
                    >
                      <Pencil size={15} />
                    </button>
                  </span>
                  <select
                    className="seat-model-select"
                    aria-label={`${t("modelProfile")} ${index + 1}`}
                    title={t("seatObservationSummary", {
                      room: config.rules.aiObservationPasses,
                      max: modelObservationLimit,
                      effective: effectiveObservationLimit
                    })}
                    data-observation-limit={effectiveObservationLimit}
                    disabled={!isHost}
                    value={record.profile.id}
                    onChange={(event) => assignProfile(seatId, event.target.value)}
                  >
                    {profiles.map((profile) => (
                      <option
                        key={profile.profile.id}
                        value={profile.profile.id}
                        disabled={!profileSupportsSeat(seatId, profile.profile.capabilities)}
                      >
                        {profile.profile.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          {invalidSeats.length > 0 && <p className="form-error">{t("noAi")}</p>}
        </section>
      </div>

      {isHost && advancedOptionsOpen && (
        <section className="lobby-band settings-band" id="advanced-room-options">
          <RulesEditor
            config={config}
            relayOnlyAvailable={turnConfigured}
            onChange={changeRules}
            onSave={saveRules}
          />
        </section>
      )}

      <footer className="lobby-footer">
        {isHost ? (
          <>
            <button
              className="secondary-button advanced-options-button"
              type="button"
              aria-controls="advanced-room-options"
              aria-expanded={advancedOptionsOpen}
              onClick={() => setAdvancedOptionsOpen((open) => !open)}
            >
              <SlidersHorizontal size={18} />
              {t("advancedOptions")}
            </button>
            <button
              className="primary-button start-button"
              type="button"
              disabled={
                invalidSeats.length > 0 ||
                state.participants.some((participant) => !participant.connected)
              }
              onClick={() => setPromptDialogOpen(true)}
            >
              <Play size={19} />
              {t("start")}
            </button>
          </>
        ) : (
          <span className="waiting-label">{t("waiting")}</span>
        )}
      </footer>

      {promptDialogOpen && (
        <PromptStartDialog
          locale={state.config.locale}
          showTopicHint={config.showTopicHint !== false}
          generatedAvailable={generatedPromptAvailable}
          customMakesHostSpectator={
            config.mode === "blind-relay" &&
            timeline.some((slot) => slot.actorId === session.participantId)
          }
          onSelect={startWithPrompt}
          onClose={() => setPromptDialogOpen(false)}
        />
      )}
      {leaveDialogOpen && (
        <LeaveRoomDialog onConfirm={onLeave} onClose={() => setLeaveDialogOpen(false)} />
      )}
      {editingPersonaSeatId !== undefined && editingPersona !== undefined && (
        <PersonaEditorDialog
          key={editingPersonaSeatId}
          persona={editingPersona}
          locale={state.config.locale}
          value={session.seatPersonaCustomizations[editingPersonaSeatId]}
          onSave={(value) => savePersonaCustomization(editingPersonaSeatId, value)}
          onReset={() => resetPersonaCustomization(editingPersonaSeatId)}
          onClose={() => setEditingPersonaSeatId(undefined)}
        />
      )}
    </main>
  );
}
