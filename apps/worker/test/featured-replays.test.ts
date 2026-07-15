import { describe, expect, it } from "vitest";

import { FEATURED_REPLAY_TOKEN, featuredReplayAssetPath } from "../src/featured-replays";

describe("featured replays", () => {
  it("maps the documented showcase token to a bundled immutable replay", () => {
    expect(featuredReplayAssetPath(FEATURED_REPLAY_TOKEN)).toBe(
      `/featured-replays/${FEATURED_REPLAY_TOKEN}.json`
    );
  });

  it("does not turn arbitrary replay tokens into asset paths", () => {
    expect(featuredReplayAssetPath("AAAA2222.not-the-featured-token")).toBeUndefined();
  });
});
