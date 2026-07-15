import type { QuickReaction } from "@drawguessai/game-core";

export type ReactionTone = "positive" | "negative" | "neutral";

export function reactionTone(reaction: QuickReaction): ReactionTone {
  if (reaction === "applause" || reaction === "heart" || reaction === "spark") {
    return "positive";
  }
  if (reaction === "egg" || reaction === "confused") return "negative";
  return "neutral";
}
