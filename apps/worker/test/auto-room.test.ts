import { AI_DISPLAY_NAMES, AI_PERSONAS, type AiTurnJob } from "@drawguessai/ai-adapters";
import type { PublicAiSeat } from "@drawguessai/network-protocol";
import { createInitialGameState, type GameState } from "@drawguessai/game-core";
import { describe, expect, it, vi } from "vitest";

import {
  AUTOMATED_ROOM_CODE,
  AUTOMATED_ROOM_RETRY_DELAY_MS,
  AutoRoomScheduler,
  hourlyRunBucket,
  nextHourlyRunAt
} from "../src/auto-room";
import { RoomCodeSchema } from "../src/index";
import {
  AUTOMATED_AI_SEAT_COUNT,
  AUTOMATED_AI_TURN_TIMEOUT_SECONDS,
  AUTOMATED_DRAW_ATTEMPT_TIMEOUT_MS,
  AUTOMATED_POST_GAME_REVIEW_TIMEOUT_SECONDS,
  AUTOMATED_SERVER_AI_TIMEOUT_MS,
  automatedAiDisplayNames,
  automatedRoomConfig,
  RoomObject
} from "../src/room";
import { WORKERS_AI_PROFILE_ID, WORKERS_AI_PROFILES } from "../src/server-ai";

const automatedDrawJob: AiTurnJob = {
  jobId: "automated-draw",
  roomId: AUTOMATED_ROOM_CODE,
  turnIndex: 0,
  role: "draw",
  locale: "zh-CN",
  personaId: "maestro",
  inputText: "一把雨伞",
  observationIndex: 0,
  observationLimit: 0,
  timeLimitSeconds: 30,
  budget: {
    maxStrokes: 120,
    maxUndos: 3,
    colorCount: 12,
    remainingStrokes: 120,
    remainingUndos: 3
  }
};

const automatedGuessJob: AiTurnJob = {
  jobId: "automated-guess",
  roomId: AUTOMATED_ROOM_CODE,
  turnIndex: 1,
  role: "guess",
  locale: "zh-CN",
  personaId: "maestro",
  inputCommands: [
    {
      type: "stroke",
      id: "relay-subject",
      tool: "pen",
      color: "#202124",
      width: 8,
      points: [
        { x: 180, y: 560 },
        { x: 500, y: 180 },
        { x: 820, y: 560 }
      ],
      offsetMs: 0
    },
    { type: "finish", id: "relay-finish", offsetMs: 1 }
  ],
  observationIndex: 0,
  observationLimit: 0,
  timeLimitSeconds: 30,
  budget: {
    maxStrokes: 120,
    maxUndos: 3,
    colorCount: 12,
    remainingStrokes: 120,
    remainingUndos: 3
  }
};

const automatedServerSeat: PublicAiSeat = {
  seatId: "auto-ai-1",
  profileId: WORKERS_AI_PROFILE_ID,
  displayName: "小北",
  personaId: "maestro",
  capabilities: WORKERS_AI_PROFILES.find(({ id }) => id === WORKERS_AI_PROFILE_ID)!.capabilities,
  execution: "server",
  ready: true
};

type AutomatedJobRoom = {
  executeAutomatedJob: (seat: PublicAiSeat, job: AiTurnJob) => Promise<unknown>;
};

function roomForAutomatedJob(ai: Ai): AutomatedJobRoom {
  return new RoomObject(
    {
      storage: {
        sql: { exec: vi.fn() }
      }
    } as unknown as DurableObjectState,
    {
      AI: ai,
      ROOM_IDLE_SECONDS: "7200"
    } as ConstructorParameters<typeof RoomObject>[1]
  ) as unknown as AutomatedJobRoom;
}

