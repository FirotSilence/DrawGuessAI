import {
  CONSTANT_STROKE_WIDTH_PROFILE,
  DEFAULT_STROKE_WIDTH_PROFILE,
  type BrushPreset,
  type StrokeCommand,
  type StrokeWidthProfile
} from "./schema";

export interface BrushRenderPoint {
  x: number;
  y: number;
}

export interface StrokeBrushLayer {
  opacity: number;
  points: BrushRenderPoint[];
  widthScale: number;
}

const PENCIL_STROKE_WIDTH_PROFILE: StrokeWidthProfile = {
  startScale: 0.42,
  peakScale: 0.94,
  endScale: 0.38,
  peakAt: 0.52
};

const PAINT_STROKE_WIDTH_PROFILE: StrokeWidthProfile = {
  startScale: 0.34,
  peakScale: 1.32,
  endScale: 0.46,
  peakAt: 0.58
};

function stableNoise(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) / 0xffffffff) * 2 - 1;
}

function pointNormal(
  points: readonly BrushRenderPoint[],
  index: number,
  closed: boolean
): BrushRenderPoint {
  const first = points[0];
  const last = points.at(-1);
  const hasRepeatedClosure =
    closed && first !== undefined && last !== undefined && first.x === last.x && first.y === last.y;
  const closedPrevious = hasRepeatedClosure ? points.at(-2) : last;
  const closedNext = hasRepeatedClosure ? points[1] : first;
  const previous = points[index - 1] ??
    (closed ? closedPrevious : undefined) ??
    points[index] ?? { x: 0, y: 0 };
  const next = points[index + 1] ??
    (closed ? closedNext : undefined) ??
    points[index] ?? { x: 0, y: 0 };
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  const length = Math.hypot(dx, dy);
  return length <= 0 ? { x: 0, y: 0 } : { x: -dy / length, y: dx / length };
}

function offsetPoints(
  stroke: StrokeCommand,
  lane: number,
  offsetScale: number,
  jitterScale: number
): BrushRenderPoint[] {
  return stroke.points.map((point, index, points) => {
    const normal = pointNormal(points, index, stroke.closed === true);
    const noise = stableNoise(`${stroke.id}:${lane}:${point.x}:${point.y}`);
    const offset = stroke.width * (offsetScale + noise * jitterScale);
    return {
      x: point.x + normal.x * offset,
      y: point.y + normal.y * offset
    };
  });
}

export function brushPresetForStroke(stroke: StrokeCommand): BrushPreset {
  return stroke.tool === "eraser" ? "ink" : (stroke.brushPreset ?? "ink");
}

export function strokeWidthProfileForRender(stroke: StrokeCommand): StrokeWidthProfile {
  if (stroke.widthProfile !== undefined) return stroke.widthProfile;
  if (stroke.tool === "eraser") return CONSTANT_STROKE_WIDTH_PROFILE;
  const preset = brushPresetForStroke(stroke);
  if (preset === "marker") return CONSTANT_STROKE_WIDTH_PROFILE;
  if (preset === "pencil") return PENCIL_STROKE_WIDTH_PROFILE;
  if (preset === "paint") return PAINT_STROKE_WIDTH_PROFILE;
  return DEFAULT_STROKE_WIDTH_PROFILE;
}

export function strokeWidthScaleAt(profile: StrokeWidthProfile, progress: number): number {
  const smoothStep = (value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    return clamped * clamped * (3 - 2 * clamped);
  };
  const clamped = Math.max(0, Math.min(1, progress));
  if (clamped <= profile.peakAt) {
    const amount = smoothStep(clamped / profile.peakAt);
    return profile.startScale + (profile.peakScale - profile.startScale) * amount;
  }
  const amount = smoothStep((clamped - profile.peakAt) / (1 - profile.peakAt));
  return profile.peakScale + (profile.endScale - profile.peakScale) * amount;
}

export function brushLayersForStroke(stroke: StrokeCommand): StrokeBrushLayer[] {
  const preset = brushPresetForStroke(stroke);
  if (preset === "pencil") {
    return [
      { opacity: 0.48, points: offsetPoints(stroke, 0, 0, 0.035), widthScale: 0.5 },
      { opacity: 0.28, points: offsetPoints(stroke, 1, -0.2, 0.12), widthScale: 0.2 },
      { opacity: 0.24, points: offsetPoints(stroke, 2, 0.2, 0.14), widthScale: 0.18 }
    ];
  }
  if (preset === "marker") {
    return [{ opacity: 0.7, points: [...stroke.points], widthScale: 1.15 }];
  }
  if (preset === "paint") {
    return [
      { opacity: 0.8, points: offsetPoints(stroke, 0, -0.3, 0.055), widthScale: 0.34 },
      { opacity: 0.72, points: offsetPoints(stroke, 1, -0.09, 0.07), widthScale: 0.3 },
      { opacity: 0.66, points: offsetPoints(stroke, 2, 0.13, 0.075), widthScale: 0.26 },
      { opacity: 0.52, points: offsetPoints(stroke, 3, 0.32, 0.09), widthScale: 0.2 }
    ];
  }
  return [{ opacity: 1, points: [...stroke.points], widthScale: 1 }];
}
