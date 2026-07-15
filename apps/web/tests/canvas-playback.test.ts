import {
  DEFAULT_STROKE_WIDTH_PROFILE,
  type CanvasCommand,
  type StrokeCommand
} from "@drawguessai/canvas-protocol";
import { describe, expect, it } from "vitest";

import {
  commandPlaybackWeight,
  commandsAtPlaybackProgress,
  playbackProgressForRender,
  strokeAtPlaybackProgress
} from "../src/lib/canvas-playback";
import { strokeWidthScaleAt } from "../src/lib/canvas-renderer";

function stroke(id: string, fillColor?: string): StrokeCommand {
  return {
    type: "stroke",
    id,
    tool: "pen",
    color: "#202124",
    ...(fillColor === undefined ? {} : { fillColor, closed: true }),
    width: 8,
    points: Array.from({ length: 18 }, (_, index) => ({
      x: 100 + index * 12,
      y: 100 + index * 6
    })),
    offsetMs: 0
  };
}

describe("AI canvas playback", () => {
  it("uses a subtle thin-thick-thin default while allowing directional pressure", () => {
    expect(strokeWidthScaleAt(DEFAULT_STROKE_WIDTH_PROFILE, 0)).toBeCloseTo(0.58);
    expect(strokeWidthScaleAt(DEFAULT_STROKE_WIDTH_PROFILE, 0.5)).toBeCloseTo(1.12);
    expect(strokeWidthScaleAt(DEFAULT_STROKE_WIDTH_PROFILE, 1)).toBeCloseTo(0.58);
    const forward = { startScale: 0.4, peakScale: 1.4, endScale: 0.9, peakAt: 0.7 };
    expect(strokeWidthScaleAt(forward, 0.7)).toBeCloseTo(1.4);
    expect(strokeWidthScaleAt(forward, 1)).toBeCloseTo(0.9);
  });

  it("reveals actions in order and waits until a polygon is complete before filling it", () => {
    const commands: CanvasCommand[] = [
      stroke("filled", "#e94f64"),
      stroke("detail"),
      { type: "finish", id: "finish", offsetMs: 100 }
    ];

    const early = commandsAtPlaybackProgress(commands, 0.2);
    expect(early).toHaveLength(1);
    expect(early[0]).toMatchObject({ type: "stroke", id: "filled" });
    if (early[0]?.type === "stroke") {
      expect(early[0].points.length).toBeLessThan(18);
      expect(early[0].fillColor).toBeUndefined();
      expect(early[0].closed).toBeUndefined();
    }

    const late = commandsAtPlaybackProgress(commands, 0.8);
    expect(late[0]).toMatchObject({
      type: "stroke",
      id: "filled",
      fillColor: "#e94f64",
      closed: true
    });
    expect(late[1]).toMatchObject({ type: "stroke", id: "detail" });
  });

  it("spends less time per action while many actions remain in the queue", () => {
    const command = stroke("queued");
    expect(commandPlaybackWeight(command, 48)).toBeLessThan(commandPlaybackWeight(command, 4));
  });

  it("draws a two-point line progressively instead of popping in complete", () => {
    const line = stroke("line");
    line.points = [
      { x: 100, y: 100 },
      { x: 900, y: 500 }
    ];
    const halfway = strokeAtPlaybackProgress(line, 0.5);
    expect(halfway?.points).toEqual([
      { x: 100, y: 100 },
      { x: 500, y: 300 }
    ]);
    const third = strokeAtPlaybackProgress(line, 1 / 3);
    expect(
      third?.points.every((point) => Number.isInteger(point.x) && Number.isInteger(point.y))
    ).toBe(true);
  });

  it("starts a newly submitted drawing blank before the browser can paint the completed frame", () => {
    expect(playbackProgressForRender("room:turn:old", "room:turn:new", 1)).toBe(0);
    expect(playbackProgressForRender("room:turn:new", "room:turn:new", 0.35)).toBe(0.35);
    expect(playbackProgressForRender(undefined, undefined, 1)).toBe(1);
  });
});
