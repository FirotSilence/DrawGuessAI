import { ModelProfileSchema } from "@drawguessai/ai-adapters";
import { useCallback, useEffect, useMemo, useState } from "react";

import { HomeScreen } from "./components/HomeScreen";
import { LocalDemo } from "./components/LocalDemo";
import { ModelProfilesDialog } from "./components/ModelProfilesDialog";
import { ReplayView } from "./components/ReplayView";
import { RoomView } from "./components/RoomView";
import { fetchAppConfig } from "./lib/api";
import { DEMO_PROFILE, loadModelProfiles, type StoredModelProfile } from "./lib/model-store";
import {
  clearRoomSession,
  loadRoomSession,
  saveRoomSession,
  type RoomSession
} from "./lib/session-store";

type Screen = "home" | "room" | "demo" | "replay";

export default function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const replayToken = params.get("replay") ?? "";
  const requestedRoom = (params.get("room") ?? "").toUpperCase();
  const restored = requestedRoom === "" ? undefined : loadRoomSession(requestedRoom);
  const [homeRoomCode, setHomeRoomCode] = useState(requestedRoom);
  const [screen, setScreen] = useState<Screen>(
    replayToken !== "" ? "replay" : restored === undefined ? "home" : "room"
  );
  const [session, setSession] = useState<RoomSession | undefined>(restored);
  const [profiles, setProfiles] = useState<StoredModelProfile[]>([
    { profile: DEMO_PROFILE, remember: false }
  ]);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [turnConfigured, setTurnConfigured] = useState(false);

  const reloadProfiles = useCallback(async () => {
    const local = await loadModelProfiles();
    try {
      const config = await fetchAppConfig();
      setTurnConfigured(config.turnConfigured);
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

  return (
    <>
      {screen === "home" && (
        <HomeScreen
          profiles={profiles}
          initialRoomCode={homeRoomCode}
          onOpenModels={() => setModelsOpen(true)}
          onSession={enterRoom}
          onLocalDemo={() => setScreen("demo")}
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
      {screen === "demo" && <LocalDemo onBack={() => setScreen("home")} />}
      {screen === "replay" && <ReplayView token={replayToken} onBack={goHome} />}
      <ModelProfilesDialog
        open={modelsOpen}
        profiles={profiles}
        onClose={() => setModelsOpen(false)}
        onReload={reloadProfiles}
      />
    </>
  );
}
