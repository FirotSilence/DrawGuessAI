import { z } from "zod";

import { hashToken } from "./tokens";

const MAX_PAGE_SIZE = 24;
const EXPIRED_CLEANUP_BATCH = 100;
const PERMANENT_LIKE_THRESHOLD = 3;
const MAX_PERMANENT_MATCHES = 500;
const MAX_PERMANENT_PAYLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_REPLAY_RETENTION_MS = 7 * 86_400_000;

const MatchSummarySchema = z
  .object({
    token: z.string().min(20).max(200),
    roomId: z.string().min(1).max(100),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    mode: z.enum(["ai-theatre", "blind-relay"]),
    locale: z.enum(["zh-CN", "en"]),
    prompt: z.string().min(1).max(160),
    playerCount: z.number().int().min(1).max(12),
    turnCount: z.number().int().min(1).max(12)
  })
  .strict();

const ArchiveUpsertSchema = z
  .object({
    summary: MatchSummarySchema,
    payload: z.unknown()
  })
  .strict();

const ViewerIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{16,96}$/);

const LikeRequestSchema = z
  .object({
    viewerId: ViewerIdSchema,
    voterNetworkKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  })
  .strict();

const PurgeRoomRequestSchema = z
  .object({
    roomId: z.string().min(1).max(100)
  })
  .strict();

const CursorSchema = z.string().regex(/^\d{1,16}:[A-Za-z0-9._-]{20,200}$/);

interface MatchRow {
  [key: string]: string | number | null;
  token: string;
  room_id: string;
  started_at: number;
  completed_at: number;
  expires_at: number | null;
  permanent: number;
  like_count: number;
  mode: "ai-theatre" | "blind-relay";
  locale: "zh-CN" | "en";
  prompt: string;
  player_count: number;
  turn_count: number;
  payload_bytes: number;
}

