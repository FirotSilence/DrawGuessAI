import type { QuickReaction } from "@drawguessai/game-core";
import {
  CircleHelp,
  Frown,
  Heart,
  Laugh,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  type LucideIcon
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { reactionTone } from "../lib/reaction-tone";

interface ReactionDefinition {
  reaction: QuickReaction;
  Icon: LucideIcon;
  label: string;
}

const REACTIONS: readonly ReactionDefinition[] = [
  { reaction: "applause", Icon: ThumbsUp, label: "reactionApplause" },
  { reaction: "heart", Icon: Heart, label: "reactionHeart" },
  { reaction: "spark", Icon: Sparkles, label: "reactionSpark" },
  { reaction: "laugh", Icon: Laugh, label: "reactionLaugh" },
  { reaction: "confused", Icon: Frown, label: "reactionConfused" },
  { reaction: "egg", Icon: ThumbsDown, label: "reactionEgg" }
];

const REACTION_BY_KIND = new Map(REACTIONS.map((definition) => [definition.reaction, definition]));

export function ReactionIcon({ reaction, size = 18 }: { reaction: QuickReaction; size?: number }) {
  const Icon = REACTION_BY_KIND.get(reaction)?.Icon ?? CircleHelp;
  return (
    <Icon
      aria-hidden="true"
      className={`reaction-icon reaction-icon-${reaction}`}
      size={size}
      strokeWidth={2.5}
    />
  );
}

export function ReactionSentiment({
  reaction,
  size = 18
}: {
  reaction: QuickReaction;
  size?: number;
}) {
  const { t } = useTranslation();
  const tone = reactionTone(reaction);
  const reactionLabel = t(REACTION_BY_KIND.get(reaction)?.label ?? "reactionConfused");

  return (
    <span
      className={`reaction-sentiment reaction-tone-${tone}`}
      title={reactionLabel}
      role="img"
      aria-label={reactionLabel}
    >
      <span className="reaction-sentiment-icon" aria-hidden="true">
        <ReactionIcon reaction={reaction} size={size} />
      </span>
      <span className="reaction-sentiment-copy" aria-hidden="true">
        <span className="reaction-sentiment-kind">{reactionLabel}</span>
      </span>
    </span>
  );
}

export function ReactionBar({ onReact }: { onReact: (reaction: QuickReaction) => void }) {
  const { t } = useTranslation();
  return (
    <div className="reaction-bar">
      {REACTIONS.map(({ reaction, label }) => {
        const tone = reactionTone(reaction);
        const accessibleLabel = t(label);
        return (
          <button
            key={reaction}
            className={`reaction-button reaction-tone-${tone}`}
            type="button"
            title={accessibleLabel}
            aria-label={accessibleLabel}
            data-reaction={reaction}
            data-tone={tone}
            onClick={() => onReact(reaction)}
          >
            <ReactionIcon reaction={reaction} size={20} />
          </button>
        );
      })}
    </div>
  );
}
