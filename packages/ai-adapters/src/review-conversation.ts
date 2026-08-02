import type { PostGameReview } from "@drawguessai/game-core";

const RECENT_SPEAKER_LIMIT = 7;
const DIRECTED_LINE_LIMIT = 4;

function compact(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function actorId(value: string): string {
  return compact(value, 80);
}

export function buildReviewConversationContext(
  reviews: readonly PostGameReview[],
  reviewerActorId: string
): string[] {
  const published = reviews.filter((review) => review.status !== "departed");
  if (published.length === 0) {
    return ["CONVERSATION POSITION: opening speaker; no earlier table talk."];
  }

  const recentOffset = Math.max(0, published.length - RECENT_SPEAKER_LIMIT);
  const recent = published.slice(recentOffset);
  const latest = published.at(-1)!;
  const speakerLines = recent.map((review, index) => {
    const replyTarget = published.find((candidate) => candidate.seatId === review.replyToSeatId);
    const reply =
      replyTarget === undefined
        ? ""
        : ` replyingTo actorId=${actorId(replyTarget.seatId)} name=${JSON.stringify(compact(replyTarget.displayName, 40))}`;
    return `S${recentOffset + index + 1} actorId=${actorId(review.seatId)} name=${JSON.stringify(compact(review.displayName, 40))}${reply} said=${JSON.stringify(compact(review.text, 120))}`;
  });
  const directedLines = published
    .flatMap((review) =>
      (review.actions ?? [])
        .filter((action) => action.targetSeatId === reviewerActorId)
        .map((action) => ({ review, action }))
    )
    .slice(-DIRECTED_LINE_LIMIT)
    .map(({ review, action }) => {
      const turn =
        action.targetTurnIndex === undefined ? "at your turn" : `at T${action.targetTurnIndex + 1}`;
      return `from actorId=${actorId(review.seatId)} name=${JSON.stringify(compact(review.displayName, 40))} ${turn}: ${JSON.stringify(compact(action.text, 100))} [${action.reaction}]`;
    });

  return [
    `CONVERSATION POSITION: speaker ${published.length + 1} after ${published.length} earlier speaker${published.length === 1 ? "" : "s"}.`,
    `LATEST SPEAKER: actorId=${actorId(latest.seatId)} name=${JSON.stringify(compact(latest.displayName, 40))}`,
    "EARLIER TABLE TALK (oldest to newest):",
    ...speakerLines,
    ...(directedLines.length === 0
      ? []
      : ["DIRECTED AT YOU (these are open conversational hooks):", ...directedLines])
  ];
}
