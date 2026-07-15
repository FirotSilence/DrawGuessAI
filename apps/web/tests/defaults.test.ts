import type { AiCanvasSourceCommand, AiTurnResult, ModelProfile } from "@drawguessai/ai-adapters";
import type { CanvasCommand } from "@drawguessai/canvas-protocol";
import { DEFAULT_GAME_RULES } from "@drawguessai/game-core";
import { describe, expect, it } from "vitest";

import {
  aiExecutionErrorCode,
  allocateAiPlanSeconds,
  allocateAiPassSeconds,
  compactAiCanvasSourceCommands,
  droppedCommandFeedback,
  effectiveObservationLimit,
  MAX_CANVAS_CANDIDATE_ATTEMPTS,
  mergeAiDrawingPass,
  validateAiDrawingCandidate
} from "../src/lib/ai-executor";
import {
  AI_SEAT_IDS,
  completeAiSeatNames,
  completeAiSeatPersonas,
  createAiSeatNames,
  createAiSeatPersonas,
  createAiSeatProfiles,
  swapAiSeatPersona
} from "../src/lib/ai-seats";
import { ApiRequestError } from "../src/lib/api";
import {
  DEMO_PROFILE,
  isBuiltInLocalProfileId,
  preferredModelProfileId,
  type StoredModelProfile
} from "../src/lib/model-store";
import { getOrCreateDisplayName, rememberDisplayName } from "../src/lib/player-name";
import { resolveInitialLocale } from "../src/lib/locale";

