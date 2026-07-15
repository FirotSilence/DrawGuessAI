import type { GameLocale } from "@drawguessai/game-core";

const DISPLAY_NAME_KEY = "drawguessai:display-name";

const zhPrefixes = ["珊瑚", "青绿", "钴蓝", "芥末", "纸飞机", "小画笔", "墨线", "调色盘"] as const;
const zhSuffixes = ["画手", "猜客", "观察员", "接龙王", "涂鸦家", "灵感派"] as const;
const enPrefixes = [
  "Coral",
  "Teal",
  "Cobalt",
  "Mustard",
  "Paper",
  "Inky",
  "Bright",
  "Quick"
] as const;
const enSuffixes = ["Brush", "Guesser", "Sketcher", "Doodler", "Observer", "Colorist"] as const;

type DisplayNameStorage = Pick<Storage, "getItem" | "setItem">;

function randomIndex(length: number): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0]! % length;
}

export function createRandomDisplayName(locale: GameLocale): string {
  const number = String(10 + randomIndex(90));
  if (locale === "zh-CN") {
    return `${zhPrefixes[randomIndex(zhPrefixes.length)]}${zhSuffixes[randomIndex(zhSuffixes.length)]}${number}`;
  }
  return `${enPrefixes[randomIndex(enPrefixes.length)]} ${enSuffixes[randomIndex(enSuffixes.length)]} ${number}`;
}

export function getOrCreateDisplayName(
  locale: GameLocale,
  storage: DisplayNameStorage = localStorage
): string {
  try {
    const existing = storage.getItem(DISPLAY_NAME_KEY)?.trim();
    if (existing !== undefined && existing !== "" && existing.length <= 24) return existing;
    const generated = createRandomDisplayName(locale);
    storage.setItem(DISPLAY_NAME_KEY, generated);
    return generated;
  } catch {
    return createRandomDisplayName(locale);
  }
}

export function rememberDisplayName(
  displayName: string,
  storage: DisplayNameStorage = localStorage
): void {
  const normalized = displayName.trim().slice(0, 24);
  if (normalized === "") return;
  try {
    storage.setItem(DISPLAY_NAME_KEY, normalized);
  } catch {
    // Storage can be unavailable in privacy modes; the current session still works.
  }
}
