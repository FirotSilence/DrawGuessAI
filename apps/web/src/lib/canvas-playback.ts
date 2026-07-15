import type { CanvasCommand, StrokeCommand } from "@drawguessai/canvas-protocol";

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

export function commandsAtPlaybackProgress(
  commands: readonly CanvasCommand[],
  progress: number
): CanvasCommand[] {
  if (progress >= 1) return [...commands];
  if (progress <= 0) return [];
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
      if (partial !== undefined) visible.push(partial);
    }
    break;
  }
  return visible;
}
