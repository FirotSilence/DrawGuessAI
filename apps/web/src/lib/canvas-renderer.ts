import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  PAPER_COLOR,
  activeCanvasMarkCommands,
  brushLayersForStroke,
  strokeWidthProfileForRender,
  strokeWidthScaleAt,
  type BrushRenderPoint,
  type CanvasCommand,
  type FillCommand,
  type StrokeCommand,
  type StrokeWidthProfile
} from "@drawguessai/canvas-protocol";

export { strokeWidthScaleAt } from "@drawguessai/canvas-protocol";

type CanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const AI_CANVAS_IMAGE_SIZE = { width: 640, height: 480 } as const;

function traceStrokePath(
  context: CanvasContext,
  points: readonly BrushRenderPoint[],
  closed: boolean
): void {
  context.beginPath();
  context.moveTo(points[0]!.x, points[0]!.y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  if (closed) context.closePath();
}

function drawConstantOutline(
  context: CanvasContext,
  points: readonly BrushRenderPoint[],
  closed: boolean,
  width: number,
  color: string
): void {
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = color;
  context.lineWidth = width;
  traceStrokePath(context, points, closed);
  context.stroke();
}

interface SampledPoint {
  x: number;
  y: number;
  distance: number;
}

function sampledStrokePoints(
  points: readonly BrushRenderPoint[],
  closed: boolean,
  width: number
): SampledPoint[] {
  const source = [...points];
  const first = source[0];
  const last = source.at(-1);
  if (
    closed &&
    first !== undefined &&
    last !== undefined &&
    (first.x !== last.x || first.y !== last.y)
  ) {
    source.push(first);
  }
  if (source.length === 0) return [];
  const sampled: SampledPoint[] = [{ ...source[0]!, distance: 0 }];
  let distance = 0;
  for (let index = 1; index < source.length; index += 1) {
    const start = source[index - 1]!;
    const end = source[index]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length === 0) continue;
    const steps = Math.min(32, Math.max(1, Math.ceil(length / Math.max(8, width))));
    for (let step = 1; step <= steps; step += 1) {
      const amount = step / steps;
      sampled.push({
        x: start.x + (end.x - start.x) * amount,
        y: start.y + (end.y - start.y) * amount,
        distance: distance + length * amount
      });
    }
    distance += length;
  }
  return sampled;
}

function drawVariableOutline(
  context: CanvasContext,
  points: readonly BrushRenderPoint[],
  closed: boolean,
  width: number,
  color: string,
  profile: StrokeWidthProfile
): void {
  const sampled = sampledStrokePoints(points, closed, width);
  const totalDistance = sampled.at(-1)?.distance ?? 0;
  if (sampled.length < 2 || totalDistance <= 0) return;
  context.fillStyle = color;
  const widths = sampled.map(
    (point) => width * strokeWidthScaleAt(profile, point.distance / totalDistance)
  );

  context.beginPath();
  for (let index = 1; index < sampled.length; index += 1) {
    const start = sampled[index - 1]!;
    const end = sampled[index]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const normalX = -dy / length;
    const normalY = dx / length;
    const startRadius = widths[index - 1]! / 2;
    const endRadius = widths[index]! / 2;
    context.moveTo(start.x + normalX * startRadius, start.y + normalY * startRadius);
    context.lineTo(end.x + normalX * endRadius, end.y + normalY * endRadius);
    context.lineTo(end.x - normalX * endRadius, end.y - normalY * endRadius);
    context.lineTo(start.x - normalX * startRadius, start.y - normalY * startRadius);
    context.closePath();
  }

  sampled.forEach((point, index) => {
    context.moveTo(point.x + widths[index]! / 2, point.y);
    context.arc(point.x, point.y, widths[index]! / 2, 0, Math.PI * 2, true);
  });
  context.fill();
}

