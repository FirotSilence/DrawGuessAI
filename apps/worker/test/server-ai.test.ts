import { describe, expect, it, vi } from "vitest";

import { ModelProfileSchema, type AiTurnJob } from "@drawguessai/ai-adapters";

import {
  MINIMAX_SERVER_PROFILE_ID,
  WORKERS_AI_MODEL,
  WORKERS_AI_PROFILE_ID,
  WORKERS_AI_PROFILE_IDS,
  WORKERS_AI_PROFILES,
  configuredServerProfiles,
  configuredServerProfilesWithDiagnostics,
  configuredWorkersAiProfiles,
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
  it("builds a provider-neutral default profile from scalar environment settings", () => {
    const token = "generic-token";
    const profiles = configuredServerProfiles({
      SERVER_AI_API_KEY: token,
      SERVER_AI_PROFILE_ID: "server-primary",
      SERVER_AI_LABEL: "Hosted multimodal model",
      SERVER_AI_PROTOCOL: "anthropic-compatible",
      SERVER_AI_AUTH_MODE: "bearer",
      SERVER_AI_BASE_URL: "https://provider.example/anthropic",
      SERVER_AI_MODEL: "vision-model-v2",
      SERVER_AI_VISION: "true",
      SERVER_AI_STRUCTURED_OUTPUT: "json-object",
      SERVER_AI_MAX_OBSERVATION_PASSES: "2",
      SERVER_AI_DRAWING_PLAN_MODE: "separate",
      SERVER_AI_REASONING_MODE: "disabled",
      SERVER_AI_SUPPORTED_ROLES: "prompt,draw,guess,review"
    });

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      apiKey: token,
      authMode: "bearer",
      profile: {
        id: "server-primary",
        label: "Hosted multimodal model",
        protocol: "anthropic-compatible",
        execution: "server",
        baseUrl: "https://provider.example/anthropic",
        model: "vision-model-v2",
        capabilities: {
          vision: true,
          structuredOutput: "json-object",
          observationMode: "checkpoint",
          maxObservationPasses: 2,
          drawingPlanMode: "separate",
          reasoningMode: "disabled",
          supportedRoles: ["prompt", "draw", "guess", "review"]
        },
        enabled: true
      }
    });
  });

  it("keeps the MiniMax variables as a backwards-compatible deployment alias", () => {
    const token = "x".repeat(756);
    const profiles = configuredServerProfiles({
      MINIMAX_API_KEY: token,
      MINIMAX_BASE_URL: "https://api.minimaxi.com/anthropic",
      MINIMAX_MODEL: "MiniMax-M3[1M]"
    });

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      apiKey: token,
      authMode: "bearer",
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

  it("rejects unsafe or contradictory scalar capability declarations", () => {
    expect(
      configuredServerProfiles({
        SERVER_AI_API_KEY: "secret",
        SERVER_AI_BASE_URL: "https://provider.example/v1",
        SERVER_AI_MODEL: "text-model",
        SERVER_AI_VISION: "false",
        SERVER_AI_SUPPORTED_ROLES: "draw,guess"
      })
    ).toEqual([]);
    expect(
      configuredServerProfiles({
        SERVER_AI_API_KEY: "secret",
        SERVER_AI_BASE_URL: "https://provider.example/v1",
        SERVER_AI_MODEL: "model",
        SERVER_AI_VISION: "sometimes"
      })
    ).toEqual([]);
  });

  it("uses conservative text-only defaults for a minimally configured provider", () => {
    const [record] = configuredServerProfiles({
      SERVER_AI_API_KEY: "secret",
      SERVER_AI_BASE_URL: "https://provider.example/v1",
      SERVER_AI_MODEL: "text-model"
    });
    expect(record).toMatchObject({
      authMode: "protocol-default",
      profile: {
        id: "server-default",
        label: "Server · text-model",
        protocol: "openai-compatible",
        capabilities: {
          vision: false,
          structuredOutput: "none",
          observationMode: "one-shot",
          maxObservationPasses: 0,
          supportedRoles: ["prompt", "draw", "review"]
        }
      }
    });
  });

  it("keeps a scalar profile valid when an omitted label has a long model name", () => {
    const model = `provider/${"long-model-name-".repeat(7)}`.slice(0, 120);
    const configuration = configuredServerProfilesWithDiagnostics({
      SERVER_AI_API_KEY: "secret",
      SERVER_AI_BASE_URL: "https://provider.example/v1",
      SERVER_AI_MODEL: model
    });

    expect(configuration.issues).toEqual([]);
    expect(configuration.profiles).toHaveLength(1);
    expect(configuration.profiles[0]?.profile.model).toBe(model);
    expect([...configuration.profiles[0]!.profile.label]).toHaveLength(40);
  });

  it("reports sanitized configuration diagnostics without exposing secret values", () => {
    const secret = "do-not-expose-this-token";
    const valid = {
      profile: {
        id: "server-valid-diagnostic",
        label: "Valid diagnostic model",
        protocol: "openai-compatible",
        execution: "server",
        baseUrl: "https://provider.example/v1",
        model: "model",
        capabilities: {
          vision: false,
          structuredOutput: "none",
          observationMode: "one-shot",
          maxObservationPasses: 0,
          supportedRoles: ["draw"]
        },
        enabled: true
      },
      apiKey: secret
    };
    const configuration = configuredServerProfilesWithDiagnostics({
      SERVER_AI_API_KEY: secret,
      SERVER_AI_BASE_URL: "not-a-url",
      SERVER_AI_MODEL: "model",
      SERVER_AI_PROFILES_JSON: JSON.stringify([{ apiKey: secret, broken: true }, valid])
    });

    expect(configuration.profiles.map(({ profile }) => profile.id)).toEqual([
      "server-valid-diagnostic"
    ]);
    expect(configuration.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "scalar", code: "invalid-profile" }),
        expect.objectContaining({ source: "profiles-json", code: "invalid-profile", index: 0 })
      ])
    );
    expect(JSON.stringify(configuration.issues)).not.toContain(secret);
    expect(JSON.stringify(configuration.issues)).not.toContain("not-a-url");
  });

  it("distinguishes malformed profile JSON from an empty configuration", () => {
    expect(configuredServerProfilesWithDiagnostics({}).issues).toEqual([]);
    expect(
      configuredServerProfilesWithDiagnostics({ SERVER_AI_PROFILES_JSON: "not json" }).issues
    ).toEqual([{ source: "profiles-json", code: "invalid-json" }]);
  });

  it("skips a malformed JSON profile without hiding valid siblings", () => {
    const valid = {
      profile: {
        id: "server-valid",
        label: "Valid model",
        protocol: "openai-compatible",
        execution: "server",
        baseUrl: "https://provider.example/v1",
        model: "model",
        capabilities: {
          vision: false,
          structuredOutput: "none",
          observationMode: "one-shot",
          maxObservationPasses: 0,
          supportedRoles: ["draw"]
        },
        enabled: true
      },
      apiKey: "secret",
      authMode: "x-api-key"
    };
    const records = configuredServerProfiles({
      SERVER_AI_PROFILES_JSON: JSON.stringify([{ broken: true }, valid])
    });
    expect(records).toEqual([valid]);
  });

  it("resolves each JSON profile key from a separate Worker secret reference", () => {
    const token = "separate-secret-value";
    const record = {
      profile: {
        id: "server-key-reference",
        label: "Referenced key model",
        protocol: "openai-compatible",
        execution: "server",
        baseUrl: "https://provider.example/v1",
        model: "vision-model",
        capabilities: {
          vision: true,
          structuredOutput: "json-schema",
          observationMode: "checkpoint",
          maxObservationPasses: 1,
          supportedRoles: ["prompt", "draw", "guess", "review"]
        },
        enabled: true
      },
      apiKeyRef: "VISION_PROVIDER_API_KEY",
      authMode: "bearer"
    };
    const environment = {
      SERVER_AI_PROFILES_JSON: JSON.stringify([record]),
      VISION_PROVIDER_API_KEY: token
    };
    const configuration = configuredServerProfilesWithDiagnostics(environment);

    expect(configuration.issues).toEqual([]);
    expect(configuration.profiles).toHaveLength(1);
    expect(configuration.profiles[0]).toMatchObject({
      profile: { id: "server-key-reference" },
      apiKey: token,
      authMode: "bearer"
    });
    expect(JSON.stringify(publicServerProfiles(configuration.profiles, false))).not.toContain(
      token
    );
  });

  it("accepts authentication metadata inside a shared model profile and rejects conflicts", () => {
    const profile = {
      id: "server-nested-auth",
      label: "Nested auth model",
      protocol: "openai-compatible",
      authMode: "x-api-key",
      execution: "server",
      baseUrl: "https://provider.example/v1",
      model: "model",
      capabilities: {
        vision: false,
        structuredOutput: "none",
        observationMode: "one-shot",
        maxObservationPasses: 0,
        supportedRoles: ["draw"]
      },
      enabled: true
    };
    const accepted = configuredServerProfilesWithDiagnostics({
      SERVER_AI_PROFILES_JSON: JSON.stringify([{ profile, apiKey: "secret" }])
    });
    expect(accepted.issues).toEqual([]);
    expect(accepted.profiles[0]?.authMode).toBe("x-api-key");

    const rejected = configuredServerProfilesWithDiagnostics({
      SERVER_AI_PROFILES_JSON: JSON.stringify([{ profile, apiKey: "secret", authMode: "bearer" }])
    });
    expect(rejected.profiles).toEqual([]);
    expect(rejected.issues).toEqual([
      expect.objectContaining({
        source: "profiles-json",
        code: "invalid-profile",
        index: 0,
        path: "authMode"
      })
    ]);
  });

  it("reports a missing referenced profile key without leaking its variable name as a value", () => {
    const record = {
      profile: {
        id: "server-missing-key",
        label: "Missing key model",
        protocol: "openai-compatible",
        execution: "server",
        baseUrl: "https://provider.example/v1",
        model: "model",
        capabilities: {
          vision: false,
          structuredOutput: "none",
          observationMode: "one-shot",
          maxObservationPasses: 0,
          supportedRoles: ["draw"]
        },
        enabled: true
      },
      apiKeyRef: "MISSING_PROVIDER_KEY"
    };
    const configuration = configuredServerProfilesWithDiagnostics({
      SERVER_AI_PROFILES_JSON: JSON.stringify([record])
    });

    expect(configuration.profiles).toEqual([]);
    expect(configuration.issues).toEqual([
      {
        source: "profiles-json",
        code: "missing-referenced-secret",
        index: 0,
        path: "apiKeyRef"
      }
    ]);
    expect(JSON.stringify(configuration.issues)).not.toContain("MISSING_PROVIDER_KEY");
  });

  it("rejects profile metadata that exceeds the Cloudflare variable size budget", () => {
    const configuration = configuredServerProfilesWithDiagnostics({
      SERVER_AI_PROFILES_JSON: " ".repeat(5 * 1024 + 1)
    });
    expect(configuration.profiles).toEqual([]);
    expect(configuration.issues).toEqual([
      { source: "profiles-json", code: "configuration-too-large" }
    ]);
  });

  it("reports when a scalar profile pushes the combined server profile count over eight", () => {
    const records = Array.from({ length: 8 }, (_, index) => ({
      profile: {
        id: `server-list-${index}`,
        label: `Server ${index}`,
        protocol: "openai-compatible",
        execution: "server",
        baseUrl: "https://provider.example/v1",
        model: "model",
        capabilities: {
          vision: false,
          structuredOutput: "none",
          observationMode: "one-shot",
          maxObservationPasses: 0,
          supportedRoles: ["draw"]
        },
        enabled: true
      },
      apiKey: "secret"
    }));
    const configuration = configuredServerProfilesWithDiagnostics({
      SERVER_AI_API_KEY: "scalar-secret",
      SERVER_AI_BASE_URL: "https://provider.example/v1",
      SERVER_AI_MODEL: "scalar-model",
      SERVER_AI_PROFILES_JSON: JSON.stringify(records)
    });

    expect(configuration.profiles).toHaveLength(8);
    expect(configuration.issues).toContainEqual({
      source: "profiles-json",
      code: "profile-limit-exceeded"
    });
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

  it("supports explicit bearer authentication for any Anthropic-compatible server", async () => {
    const token = "provider-token";
    const profiles = configuredServerProfiles({
      SERVER_AI_API_KEY: token,
      SERVER_AI_PROFILE_ID: "server-anthropic-bearer",
      SERVER_AI_PROTOCOL: "anthropic-compatible",
      SERVER_AI_AUTH_MODE: "bearer",
      SERVER_AI_BASE_URL: "https://provider.example/anthropic",
      SERVER_AI_MODEL: "multimodal-model",
      SERVER_AI_VISION: "true",
      SERVER_AI_MAX_OBSERVATION_PASSES: "1"
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
        "server-anthropic-bearer",
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

  it("advertises and executes a deployment-configured Workers AI model", async () => {
    const custom = {
      id: "cloudflare-workers-ai-custom-vision-lab",
      label: "Cloudflare · Vision Lab",
      model: "@cf/example/vision-lab-8b",
      dialect: "chat-completions",
      capabilities: {
        vision: true,
        structuredOutput: "json-schema",
        observationMode: "checkpoint",
        maxObservationPasses: 1,
        drawingPlanMode: "inline",
        supportedRoles: ["prompt", "draw", "guess", "review"]
      },
      chatTemplateKwargs: { thinking: false }
    };
    const environment = { WORKERS_AI_PROFILES_JSON: JSON.stringify([custom]) };
    const configuration = configuredServerProfilesWithDiagnostics(environment);
    const publicProfiles = publicServerProfiles(
      configuration.profiles,
      true,
      configuration.workersAiProfiles
    );

    expect(configuration.issues).toEqual([]);
    expect(configuredWorkersAiProfiles(environment).at(-1)?.id).toBe(custom.id);
    expect(publicProfiles.some(({ id }) => id === custom.id)).toBe(true);

    const run = vi.fn().mockResolvedValue({
      choices: [{ message: { content: resultText("a custom vision answer") } }]
    });
    const result = await executeServerProfile(
      [],
      workersAi(run),
      custom.id,
      guessJob,
      configuration.workersAiProfiles
    );
    expect(result.guess).toBe("a custom vision answer");
    expect(run.mock.calls[0]?.[0]).toBe(custom.model);
  });

  it("rejects unsafe or contradictory custom Workers AI definitions", () => {
    const invalid = [
      {
        id: "cloudflare-workers-ai-custom-external-url",
        label: "External URL",
        model: "https://provider.example/model",
        dialect: "chat-completions",
        capabilities: {
          vision: false,
          structuredOutput: "json-schema",
          observationMode: "one-shot",
          maxObservationPasses: 0,
          supportedRoles: ["draw"]
        }
      },
      {
        id: "cloudflare-workers-ai-custom-unsafe-options",
        label: "Unsafe options",
        model: "@cf/example/model",
        dialect: "chat-completions",
        capabilities: {
          vision: false,
          structuredOutput: "json-schema",
          observationMode: "one-shot",
          maxObservationPasses: 0,
          supportedRoles: ["draw"]
        },
        chatTemplateKwargs: { temperature: 99 }
      },
      {
        id: "cloudflare-workers-ai-custom-wrong-moondream",
        label: "Wrong Moondream",
        model: "@cf/example/moondream",
        dialect: "moondream-query",
        capabilities: {
          vision: true,
          structuredOutput: "none",
          observationMode: "one-shot",
          maxObservationPasses: 0,
          supportedRoles: ["draw", "guess"]
        }
      },
      {
        id: "cloudflare-workers-ai-custom-ignored-options",
        label: "Ignored options",
        model: "@cf/example/model",
        dialect: "llama-guided",
        capabilities: {
          vision: false,
          structuredOutput: "json-schema",
          observationMode: "one-shot",
          maxObservationPasses: 0,
          supportedRoles: ["draw"]
        },
        chatTemplateKwargs: { thinking: false }
      }
    ];
    const configuration = configuredServerProfilesWithDiagnostics({
      WORKERS_AI_PROFILES_JSON: JSON.stringify(invalid)
    });

    expect(configuration.workersAiProfiles).toEqual(WORKERS_AI_PROFILES);
    expect(configuration.issues).toHaveLength(4);
    expect(configuration.issues.every(({ source }) => source === "workers-ai-json")).toBe(true);
  });

  it("bounds the number of custom Workers AI profiles", () => {
    const profiles = Array.from({ length: 6 }, (_, index) => ({
      id: `cloudflare-workers-ai-custom-model-${index}`,
      label: `Custom ${index}`,
      model: `@cf/example/model-${index}`,
      dialect: "llama-guided",
      capabilities: {
        vision: false,
        structuredOutput: "json-schema",
        observationMode: "one-shot",
        maxObservationPasses: 0,
        supportedRoles: ["draw"]
      }
    }));
    const configuration = configuredServerProfilesWithDiagnostics({
      WORKERS_AI_PROFILES_JSON: JSON.stringify(profiles)
    });
    expect(configuration.workersAiProfiles).toEqual(WORKERS_AI_PROFILES);
    expect(configuration.issues).toEqual([
      expect.objectContaining({ source: "workers-ai-json", code: "invalid-profile-list" })
    ]);
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
    const glm = WORKERS_AI_PROFILES.find(({ id }) => id === WORKERS_AI_PROFILE_IDS.glm);
    expect(glm?.label).toMatch(/text only/i);
    expect(glm?.capabilities.vision).toBe(false);
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
