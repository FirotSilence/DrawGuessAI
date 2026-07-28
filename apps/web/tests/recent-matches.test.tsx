/** @vitest-environment jsdom */

import { render, waitFor } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchMatches: vi.fn(),
  likeMatch: vi.fn()
}));

vi.mock("../src/lib/api", () => ({
  fetchMatches: apiMocks.fetchMatches,
  likeMatch: apiMocks.likeMatch
}));

import { RecentMatches } from "../src/components/RecentMatches";
import { en } from "../src/locales/en";

const testI18n = createInstance();

describe("recent matches", () => {
  beforeAll(async () => {
    await testI18n.use(initReactI18next).init({
      resources: { en: { translation: en } },
      lng: "en",
      interpolation: { escapeValue: false }
    });
  });

  afterEach(() => {
    apiMocks.fetchMatches.mockReset();
    apiMocks.likeMatch.mockReset();
  });

  it("shows each archive result only once in the home ticker", async () => {
    apiMocks.fetchMatches.mockResolvedValue({
      items: [
        {
          token: "ABCDEFGH.abcdefghijklmnopqrstuv",
          roomId: "ABCDEFGH",
          startedAt: 1,
          completedAt: 2,
          permanent: false,
          likeCount: 0,
          liked: false,
          mode: "ai-theatre",
          locale: "en",
          prompt: "a kite in rain",
          playerCount: 4,
          turnCount: 4
        }
      ]
    });

    const { container } = render(
      <I18nextProvider i18n={testI18n}>
        <RecentMatches onOpenAll={() => undefined} onOpenReplay={() => undefined} />
      </I18nextProvider>
    );

    await waitFor(() => expect(container.querySelectorAll(".match-card")).toHaveLength(1));
    expect(apiMocks.fetchMatches).toHaveBeenCalledWith({ limit: 6 });
  });
});
