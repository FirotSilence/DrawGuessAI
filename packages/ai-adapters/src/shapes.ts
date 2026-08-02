import {
  BRUSH_WIDTHS,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  BrushPresetSchema,
  FinishCommandSchema,
  StrokeCommandSchema,
  StrokeWidthProfileSchema,
  UndoCommandSchema,
  type Point,
  type StrokeCommand
} from "@drawguessai/canvas-protocol";
import { z } from "zod";

const BrushWidthSchema = z.union(BRUSH_WIDTHS.map((width) => z.literal(width)));
const ShapePointSchema = z
  .object({
    x: z.number(),
    y: z.number()
  })
  .strict();

export const AiTransformSchema = z
  .object({
    translateX: z.number().default(0),
    translateY: z.number().default(0),
    scaleX: z.number().min(-10).max(10).default(1),
    scaleY: z.number().min(-10).max(10).default(1),
    rotationDeg: z.number().min(-360).max(360).default(0),
    originX: z.number().default(0),
    originY: z.number().default(0)
  })
  .strict();

const ShapeStyle = {
  id: z.string().min(1).max(80),
  tool: z.enum(["pen", "eraser"]).default("pen"),
  brushPreset: BrushPresetSchema.optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#202124"),
  fillColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  width: BrushWidthSchema.default(8),
  widthProfile: StrokeWidthProfileSchema.optional(),
  transform: AiTransformSchema.optional(),
  offsetMs: z.number().int().min(0).max(300_000).default(0)
} as const;

const FillOption = {
  fill: z.boolean().default(false)
} as const;

const AiPathSegmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), to: ShapePointSchema }).strict(),
  z
    .object({
      kind: z.literal("quadratic"),
      control: ShapePointSchema,
      to: ShapePointSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("cubic"),
      control1: ShapePointSchema,
      control2: ShapePointSchema,
      to: ShapePointSchema
    })
    .strict()
]);

export const AiShapeCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("line"),
      ...ShapeStyle,
      start: ShapePointSchema,
      end: ShapePointSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("polyline"),
      ...ShapeStyle,
      points: z.array(ShapePointSchema).min(2).max(96)
    })
    .strict(),
  z
    .object({
      type: z.literal("polygon"),
      ...ShapeStyle,
      points: z.array(ShapePointSchema).min(3).max(64),
      fill: z.boolean().default(true)
    })
    .strict(),
  z
    .object({
      type: z.literal("rect"),
      ...ShapeStyle,
      ...FillOption,
      x: z.number(),
      y: z.number(),
      rectWidth: z.number().positive().max(2_000),
      rectHeight: z.number().positive().max(2_000),
      cornerRadius: z.number().min(0).max(500).default(0)
    })
    .strict(),
  z
    .object({
      type: z.literal("circle"),
      ...ShapeStyle,
      ...FillOption,
      cx: z.number(),
      cy: z.number(),
      radius: z.number().positive().max(2_000)
    })
    .strict(),
  z
    .object({
      type: z.literal("ellipse"),
      ...ShapeStyle,
      ...FillOption,
      cx: z.number(),
      cy: z.number(),
      rx: z.number().positive().max(2_000),
      ry: z.number().positive().max(2_000),
      rotationDeg: z.number().min(-360).max(360).default(0)
    })
    .strict(),
  z
    .object({
      type: z.literal("arc"),
      ...ShapeStyle,
      cx: z.number(),
      cy: z.number(),
      rx: z.number().positive().max(2_000),
      ry: z.number().positive().max(2_000),
      startDeg: z.number().min(-720).max(720),
      endDeg: z.number().min(-720).max(720),
      rotationDeg: z.number().min(-360).max(360).default(0)
    })
    .strict(),
  z
    .object({
      type: z.literal("curve"),
      ...ShapeStyle,
      start: ShapePointSchema,
      control1: ShapePointSchema,
      control2: ShapePointSchema,
      end: ShapePointSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("quadratic"),
      ...ShapeStyle,
      start: ShapePointSchema,
      control: ShapePointSchema,
      end: ShapePointSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("spline"),
      ...ShapeStyle,
      points: z.array(ShapePointSchema).min(3).max(16),
      tension: z.number().min(0).max(1).default(0.35),
      closed: z.boolean().default(false),
      fill: z.boolean().default(false)
    })
    .strict(),
  z
    .object({
      type: z.literal("arcThrough"),
      ...ShapeStyle,
      start: ShapePointSchema,
      through: ShapePointSchema,
      end: ShapePointSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("path"),
      ...ShapeStyle,
      start: ShapePointSchema,
      segments: z.array(AiPathSegmentSchema).min(1).max(16),
      closed: z.boolean().default(false),
      fill: z.boolean().default(false)
    })
    .strict()
]);