function roomForRoundtableRecovery() {
  const now = Date.now();
  const values = new Map<string, unknown>();
  const eventPayloads: string[] = [];
  const pendingArchives = new Map<
    string,
    {
      token: string;
      envelope: string;
      attempts: number;
      next_attempt_at: number;
      created_at: number;
      last_error_code?: string;
    }
  >();
  const archiveFetch = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(Response.json({ ok: true }))
  );
  const storage = {
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") {
        values.set(key, value);
      } else {
        for (const [entryKey, entryValue] of Object.entries(key)) values.set(entryKey, entryValue);
      }
      return Promise.resolve();
    },
    setAlarm: vi.fn(() => Promise.resolve()),
    deleteAll: vi.fn(() => Promise.resolve()),
    sql: {
      exec: vi.fn((query: string, ...params: unknown[]) => {
        if (query.includes("INSERT OR IGNORE INTO room_events")) {
          eventPayloads.push(params[4] as string);
        }
        if (query.includes("INSERT INTO pending_match_archives")) {
          const token = params[0] as string;
          const previous = pendingArchives.get(token);
          pendingArchives.set(token, {
            token,
            envelope: params[1] as string,
            attempts: previous?.attempts ?? 0,
            next_attempt_at: params[2] as number,
            created_at: previous?.created_at ?? (params[3] as number)
          });
        }
        if (query.includes("DELETE FROM pending_match_archives")) {
          pendingArchives.delete(params[0] as string);
        }
        if (query.includes("UPDATE pending_match_archives")) {
          const token = params[3] as string;
          const previous = pendingArchives.get(token);
          if (previous !== undefined) {
            pendingArchives.set(token, {
              ...previous,
              attempts: params[0] as number,
              next_attempt_at: params[1] as number,
              last_error_code: params[2] as string
            });
          }
        }
        return {
          toArray: () => {
            if (query.includes("SELECT payload FROM room_events")) {
              return eventPayloads.map((payload) => ({ payload }));
            }
            if (query.includes("SELECT MIN(next_attempt_at)")) {
              const due = [...pendingArchives.values()].map(
                ({ next_attempt_at }) => next_attempt_at
              );
              return [{ next_attempt_at: due.length === 0 ? null : Math.min(...due) }];
            }
            if (
              query.includes("FROM pending_match_archives") &&
              query.includes("WHERE token = ?")
            ) {
              const row = pendingArchives.get(params[0] as string);
              return row === undefined ? [] : [row];
            }
            if (
              query.includes("FROM pending_match_archives") &&
              query.includes("next_attempt_at <= ?")
            ) {
              return [...pendingArchives.values()]
                .filter(({ next_attempt_at }) => next_attempt_at <= (params[0] as number))
                .slice(0, params[1] as number);
            }
            if (query.includes("SELECT token FROM pending_match_archives")) {
              return [...pendingArchives.values()].slice(0, 1);
            }
            return [];
          }
        };
      })
    }
  };
  const state: GameState = {
    ...createInitialGameState(AUTOMATED_ROOM_CODE, "recovery-seed", automatedRoomConfig(), now),
    phase: "complete",
    seq: 9,
    timeline: [
      {
        index: 0,
        role: "draw",
        actorType: "ai",
        actorId: "missing-review-ai",
        displayName: "小北",
        personaId: "maestro"
      }
    ],
    appliedEventIds: ["review_MACH8888_missing-review-ai"],
    artifacts: [
      {
        kind: "prompt",
        turnIndex: -1,
        actorId: "system-auto-host",
        text: "一把雨伞"
      }
    ],
    replayToken: "MACH8888.abcdefghijklmnopqrstuv"
  };
  values.set("room:state", state);
  values.set("room:meta", {
    roomCode: AUTOMATED_ROOM_CODE,
    aiSeats: [],
    aiExecutorId: "system-auto-host",
    lastReactionAt: {},
    automated: true,
    roundEventStartSeq: 1,
    roundStartedAt: now,
    replayExpiresAt: now + 86_400_000,
    automatedRoundtableAt: now - 1
  });
  const room = new RoomObject(
    { storage, getWebSockets: vi.fn(() => []) } as unknown as DurableObjectState,
    {
      MATCHES: { getByName: () => ({ fetch: archiveFetch }) },
      ROOM_IDLE_SECONDS: "7200"
    } as unknown as ConstructorParameters<typeof RoomObject>[1]
  );

  return { room, values, archiveFetch, pendingArchives, deleteAll: storage.deleteAll };
}

