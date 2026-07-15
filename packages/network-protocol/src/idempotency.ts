import type { GameEnvelope } from "./schema";

export interface EnvelopeCursor {
  lastSeq: number;
  seenEventIds: string[];
}

export type EnvelopeDecision = "accept" | "duplicate" | "gap" | "stale";

export function inspectEnvelope(cursor: EnvelopeCursor, envelope: GameEnvelope): EnvelopeDecision {
  if (cursor.seenEventIds.includes(envelope.eventId)) return "duplicate";
  if (envelope.seq <= cursor.lastSeq) return "stale";
  if (envelope.seq > cursor.lastSeq + 1) return "gap";
  return "accept";
}

export function advanceEnvelopeCursor(
  cursor: EnvelopeCursor,
  envelope: GameEnvelope
): EnvelopeCursor {
  return {
    lastSeq: Math.max(cursor.lastSeq, envelope.seq),
    seenEventIds: [...cursor.seenEventIds.slice(-255), envelope.eventId]
  };
}
