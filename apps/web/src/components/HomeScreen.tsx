import { AI_PERSONAS, getPersona } from "@drawguessai/ai-adapters";
import type { CanvasCommand } from "@drawguessai/canvas-protocol";
import { DEFAULT_GAME_CONFIG, type GameMode } from "@drawguessai/game-core";
import type { PublicAiSeat } from "@drawguessai/network-protocol";
import { Bot, DoorOpen, Gamepad2, Globe2, Settings2, Sparkles, UsersRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiRequestError, createRoom, fetchAutomatedRoom, joinRoom } from "../lib/api";
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
import { RecentMatches } from "./RecentMatches";
import { SourceLink } from "./SourceLink";

interface HomeScreenProps {
  profiles: readonly StoredModelProfile[];
  initialRoomCode?: string;
  onOpenModels: () => void;
  onSession: (session: RoomSession) => void;
  onOpenMatchHistory: () => void;
  onOpenReplay: (token: string) => void;
  automatedRoomCode?: string;
}

const HOME_SAMPLE_COMMANDS: readonly CanvasCommand[] = [
  {
    type: "stroke",
    id: "sample-canopy",
    tool: "pen",
    color: "#ea4d3d",
    width: 16,
    points: [
      { x: 250, y: 350 },
      { x: 300, y: 260 },
      { x: 390, y: 210 },
      { x: 500, y: 195 },
      { x: 610, y: 210 },
      { x: 700, y: 260 },
      { x: 750, y: 350 },
      { x: 670, y: 330 },
      { x: 585, y: 350 },
      { x: 500, y: 325 },
      { x: 415, y: 350 },
      { x: 330, y: 330 },
      { x: 250, y: 350 }
    ],
    offsetMs: 0
  },
  {
    type: "stroke",
    id: "sample-handle",
    tool: "pen",
    color: "#202124",
    width: 16,
    points: [
      { x: 500, y: 325 },
      { x: 500, y: 720 }
    ],
    offsetMs: 120
  },
  {
    type: "stroke",
    id: "sample-hook",
    tool: "pen",
    color: "#202124",
    width: 16,
    points: [
      { x: 500, y: 720 },
      { x: 500, y: 780 },
      { x: 465, y: 815 },
      { x: 420, y: 790 }
    ],
    offsetMs: 240
  },
  { type: "finish", id: "sample-finish", offsetMs: 360 }
];

export function HomeScreen({
  profiles,
  initialRoomCode = "",
  onOpenModels,
  onSession,
  onOpenMatchHistory,
  onOpenReplay,
  automatedRoomCode
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
    defaultProfileId === undefined ? {} : createAiSeatProfiles(defaultProfileId)
  );
  const seatPersonas = useMemo(() => createAiSeatPersonas(), []);
  const seatNames = useMemo(() => createAiSeatNames(locale), [locale]);

  useEffect(() => {
    if (defaultProfileId === undefined) {
      setSeatProfiles({});
      previousDefaultProfileId.current = undefined;
      return;
    }
    const previousDefault = previousDefaultProfileId.current;
    const defaults = createAiSeatProfiles(defaultProfileId);
    setSeatProfiles((current) =>
      Object.fromEntries(
        Object.keys(defaults).map((seatId) => [
          seatId,
          current[seatId] === undefined ||
          current[seatId] === previousDefault ||
          !profiles.some((record) => record.profile.id === current[seatId])
            ? defaultProfileId
            : current[seatId]!
        ])
      )
    );
    previousDefaultProfileId.current = defaultProfileId;
  }, [defaultProfileId, profiles]);

  useEffect(() => {
    if (automatedRoomCode !== undefined && roomCode.trim().toUpperCase() === automatedRoomCode) {
      setJoinAs("spectator");
    }
  }, [automatedRoomCode, roomCode]);

  const publicSeats = (): PublicAiSeat[] =>
    Object.entries(seatProfiles).flatMap(([seatId, profileId], index) => {
      const record = profiles.find((candidate) => candidate.profile.id === profileId);
      if (record === undefined) return [];
      const persona = getPersona(
        seatPersonas[seatId] ?? AI_PERSONAS[index % AI_PERSONAS.length]!.id
      );
      return [
        {
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
        }
      ];
    });

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const locale = i18n.language === "en" ? "en" : "zh-CN";
      const aiSeats = publicSeats();
      if (defaultProfileId === undefined || aiSeats.length === 0) {
        throw new Error(t("noAi"));
      }
      const response = await createRoom({
        displayName: displayName.trim(),
        config: { ...DEFAULT_GAME_CONFIG, mode, locale },
        aiSeats
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
      const effectiveJoinAs =
        automatedRoomCode !== undefined && roomCode.trim().toUpperCase() === automatedRoomCode
          ? "spectator"
          : joinAs;
      const response = await joinRoom(roomCode.trim().toUpperCase(), {
        displayName: displayName.trim(),
        joinAs: effectiveJoinAs
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

  const watchAutomatedRoom = async () => {
    setBusy(true);
    setError("");
    try {
      const room = await fetchAutomatedRoom();
      if (!room.available) {
        throw new ApiRequestError(503, room.error, "automated-room-unavailable");
      }
      if (room.phase === "complete" && room.replayToken !== undefined) {
        onOpenReplay(room.replayToken);
        return;
      }
      const response = await joinRoom(room.roomCode, {
        displayName: displayName.trim(),
        joinAs: "spectator"
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
      setError(
        cause instanceof ApiRequestError && cause.code === "automated-ai-unavailable"
          ? t("automatedRoomUnavailable")
          : cause instanceof Error
            ? cause.message
            : t("roomError")
      );
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
                    disabled={roomCode.trim().toUpperCase() === automatedRoomCode}
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
            <button
              className="primary-button room-submit"
              type="submit"
              disabled={busy || (tab === "create" && defaultProfileId === undefined)}
            >
              {tab === "create" ? <Sparkles size={18} /> : <DoorOpen size={18} />}
              {tab === "create" ? t("createAction") : t("joinAction")}
            </button>
          </form>
          <button
            className="text-button automated-room-button"
            type="button"
            disabled={busy}
            onClick={() => void watchAutomatedRoom()}
          >
            <Bot size={17} />
            {t("watchAutoRoom")}
          </button>
        </section>

        <section className="home-canvas" aria-label={t("aiTheatre")}>
          <div className="sample-tape sample-tape--left" />
          <div className="sample-tape sample-tape--right" />
          <CanvasBoard commands={HOME_SAMPLE_COMMANDS} compact />
          <div className="sample-caption">
            <span>{seatNames["ai-1"] ?? "AI #1"}</span>
            <strong>{AI_PERSONAS[0]!.fallback[i18n.language === "en" ? "en" : "zh-CN"]}</strong>
          </div>
        </section>
        <RecentMatches onOpenAll={onOpenMatchHistory} onOpenReplay={onOpenReplay} />
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
