import {
  hasVisibleCanvasContent,
  validateCanvasCommands,
  type CanvasBudget,
  type CanvasCommand
} from "@drawguessai/canvas-protocol";

export function validateDrawingDraft(
  rawCommands: readonly unknown[],
  budget: CanvasBudget
): CanvasCommand[] | undefined {
  if (
    rawCommands.some(
      (command) =>
        typeof command === "object" &&
        command !== null &&
        "type" in command &&
        command.type === "finish"
    )
  ) {
    return undefined;
  }
  const validation = validateCanvasCommands(rawCommands, budget);
  return validation.ok ? validation.commands : undefined;
}

export function finalizeDrawingDraft(
  rawCommands: readonly unknown[],
  budget: CanvasBudget,
  finishId: string
): CanvasCommand[] | undefined {
  const draft = validateDrawingDraft(rawCommands, budget);
  if (draft === undefined) return undefined;
  const commands: CanvasCommand[] = [
    ...draft,
    {
      type: "finish",
      id: finishId.slice(0, 80),
      offsetMs: Math.max(0, ...draft.map((command) => command.offsetMs))
    }
  ];
  const validation = validateCanvasCommands(commands, budget, { requireFinish: true });
  if (!validation.ok || !hasVisibleCanvasContent(validation.commands)) return undefined;
  return validation.commands;
}
