export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 750;
export const MAX_POINTS_PER_STROKE = 96;
export const MAX_POINTS_PER_TURN = 4096;
export const MAX_COMMAND_OFFSET_MS = 300_000;
export const MAX_FILLS_PER_TURN = 12;

export const BRUSH_WIDTHS = [4, 8, 16, 28] as const;

export const BRUSH_PRESETS = ["ink", "pencil", "marker", "paint"] as const;

export const PAPER_COLOR = "#f7f8fa";

export const MASTER_PALETTE = [
  "#202124",
  PAPER_COLOR,
  "#e94f64",
  "#ff8a3d",
  "#f2c84b",
  "#46a66f",
  "#1fa6a8",
  "#3f7edb",
  "#7657c8",
  "#d75aa4",
  "#8a5a44",
  "#7b8794"
] as const;

export type BrushWidth = (typeof BRUSH_WIDTHS)[number];
export type PaletteColor = (typeof MASTER_PALETTE)[number];
