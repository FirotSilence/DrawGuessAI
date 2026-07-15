import { AI_PERSONAS } from "@drawguessai/ai-adapters";
import type { GameLocale } from "@drawguessai/game-core";

export const AI_SEAT_IDS = AI_PERSONAS.map((_, index) => `ai-${index + 1}`);

const AI_NAMES: Record<GameLocale, readonly string[]> = {
  "zh-CN": [
    "小北",
    "阿岚",
    "木木",
    "夏梨",
    "可可",
    "七喜",
    "小满",
    "青禾",
    "早早",
    "米粒",
    "乔安",
    "星野",
    "栗子",
    "阿葵",
    "洛洛",
    "半夏",
    "知秋",
    "小川",
    "元宝",
    "苏打",
    "南星",
    "安可",
    "初九",
    "团子"
  ],
  en: [
    "Alex",
    "Jamie",
    "Riley",
    "Morgan",
    "Casey",
    "Taylor",
    "Jordan",
    "Quinn",
    "Avery",
    "Robin",
    "Skyler",
    "Cameron",
    "Rowan",
    "Sasha",
    "Remy",
    "Drew",
    "Bailey",
    "Parker",
    "Jules",
    "Ellis",
    "Finley",
    "Devon",
    "Marlow",
    "Kit"
  ]
};

export function createAiSeatProfiles(profileId: string): Record<string, string> {
  return Object.fromEntries(AI_SEAT_IDS.map((seatId) => [seatId, profileId]));
}

export function createAiSeatPersonas(): Record<string, string> {
  return completeAiSeatPersonas({});
}

export function createAiSeatNames(
  locale: GameLocale,
  random: () => number = Math.random
): Record<string, string> {
  const names = [...AI_NAMES[locale]];
  for (let index = names.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [names[index], names[swapIndex]] = [names[swapIndex]!, names[index]!];
  }
  return Object.fromEntries(AI_SEAT_IDS.map((seatId, index) => [seatId, names[index]!]));
}

export function completeAiSeatNames(
  current: Readonly<Record<string, string>>,
  locale: GameLocale
): Record<string, string> {
  const usedNames = new Set<string>();
  return Object.fromEntries(
    AI_SEAT_IDS.map((seatId, index) => {
      const requested = current[seatId]?.trim().slice(0, 40);
      const name =
        requested !== undefined && requested !== "" && !usedNames.has(requested)
          ? requested
          : (AI_NAMES[locale].find((candidate) => !usedNames.has(candidate)) ?? `AI ${index + 1}`);
      usedNames.add(name);
      return [seatId, name];
    })
  );
}

export function completeAiSeatPersonas(
  current: Readonly<Record<string, string>>
): Record<string, string> {
  const validPersonaIds = new Set(AI_PERSONAS.map((persona) => persona.id));
  return Object.fromEntries(
    AI_SEAT_IDS.map((seatId, index) => {
      const requested = current[seatId];
      const personaId =
        requested !== undefined && validPersonaIds.has(requested)
          ? requested
          : AI_PERSONAS[index % AI_PERSONAS.length]!.id;
      return [seatId, personaId];
    })
  );
}

export function swapAiSeatPersona(
  current: Readonly<Record<string, string>>,
  seatId: string,
  personaId: string
): Record<string, string> {
  const normalized = completeAiSeatPersonas(current);
  return AI_PERSONAS.some((persona) => persona.id === personaId)
    ? { ...normalized, [seatId]: personaId }
    : normalized;
}