export const AiCanvasSourceCommandSchema = z.union([
  AiShapeCommandSchema,
  StrokeCommandSchema,
  UndoCommandSchema,
  FinishCommandSchema
]);

export type AiShapeCommand = z.infer<typeof AiShapeCommandSchema>;
export type AiCanvasSourceCommand = z.infer<typeof AiCanvasSourceCommandSchema>;

function clampPoint(x: number, y: number): Point {
  return {
    x: Math.max(0, Math.min(CANVAS_WIDTH, Math.round(x))),
    y: Math.max(0, Math.min(CANVAS_HEIGHT, Math.round(y)))
  };
}

function transformPoint(
  point: { x: number; y: number },
  transform: z.infer<typeof AiTransformSchema> | undefined
): Point {
  if (transform === undefined) return clampPoint(point.x, point.y);
  const localX = (point.x - transform.originX) * transform.scaleX;
  const localY = (point.y - transform.originY) * transform.scaleY;
  const rotation = (transform.rotationDeg * Math.PI) / 180;
  return clampPoint(
    transform.originX +
      localX * Math.cos(rotation) -
      localY * Math.sin(rotation) +
      transform.translateX,
    transform.originY +
      localX * Math.sin(rotation) +
      localY * Math.cos(rotation) +
      transform.translateY
  );
}

function ellipsePoint(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  angle: number,
  rotation: number
): { x: number; y: number } {
  const localX = Math.cos(angle) * rx;
  const localY = Math.sin(angle) * ry;
  return {
    x: cx + localX * Math.cos(rotation) - localY * Math.sin(rotation),
    y: cy + localX * Math.sin(rotation) + localY * Math.cos(rotation)
  };
}

function sampleEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotationDeg: number,
  startDeg = 0,
  endDeg = 360
): { x: number; y: number }[] {
  const sweep = endDeg - startDeg;
  const steps = Math.max(12, Math.min(48, Math.ceil(Math.abs(sweep) / 10) + 1));
  const rotation = (rotationDeg * Math.PI) / 180;
  return Array.from({ length: steps }, (_, index) => {
    const progress = index / (steps - 1);
    const angle = ((startDeg + sweep * progress) * Math.PI) / 180;
    return ellipsePoint(cx, cy, rx, ry, angle, rotation);
  });
}

function sampleCubic(
  start: { x: number; y: number },
  control1: { x: number; y: number },
  control2: { x: number; y: number },
  end: { x: number; y: number },
  steps = 25
): { x: number; y: number }[] {
  return Array.from({ length: steps }, (_, index) => {
    const t = index / (steps - 1);
    const inverse = 1 - t;
    return {
      x:
        inverse ** 3 * start.x +
        3 * inverse ** 2 * t * control1.x +
        3 * inverse * t ** 2 * control2.x +
        t ** 3 * end.x,
      y:
        inverse ** 3 * start.y +
        3 * inverse ** 2 * t * control1.y +
        3 * inverse * t ** 2 * control2.y +
        t ** 3 * end.y
    };
  });
}

function sampleQuadratic(
  start: { x: number; y: number },
  control: { x: number; y: number },
  end: { x: number; y: number },
  steps = 16
): { x: number; y: number }[] {
  return Array.from({ length: steps }, (_, index) => {
    const t = index / (steps - 1);
    const inverse = 1 - t;
    return {
      x: inverse ** 2 * start.x + 2 * inverse * t * control.x + t ** 2 * end.x,
      y: inverse ** 2 * start.y + 2 * inverse * t * control.y + t ** 2 * end.y
    };
  });
}

