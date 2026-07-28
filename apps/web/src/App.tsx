import { ModelProfileSchema } from "@drawguessai/ai-adapters";
import { useCallback, useEffect, useState } from "react";

import { HomeScreen } from "./components/HomeScreen";
import { MatchHistoryScreen } from "./components/MatchHistoryScreen";
import { ModelProfilesDialog } from "./components/ModelProfilesDialog";
import { ReplayView } from "./components/ReplayView";
import { RoomView } from "./components/RoomView";
import { fetchAppConfig } from "./lib/api";
import { loadModelProfiles, type StoredModelProfile } from "./lib/model-store";
import {
  clearRoomSession,
  loadRoomSession,
  saveRoomSession,
  type RoomSession
} from "./lib/session-store";

type Screen = "home" | "room" | "replay" | "history";

export default function App() {
  const params = new URLSearchParams(location.search);
  const replayToken = params.get("replay") ?? "";
  const matchesRequested = params.get("matches") === "1";
  const requestedRoom = (params.get("room") ?? "").toUpperCase();
  const restored = requestedRoom === "" ? undefined : loadRoomSession(requestedRoom);
  const [homeRoomCode, setHomeRoomCode] = useState(requestedRoom);
  const [screen, setScreen] = useState<Screen>(
    replayToken !== ""
      ? "replay"
      : matchesRequested
        ? "history"
        : restored === undefined
          ? "home"
          : "room"
  );
  const [session, setSession] = useState<RoomSession | undefined>(restored);
  const [profiles, setProfiles] = useState<StoredModelProfile[]>([]);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [turnConfigured, setTurnConfigured] = useState(false);
  const [automatedRoomCode, setAutomatedRoomCode] = useState<string>();

  const reloadProfiles = useCallback(async () => {
    const local = await loadModelProfiles();
    try {
      const config = await fetchAppConfig();
      setTurnConfigured(config.turnConfigured);
      setAutomatedRoomCode(config.automatedRoomCode);
      const server: StoredModelProfile[] = config.serverAiProfiles.map((profile) => ({
        profile: ModelProfileSchema.parse({
          ...profile,
          protocol: "openai-compatible",
          baseUrl: "https://server.invalid",
          model: profile.id,
          enabled: true
        }),
        remember: false
      }));
      setProfiles([
        ...local,
        ...server.filter((record) => !local.some((item) => item.profile.id === record.profile.id))
      ]);
    } catch {
      setTurnConfigured(false);
      setAutomatedRoomCode(undefined);
      setProfiles(local);
    }
  }, []);

  useEffect(() => {
    void reloadProfiles();
  }, [reloadProfiles]);

  const goHome = () => {
    if (session !== undefined) clearRoomSession(session.roomId);
    history.replaceState(null, "", location.pathname);
    setHomeRoomCode("");
    setSession(undefined);
    setScreen("home");
  };

  const enterRoom = (next: RoomSession) => {
    saveRoomSession(next);
    setSession(next);
    history.replaceState(null, "", `?room=${encodeURIComponent(next.roomId)}`);
    setScreen("room");
  };

  const openMatchHistory = () => {
    history.replaceState(null, "", "?matches=1");
    setScreen("history");
  };

  const openReplay = (token: string) => {
    history.replaceState(null, "", `?replay=${encodeURIComponent(token)}`);
    setScreen("replay");
  };

  return (
    <>
      {screen === "home" && (
        <HomeScreen
          profiles={profiles}
          initialRoomCode={homeRoomCode}
          onOpenModels={() => setModelsOpen(true)}
          onSession={enterRoom}
          onOpenMatchHistory={openMatchHistory}
          onOpenReplay={openReplay}
          {...(automatedRoomCode === undefined ? {} : { automatedRoomCode })}
        />
      )}
      {screen === "room" && session !== undefined && (
        <RoomView
          initialSession={session}
          profiles={profiles}
          turnConfigured={turnConfigured}
          onLeave={goHome}
        />
      )}
      {screen === "replay" && <ReplayView token={replayToken} onBack={goHome} />}
      {screen === "history" && <MatchHistoryScreen onBack={goHome} onOpenReplay={openReplay} />}
      <ModelProfilesDialog
        open={modelsOpen}
        profiles={profiles}
        onClose={() => setModelsOpen(false)}
        onReload={reloadProfiles}
      />
    </>
  );
}
