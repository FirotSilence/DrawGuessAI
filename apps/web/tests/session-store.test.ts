import { afterEach, describe, expect, it, vi } from "vitest";

import { loadRoomSession, saveRoomSession, type RoomSession } from "../src/lib/session-store";

class MemorySessionStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("room session storage", () => {
  it("persists valid persona customizations and drops malformed prompt data", () => {
    const storage = new MemorySessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    const session: RoomSession = {
      roomId: "ROOM1234",
      participantId: "host",
      reconnectToken: "reconnect",
      seatProfiles: { "ai-1": "minimax" },
      seatPersonas: { "ai-1": "maestro" },
      seatPersonaCustomizations: {
        "ai-1": {
          name: "街头派",
          description: "直爽而认真",
          turnPrompt: "Use lively curves and keep the subject clear.",
          reviewPrompt: "React like a competitive friend."
        }
      },
      seatNames: { "ai-1": "南星" }
    };

    saveRoomSession(session);
    expect(loadRoomSession("room1234")?.seatPersonaCustomizations).toEqual(
      session.seatPersonaCustomizations
    );

    storage.setItem(
      "drawguessai:room:ROOM1234",
      JSON.stringify({
        ...session,
        seatPersonaCustomizations: {
          "ai-1": { ...session.seatPersonaCustomizations["ai-1"], turnPrompt: "" }
        }
      })
    );
    expect(loadRoomSession("ROOM1234")?.seatPersonaCustomizations).toEqual({});
  });
});
