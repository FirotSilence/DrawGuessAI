import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_GAME_CONFIG,
  applyTopicHintSetting,
  aiPlaybackDurationMs,
  applyGameEvent,
  buildAiTheatreTimeline,
  buildBlindTimeline,
  createInitialGameState,
  createPromptMetadata,
  gamePhaseMachine,
  hashGameState,
  replayGame,
  type GameEvent
} from "../src";

describe("game core", () => {
  it("creates deterministic visible prompt language and type metadata", () => {
    expect(createPromptMetadata("守株待兔", "zh-CN", "idiom")).toEqual({
      language: "zh-CN",
      kind: "idiom",
      length: 4
    });
    expect(createPromptMetadata("flying a kite in rain", "en", "phrase")).toEqual({
      language: "en",
      kind: "phrase",
      length: 5
    });
    expect(createPromptMetadata("切西瓜", "zh-CN", "phrase", "fruit")).toEqual({
      language: "zh-CN",
      kind: "phrase",
      length: 3,
      topic: "fruit"
    });
    expect(DEFAULT_GAME_CONFIG.showTopicHint).toBe(true);
    expect(
      applyTopicHintSetting({ language: "zh-CN", kind: "phrase", length: 3, topic: "fruit" }, false)
    ).toEqual({ language: "zh-CN", kind: "phrase", length: 3 });
  });

  it("accelerates a deep AI drawing queue while preserving an ordered playback window", () => {
    expect(aiPlaybackDurationMs(0, 25)).toBe(2_200);
    expect(aiPlaybackDurationMs(2, 25)).toBe(2_500);
    expect(aiPlaybackDurationMs(60, 10)).toBe(10_000);
    expect(aiPlaybackDurationMs(20, 25)).toBe(6_720);
    expect(aiPlaybackDurationMs(120, 25)).toBeLessThan(20_000);
  });

  it("drives the documented phase machine", () => {
    const actor = createActor(gamePhaseMachine).start();
    expect(actor.getSnapshot().value).toBe("lobby");
    actor.send({ type: "START" });
    actor.send({ type: "PROMPT_READY" });
    actor.send({ type: "INSPECT" });
    actor.send({ type: "SUBMIT" });
    actor.send({ type: "NEXT", hasMoreTurns: false });
    actor.send({ type: "COMPLETE" });
    expect(actor.getSnapshot().value).toBe("complete");

    const failedActor = createActor(gamePhaseMachine).start();
    failedActor.send({ type: "START" });
    failedActor.send({ type: "PROMPT_READY" });
    failedActor.send({ type: "FAIL" });
    expect(failedActor.getSnapshot().value).toBe("failed");
  });

  it("assigns every human once and deterministically fills AI seats", () => {
    const aiSeats = Array.from({ length: 6 }, (_, index) => ({
      id: `a${index + 1}`,
      displayName: `AI ${index + 1}`
    }));
    const options = {
      humans: [
        { id: "h1", displayName: "One" },
        { id: "h2", displayName: "Two" }
      ],
      aiSeats,
      chainLength: 8,
      seed: "fixed"
    };
    const first = buildBlindTimeline(options);
    const second = buildBlindTimeline(options);
    expect(second).toEqual(first);
    expect(first.filter((slot) => slot.actorType === "human")).toHaveLength(2);
    expect(new Set(first.map((slot) => slot.actorId)).size).toBe(8);
    expect(new Set(first.map((slot) => slot.index)).size).toBe(8);
    expect(first.map((slot) => slot.role)).toEqual([
      "draw",
      "guess",
      "draw",
      "guess",
      "draw",
      "guess",
      "draw",
      "guess"
    ]);
  });

  it("uses a distinct AI actor for every theatre turn", () => {
    const seats = Array.from({ length: 8 }, (_, index) => ({
      id: `ai-${index + 1}`,
      displayName: `AI ${index + 1}`,
      personaId: `persona-${index + 1}`,
      ...(index === 0 ? { personaName: "Custom persona" } : {})
    }));
    const timeline = buildAiTheatreTimeline(seats, 8);
    expect(new Set(timeline.map((slot) => slot.actorId)).size).toBe(8);
    expect(new Set(timeline.map((slot) => slot.personaId)).size).toBe(8);
    expect(timeline[0]?.personaName).toBe("Custom persona");
    expect(() => buildAiTheatreTimeline(seats.slice(0, 4), 8)).toThrow(/distinct AI seats/);
    const sharedPersona = buildAiTheatreTimeline(
      seats.map((seat) => ({ ...seat, personaId: "same-persona" })),
      8
    );
    expect(new Set(sharedPersona.map((slot) => slot.personaId))).toEqual(new Set(["same-persona"]));
  });

  it("replays events deterministically and ignores duplicate event ids", () => {
    const config = {
      ...DEFAULT_GAME_CONFIG,
      rules: { ...DEFAULT_GAME_CONFIG.rules, chainLength: 4 }
    };
    const initial = createInitialGameState("room", "seed", config, 1);
    const timeline = buildBlindTimeline({
      humans: [],
      aiSeats: Array.from({ length: 4 }, (_, index) => ({
        id: `ai-${index + 1}`,
        displayName: `AI ${index + 1}`
      })),
      chainLength: 4,
      seed: "seed"
    });
    const events: GameEvent[] = [
      { type: "timeline.configured", id: "1", at: 2, timeline },
      { type: "game.started", id: "2", at: 3 },
      {
        type: "prompt.selected",
        id: "3",
        at: 4,
        actorId: "system",
        text: "A test",
        metadata: createPromptMetadata("A test", "en", "phrase")
      }
    ];
    const replayed = replayGame(initial, events);
    const duplicated = applyGameEvent(replayed, events[2]!);
    expect(duplicated).toBe(replayed);
    expect(hashGameState(replayed)).toBe(hashGameState(replayGame(initial, events)));
    expect(replayed.phase).toBe("turn");
    expect(replayed.promptMetadata).toEqual({ language: "en", kind: "phrase", length: 2 });
    const failed = applyGameEvent(replayed, {
      type: "game.failed",
      id: "4",
      at: 5,
      actorId: "ai-1",
      turnIndex: 0,
      errorCode: "empty-drawing"
    });
    expect(failed.phase).toBe("failed");
    expect(failed.failure).toEqual({
      actorId: "ai-1",
      turnIndex: 0,
      errorCode: "empty-drawing",
      at: 5
    });
  });

  it("records host transfer as a deterministic domain event", () => {
    const initial = createInitialGameState("room", "seed", DEFAULT_GAME_CONFIG, 1);
    const withHost = applyGameEvent(initial, {
      type: "player.joined",
      id: "host",
      at: 2,
      participant: {
        id: "p1",
        displayName: "First",
        roomRole: "host",
        connected: true,
        hasActed: false
      }
    });
    const withGuest = applyGameEvent(withHost, {
      type: "player.joined",
      id: "guest",
      at: 3,
      participant: {
        id: "p2",
        displayName: "Second",
        roomRole: "player",
        connected: true,
        hasActed: false
      }
    });
    const transferred = applyGameEvent(withGuest, {
      type: "player.host-transferred",
      id: "transfer",
      at: 4,
      fromParticipantId: "p1",
      toParticipantId: "p2"
    });
    expect(transferred.participants.find((player) => player.id === "p1")?.roomRole).toBe("player");
    expect(transferred.participants.find((player) => player.id === "p2")?.roomRole).toBe("host");
    expect(hashGameState(transferred)).toBe(
      hashGameState(
        replayGame(initial, [
          {
            type: "player.joined",
            id: "host",
            at: 2,
            participant: {
              id: "p1",
              displayName: "First",
              roomRole: "host",
              connected: true,
              hasActed: false
            }
          },
          {
            type: "player.joined",
            id: "guest",
            at: 3,
            participant: {
              id: "p2",
              displayName: "Second",
              roomRole: "player",
              connected: true,
              hasActed: false
            }
          },
          {
            type: "player.host-transferred",
            id: "transfer",
            at: 4,
            fromParticipantId: "p1",
            toParticipantId: "p2"
          }
        ])
      )
    );
  });

  it("removes a lobby participant and their scheduled turn deterministically", () => {
    const initial = createInitialGameState("room", "seed", DEFAULT_GAME_CONFIG, 1);
    const joined = applyGameEvent(initial, {
      type: "player.joined",
      id: "join",
      at: 2,
      participant: {
        id: "p1",
        displayName: "Leaving player",
        roomRole: "player",
        connected: true,
        hasActed: false
      }
    });
    const scheduled = applyGameEvent(joined, {
      type: "timeline.configured",
      id: "schedule",
      at: 3,
      timeline: [
        {
          index: 0,
          role: "draw",
          actorType: "human",
          actorId: "p1",
          displayName: "Leaving player"
        },
        {
          index: 1,
          role: "guess",
          actorType: "ai",
          actorId: "ai-1",
          displayName: "One",
          personaId: "maestro"
        },
        {
          index: 2,
          role: "draw",
          actorType: "ai",
          actorId: "ai-2",
          displayName: "Two",
          personaId: "deadpan"
        },
        {
          index: 3,
          role: "guess",
          actorType: "ai",
          actorId: "ai-3",
          displayName: "Three",
          personaId: "hype"
        }
      ]
    });
    const left = applyGameEvent(scheduled, {
      type: "player.left",
      id: "leave",
      at: 4,
      participantId: "p1"
    });

    expect(left.participants).toHaveLength(0);
    expect(left.timeline.some((slot) => slot.actorId === "p1")).toBe(false);
    expect(hashGameState(left)).toBe(
      hashGameState(
        replayGame(initial, [
          {
            type: "player.joined",
            id: "join",
            at: 2,
            participant: {
              id: "p1",
              displayName: "Leaving player",
              roomRole: "player",
              connected: true,
              hasActed: false
            }
          },
          {
            type: "timeline.configured",
            id: "schedule",
            at: 3,
            timeline: scheduled.timeline
          },
          { type: "player.left", id: "leave", at: 4, participantId: "p1" }
        ])
      )
    );
  });

  it("records one idempotent post-game review per AI seat", () => {
    const completed = {
      ...createInitialGameState("room", "seed", DEFAULT_GAME_CONFIG, 1),
      phase: "complete" as const
    };
    const event: GameEvent = {
      type: "postgame.reviewed",
      id: "review-ai-1",
      at: 2,
      review: {
        id: "review-ai-1",
        seatId: "ai-1",
        personaId: "deadpan",
        displayName: "Deadpan",
        modelLabel: "MiniMax-M3",
        text: "Technically, the relay reached the end.",
        score: 4,
        reaction: "laugh",
        actions: [
          {
            targetSeatId: "ai-2",
            targetDisplayName: "Cheerleader",
            reaction: "egg",
            text: "You missed my masterpiece."
          }
        ],
        at: 2
      }
    };
    const reviewed = applyGameEvent(completed, event);
    expect(reviewed.postGameReviews).toHaveLength(1);
    expect(reviewed.postGameReviews[0]?.actions?.[0]?.targetSeatId).toBe("ai-2");
    expect(
      applyGameEvent(reviewed, { ...event, id: "another-event" }).postGameReviews
    ).toHaveLength(1);
  });
});
