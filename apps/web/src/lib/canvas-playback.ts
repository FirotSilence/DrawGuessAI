import {
  activeCanvasMarkCommands,
  brushPresetForStroke,
  type BrushPreset,
  type CanvasCommand,
  type Point,
  type StrokeCommand
} from "@drawguessai/canvas-protocol";

export interface CanvasPlaybackCursor {
  angleDeg: number;
  brushPreset: BrushPreset;
  color: string;
  point: Point;
  tool: StrokeCommand["tool"];
  width: StrokeCommand["width"];
}

export interface CanvasPlaybackFrame {
  commands: CanvasCommand[];
  cursor?: CanvasPlaybackCursor;
}

export function playbackProgressForRender(
  activeIdentity: string | undefined,
  renderIdentity: string | undefined,
  activeProgress: number
): number {
  if (renderIdentity === undefined) return 1;
  if (activeIdentity !== renderIdentity) return 0;
  return Math.max(0, Math.min(1, activeProgress));
}

export function commandPlaybackWeight(command: CanvasCommand, pendingActions: number): number {
  const base =
    command.type === "stroke"
      ? Math.max(2, command.points.length - 1) + (command.fillColor === undefined ? 0 : 8)
      : command.type === "undo"
        ? 3
        : 0;
  const queueAcceleration =
    pendingActions > 36 ? 0.28 : pendingActions > 18 ? 0.46 : pendingActions > 8 ? 0.7 : 1;
  return Math.max(0.8, base * queueAcceleration);
}

export function strokeAtPlaybackProgress(
  command: StrokeCommand,
  progress: number
): StrokeCommand | undefined {
  if (progress <= 0) return undefined;
  if (progress >= 1) return command;
  const segmentPosition = progress * (command.points.length - 1);
  const completedSegments = Math.floor(segmentPosition);
  const points = command.points.slice(0, completedSegments + 1);
  const start = command.points[completedSegments]!;
  const end = command.points[Math.min(completedSegments + 1, command.points.length - 1)]!;
  const segmentProgress = segmentPosition - completedSegments;
  points.push({
    x: Math.round(start.x + (end.x - start.x) * segmentProgress),
    y: Math.round(start.y + (end.y - start.y) * segmentProgress)
  });
  const partial: StrokeCommand = { ...command, points };
  delete partial.closed;
  delete partial.fillColor;
  return partial;
}

function playbackCursorForStroke(
  command: StrokeCommand,
  partial: StrokeCommand
): CanvasPlaybackCursor | undefined {
  const point = partial.points.at(-1);
  if (point === undefined) return undefined;
  let previous = partial.points.at(-2) ?? point;
  for (let index = partial.points.length - 2; index >= 0; index -= 1) {
    const candidate = partial.points[index]!;
    if (candidate.x !== point.x || candidate.y !== point.y) {
      previous = candidate;
      break;
    }
  }
  return {
    angleDeg: (Math.atan2(point.y - previous.y, point.x - previous.x) * 180) / Math.PI,
    brushPreset: brushPresetForStroke(command),
    color: command.color,
    point,
    tool: command.tool,
    width: command.width
  };
}

export function liveCanvasPlaybackCursor(
  commands: readonly CanvasCommand[]
): CanvasPlaybackCursor | undefined {
  const latest = activeCanvasMarkCommands(commands).at(-1);
  return latest?.type === "stroke" ? playbackCursorForStroke(latest, latest) : undefined;
}

export function canvasPlaybackFrameAtProgress(
  commands: readonly CanvasCommand[],
  progress: number
): CanvasPlaybackFrame {
  if (progress >= 1) return { commands: [...commands] };
  if (progress <= 0) return { commands: [] };
  const drawable = commands.filter((command) => command.type !== "finish");
  const weights = drawable.map((command, index) =>
    commandPlaybackWeight(command, drawable.length - index)
  );
  const target = weights.reduce((sum, weight) => sum + weight, 0) * progress;
  const visible: CanvasCommand[] = [];
  let consumed = 0;
  for (let index = 0; index < drawable.length; index += 1) {
    const command = drawable[index]!;
    const weight = weights[index]!;
    if (consumed + weight <= target) {
      visible.push(command);
      consumed += weight;
      continue;
    }
    if (command.type === "stroke" && target > consumed) {
      const fraction = (target - consumed) / weight;
      const partial = strokeAtPlaybackProgress(command, fraction);
      if (partial !== undefined) {
        visible.push(partial);
        const cursor = playbackCursorForStroke(command, partial);
        return cursor === undefined ? { commands: visible } : { commands: visible, cursor };
      }
    }
    break;
  }
  return { commands: visible };
}

export function commandsAtPlaybackProgress(
  commands: readonly CanvasCommand[],
  progress: number
): CanvasCommand[] {
  return canvasPlaybackFrameAtProgress(commands, progress).commands;
}
