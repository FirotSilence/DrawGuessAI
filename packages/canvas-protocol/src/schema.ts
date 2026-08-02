import { z } from "zod";

import {
  BRUSH_PRESETS,
  BRUSH_WIDTHS,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  MAX_COMMAND_OFFSET_MS,
  MAX_POINTS_PER_STROKE
} from "./constants";

export const PointSchema = z
  .object({
    x: z.number().int().min(0).max(CANVAS_WIDTH),
    y: z.number().int().min(0).max(CANVAS_HEIGHT)
  })
  .strict();

export const StrokeWidthProfileSchema = z
  .object({
    startScale: z.number().min(0.25).max(2),
    peakScale: z.number().min(0.25).max(2),
    endScale: z.number().min(0.25).max(2),
    peakAt: z.number().min(0.1).max(0.9)
  })
  .strict();

export const BrushPresetSchema = z.enum(BRUSH_PRESETS);

export const StrokeCommandSchema = z
  .object({
    type: z.literal("stroke"),
    id: z.string().min(1).max(80),
    tool: z.enum(["pen", "eraser"]),
    brushPreset: BrushPresetSchema.optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    fillColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    closed: z.boolean().optional(),
    width: z.union(BRUSH_WIDTHS.map((width) => z.literal(width))),
    widthProfile: StrokeWidthProfileSchema.optional(),
    points: z.array(PointSchema).min(2).max(MAX_POINTS_PER_STROKE),
    offsetMs: z.number().int().min(0).max(MAX_COMMAND_OFFSET_MS)
  })
  .strict();

export const FillCommandSchema = z
  .object({
    type: z.literal("fill"),
    id: z.string().min(1).max(80),
    point: PointSchema,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    offsetMs: z.number().int().min(0).max(MAX_COMMAND_OFFSET_MS)
  })
  .strict();

export const UndoCommandSchema = z
  .object({
    type: z.literal("undo"),
    id: z.string().min(1).max(80),
    targetId: z.string().min(1).max(80),
    offsetMs: z.number().int().min(0).max(MAX_COMMAND_OFFSET_MS)
  })
  .strict();

export const FinishCommandSchema = z
  .object({
    type: z.literal("finish"),
    id: z.string().min(1).max(80),
    offsetMs: z.number().int().min(0).max(MAX_COMMAND_OFFSET_MS)
  })
  .strict();

export const CanvasCommandSchema = z.discriminatedUnion("type", [
  StrokeCommandSchema,
  FillCommandSchema,
  UndoCommandSchema,
  FinishCommandSchema
]);

export const CanvasMarkCommandSchema = z.discriminatedUnion("type", [
  StrokeCommandSchema,
  FillCommandSchema
]);

export const CanvasBudgetSchema = z
  .object({
    maxStrokes: z.number().int().min(20).max(120),
    maxUndos: z.number().int().min(0).max(10),
    colorCount: z.number().int().min(4).max(12),
    maxTotalPoints: z.number().int().min(400).max(4096).default(4096)
  })
  .strict();

export type Point = z.infer<typeof PointSchema>;
export type BrushPreset = z.infer<typeof BrushPresetSchema>;
export type StrokeWidthProfile = z.infer<typeof StrokeWidthProfileSchema>;
export type StrokeCommand = z.infer<typeof StrokeCommandSchema>;
export type FillCommand = z.infer<typeof FillCommandSchema>;
export type CanvasMarkCommand = z.infer<typeof CanvasMarkCommandSchema>;
export type UndoCommand = z.infer<typeof UndoCommandSchema>;
export type FinishCommand = z.infer<typeof FinishCommandSchema>;
export type CanvasCommand = z.infer<typeof CanvasCommandSchema>;
export type CanvasBudget = z.infer<typeof CanvasBudgetSchema>;

export const DEFAULT_STROKE_WIDTH_PROFILE: StrokeWidthProfile = {
  startScale: 0.58,
  peakScale: 1.12,
  endScale: 0.58,
  peakAt: 0.5
};

export const CONSTANT_STROKE_WIDTH_PROFILE: StrokeWidthProfile = {
  startScale: 1,
  peakScale: 1,
  endScale: 1,
  peakAt: 0.5
};
