import { describe, expect, it } from "vitest";

import { reactionTone } from "../src/lib/reaction-tone";

describe("reaction tones", () => {
  it("separates praise, criticism, and laughter", () => {
    expect((["applause", "heart", "spark"] as const).map(reactionTone)).toEqual([
      "positive",
      "positive",
      "positive"
    ]);
    expect((["egg", "confused"] as const).map(reactionTone)).toEqual(["negative", "negative"]);
    expect(reactionTone("laugh")).toBe("neutral");
  });
});