export function drawStroke(context: CanvasContext, stroke: StrokeCommand): void {
  if (stroke.points.length < 2) return;
  context.save();
  const color = stroke.tool === "eraser" ? PAPER_COLOR : stroke.color;
  if (stroke.fillColor !== undefined) {
    traceStrokePath(context, stroke.points, stroke.closed === true);
    context.fillStyle = stroke.tool === "eraser" ? PAPER_COLOR : stroke.fillColor;
    context.fill();
  }
  const profile = strokeWidthProfileForRender(stroke);
  const constant = profile.startScale === 1 && profile.peakScale === 1 && profile.endScale === 1;
  for (const layer of brushLayersForStroke(stroke)) {
    context.save();
    context.globalAlpha = layer.opacity;
    const width = stroke.width * layer.widthScale;
    if (constant) {
      drawConstantOutline(context, layer.points, stroke.closed === true, width, color);
    } else {
      drawVariableOutline(context, layer.points, stroke.closed === true, width, color, profile);
    }
    context.restore();
  }
  context.restore();
}

function rgbFromHex(color: string): readonly [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16)
  ];
}

export function drawFill(context: CanvasContext, command: FillCommand): void {
  const width = context.canvas.width;
  const height = context.canvas.height;
  if (width <= 0 || height <= 0) return;
  const transform = context.getTransform();
  const seedX = Math.max(
    0,
    Math.min(
      width - 1,
      Math.round(command.point.x * transform.a + command.point.y * transform.c + transform.e)
    )
  );
  const seedY = Math.max(
    0,
    Math.min(
      height - 1,
      Math.round(command.point.x * transform.b + command.point.y * transform.d + transform.f)
    )
  );
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const seedOffset = (seedY * width + seedX) * 4;
  const target = [
    data[seedOffset]!,
    data[seedOffset + 1]!,
    data[seedOffset + 2]!,
    data[seedOffset + 3]!
  ] as const;
  const replacement = rgbFromHex(command.color);
  if (
    target[0] === replacement[0] &&
    target[1] === replacement[1] &&
    target[2] === replacement[2] &&
    target[3] === 255
  ) {
    return;
  }

  const pixelCount = width * height;
  const queued = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  const seedIndex = seedY * width + seedX;
  queue[tail++] = seedIndex;
  queued[seedIndex] = 1;
  const matchesTarget = (pixelIndex: number) => {
    const offset = pixelIndex * 4;
    return (
      Math.abs(data[offset]! - target[0]) <= 8 &&
      Math.abs(data[offset + 1]! - target[1]) <= 8 &&
      Math.abs(data[offset + 2]! - target[2]) <= 8 &&
      Math.abs(data[offset + 3]! - target[3]) <= 8
    );
  };
  const enqueue = (pixelIndex: number) => {
    if (queued[pixelIndex] === 1 || !matchesTarget(pixelIndex)) return;
    queued[pixelIndex] = 1;
    queue[tail++] = pixelIndex;
  };

  while (head < tail) {
    const pixelIndex = queue[head++]!;
    const offset = pixelIndex * 4;
    data[offset] = replacement[0];
    data[offset + 1] = replacement[1];
    data[offset + 2] = replacement[2];
    data[offset + 3] = 255;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueue(pixelIndex - 1);
    if (x + 1 < width) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y + 1 < height) enqueue(pixelIndex + width);
  }
  context.putImageData(image, 0, 0);
}

export function renderCanvasCommands(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  commands: readonly CanvasCommand[]
): void {
  context.save();
  context.fillStyle = PAPER_COLOR;
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  context.restore();
  for (const command of activeCanvasMarkCommands(commands)) {
    if (command.type === "stroke") drawStroke(context, command);
    else drawFill(context, command);
  }
}

export function commandsToDataUrl(commands: readonly CanvasCommand[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Canvas rendering is unavailable");
  renderCanvasCommands(context, commands);
  return canvas.toDataURL("image/png");
}

export function commandsToAiImageDataUrl(commands: readonly CanvasCommand[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = AI_CANVAS_IMAGE_SIZE.width;
  canvas.height = AI_CANVAS_IMAGE_SIZE.height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Canvas rendering is unavailable");
  context.scale(
    AI_CANVAS_IMAGE_SIZE.width / CANVAS_WIDTH,
    AI_CANVAS_IMAGE_SIZE.height / CANVAS_HEIGHT
  );
  renderCanvasCommands(context, commands);
  const webp = canvas.toDataURL("image/webp", 0.9);
  return webp.startsWith("data:image/webp;") ? webp : canvas.toDataURL("image/png");
}
