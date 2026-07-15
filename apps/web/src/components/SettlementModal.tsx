import type { TimelineSlot } from "@drawguessai/game-core";
import { Gauge, Minus, Trophy, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import type { RoundtableResult } from "../lib/turn-contribution";
import { PersonaAvatar } from "./PersonaAvatar";

interface SettlementModalProps {
  result: RoundtableResult;
  actors: readonly TimelineSlot[];
  onClose: () => void;
}

function AnimatedScore({ score }: { score: number | undefined }) {
  const [shown, setShown] = useState<number | undefined>(score === undefined ? undefined : 0);

  useEffect(() => {
    if (score === undefined) {
      setShown(undefined);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(score);
      return;
    }
    let frame = 0;
    const delay = window.setTimeout(() => {
      const startedAt = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / 820);
        const eased = 1 - Math.pow(1 - progress, 3);
        setShown(score * eased);
        if (progress < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }, 480);
    return () => {
      window.clearTimeout(delay);
      cancelAnimationFrame(frame);
    };
  }, [score]);

  return (
    <strong className="settlement-score-value">
      {shown === undefined ? "--" : shown.toFixed(1)}
      <span>/10</span>
    </strong>
  );
}

function ActorAvatar({
  actor,
  featured = false
}: {
  actor: TimelineSlot | undefined;
  featured?: boolean;
}) {
  if (actor === undefined) {
    return (
      <span className={`settlement-actor-placeholder${featured ? " is-featured" : ""}`}>
        <Minus size={featured ? 24 : 20} />
      </span>
    );
  }
  if (actor.actorType === "human") {
    return (
      <span
        className={`settlement-human-avatar${featured ? " is-featured" : ""}`}
        role="img"
        aria-label={actor.displayName}
      >
        <UserRound size={featured ? 28 : 22} />
      </span>
    );
  }
  return (
    <PersonaAvatar
      personaId={actor.personaId ?? "maestro"}
      size={featured ? "large" : "medium"}
      label={actor.displayName}
    />
  );
}

export function SettlementModal({ result, actors, onClose }: SettlementModalProps) {
  const { t } = useTranslation();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const actorById = useMemo(() => new Map(actors.map((actor) => [actor.actorId, actor])), [actors]);
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop settlement-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal settlement-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settlement-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header settlement-dialog-header">
          <span className="settlement-title-icon" aria-hidden="true">
            <Trophy size={24} />
          </span>
          <span>
            <small>{t("roundtableResults")}</small>
            <h2 id="settlement-dialog-title">{t("settlementTitle")}</h2>
          </span>
          <button
            className="icon-button"
            type="button"
            ref={closeButtonRef}
            title={t("settlementClose")}
            aria-label={t("settlementClose")}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>

        <div className="settlement-stage" data-layout="single-column-summary">
          <section className="settlement-award is-best">
            <div className="settlement-award-summary">
              <span className="settlement-actor is-featured">
                <ActorAvatar
                  actor={result.best ? actorById.get(result.best.seatId) : undefined}
                  featured
                />
              </span>
              <span className="settlement-award-copy">
                <small>{t("roundtableBest")}</small>
                <strong>{result.best?.displayName ?? t("roundtableNoVote")}</strong>
                <span>
                  {result.best === undefined
                    ? t("roundtableAwaitingPositive")
                    : t("roundtablePlayerStats", {
                        positive: result.best.positive,
                        negative: result.best.negative,
                        net: result.best.net
                      })}
                </span>
              </span>
            </div>
          </section>

          <section className="settlement-award is-worst">
            <div className="settlement-award-summary">
              <span className="settlement-actor">
                <ActorAvatar
                  actor={result.worst ? actorById.get(result.worst.seatId) : undefined}
                />
              </span>
              <span className="settlement-award-copy">
                <small>{t("roundtableWorst")}</small>
                <strong>{result.worst?.displayName ?? t("roundtableNoVote")}</strong>
                <span>
                  {result.worst === undefined
                    ? t("roundtableAwaitingNegative")
                    : t("roundtablePlayerStats", {
                        positive: result.worst.positive,
                        negative: result.worst.negative,
                        net: result.worst.net
                      })}
                </span>
              </span>
            </div>
          </section>

          <section className="settlement-award is-score">
            <div className="settlement-award-summary">
              <span className="settlement-score-icon" aria-hidden="true">
                <Gauge size={19} />
              </span>
              <span className="settlement-award-copy">
                <small>{t("roundtableOverall")}</small>
                <AnimatedScore score={result.overallScore} />
                <span>
                  {t("settlementScoreStats", {
                    ratings: result.ratings.length,
                    interactions: result.totalInteractions
                  })}
                </span>
              </span>
              <div className="settlement-score-meter" aria-hidden="true">
                {Array.from({ length: 10 }, (_, index) => (
                  <span
                    className={
                      result.overallScore !== undefined && index < Math.round(result.overallScore)
                        ? "is-filled"
                        : undefined
                    }
                    style={{ "--meter-index": index } as CSSProperties}
                    key={index}
                  />
                ))}
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
