import { ArrowLeft, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchMatches, likeMatch, type MatchSummary } from "../lib/api";
import { MatchList } from "./MatchList";
import { SourceLink } from "./SourceLink";

const PAGE_SIZE = 12;

export function MatchHistoryScreen({
  onBack,
  onOpenReplay
}: {
  onBack: () => void;
  onOpenReplay: (token: string) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<MatchSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [likingToken, setLikingToken] = useState<string>();
  const [error, setError] = useState("");

  const load = useCallback(
    async (cursor?: string) => {
      if (cursor === undefined) setLoading(true);
      else setLoadingMore(true);
      setError("");
      try {
        const page = await fetchMatches({
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor })
        });
        setItems((current) => (cursor === undefined ? page.items : [...current, ...page.items]));
        setNextCursor(page.nextCursor);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("matchLoadError"));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [t]
  );

  useEffect(() => {
    void load();
  }, [load]);

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
    <main className="match-history-screen">
      <header className="match-history-header">
        <button className="icon-button" type="button" title={t("back")} onClick={onBack}>
          <ArrowLeft size={19} />
        </button>
        <div>
          <span className="eyebrow">{t("matchArchive")}</span>
          <h1>{t("allMatches")}</h1>
        </div>
        <SourceLink />
      </header>
      <section className="match-history-content">
        {loading ? (
          <div className="match-loading" role="status">
            <LoaderCircle className="spin" size={22} />
            <span>{t("loadingMatches")}</span>
          </div>
        ) : items.length > 0 ? (
          <>
            <MatchList
              items={items}
              likingToken={likingToken}
              onLike={(token) => void like(token)}
              onOpenReplay={onOpenReplay}
            />
            {nextCursor !== undefined && (
              <button
                className="secondary-button match-load-more"
                type="button"
                disabled={loadingMore}
                onClick={() => void load(nextCursor)}
              >
                {loadingMore && <LoaderCircle className="spin" size={17} />}
                {t("loadMoreMatches")}
              </button>
            )}
          </>
        ) : (
          <p className="muted-copy">{error === "" ? t("noMatches") : error}</p>
        )}
      </section>
    </main>
  );
}
