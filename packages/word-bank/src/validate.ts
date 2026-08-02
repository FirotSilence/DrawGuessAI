import { PROMPT_TOPICS, type PromptTopic } from "@drawguessai/game-core";

import { WORD_BANK } from "./bank";
import { validateAllAgesText, validatePlayablePromptText } from "./safety";
import { PromptEntrySchema, type PromptCategory, type PromptDifficulty } from "./schema";

export interface BankReport {
  valid: boolean;
  total: number;
  categories: Record<PromptCategory, number>;
  difficulties: Record<PromptDifficulty, number>;
  topics: Record<PromptTopic, number>;
  duplicateIds: string[];
  duplicateTexts: string[];
  invalidEntries: string[];
}

const CATEGORIES: readonly PromptCategory[] = [
  "objects",
  "animals",
  "actions",
  "daily-scenes",
  "people-at-work",
  "nature-weather",
  "sports",
  "food-scenes",
  "transport-travel",
  "festivals-culture",
  "places",
  "idioms",
  "proverbs",
  "poem-lines",
  "xiehouyu"
];

export function validateWordBank(): BankReport {
  const categories = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
    PromptCategory,
    number
  >;
  const difficulties: Record<PromptDifficulty, number> = { easy: 0, medium: 0, hard: 0 };
  const topics = Object.fromEntries(PROMPT_TOPICS.map((topic) => [topic, 0])) as Record<
    PromptTopic,
    number
  >;
  const ids = new Set<string>();
  const texts = new Set<string>();
  const duplicateIds: string[] = [];
  const duplicateTexts: string[] = [];
  const invalidEntries = new Set<string>();

  for (const entry of WORD_BANK) {
    const englishIsValid =
      entry.kind === "poem-line"
        ? validateAllAgesText(entry.texts.en).ok
        : validatePlayablePromptText(entry.texts.en, entry.kind, "en").ok;
    if (
      !PromptEntrySchema.safeParse(entry).success ||
      !validatePlayablePromptText(entry.texts["zh-CN"], entry.kind, "zh-CN").ok ||
      !englishIsValid
    ) {
      invalidEntries.add(entry.id);
    }
    if (ids.has(entry.id)) duplicateIds.push(entry.id);
    ids.add(entry.id);
    for (const text of [entry.texts["zh-CN"], entry.texts.en.toLowerCase()]) {
      if (texts.has(text)) duplicateTexts.push(text);
      texts.add(text);
    }
    categories[entry.category] += 1;
    difficulties[entry.difficulty] += 1;
    topics[entry.topic] += 1;
  }

  return {
    valid:
      WORD_BANK.length >= 400 &&
      Object.values(categories).every((count) => count > 0) &&
      duplicateIds.length === 0 &&
      duplicateTexts.length === 0 &&
      invalidEntries.size === 0,
    total: WORD_BANK.length,
    categories,
    difficulties,
    topics,
    duplicateIds,
    duplicateTexts,
    invalidEntries: [...invalidEntries]
  };
}
