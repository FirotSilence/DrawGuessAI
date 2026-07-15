import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiTurnJob } from "@drawguessai/ai-adapters";

import { executeServerAi, fetchIceServers } from "../src/lib/api";
import type { RoomSession } from "../src/lib/session-store";

const job: AiTurnJob = {
  jobId: "server-ai-request",
  roomId: "ROOM1234",
  turnIndex: -1,
  role: "prompt",
  locale: "en",
  personaId: "inspector",
  observationIndex: 0,
  observationLimit: 0,
  timeLimitSeconds: 30,
  budget: {
    maxStrokes: 60,
    maxUndos: 3,
    colorCount: 10,
    remainingStrokes: 60,
    remainingUndos: 3
  }
};

afterEach(() => vi.unstubAllGlobals());

describe("server AI API", () => {
  it("serializes only participant credentials for ICE configuration", async () => {
    const session: RoomSession = {
      roomId: "ROOM1234",
      participantId: "participant",
      reconnectToken: "reconnect-token",
      hostToken: "host-token-must-not-be-sent",
      inviteUrl: "https://example.com/?room=ROOM1234",
      seatProfiles: { "ai-1": "server-minimax-m3" },
      seatPersonas: { "ai-1": "maestro" },
      seatPersonaCustomizations: {},
      seatNames: { "ai-1": "Marlow" }
    };
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ iceServers: [{ urls: ["stun:example.com:3478"] }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchIceServers(session)).resolves.toEqual([{ urls: ["stun:example.com:3478"] }]);

    const request = fetchMock.mock.calls[0]?.[1];
    if (typeof request?.body !== "string") throw new Error("Expected a JSON request body");
    expect(JSON.parse(request.body)).toEqual({
      roomId: "ROOM1234",
      participantId: "participant",
      reconnectToken: "reconnect-token"
    });
  });

  it("serializes only fields accepted by the strict server protocol", async () => {
    const session: RoomSession = {
      roomId: "ROOM1234",
      participantId: "participant",
      reconnectToken: "reconnect-token",
      hostToken: "host-token-must-not-be-sent",
      inviteUrl: "http://localhost:5173/?room=ROOM1234",
      seatProfiles: { "ai-1": "server-minimax-m3" },
      seatPersonas: { "ai-1": "maestro" },
      seatPersonaCustomizations: {},
      seatNames: { "ai-1": "Marlow" }
    };
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            jobId: job.jobId,
            status: "ok",
            prompt: "a cat under an umbrella",
            confidence: 0.8,
            reaction: { kind: "spark", text: "Ready." }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await executeServerAi("server-minimax-m3", session, job);

    const request = fetchMock.mock.calls[0]?.[1];
    if (typeof request?.body !== "string") throw new Error("Expected a JSON request body");
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["job", "participantId", "reconnectToken", "roomId"]);
    expect(body).not.toHaveProperty("hostToken");
    expect(body).not.toHaveProperty("inviteUrl");
    expect(body).not.toHaveProperty("seatProfiles");
    expect(body).not.toHaveProperty("seatPersonas");
    expect(body).not.toHaveProperty("seatPersonaCustomizations");
    expect(body).not.toHaveProperty("seatNames");
  });

  it("sends the host grant only for an authenticated post-game review", async () => {
    const session: RoomSession = {
      roomId: "ROOM1234",
      participantId: "participant",
      reconnectToken: "reconnect-token",
      hostToken: "host-review-token",
      seatProfiles: {},
      seatPersonas: {},
      seatPersonaCustomizations: {},
      seatNames: {}
    };
    const reviewJob: AiTurnJob = {
      ...job,
      jobId: "review_ROOM1234_ai-1",
      role: "review",
      inputText: "Original prompt: umbrella. Final result: jellyfish."
    };
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            jobId: reviewJob.jobId,
            status: "ok",
            review: { text: "A bold aquatic interpretation.", score: 4 },
            confidence: 0.8,
            reaction: { kind: "laugh", text: "Unexpected, but committed." }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await executeServerAi("server-minimax-m3", session, reviewJob);

    const request = fetchMock.mock.calls[0]?.[1];
    if (typeof request?.body !== "string") throw new Error("Expected a JSON request body");
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.hostToken).toBe("host-review-token");
    expect(body).not.toHaveProperty("seatProfiles");
    expect(body).not.toHaveProperty("seatPersonas");
  });
});
