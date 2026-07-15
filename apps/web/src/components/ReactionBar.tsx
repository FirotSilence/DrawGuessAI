import type { QuickReaction } from "@drawguessai/game-core";
import { CircleHelp, Egg, Hand, Heart, Laugh, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { reactionTone } from "../lib/reaction-tone";

const REACTIONS: readonly [QuickReaction, typeof Hand, string][] = [
  ["applause", Hand, "reactionApplause"],
  ["egg", Egg, "reactionEgg"],
  ["laugh", Laugh, "reactionLaugh"],
  ["confused", CircleHelp, "reactionConfused"],
  ["spark", Sparkles, "reactionSpark"],
  ["heart", Heart, "reactionHeart"]
];

export function ReactionIcon({ reaction, size = 18 }: { reaction: QuickReaction; size?: number }) {
  const Icon = REACTIONS.find(([candidate]) => candidate === reaction)?.[1] ?? CircleHelp;
  return <Icon size={size} />;
}

export function ReactionBar({ onReact }: { onReact: (reaction: QuickReaction) => void }) {
  const { t } = useTranslation();
  return (
    <div className="reaction-bar">
      {REACTIONS.map(([reaction, Icon, label]) => (
        <button
          key={reaction}
          className={`reaction-button reaction-tone-${reactionTone(reaction)}`}
          type="button"
          title={t(label)}
          aria-label={t(label)}
          onClick={() => onReact(reaction)}
        >
          <Icon size={18} />
        </button>
      ))}
    </div>
  );
}
