import type { GameLocale, PromptKind } from "@drawguessai/game-core";

const BLOCKED_TERMS = [
  "porn",
  "nude",
  "suicide",
  "kill yourself",
  "纳粹",
  "色情",
  "裸体",
  "自杀",
  "去死"
] as const;

export interface PromptTextValidation {
  ok: boolean;
  reason?: "too-short" | "too-long" | "too-complex" | "unsupported-kind" | "blocked";
}

const ESTABLISHED_SAYING_KINDS = new Set<PromptKind>(["idiom", "proverb", "xiehouyu"]);
const CHINESE_COMPLEX_MARKERS =
  /(?:然后|接着|随后|同时|一边.+一边|因为|所以|但是|而且|如果|虽然|结果|突然|正在|已经|仍然|于是|被.{1,6}(?:吹|打|推|拉|带|卷|撞|淋|困|抓|偷|拿|吃|弄|压|卡|吓|烧|淹|冲|撕|踩|砸|咬)|把.{1,6}(?:放|拿|扔|打|推|拉|送|带|搬|倒|关|开|弄|丢|交|塞))/u;
const CHINESE_LOCATIVE_CLAUSE =
  /^.{1,4}在.{1,5}(?:睡觉|奔跑|跑步|吃饭|玩耍|唱歌|跳舞|读书|写字|工作|画画|看书|等车|站立|坐着|哭泣|大笑)$/u;
const ENGLISH_COMPLEX_MARKERS =
  /\b(?:i|you|he|she|it|we|they|am|is|are|was|were|has|have|had|does|did|will|would|shall|should|can|could|may|might|must|because|although|though|while|then|afterwards|however|therefore|suddenly)\b/iu;

export function validateAllAgesText(text: string): PromptTextValidation {
  const normalized = text.trim().toLocaleLowerCase();
  if (normalized.length < 1) return { ok: false, reason: "too-short" };
  if ([...normalized].length > 160) return { ok: false, reason: "too-long" };
  if (BLOCKED_TERMS.some((term) => normalized.includes(term))) {
    return { ok: false, reason: "blocked" };
  }
  return { ok: true };
}

export function validatePlayablePromptText(
  text: string,
  kind: PromptKind = "phrase",
  locale?: GameLocale
): PromptTextValidation {
  const safe = validateAllAgesText(text);
  if (!safe.ok) return safe;
  const normalized = text.trim();
  const hasChinese = /[\u3400-\u9fff]/u.test(normalized);
  const resolvedLocale = locale ?? (hasChinese ? "zh-CN" : "en");
  const isEstablishedSaying = ESTABLISHED_SAYING_KINDS.has(kind);

  if (kind === "poem-line") {
    if (resolvedLocale !== "zh-CN") return { ok: false, reason: "unsupported-kind" };
    const compactPoemLine = normalized.replace(/\s+/g, "");
    if ([...compactPoemLine].length > 12) return { ok: false, reason: "too-long" };
    if (!/^[\u3400-\u9fff]{4,12}$/u.test(compactPoemLine)) {
      return { ok: false, reason: "too-complex" };
    }
    return { ok: true };
  }

  const maxChineseCharacters = isEstablishedSaying ? 16 : kind === "word" ? 6 : 8;
  const maxEnglishWords = isEstablishedSaying ? 12 : kind === "word" ? 3 : 6;
  if (hasChinese && [...normalized].length > maxChineseCharacters) {
    return { ok: false, reason: "too-long" };
  }
  if (!hasChinese && normalized.split(/\s+/).length > maxEnglishWords) {
    return { ok: false, reason: "too-long" };
  }

  if (
    /[。！？.!?；;：:]/u.test(normalized) ||
    /[\r\n]/u.test(normalized) ||
    (!isEstablishedSaying && /[，,]/u.test(normalized))
  ) {
    return { ok: false, reason: "too-complex" };
  }
  if (
    !isEstablishedSaying &&
    (CHINESE_COMPLEX_MARKERS.test(normalized) ||
      CHINESE_LOCATIVE_CLAUSE.test(normalized) ||
      /[了呢吗吧啊呀啦]$/u.test(normalized) ||
      ENGLISH_COMPLEX_MARKERS.test(normalized))
  ) {
    return { ok: false, reason: "too-complex" };
  }
  return { ok: true };
}

export function sanitizeAiLine(text: string, fallback: string): string {
  const clean = text
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 80);
  return validateAllAgesText(clean).ok ? clean : fallback;
}
