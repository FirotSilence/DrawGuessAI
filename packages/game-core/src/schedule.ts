import { z } from "zod";

export const TurnRoleSchema = z.enum(["draw", "guess"]);
export const ActorTypeSchema = z.enum(["human", "ai"]);

export const TimelineSlotSchema = z
  .object({
    index: z.number().int().min(0).max(11),
    role: TurnRoleSchema,
    actorType: ActorTypeSchema,
    actorId: z.string().min(1).max(80),
    displayName: z.string().min(1).max(40),
    personaId: z.string().min(1).max(60).optional(),
    personaName: z.string().trim().min(1).max(24).optional()
  })
  .strict();

export interface ScheduleActor {
  id: string;
  displayName: string;
  personaId?: string;
  personaName?: string;
}

export interface BuildBlindTimelineOptions {
  humans: readonly ScheduleActor[];
  aiSeats: readonly ScheduleActor[];
  chainLength: number;
  seed: string;
  positions?: Readonly<Record<string, number>>;
}

export type TimelineSlot = z.infer<typeof TimelineSlotSchema>;
export type TurnRole = z.infer<typeof TurnRoleSchema>;

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createSeededRandom(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function shuffleWithSeed<T>(items: readonly T[], seed: string): T[] {
  const result = [...items];
  const random = createSeededRandom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function roleForIndex(index: number): TurnRole {
  return index % 2 === 0 ? "draw" : "guess";
}

function distinctAiSeats(aiSeats: readonly ScheduleActor[], required: number): ScheduleActor[] {
  if (aiSeats.length < required) {
    throw new Error(`The timeline requires ${required} distinct AI seats`);
  }
  const assigned = aiSeats.slice(0, required);
  if (new Set(assigned.map((seat) => seat.id)).size !== required) {
    throw new Error("Every AI turn requires a distinct AI actor");
  }
  return assigned;
}

export function buildAiTheatreTimeline(
  aiSeats: readonly ScheduleActor[],
  chainLength: number
): TimelineSlot[] {
  if (chainLength < 4 || chainLength > 12) {
    throw new RangeError("chainLength must be between 4 and 12");
  }
  const assignedSeats = distinctAiSeats(aiSeats, chainLength);
  return Array.from({ length: chainLength }, (_, index) => {
    const actor = assignedSeats[index]!;
    return {
      index,
      role: roleForIndex(index),
      actorType: "ai" as const,
      actorId: actor.id,
      displayName: actor.displayName,
      ...(actor.personaId === undefined ? {} : { personaId: actor.personaId }),
      ...(actor.personaName === undefined ? {} : { personaName: actor.personaName })
    };
  });
}

export function buildBlindTimeline(options: BuildBlindTimelineOptions): TimelineSlot[] {
  const { humans, aiSeats, chainLength, seed, positions = {} } = options;
  if (humans.length > 8) {
    throw new RangeError("Blind relay supports at most eight human players");
  }
  if (chainLength < Math.max(4, humans.length) || chainLength > 12) {
    throw new RangeError("chainLength must fit every human and stay between 4 and 12");
  }
  const requiredAiSeats = chainLength - humans.length;
  const assignedAiSeats = distinctAiSeats(aiSeats, requiredAiSeats);

  const slots = Array<ScheduleActor | undefined>(chainLength).fill(undefined);
  const usedPositions = new Set<number>();
  for (const human of humans) {
    const requested = positions[human.id];
    if (requested === undefined) {
      continue;
    }
    if (requested < 0 || requested >= chainLength || usedPositions.has(requested)) {
      throw new Error(`Invalid or duplicate requested position ${requested}`);
    }
    slots[requested] = human;
    usedPositions.add(requested);
  }

  const unplacedHumans = shuffleWithSeed(
    humans.filter((human) => positions[human.id] === undefined),
    `${seed}:humans`
  );
  const openPositions = shuffleWithSeed(
    slots.map((actor, index) => (actor === undefined ? index : -1)).filter((index) => index >= 0),
    `${seed}:positions`
  );
  for (const human of unplacedHumans) {
    const position = openPositions.shift();
    if (position === undefined) {
      throw new Error("No position available for human player");
    }
    slots[position] = human;
  }

  let aiIndex = 0;
  return slots.map((actor, index) => {
    const isHuman = actor !== undefined;
    const assigned = actor ?? assignedAiSeats[aiIndex++]!;
    return {
      index,
      role: roleForIndex(index),
      actorType: isHuman ? ("human" as const) : ("ai" as const),
      actorId: assigned.id,
      displayName: assigned.displayName,
      ...(assigned.personaId === undefined ? {} : { personaId: assigned.personaId }),
      ...(assigned.personaName === undefined ? {} : { personaName: assigned.personaName })
    };
  });
}
