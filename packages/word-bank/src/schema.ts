import { PromptTopicSchema } from "@drawguessai/game-core";
import { z } from "zod";

export const PromptCategorySchema = z.enum([
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
  "idioms",
  "proverbs",
  "poem-lines",
  "xiehouyu"
]);

export const PromptDifficultySchema = z.enum(["easy", "medium", "hard"]);

export const PromptEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    texts: z
      .object({
        "zh-CN": z.string().min(1).max(16),
        en: z.string().min(2).max(80)
      })
      .strict(),
    category: PromptCategorySchema,
    topic: PromptTopicSchema,
    difficulty: PromptDifficultySchema,
    drawability: z.number().int().min(1).max(5),
    ambiguity: z.number().int().min(1).max(5),
    aiTriviality: z.number().int().min(1).max(5),
    cultureTags: z.array(z.string().min(1).max(30)).max(6),
    safety: z.literal("all-ages"),
    source: z.enum(["curated", "generated"]),
    version: z.number().int().positive()
  })
  .strict();

export type PromptCategory = z.infer<typeof PromptCategorySchema>;
export type PromptDifficulty = z.infer<typeof PromptDifficultySchema>;
export type PromptEntry = z.infer<typeof PromptEntrySchema>;
