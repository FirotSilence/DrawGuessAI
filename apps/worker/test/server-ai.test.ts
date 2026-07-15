import { describe, expect, it, vi } from "vitest";

import { ModelProfileSchema, type AiTurnJob } from "@drawguessai/ai-adapters";

import {
  MINIMAX_SERVER_PROFILE_ID,
  WORKERS_AI_MODEL,
  WORKERS_AI_PROFILE_ID,
  WORKERS_AI_PROFILE_IDS,
  WORKERS_AI_PROFILES,
  configuredServerProfiles,
  executeServerProfile,
  executeWorkersAi,
  publicServerProfiles
} from "../src/server-ai";

const budget = {
  maxStrokes: 60,
  maxUndos: 3,
  colorCount: 10,
  remainingStrokes: 60,
  remainingUndos: 3
};

const guessJob: AiTurnJob = {
  jobId: "worker-ai-job",
  roomId: "room",
  turnIndex: 1,
  role: "guess",
  locale: "en",
  personaId: "deadpan",
  inputText: "previous guess",
  imageDataUrl: "data:image/png;base64,AA==",
  observationIndex: 0,
  observationLimit: 1,
  timeLimitSeconds: 45,
  budget
};

const promptJob: AiTurnJob = {
  jobId: "worker-prompt-job",
  roomId: "room",
  turnIndex: -1,
  role: "prompt",
  locale: "en",
  personaId: "deadpan",
  observationIndex: 0,
  observationLimit: 0,
  timeLimitSeconds: 45,
  budget
};

const drawJob: AiTurnJob = {
  ...guessJob,
  jobId: "worker-draw-job",
  turnIndex: 0,
  role: "draw",
  inputText: "a bicycle in the rain",
  imageDataUrl: undefined,
  observationLimit: 0
};

function resultText(guess = "a bicycle in the rain") {
  return JSON.stringify({
    jobId: guessJob.jobId,
    status: "ok",
    guess,
    confidence: 0.72,
    reaction: { kind: "spark", text: "I nearly missed that one." }
  });
}

function promptResultText(prompt = "a cat under an umbrella") {
  return JSON.stringify({
    jobId: promptJob.jobId,
    status: "ok",
    prompt,
    confidence: 0.8,
    reaction: { kind: "spark", text: "This one should travel well." }
  });
}

function workersAi(run: ReturnType<typeof vi.fn>): Ai {
  return { run } as unknown as Ai;
}