interface ArchivedPayload {
  protocolVersion: 1;
  roomId: string;
  state: unknown;
  events: unknown[];
  expiresAt?: number;
  permanent?: boolean;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function payloadKey(token: string): string {
  return `match:payload:${token}`;
}

function parseCursor(
  cursor: string | undefined
): { completedAt: number; token: string } | undefined {
  if (cursor === undefined || cursor === "") return undefined;
  const parsed = CursorSchema.safeParse(cursor);
  if (!parsed.success) throw new Error("Invalid pagination cursor");
  const separator = parsed.data.indexOf(":");
  return {
    completedAt: Number(parsed.data.slice(0, separator)),
    token: parsed.data.slice(separator + 1)
  };
}

function rowSummary(row: MatchRow, liked: boolean) {
  return {
    token: row.token,
    roomId: row.room_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    permanent: row.permanent === 1,
    likeCount: row.like_count,
    liked,
    mode: row.mode,
    locale: row.locale,
    prompt: row.prompt,
    playerCount: row.player_count,
    turnCount: row.turn_count
  };
}

export class MatchArchiveObject {
  constructor(private readonly objectState: DurableObjectState) {
    this.objectState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS match_index (
        token TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        expires_at INTEGER,
        permanent INTEGER NOT NULL DEFAULT 0,
        like_count INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL,
        locale TEXT NOT NULL,
        prompt TEXT NOT NULL,
        player_count INTEGER NOT NULL,
        turn_count INTEGER NOT NULL,
        payload_bytes INTEGER NOT NULL DEFAULT 0
      )
    `);
    const matchColumns = this.objectState.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(match_index)")
      .toArray();
    if (!matchColumns.some(({ name }) => name === "payload_bytes")) {
      this.objectState.storage.sql.exec(
        "ALTER TABLE match_index ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0"
      );
    }
    this.objectState.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS match_index_recent
      ON match_index (completed_at DESC, token DESC)
    `);
    this.objectState.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS match_index_expiry
      ON match_index (permanent, expires_at)
    `);
    this.objectState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS match_likes (
        token TEXT NOT NULL,
        viewer_hash TEXT NOT NULL,
        network_hash TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (token, viewer_hash)
      )
    `);
    const likeColumns = this.objectState.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(match_likes)")
      .toArray();
    if (!likeColumns.some(({ name }) => name === "network_hash")) {
      this.objectState.storage.sql.exec("ALTER TABLE match_likes ADD COLUMN network_hash TEXT");
    }
    this.objectState.storage.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS match_likes_network
      ON match_likes (token, network_hash)
      WHERE network_hash IS NOT NULL
    `);
    this.objectState.storage.sql.exec(
      `
        UPDATE match_index
        SET permanent = 0,
            expires_at = COALESCE(expires_at, completed_at + ?)
        WHERE permanent = 1 AND like_count < ?
      `,
      DEFAULT_REPLAY_RETENTION_MS,
      PERMANENT_LIKE_THRESHOLD
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/upsert" && request.method === "POST") {
        return this.upsert(await request.json());
      }
      if (url.pathname === "/list" && request.method === "GET") {
        return this.list(url);
      }
      if (url.pathname.startsWith("/replay/") && request.method === "GET") {
        return this.replay(decodeURIComponent(url.pathname.slice("/replay/".length)), url);
      }
      if (url.pathname.startsWith("/like/") && request.method === "POST") {
        return this.like(
          decodeURIComponent(url.pathname.slice("/like/".length)),
          await request.json()
        );
      }
      if (url.pathname === "/purge-room" && request.method === "POST") {
        return this.purgeNonPermanentRoom(await request.json());
      }
    } catch (error) {
      return json(
        {
          error: "invalid-request",
          message: error instanceof Error ? error.message.slice(0, 160) : "Invalid request"
        },
        400
      );
    }
    return json({ error: "not-found" }, 404);
  }

  private async upsert(raw: unknown): Promise<Response> {
    const { summary, payload } = ArchiveUpsertSchema.parse(raw);
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    this.objectState.storage.sql.exec(
      `
        INSERT INTO match_index (
          token, room_id, started_at, completed_at, expires_at, permanent, like_count,
          mode, locale, prompt, player_count, turn_count, payload_bytes
        ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET
          room_id = excluded.room_id,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          expires_at = CASE WHEN match_index.permanent = 1 THEN NULL ELSE excluded.expires_at END,
          mode = excluded.mode,
          locale = excluded.locale,
          prompt = excluded.prompt,
          player_count = excluded.player_count,
          turn_count = excluded.turn_count,
          payload_bytes = excluded.payload_bytes
      `,
      summary.token,
      summary.roomId,
      summary.startedAt,
      summary.completedAt,
      summary.expiresAt,
      summary.mode,
      summary.locale,
      summary.prompt,
      summary.playerCount,
      summary.turnCount,
      payloadBytes
    );
    await this.objectState.storage.put(payloadKey(summary.token), payload);
    await this.enforcePermanentRetention();
    await this.scheduleExpiryCleanup();
    return json({ ok: true });
  }

  private async list(url: URL): Promise<Response> {
    await this.cleanupExpired();
    const parsedLimit = z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .safeParse(url.searchParams.get("limit") ?? "12");
    if (!parsedLimit.success) throw new Error("Invalid page size");
    const cursor = parseCursor(url.searchParams.get("cursor") ?? undefined);
    const viewerId = url.searchParams.get("viewerId") ?? undefined;
    const viewerHash =
      viewerId === undefined ? undefined : await hashToken(ViewerIdSchema.parse(viewerId));
    const limit = parsedLimit.data;
    const rows =
      cursor === undefined
        ? this.objectState.storage.sql
            .exec<MatchRow>(
              `
                SELECT token, room_id, started_at, completed_at, expires_at, permanent, like_count,
                       mode, locale, prompt, player_count, turn_count
                FROM match_index
                ORDER BY completed_at DESC, token DESC
                LIMIT ?
              `,
              limit + 1
            )
            .toArray()
        : this.objectState.storage.sql
            .exec<MatchRow>(
              `
                SELECT token, room_id, started_at, completed_at, expires_at, permanent, like_count,
                       mode, locale, prompt, player_count, turn_count
                FROM match_index
                WHERE completed_at < ? OR (completed_at = ? AND token < ?)
                ORDER BY completed_at DESC, token DESC
                LIMIT ?
              `,
              cursor.completedAt,
              cursor.completedAt,
              cursor.token,
              limit + 1
            )
            .toArray();
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row) => rowSummary(row, this.hasLiked(row.token, viewerHash)));
    const last = pageRows.at(-1);
    return json({
      items,
      nextCursor:
        rows.length > limit && last !== undefined ? `${last.completed_at}:${last.token}` : undefined
    });
  }

  private async replay(token: string, url: URL): Promise<Response> {
    await this.cleanupExpired();
    const row = this.find(token);
    if (row === undefined) return json({ error: "replay-not-found" }, 404);
    const payload = await this.objectState.storage.get<ArchivedPayload>(payloadKey(token));
    if (payload === undefined) return json({ error: "replay-not-found" }, 404);
    const viewerId = url.searchParams.get("viewerId") ?? undefined;
    const viewerHash =
      viewerId === undefined ? undefined : await hashToken(ViewerIdSchema.parse(viewerId));
    const archive = { ...payload };
    delete archive.expiresAt;
    delete archive.permanent;
    return json({
      ...archive,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      permanent: row.permanent === 1,
      likeCount: row.like_count,
      liked: this.hasLiked(token, viewerHash)
    });
  }

  private async like(token: string, raw: unknown): Promise<Response> {
    const { viewerId, voterNetworkKey } = LikeRequestSchema.parse(raw);
    await this.cleanupExpired();
    const row = this.find(token);
    if (row === undefined) return json({ error: "match-not-found" }, 404);
    const viewerHash = await hashToken(viewerId);
    const existing = this.objectState.storage.sql
      .exec<{ viewer_hash: string }>(
        `
          SELECT viewer_hash
          FROM match_likes
          WHERE token = ? AND (viewer_hash = ? OR network_hash = ?)
          LIMIT 1
        `,
        token,
        viewerHash,
        voterNetworkKey
      )
      .toArray();
    if (existing.length === 0) {
      this.objectState.storage.sql.exec(
        `
          INSERT INTO match_likes (token, viewer_hash, network_hash, created_at)
          VALUES (?, ?, ?, ?)
        `,
        token,
        viewerHash,
        voterNetworkKey,
        Date.now()
      );
      this.objectState.storage.sql.exec(
        `
          UPDATE match_index
          SET like_count = like_count + 1,
              permanent = CASE
                WHEN like_count + 1 >= ? THEN 1
                ELSE permanent
              END,
              expires_at = CASE
                WHEN like_count + 1 >= ? THEN NULL
                ELSE expires_at
              END
          WHERE token = ?
        `,
        PERMANENT_LIKE_THRESHOLD,
        PERMANENT_LIKE_THRESHOLD,
        token
      );
      await this.enforcePermanentRetention();
    }
    const updated = this.find(token);
    if (updated === undefined) return json({ error: "match-not-found" }, 404);
    return json(rowSummary(updated, this.hasLiked(token, viewerHash)));
  }

  private async purgeNonPermanentRoom(raw: unknown): Promise<Response> {
    const { roomId } = PurgeRoomRequestSchema.parse(raw);
    const rows = this.objectState.storage.sql
      .exec<{ token: string }>(
        "SELECT token FROM match_index WHERE room_id = ? AND permanent = 0",
        roomId
      )
      .toArray();
    for (const { token } of rows) {
      await this.objectState.storage.delete(payloadKey(token));
      this.objectState.storage.sql.exec("DELETE FROM match_likes WHERE token = ?", token);
    }
    this.objectState.storage.sql.exec(
      "DELETE FROM match_index WHERE room_id = ? AND permanent = 0",
      roomId
    );
    await this.scheduleExpiryCleanup();
    return json({ removed: rows.length });
  }

  private find(token: string): MatchRow | undefined {
    return this.objectState.storage.sql
      .exec<MatchRow>(
        `
          SELECT token, room_id, started_at, completed_at, expires_at, permanent, like_count,
                 mode, locale, prompt, player_count, turn_count
          FROM match_index
          WHERE token = ?
          LIMIT 1
        `,
        token
      )
      .toArray()[0];
  }

  private hasLiked(token: string, viewerHash: string | undefined): boolean {
    if (viewerHash === undefined) return false;
    return (
      this.objectState.storage.sql
        .exec<{ token: string }>(
          "SELECT token FROM match_likes WHERE token = ? AND viewer_hash = ? LIMIT 1",
          token,
          viewerHash
        )
        .toArray().length > 0
    );
  }

  private async deleteArchivedMatch(token: string): Promise<void> {
    await this.objectState.storage.delete(payloadKey(token));
    this.objectState.storage.sql.exec("DELETE FROM match_likes WHERE token = ?", token);
    this.objectState.storage.sql.exec("DELETE FROM match_index WHERE token = ?", token);
  }

  private async enforcePermanentRetention(): Promise<void> {
    const rows = this.objectState.storage.sql
      .exec<{ token: string; payload_bytes: number }>(
        `
          SELECT token, payload_bytes
          FROM match_index
          WHERE permanent = 1
          ORDER BY completed_at DESC, token DESC
        `
      )
      .toArray();
    let retainedBytes = 0;
    for (const [index, row] of rows.entries()) {
      const nextBytes = retainedBytes + Math.max(0, row.payload_bytes);
      if (index >= MAX_PERMANENT_MATCHES || nextBytes > MAX_PERMANENT_PAYLOAD_BYTES) {
        await this.deleteArchivedMatch(row.token);
      } else {
        retainedBytes = nextBytes;
      }
    }
  }

  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const rows = this.objectState.storage.sql
      .exec<{ token: string }>(
        `
          SELECT token FROM match_index
          WHERE permanent = 0 AND expires_at IS NOT NULL AND expires_at <= ?
          ORDER BY expires_at ASC
          LIMIT ?
        `,
        now,
        EXPIRED_CLEANUP_BATCH
      )
      .toArray();
    for (const { token } of rows) {
      await this.deleteArchivedMatch(token);
    }
    await this.scheduleExpiryCleanup();
  }

  private async scheduleExpiryCleanup(): Promise<void> {
    const next = this.objectState.storage.sql
      .exec<{ expires_at: number }>(
        `
          SELECT MIN(expires_at) AS expires_at
          FROM match_index
          WHERE permanent = 0 AND expires_at IS NOT NULL
        `
      )
      .toArray()[0]?.expires_at;
    if (typeof next === "number") await this.objectState.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    await this.cleanupExpired();
  }
}
