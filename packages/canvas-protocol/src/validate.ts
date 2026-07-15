import { MASTER_PALETTE, MAX_FILLS_PER_TURN, MAX_POINTS_PER_TURN, PAPER_COLOR } from "./constants";
import {
  CanvasCommandSchema,
  type CanvasBudget,
  type CanvasCommand,
  type CanvasMarkCommand,
  type StrokeCommand
} from "./schema";

export interface CanvasValidationIssue {
  commandIndex: number;
  code:
    | "invalid-command"
    | "duplicate-id"
    | "after-finish"
    | "stroke-budget"
    | "fill-budget"
    | "point-budget"
    | "color-not-allowed"
    | "undo-budget"
    | "invalid-undo"
    | "missing-finish";
  message: string;
}

export interface CanvasStats {
  strokes: number;
  undos: number;
  points: number;
  activeStrokes: number;
  finished: boolean;
}

export type CanvasValidationResult =
  | { ok: true; commands: CanvasCommand[]; stats: CanvasStats }
  | { ok: false; issues: CanvasValidationIssue[]; stats: CanvasStats };

export interface ValidateCanvasOptions {
  requireFinish?: boolean;
}

export function validateCanvasCommands(
  rawCommands: readonly unknown[],
  budget: CanvasBudget,
  options: ValidateCanvasOptions = {}
): CanvasValidationResult {
  const issues: CanvasValidationIssue[] = [];
  const commands: CanvasCommand[] = [];
  const seenIds = new Set<string>();
  const activeMarks = new Map<string, CanvasMarkCommand>();
  const undoneIds = new Set<string>();
  const allowedColors = new Set(MASTER_PALETTE.slice(0, budget.colorCount));
  let strokes = 0;
  let fills = 0;
  let undos = 0;
  let points = 0;
  let finished = false;

  rawCommands.forEach((rawCommand, commandIndex) => {
    const parsed = CanvasCommandSchema.safeParse(rawCommand);
    if (!parsed.success) {
      issues.push({
        commandIndex,
        code: "invalid-command",
        message: parsed.error.issues.map((issue) => issue.message).join("; ")
      });
      return;
    }

    const command = parsed.data;
    if (seenIds.has(command.id)) {
      issues.push({ commandIndex, code: "duplicate-id", message: `Duplicate id ${command.id}` });
      return;
    }
    seenIds.add(command.id);

    if (finished) {
      issues.push({ commandIndex, code: "after-finish", message: "Command appears after finish" });
      return;
    }

    if (command.type === "stroke" || command.type === "fill") {
      strokes += 1;
      if (command.type === "fill") fills += 1;
      points += command.type === "stroke" ? command.points.length : 1;
      if (strokes > budget.maxStrokes) {
        issues.push({ commandIndex, code: "stroke-budget", message: "Stroke budget exceeded" });
      }
      if (fills > MAX_FILLS_PER_TURN) {
        issues.push({ commandIndex, code: "fill-budget", message: "Fill budget exceeded" });
      }
      if (points > Math.min(budget.maxTotalPoints, MAX_POINTS_PER_TURN)) {
        issues.push({ commandIndex, code: "point-budget", message: "Point budget exceeded" });
      }
      if (
        (command.type === "fill" || command.tool === "pen") &&
        !allowedColors.has(command.color as (typeof MASTER_PALETTE)[number])
      ) {
        issues.push({ commandIndex, code: "color-not-allowed", message: "Color is not enabled" });
      }
      if (
        command.type === "stroke" &&
        command.fillColor !== undefined &&
        !allowedColors.has(command.fillColor as (typeof MASTER_PALETTE)[number])
      ) {
        issues.push({
          commandIndex,
          code: "color-not-allowed",
          message: "Fill color is not enabled"
        });
      }
      activeMarks.set(command.id, command);
    } else if (command.type === "undo") {
      undos += 1;
      if (undos > budget.maxUndos) {
        issues.push({ commandIndex, code: "undo-budget", message: "Undo budget exceeded" });
      }
      if (!activeMarks.has(command.targetId) || undoneIds.has(command.targetId)) {
        issues.push({ commandIndex, code: "invalid-undo", message: "Undo target is not active" });
      } else {
        activeMarks.delete(command.targetId);
        undoneIds.add(command.targetId);
      }
    } else {
      finished = true;
    }

    commands.push(command);
  });

  if (options.requireFinish === true && !finished) {
    issues.push({
      commandIndex: rawCommands.length,
      code: "missing-finish",
      message: "Turn must end with finish"
    });
  }

  const stats: CanvasStats = {
    strokes,
    undos,
    points,
    activeStrokes: activeMarks.size,
    finished
  };

  return issues.length === 0 ? { ok: true, commands, stats } : { ok: false, issues, stats };
}

export function activeStrokeCommands(commands: readonly CanvasCommand[]): StrokeCommand[] {
  return activeCanvasMarkCommands(commands).filter(
    (command): command is StrokeCommand => command.type === "stroke"
  );
}

export function activeCanvasMarkCommands(commands: readonly CanvasCommand[]): CanvasMarkCommand[] {
  const active = new Map<string, CanvasMarkCommand>();
  for (const command of commands) {
    if (command.type === "stroke" || command.type === "fill") {
      active.set(command.id, command);
    } else if (command.type === "undo") {
      active.delete(command.targetId);
    }
  }
  return [...active.values()];
}

export function hasVisibleCanvasContent(commands: readonly CanvasCommand[]): boolean {
  return activeCanvasMarkCommands(commands).some((mark) => {
    if (mark.type === "fill") return mark.color.toLowerCase() !== PAPER_COLOR;
    const stroke = mark;
    if (stroke.tool !== "pen") return false;
    const outlineVisible = stroke.color.toLowerCase() !== PAPER_COLOR;
    const fillVisible =
      stroke.fillColor !== undefined && stroke.fillColor.toLowerCase() !== PAPER_COLOR;
    if (!outlineVisible && !fillVisible) return false;
    const first = stroke.points[0];
    return (
      first !== undefined &&
      stroke.points.some((point) => point.x !== first.x || point.y !== first.y)
    );
  });
}
