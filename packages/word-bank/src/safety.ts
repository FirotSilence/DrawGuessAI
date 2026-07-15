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
  reason?: "too-short" | "too-long" | "too-complex" | "blocked";
}

export function validateAllAgesText(text: string): PromptTextValidation {
  const normalized = text.trim().toLocaleLowerCase();
  if (normalized.length < 1) return { ok: false, reason: "too-short" };
  if ([...normalized].length > 160) return { ok: false, reason: "too-long" };
  if (BLOCKED_TERMS.some((term) => normalized.includes(term))) {
    return { ok: false, reason: "blocked" };
  }
  return { ok: true };
}

export function validatePlayablePromptText(text: string): PromptTextValidation {
  const safe = validateAllAgesText(text);
  if (!safe.ok) return safe;
  const normalized = text.trim();
  const hasChinese = /[\u3400-\u9fff]/u.test(normalized);
  if (hasChinese && [...normalized].length > 16) return { ok: false, reason: "too-long" };
  if (!hasChinese && normalized.split(/\s+/).length > 12) {
    return { ok: false, reason: "too-long" };
  }
  if (/[。！？.!?]\s*$/u.test(normalized) || /[\r\n]/u.test(normalized)) {
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
