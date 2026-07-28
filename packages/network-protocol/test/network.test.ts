import { describe, expect, it } from "vitest";

import {
  AiActivitySchema,
  ClientMessageSchema,
  PublicAiSeatSchema,
  ServerMessageSchema,
  advanceEnvelopeCursor,
  canView,
  inspectEnvelope,
  type GameEnvelope
} from "../src";

const envelope: GameEnvelope = {
  v: 1,
  roomId: "room",
  seq: 1,
  eventId: "event-1",
  actorId: "actor",
  visibility: "public",
  type: "test",
  payload: { ok: true },
  sentAt: 1
};

describe("network protocol", () => {
  it("detects duplicate, stale, and gapped envelopes", () => {
    const initial = { lastSeq: 0, seenEventIds: [] };
    expect(inspectEnvelope(initial, envelope)).toBe("accept");
    const next = advanceEnvelopeCursor(initial, envelope);
    expect(inspectEnvelope(next, envelope)).toBe("duplicate");
    expect(inspectEnvelope(next, { ...envelope, eventId: "old", seq: 0 })).toBe("stale");
    expect(inspectEnvelope(next, { ...envelope, eventId: "gap", seq: 3 })).toBe("gap");
  });

  it("keeps blind content away from players who have not acted", () => {
    const waiting = {
      participantId: "waiting",
      roomRole: "player" as const,
      hasActed: false,
      isAiExecutor: false
    };
    const acted = { ...waiting, hasActed: true };
    expect(canView("acted", waiting, { phase: "turn" })).toBe(false);
    expect(canView("acted", acted, { phase: "turn" })).toBe(true);
    expect(canView("active", waiting, { phase: "turn", activeParticipantId: "waiting" })).toBe(
      true
    );
    expect(canView("reveal", waiting, { phase: "turn" })).toBe(false);
    expect(canView("reveal", waiting, { phase: "reveal" })).toBe(true);
  });

  it("never includes provider credentials in a protocol envelope", () => {
    expect(JSON.stringify(envelope)).not.toContain("apiKey");
    expect(JSON.stringify(envelope)).not.toContain("authorization");
  });

  it("keeps AI activity public-safe and rejects hidden reasoning fields", () => {
    const activity = {
      jobId: "job",
      seatId: "ai-1",
      modelLabel: "MiniMax-M3",
      role: "draw" as const,
      stage: "inspecting" as const,
      observationIndex: 1,
      observationLimit: 1,
      strokeCount: 12,
      deadlineAt: 100
    };
    expect(AiActivitySchema.parse(activity)).toEqual(activity);
    expect(AiActivitySchema.parse({ ...activity, stage: "retrying" }).stage).toBe("retrying");
    expect(AiActivitySchema.safeParse({ ...activity, reasoning: "private" }).success).toBe(false);
  });

  it("carries bounded custom persona prompts without provider credentials", () => {
    const seat = PublicAiSeatSchema.parse({
      seatId: "ai-1",
      profileId: "server-test",
      displayName: "南星",
      personaId: "maestro",
      personaCustomization: {
        name: "嘴硬画师",
        description: "嘴上不服，画画认真",
        turnPrompt: "Draw clearly, then react with dry confidence.",
        reviewPrompt: "Be concise and honestly competitive at the table."
      },
      capabilities: {
        vision: true,
        structuredOutput: "json-schema",
        observationMode: "checkpoint",
        maxObservationPasses: 1
      },
      execution: "local",
      ready: true
    });
    expect(seat.personaCustomization?.name).toBe("嘴硬画师");
    expect(JSON.stringify(seat)).not.toContain("apiKey");
    expect(
      PublicAiSeatSchema.safeParse({
        ...seat,
        personaCustomization: { ...seat.personaCustomization, turnPrompt: "x".repeat(1_501) }
      }).success
    ).toBe(false);
  });

  it("validates tagged custom prompts and public post-game reviews", () => {
    expect(
      ClientMessageSchema.parse({
        type: "game.start",
        hostToken: "host-token",
        prompt: {
          source: "custom",
          text: "守株待兔",
          metadata: { language: "zh-CN", kind: "idiom", length: 4, topic: "history" }
        }
      }).type
    ).toBe("game.start");
    expect(
      ClientMessageSchema.parse({
        type: "prompt.select",
        text: "守株待兔",
        metadata: { language: "zh-CN", kind: "idiom", length: 4, topic: "history" },
        hostToken: "host-token"
      }).type
    ).toBe("prompt.select");
    expect(ClientMessageSchema.parse({ type: "game.restart", hostToken: "host-token" })).toEqual({
      type: "game.restart",
      hostToken: "host-token"
    });
    expect(
      ClientMessageSchema.parse({
        type: "postgame.review",
        review: {
          id: "review-ai-1",
          seatId: "ai-1",
          personaId: "deadpan",
          displayName: "Deadpan",
          modelLabel: "MiniMax-M3",
          text: "A very deliberate detour.",
          score: 4,
          reaction: "laugh",
          actions: [
            {
              targetSeatId: "ai-2",
              targetDisplayName: "Maestro",
              reaction: "egg",
              text: "That was obviously a bicycle."
            }
          ]
        },
        hostToken: "host-token"
      }).type
    ).toBe("postgame.review");
  });

  it("versions clear-and-redraw previews so unordered packets stay idempotent", () => {
    expect(ClientMessageSchema.parse({ type: "preview.clear", generation: 2 })).toEqual({
      type: "preview.clear",
      generation: 2
    });
    expect(ClientMessageSchema.safeParse({ type: "preview.clear", generation: -1 }).success).toBe(
      false
    );
  });

  it("carries the next automated start time with an automated room snapshot", () => {
    const snapshot = ServerMessageSchema.parse({
      type: "room.snapshot",
      state: {},
      peers: [],
      automated: true,
      automatedNextRunAt: 3_600_000
    });
    expect(snapshot).toMatchObject({ automated: true, automatedNextRunAt: 3_600_000 });
  });

  it("carries private drawing drafts and paint-bucket previews without a finish command", () => {
    const fill = {
      type: "fill" as const,
      id: "fill-1",
      point: { x: 500, y: 375 },
      color: "#e94f64",
      offsetMs: 200
    };
    expect(ClientMessageSchema.parse({ type: "turn.save-drawing", commands: [fill] })).toEqual({
      type: "turn.save-drawing",
      commands: [fill]
    });
    expect(
      ClientMessageSchema.parse({ type: "preview.stroke", command: fill, generation: 1 })
    ).toEqual({ type: "preview.stroke", command: fill, generation: 1 });
  });

  it("accepts only public-safe AI failure reports", () => {
    expect(
      ClientMessageSchema.parse({
        type: "ai.failure",
        jobId: "job-1",
        errorCode: "empty-drawing"
      })
    ).toEqual({ type: "ai.failure", jobId: "job-1", errorCode: "empty-drawing" });
    expect(
      ClientMessageSchema.safeParse({
        type: "ai.failure",
        jobId: "job-1",
        errorCode: "Bearer private-token"
      }).success
    ).toBe(false);
  });
});
