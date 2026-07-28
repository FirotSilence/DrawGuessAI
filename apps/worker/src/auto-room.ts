import type { Env } from "./env";

export const AUTOMATED_ROOM_CODE = "MACH8888";
export const AUTOMATED_ROOM_SCHEDULER = "drawguessai-hourly-auto-room";
const HOUR_MS = 3_600_000;
const LAST_RUN_HOUR_KEY = "auto-room:last-run-hour";
const NEXT_RUN_AT_KEY = "auto-room:next-run-at";
const RUN_ATTEMPTS_KEY = "auto-room:run-attempts";
const STATUS_KEY = "auto-room:status";
export const AUTOMATED_ROOM_RETRY_DELAY_MS = 120_000;
export const AUTOMATED_ROOM_MAX_ATTEMPTS_PER_HOUR = 3;

interface AutomatedRunAttempts {
  hour: number;
  attempts: number;
}

type AutomatedRoomStatusName =
  "not-initialized" | "scheduled" | "running" | "retrying" | "settling";

interface StoredAutomatedRoomStatus {
  available: boolean;
  status: Exclude<AutomatedRoomStatusName, "not-initialized">;
  updatedAt: number;
  phase?: string;
  replayToken?: string;
  error?: string;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

export function nextHourlyRunAt(now = Date.now()): number {
  return (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;
}

export function hourlyRunBucket(now = Date.now()): number {
  return Math.floor(now / HOUR_MS) * HOUR_MS;
}

export class AutoRoomScheduler {
  constructor(
    private readonly objectState: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status" && request.method === "GET") {
      return this.readStatus();
    }
    if (url.pathname === "/ensure" && request.method === "POST") {
      return this.ensureAndSchedule();
    }
    if (url.pathname === "/tick" && request.method === "POST") {
      const result = await this.runOnce();
      return json({ roomCode: AUTOMATED_ROOM_CODE, ...result });
    }
    return json({ error: "not-found" }, 404);
  }

  private async readStatus(): Promise<Response> {
    const [stored, nextRunAt, attempts] = await Promise.all([
      this.objectState.storage.get<StoredAutomatedRoomStatus>(STATUS_KEY),
      this.objectState.storage.get<number>(NEXT_RUN_AT_KEY),
      this.objectState.storage.get<AutomatedRunAttempts>(RUN_ATTEMPTS_KEY)
    ]);
    if (stored === undefined) {
      return json({
        roomCode: AUTOMATED_ROOM_CODE,
        available: false,
        status: "not-initialized" satisfies AutomatedRoomStatusName,
        nextRunAt: nextRunAt ?? nextHourlyRunAt()
      });
    }
    return json({
      roomCode: AUTOMATED_ROOM_CODE,
      available: stored.available,
      status: stored.status,
      nextRunAt: nextRunAt ?? nextHourlyRunAt(),
      updatedAt: stored.updatedAt,
      ...(stored.phase === undefined ? {} : { phase: stored.phase }),
      ...(stored.replayToken === undefined ? {} : { replayToken: stored.replayToken }),
      ...(stored.error === undefined ? {} : { error: stored.error }),
      ...(stored.status !== "retrying" || attempts === undefined
        ? {}
        : { attempt: attempts.attempts })
    });
  }

  private async roomFetch(path: string): Promise<Response> {
    return this.env.ROOMS.getByName(AUTOMATED_ROOM_CODE).fetch(`https://room.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" }
    });
  }

  private async ensureRoom(): Promise<Response> {
    return this.roomFetch("/automated/ensure");
  }

  private async setStatus(status: StoredAutomatedRoomStatus): Promise<void> {
    await this.objectState.storage.put(STATUS_KEY, status);
  }

  private async scheduleRun(at: number): Promise<void> {
    const [storedAt, alarmAt] = await Promise.all([
      this.objectState.storage.get<number>(NEXT_RUN_AT_KEY),
      this.objectState.storage.getAlarm()
    ]);
    const writes: Promise<unknown>[] = [];
    if (storedAt !== at) writes.push(this.objectState.storage.put(NEXT_RUN_AT_KEY, at));
    if (alarmAt !== at) writes.push(this.objectState.storage.setAlarm(at));
    await Promise.all(writes);
  }

  private statusFromPayload(
    payload: Record<string, unknown>,
    status: StoredAutomatedRoomStatus["status"],
    options: { available?: boolean; error?: string } = {}
  ): StoredAutomatedRoomStatus {
    const phase = stringProperty(payload, "phase");
    const replayToken = stringProperty(payload, "replayToken");
    return {
      available: options.available ?? true,
      status,
      updatedAt: Date.now(),
      ...(phase === undefined ? {} : { phase }),
      ...(replayToken === undefined ? {} : { replayToken }),
      ...(options.error === undefined ? {} : { error: options.error })
    };
  }

  private async ensureAndSchedule(): Promise<Response> {
    const response = await this.ensureRoom();
    if (!response.ok) return response;
    const ensured = (await response.json()) as Record<string, unknown>;
    const nextRunAt =
      (await this.objectState.storage.get<number>(NEXT_RUN_AT_KEY)) ?? nextHourlyRunAt();
    await this.scheduleRun(nextRunAt);
    await this.setStatus(this.statusFromPayload(ensured, "scheduled"));
    return json({ roomCode: AUTOMATED_ROOM_CODE, nextRunAt, ...ensured });
  }

  private async scheduleRetry(now: number, currentHour: number): Promise<Record<string, unknown>> {
    const previous = await this.objectState.storage.get<AutomatedRunAttempts>(RUN_ATTEMPTS_KEY);
    const attempts = previous?.hour === currentHour ? previous.attempts + 1 : 1;
    const nextHour = nextHourlyRunAt(now);
    const retryAt = Math.min(now + AUTOMATED_ROOM_RETRY_DELAY_MS, nextHour);
    const nextRunAt = attempts < AUTOMATED_ROOM_MAX_ATTEMPTS_PER_HOUR ? retryAt : nextHour;
    await this.objectState.storage.put(RUN_ATTEMPTS_KEY, { hour: currentHour, attempts });
    await this.scheduleRun(nextRunAt);
    return {
      nextRunAt,
      retrying: nextRunAt !== nextHour,
      attempt: attempts
    };
  }

  private async scheduleHourlyRun(currentHour: number, nextRunAt: number): Promise<void> {
    await this.objectState.storage.put(LAST_RUN_HOUR_KEY, currentHour);
    await this.objectState.storage.put(RUN_ATTEMPTS_KEY, { hour: currentHour, attempts: 0 });
    await this.scheduleRun(nextRunAt);
  }

  private async failedRun(
    now: number,
    currentHour: number,
    error: string,
    payload: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const retry = await this.scheduleRetry(now, currentHour);
    await this.setStatus(
      this.statusFromPayload(payload, retry.retrying === true ? "retrying" : "scheduled", {
        available: false,
        error
      })
    );
    return { started: false, ...payload, ...retry, error };
  }

  private async runOnce(): Promise<Record<string, unknown>> {
    const now = Date.now();
    const currentHour = hourlyRunBucket(now);
    const nextRunAt = nextHourlyRunAt(now);
    const [lastRunHour, previousStatus] = await Promise.all([
      this.objectState.storage.get<number>(LAST_RUN_HOUR_KEY),
      this.objectState.storage.get<StoredAutomatedRoomStatus>(STATUS_KEY)
    ]);
    await this.setStatus({
      available: previousStatus?.available ?? false,
      status: "running",
      updatedAt: now,
      ...(previousStatus?.phase === undefined ? {} : { phase: previousStatus.phase }),
      ...(previousStatus?.replayToken === undefined
        ? {}
        : { replayToken: previousStatus.replayToken })
    });
    try {
      let ensured: Response;
      if (lastRunHour === currentHour) {
        ensured = await this.ensureRoom();
        if (!ensured.ok) {
          const payload = (await ensured.json().catch(() => ({}))) as Record<string, unknown>;
          return this.failedRun(
            now,
            currentHour,
            stringProperty(payload, "error") ?? "automated-room-run-failed",
            payload
          );
        }
        const existing = (await ensured.json().catch(() => ({}))) as Record<string, unknown>;
        if (existing.phase !== "failed") {
          await this.scheduleRun(nextRunAt);
          await this.setStatus(this.statusFromPayload(existing, "scheduled"));
          return { started: false, skipped: true, nextRunAt };
        }
      } else {
        ensured = await this.ensureRoom();
      }
      if (!ensured.ok) {
        const payload = (await ensured.json().catch(() => ({}))) as Record<string, unknown>;
        return this.failedRun(
          now,
          currentHour,
          stringProperty(payload, "error") ?? "automated-room-run-failed",
          payload
        );
      }
      const response = await this.roomFetch("/automated/run");
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        return this.failedRun(
          now,
          currentHour,
          stringProperty(payload, "error") ?? "automated-room-run-failed",
          payload
        );
      }
      const result = (await response.json()) as Record<string, unknown>;
      if (result.started === true && result.phase !== "failed") {
        await this.scheduleHourlyRun(currentHour, nextRunAt);
        await this.setStatus(this.statusFromPayload(result, "scheduled"));
        return { ...result, nextRunAt };
      }
      const retry = await this.scheduleRetry(now, currentHour);
      const settling = result.settling === true || result.repairingReplay === true;
      await this.setStatus(
        this.statusFromPayload(
          result,
          retry.retrying === true ? (settling ? "settling" : "retrying") : "scheduled",
          {
            available: result.phase !== "failed",
            ...(!settling && typeof result.error === "string" ? { error: result.error } : {})
          }
        )
      );
      return { ...result, ...retry };
    } catch {
      return this.failedRun(now, currentHour, "automated-room-run-failed");
    }
  }

  async alarm(): Promise<void> {
    await this.runOnce();
  }
}
