import {
  createPromptMetadata,
  type GameLocale,
  type PromptKind,
  type PromptMetadata
} from "@drawguessai/game-core";
import { Languages, Shapes, Tags } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PROMPT_TOPIC_KEYS } from "../lib/prompt-topics";

const kindKeys: Record<PromptKind, string> = {
  word: "promptKindWord",
  phrase: "promptKindPhrase",
  idiom: "promptKindIdiom",
  proverb: "promptKindProverb",
  "poem-line": "promptKindPoemLine",
  xiehouyu: "promptKindXiehouyu"
};

export function PromptTags({
  text,
  metadata,
  fallbackLanguage,
  showTopic = true
}: {
  text: string;
  metadata: PromptMetadata | undefined;
  fallbackLanguage: GameLocale;
  showTopic?: boolean;
}) {
  const { t } = useTranslation();
  const resolved = metadata ?? createPromptMetadata(text, fallbackLanguage);
  const kind = t(kindKeys[resolved.kind]);
  const typeLabel =
    resolved.language === "zh-CN"
      ? t("promptTypeChinese", { length: resolved.length, kind })
      : resolved.kind === "word"
        ? kind
        : t("promptTypeEnglish", { length: resolved.length, kind });

  return (
    <span className="prompt-tags" aria-label={t("promptTags")}>
      <span>
        <Languages size={13} />
        {t(resolved.language === "zh-CN" ? "promptLanguageChinese" : "promptLanguageEnglish")}
      </span>
      <span>
        <Tags size={13} />
        {typeLabel}
      </span>
      {showTopic && resolved.topic !== undefined && (
        <span>
          <Shapes size={13} />
          {t(PROMPT_TOPIC_KEYS[resolved.topic])}
        </span>
      )}
    </span>
  );
}