function sampleSpline(
  points: readonly { x: number; y: number }[],
  tension: number,
  closed: boolean,
  stepsPerSegment = 5
): { x: number; y: number }[] {
  const result: { x: number; y: number }[] = [];
  const segmentCount = closed ? points.length : points.length - 1;
  const tangentScale = (1 - tension) / 2;
  const pointAt = (index: number) => {
    if (closed) return points[(index + points.length) % points.length]!;
    return points[Math.max(0, Math.min(points.length - 1, index))]!;
  };
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const p0 = pointAt(segment - 1);
    const p1 = pointAt(segment);
    const p2 = pointAt(segment + 1);
    const p3 = pointAt(segment + 2);
    for (let step = segment === 0 ? 0 : 1; step <= stepsPerSegment; step += 1) {
      const t = step / stepsPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const tangent1 = {
        x: (p2.x - p0.x) * tangentScale,
        y: (p2.y - p0.y) * tangentScale
      };
      const tangent2 = {
        x: (p3.x - p1.x) * tangentScale,
        y: (p3.y - p1.y) * tangentScale
      };
      result.push({
        x: h00 * p1.x + h10 * tangent1.x + h01 * p2.x + h11 * tangent2.x,
        y: h00 * p1.y + h10 * tangent1.y + h01 * p2.y + h11 * tangent2.y
      });
    }
  }
  return result;
}

function sampleQuadraticThrough(
  start: { x: number; y: number },
  through: { x: number; y: number },
  end: { x: number; y: number }
): { x: number; y: number }[] {
  return sampleQuadratic(
    start,
    {
      x: 2 * through.x - (start.x + end.x) / 2,
      y: 2 * through.y - (start.y + end.y) / 2
    },
    end,
    21
  );
}

function sampleArcThrough(
  start: { x: number; y: number },
  through: { x: number; y: number },
  end: { x: number; y: number }
): { x: number; y: number }[] {
  const determinant =
    2 *
    (start.x * (through.y - end.y) + through.x * (end.y - start.y) + end.x * (start.y - through.y));
  if (Math.abs(determinant) < 0.001) return sampleQuadraticThrough(start, through, end);
  const startSquared = start.x ** 2 + start.y ** 2;
  const throughSquared = through.x ** 2 + through.y ** 2;
  const endSquared = end.x ** 2 + end.y ** 2;
  const center = {
    x:
      (startSquared * (through.y - end.y) +
        throughSquared * (end.y - start.y) +
        endSquared * (start.y - through.y)) /
      determinant,
    y:
      (startSquared * (end.x - through.x) +
        throughSquared * (start.x - end.x) +
        endSquared * (through.x - start.x)) /
      determinant
  };
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  if (!Number.isFinite(radius) || radius > 10_000) {
    return sampleQuadraticThrough(start, through, end);
  }
  const tau = Math.PI * 2;
  const normalizeSweep = (angle: number) => ((angle % tau) + tau) % tau;
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const throughAngle = Math.atan2(through.y - center.y, through.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const positiveSweep = normalizeSweep(endAngle - startAngle);
  const throughSweep = normalizeSweep(throughAngle - startAngle);
  const sweep = throughSweep <= positiveSweep + 0.0001 ? positiveSweep : positiveSweep - tau;
  if (Math.abs(sweep) < 0.0001) return sampleQuadraticThrough(start, through, end);
  const steps = Math.max(12, Math.min(48, Math.ceil(Math.abs((sweep * 180) / Math.PI) / 10) + 1));
  const sampled = Array.from({ length: steps }, (_, index) => {
    const angle = startAngle + sweep * (index / (steps - 1));
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius
    };
  });
  const throughProgress = sweep > 0 ? throughSweep / sweep : (throughSweep - tau) / sweep;
  sampled[Math.round(throughProgress * (steps - 1))] = { ...through };
  return sampled;
}

function limitPoints(points: readonly Point[]): Point[] {
  if (points.length <= 96) return [...points];
  return Array.from(
    { length: 96 },
    (_, index) => points[Math.round((index / 95) * (points.length - 1))]!
  );
}

function roundedRectPoints(command: Extract<AiShapeCommand, { type: "rect" }>) {
  const radius = Math.min(command.cornerRadius, command.rectWidth / 2, command.rectHeight / 2);
  if (radius <= 0) {
    return [
      { x: command.x, y: command.y },
      { x: command.x + command.rectWidth, y: command.y },
      { x: command.x + command.rectWidth, y: command.y + command.rectHeight },
      { x: command.x, y: command.y + command.rectHeight }
    ];
  }
  const corners = [
    [command.x + command.rectWidth - radius, command.y + radius, -90, 0],
    [command.x + command.rectWidth - radius, command.y + command.rectHeight - radius, 0, 90],
    [command.x + radius, command.y + command.rectHeight - radius, 90, 180],
    [command.x + radius, command.y + radius, 180, 270]
  ] as const;
  return corners.flatMap(([cx, cy, start, end]) =>
    sampleEllipse(cx, cy, radius, radius, 0, start, end).filter(
      (_, index) => index === 0 || index % 3 === 0
    )
  );
}

