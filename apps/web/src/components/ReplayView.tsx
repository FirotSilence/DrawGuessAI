import type { GameState } from "@drawguessai/game-core";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchReplay } from "../lib/api";
import { RevealScreen } from "./RevealScreen";
import { SourceLink } from "./SourceLink";

interface ReplayPayload {
  protocolVersion: 1;
  roomId: string;
  expiresAt: number;
  state: GameState;
  events: unknown[];
}

export function ReplayView({ token, onBack }: { token: string; onBack: () => void }) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<ReplayPayload>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetchReplay(token)
      .then((value) => {
        if (active) setPayload(value as ReplayPayload);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : t("replayNotFound"));
      });
    return () => {
      active = false;
    };
  }, [t, token]);

  if (payload !== undefined)
    return <RevealScreen state={payload.state} replayPayload={payload} onBack={onBack} />;
  return (
    <main className="loading-screen">
      {error === "" ? (
        <>
          <LoaderCircle className="spin" size={34} />
          <strong>{t("loadingReplay")}</strong>
          <SourceLink />
        </>
      ) : (
        <>
          <AlertTriangle size={34} />
          <strong>{t("replayNotFound")}</strong>
          <p>{error}</p>
          <button className="primary-button" type="button" onClick={onBack}>
            {t("back")}
          </button>
          <SourceLink />
        </>
      )}
    </main>
  );
}
