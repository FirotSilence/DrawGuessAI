import type {
  GameArtifact,
  GameState,
  PostGameReview,
  QuickReaction,
  TimelineSlot
} from "@drawguessai/game-core";

export interface TurnContribution {
  slot: TimelineSlot;
  input: GameArtifact;
  output: GameArtifact;
}

export interface ReceivedPostGameReaction {
  fromSeatId: string;
  fromDisplayName: string;
  reaction: QuickReaction;
  text: string;
}

export interface RoundtablePlayerResult {
  seatId: string;
  displayName: string;
  positive: number;
  negative: number;
  neutral: number;
  net: number;
  received: number;
  reactions: Record<QuickReaction, number>;
}

export interface RoundtableInteractionSource {
  id: string;
  channel: "review" | "live";
  fromSeatId: string;
  fromDisplayName: string;
  targetSeatId: string;
  targetDisplayName: string;
  reaction: QuickReaction;
  text: string | undefined;
  weight: number;
}

export interface RoundtableRatingSource {
  seatId: string;
  displayName: string;
  score: number;
}

export interface RoundtableResult {
  best: RoundtablePlayerResult | undefined;
  worst: RoundtablePlayerResult | undefined;
  overallScore: number | undefined;
  totalInteractions: number;
  positiveInteractions: number;
  negativeInteractions: number;
  interactions: RoundtableInteractionSource[];
  ratings: RoundtableRatingSource[];
}

const REACTION_WEIGHTS: Record<QuickReaction, number> = {
  applause: 2,
  heart: 2,
  spark: 1,
  laugh: 0,
  confused: -1,
  egg: -2
};

const POSITIVE_REACTIONS = new Set<QuickReaction>(["applause", "heart", "spark"]);
const NEGATIVE_REACTIONS = new Set<QuickReaction>(["egg", "confused"]);

function emptyReactionCounts(): Record<QuickReaction, number> {
  return { applause: 0, egg: 0, laugh: 0, confused: 0, spark: 0, heart: 0 };
}

export function roundtableActors(state: Pick<GameState, "timeline">): TimelineSlot[] {
  return [...new Map(state.timeline.map((slot) => [slot.actorId, slot] as const)).values()];
}

export function contributionForActor(
  state: Pick<GameState, "timeline" | "artifacts">,
  actorId: string
): TurnContribution | undefined {
  const slot = state.timeline.find((candidate) => candidate.actorId === actorId);
  if (slot === undefined) return undefined;
  const input = state.artifacts.find((artifact) =>
    slot.index === 0 ? artifact.kind === "prompt" : artifact.turnIndex === slot.index - 1
  );
  const output = state.artifacts.find((artifact) => artifact.turnIndex === slot.index);
  if (input === undefined || output === undefined) return undefined;
  return { slot, input, output };
}

export function receivedPostGameReactions(
  reviews: readonly PostGameReview[],
  targetSeatId: string
): ReceivedPostGameReaction[] {
  return reviews.flatMap((review) =>
    (review.actions ?? [])
      .filter((action) => action.targetSeatId === targetSeatId)
      .map((action) => ({
        fromSeatId: review.seatId,
        fromDisplayName: review.displayName,
        reaction: action.reaction,
        text: action.text
      }))
  );
}

export function roundtableResult(
  state: Pick<GameState, "timeline" | "reactions">,
  reviews: readonly PostGameReview[]
): RoundtableResult {
  const actors = roundtableActors(state);
  const tallies = new Map(
    actors.map((actor) => [
      actor.actorId,
      {
        seatId: actor.actorId,
        displayName: actor.displayName,
        positive: 0,
        negative: 0,
        neutral: 0,
        net: 0,
        received: 0,
        reactions: emptyReactionCounts()
      } satisfies RoundtablePlayerResult
    ])
  );
  const actorById = new Map(actors.map((actor) => [actor.actorId, actor]));
  const interactions: RoundtableInteractionSource[] = [];
  let totalWeight = 0;
  const receive = (source: Omit<RoundtableInteractionSource, "targetDisplayName" | "weight">) => {
    const tally = tallies.get(source.targetSeatId);
    if (tally === undefined) return;
    tally.received += 1;
    tally.reactions[source.reaction] += 1;
    const weight = REACTION_WEIGHTS[source.reaction];
    tally.net += weight;
    totalWeight += weight;
    if (POSITIVE_REACTIONS.has(source.reaction)) tally.positive += 1;
    else if (NEGATIVE_REACTIONS.has(source.reaction)) tally.negative += 1;
    else tally.neutral += 1;
    interactions.push({
      ...source,
      targetDisplayName: tally.displayName,
      weight
    });
  };

  for (const review of reviews) {
    if (review.status === "departed") continue;
    for (const [index, action] of (review.actions ?? []).entries()) {
      receive({
        id: `${review.id}:action:${index}`,
        channel: "review",
        fromSeatId: review.seatId,
        fromDisplayName: review.displayName,
        targetSeatId: action.targetSeatId,
        reaction: action.reaction,
        text: action.text
      });
    }
  }
  const actorIds = new Set(actors.map((actor) => actor.actorId));
  for (const reaction of state.reactions) {
    const activeActor = state.timeline[reaction.turnIndex];
    const reactingActor = actorById.get(reaction.actorId);
    if (
      activeActor === undefined ||
      reactingActor === undefined ||
      activeActor.actorId === reaction.actorId ||
      !actorIds.has(reaction.actorId)
    ) {
      continue;
    }
    receive({
      id: reaction.id,
      channel: "live",
      fromSeatId: reaction.actorId,
      fromDisplayName: reactingActor.displayName,
      targetSeatId: activeActor.actorId,
      reaction: reaction.reaction,
      text: reaction.text
    });
  }

  const values = [...tallies.values()];
  const actorOrder = new Map(actors.map((actor, index) => [actor.actorId, index]));
  const interacted = values.filter((value) => value.received > 0);
  const best = [...interacted].sort(
    (left, right) =>
      right.net - left.net ||
      right.positive - left.positive ||
      left.negative - right.negative ||
      right.received - left.received ||
      actorOrder.get(left.seatId)! - actorOrder.get(right.seatId)!
  )[0];
  const worst = [...interacted].sort(
    (left, right) =>
      left.net - right.net ||
      right.negative - left.negative ||
      left.positive - right.positive ||
      right.received - left.received ||
      actorOrder.get(right.seatId)! - actorOrder.get(left.seatId)!
  )[0];
  const totalInteractions = values.reduce((sum, value) => sum + value.received, 0);
  const ratings = reviews
    .filter((review) => review.status !== "departed")
    .map((review) => ({
      seatId: review.seatId,
      displayName: review.displayName,
      score: review.score
    }));
  const generatedScores = ratings.map((rating) => rating.score);
  const reviewerScore =
    generatedScores.length === 0
      ? undefined
      : (generatedScores.reduce((sum, score) => sum + score, 0) / generatedScores.length) * 2;
  const interactionScore =
    totalInteractions === 0
      ? undefined
      : Math.max(0, Math.min(10, 5 + (totalWeight / totalInteractions) * 2.5));
  const overallScore =
    reviewerScore === undefined
      ? interactionScore
      : interactionScore === undefined
        ? reviewerScore
        : reviewerScore * 0.65 + interactionScore * 0.35;

  return {
    best,
    worst,
    overallScore: overallScore === undefined ? undefined : Math.round(overallScore * 10) / 10,
    totalInteractions,
    positiveInteractions: values.reduce((sum, value) => sum + value.positive, 0),
    negativeInteractions: values.reduce((sum, value) => sum + value.negative, 0),
    interactions,
    ratings
  };
}
