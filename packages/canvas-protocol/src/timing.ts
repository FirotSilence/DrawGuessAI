import { MAX_COMMAND_OFFSET_MS } from "./constants";
import type { CanvasCommand } from "./schema";

function clampCommandOffset(offsetMs: number): number {
  return Math.min(MAX_COMMAND_OFFSET_MS, Math.max(0, Math.round(offsetMs)));
}

export function toCanvasCommandOffsetMs(nowMs: number, turnStartedAtMs: number): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(turnStartedAtMs)) return 0;
  return clampCommandOffset(nowMs - turnStartedAtMs);
}

export function normalizeCanvasCommandOffsets(commands: readonly CanvasCommand[]): CanvasCommand[] {
  const firstOffset = commands[0]?.offsetMs ?? 0;
  const needsRebase = commands.some(
    (command) =>
      !Number.isFinite(command.offsetMs) ||
      command.offsetMs < 0 ||
      command.offsetMs > MAX_COMMAND_OFFSET_MS
  );
  const origin = needsRebase && Number.isFinite(firstOffset) ? firstOffset : 0;
  let previousOffset = 0;

  return commands.map((command) => {
    const candidate = Number.isFinite(command.offsetMs)
      ? clampCommandOffset(command.offsetMs - origin)
      : previousOffset;
    const offsetMs = Math.max(previousOffset, candidate);
    previousOffset = offsetMs;
    return { ...command, offsetMs };
  });
}