function roomForAutomatedJoin(legacyParticipants: GameState["participants"] = []) {
  const now = Date.now();
  const values = new Map<string, unknown>();
  const systemHost: GameState["participants"][number] = {
    id: "system-auto-host",
    displayName: "Auto Host",
    roomRole: "host",
    connected: false,
    hasActed: false
  };
  const state: GameState = {
    ...createInitialGameState(AUTOMATED_ROOM_CODE, "join-seed", automatedRoomConfig(), now),
    participants: [systemHost, ...legacyParticipants]
  };
  values.set("room:state", state);
  values.set("room:meta", {
    roomCode: AUTOMATED_ROOM_CODE,
    aiSeats: [],
    aiExecutorId: systemHost.id,
    lastReactionAt: {},
    automated: true
  });
  values.set("room:credentials", {
    hostHash: "unused",
    participants: Object.fromEntries(
      [systemHost, ...legacyParticipants].map((participant) => [
        participant.id,
        { reconnectHash: "unused" }
      ])
    )
  });
  const closed = new Map(legacyParticipants.map((participant) => [participant.id, vi.fn()]));
  const storage = {
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") values.set(key, value);
      else
        for (const [entryKey, entryValue] of Object.entries(key)) values.set(entryKey, entryValue);
      return Promise.resolve();
    },
    setAlarm: vi.fn(() => Promise.resolve()),
    sql: {
      exec: vi.fn((query: string) => ({
        toArray: () =>
          query.includes("SELECT MIN(next_attempt_at)") ? [{ next_attempt_at: null }] : []
      }))
    }
  };
  const room = new RoomObject(
    {
      storage,
      getWebSockets: vi.fn((tag?: string) =>
        tag !== undefined && closed.has(tag) ? [{ close: closed.get(tag) }] : []
      )
    } as unknown as DurableObjectState,
    { ROOM_IDLE_SECONDS: "7200" } as ConstructorParameters<typeof RoomObject>[1]
  );
  return { room, values, closed };
}

function roomForAutomatedIdentityUpgrade() {
  const now = Date.now();
  const values = new Map<string, unknown>();
  const profile = WORKERS_AI_PROFILES.find(({ id }) => id === WORKERS_AI_PROFILE_ID)!;
  const aiSeats: PublicAiSeat[] = Array.from({ length: AUTOMATED_AI_SEAT_COUNT }, (_, index) => ({
    seatId: `auto-ai-${index + 1}`,
    profileId: profile.id,
    displayName: `AI ${index + 1}`,
    personaId: AI_PERSONAS[index]!.id,
    capabilities: profile.capabilities,
    execution: "server",
    ready: true
  }));
  const host: GameState["participants"][number] = {
    id: "system-auto-host",
    displayName: "Auto Host",
    roomRole: "host",
    connected: false,
    hasActed: false
  };
  const state: GameState = {
    ...createInitialGameState(AUTOMATED_ROOM_CODE, "identity-upgrade", automatedRoomConfig(), now),
    participants: [host],
    timeline: aiSeats.map((seat, index) => ({
      index,
      role: index % 2 === 0 ? "draw" : "guess",
      actorType: "ai",
      actorId: seat.seatId,
      displayName: seat.displayName,
      personaId: seat.personaId
    }))
  };
  values.set("room:state", state);
  values.set("room:meta", {
    roomCode: AUTOMATED_ROOM_CODE,
    aiSeats,
    aiExecutorId: host.id,
    lastReactionAt: {},
    automated: true,
    automatedExecutionVersion: 7
  });
  values.set("room:credentials", {
    hostHash: "unused",
    participants: { [host.id]: { reconnectHash: "unused" } }
  });
  const storage = {
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") values.set(key, value);
      else
        for (const [entryKey, entryValue] of Object.entries(key)) values.set(entryKey, entryValue);
      return Promise.resolve();
    },
    setAlarm: vi.fn(() => Promise.resolve()),
    sql: { exec: vi.fn(() => ({ toArray: () => [] })) }
  };
  const room = new RoomObject(
    {
      storage,
      getWebSockets: vi.fn(() => [])
    } as unknown as DurableObjectState,
    {
      AI: {} as Ai,
      ROOM_IDLE_SECONDS: "7200"
    } as ConstructorParameters<typeof RoomObject>[1]
  );
  return { room, values };
}

