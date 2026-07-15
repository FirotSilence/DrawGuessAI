import {
  DEFAULT_GAME_CONFIG,
  createInitialGameState,
  type GameState,
  type PostGameReview
} from "@drawguessai/game-core";
import { describe, expect, it } from "vitest";

import {
  contributionForActor,
  receivedPostGameReactions,
  roundtableActors,
  roundtableResult
} from "../src/lib/turn-contribution";

function completedState(): GameState {
  return {
    ...createInitialGameState("room", "seed", DEFAULT_GAME_CONFIG, 1),
    phase: "complete",
    timeline: [
      {
        index: 0,
        role: "draw",
        actorType: "ai",
        actorId: "artist",
        displayName: "Artist",
        personaId: "maestro"
      },
      {
        index: 1,
        role: "guess",
        actorType: "ai",
        actorId: "guesser",
        displayName: "Guesser",
        personaId: "detective"
      }
    ],
    artifacts: [
      { kind: "prompt", turnIndex: -1, actorId: "host", text: "守株待兔" },
      {
        kind: "drawing",
        turnIndex: 0,
        actorId: "artist",
        commands: [
          {
            type: "stroke",
            id: "line",
            tool: "pen",
            color: "#202124",
            width: 8,
            points: [
              { x: 10, y: 10 },
              { x: 100, y: 100 }
            ],
            offsetMs: 0
          }
        ],
        canvasHash: "00000000"
      },
      { kind: "guess", turnIndex: 1, actorId: "guesser", text: "兔子撞树" }
    ]
  };
}