describe("server AI profiles", () => {
  it("builds the vision-capable MiniMax profile from dedicated secrets", () => {
    const token = "x".repeat(756);
    const profiles = configuredServerProfiles({
      MINIMAX_API_KEY: token,
      MINIMAX_BASE_URL: "https://api.minimaxi.com/anthropic",
      MINIMAX_MODEL: "MiniMax-M3[1M]"
    });

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      apiKey: token,
      profile: {
        id: MINIMAX_SERVER_PROFILE_ID,
        protocol: "anthropic-compatible",
        model: "MiniMax-M3[1M]",
        capabilities: {
          vision: true,
          observationMode: "checkpoint",
          maxObservationPasses: 2,
          supportedRoles: ["prompt", "draw", "guess", "review"]
        }
      }
    });

    const publicProfiles = publicServerProfiles(profiles, true);
    const publicJson = JSON.stringify(publicProfiles);
    expect(publicJson).not.toContain(token);
    expect(publicProfiles.map(({ id }) => id)).toEqual([
      MINIMAX_SERVER_PROFILE_ID,
      ...WORKERS_AI_PROFILES.map(({ id }) => id)
    ]);
    for (const profile of publicProfiles) {
      expect(() =>
        ModelProfileSchema.parse({
          ...profile,
          protocol: "openai-compatible",
          baseUrl: "https://server.invalid",
          model: profile.id,
          enabled: true
        })
      ).not.toThrow();
    }
  });

  it("does not advertise MiniMax when its secret is absent or malformed", () => {
    expect(configuredServerProfiles({})).toEqual([]);
    expect(
      configuredServerProfiles({
        MINIMAX_API_KEY: "secret",
        MINIMAX_BASE_URL: "not-a-url"
      })
    ).toEqual([]);
  });

  it("applies the externally configured MiniMax observation ceiling", () => {
    const disabled = configuredServerProfiles({
      MINIMAX_API_KEY: "secret",
      MINIMAX_MAX_OBSERVATION_PASSES: "0"
    })[0]!;
    expect(disabled.profile.capabilities).toMatchObject({
      observationMode: "one-shot",
      maxObservationPasses: 0
    });

    const singlePass = configuredServerProfiles({
      MINIMAX_API_KEY: "secret",
      MINIMAX_MAX_OBSERVATION_PASSES: "1"
    })[0]!;
    expect(singlePass.profile.capabilities).toMatchObject({
      observationMode: "checkpoint",
      maxObservationPasses: 1
    });
  });

  it("reserves every built-in Workers AI profile ID", () => {
    const records = WORKERS_AI_PROFILES.map(({ id }, index) => ({
      profile: {
        id,
        label: `Injected ${index}`,
        protocol: "openai-compatible" as const,
        execution: "server" as const,
        baseUrl: "https://provider.example/v1",
        model: "injected",
        capabilities: {
          vision: true,
          structuredOutput: "json-schema" as const,
          observationMode: "one-shot" as const,
          maxObservationPasses: 0
        },
        secretRef: `secret-${index}`,
        enabled: true
      },
      apiKey: "must-not-win"
    }));
    expect(configuredServerProfiles({ SERVER_AI_PROFILES_JSON: JSON.stringify(records) })).toEqual(
      []
    );
  });

  it("uses CCSwitch token-plan bearer authentication for MiniMax", async () => {
    const token = "ccswitch-token";
    const profiles = configuredServerProfiles({
      MINIMAX_API_KEY: token,
      MINIMAX_BASE_URL: "https://api.minimaxi.com/anthropic",
      MINIMAX_MODEL: "MiniMax-M3[1M]"
    });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(headers.has("x-api-key")).toBe(false);
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: resultText("a rainy bicycle") }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await executeServerProfile(
        profiles,
        workersAi(vi.fn()),
        MINIMAX_SERVER_PROFILE_ID,
        guessJob
      );
      expect(result.guess).toBe("a rainy bicycle");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the Llama vision binding and guided JSON dialect", async () => {
    const run = vi.fn().mockResolvedValue({ response: resultText() });
    const result = await executeServerProfile([], workersAi(run), WORKERS_AI_PROFILE_ID, guessJob);

    expect(result.guess).toBe("a bicycle in the rain");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe(WORKERS_AI_MODEL);
    const request = run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.guided_json).toBeDefined();
    expect(request.max_tokens).toBe(512);
    expect(JSON.stringify(request.messages)).toContain(guessJob.imageDataUrl);
  });

  it.each([
    [WORKERS_AI_PROFILE_IDS.gemma, "@cf/google/gemma-4-26b-a4b-it"],
    [WORKERS_AI_PROFILE_IDS.kimi, "@cf/moonshotai/kimi-k2.6"]
  ])("uses chat-completions structured output for %s", async (profileId, model) => {
    const run = vi.fn().mockResolvedValue({
      choices: [{ message: { content: resultText() } }]
    });
    const result = await executeWorkersAi(workersAi(run), profileId, guessJob);

    expect(result.guess).toBe("a bicycle in the rain");
    expect(run.mock.calls[0]?.[0]).toBe(model);
    const request = run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.response_format).toMatchObject({ type: "json_schema" });
    expect(JSON.stringify(request.messages)).toContain(guessJob.imageDataUrl);
    if (profileId === WORKERS_AI_PROFILE_IDS.kimi) {
      expect(request.chat_template_kwargs).toEqual({ thinking: false });
    }
    expect(request.max_completion_tokens).toBe(512);
  });

  it("uses Moondream's image-query dialect for guessing", async () => {
    const run = vi.fn().mockResolvedValue({ answer: resultText("a rainy cycle") });
    const result = await executeWorkersAi(
      workersAi(run),
      WORKERS_AI_PROFILE_IDS.moondream,
      guessJob
    );

    expect(result.guess).toBe("a rainy cycle");
    const request = run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(run.mock.calls[0]?.[0]).toBe("@cf/moondream/moondream3.1-9B-A2B");
    expect(request).toMatchObject({
      task: "query",
      image: guessJob.imageDataUrl,
      reasoning: false,
      stream: false
    });
  });

  it("uses GLM for text prompt generation without sending an image", async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [{ message: { content: promptResultText() } }]
    });
    const result = await executeWorkersAi(workersAi(run), WORKERS_AI_PROFILE_IDS.glm, promptJob);

    expect(result.prompt).toBe("a cat under an umbrella");
    expect(run.mock.calls[0]?.[0]).toBe("@cf/zai-org/glm-4.7-flash");
    const request = run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.response_format).toMatchObject({ type: "json_schema" });
    expect(JSON.stringify(request)).not.toContain("data:image");
  });

  it("rejects role-limited models before contacting Workers AI", async () => {
    const run = vi.fn();
    await expect(
      executeWorkersAi(workersAi(run), WORKERS_AI_PROFILE_IDS.moondream, drawJob)
    ).rejects.toThrow(/does not support draw/);
    await expect(
      executeWorkersAi(workersAi(run), WORKERS_AI_PROFILE_IDS.glm, guessJob)
    ).rejects.toThrow(/does not support guess/);
    expect(run).not.toHaveBeenCalled();
  });

  it("repairs one invalid Workers AI response and then falls back", async () => {
    const repairedRun = vi
      .fn()
      .mockResolvedValueOnce({ response: "not-json" })
      .mockResolvedValueOnce({ response: resultText("a repaired guess") });
    const repaired = await executeWorkersAi(
      workersAi(repairedRun),
      WORKERS_AI_PROFILE_ID,
      guessJob
    );
    expect(repaired.guess).toBe("a repaired guess");
    expect(repairedRun).toHaveBeenCalledTimes(2);

    const failedRun = vi.fn().mockResolvedValue({ response: "still-not-json" });
    const failed = await executeWorkersAi(workersAi(failedRun), WORKERS_AI_PROFILE_ID, guessJob);
    expect(failed.status).toBe("fallback");
    expect(failed.errorCode).toBe("invalid-response");
    expect(failedRun).toHaveBeenCalledTimes(2);
  });

  it("retries a malformed Workers AI envelope", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ unexpected: true })
      .mockResolvedValueOnce({ response: resultText("a repaired envelope") });

    const result = await executeWorkersAi(workersAi(run), WORKERS_AI_PROFILE_ID, guessJob);

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");
    expect(result.guess).toBe("a repaired envelope");
  });

  it("retries a blank initial Workers AI drawing four times", async () => {
    const blank = JSON.stringify({
      jobId: drawJob.jobId,
      status: "ok",
      clearCanvas: false,
      commands: [{ type: "finish", id: "finish", offsetMs: 0 }],
      confidence: 0.1,
      reaction: { kind: "confused", text: "Blank." }
    });
    const run = vi.fn().mockResolvedValue({ response: blank });
    const result = await executeWorkersAi(workersAi(run), WORKERS_AI_PROFILE_ID, drawJob);

    expect(run).toHaveBeenCalledTimes(4);
    expect(result.status).toBe("fallback");
    expect(result.errorCode).toBe("empty-drawing");
  });

  it("keeps a Workers AI repair inside the original turn deadline", async () => {
    vi.useFakeTimers();
    try {
      const run = vi
        .fn()
        .mockImplementationOnce(
          () => new Promise((resolve) => setTimeout(() => resolve({ response: "not-json" }), 600))
        )
        .mockImplementationOnce(() => new Promise(() => undefined));
      const pending = executeWorkersAi(workersAi(run), WORKERS_AI_PROFILE_ID, guessJob, 1_000);

      await vi.advanceTimersByTimeAsync(600);
      await vi.advanceTimersByTimeAsync(400);
      const result = await pending;

      expect(run).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("fallback");
      expect(result.errorCode).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});
