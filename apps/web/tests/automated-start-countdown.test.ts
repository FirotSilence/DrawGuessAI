import { describe, expect, it } from "vitest";

import { formatAutomatedStartCountdown } from "../src/lib/automated-start";

describe("automated start countdown", () => {
  it("formats an hourly start countdown without rounding a second away", () => {
    expect(formatAutomatedStartCountdown(3_661_000, 1_000)).toBe("01:01:00");
    expect(formatAutomatedStartCountdown(61_100, 1_000)).toBe("01:01");
    expect(formatAutomatedStartCountdown(1_001, 1_000)).toBe("00:01");
    expect(formatAutomatedStartCountdown(1_000, 1_000)).toBe("00:00");
  });
});