function serverRecord(id: string, model: string): StoredModelProfile {
  const profile: ModelProfile = {
    id,
    label: id,
    protocol: "openai-compatible",
    execution: "server",
    baseUrl: "https://server.invalid",
    model,
    capabilities: {
      vision: true,
      structuredOutput: "json-schema",
      observationMode: "checkpoint",
      maxObservationPasses: 1
    },
    enabled: true
  };
  return { profile, remember: false };
}

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("home defaults", () => {
  it("uses the browser language only until the player chooses a locale", () => {
    expect(resolveInitialLocale(null, ["zh-Hans-CN", "en-US"])).toBe("zh-CN");
    expect(resolveInitialLocale(null, ["en-GB", "zh-CN"])).toBe("en");
    expect(resolveInitialLocale(null, ["fr-FR", "zh-CN"])).toBe("zh-CN");
    expect(resolveInitialLocale(null, ["fr-FR"])).toBe("en");
    expect(resolveInitialLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveInitialLocale("zh-CN", ["en-US"])).toBe("zh-CN");
  });

  it("keeps randomized AI names independent from reusable personas", () => {
    const profiles = createAiSeatProfiles("minimax");
    const personas = createAiSeatPersonas();
    const names = createAiSeatNames("en", () => 0.42);
    expect(AI_SEAT_IDS).toHaveLength(12);
    expect(Object.keys(profiles)).toEqual(AI_SEAT_IDS);
    expect(new Set(Object.values(personas)).size).toBe(12);
    expect(new Set(Object.values(names)).size).toBe(12);

    const swapped = swapAiSeatPersona(personas, "ai-1", personas["ai-8"]!);
    expect(swapped["ai-1"]).toBe(personas["ai-8"]);
    expect(swapped["ai-8"]).toBe(personas["ai-8"]);
    expect(new Set(Object.values(swapped)).size).toBe(11);

    const completed = completeAiSeatPersonas({ "ai-1": "poet", "ai-2": "poet" });
    expect(completed["ai-1"]).toBe("poet");
    expect(completed["ai-2"]).toBe("poet");
    expect(completeAiSeatNames({ "ai-1": "Marlow" }, "en")["ai-1"]).toBe("Marlow");
  });

  it("keeps actionable AI execution failures instead of collapsing every cause", () => {
    expect(aiExecutionErrorCode(new ApiRequestError(503, "request-failed", "Unavailable"))).toBe(
      "server-request-failed"
    );
    expect(aiExecutionErrorCode(new DOMException("Late", "TimeoutError"))).toBe("timeout");
    expect(aiExecutionErrorCode(Object.assign(new Error("Bad result"), { name: "ZodError" }))).toBe(
      "invalid-server-result"
    );
    expect(aiExecutionErrorCode(new Error("Unknown"))).toBe("execution-error");
  });

  it("prefers the first complete server profile without depending on a provider name", () => {
    const profiles = [
      { profile: DEMO_PROFILE, remember: false },
      serverRecord("hosted-primary", "vision-model"),
      serverRecord("hosted-secondary", "another-model")
    ];
    expect(preferredModelProfileId(profiles)).toBe("hosted-primary");
    expect(DEMO_PROFILE.capabilities.drawingPlanMode).toBe("inline");
  });

  it("does not make a drawing-only model the default for every relay seat", () => {
    const drawingOnly = serverRecord("drawing-only", "DeepSeek-V4-Flash");
    drawingOnly.profile.capabilities = {
      vision: false,
      structuredOutput: "none",
      observationMode: "one-shot",
      maxObservationPasses: 0,
      supportedRoles: ["draw", "prompt", "review"]
    };
    expect(preferredModelProfileId([{ profile: DEMO_PROFILE, remember: false }, drawingOnly])).toBe(
      DEMO_PROFILE.id
    );
  });

  it("keeps environment-owned local presets outside editable profile storage", () => {
    expect(isBuiltInLocalProfileId("ccswitch-local")).toBe(true);
    expect(isBuiltInLocalProfileId("ccswitch-local-minimax-m3")).toBe(false);
    expect(isBuiltInLocalProfileId("deepseek-local-direct")).toBe(true);
    expect(isBuiltInLocalProfileId("my-deepseek-profile")).toBe(false);
  });

  it("creates one random display name and remembers later edits", () => {
    const storage = new MemoryStorage();
    const generated = getOrCreateDisplayName("zh-CN", storage);
    expect(generated).not.toBe("");
    expect(generated.length).toBeLessThanOrEqual(24);
    expect(getOrCreateDisplayName("en", storage)).toBe(generated);

    rememberDisplayName("  Studio Friend  ", storage);
    expect(getOrCreateDisplayName("en", storage)).toBe("Studio Friend");
  });

  it("divides a drawing deadline across inspection passes", () => {
    expect(allocateAiPlanSeconds(180_000, 4)).toBe(20);
    expect(allocateAiPassSeconds(75, 75_000, 2)).toBe(37);
    expect(allocateAiPassSeconds(30, 30_000, 2)).toBe(14);
    expect(allocateAiPassSeconds(15, 15_000, 1)).toBe(14);
    expect(effectiveObservationLimit(2, 2, true, 30_000)).toBe(2);
    expect(effectiveObservationLimit(0, 2, true, 180_000)).toBe(0);
    expect(effectiveObservationLimit(2, 1, true, 75_000)).toBe(1);
    expect(effectiveObservationLimit(2, 2, false, 75_000)).toBe(0);
  });

  it("keeps the large drawing budget while using the original correction limits", () => {
    expect(DEFAULT_GAME_RULES).toMatchObject({
      maxStrokes: 120,
      maxUndos: 3,
      colorCount: 12,
      aiObservationPasses: 1,
      aiPlaybackSeconds: 12,
      aiRequestTimeoutSeconds: 180
    });
  });

  it("allows four corrected candidates and detects combined canvas-limit failures", () => {
    expect(MAX_CANVAS_CANDIDATE_ATTEMPTS).toBe(4);
    const validation = validateAiDrawingCandidate(
      [
        {
          type: "stroke",
          id: "off-palette",
          tool: "pen",
          color: "#ffffff",
          width: 8,
          points: [
            { x: 100, y: 100 },
            { x: 300, y: 300 }
          ],
          offsetMs: 0
        }
      ],
      { maxStrokes: 20, maxUndos: 0, colorCount: 4, maxTotalPoints: 4096 }
    );
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues.map((issue) => issue.code)).toContain("color-not-allowed");
    }
    expect(
      validateAiDrawingCandidate(
        [
          {
            type: "stroke",
            id: "valid-stroke",
            tool: "pen",
            color: "#202124",
            width: 8,
            points: [
              { x: 100, y: 100 },
              { x: 300, y: 300 }
            ],
            offsetMs: 0
          }
        ],
        { maxStrokes: 20, maxUndos: 0, colorCount: 4, maxTotalPoints: 4096 },
        "x".repeat(100)
      ).ok
    ).toBe(true);
  });

  it("keeps delta refinements but replaces the canvas after an explicit clear", () => {
    const stroke = (id: string, x: number): CanvasCommand => ({
      type: "stroke",
      id,
      tool: "pen",
      color: "#202124",
      width: 8,
      points: [
        { x, y: 100 },
        { x: x + 20, y: 120 }
      ],
      offsetMs: 0
    });
    const initial = [stroke("old", 100)];
    const result = (clearCanvas: boolean): AiTurnResult => ({
      jobId: "job",
      status: "ok",
      commands: [
        stroke("new", 300),
        { type: "undo", id: "undo-old", targetId: "old", offsetMs: 10 }
      ],
      clearCanvas,
      confidence: 0.7,
      reaction: { kind: "spark", text: "Done" }
    });

    const appended = mergeAiDrawingPass(initial, result(false), "append", 1);
    expect(appended.cleared).toBe(false);
    expect(appended.accumulated.map(({ type }) => type)).toEqual(["stroke", "stroke", "undo"]);

    const replaced = mergeAiDrawingPass(initial, result(true), "replace", 1);
    expect(replaced.cleared).toBe(true);
    expect(replaced.accumulated).toHaveLength(1);
    expect(replaced.accumulated[0]).toMatchObject({ type: "stroke", id: "replace-0" });
  });

  it("maps an inspection undo back to the stable primitive id from the preceding pass", () => {
    const original: AiTurnResult = {
      jobId: "job",
      status: "ok",
      commands: [
        {
          type: "stroke",
          id: "bike-wheel",
          tool: "pen",
          color: "#202124",
          width: 8,
          points: [
            { x: 100, y: 100 },
            { x: 200, y: 200 }
          ],
          offsetMs: 0
        }
      ],
      clearCanvas: false,
      confidence: 0.7,
      reaction: { kind: "spark", text: "First pass" }
    };
    const first = mergeAiDrawingPass([], original, "pass-0", 0);
    const revision: AiTurnResult = {
      ...original,
      commands: [
        { type: "undo", id: "remove-wheel", targetId: "bike-wheel", offsetMs: 0 },
        { ...original.commands![0]!, id: "bike-wheel", offsetMs: 100 }
      ]
    };
    const second = mergeAiDrawingPass(first.accumulated, revision, "pass-1", 1, first.ids);

    expect(second.batch[0]).toMatchObject({
      type: "undo",
      targetId: first.batch[0]?.id
    });
    expect(second.batch[1]).toMatchObject({ type: "stroke", id: "pass-1-1" });
  });

  it("sends only active vector primitives into the next inspection", () => {
    const source: AiCanvasSourceCommand[] = [
      {
        type: "line",
        id: "removed-line",
        tool: "pen",
        color: "#202124",
        width: 8,
        start: { x: 10, y: 10 },
        end: { x: 100, y: 100 },
        offsetMs: 0
      },
      {
        type: "ellipse",
        id: "active-ellipse",
        tool: "pen",
        color: "#202124",
        width: 8,
        cx: 300,
        cy: 250,
        rx: 80,
        ry: 50,
        rotationDeg: 0,
        fill: false,
        offsetMs: 10
      },
      { type: "undo", id: "remove", targetId: "removed-line", offsetMs: 20 },
      { type: "finish", id: "finish", offsetMs: 30 }
    ];

    expect(compactAiCanvasSourceCommands(source).map(({ id }) => id)).toEqual(["active-ellipse"]);
  });

  it("turns skipped command markers into bounded observation feedback", () => {
    const feedback = droppedCommandFeedback([
      'commands[4] id="left-hand" type="mystery" skipped: invalid command',
      'commands[9] id="hat" type="path" skipped: invalid segment'
    ]);

    expect(feedback).toContain("commands[4]");
    expect(feedback).toContain("left-hand");
    expect(feedback).toContain("restore only missing or corrupt marks");
    expect(feedback?.length).toBeLessThanOrEqual(240);
    expect(droppedCommandFeedback([])).toBeUndefined();
  });
});
