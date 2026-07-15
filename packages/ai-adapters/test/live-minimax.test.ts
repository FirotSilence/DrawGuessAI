import { describe, expect, it } from "vitest";

import { executeAiTurn, type AiTurnJob, type ModelProfile } from "../src";

const environment = (
  globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }
).process?.env;
const live = environment?.TEST_CCSWITCH_MINIMAX === "1" ? describe : describe.skip;

live("CCSwitch MiniMax live contract", () => {
  it("returns a valid inline first-pass vector drawing within the turn budget", async () => {
    const profile: ModelProfile = {
      id: "ccswitch-local-minimax-m3",
      label: "CCSwitch · MiniMax-M3",
      protocol: "anthropic-compatible",
      execution: "local",
      baseUrl: "http://127.0.0.1:5000",
      model: "MiniMax-M3",
      capabilities: {
        vision: true,
        structuredOutput: "none",
        observationMode: "checkpoint",
        maxObservationPasses: 2,
        drawingPlanMode: "inline"
      },
      secretRef: "ccswitch-local-minimax-m3",
      enabled: true
    };
    const job: AiTurnJob = {
      jobId: "live-draw-elephant",
      roomId: "live-contract",
      turnIndex: 0,
      role: "draw",
      drawPhase: "render",
      locale: "en",
      personaId: "maestro",
      inputText: "elephant",
      observationIndex: 0,
      observationLimit: 2,
      timeLimitSeconds: 120,
      budget: {
        maxStrokes: 120,
        maxUndos: 10,
        colorCount: 12,
        remainingStrokes: 120,
        remainingUndos: 10
      }
    };

    const result = await executeAiTurn({
      profile,
      secret: { secretRef: profile.secretRef!, apiKey: "local-proxy" },
      job,
      timeoutMs: 120_000
    });

    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    expect(result.commands?.some((command) => command.type === "stroke")).toBe(true);
  }, 180_000);
});
