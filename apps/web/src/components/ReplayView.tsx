import type { GameState } from "@drawguessai/game-core";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchReplay, likeMatch } from "../lib/api";
import { RevealScreen } from "./RevealScreen";
import { SourceLink } from "./SourceLink";

interface ReplayPayload {
  featured?: true;
  protocolVersion: 1;
  roomId: string;
  expiresAt?: number;
  permanent?: boolean;
  likeCount?: number;
  liked?: boolean;
  roundtablePending?: boolean;
  state: GameState;
  events: unknown[];
}

export function ReplayView({ token, onBack }: { token: string; onBack: () => void }) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<ReplayPayload>();
  const [error, setError] = useState("");
  const [liking, setLiking] = useState(false);

  useEffect(() => {
    let active = true;
    setLiking(false);
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

  useEffect(() => {
    if (payload?.roundtablePending !== true) return;
    let active = true;
    let retryTimer: number | undefined;
    const refresh = async () => {
      try {
        const next = (await fetchReplay(token)) as ReplayPayload;
        if (!active) return;
        setPayload(next);
        if (next.roundtablePending === true) {
          retryTimer = window.setTimeout(() => void refresh(), 900);
        }
      } catch {
        if (active) retryTimer = window.setTimeout(() => void refresh(), 1_500);
      }
    };
    retryTimer = window.setTimeout(() => void refresh(), 900);
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [payload?.roundtablePending, token]);

  const like = async () => {
    if (payload === undefined || payload.featured === true || payload.liked === true) return;
    setLiking(true);
    try {
      const updated = await likeMatch(token);
      setPayload((current) =>
        current === undefined
          ? current
          : {
              ...current,
              permanent: updated.permanent,
              likeCount: updated.likeCount,
              liked: updated.liked
            }
      );
    } catch {
      // Keep the replay available so the viewer can retry the action.
    } finally {
      setLiking(false);
    }
  };

  if (payload !== undefined)
    return (
      <RevealScreen
        state={payload.state}
        replayPayload={payload}
        featuredReplay={payload.featured === true}
        permanentReplay={payload.permanent === true}
        roundtablePending={payload.roundtablePending === true}
        likeCount={payload.likeCount}
        liked={payload.liked}
        liking={liking}
        onLike={
          payload.featured === true || payload.likeCount === undefined
            ? undefined
            : () => void like()
        }
        onBack={onBack}
      />
    );
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
