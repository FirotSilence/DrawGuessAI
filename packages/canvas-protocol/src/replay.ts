import { activeStrokeCommands } from "./validate";
import type { CanvasCommand, StrokeCommand } from "./schema";

export interface CanvasReplayFrame {
  index: number;
  offsetMs: number;
  command: CanvasCommand;
  activeStrokes: StrokeCommand[];
}

export function buildCanvasReplay(commands: readonly CanvasCommand[]): CanvasReplayFrame[] {
  return commands.map((command, index) => ({
    index,
    offsetMs: command.offsetMs,
    command,
    activeStrokes: activeStrokeCommands(commands.slice(0, index + 1))
  }));
}

export function hashCanvasCommands(commands: readonly CanvasCommand[]): string {
  const value = JSON.stringify(commands);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
