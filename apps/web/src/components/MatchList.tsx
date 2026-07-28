import { Clock3, Heart, Infinity as InfinityIcon, Paintbrush, UsersRound } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { MatchSummary } from "../lib/api";

export interface MatchListProps {
  items: readonly MatchSummary[];
  onLike: (token: string) => void;
  onOpenReplay: (token: string) => void;
  likingToken?: string | undefined;
  compact?: boolean;
  ticker?: boolean;
}

function matchDate(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

export function MatchList({
  items,
  onLike,
  onOpenReplay,
  likingToken,
  compact = false,
  ticker = false
}: MatchListProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === "en" ? "en" : "zh-CN";
  const dateLabels = useMemo(
    () => new Map(items.map((item) => [item.token, matchDate(item.completedAt, locale)])),
    [items, locale]
  );

  return (
    <div className={`match-list${compact ? " is-compact" : ""}${ticker ? " is-ticker" : ""}`}>
      {items.map((item, index) => (
        <article className="match-card" key={`${item.token}:${index}`}>
          <button
            className="match-card-main"
            type="button"
            aria-label={t("openMatchReplay")}
            onClick={() => onOpenReplay(item.token)}
          >
            <span className="match-prompt">{item.prompt}</span>
            <span className="match-meta">
              <span>
                <Paintbrush size={14} />
                {t(item.mode === "ai-theatre" ? "aiTheatre" : "blindRelay")}
              </span>
              <span>
                <UsersRound size={14} />
                {t("matchTurns", { count: item.turnCount })}
              </span>
              <span>
                <Clock3 size={14} />
                {dateLabels.get(item.token)}
              </span>
              {item.permanent && (
                <span className="match-permanent" title={t("matchPermanent")}>
                  <InfinityIcon size={14} />
                  {t("matchPermanent")}
                </span>
              )}
            </span>
          </button>
          <button
            className={`match-like-button${item.liked ? " is-liked" : ""}`}
            type="button"
            aria-pressed={item.liked}
            title={t(item.liked ? "matchLiked" : "likeMatch")}
            disabled={item.liked || likingToken === item.token}
            onClick={() => onLike(item.token)}
          >
            <Heart size={17} fill={item.liked ? "currentColor" : "none"} />
            <span>{item.likeCount}</span>
          </button>
        </article>
      ))}
    </div>
  );
}
