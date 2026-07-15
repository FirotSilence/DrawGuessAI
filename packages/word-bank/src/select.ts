import { WORD_BANK } from "./bank";
import type { PromptDifficulty, PromptEntry } from "./schema";

export interface SelectPromptOptions {
  seed: string;
  recentIds?: readonly string[];
  difficulty?: PromptDifficulty | "mixed";
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function selectPrompt(options: SelectPromptOptions): PromptEntry {
  const recent = new Set(options.recentIds ?? []);
  const matching = WORD_BANK.filter(
    (entry) =>
      !recent.has(entry.id) &&
      (options.difficulty === undefined ||
        options.difficulty === "mixed" ||
        entry.difficulty === options.difficulty)
  );
  const candidates = matching.length > 0 ? matching : WORD_BANK;
  return candidates[hashSeed(options.seed) % candidates.length]!;
}
