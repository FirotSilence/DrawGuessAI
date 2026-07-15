import simplify from "simplify-js";

import { CANVAS_HEIGHT, CANVAS_WIDTH, MAX_POINTS_PER_STROKE } from "./constants";
import type { Point } from "./schema";

export function quantizePoint(point: { x: number; y: number }): Point {
  return {
    x: Math.max(0, Math.min(CANVAS_WIDTH, Math.round(point.x))),
    y: Math.max(0, Math.min(CANVAS_HEIGHT, Math.round(point.y)))
  };
}

export function simplifyStroke(
  points: readonly { x: number; y: number }[],
  tolerance = 1.5
): Point[] {
  if (points.length === 0) {
    return [];
  }
  const normalized = simplify(points.map(quantizePoint), tolerance, true).map(quantizePoint);
  const limited =
    normalized.length <= MAX_POINTS_PER_STROKE
      ? normalized
      : Array.from(
          { length: MAX_POINTS_PER_STROKE },
          (_, index) =>
            normalized[Math.round((index * (normalized.length - 1)) / (MAX_POINTS_PER_STROKE - 1))]!
        );
  if (limited.length === 1) {
    const point = limited[0]!;
    const neighbor =
      point.x < CANVAS_WIDTH
        ? { ...point, x: point.x + 1 }
        : point.x > 0
          ? { ...point, x: point.x - 1 }
          : point.y < CANVAS_HEIGHT
            ? { ...point, y: point.y + 1 }
            : { ...point, y: point.y - 1 };
    return [point, neighbor];
  }
  return limited;
}
