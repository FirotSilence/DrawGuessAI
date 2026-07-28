import { AI_DISPLAY_NAMES, AI_PERSONAS } from "@drawguessai/ai-adapters";
import type { GameLocale } from "@drawguessai/game-core";

export const AI_SEAT_IDS = AI_PERSONAS.map((_, index) => `ai-${index + 1}`);

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
  const names = [...AI_DISPLAY_NAMES[locale]];
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
          : (AI_DISPLAY_NAMES[locale].find((candidate) => !usedNames.has(candidate)) ??
            `AI ${index + 1}`);
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
