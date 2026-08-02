import { describe, expect, it } from "vitest";

import {
  PlayablePromptKindSchema,
  selectPrompt,
  validateAllAgesText,
  validatePlayablePromptText,
  validateWordBank,
  WORD_BANK
} from "../src";

describe("word bank", () => {
  it("contains a balanced bilingual set", () => {
    const report = validateWordBank();
    expect(report.valid).toBe(true);
    expect(report.total).toBe(555);
    expect(Object.keys(report.categories)).toHaveLength(15);
    expect(Object.values(report.categories).every((count) => count >= 35)).toBe(true);
    expect(report.difficulties).toEqual({ easy: 112, medium: 278, hard: 165 });
    expect(Object.values(report.topics).reduce((total, count) => total + count, 0)).toBe(555);
    expect(report.topics.fruit).toBeGreaterThan(0);
    expect(report.topics.person).toBeGreaterThan(35);
    expect(report.topics.history).toBeGreaterThan(0);
    expect(report.duplicateTexts).toEqual([]);
    for (const entry of WORD_BANK) {
      expect(entry.texts["zh-CN"].length).toBeLessThanOrEqual(16);
      const englishWords = entry.texts.en.trim().split(/\s+/).length;
      expect(englishWords).toBeGreaterThan(0);
      expect(englishWords).toBeLessThanOrEqual(12);
      expect(entry.texts["zh-CN"]).not.toMatch(/[。！？]$/);
      expect(entry.texts.en).not.toMatch(/[.!?]$/);
      expect(entry.topic).toBeTruthy();
      expect(validatePlayablePromptText(entry.texts["zh-CN"], entry.kind, "zh-CN").ok).toBe(true);
      if (entry.kind === "poem-line") {
        expect(validatePlayablePromptText(entry.texts.en, entry.kind, "en")).toEqual({
          ok: false,
          reason: "unsupported-kind"
        });
      } else {
        expect(validatePlayablePromptText(entry.texts.en, entry.kind, "en").ok).toBe(true);
      }
    }
  });

  it("uses common compact concepts instead of generated sentences", () => {
    const chinese = new Set<string>();
    const english = new Set<string>();
    for (const entry of WORD_BANK) {
      expect(chinese.has(entry.texts["zh-CN"])).toBe(false);
      expect(english.has(entry.texts.en.toLowerCase())).toBe(false);
      chinese.add(entry.texts["zh-CN"]);
      english.add(entry.texts.en.toLowerCase());
    }
    expect(WORD_BANK.filter((entry) => entry.category === "idioms")).toHaveLength(50);
    expect(WORD_BANK.filter((entry) => entry.category === "proverbs")).toHaveLength(50);
    expect(WORD_BANK.filter((entry) => entry.category === "places")).toHaveLength(35);
    expect(WORD_BANK.filter((entry) => entry.category === "poem-lines")).toHaveLength(35);
    expect(WORD_BANK.filter((entry) => entry.category === "xiehouyu")).toHaveLength(35);
    expect(PlayablePromptKindSchema.safeParse("poem-line").success).toBe(true);
  });

  it("includes familiar Chinese cultural forms with explicit labels", () => {
    const entriesByText = new Map(WORD_BANK.map((entry) => [entry.texts["zh-CN"], entry]));
    const expected = [
      ["愚公移山", "idioms", "idiom"],
      ["瑞雪兆丰年", "proverbs", "proverb"],
      ["床前明月光", "poem-lines", "classical-poetry"],
      ["八仙过海，各显神通", "xiehouyu", "xiehouyu"]
    ] as const;

    for (const [text, category, cultureTag] of expected) {
      const entry = entriesByText.get(text);
      expect(entry?.category).toBe(category);
      expect(entry?.cultureTags).toContain(cultureTag);
    }
  });

  it("selects deterministically while avoiding recent prompts", () => {
    const first = selectPrompt({ seed: "same", locale: "zh-CN" });
    const second = selectPrompt({ seed: "same", locale: "zh-CN" });
    expect(second.id).toBe(first.id);
    expect(selectPrompt({ seed: "same", locale: "zh-CN", recentIds: [first.id] }).id).not.toBe(
      first.id
    );
  });

  it("offers common poem lines only for Chinese prompts", () => {
    const chineseSelections = Array.from({ length: 1_000 }, (_, index) =>
      selectPrompt({ seed: `zh-${index}`, locale: "zh-CN" })
    );
    const englishSelections = Array.from({ length: 1_000 }, (_, index) =>
      selectPrompt({ seed: `en-${index}`, locale: "en" })
    );
    expect(chineseSelections.some((entry) => entry.kind === "poem-line")).toBe(true);
    expect(englishSelections.every((entry) => entry.kind !== "poem-line")).toBe(true);
  });

  it("blocks unsafe custom text", () => {
    expect(validateAllAgesText("一座会唱歌的城市").ok).toBe(true);
    expect(validateAllAgesText("色情内容")).toEqual({ ok: false, reason: "blocked" });
    expect(validatePlayablePromptText("守株待兔", "idiom", "zh-CN").ok).toBe(true);
    expect(validatePlayablePromptText("狗拿耗子，多管闲事", "xiehouyu", "zh-CN").ok).toBe(true);
    expect(validatePlayablePromptText("猫", "word", "zh-CN").ok).toBe(true);
    expect(validatePlayablePromptText("被子", "word", "zh-CN").ok).toBe(true);
    expect(validatePlayablePromptText("门把手", "word", "zh-CN").ok).toBe(true);
    expect(validatePlayablePromptText("等公交", "phrase", "zh-CN").ok).toBe(true);
    expect(validatePlayablePromptText("床前明月光", "poem-line", "zh-CN").ok).toBe(true);
    expect(validatePlayablePromptText("moonlight before my bed", "poem-line", "en")).toEqual({
      ok: false,
      reason: "unsupported-kind"
    });
    expect(validatePlayablePromptText("雨伞被风吹走", "phrase")).toEqual({
      ok: false,
      reason: "too-complex"
    });
    expect(validatePlayablePromptText("做饭烧糊了", "phrase")).toEqual({
      ok: false,
      reason: "too-complex"
    });
    expect(validatePlayablePromptText("一只猫在窗边睡觉", "phrase")).toEqual({
      ok: false,
      reason: "too-complex"
    });
    expect(validatePlayablePromptText("a cat is sleeping by window", "phrase")).toEqual({
      ok: false,
      reason: "too-complex"
    });
    expect(
      validatePlayablePromptText(
        "这是一个写得很长很复杂而且几乎没有合理猜测空间的完整句子。",
        "phrase"
      )
    ).toEqual({ ok: false, reason: "too-long" });
  });
});
