/** @vitest-environment jsdom */

import {
  DEFAULT_GAME_CONFIG,
  createInitialGameState,
  type GameState,
  type PostGameReview
} from "@drawguessai/game-core";
import { cleanup, render } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ReactionBar } from "../src/components/ReactionBar";
import { RevealScreen } from "../src/components/RevealScreen";
import { en } from "../src/locales/en";

const testI18n = createInstance();

const reviews: PostGameReview[] = [
  {
    id: "artist-review",
    seatId: "artist",
    personaId: "maestro",
    displayName: "Artist",
    modelLabel: "Model",
    text: "That drawing landed immediately.",
    score: 5,
    reaction: "applause",
    actions: [
      {
        targetSeatId: "guesser",
        targetDisplayName: "Guesser",
        reaction: "egg",
        text: "That guess missed by a mile."
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
    text: "I could not make sense of it.",
    score: 2,
    reaction: "confused",
    actions: [
      {
        targetSeatId: "artist",
        targetDisplayName: "Artist",
        reaction: "heart",
        text: "The drawing still looked great."
      }
    ],
    at: 2
  }
];

function completedState(): GameState {
  return {
    ...createInitialGameState("room", "seed", { ...DEFAULT_GAME_CONFIG, locale: "en" }, 1),
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
    artifacts: [{ kind: "prompt", turnIndex: -1, actorId: "host", text: "A lighthouse" }],
    postGameReviews: reviews
  };
}

describe("reaction polarity cues", () => {
  beforeAll(async () => {
    await testI18n.use(initReactI18next).init({
      resources: { en: { translation: en } },
      lng: "en",
      interpolation: { escapeValue: false }
    });
  });

  afterEach(cleanup);

  it("uses expressive icons and reaction names without visible polarity words", () => {
    const { container } = render(
      <I18nextProvider i18n={testI18n}>
        <RevealScreen state={completedState()} onBack={() => undefined} />
      </I18nextProvider>
    );

    const posts = [...container.querySelectorAll(".persona-review")];
    expect(posts).toHaveLength(2);
    expect(posts[0]?.classList.contains("reaction-tone-positive")).toBe(true);
    expect(posts[1]?.classList.contains("reaction-tone-negative")).toBe(true);
    expect(posts[0]?.querySelector(".review-copy > header .reaction-sentiment")?.textContent).toBe(
      "Applaud"
    );
    expect(posts[1]?.querySelector(".review-copy > header .reaction-sentiment")?.textContent).toBe(
      "Confused"
    );
    expect(posts[0]?.querySelector(".review-action .reaction-sentiment")?.textContent).toBe("Love");
    expect(posts[1]?.querySelector(".review-action .reaction-sentiment")?.textContent).toBe(
      "Throw egg"
    );
    expect(container.querySelector(".reaction-sentiment-tone")).toBeNull();
    expect(container.textContent).not.toContain("Positive");
    expect(container.textContent).not.toContain("Negative");
  });

  it("groups positive controls first and exposes each button's tone", () => {
    const { container } = render(
      <I18nextProvider i18n={testI18n}>
        <ReactionBar onReact={() => undefined} />
      </I18nextProvider>
    );

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".reaction-button")];
    expect(buttons.map((button) => button.dataset.tone)).toEqual([
      "positive",
      "positive",
      "positive",
      "neutral",
      "negative",
      "negative"
    ]);
    expect(buttons.map((button) => button.dataset.reaction)).toEqual([
      "applause",
      "heart",
      "spark",
      "laugh",
      "confused",
      "egg"
    ]);
    expect(
      buttons.map((button) =>
        [...(button.querySelector("svg")?.classList ?? [])].find((name) =>
          name.startsWith("lucide-")
        )
      )
    ).toEqual([
      "lucide-thumbs-up",
      "lucide-heart",
      "lucide-sparkles",
      "lucide-laugh",
      "lucide-frown",
      "lucide-thumbs-down"
    ]);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Applaud");
    expect(buttons.at(-1)?.getAttribute("aria-label")).toBe("Throw egg");
  });
});
