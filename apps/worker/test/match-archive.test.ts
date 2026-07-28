import { describe, expect, it, vi } from "vitest";

import { MatchArchiveObject } from "../src/match-archive";

function archiveForLikes() {
  const token = "MACH8888.abcdefghijklmnopqrstuv";
  const row = {
    token,
    room_id: "MACH8888",
    started_at: 1,
    completed_at: 2,
    expires_at: (Date.now() + 86_400_000) as number | null,
    permanent: 0,
    like_count: 0,
    mode: "ai-theatre" as const,
    locale: "zh-CN" as const,
    prompt: "一把雨伞",
    player_count: 8,
    turn_count: 8,
    payload_bytes: 1024
  };
  const likes: { viewer_hash: string; network_hash: string }[] = [];
  const exec = vi.fn((query: string, ...params: unknown[]) => {
    if (query.includes("PRAGMA table_info(match_index)")) {
      return { toArray: () => [{ name: "payload_bytes" }] };
    }
    if (query.includes("PRAGMA table_info(match_likes)")) {
      return { toArray: () => [{ name: "network_hash" }] };
    }
    if (query.includes("SELECT token FROM match_index") && query.includes("expires_at <= ?")) {
      return { toArray: () => [] };
    }
    if (query.includes("SELECT MIN(expires_at)")) {
      return { toArray: () => [{ expires_at: row.expires_at }] };
    }
    if (query.includes("FROM match_index") && query.includes("WHERE token = ?")) {
      return { toArray: () => [row] };
    }
    if (query.includes("SELECT viewer_hash") && query.includes("network_hash = ?")) {
      const match = likes.find(
        (like) => like.viewer_hash === params[1] || like.network_hash === params[2]
      );
      return { toArray: () => (match === undefined ? [] : [match]) };
    }
    if (query.includes("INSERT INTO match_likes")) {
      likes.push({
        viewer_hash: params[1] as string,
        network_hash: params[2] as string
      });
    }
    if (query.includes("SET like_count = like_count + 1")) {
      row.like_count += 1;
      if (row.like_count >= 3) {
        row.permanent = 1;
        row.expires_at = null;
      }
    }
    if (query.includes("SELECT token FROM match_likes") && query.includes("viewer_hash = ?")) {
      const match = likes.find((like) => like.viewer_hash === params[1]);
      return { toArray: () => (match === undefined ? [] : [{ token }]) };
    }
    if (query.includes("WHERE permanent = 1") && query.includes("payload_bytes")) {
      return {
        toArray: () =>
          row.permanent === 1 ? [{ token: row.token, payload_bytes: row.payload_bytes }] : []
      };
    }
    return { toArray: () => [] };
  });
  const storage = {
    sql: { exec },
    delete: vi.fn(() => Promise.resolve()),
    setAlarm: vi.fn(() => Promise.resolve())
  };
  return {
    token,
    row,
    archive: new MatchArchiveObject({ storage } as unknown as DurableObjectState)
  };
}

describe("match archive", () => {
  it("removes only unliked legacy automated matches and their payloads", async () => {
    const exec = vi.fn((query: string) => {
      if (query.includes("SELECT token FROM match_index WHERE room_id")) {
        return {
          toArray: () =>
            query.includes("permanent = 0")
              ? [{ token: "MACH8888.legacy-unliked-match" }]
              : [
                  { token: "MACH8888.legacy-unliked-match" },
                  { token: "MACH8888.legacy-permanent-match" }
                ]
        };
      }
      return { toArray: () => [] };
    });
    const storage = {
      sql: { exec },
      delete: vi.fn(() => Promise.resolve()),
      setAlarm: vi.fn(() => Promise.resolve())
    };
    const archive = new MatchArchiveObject({ storage } as unknown as DurableObjectState);

    const response = await archive.fetch(
      new Request("https://matches.internal/purge-room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: "MACH8888" })
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ removed: 1 });
    expect(storage.delete).toHaveBeenCalledWith("match:payload:MACH8888.legacy-unliked-match");
    expect(storage.delete).not.toHaveBeenCalledWith(
      "match:payload:MACH8888.legacy-permanent-match"
    );
    expect(exec.mock.calls.some(([query]) => query.includes("permanent = 0"))).toBe(true);
  });

  it("returns the replay viewer's existing like state", async () => {
    const token = "MACH8888.abcdefghijklmnopqrstuv";
    const row = {
      token,
      room_id: "MACH8888",
      started_at: 1,
      completed_at: 2,
      expires_at: 3,
      permanent: 0,
      like_count: 1,
      mode: "ai-theatre" as const,
      locale: "zh-CN" as const,
      prompt: "一把雨伞",
      player_count: 8,
      turn_count: 8
    };
    const exec = vi.fn((query: string) => {
      if (query.includes("FROM match_index") && query.includes("WHERE token = ?")) {
        return { toArray: () => [row] };
      }
      if (query.includes("FROM match_likes")) {
        return { toArray: () => [{ token }] };
      }
      return { toArray: () => [] };
    });
    const storage = {
      sql: { exec },
      get: vi.fn(() =>
        Promise.resolve({ protocolVersion: 1, roomId: "MACH8888", state: {}, events: [] })
      ),
      setAlarm: vi.fn(() => Promise.resolve())
    };
    const archive = new MatchArchiveObject({ storage } as unknown as DurableObjectState);

    const response = await archive.fetch(
      new Request(`https://matches.internal/replay/${token}?viewerId=viewer-identifier-123456`)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ likeCount: 1, liked: true });
  });

  it("requires three independent voters before granting long-term retention", async () => {
    const { archive, token } = archiveForLikes();
    const like = (viewer: number, network: number) =>
      archive.fetch(
        new Request(`https://matches.internal/like/${token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            viewerId: `viewer-identifier-${viewer.toString().padStart(8, "0")}`,
            voterNetworkKey: network.toString(36).padStart(43, "0")
          })
        })
      );

    await expect((await like(1, 1)).json()).resolves.toMatchObject({
      likeCount: 1,
      permanent: false
    });
    await expect((await like(2, 2)).json()).resolves.toMatchObject({
      likeCount: 2,
      permanent: false
    });
    await expect((await like(3, 3)).json()).resolves.toMatchObject({
      likeCount: 3,
      permanent: true
    });
  });

  it("does not count forged viewer ids again from the same network", async () => {
    const { archive, token } = archiveForLikes();
    const network = "a".repeat(43);
    const request = (viewerId: string) =>
      new Request(`https://matches.internal/like/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewerId, voterNetworkKey: network })
      });

    await archive.fetch(request("viewer-identifier-00000001"));
    const duplicate = await archive.fetch(request("viewer-identifier-00000002"));

    await expect(duplicate.json()).resolves.toMatchObject({
      likeCount: 1,
      permanent: false,
      liked: false
    });
  });
});