describe("post-game turn contributions", () => {
  it("pairs a drawing player with the received clue and submitted canvas", () => {
    const contribution = contributionForActor(completedState(), "artist");
    expect(contribution?.slot.role).toBe("draw");
    expect(contribution?.input).toMatchObject({ kind: "prompt", text: "守株待兔" });
    expect(contribution?.output).toMatchObject({ kind: "drawing", actorId: "artist" });
  });

  it("pairs a guessing player with the received canvas and submitted guess", () => {
    const contribution = contributionForActor(completedState(), "guesser");
    expect(contribution?.slot.role).toBe("guess");
    expect(contribution?.input).toMatchObject({ kind: "drawing", actorId: "artist" });
    expect(contribution?.output).toMatchObject({ kind: "guess", text: "兔子撞树" });
  });

  it("places directed reactions under the target player's post", () => {
    const reviews: PostGameReview[] = [
      {
        id: "one",
        seatId: "artist",
        personaId: "maestro",
        displayName: "Artist",
        modelLabel: "Model",
        text: "I drew it.",
        score: 3,
        reaction: "laugh",
        actions: [
          {
            targetSeatId: "guesser",
            targetDisplayName: "Guesser",
            reaction: "egg",
            text: "How did you miss the rabbit?"
          }
        ],
        at: 1
      },
      {
        id: "two",
        seatId: "guesser",
        personaId: "detective",
        displayName: "Guesser",
        modelLabel: "Model",
        text: "It looked like a potato.",
        score: 2,
        reaction: "confused",
        at: 2
      }
    ];

    expect(receivedPostGameReactions(reviews, "artist")).toEqual([]);
    expect(receivedPostGameReactions(reviews, "guesser")).toEqual([
      expect.objectContaining({ fromDisplayName: "Artist", reaction: "egg" })
    ]);
  });

  it("keeps human and AI actors in the same roundtable order", () => {
    const state = completedState();
    const humanSlot = { ...state.timeline[1]!, actorType: "human" as const };
    delete humanSlot.personaId;
    state.timeline[1] = humanSlot;
    expect(roundtableActors(state).map((actor) => actor.actorType)).toEqual(["ai", "human"]);
  });

  it("derives awards and the overall rating from directed interactions", () => {
    const state = completedState();
    const reviews: PostGameReview[] = [
      {
        id: "artist-review",
        seatId: "artist",
        personaId: "maestro",
        displayName: "Artist",
        modelLabel: "Model",
        text: "The rabbit was right there.",
        score: 3,
        reaction: "laugh",
        actions: [
          {
            targetSeatId: "guesser",
            targetDisplayName: "Guesser",
            reaction: "egg",
            text: "You guessed around it."
          }
        ],
        at: 1
      },
      {
        id: "guesser-review",
        seatId: "guesser",
        personaId: "detective",
        displayName: "Guesser",
        modelLabel: "Model",
        text: "The tree was excellent.",
        score: 5,
        reaction: "applause",
        actions: [
          {
            targetSeatId: "artist",
            targetDisplayName: "Artist",
            reaction: "applause",
            text: "The drawing deserved better."
          }
        ],
        at: 2
      }
    ];

    const result = roundtableResult(state, reviews);
    expect(result.best).toMatchObject({ seatId: "artist", positive: 1, net: 2 });
    expect(result.worst).toMatchObject({ seatId: "guesser", negative: 1, net: -2 });
    expect(result.totalInteractions).toBe(2);
    expect(result.overallScore).toBe(7);
    expect(result.interactions).toEqual([
      expect.objectContaining({
        channel: "review",
        fromDisplayName: "Artist",
        targetDisplayName: "Guesser",
        reaction: "egg",
        weight: -2
      }),
      expect.objectContaining({
        channel: "review",
        fromDisplayName: "Guesser",
        targetDisplayName: "Artist",
        reaction: "applause",
        weight: 2
      })
    ]);
    expect(result.ratings).toEqual([
      expect.objectContaining({ displayName: "Artist", score: 3 }),
      expect.objectContaining({ displayName: "Guesser", score: 5 })
    ]);
  });

  it("counts other-player live reactions but ignores an AI reacting to its own turn", () => {
    const state = completedState();
    state.reactions = [
      {
        id: "observer-heart",
        actorId: "guesser",
        turnIndex: 0,
        reaction: "heart",
        at: 1
      },
      {
        id: "self-spark",
        actorId: "artist",
        turnIndex: 0,
        reaction: "spark",
        at: 2
      },
      {
        id: "observer-egg",
        actorId: "observer",
        turnIndex: 0,
        reaction: "egg",
        at: 3
      }
    ];

    const result = roundtableResult(state, []);
    expect(result.best).toMatchObject({ seatId: "artist", positive: 1, received: 1 });
    expect(result.totalInteractions).toBe(1);
    expect(result.overallScore).toBe(10);
    expect(result.interactions).toEqual([
      expect.objectContaining({
        channel: "live",
        fromDisplayName: "Guesser",
        targetDisplayName: "Artist",
        reaction: "heart"
      })
    ]);
  });

  it("still awards relative best and worst players when every reaction is negative", () => {
    const state = completedState();
    const reviews: PostGameReview[] = [
      {
        id: "one-egg",
        seatId: "artist",
        personaId: "maestro",
        displayName: "Artist",
        modelLabel: "Model",
        text: "Nope.",
        score: 2,
        reaction: "egg",
        actions: [
          {
            targetSeatId: "guesser",
            targetDisplayName: "Guesser",
            reaction: "egg",
            text: "That guess wandered off."
          }
        ],
        at: 1
      },
      {
        id: "one-confused",
        seatId: "guesser",
        personaId: "detective",
        displayName: "Guesser",
        modelLabel: "Model",
        text: "Also nope.",
        score: 2,
        reaction: "confused",
        actions: [
          {
            targetSeatId: "artist",
            targetDisplayName: "Artist",
            reaction: "confused",
            text: "That rabbit needed a passport."
          }
        ],
        at: 2
      }
    ];

    const result = roundtableResult(state, reviews);
    expect(result.best?.seatId).toBe("artist");
    expect(result.worst?.seatId).toBe("guesser");
  });
});
