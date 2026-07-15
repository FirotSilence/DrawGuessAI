import { describe, expect, it } from "vitest";

import {
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
    expect(report.total).toBe(520);
    expect(Object.keys(report.categories)).toHaveLength(14);
    expect(Object.values(report.categories).every((count) => count >= 35)).toBe(true);
    expect(report.difficulties).toEqual({ easy: 104, medium: 260, hard: 156 });
    expect(Object.values(report.topics).reduce((total, count) => total + count, 0)).toBe(520);
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
    expect(WORD_BANK.filter((entry) => entry.category === "poem-lines")).toHaveLength(35);
    expect(WORD_BANK.filter((entry) => entry.category === "xiehouyu")).toHaveLength(35);
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
    const first = selectPrompt({ seed: "same" });
    const second = selectPrompt({ seed: "same" });
    expect(second.id).toBe(first.id);
    expect(selectPrompt({ seed: "same", recentIds: [first.id] }).id).not.toBe(first.id);
  });

  it("blocks unsafe custom text", () => {
    expect(validateAllAgesText("一座会唱歌的城市").ok).toBe(true);
    expect(validateAllAgesText("色情内容")).toEqual({ ok: false, reason: "blocked" });
    expect(validatePlayablePromptText("守株待兔").ok).toBe(true);
    expect(validatePlayablePromptText("猫").ok).toBe(true);
    expect(
      validatePlayablePromptText("这是一个写得很长很复杂而且几乎没有合理猜测空间的完整句子。")
    ).toEqual({ ok: false, reason: "too-long" });
  });
});
