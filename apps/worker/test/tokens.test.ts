import { describe, expect, it } from "vitest";

import { hashToken, randomRoomCode, randomToken, tokenMatches } from "../src/tokens";

describe("worker token helpers", () => {
  it("creates compact non-ambiguous room codes", () => {
    expect(randomRoomCode()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
  });

  it("hashes reconnect and replay tokens", async () => {
    const token = randomToken();
    const hash = await hashToken(token);
    expect(await tokenMatches(token, hash)).toBe(true);
    expect(await tokenMatches(`${token}x`, hash)).toBe(false);
    expect(hash).not.toContain(token);
  });
});
