import { z } from "zod";

export const GameModeSchema = z.enum(["ai-theatre", "blind-relay"]);
export const GameLocaleSchema = z.enum(["zh-CN", "en"]);
export const PromptSourceSchema = z.enum(["curated", "custom", "generated"]);
export const IcePolicySchema = z.enum(["all", "relay"]);

export const GameRulesSchema = z
  .object({
    chainLength: z.number().int().min(4).max(12),
    drawSeconds: z.number().int().min(30).max(180),
    guessSeconds: z.number().int().min(15).max(90),
    maxStrokes: z.number().int().min(20).max(120),
    maxUndos: z.number().int().min(0).max(10),
    colorCount: z.number().int().min(4).max(12),
    aiObservationPasses: z.number().int().min(0).max(2),
    aiPlaybackSeconds: z.number().int().min(10).max(45),
    aiRequestTimeoutSeconds: z.number().int().min(30).max(180)
  })
  .strict();

export const DEFAULT_GAME_RULES = GameRulesSchema.parse({
  chainLength: 8,
  drawSeconds: 75,
  guessSeconds: 45,
  maxStrokes: 120,
  maxUndos: 3,
  colorCount: 12,
  aiObservationPasses: 1,
  aiPlaybackSeconds: 12,
  aiRequestTimeoutSeconds: 180
});

export const GameConfigSchema = z
  .object({
    mode: GameModeSchema,
    locale: GameLocaleSchema,
    promptSource: PromptSourceSchema,
    showTopicHint: z.boolean().default(true),
    icePolicy: IcePolicySchema,
    allowSpectators: z.boolean(),
    replayDays: z.number().int().min(1).max(30),
    rules: GameRulesSchema
  })
  .strict();

export const DEFAULT_GAME_CONFIG = GameConfigSchema.parse({
  mode: "ai-theatre",
  locale: "zh-CN",
  promptSource: "curated",
  showTopicHint: true,
  icePolicy: "all",
  allowSpectators: true,
  replayDays: 7,
  rules: DEFAULT_GAME_RULES
});

export function aiPlaybackDurationMs(strokeCount: number, configuredSeconds: number): number {
  if (strokeCount <= 0) return 2_200;
  const count = Math.round(strokeCount);
  const pacedStrokeDuration = Math.max(
    2_500,
    1_800 + Math.min(count, 12) * 350 + Math.max(0, count - 12) * 90
  );
  return Math.min(configuredSeconds * 1_000, pacedStrokeDuration);
}

export type GameMode = z.infer<typeof GameModeSchema>;
export type GameLocale = z.infer<typeof GameLocaleSchema>;
export type PromptSource = z.infer<typeof PromptSourceSchema>;
export type IcePolicy = z.infer<typeof IcePolicySchema>;
export type GameRules = z.infer<typeof GameRulesSchema>;
export type GameConfig = z.infer<typeof GameConfigSchema>;