describe("automated room scheduling", () => {
  it("does not replace a failed server drawing with the deterministic demo drawing", async () => {
    const room = roomForAutomatedJob({
      run: vi.fn().mockRejectedValue(new Error("offline"))
    } as unknown as Ai);

    await expect(room.executeAutomatedJob(automatedServerSeat, automatedDrawJob)).rejects.toThrow();
  });

  it("attaches a rasterized drawing before the server AI guesses", async () => {
    const response = JSON.stringify({
      jobId: automatedGuessJob.jobId,
      status: "ok",
      guess: "一座房子",
      confidence: 0.7,
      reaction: { kind: "confused", text: "我还在想。" }
    });
    const run = vi.fn().mockResolvedValue({ response });
    const room = roomForAutomatedJob({ run } as unknown as Ai);

    await expect(
      room.executeAutomatedJob(automatedServerSeat, automatedGuessJob)
    ).resolves.toMatchObject({
      status: "ok",
      guess: "一座房子"
    });

    expect(JSON.stringify(run.mock.calls[0]?.[1])).toContain("data:image/png;base64,");
  });

  it("retries a stalled automated drawing inside the real turn deadline", async () => {
    vi.useFakeTimers();
    try {
      const response = JSON.stringify({
        jobId: automatedDrawJob.jobId,
        status: "ok",
        clearCanvas: false,
        commands: [
          {
            type: "stroke",
            id: "recovered-mark",
            tool: "pen",
            color: "#202124",
            width: 8,
            points: [
              { x: 180, y: 180 },
              { x: 520, y: 460 }
            ],
            offsetMs: 0
          },
          { type: "finish", id: "recovered-finish", offsetMs: 1 }
        ],
        confidence: 0.7,
        reaction: { kind: "confused", text: "我有点紧张。" }
      });
      const run = vi
        .fn()
        .mockImplementationOnce(() => new Promise<unknown>(() => undefined))
        .mockResolvedValueOnce({ response });
      const room = roomForAutomatedJob({ run } as unknown as Ai);
      const pending = room.executeAutomatedJob(automatedServerSeat, {
        ...automatedDrawJob,
        timeLimitSeconds: AUTOMATED_AI_TURN_TIMEOUT_SECONDS
      });

      await vi.advanceTimersByTimeAsync(AUTOMATED_DRAW_ATTEMPT_TIMEOUT_MS);

      await expect(pending).resolves.toMatchObject({ status: "ok" });
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an actionable availability error when no real server AI is ready", async () => {
    const scheduler = new AutoRoomScheduler(
      {
        storage: { setAlarm: vi.fn(() => Promise.resolve()) }
      } as unknown as DurableObjectState,
      {
        ROOMS: {
          getByName: () => ({
            fetch: vi.fn(() =>
              Promise.resolve(Response.json({ error: "automated-ai-unavailable" }, { status: 503 }))
            )
          })
        }
      } as unknown as ConstructorParameters<typeof AutoRoomScheduler>[1]
    );

    const response = await scheduler.fetch(
      new Request("https://auto.internal/ensure", { method: "POST" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "automated-ai-unavailable" });
  });

  it("serves repeated public status reads without creating or scheduling a room", async () => {
    const put = vi.fn(() => Promise.resolve());
    const setAlarm = vi.fn(() => Promise.resolve());
    const roomFetch = vi.fn();
    const scheduler = new AutoRoomScheduler(
      {
        storage: {
          get: vi.fn(() => Promise.resolve(undefined)),
          put,
          setAlarm,
          getAlarm: vi.fn(() => Promise.resolve(null))
        }
      } as unknown as DurableObjectState,
      {
        ROOMS: { getByName: () => ({ fetch: roomFetch }) }
      } as unknown as ConstructorParameters<typeof AutoRoomScheduler>[1]
    );

    const first = await scheduler.fetch(new Request("https://auto.internal/status"));
    const second = await scheduler.fetch(new Request("https://auto.internal/status"));

    expect(first.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      roomCode: AUTOMATED_ROOM_CODE,
      available: false,
      status: "not-initialized"
    });
    expect(put).not.toHaveBeenCalled();
    expect(setAlarm).not.toHaveBeenCalled();
    expect(roomFetch).not.toHaveBeenCalled();
  });

  it("rejects player joins to the automated room even while it is in the lobby", async () => {
    const { room, values } = roomForAutomatedJoin();

    const response = await room.fetch(
      new Request("https://room.internal/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Player", joinAs: "player" })
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "automated-room-spectators-only"
    });
    expect((values.get("room:state") as GameState).participants).toHaveLength(1);
  });

  it("removes legacy automated players before admitting a spectator", async () => {
    const legacyPlayers = Array.from({ length: 11 }, (_, index) => ({
      id: `legacy-${index}`,
      displayName: `Legacy ${index}`,
      roomRole: "player" as const,
      connected: true,
      hasActed: false
    }));
    const { room, values, closed } = roomForAutomatedJoin(legacyPlayers);

    const response = await room.fetch(
      new Request("https://room.internal/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Watcher", joinAs: "spectator" })
      })
    );

    expect(response.status).toBe(200);
    const state = values.get("room:state") as GameState;
    expect(state.participants.map(({ roomRole }) => roomRole)).toEqual(["host", "spectator"]);
    expect([...closed.values()].every((close) => close.mock.calls.length === 1)).toBe(true);
    const credentials = values.get("room:credentials") as {
      participants: Record<string, unknown>;
    };
    expect(Object.keys(credentials.participants).some((id) => id.startsWith("legacy-"))).toBe(
      false
    );
  });

  it("uses a valid fixed room code and schedules the next hour boundary", () => {
    expect(RoomCodeSchema.parse(AUTOMATED_ROOM_CODE)).toBe(AUTOMATED_ROOM_CODE);
    expect(AUTOMATED_AI_SEAT_COUNT).toBe(8);
    expect(nextHourlyRunAt(3_600_001)).toBe(7_200_000);
    expect(nextHourlyRunAt(7_199_999)).toBe(7_200_000);
    expect(hourlyRunBucket(7_199_999)).toBe(3_600_000);
  });

  it("gives the automated seats stable, distinct names from the normal-room pool", () => {
    const names = automatedAiDisplayNames("identity-seed");

    expect(names).toHaveLength(AUTOMATED_AI_SEAT_COUNT);
    expect(new Set(names).size).toBe(AUTOMATED_AI_SEAT_COUNT);
    expect(names.every((name) => AI_DISPLAY_NAMES["zh-CN"].includes(name))).toBe(true);
    expect(names.every((name) => !/^AI\s*#?\d+$/i.test(name))).toBe(true);
    expect(automatedAiDisplayNames("identity-seed")).toEqual(names);
    expect(automatedAiDisplayNames("another-seed")).not.toEqual(names);
  });

  it("upgrades an existing numbered automated timeline without renaming it again", async () => {
    const { room, values } = roomForAutomatedIdentityUpgrade();
    const request = () =>
      new Request("https://room.internal/automated/ensure", {
        method: "POST"
      });

    expect((await room.fetch(request())).status).toBe(200);
    const upgraded = values.get("room:state") as GameState;
    const names = upgraded.timeline.map(({ displayName }) => displayName);
    expect(names.every((name) => !/^AI\s*#?\d+$/i.test(name))).toBe(true);
    expect(new Set(names).size).toBe(AUTOMATED_AI_SEAT_COUNT);
    expect(
      (values.get("room:meta") as { automatedNameSeed?: string }).automatedNameSeed
    ).toBeTruthy();

    const sequence = upgraded.seq;
    expect((await room.fetch(request())).status).toBe(200);
    const stable = values.get("room:state") as GameState;
    expect(stable.timeline.map(({ displayName }) => displayName)).toEqual(names);
    expect(stable.seq).toBe(sequence);
  });

  it("gives a real automated drawing enough time without exceeding the hourly run budget", () => {
    const config = automatedRoomConfig();

    expect(config.rules.aiRequestTimeoutSeconds).toBe(120);
    expect(config.rules.guessSeconds).toBe(30);
    expect(AUTOMATED_SERVER_AI_TIMEOUT_MS).toBe(120_000);
    expect(AUTOMATED_AI_TURN_TIMEOUT_SECONDS).toBe(config.rules.aiRequestTimeoutSeconds);

    const drawTurns = Math.ceil(config.rules.chainLength / 2);
    const guessTurns = Math.floor(config.rules.chainLength / 2);
    const maximumScheduledRunSeconds =
      drawTurns * config.rules.aiRequestTimeoutSeconds +
      guessTurns * config.rules.guessSeconds +
      config.rules.chainLength * AUTOMATED_POST_GAME_REVIEW_TIMEOUT_SECONDS;
    expect(maximumScheduledRunSeconds).toBeLessThan(15 * 60);
  });

  it("repairs an automatic replay that completed before its roundtable was saved", async () => {
    const { room, values, archiveFetch } = roomForRoundtableRecovery();

    await room.alarm();

    const state = values.get("room:state") as GameState;
    expect(state.phase).toBe("complete");
    expect(state.postGameReviews).toHaveLength(1);
    expect(state.postGameReviews[0]).toMatchObject({
      seatId: "missing-review-ai",
      status: "departed",
      id: "review_MACH8888_recovery-seed_missing-review-ai"
    });
    expect(archiveFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed archive in the durable outbox and retries it from the alarm", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const { room, values, archiveFetch, pendingArchives } = roomForRoundtableRecovery();
      archiveFetch.mockResolvedValueOnce(Response.json({ error: "offline" }, { status: 503 }));

      await room.alarm();

      expect(pendingArchives.size).toBe(1);
      const pending = [...pendingArchives.values()][0]!;
      expect(pending.attempts).toBe(1);
      const restartable = room as unknown as {
        restartRoom: (
          state: GameState,
          meta: Record<string, unknown>,
          actorId: string
        ) => Promise<GameState>;
      };
      const restarted = await restartable.restartRoom(
        values.get("room:state") as GameState,
        values.get("room:meta") as Record<string, unknown>,
        "system-auto-host"
      );
      expect(restarted.phase).toBe("lobby");
      expect(pendingArchives.size).toBe(1);

      archiveFetch.mockResolvedValueOnce(Response.json({ ok: true }));
      vi.setSystemTime(pending.next_attempt_at);
      await room.alarm();

      expect(pendingArchives.size).toBe(0);
      expect(archiveFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expire an idle room until its pending archive is delivered", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(20_000);
      const { room, values, archiveFetch, pendingArchives, deleteAll } =
        roomForRoundtableRecovery();
      archiveFetch.mockResolvedValueOnce(Response.json({ error: "offline" }, { status: 503 }));
      await room.alarm();

      const pending = [...pendingArchives.values()][0]!;
      const meta = values.get("room:meta") as Record<string, unknown>;
      meta.automated = false;
      meta.idleExpiresAt = Date.now() - 1;
      values.set("room:meta", meta);

      vi.setSystemTime(pending.next_attempt_at - 1);
      await room.alarm();
      expect(deleteAll).not.toHaveBeenCalled();

      archiveFetch.mockResolvedValueOnce(Response.json({ ok: true }));
      vi.setSystemTime(pending.next_attempt_at);
      await room.alarm();
      expect(deleteAll).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backfills a legacy archived automatic replay with match-scoped review ids", async () => {
    const { room, values, archiveFetch } = roomForRoundtableRecovery();
    const archivedState = values.get("room:state") as GameState;
    values.set("room:state", { ...archivedState, phase: "failed" });
    const upserts: unknown[] = [];
    archiveFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/replay/")) {
        return Promise.resolve(
          Response.json({
            roomId: AUTOMATED_ROOM_CODE,
            expiresAt: Date.now() + 86_400_000,
            state: archivedState,
            events: []
          })
        );
      }
      if (url.endsWith("/upsert")) {
        if (typeof init?.body === "string") upserts.push(JSON.parse(init.body) as unknown);
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    const response = await room.fetch(
      new Request("https://room.internal/automated/repair-roundtable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: archivedState.replayToken })
      })
    );

    await expect(response.json()).resolves.toMatchObject({ pending: true });
    const meta = values.get("room:meta") as { automatedArchivedRoundtableAt?: number };
    meta.automatedArchivedRoundtableAt = Date.now() - 1;
    values.set("room:meta", meta);
    await room.alarm();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      payload: {
        state: {
          postGameReviews: [
            {
              id: "review_MACH8888_recovery-seed_missing-review-ai",
              seatId: "missing-review-ai",
              status: "departed"
            }
          ]
        }
      }
    });
  });

  it("deduplicates Cron and alarm deliveries within the same hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_600_001);
    const values = new Map<string, unknown>();
    const roomFetch = vi.fn((url: string) => {
      if (url.endsWith("/automated/ensure")) {
        return Promise.resolve(Response.json({ roomCode: AUTOMATED_ROOM_CODE, created: false }));
      }
      return Promise.resolve(Response.json({ started: true, phase: "complete" }));
    });
    const storage = {
      get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
      put: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
      getAlarm: vi.fn(() => Promise.resolve(undefined)),
      setAlarm: vi.fn(() => Promise.resolve())
    };
    const scheduler = new AutoRoomScheduler(
      { storage } as unknown as DurableObjectState,
      {
        ROOMS: {
          getByName: () => ({ fetch: roomFetch })
        }
      } as unknown as ConstructorParameters<typeof AutoRoomScheduler>[1]
    );

    await scheduler.fetch(new Request("https://auto.internal/tick", { method: "POST" }));
    await scheduler.fetch(new Request("https://auto.internal/tick", { method: "POST" }));

    expect(roomFetch).toHaveBeenCalledTimes(3);
    expect(roomFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://room.internal/automated/ensure",
      "https://room.internal/automated/run",
      "https://room.internal/automated/ensure"
    ]);
    vi.useRealTimers();
  });

  it("retries a failed automated run before marking its hourly bucket complete", async () => {
    vi.useFakeTimers();
    try {
      const hour = 3_600_000;
      vi.setSystemTime(hour + 1);
      const values = new Map<string, unknown>();
      let runs = 0;
      const roomFetch = vi.fn((url: string) => {
        if (url.endsWith("/automated/ensure")) {
          return Promise.resolve(Response.json({ roomCode: AUTOMATED_ROOM_CODE, created: false }));
        }
        runs += 1;
        return Promise.resolve(
          Response.json(
            runs === 1 ? { started: true, phase: "failed" } : { started: true, phase: "complete" }
          )
        );
      });
      const storage = {
        get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
        put: (key: string, value: unknown) => {
          values.set(key, value);
          return Promise.resolve();
        },
        getAlarm: vi.fn(() => Promise.resolve(undefined)),
        setAlarm: vi.fn(() => Promise.resolve())
      };
      const scheduler = new AutoRoomScheduler(
        { storage } as unknown as DurableObjectState,
        {
          ROOMS: {
            getByName: () => ({ fetch: roomFetch })
          }
        } as unknown as ConstructorParameters<typeof AutoRoomScheduler>[1]
      );

      const failed = await scheduler.fetch(
        new Request("https://auto.internal/tick", { method: "POST" })
      );

      await expect(failed.json()).resolves.toMatchObject({
        started: true,
        phase: "failed",
        retrying: true,
        attempt: 1,
        nextRunAt: hour + 1 + AUTOMATED_ROOM_RETRY_DELAY_MS
      });
      expect(values.get("auto-room:last-run-hour")).toBeUndefined();
      const publicStatus = await scheduler.fetch(new Request("https://auto.internal/status"));
      await expect(publicStatus.json()).resolves.toMatchObject({
        status: "retrying",
        nextRunAt: hour + 1 + AUTOMATED_ROOM_RETRY_DELAY_MS,
        attempt: 1
      });

      vi.setSystemTime(hour + 1 + AUTOMATED_ROOM_RETRY_DELAY_MS);
      const recovered = await scheduler.fetch(
        new Request("https://auto.internal/tick", { method: "POST" })
      );

      await expect(recovered.json()).resolves.toMatchObject({
        started: true,
        phase: "complete",
        nextRunAt: hour * 2
      });
      expect(values.get("auto-room:last-run-hour")).toBe(hour);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a failed room even when an older scheduler marked the hour as complete", async () => {
    vi.useFakeTimers();
    try {
      const hour = 3_600_000;
      vi.setSystemTime(hour + 1);
      const values = new Map<string, unknown>([["auto-room:last-run-hour", hour]]);
      const roomFetch = vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith("/automated/ensure")
            ? Response.json({ roomCode: AUTOMATED_ROOM_CODE, phase: "failed" })
            : Response.json({ started: true, phase: "complete" })
        )
      );
      const storage = {
        get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
        put: (key: string, value: unknown) => {
          values.set(key, value);
          return Promise.resolve();
        },
        getAlarm: vi.fn(() => Promise.resolve(undefined)),
        setAlarm: vi.fn(() => Promise.resolve())
      };
      const scheduler = new AutoRoomScheduler(
        { storage } as unknown as DurableObjectState,
        {
          ROOMS: {
            getByName: () => ({ fetch: roomFetch })
          }
        } as unknown as ConstructorParameters<typeof AutoRoomScheduler>[1]
      );

      const response = await scheduler.fetch(
        new Request("https://auto.internal/tick", { method: "POST" })
      );

      await expect(response.json()).resolves.toMatchObject({
        started: true,
        phase: "complete",
        nextRunAt: hour * 2
      });
      expect(roomFetch.mock.calls.map(([url]) => url)).toEqual([
        "https://room.internal/automated/ensure",
        "https://room.internal/automated/run"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