function pathPoints(command: Extract<AiShapeCommand, { type: "path" }>) {
  const points: { x: number; y: number }[] = [command.start];
  let current = command.start;
  for (const segment of command.segments) {
    const sampled =
      segment.kind === "line"
        ? [current, segment.to]
        : segment.kind === "quadratic"
          ? sampleQuadratic(current, segment.control, segment.to)
          : sampleCubic(current, segment.control1, segment.control2, segment.to, 18);
    points.push(...sampled.slice(1));
    current = segment.to;
  }
  return points;
}

function filledColor(command: AiShapeCommand, fill: boolean): string | undefined {
  if (!fill) return undefined;
  if (command.tool === "eraser") return "#f7f8fa";
  return (command.fillColor ?? command.color).toLowerCase();
}

function compileStroke(
  command: AiShapeCommand,
  rawPoints: readonly { x: number; y: number }[],
  closed = false,
  fill = false
): StrokeCommand {
  const points = limitPoints(rawPoints.map((point) => transformPoint(point, command.transform)));
  return {
    type: "stroke",
    id: command.id,
    tool: command.tool,
    ...(command.brushPreset === undefined ? {} : { brushPreset: command.brushPreset }),
    color: command.color.toLowerCase(),
    ...(closed ? { closed: true } : {}),
    ...(filledColor(command, fill) === undefined ? {} : { fillColor: filledColor(command, fill)! }),
    width: command.width,
    ...(command.widthProfile === undefined ? {} : { widthProfile: command.widthProfile }),
    points,
    offsetMs: command.offsetMs
  };
}

export function compileAiShapeCommand(command: AiShapeCommand): StrokeCommand {
  if (command.type === "line") {
    return compileStroke(command, [command.start, command.end]);
  }
  if (command.type === "polyline") {
    return compileStroke(command, command.points);
  }
  if (command.type === "polygon") {
    return compileStroke(command, command.points, true, command.fill);
  }
  if (command.type === "rect") {
    return compileStroke(command, roundedRectPoints(command), true, command.fill);
  }
  if (command.type === "circle") {
    return compileStroke(
      command,
      sampleEllipse(command.cx, command.cy, command.radius, command.radius, 0),
      true,
      command.fill
    );
  }
  if (command.type === "ellipse") {
    return compileStroke(
      command,
      sampleEllipse(command.cx, command.cy, command.rx, command.ry, command.rotationDeg),
      true,
      command.fill
    );
  }
  if (command.type === "arc") {
    return compileStroke(
      command,
      sampleEllipse(
        command.cx,
        command.cy,
        command.rx,
        command.ry,
        command.rotationDeg,
        command.startDeg,
        command.endDeg
      )
    );
  }
  if (command.type === "curve") {
    return compileStroke(
      command,
      sampleCubic(command.start, command.control1, command.control2, command.end)
    );
  }
  if (command.type === "quadratic") {
    return compileStroke(command, sampleQuadratic(command.start, command.control, command.end));
  }
  if (command.type === "spline") {
    return compileStroke(
      command,
      sampleSpline(command.points, command.tension, command.closed || command.fill),
      command.closed || command.fill,
      command.fill
    );
  }
  if (command.type === "arcThrough") {
    return compileStroke(command, sampleArcThrough(command.start, command.through, command.end));
  }
  return compileStroke(command, pathPoints(command), command.closed, command.fill);
}

export function normalizeAiCanvasSourceCommands(commands: readonly unknown[]): unknown[] {
  return commands.map((command) => {
    const parsed = AiCanvasSourceCommandSchema.safeParse(command);
    return parsed.success ? parsed.data : command;
  });
}

export function compileAiCanvasCommands(commands: readonly unknown[]): unknown[] {
  return commands.map((command) => {
    const shape = AiShapeCommandSchema.safeParse(command);
    return shape.success ? compileAiShapeCommand(shape.data) : command;
  });
}
