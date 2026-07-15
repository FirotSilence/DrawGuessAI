import { MASTER_PALETTE, type CanvasBudget } from "@drawguessai/canvas-protocol";
import { describe, expect, it } from "vitest";

import { finalizeDrawingDraft, validateDrawingDraft } from "../src/drawing-draft";

const budget: CanvasBudget = {
  maxStrokes: 60,
  maxUndos: 3,
  colorCount: 10,
  maxTotalPoints: 4096
};

describe("drawing timeout drafts", () => {
  it("finishes the last valid visible canvas instead of replacing it with a blank drawing", () => {
    const draft = [
      {
        type: "stroke" as const,
        id: "last-visible-stroke",
        tool: "pen" as const,
        color: MASTER_PALETTE[0],
        width: 8 as const,
        points: [
          { x: 100, y: 100 },
          { x: 600, y: 450 }
        ],
        offsetMs: 100
      }
    ];

    expect(validateDrawingDraft(draft, budget)?.map((command) => command.id)).toEqual([
      "last-visible-stroke"
    ]);
    expect(finalizeDrawingDraft(draft, budget, "timeout-finish")?.at(-1)).toMatchObject({
      type: "finish",
      id: "timeout-finish"
    });
  });

  it("does not turn an empty or malformed draft into a successful drawing", () => {
    expect(finalizeDrawingDraft([], budget, "empty-finish")).toBeUndefined();
    expect(
      finalizeDrawingDraft(
        [
          {
            type: "stroke",
            id: "outside",
            tool: "pen",
            color: MASTER_PALETTE[0],
            width: 8,
            points: [
              { x: 0, y: 0 },
              { x: 1001, y: 751 }
            ],
            offsetMs: 0
          }
        ],
        budget,
        "invalid-finish"
      )
    ).toBeUndefined();
  });
});
