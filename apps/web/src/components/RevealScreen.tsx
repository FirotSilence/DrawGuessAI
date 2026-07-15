import { getPersona } from "@drawguessai/ai-adapters";
import type { GameState, PostGameReview, TimelineSlot } from "@drawguessai/game-core";
import {
  ArrowLeft,
  Download,
  Link2,
  LoaderCircle,
  LogOut,
  MessageCircleMore,
  Paintbrush,
  Search,
  Trophy,
  UserRound
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  contributionForActor,
  receivedPostGameReactions,
  roundtableActors,
  roundtableResult
} from "../lib/turn-contribution";
import { reactionTone } from "../lib/reaction-tone";
import { CanvasBoard } from "./CanvasBoard";
import { PersonaAvatar } from "./PersonaAvatar";
import { PromptTags } from "./PromptTags";
import { ReactionIcon } from "./ReactionBar";
import { SettlementModal } from "./SettlementModal";
import { SourceLink } from "./SourceLink";
import { TurnContributionPreview } from "./TurnContributionPreview";

interface RevealScreenProps {
  state: GameState;
  replayPayload?: unknown;
  onBack: () => void;
}

function RoundtablePost({
  state,
  slot,
  review,
  reviews
}: {
  state: GameState;
  slot: TimelineSlot;
  review: PostGameReview | undefined;
  reviews: readonly PostGameReview[];
}) {
  const { t, i18n } = useTranslation();
  const isHuman = slot.actorType === "human";
  const persona = isHuman
    ? undefined
    : getPersona(review?.personaId ?? slot.personaId ?? "maestro");
  const departed = review?.status === "departed";
  const contribution = contributionForActor(state, slot.actorId);
  const receivedReactions = receivedPostGameReactions(reviews, slot.actorId);
  const replyTo = reviews.find((candidate) => candidate.seatId === review?.replyToSeatId);
  const popoverId = `contribution-${(review?.id ?? slot.actorId).replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  return (
    <article
      className={`persona-review${isHuman ? " roundtable-human" : ""}${departed ? " is-departed" : ""}`}
    >
      <div
        className="review-avatar-anchor"
        tabIndex={contribution === undefined ? undefined : 0}
        aria-describedby={contribution === undefined ? undefined : popoverId}
      >
        {isHuman ? (
          <span className="human-roundtable-avatar" role="img" aria-label={slot.displayName}>
            <UserRound size={21} />
          </span>
        ) : (
          <PersonaAvatar
            personaId={review?.personaId ?? slot.personaId ?? "maestro"}
            size="medium"
            label={slot.displayName}
          />
        )}
        {contribution !== undefined && (
          <div className="avatar-contribution-popover" id={popoverId} role="tooltip">
            <TurnContributionPreview contribution={contribution} variant="tooltip" />
          </div>
        )}
      </div>
      <div className="review-post">
        <div className="review-post-grid">
          <div className="review-copy">
            <header>
              <strong>{slot.displayName}</strong>
              {persona !== undefined && (
                <span className="review-persona-tag">
                  {slot.personaName ?? persona.names[i18n.language === "en" ? "en" : "zh-CN"]}
                </span>
              )}
              {isHuman ? (
                <span className="human-player-badge">{t("humanPlayer")}</span>
              ) : departed ? (
                <span
                  className="review-departed-icon"
                  title={review?.errorCode ?? t("aiReviewDeparted")}
                >
                  <LogOut size={15} />
                </span>
              ) : review !== undefined ? (
                <span
                  className={`review-reaction reaction-tone-${reactionTone(review.reaction)}`}
                  title={t(
                    `reaction${review.reaction[0]!.toUpperCase()}${review.reaction.slice(1)}`
                  )}
                >
                  <ReactionIcon reaction={review.reaction} size={16} />
                </span>
              ) : null}
            </header>
            {replyTo !== undefined && !departed && (
              <small className="review-reply">
                {t("replyingTo", { name: replyTo.displayName })}
              </small>
            )}
            {review !== undefined && <p>{review.text}</p>}
            {review !== undefined && (
              <span className="review-meta">
                <small className="review-model">{review.modelLabel}</small>
                {departed && review.errorCode !== undefined && (
                  <small>{t("reviewErrorCode", { code: review.errorCode })}</small>
                )}
              </span>
            )}
          </div>
          {contribution !== undefined && <TurnContributionPreview contribution={contribution} />}
        </div>
        {receivedReactions.length > 0 && (
          <div className="review-actions review-received-actions">
            <small className="review-actions-label">{t("receivedReactions")}</small>
            {receivedReactions.map((action, index) => (
              <div
                className={`review-action reaction-tone-${reactionTone(action.reaction)}`}
                key={`${slot.actorId}:${action.fromSeatId}:${action.reaction}:${index}`}
              >
                <span
                  title={t(
                    `reaction${action.reaction[0]!.toUpperCase()}${action.reaction.slice(1)}`
                  )}
                >
                  <ReactionIcon reaction={action.reaction} size={16} />
                </span>
                <span>
                  <strong>{t("receivedReactionFrom", { name: action.fromDisplayName })}</strong>
                  <small>{action.text}</small>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function SettlementButton({
  settled,
  compact = false,
  onClick
}: {
  settled: boolean;
  compact?: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      className={`primary-button settlement-trigger${compact ? " is-compact" : ""}`}
      type="button"
      disabled={!settled}
      onClick={onClick}
    >
      {settled ? <Trophy size={17} /> : <LoaderCircle className="spin" size={17} />}
      {t(settled ? "viewSettlement" : "settling")}
    </button>
  );
}

export function RevealScreen({ state, replayPayload, onBack }: RevealScreenProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [settlementOpen, setSettlementOpen] = useState(false);
  const prompt = state.artifacts.find((artifact) => artifact.kind === "prompt");
  const reviews = state.postGameReviews ?? [];
  const tableActors = roundtableActors(state);
  const aiSeatCount = tableActors.filter((slot) => slot.actorType === "ai").length;
  const humanSeatCount = tableActors.length - aiSeatCount;
  const settledSeatCount = humanSeatCount + reviews.length;
  const tableResult = roundtableResult(state, reviews);
  const roundtableSettled = reviews.length >= aiSeatCount || replayPayload !== undefined;

  const exportReplay = () => {
    const payload = replayPayload ?? {
      protocolVersion: state.protocolVersion,
      roomId: state.roomId,
      state
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `drawguessai-${state.roomId}-v${state.protocolVersion}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const copyReplay = async () => {
    if (state.replayToken === undefined) return;
    const url = new URL(location.origin);
    url.searchParams.set("replay", state.replayToken);
    await navigator.clipboard.writeText(url.toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <main className="reveal-screen">
      <header className="reveal-header">
        <button className="icon-button" type="button" title={t("back")} onClick={onBack}>
          <ArrowLeft size={19} />
        </button>
        <div>
          <span className="eyebrow">{t("reveal")}</span>
          <h1>{prompt?.kind === "prompt" ? prompt.text : t("mysteryPrompt")}</h1>
          {prompt?.kind === "prompt" && (
            <PromptTags
              text={prompt.text}
              metadata={prompt.metadata ?? state.promptMetadata}
              fallbackLanguage={state.config.locale}
              showTopic={state.config.showTopicHint !== false}
            />
          )}
        </div>
        <div className="reveal-actions">
          <SourceLink />
          {state.replayToken !== undefined && (
            <button className="secondary-button" type="button" onClick={() => void copyReplay()}>
              <Link2 size={17} />
              {copied ? t("copied") : t("copyReplay")}
            </button>
          )}
          <button className="primary-button" type="button" onClick={exportReplay}>
            <Download size={17} />
            {t("exportReplay")}
          </button>
        </div>
      </header>

      <section className="reveal-chain">
        {state.timeline.map((slot) => {
          const artifact = state.artifacts.find((candidate) => candidate.turnIndex === slot.index);
          return (
            <article className={`reveal-step step-${slot.role}`} key={slot.index}>
              <header>
                <span>{slot.index + 1}</span>
                <strong>{slot.displayName}</strong>
                <small>
                  {slot.role === "draw" ? <Paintbrush size={15} /> : <Search size={15} />}
                  {t(slot.role === "draw" ? "drawing" : "guessing")}
                </small>
              </header>
              {artifact?.kind === "drawing" ? (
                <CanvasBoard commands={artifact.commands} compact />
              ) : artifact?.kind === "guess" ? (
                <blockquote>{artifact.text}</blockquote>
              ) : (
                <p className="empty-artifact">{t("emptyCanvas")}</p>
              )}
            </article>
          );
        })}
      </section>
      {tableActors.length > 0 && (
        <section className="postgame-reviews">
          <header>
            <span>
              <MessageCircleMore size={20} />
              <span>
                <small>{t("afterParty")}</small>
                <h2>{t("aiRoundtable")}</h2>
              </span>
            </span>
            <span className="roundtable-header-actions">
              <strong>
                {settledSeatCount}/{tableActors.length}
              </strong>
              <SettlementButton
                settled={roundtableSettled}
                compact
                onClick={() => setSettlementOpen(true)}
              />
            </span>
          </header>
          <div className="review-conversation">
            {tableActors.map((slot) => {
              const review = reviews.find((candidate) => candidate.seatId === slot.actorId);
              if (slot.actorType === "ai" && review === undefined) return null;
              return (
                <RoundtablePost
                  key={slot.actorId}
                  state={state}
                  slot={slot}
                  review={review}
                  reviews={reviews}
                />
              );
            })}
            {reviews.length < aiSeatCount && replayPayload === undefined && (
              <div className="review-loading" role="status">
                <LoaderCircle className="spin" size={18} />
                {t("aiReviewsLoading")}
              </div>
            )}
            {aiSeatCount > 0 && reviews.length === 0 && replayPayload !== undefined && (
              <p className="muted-copy">{t("noAiReviews")}</p>
            )}
          </div>
          <footer className="settlement-footer">
            <SettlementButton settled={roundtableSettled} onClick={() => setSettlementOpen(true)} />
          </footer>
        </section>
      )}
      {settlementOpen && roundtableSettled && (
        <SettlementModal
          result={tableResult}
          actors={tableActors}
          onClose={() => setSettlementOpen(false)}
        />
      )}
      <footer className="replay-footer">
        <span>{t("replayExpires")}</span>
        <strong>v{state.protocolVersion}</strong>
      </footer>
    </main>
  );
}
