/** @vitest-environment jsdom */

import type { TimelineSlot } from "@drawguessai/game-core";
import { render } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { SettlementModal } from "../src/components/SettlementModal";
import { en } from "../src/locales/en";
import type { RoundtablePlayerResult, RoundtableResult } from "../src/lib/turn-contribution";

const testI18n = createInstance();

const reactions = {
  applause: 0,
  egg: 0,
  laugh: 0,
  confused: 0,
  spark: 0,
  heart: 0
};

function player(seatId: string, displayName: string): RoundtablePlayerResult {
  return {
    seatId,
    displayName,
    positive: seatId === "best" ? 2 : 0,
    negative: seatId === "worst" ? 1 : 0,
    neutral: 0,
    net: seatId === "best" ? 4 : -2,
    received: seatId === "best" ? 2 : 1,
    reactions
  };
}

const actors: TimelineSlot[] = [
  {
    index: 0,
    role: "draw",
    actorType: "ai",
    actorId: "best",
    displayName: "Best",
    personaId: "maestro"
  },
  {
    index: 1,
    role: "guess",
    actorType: "ai",
    actorId: "worst",
    displayName: "Worst",
    personaId: "deadpan"
  }
];

const result: RoundtableResult = {
  best: player("best", "Best"),
  worst: player("worst", "Worst"),
  overallScore: 7.5,
  totalInteractions: 2,
  positiveInteractions: 1,
  negativeInteractions: 1,
  interactions: [
    {
      id: "positive",
      channel: "review",
      fromSeatId: "worst",
      fromDisplayName: "Worst",
      targetSeatId: "best",
      targetDisplayName: "Best",
      reaction: "applause",
      text: "That landed.",
      weight: 2
    },
    {
      id: "negative",
      channel: "review",
      fromSeatId: "best",
      fromDisplayName: "Best",
      targetSeatId: "worst",
      targetDisplayName: "Worst",
      reaction: "egg",
      text: "That did not.",
      weight: -2
    },
    {
      id: "positive-two",
      channel: "review",
      fromSeatId: "worst",
      fromDisplayName: "Worst",
      targetSeatId: "best",
      targetDisplayName: "Best",
      reaction: "heart",
      text: "Clear and quick.",
      weight: 2
    },
    {
      id: "positive-three",
      channel: "live",
      fromSeatId: "worst",
      fromDisplayName: "Worst",
      targetSeatId: "best",
      targetDisplayName: "Best",
      reaction: "spark",
      text: "Nice save.",
      weight: 1
    },
    {
      id: "positive-four",
      channel: "review",
      fromSeatId: "worst",
      fromDisplayName: "Worst",
      targetSeatId: "best",
      targetDisplayName: "Best",
      reaction: "applause",
      text: "Easy to follow.",
      weight: 2
    }
  ],
  ratings: [
    { seatId: "best", displayName: "Best", score: 4 },
    { seatId: "worst", displayName: "Worst", score: 3 }
  ]
};

describe("settlement modal", () => {
  beforeAll(async () => {
    await testI18n.use(initReactI18next).init({
      resources: { en: { translation: en } },
      lng: "en",
      interpolation: { escapeValue: false }
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true, addListener() {}, removeListener() {} })
    });
  });

  it("renders only the three result summaries even when source details exist", () => {
    const { container } = render(
      <I18nextProvider i18n={testI18n}>
        <SettlementModal result={result} actors={actors} onClose={() => undefined} />
      </I18nextProvider>
    );
    expect(container.querySelector(".settlement-stage")?.getAttribute("data-layout")).toBe(
      "single-column-summary"
    );
    const awards = [...container.querySelectorAll(".settlement-award")];
    expect(awards).toHaveLength(3);
    expect(
      awards.every(
        (award) =>
          award.children.length === 1 &&
          award.firstElementChild?.classList.contains("settlement-award-summary")
      )
    ).toBe(true);
    expect(container.querySelector(".settlement-source-lane")).toBeNull();
    expect(container.querySelector(".settlement-source-tag")).toBeNull();
    expect(container.querySelectorAll(".settlement-score-icon")).toHaveLength(1);
    expect(container.querySelectorAll(".settlement-score-meter > span")).toHaveLength(10);
    expect(container.querySelectorAll(".settlement-actor")).toHaveLength(2);
  });
});
