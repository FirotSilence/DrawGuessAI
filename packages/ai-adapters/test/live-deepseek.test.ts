import { describe, expect, it } from "vitest";

import { executeAiTurn, type AiTurnJob, type ModelProfile } from "../src";

const environment = (
  globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }
).process?.env;
const ccswitchLive = environment?.TEST_CCSWITCH_DEEPSEEK === "1" ? describe : describe.skip;
const directApiKey = environment?.DEEPSEEK_API_KEY;
const directLive =
  environment?.TEST_DEEPSEEK_DIRECT === "1" && directApiKey !== undefined && directApiKey !== ""
    ? describe
    : describe.skip;

function deepSeekProfile(baseUrl: string, id: string): ModelProfile {
  return {
    id,
    label: "DeepSeek · Direct (text only)",
    protocol: "anthropic-compatible",
    execution: "local",
    baseUrl,
    model: environment?.DEEPSEEK_MODEL ?? "DeepSeek-V4-Flash",
    capabilities: {
      vision: false,
      structuredOutput: "none",
      observationMode: "one-shot",
      maxObservationPasses: 0,
      drawingPlanMode: "inline",
      reasoningMode: "disabled",
      supportedRoles: ["draw", "prompt", "review"]
    },
    secretRef: id,
    enabled: true
  };
}

function deepSeekContract(profile: ModelProfile, apiKey: string) {
  it("returns a valid one-shot vector drawing without advertising vision", async () => {
    const job: AiTurnJob = {
      jobId: "live-draw-deepseek-apple",
      roomId: "live-contract",
      turnIndex: 0,
      role: "draw",
      drawPhase: "render",
      locale: "zh-CN",
      personaId: "maestro",
      inputText: "苹果",
      observationIndex: 0,
      observationLimit: 0,
      timeLimitSeconds: 120,
      budget: {
        maxStrokes: 120,
        maxUndos: 3,
        colorCount: 12,
        remainingStrokes: 120,
        remainingUndos: 3
      }
    };

    const result = await executeAiTurn({
      profile,
      secret: { secretRef: profile.secretRef!, apiKey },
      job,
      timeoutMs: 120_000
    });

    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    expect(result.commands?.some((command) => command.type === "stroke")).toBe(true);
  }, 180_000);

  it("returns a valid temporary prompt for the profile connection test", async () => {
    const result = await executeAiTurn({
      profile,
      secret: { secretRef: profile.secretRef!, apiKey },
      job: {
        jobId: "live-deepseek-prompt",
        roomId: "live-contract",
        turnIndex: -1,
        role: "prompt",
        locale: "zh-CN",
        personaId: "inspector",
        observationIndex: 0,
        observationLimit: 0,
        timeLimitSeconds: 30,
        budget: {
          maxStrokes: 60,
          maxUndos: 3,
          colorCount: 10,
          remainingStrokes: 60,
          remainingUndos: 3
        }
      },
      timeoutMs: 30_000
    });

    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    expect(result.prompt).toBeTruthy();
  }, 60_000);
}

ccswitchLive("CCSwitch DeepSeek live contract", () => {
  deepSeekContract(
    deepSeekProfile("http://127.0.0.1:5000", "ccswitch-local-deepseek-v4-flash"),
    "local-proxy"
  );
});

directLive("official DeepSeek live contract", () => {
  deepSeekContract(
    deepSeekProfile(
      environment?.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/anthropic",
      "deepseek-local-direct"
    ),
    directApiKey ?? "missing-live-test-key"
  );
});
