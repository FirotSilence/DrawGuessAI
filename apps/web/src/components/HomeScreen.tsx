import { AI_PERSONAS, createDemoTurnResult, getPersona } from "@drawguessai/ai-adapters";
import { DEFAULT_GAME_CONFIG, type GameMode } from "@drawguessai/game-core";
import type { PublicAiSeat } from "@drawguessai/network-protocol";
import { Bot, DoorOpen, Gamepad2, Globe2, Settings2, Sparkles, UsersRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { createRoom, joinRoom } from "../lib/api";
import { createAiSeatNames, createAiSeatPersonas, createAiSeatProfiles } from "../lib/ai-seats";
import {
  isModelProfileReady,
  preferredModelProfileId,
  type StoredModelProfile
} from "../lib/model-store";
import { getOrCreateDisplayName, rememberDisplayName } from "../lib/player-name";
import type { RoomSession } from "../lib/session-store";
import { setLocale } from "../i18n";
import { CanvasBoard } from "./CanvasBoard";
import { SourceLink } from "./SourceLink";

interface HomeScreenProps {
  profiles: readonly StoredModelProfile[];
  initialRoomCode?: string;
  onOpenModels: () => void;
  onSession: (session: RoomSession) => void;
  onLocalDemo: () => void;
}

export function HomeScreen({
  profiles,
  initialRoomCode = "",
  onOpenModels,
  onSession,
  onLocalDemo
}: HomeScreenProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === "en" ? "en" : "zh-CN";
  const [tab, setTab] = useState<"create" | "join">(initialRoomCode === "" ? "create" : "join");
  const [displayName, setDisplayName] = useState(() => getOrCreateDisplayName(locale));
  const [roomCode, setRoomCode] = useState(initialRoomCode.toUpperCase());
  const [mode, setMode] = useState<GameMode>("ai-theatre");
  const [joinAs, setJoinAs] = useState<"player" | "spectator">("player");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const defaultProfileId = preferredModelProfileId(profiles);
  const previousDefaultProfileId = useRef(defaultProfileId);
  const [seatProfiles, setSeatProfiles] = useState<Record<string, string>>(() =>
    createAiSeatProfiles(defaultProfileId)
  );
  const seatPersonas = useMemo(() => createAiSeatPersonas(), []);
  const seatNames = useMemo(() => createAiSeatNames(locale), [locale]);

  useEffect(() => {
    const previousDefault = previousDefaultProfileId.current;
    setSeatProfiles((current) =>
      Object.fromEntries(
        Object.entries(current).map(([seatId, profileId]) => [
          seatId,
          profileId === previousDefault ||
          !profiles.some((record) => record.profile.id === profileId)
            ? defaultProfileId
            : profileId
        ])
      )
    );
    previousDefaultProfileId.current = defaultProfileId;
  }, [defaultProfileId, profiles]);

  const sampleCommands = useMemo(
    () =>
      createDemoTurnResult({
        jobId: "home-sample",
        roomId: "sample",
        turnIndex: 0,
        role: "draw",
        locale: i18n.language === "en" ? "en" : "zh-CN",
        personaId: "maestro",
        inputText: "sample",
        observationIndex: 0,
        observationLimit: 0,
        timeLimitSeconds: 30,
        budget: {
          maxStrokes: 60,
          maxUndos: 3,
          colorCount: 10,
          remainingStrokes: 60,
          remainingUndos: 3
        }
      }).commands ?? [],
    [i18n.language]
  );

  const publicSeats = (): PublicAiSeat[] =>
    Object.entries(seatProfiles).map(([seatId, profileId], index) => {
      const record =
        profiles.find((candidate) => candidate.profile.id === profileId) ?? profiles[0]!;
      const persona = getPersona(
        seatPersonas[seatId] ?? AI_PERSONAS[index % AI_PERSONAS.length]!.id
      );
      return {
        seatId,
        profileId: record.profile.id,
        displayName: seatNames[seatId] ?? `AI ${index + 1}`,
        personaId: persona.id,
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

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const locale = i18n.language === "en" ? "en" : "zh-CN";
      const response = await createRoom({
        displayName: displayName.trim(),
        config: { ...DEFAULT_GAME_CONFIG, mode, locale },
        aiSeats: publicSeats()
      });
      rememberDisplayName(displayName);
      onSession({
        roomId: response.roomId,
        participantId: response.participantId,
        reconnectToken: response.reconnectToken,
        hostToken: response.hostToken,
        inviteUrl: response.inviteUrl,
        seatProfiles,
        seatPersonas,
        seatPersonaCustomizations: {},
        seatNames
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("roomError"));
    } finally {
      setBusy(false);
    }
  };

  const submitJoin = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await joinRoom(roomCode.trim().toUpperCase(), {
        displayName: displayName.trim(),
        joinAs
      });
      rememberDisplayName(displayName);
      onSession({
        roomId: response.roomId,
        participantId: response.participantId,
        reconnectToken: response.reconnectToken,
        seatProfiles: {},
        seatPersonas: {},
        seatPersonaCustomizations: {},
        seatNames: {}
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("roomError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="home-screen">
      <header className="home-header">
        <a className="brand-lockup" href="/" aria-label={t("brand")}>
          <span className="brand-mark">
            <PaintMark />
          </span>
          <strong>{t("brand")}</strong>
        </a>
        <div className="header-actions">
          <SourceLink />
          <button
            className="icon-button"
            type="button"
            title={t("settings")}
            onClick={onOpenModels}
          >
            <Settings2 size={19} />
          </button>
          <button
            className="locale-button"
            type="button"
            onClick={() => void setLocale(i18n.language === "en" ? "zh-CN" : "en")}
          >
            <Globe2 size={17} />
            {i18n.language === "en" ? "中文" : "EN"}
          </button>
        </div>
      </header>

      <div className="home-main">
        <section className="room-tool" aria-label={tab === "create" ? t("create") : t("join")}>
          <div className="segmented-control">
            <button
              className={tab === "create" ? "is-active" : ""}
              type="button"
              onClick={() => setTab("create")}
            >
              <Gamepad2 size={17} />
              {t("create")}
            </button>
            <button
              className={tab === "join" ? "is-active" : ""}
              type="button"
              onClick={() => setTab("join")}
            >
              <DoorOpen size={17} />
              {t("join")}
            </button>
          </div>

          <form
            onSubmit={(event) => void (tab === "create" ? submitCreate(event) : submitJoin(event))}
          >
            <label className="field-label">
              <span>{t("displayName")}</span>
              <input
                required
                maxLength={24}
                value={displayName}
                autoComplete="nickname"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>

            {tab === "create" ? (
              <>
                <div className="mode-selector">
                  <button
                    type="button"
                    className={mode === "ai-theatre" ? "mode-option is-active" : "mode-option"}
                    onClick={() => setMode("ai-theatre")}
                  >
                    <Bot size={21} />
                    <span>{t("aiTheatre")}</span>
                  </button>
                  <button
                    type="button"
                    className={mode === "blind-relay" ? "mode-option is-active" : "mode-option"}
                    onClick={() => setMode("blind-relay")}
                  >
                    <UsersRound size={21} />
                    <span>{t("blindRelay")}</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="field-label">
                  <span>{t("roomCode")}</span>
                  <input
                    required
                    minLength={8}
                    maxLength={8}
                    value={roomCode}
                    autoComplete="off"
                    onChange={(event) =>
                      setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""))
                    }
                  />
                </label>
                <div className="segmented-control join-role">
                  <button
                    type="button"
                    className={joinAs === "player" ? "is-active" : ""}
                    onClick={() => setJoinAs("player")}
                  >
                    {t("participant")}
                  </button>
                  <button
                    type="button"
                    className={joinAs === "spectator" ? "is-active" : ""}
                    onClick={() => setJoinAs("spectator")}
                  >
                    {t("spectator")}
                  </button>
                </div>
              </>
            )}

            {error !== "" && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary-button room-submit" type="submit" disabled={busy}>
              {tab === "create" ? <Sparkles size={18} /> : <DoorOpen size={18} />}
              {tab === "create" ? t("createAction") : t("joinAction")}
            </button>
          </form>
          <button className="text-button local-demo-button" type="button" onClick={onLocalDemo}>
            <Gamepad2 size={17} />
            {t("localDemo")}
          </button>
        </section>

        <section className="home-canvas" aria-label={t("localDemo")}>
          <div className="sample-tape sample-tape--left" />
          <div className="sample-tape sample-tape--right" />
          <CanvasBoard commands={sampleCommands} compact />
          <div className="sample-caption">
            <span>{seatNames["ai-1"] ?? "AI #1"}</span>
            <strong>{AI_PERSONAS[0]!.fallback[i18n.language === "en" ? "en" : "zh-CN"]}</strong>
          </div>
        </section>
      </div>
    </main>
  );
}

function PaintMark() {
  return (
    <span className="paint-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
