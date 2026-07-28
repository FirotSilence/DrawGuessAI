import { History, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchMatches, likeMatch, type MatchSummary } from "../lib/api";
import { MatchList } from "./MatchList";

export function RecentMatches({
  onOpenAll,
  onOpenReplay
}: {
  onOpenAll: () => void;
  onOpenReplay: (token: string) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<MatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [likingToken, setLikingToken] = useState<string>();

  useEffect(() => {
    let active = true;
    void fetchMatches({ limit: 6 })
      .then((page) => {
        if (active) setItems(page.items);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : t("matchLoadError"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const like = async (token: string) => {
    setLikingToken(token);
    try {
      const updated = await likeMatch(token);
      setItems((current) => current.map((item) => (item.token === token ? updated : item)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("matchLoadError"));
    } finally {
      setLikingToken(undefined);
    }
  };

  return (
    <section className="recent-matches" aria-label={t("recentMatches")}>
      <div className="recent-matches-bar">
        <span className="recent-matches-label">
          <History size={15} />
          {t("recentMatches")}
        </span>
        <div className="recent-matches-ticker">
          {loading ? (
            <div className="match-loading" role="status">
              <LoaderCircle className="spin" size={16} />
              <span>{t("loadingMatches")}</span>
            </div>
          ) : items.length > 0 ? (
            <div className="recent-matches-ticker-track">
              <MatchList
                compact
                ticker
                items={items}
                likingToken={likingToken}
                onLike={(token) => void like(token)}
                onOpenReplay={onOpenReplay}
              />
            </div>
          ) : (
            <p className="recent-matches-empty">{error === "" ? t("noMatches") : error}</p>
          )}
        </div>
        <button
          className="icon-button recent-matches-all-button"
          type="button"
          title={t("allMatches")}
          aria-label={t("allMatches")}
          onClick={onOpenAll}
        >
          <History size={17} />
        </button>
      </div>
    </section>
  );
}
