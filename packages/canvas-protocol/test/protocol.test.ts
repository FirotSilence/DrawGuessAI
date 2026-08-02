import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  BRUSH_PRESETS,
  BrushPresetSchema,
  hashCanvasCommands,
  hasVisibleCanvasContent,
  MASTER_PALETTE,
  activeCanvasMarkCommands,
  brushLayersForStroke,
  normalizeCanvasCommandOffsets,
  simplifyStroke,
  strokeWidthProfileForRender,
  toCanvasCommandOffsetMs,
  validateCanvasCommands,
  type CanvasBudget,
  type CanvasCommand
} from "../src";

const budget: CanvasBudget = {
  maxStrokes: 60,
  maxUndos: 3,
  colorCount: 10,
  maxTotalPoints: 4096
};

describe("canvas protocol", () => {
  it("uses turn-relative command times even after the page has been open for five minutes", () => {
    expect(toCanvasCommandOffsetMs(612_345, 600_000)).toBe(12_345);
    expect(toCanvasCommandOffsetMs(999_999, 600_000)).toBe(300_000);
  });

  it("repairs browser-uptime offsets before a drawing is submitted", () => {
    const commands: CanvasCommand[] = [
      {
        type: "stroke",
        id: "late-stroke",
        tool: "pen",
        color: MASTER_PALETTE[0],
        width: 8,
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 20 }
        ],
        offsetMs: 612_345
      },
      { type: "finish", id: "late-finish", offsetMs: 613_845 }
    ];

    const normalized = normalizeCanvasCommandOffsets(commands);

    expect(normalized.map((command) => command.offsetMs)).toEqual([0, 1_500]);
    expect(validateCanvasCommands(normalized, budget, { requireFinish: true }).ok).toBe(true);
  });

  it("accepts a deterministic finished drawing", () => {
    const commands: CanvasCommand[] = [
      {
        type: "stroke",
        id: "stroke-1",
        tool: "pen",
        color: MASTER_PALETTE[0],
        width: 8,
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 20 }
        ],
        offsetMs: 10
      },
      { type: "finish", id: "finish-1", offsetMs: 20 }
    ];

    const result = validateCanvasCommands(commands, budget, { requireFinish: true });
    expect(result.ok).toBe(true);
    expect(hashCanvasCommands(commands)).toHaveLength(8);
    expect(hashCanvasCommands(commands)).toBe(hashCanvasCommands(structuredClone(commands)));
  });

  it("keeps brush presets bounded, deterministic, and backward compatible", () => {
    const base = {
      type: "stroke" as const,
      id: "brush-sample",
      tool: "pen" as const,
      color: MASTER_PALETTE[0],
      width: 16 as const,
      points: [
        { x: 100, y: 120 },
        { x: 300, y: 180 },
        { x: 520, y: 140 }
      ],
      offsetMs: 0
    };

    expect(BRUSH_PRESETS.map((preset) => BrushPresetSchema.parse(preset))).toEqual(BRUSH_PRESETS);
    expect(brushLayersForStroke(base)).toHaveLength(1);
    for (const brushPreset of BRUSH_PRESETS) {
      const stroke = { ...base, brushPreset };
      expect(brushLayersForStroke(stroke)).toEqual(brushLayersForStroke(stroke));
      expect(
        validateCanvasCommands(
          [stroke, { type: "finish", id: `finish-${brushPreset}`, offsetMs: 1 }],
          budget,
          { requireFinish: true }
        ).ok
      ).toBe(true);
    }
    expect(brushLayersForStroke({ ...base, brushPreset: "pencil" })).toHaveLength(3);
    expect(brushLayersForStroke({ ...base, brushPreset: "paint" })).toHaveLength(4);
    expect(strokeWidthProfileForRender({ ...base, brushPreset: "marker" })).toMatchObject({
      startScale: 1,
      peakScale: 1,
      endScale: 1
    });
  });

  it("accepts filled closed strokes while enforcing the room palette", () => {
    const filled: CanvasCommand[] = [
      {
        type: "stroke",
        id: "filled-polygon",
        tool: "pen",
        color: MASTER_PALETTE[0],
        fillColor: MASTER_PALETTE[2],
        closed: true,
        width: 8,
        points: [
          { x: 100, y: 100 },
          { x: 300, y: 100 },
          { x: 200, y: 260 }
        ],
        offsetMs: 0
      },
      { type: "finish", id: "filled-finish", offsetMs: 100 }
    ];

    expect(validateCanvasCommands(filled, budget, { requireFinish: true }).ok).toBe(true);
    const invalidFill = structuredClone(filled);
    if (invalidFill[0]?.type === "stroke") invalidFill[0].fillColor = "#abcdef";
    expect(validateCanvasCommands(invalidFill, budget, { requireFinish: true }).ok).toBe(false);
  });

  it("accepts paint-bucket fills as ordered, undoable canvas marks", () => {
    const commands: CanvasCommand[] = [
      {
        type: "stroke",
        id: "outline",
        tool: "pen",
        color: MASTER_PALETTE[0],
        closed: true,
        width: 8,
        points: [
          { x: 100, y: 100 },
          { x: 400, y: 100 },
          { x: 400, y: 400 },
          { x: 100, y: 400 },
          { x: 100, y: 100 }
        ],
        offsetMs: 0
      },
      {
        type: "fill",
        id: "inside-fill",
        point: { x: 250, y: 250 },
        color: MASTER_PALETTE[2],
        offsetMs: 10
      },
      { type: "finish", id: "fill-finish", offsetMs: 20 }
    ];

    expect(validateCanvasCommands(commands, budget, { requireFinish: true }).ok).toBe(true);
    expect(activeCanvasMarkCommands(commands).map((command) => command.type)).toEqual([
      "stroke",
      "fill"
    ]);
    expect(hasVisibleCanvasContent(commands)).toBe(true);

    const undone: CanvasCommand[] = [
      ...commands.slice(0, 2),
      { type: "undo", id: "undo-fill", targetId: "inside-fill", offsetMs: 15 },
      commands[2]!
    ];
    expect(validateCanvasCommands(undone, budget, { requireFinish: true }).ok).toBe(true);
    expect(activeCanvasMarkCommands(undone).map((command) => command.id)).toEqual(["outline"]);
  });

  it("bounds expensive paint-bucket operations per turn", () => {
    const commands: CanvasCommand[] = [
      ...Array.from({ length: 13 }, (_, index) => ({
        type: "fill" as const,
        id: `fill-${index}`,
        point: { x: index, y: index },
        color: MASTER_PALETTE[index % 2 === 0 ? 2 : 3]!,
        offsetMs: index
      })),
      { type: "finish", id: "finish-fills", offsetMs: 20 }
    ];
    const result = validateCanvasCommands(commands, budget, { requireFinish: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.code === "fill-budget")).toBe(true);
  });

  it("validates bounded pressure profiles and detects only active visible marks", () => {
    const profiled: CanvasCommand[] = [
      {
        type: "stroke",
        id: "profiled",
        tool: "pen",
        color: MASTER_PALETTE[0],
        width: 8,
        widthProfile: { startScale: 0.5, peakScale: 1.25, endScale: 0.8, peakAt: 0.65 },
        points: [
          { x: 20, y: 20 },
          { x: 200, y: 120 }
        ],
        offsetMs: 0
      },
      { type: "finish", id: "profiled-finish", offsetMs: 10 }
    ];
    expect(validateCanvasCommands(profiled, budget, { requireFinish: true }).ok).toBe(true);
    expect(hasVisibleCanvasContent(profiled)).toBe(true);

    const undone: CanvasCommand[] = [
      profiled[0]!,
      { type: "undo", id: "profiled-undo", targetId: "profiled", offsetMs: 5 },
      profiled[1]!
    ];
    expect(hasVisibleCanvasContent(undone)).toBe(false);
    expect(
      validateCanvasCommands(
        [
          {
            ...profiled[0]!,
            type: "stroke",
            widthProfile: { startScale: 0.1, peakScale: 1, endScale: 1, peakAt: 0.5 }
          },
          profiled[1]!
        ],
        budget,
        { requireFinish: true }
      ).ok
    ).toBe(false);
  });

  it("rejects commands after finish and duplicate undo", () => {
    const commands: unknown[] = [
      {
        type: "stroke",
        id: "s",
        tool: "pen",
        color: MASTER_PALETTE[0],
        width: 4,
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 }
        ],
        offsetMs: 0
      },
      { type: "undo", id: "u1", targetId: "s", offsetMs: 1 },
      { type: "undo", id: "u2", targetId: "s", offsetMs: 2 },
      { type: "finish", id: "f", offsetMs: 3 },
      { type: "finish", id: "f2", offsetMs: 4 }
    ];

    const result = validateCanvasCommands(commands, budget);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["invalid-undo", "after-finish"])
      );
    }
  });

  it("always quantizes simplified points inside the canvas", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            x: fc.double({ min: -2000, max: 3000, noNaN: true }),
            y: fc.double({ min: -2000, max: 3000, noNaN: true })
          }),
          { minLength: 1, maxLength: 200 }
        ),
        (points) => {
          const simplified = simplifyStroke(points);
          expect(simplified.length).toBeLessThanOrEqual(96);
          expect(simplified.length).toBeGreaterThanOrEqual(2);
          for (const point of simplified) {
            expect(Number.isInteger(point.x)).toBe(true);
            expect(Number.isInteger(point.y)).toBe(true);
            expect(point.x).toBeGreaterThanOrEqual(0);
            expect(point.x).toBeLessThanOrEqual(1000);
            expect(point.y).toBeGreaterThanOrEqual(0);
            expect(point.y).toBeLessThanOrEqual(750);
          }
        }
      )
    );
  });

  it("keeps the end of long strokes and makes edge taps visible", () => {
    const longStroke = Array.from({ length: 240 }, (_, index) => ({
      x: index * 4,
      y: index % 2 === 0 ? 100 : 120
    }));
    const simplified = simplifyStroke(longStroke, 0);
    expect(simplified).toHaveLength(96);
    expect(simplified.at(-1)).toEqual({ x: 956, y: 120 });

    expect(simplifyStroke([{ x: 1000, y: 750 }])).toEqual([
      { x: 1000, y: 750 },
      { x: 999, y: 750 }
    ]);
  });

  it("rejects out-of-bounds coordinates and the hard point budget", () => {
    const invalid = validateCanvasCommands(
      [
        {
          type: "stroke",
          id: "outside",
          tool: "pen",
          color: MASTER_PALETTE[0],
          width: 8,
          points: [
            { x: -1, y: 0 },
            { x: 1001, y: 751 }
          ],
          offsetMs: 0
        },
        { type: "finish", id: "finish", offsetMs: 1 }
      ],
      budget,
      { requireFinish: true }
    );
    expect(invalid.ok).toBe(false);

    const tinyBudget = { ...budget, maxTotalPoints: 2 };
    const tooMany = validateCanvasCommands(
      [
        {
          type: "stroke",
          id: "points",
          tool: "pen",
          color: MASTER_PALETTE[0],
          width: 8,
          points: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 3 }
          ],
          offsetMs: 0
        },
        { type: "finish", id: "finish", offsetMs: 1 }
      ],
      tinyBudget
    );
    expect(tooMany.ok).toBe(false);
  });
});
