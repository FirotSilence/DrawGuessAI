import {
  reviewActionRespectsTargetRole,
  type AiReviewActor,
  type AiSocialAction,
  type AiTurnResult
} from "@drawguessai/ai-adapters";
import type {
  GameArtifact,
  GameState,
  PostGameAction,
  PostGameReview,
  TimelineSlot
} from "@drawguessai/game-core";

function compact(value: string, limit = 80): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function normalizeReviewText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quoted(value: string | undefined): string {
  return value === undefined ? "?" : JSON.stringify(compact(value));
}

function artifactAt(state: GameState, turnIndex: number): GameArtifact | undefined {
  return state.artifacts.find((artifact) => artifact.turnIndex === turnIndex);
}

function incomingText(state: GameState, turnIndex: number): string | undefined {
  if (turnIndex === 0) {
    return state.artifacts.find((artifact) => artifact.kind === "prompt")?.text;
  }
  const artifact = artifactAt(state, turnIndex - 1);
  return artifact?.kind === "guess" ? artifact.text : undefined;
}

function expectedGuessText(state: GameState, turnIndex: number): string | undefined {
  return turnIndex <= 0 ? undefined : incomingText(state, turnIndex - 1);
}

function normalized(value: string | undefined): string {
  return (value ?? "").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function matchMarker(
  expected: string | undefined,
  actual: string | undefined
): "yes" | "no" | "unknown" {
  const normalizedExpected = normalized(expected);
  const normalizedActual = normalized(actual);
  if (normalizedExpected === "" || normalizedActual === "") return "unknown";
  return normalizedExpected === normalizedActual ? "yes" : "no";
}

function uniqueActors(state: GameState): TimelineSlot[] {
  return [...new Map(state.timeline.map((slot) => [slot.actorId, slot] as const)).values()];
}

export function reviewActorsForState(state: Pick<GameState, "timeline">): AiReviewActor[] {
  return [...new Map(state.timeline.map((slot) => [slot.actorId, slot] as const)).values()].map(
    (actor) => ({
      actorId: actor.actorId,
      displayName: actor.displayName,
      actorType: actor.actorType,
      turns: state.timeline
        .filter((slot) => slot.actorId === actor.actorId)
        .map((slot) => ({ index: slot.index, role: slot.role }))
    })
  );
}

export function reviewRoleForActor(
  state: Pick<GameState, "timeline">,
  actorId: string
): "draw" | "guess" | "mixed" {
  const roles = new Set(
    state.timeline.filter((slot) => slot.actorId === actorId).map((slot) => slot.role)
  );
  if (roles.has("draw") && roles.has("guess")) return "mixed";
  return roles.has("guess") ? "guess" : "draw";
}

function roleOwnershipLine(role: "draw" | "guess" | "mixed"): string {
  if (role === "draw") {
    return "ROLE OWNERSHIP: YOU created the drawing; YOU did not make the downstream guess. Never call that guess yours.";
  }
  if (role === "guess") {
    return "ROLE OWNERSHIP: YOU did not create the incoming drawing; YOU only submitted the guess. Never call that drawing yours.";
  }
  return "ROLE OWNERSHIP: YOU had both roles. Use each T-number in YOUR TURNS and never claim another player's drawing or guess.";
}

export function departedReviewText(locale: GameState["config"]["locale"]): string {
  return locale === "zh-CN"
    ? "AI无言以对,已退出房间(掉线/报错)"
    : "AI had nothing to say and left the room (offline/error).";
}

export function isUsablePostGameReviewResult(
  result: AiTurnResult | undefined
): result is AiTurnResult & { status: "ok"; review: NonNullable<AiTurnResult["review"]> } {
  return (
    result?.status === "ok" &&
    result.review !== undefined &&
    result.review.text.trim() !== "" &&
    (result.review.actions?.length ?? 0) > 0
  );
}

function ownTurnLine(state: GameState, slot: TimelineSlot, subject = "YOU"): string {
  const output = artifactAt(state, slot.index);
  if (slot.role === "draw") {
    const next = state.timeline[slot.index + 1];
    const nextOutput = artifactAt(state, slot.index + 1);
    const nextGuess = nextOutput?.kind === "guess" ? nextOutput.text : undefined;
    const input = incomingText(state, slot.index);
    return `T${slot.index + 1} ${subject} drew input=${quoted(input)}; downstream=${next?.displayName ?? "none"} guessed=${quoted(nextGuess)}; MATCH=${matchMarker(input, nextGuess)}`;
  }
  const upstream = state.timeline[slot.index - 1];
  const guess = output?.kind === "guess" ? output.text : undefined;
  const expected = expectedGuessText(state, slot.index);
  return `T${slot.index + 1} ${subject} guessed=${quoted(guess)} from ${upstream?.displayName ?? "unknown"}'s drawing; target=${quoted(expected)}; MATCH=${matchMarker(expected, guess)}`;
}

function directHumanLinkLines(state: GameState, actorId: string): string[] {
  return state.timeline
    .filter((slot) => slot.actorId === actorId)
    .flatMap((slot) => {
      if (slot.role === "draw") {
        const human = state.timeline[slot.index + 1];
        if (human?.actorType !== "human") return [];
        const guessArtifact = artifactAt(state, human.index);
        const guess = guessArtifact?.kind === "guess" ? guessArtifact.text : undefined;
        const target = incomingText(state, slot.index);
        return [
          `T${slot.index + 1} DOWNSTREAM HUMAN actorId=${human.actorId} name=${JSON.stringify(human.displayName)} guessed=${quoted(guess)} from YOUR drawing; target=${quoted(target)}; MATCH=${matchMarker(target, guess)}`
        ];
      }
      const human = state.timeline[slot.index - 1];
      if (human?.actorType !== "human") return [];
      const guessArtifact = artifactAt(state, slot.index);
      const guess = guessArtifact?.kind === "guess" ? guessArtifact.text : undefined;
      const target = expectedGuessText(state, slot.index);
      return [
        `T${slot.index + 1} UPSTREAM HUMAN actorId=${human.actorId} name=${JSON.stringify(human.displayName)} drew the attached handoff; YOU guessed=${quoted(guess)}; target=${quoted(target)}; MATCH=${matchMarker(target, guess)}`
      ];
    });
}

function handoffLines(state: GameState): string[] {
  return state.timeline.flatMap((drawer) => {
    if (drawer.role !== "draw") return [];
    const guesser = state.timeline[drawer.index + 1];
    if (guesser?.role !== "guess") return [];
    const input = incomingText(state, drawer.index);
    const guessArtifact = artifactAt(state, guesser.index);
    const guess = guessArtifact?.kind === "guess" ? guessArtifact.text : undefined;
    return [
      `T${drawer.index + 1} DRAW actorId=${drawer.actorId} name=${JSON.stringify(drawer.displayName)} input=${quoted(input)} -> T${guesser.index + 1} GUESS actorId=${guesser.actorId} name=${JSON.stringify(guesser.displayName)} output=${quoted(guess)} MATCH=${matchMarker(input, guess)}`
    ];
  });
}

function fitWholeLines(lines: readonly string[], limit = 5_600): string {
  const accepted: string[] = [];
  let length = 0;
  for (const line of lines) {
    const nextLength = length + line.length + (accepted.length === 0 ? 0 : 1);
    if (nextLength > limit) continue;
    accepted.push(line);
    length = nextLength;
  }
  return accepted.join("\n");
}

export function humanDrawingForReviewer(
  state: Pick<GameState, "timeline" | "artifacts">,
  actorId: string
): { slot: TimelineSlot; artifact: Extract<GameArtifact, { kind: "drawing" }> } | undefined {
  for (const reviewerTurn of state.timeline) {
    if (reviewerTurn.actorId !== actorId || reviewerTurn.role !== "guess") continue;
    const humanSlot = state.timeline[reviewerTurn.index - 1];
    if (humanSlot?.actorType !== "human" || humanSlot.role !== "draw") continue;
    const artifact = state.artifacts.find(
      (candidate) =>
        candidate.kind === "drawing" &&
        candidate.turnIndex === humanSlot.index &&
        candidate.actorId === humanSlot.actorId
    );
    if (artifact?.kind === "drawing") return { slot: humanSlot, artifact };
  }
  return undefined;
}

export function buildPostGameReviewContext(
  state: GameState,
  actorId: string,
  reviews: readonly PostGameReview[]
): string {
  const prompt = state.artifacts.find((artifact) => artifact.kind === "prompt");
  const finalArtifact = state.artifacts.at(-1);
  const originalPrompt = prompt?.kind === "prompt" ? prompt.text : undefined;
  const metadata =
    prompt?.kind === "prompt" ? (prompt.metadata ?? state.promptMetadata) : undefined;
  const reviewRole = reviewRoleForActor(state, actorId);
  const players = uniqueActors(state).map((slot) => {
    const turns = state.timeline
      .filter((turn) => turn.actorId === slot.actorId)
      .map((turn) => `T${turn.index + 1}:${turn.role}`)
      .join(",");
    return [
      `actorId=${slot.actorId}`,
      `name=${JSON.stringify(slot.displayName)}`,
      `actorType=${slot.actorType}`,
      `roles=${turns}`,
      slot.actorId === actorId ? "YOU" : ""
    ]
      .filter(Boolean)
      .join(",");
  });
  const ownTurns = state.timeline
    .filter((slot) => slot.actorId === actorId)
    .map((slot) => ownTurnLine(state, slot));
  const humanTurns = uniqueActors(state)
    .filter((slot) => slot.actorType === "human")
    .flatMap((actor) =>
      state.timeline
        .filter((slot) => slot.actorId === actor.actorId)
        .map((slot) => `${actor.actorId}/${actor.displayName}: ${ownTurnLine(state, slot, "THEY")}`)
    );
  const directHumanLinks = directHumanLinkLines(state, actorId);
  const earlier = reviews
    .filter((review) => review.status !== "departed")
    .map((review) => {
      const actions = (review.actions ?? [])
        .map(
          (action) =>
            `${action.reaction}->${action.targetSeatId}${action.targetTurnIndex === undefined ? "" : `@T${action.targetTurnIndex + 1}`}`
        )
        .join(",");
      return `${review.seatId}/${review.displayName}: ${compact(review.text, 48)}${actions === "" ? "" : ` [${actions}]`}`;
    });
  const finalResult =
    finalArtifact?.kind === "guess"
      ? finalArtifact.text
      : finalArtifact?.kind === "drawing"
        ? (incomingText(state, finalArtifact.turnIndex) ?? "[final drawing]")
        : "?";

  const handoffs = handoffLines(state);
  return fitWholeLines([
    `SELF_ACTOR_ID=${actorId}`,
    `SELF ROLE: ${reviewRole === "draw" ? "DRAWER" : reviewRole === "guess" ? "GUESSER" : "MIXED DRAWER AND GUESSER"}`,
    roleOwnershipLine(reviewRole),
    "PLAYERS:",
    ...players,
    `ORIGINAL PROMPT: ${quoted(originalPrompt)}`,
    ...(metadata === undefined
      ? []
      : [
          `TAGS: language=${metadata.language}; type=${metadata.kind}; length=${metadata.length}${state.config.showTopicHint !== false && metadata.topic !== undefined ? `; subject=${metadata.topic}` : ""}`
        ]),
    `FINAL RESULT: ${quoted(finalResult)}`,
    `START-TO-FINAL MATCH=${matchMarker(originalPrompt, finalResult)}`,
    "HANDOFFS:",
    ...(handoffs.length === 0 ? ["none"] : handoffs),
    `YOUR TURNS: ${ownTurns.length === 0 ? "none" : ownTurns.join(" | ")}`,
    `DIRECT HUMAN LINKS: ${directHumanLinks.length === 0 ? "none" : directHumanLinks.join(" | ")}`,
    ...(humanTurns.length === 0 ? [] : [`HUMAN PARTICIPATION: ${humanTurns.join(" | ")}`]),
    ...(earlier.length === 0 ? [] : [`EARLIER TABLE TALK: ${earlier.join(" | ")}`])
  ]);
}

function contributionMatch(state: GameState, slot: TimelineSlot): "yes" | "no" | "unknown" {
  if (slot.role === "draw") {
    const guessArtifact = artifactAt(state, slot.index + 1);
    const guess = guessArtifact?.kind === "guess" ? guessArtifact.text : undefined;
    return matchMarker(incomingText(state, slot.index), guess);
  }
  const guessArtifact = artifactAt(state, slot.index);
  const guess = guessArtifact?.kind === "guess" ? guessArtifact.text : undefined;
  return matchMarker(expectedGuessText(state, slot.index), guess);
}

export function resolvePostGameActions(
  state: GameState,
  actorId: string,
  requested: readonly AiSocialAction[] | undefined
): PostGameAction[] {
  const actors = uniqueActors(state);
  if (requested === undefined || requested.length === 0) return [];
  const actions: PostGameAction[] = [];
  const seen = new Set<string>();
  for (const action of requested ?? []) {
    const target = actors.find((actor) => actor.actorId === action.targetActorId);
    if (target === undefined || target.actorId === actorId || seen.has(target.actorId)) continue;
    const targetTurns = state.timeline.filter((slot) => slot.actorId === target.actorId);
    const targetTurn =
      action.targetTurnIndex === undefined
        ? targetTurns.length === 1
          ? targetTurns[0]
          : undefined
        : targetTurns.find((slot) => slot.index === action.targetTurnIndex);
    if (targetTurn === undefined || !reviewActionRespectsTargetRole(action.text, targetTurn.role)) {
      continue;
    }
    seen.add(target.actorId);
    if (
      contributionMatch(state, targetTurn) !== "yes" &&
      (action.kind === "applause" || action.kind === "heart" || action.kind === "spark")
    ) {
      continue;
    }
    actions.push({
      targetSeatId: target.actorId,
      targetDisplayName: target.displayName,
      targetTurnIndex: targetTurn.index,
      reaction: action.kind,
      text: compact(action.text, 80)
    });
    if (actions.length === 3) break;
  }
  if (actions.length > 0) return actions;
  return [];
}
