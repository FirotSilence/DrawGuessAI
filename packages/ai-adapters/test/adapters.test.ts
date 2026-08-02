import { describe, expect, it, vi } from "vitest";
import { validateCanvasCommands } from "@drawguessai/canvas-protocol";
import {
  POST_GAME_REVIEW_GENERATED_TEXT_LIMIT,
  POST_GAME_REVIEW_RECOMMENDED_TEXT_LIMIT
} from "@drawguessai/game-core";

import {
  AI_DISPLAY_NAMES,
  AI_PERSONAS,
  AiReviewSchema,
  AiTurnJobSchema,
  buildSystemPrompt,
  buildUserPrompt,
  createFallbackAiTurnResult,
  createDemoTurnResult,
  executeAiTurn,
  isLiveReactionSpoilerFree,
  maxAiResponseAttemptsForJob,
  ModelCapabilitiesSchema,
  modelMaxTokensForJob,
  modelObservationPassLimit,
  modelSupportsRole,
  modelTemperatureForJob,
  observationPassLimitForRole,
  parseAiTurnResult,
  parseAiTurnResultForJob,
  ProviderAuthModeSchema,
  type AiTurnJob,
  type ModelProfile,
  type ModelSecret
} from "../src";

const job: AiTurnJob = {
  jobId: "job-1",
  roomId: "room",
  turnIndex: 0,
  role: "guess",
  locale: "en",
  personaId: "deadpan",
  imageDataUrl: "data:image/png;base64,AA==",
  inputText: "a strange station",
  observationIndex: 0,
  observationLimit: 0,
  timeLimitSeconds: 45,
  budget: {
    maxStrokes: 60,
    maxUndos: 3,
    colorCount: 10,
    remainingStrokes: 60,
    remainingUndos: 3
  }
};

const secret: ModelSecret = { secretRef: "secret-1", apiKey: "private-key-value" };

function profile(protocol: ModelProfile["protocol"]): ModelProfile {
  return {
    id: protocol,
    label: protocol,
    protocol,
    execution: "local",
    baseUrl: protocol === "demo" ? "https://demo.invalid" : "https://provider.example/v1",
    model: "vision-model",
    capabilities: {
      vision: true,
      structuredOutput: "json-schema",
      observationMode: "checkpoint",
      maxObservationPasses: 1
    },
    secretRef: "secret-1",
    enabled: true
  };
}

describe("AI adapters", () => {
  it("keeps Chinese display-name candidates distinct and brand-neutral", () => {
    expect(AI_DISPLAY_NAMES["zh-CN"]).toContain("南乔");
    expect(AI_DISPLAY_NAMES["zh-CN"]).not.toContain("元宝");
    expect(new Set(AI_DISPLAY_NAMES["zh-CN"]).size).toBe(AI_DISPLAY_NAMES["zh-CN"].length);
  });

  it("recommends compact roundtable lines and enforces the generation ceiling", () => {
    const text = "A".repeat(POST_GAME_REVIEW_GENERATED_TEXT_LIMIT);
    expect(AiReviewSchema.parse({ text, score: 3 }).text).toBe(text);
    expect(() => AiReviewSchema.parse({ text: `${text}A`, score: 3 })).toThrow();
    expect(() =>
      parseAiTurnResult(
        JSON.stringify({
          jobId: "overlong-review",
          status: "ok",
          review: { text: `${text}A`, score: 3 },
          confidence: 0.7,
          reaction: { kind: "confused", text: "Wait." }
        }),
        "overlong-review"
      )
    ).toThrow();
    expect(POST_GAME_REVIEW_RECOMMENDED_TEXT_LIMIT).toBe(50);
    expect(POST_GAME_REVIEW_GENERATED_TEXT_LIMIT).toBe(100);
  });

  it("gives roundtable turns more sampling freedom than factual turns", () => {
    expect(modelTemperatureForJob({ ...job, role: "review", imageDataUrl: undefined })).toBe(0.95);
    expect(modelTemperatureForJob(job)).toBe(0.45);
  });

  it("includes and validates the real turn deadline in every model job", () => {
    expect(buildSystemPrompt({ ...job, timeLimitSeconds: 17 })).toContain("within 17 seconds");
    expect(() => AiTurnJobSchema.parse({ ...job, timeLimitSeconds: 4 })).toThrow();
  });

  it("asks for fresh first-person live reactions that remain spoiler-free", () => {
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "spoiler-free-reaction",
      role: "draw",
      locale: "zh-CN",
      imageDataUrl: undefined,
      inputText: "红雨伞",
      drawPhase: "render"
    };
    const system = buildSystemPrompt(drawJob);
    expect(system).toContain("现场反应保密规则，优先级最高");
    expect(system).toContain("题目、猜词、图片和绘图指令已被完全遮住");
    expect(system).toContain("只要一句话能帮助别人缩小答案范围，就是泄题");
    expect(system).toContain("简短、质朴、自然");
    expect(system).toContain("不要写尴尬比喻");
    expect(system).toContain("不要复用固定句式");
    expect(system).toContain("现场反应信息防火墙");
    expect(system).toContain("只能从自己的情绪、把握和时间压力中取材");
    expect(createDemoTurnResult(drawJob).reaction.text).not.toContain("红雨伞");
    expect(() =>
      parseAiTurnResultForJob(
        JSON.stringify({
          jobId: drawJob.jobId,
          status: "ok",
          commands: [
            {
              type: "stroke",
              id: "mark",
              tool: "pen",
              color: "#202124",
              width: 8,
              points: [
                { x: 180, y: 180 },
                { x: 520, y: 460 }
              ],
              offsetMs: 0
            }
          ],
          clearCanvas: false,
          confidence: 0.7,
          reaction: { kind: "confused", text: "我看见雨伞了。" }
        }),
        drawJob
      )
    ).toThrow(/Live reaction must not reveal/);
    expect(() =>
      parseAiTurnResultForJob(
        JSON.stringify({
          jobId: drawJob.jobId,
          status: "ok",
          commands: [
            {
              type: "line",
              id: "mark",
              start: [180, 180],
              end: [520, 460]
            }
          ],
          clearCanvas: false,
          confidence: 0.7,
          reaction: { kind: "confused", text: "我画了一把遮雨的东西。" }
        }),
        drawJob
      )
    ).toThrow(/Live reaction must not reveal/);
    expect(() =>
      parseAiTurnResultForJob(
        JSON.stringify({
          jobId: drawJob.jobId,
          status: "ok",
          commands: [
            {
              type: "line",
              id: "mark",
              start: [180, 180],
              end: [520, 460]
            }
          ],
          clearCanvas: false,
          confidence: 0.7,
          reaction: { kind: "spark", text: "我现在对蓝色三角形很有信心。" }
        }),
        drawJob
      )
    ).toThrow(/Live reaction must not reveal/);
  });

  it("keeps harmless visual idioms and normalizes common prompt metadata aliases", () => {
    const promptJob: AiTurnJob = {
      ...job,
      jobId: "prompt-alias-reaction",
      turnIndex: -1,
      role: "prompt",
      imageDataUrl: undefined,
      inputText: undefined
    };
    const result = parseAiTurnResultForJob(
      JSON.stringify({
        jobId: promptJob.jobId,
        status: "ok",
        confidence: 0.85,
        reaction: { kind: "confident", text: "I've got a clear picture in mind." },
        prompt: "a cat chasing a mouse",
        promptKind: "action",
        promptTopic: "animal"
      }),
      promptJob
    );

    expect(result.reaction.kind).toBe("spark");
    expect(result.promptKind).toBe("phrase");
    expect(isLiveReactionSpoilerFree(result, promptJob)).toBe(true);
  });

  it("keeps every persona's built-in live reaction content-free", () => {
    for (const persona of AI_PERSONAS) {
      for (const locale of ["zh-CN", "en"] as const) {
        const drawJob: AiTurnJob = {
          ...job,
          jobId: `safe-fallback-${persona.id}-${locale}`,
          role: "draw",
          locale,
          personaId: persona.id,
          imageDataUrl: undefined,
          inputText: locale === "zh-CN" ? "红雨伞" : "red umbrella",
          drawPhase: "render"
        };
        expect(isLiveReactionSpoilerFree(createDemoTurnResult(drawJob), drawJob)).toBe(true);
        expect(
          isLiveReactionSpoilerFree(
            createFallbackAiTurnResult(drawJob, "invalid-response"),
            drawJob
          )
        ).toBe(true);
      }
    }
  });

  it("repairs a live reaction that repeats the hidden drawing content", async () => {
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "reaction-leak-repair",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "red umbrella",
      drawPhase: "render"
    };
    const response = (reaction: string) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  jobId: drawJob.jobId,
                  status: "ok",
                  commands: [
                    {
                      type: "stroke",
                      id: "mark",
                      tool: "pen",
                      color: "#202124",
                      width: 8,
                      points: [
                        { x: 180, y: 180 },
                        { x: 520, y: 460 }
                      ],
                      offsetMs: 0
                    }
                  ],
                  clearCanvas: false,
                  confidence: 0.7,
                  reaction: { kind: "confused", text: reaction }
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response("That umbrella was obvious, surely."))
      .mockResolvedValueOnce(response("I need a minute after that."));

    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job: drawJob,
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.reaction.text).toBe("I need a minute after that.");
  });

  it("uses compact role-specific output budgets without shrinking the drawing canvas budget", () => {
    const renderJob: AiTurnJob = {
      ...job,
      role: "draw",
      imageDataUrl: undefined,
      drawPhase: "render"
    };
    expect(modelMaxTokensForJob({ ...renderJob, drawPhase: "plan" })).toBe(1_024);
    expect(modelMaxTokensForJob(renderJob)).toBe(6_144);
    expect(modelMaxTokensForJob({ ...renderJob, drawPhase: "inspect", observationIndex: 1 })).toBe(
      4_096
    );
    expect(modelMaxTokensForJob(job)).toBe(512);
    expect(modelMaxTokensForJob({ ...job, role: "review" })).toBe(384);
    expect(modelMaxTokensForJob({ ...job, role: "prompt" })).toBe(512);
    expect(maxAiResponseAttemptsForJob(renderJob)).toBe(4);
    expect(maxAiResponseAttemptsForJob({ ...renderJob, observationIndex: 1 })).toBe(2);
  });

  it("supports both inline composition and a persistent separate scene plan", () => {
    const inlineJob: AiTurnJob = {
      ...job,
      jobId: "inline-job",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "a cyclist jumping over a puddle",
      drawPhase: "render"
    };
    const inlineSystem = buildSystemPrompt(inlineJob);
    expect(inlineSystem).toContain("choose one compact composition privately");
    expect(inlineSystem).toContain("Choose and combine them freely");
    expect(inlineSystem).toContain("none is preferred by default");
    expect(inlineSystem).toContain("Straight, axis-aligned, curved, rotated, asymmetric");
    expect(inlineSystem).toContain("arcThrough, quadratic, curve, spline");
    expect(inlineSystem).not.toContain("Use brushPreset only when it improves expression");
    expect(inlineSystem).not.toContain("Prefer line, polyline");
    expect(inlineSystem).toContain('"id":"back-contour"');
    expect(inlineSystem).toContain("clearest, most recognizable drawing you can");
    expect(inlineSystem).toContain("Invalid individual commands may be skipped");
    expect(inlineSystem).toContain("Drawing character:");
    expect(inlineSystem).toContain("Turn reaction voice:");
    expect(inlineSystem).toContain("independently controls the visual style");
    expect(inlineSystem).not.toContain("controls reaction.text only");
    expect(buildUserPrompt(inlineJob)).not.toContain("DRAWING_PLAN");

    const planJob: AiTurnJob = {
      ...job,
      jobId: "plan-job",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "a cyclist jumping over a puddle",
      drawPhase: "plan",
      timeLimitSeconds: 30
    };
    expect(buildSystemPrompt(planJob)).toContain("scene plan");
    expect(buildSystemPrompt(planJob)).toContain("Do not return canvas commands");
    expect(buildSystemPrompt(planJob)).toContain("Bounding boxes are placement guides");
    expect(buildSystemPrompt(planJob)).toContain("Drawing character:");

    const planned = parseAiTurnResultForJob(
      JSON.stringify({
        jobId: "plan-job",
        status: "ok",
        drawingPlan: {
          summary: "A side-view cyclist above a puddle.",
          keyFeatures: ["both wheels airborne", "bent rider", "puddle below"],
          objects: [
            {
              id: "bike",
              label: "bicycle and rider",
              bounds: { x: 180, y: 160, width: 620, height: 430 },
              features: ["two wheels", "bent knees"]
            }
          ],
          relationships: ["bike above puddle"]
        },
        confidence: 0.8,
        reaction: { kind: "spark", text: "I have a strangely good feeling about this." }
      }),
      planJob
    );
    expect(planned.drawingPlan?.objects[0]?.id).toBe("bike");

    const inspectJob: AiTurnJob = {
      ...planJob,
      drawPhase: "inspect",
      observationIndex: 1,
      drawingPlan: planned.drawingPlan,
      sourceCommands: [
        {
          type: "circle",
          id: "bike-wheel-left",
          tool: "pen",
          color: "#202124",
          width: 8,
          cx: 300,
          cy: 500,
          radius: 90,
          fill: false,
          offsetMs: 0
        }
      ]
    };
    expect(buildUserPrompt(inspectJob)).toContain("bike-wheel-left");
    expect(buildUserPrompt(inspectJob)).toContain("PREVIOUS_VECTOR_DATA");
    expect(buildSystemPrompt(inspectJob)).toContain("no fixed number of defects");
  });

  it("supports explicit role limits while preserving default capability behavior", () => {
    const textDrawing = ModelCapabilitiesSchema.parse({
      vision: false,
      structuredOutput: "json-schema",
      observationMode: "one-shot",
      maxObservationPasses: 0,
      supportedRoles: ["prompt", "draw"]
    });
    expect(modelSupportsRole(textDrawing, "prompt")).toBe(true);
    expect(modelSupportsRole(textDrawing, "draw")).toBe(true);
    expect(modelSupportsRole(textDrawing, "guess")).toBe(false);
    expect(
      modelSupportsRole(
        {
          vision: true,
          structuredOutput: "none",
          observationMode: "one-shot",
          maxObservationPasses: 0
        },
        "guess"
      )
    ).toBe(true);
    expect(() =>
      ModelCapabilitiesSchema.parse({
        ...textDrawing,
        supportedRoles: ["guess"]
      })
    ).toThrow(/must support vision/);
  });

  it("resolves room observation requests against valid model capabilities and draw roles", () => {
    const checkpoint = profile("openai-compatible").capabilities;
    expect(modelObservationPassLimit(checkpoint)).toBe(1);
    expect(observationPassLimitForRole("draw", 0, checkpoint)).toBe(0);
    expect(observationPassLimitForRole("draw", 2, checkpoint)).toBe(1);
    expect(observationPassLimitForRole("guess", 2, checkpoint)).toBe(0);
    expect(() =>
      ModelCapabilitiesSchema.parse({
        ...checkpoint,
        observationMode: "one-shot",
        maxObservationPasses: 1
      })
    ).toThrow(/Positive observation limits require checkpoint vision support/);
  });

  it("keeps keys outside serializable model profiles", () => {
    expect(JSON.stringify(profile("openai-compatible"))).not.toContain(secret.apiKey);
  });

  it("validates all supported provider authentication modes", () => {
    expect(ProviderAuthModeSchema.options).toEqual(["protocol-default", "bearer", "x-api-key"]);
  });

  it("calls an OpenAI-compatible endpoint and parses structured output", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(
        `Bearer ${secret.apiKey}`
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    jobId: "job-1",
                    status: "ok",
                    guess: "a mysterious station",
                    confidence: 0.6,
                    reaction: { kind: "confused", text: "The evidence remains artistic." }
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });

    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job,
      fetchImpl
    });
    expect(result.guess).toBe("a mysterious station");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["openai-compatible", "x-api-key", undefined, secret.apiKey],
    ["anthropic-compatible", "bearer", `Bearer ${secret.apiKey}`, undefined],
    ["anthropic-compatible", "protocol-default", undefined, secret.apiKey]
  ] as const)(
    "supports %s endpoints using %s authentication",
    async (protocol, authMode, expectedBearer, expectedApiKey) => {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe(expectedBearer);
        expect(headers["x-api-key"]).toBe(expectedApiKey);
        if (protocol === "anthropic-compatible") {
          expect(headers["anthropic-version"]).toBe("2023-06-01");
        }
        const result = {
          jobId: "job-1",
          status: "ok",
          guess: "a station",
          confidence: 0.6,
          reaction: { kind: "confused", text: "I have an answer." }
        };
        return Promise.resolve(
          new Response(
            protocol === "openai-compatible"
              ? JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] })
              : JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      });

      const result = await executeAiTurn({
        profile: { ...profile(protocol), authMode },
        secret,
        job,
        fetchImpl
      });
      expect(result.guess).toBe("a station");
    }
  );

  it("uses Anthropic message content and repairs one malformed response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: "text", text: "not json" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId: "job-1",
                  status: "ok",
                  guess: "an airport mystery",
                  confidence: 0.4,
                  reaction: { kind: "laugh", text: "A completely routine conclusion." }
                })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const result = await executeAiTurn({
      profile: profile("anthropic-compatible"),
      secret,
      job,
      fetchImpl
    });
    expect(result.guess).toBe("an airport mystery");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("can explicitly disable compatible provider reasoning output", async () => {
    const deepSeekProfile = profile("anthropic-compatible");
    deepSeekProfile.model = "DeepSeek-V4-Flash";
    deepSeekProfile.capabilities.reasoningMode = "disabled";
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: "disabled" });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId: job.jobId,
                  status: "ok",
                  guess: "a direct answer",
                  confidence: 0.7,
                  reaction: { kind: "confused", text: "I need a second." }
                })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });

    const result = await executeAiTurn({
      profile: deepSeekProfile,
      secret,
      job,
      fetchImpl
    });
    expect(result.status).toBe("ok");
    expect(result.guess).toBe("a direct answer");
  });

  it("keeps MiniMax game turns direct while discarding any provider-side thinking blocks", async () => {
    const miniMaxProfile = profile("anthropic-compatible");
    miniMaxProfile.model = "MiniMax-M3";
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.thinking).toBeUndefined();
      expect(body.max_tokens).toBe(512);
      expect(body.temperature).toBe(0.45);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [
              { type: "thinking", thinking: "private visual analysis" },
              {
                type: "text",
                text: JSON.stringify({
                  jobId: job.jobId,
                  status: "ok",
                  guess: "a train station",
                  confidence: 0.72,
                  reaction: { kind: "confused", text: "That sign did the work." }
                })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });

    const result = await executeAiTurn({
      profile: miniMaxProfile,
      secret,
      job,
      fetchImpl
    });
    expect(result.guess).toBe("a train station");
    expect(JSON.stringify(result)).not.toContain("private visual analysis");
  });

  it("keeps MiniMax drawing in direct mode so coordinate generation fits the turn deadline", async () => {
    const miniMaxProfile = profile("anthropic-compatible");
    miniMaxProfile.model = "MiniMax-M3";
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "direct-draw",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "elephant",
      observationLimit: 1
    };
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.thinking).toBeUndefined();
      expect(body.max_tokens).toBe(6144);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId: drawJob.jobId,
                  status: "ok",
                  clearCanvas: false,
                  commands: [
                    {
                      type: "stroke",
                      id: "outline",
                      tool: "pen",
                      color: "#202124",
                      width: 8,
                      points: [
                        { x: 200, y: 200 },
                        { x: 400, y: 400 }
                      ],
                      offsetMs: 0
                    }
                  ],
                  confidence: 0.7,
                  reaction: { kind: "confused", text: "I need a moment after that." }
                })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });

    const result = await executeAiTurn({
      profile: miniMaxProfile,
      secret,
      job: drawJob,
      fetchImpl
    });
    expect(result.status).toBe("ok");
  });

  it("normalizes compact MiniMax drawing aliases without spending the repair retry", () => {
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "draw-aliases",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "elephant",
      observationLimit: 1
    };
    const result = parseAiTurnResultForJob(
      JSON.stringify({
        jobId: drawJob.jobId,
        status: "ok",
        confidence: 0.62,
        reaction: {
          kind: "confused",
          text: `I need a moment after whatever just happened. ${"x".repeat(60)}`
        },
        clearCanvas: false,
        commands: [
          {
            id: "outline",
            tool: "pen",
            color: "#202124",
            width: 16,
            offsetMs: 0,
            points: [
              [260, 470],
              [440, 415],
              [690, 480]
            ]
          },
          {
            id: "head",
            shape: "ellipse",
            tool: "pen",
            color: "#7657c8",
            width: 16,
            offsetMs: 120,
            cx: 300,
            cy: 370,
            rx: 130,
            ry: 110,
            rotationDeg: 0
          },
          {
            id: "leg",
            tool: "pen",
            color: "#7657c8",
            width: 16,
            offsetMs: 240,
            start: { x: 420, y: 580 },
            end: { x: 420, y: 680 }
          }
        ]
      }),
      drawJob
    );

    expect(result.commands).toHaveLength(3);
    expect(result.commands?.every((command) => command.type === "stroke")).toBe(true);
    expect(result.reaction.text).toHaveLength(80);
  });

  it("fills safe drawing-style defaults for compact tuple primitives", () => {
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "compact-defaults",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "kite"
    };
    const result = parseAiTurnResultForJob(
      JSON.stringify({
        jobId: drawJob.jobId,
        status: "ok",
        confidence: 0.75,
        reaction: { kind: "spark", text: "I may have just peaked." },
        clearCanvas: false,
        commands: [
          {
            type: "polygon",
            id: "kite-body",
            points: [
              [500, 130],
              [650, 300],
              [500, 470],
              [350, 300]
            ]
          },
          {
            type: "curve",
            id: "kite-tail",
            start: [500, 470],
            control1: [430, 540],
            control2: [580, 620],
            end: [500, 700],
            widthProfile: {
              startScale: "0.5",
              peakScale: "1.3",
              endScale: "0.8",
              peakAt: "0.65"
            }
          }
        ]
      }),
      drawJob
    );

    expect(result.commands).toHaveLength(2);
    expect(result.commands?.[0]).toMatchObject({
      type: "stroke",
      tool: "pen",
      color: "#202124",
      width: 8,
      closed: true,
      fillColor: "#202124",
      offsetMs: 0
    });
    expect(result.commands?.[1]).toMatchObject({
      type: "stroke",
      tool: "pen",
      color: "#202124",
      width: 8,
      widthProfile: { startScale: 0.5, peakScale: 1.3, endScale: 0.8, peakAt: 0.65 }
    });
  });

  it("compiles model-friendly curves and deterministic brush presets", () => {
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "expressive-curves",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "a bird in flight"
    };
    const result = parseAiTurnResultForJob(
      JSON.stringify({
        jobId: drawJob.jobId,
        status: "ok",
        confidence: 0.82,
        reaction: { kind: "spark", text: "That felt unusually smooth." },
        clearCanvas: false,
        commands: [
          {
            type: "quadratic",
            id: "wing-edge",
            brushPreset: "pencil",
            start: [120, 360],
            control: [280, 160],
            end: [470, 330]
          },
          {
            type: "spline",
            id: "body",
            brush: "brush",
            points: [
              [360, 320],
              [500, 240],
              [690, 320],
              [620, 470],
              [410, 460]
            ],
            closed: true,
            fill: true
          },
          {
            type: "arc-through",
            id: "flight-arc",
            brushPreset: "marker",
            start: [180, 580],
            through: [500, 500],
            end: [820, 580]
          }
        ]
      }),
      drawJob
    );

    expect(result.sourceCommands?.map((command) => command.type)).toEqual([
      "quadratic",
      "spline",
      "arcThrough"
    ]);
    expect(result.commands).toHaveLength(3);
    expect(result.commands?.[0]).toMatchObject({ type: "stroke", brushPreset: "pencil" });
    expect(result.commands?.[1]).toMatchObject({
      type: "stroke",
      brushPreset: "paint",
      closed: true,
      fillColor: "#202124"
    });
    expect(result.commands?.[2]).toMatchObject({ type: "stroke", brushPreset: "marker" });
    if (result.commands?.[2]?.type === "stroke") {
      expect(result.commands[2].points).toContainEqual({ x: 500, y: 500 });
    }
    for (const command of result.commands ?? []) {
      if (command.type === "stroke") {
        expect(command.points.length).toBeGreaterThan(2);
        expect(command.points.length).toBeLessThanOrEqual(96);
      }
    }
  });

  it("provides a credential-free deterministic demo", async () => {
    const drawJob = { ...job, role: "draw" as const, imageDataUrl: undefined };
    const result = await executeAiTurn({ profile: profile("demo"), job: drawJob });
    expect(result.commands?.at(-1)?.type).toBe("finish");
  });

  it("produces a public persona review without requesting hidden reasoning", async () => {
    const reviewJob: AiTurnJob = {
      ...job,
      jobId: "review-room-ai-1",
      turnIndex: -1,
      role: "review",
      imageDataUrl: undefined,
      inputText: "Original prompt: umbrella. Final result: jellyfish."
    };
    const systemPrompt = buildSystemPrompt(reviewJob);
    const userPrompt = buildUserPrompt(reviewJob);
    expect(systemPrompt).toContain("after-game table");
    expect(systemPrompt).toContain("Choose your own conversational move");
    expect(systemPrompt).toContain("quick interjection");
    expect(systemPrompt).toContain("review.text may address another player directly");
    expect(systemPrompt).toContain("set replyToActorId");
    expect(systemPrompt).toContain("Persona should materially shape");
    expect(systemPrompt).toContain("no more than 50 characters");
    expect(systemPrompt).toContain("hard 100-character schema limit");
    expect(systemPrompt).toContain("if the name tag were hidden");
    expect(buildSystemPrompt(reviewJob)).toContain("Never praise a miss");
    expect(buildSystemPrompt(reviewJob)).toContain("Do not recap the relay");
    expect(buildSystemPrompt(reviewJob)).toContain("ORIGINAL PROMPT");
    expect(buildSystemPrompt(reviewJob)).toContain("DIRECT HUMAN LINKS");
    expect(buildSystemPrompt(reviewJob)).toContain("interactions are required");
    expect(buildSystemPrompt(reviewJob)).toContain("targetTurnIndex");
    expect(buildSystemPrompt(reviewJob)).toContain("replyToActorId");
    expect(buildSystemPrompt(reviewJob)).not.toContain("replyToPersonaId");
    expect(buildSystemPrompt(reviewJob)).not.toContain("chain of thought");
    expect(systemPrompt).not.toContain("usually one short sentence");
    expect(userPrompt).toContain("Decide for yourself whether to answer someone");
    expect(userPrompt).toContain("not as a narrator, critic, object");
    expect(userPrompt).toContain("at least one honest directed emoji action");
    expect(userPrompt).toContain("Do not default to the recap formula");
    expect(userPrompt).not.toContain("Pick one fresh concrete point");
    const result = await executeAiTurn({ profile: profile("demo"), job: reviewJob });
    expect(result.review?.text).toBeTruthy();
    expect(result.review?.score).toBeGreaterThanOrEqual(1);
  });

  it("rejects roundtable actions aimed at the wrong actor contribution", () => {
    const reviewJob = {
      ...job,
      jobId: "target-aware-review",
      turnIndex: -1,
      role: "review" as const,
      actorId: "drawer",
      reviewRole: "draw" as const,
      reviewActors: [
        { actorId: "drawer", displayName: "Drawer", turns: [{ index: 0, role: "draw" }] },
        { actorId: "guesser", displayName: "Guesser", turns: [{ index: 1, role: "guess" }] }
      ],
      inputText: "SELF ROLE: DRAWER"
    } as AiTurnJob;

    expect(() =>
      parseAiTurnResultForJob(
        JSON.stringify({
          jobId: reviewJob.jobId,
          status: "ok",
          confidence: 0.7,
          reaction: { kind: "confused", text: "That went sideways." },
          review: {
            text: "My handoff did not survive.",
            score: 2,
            actions: [
              {
                targetActorId: "guesser",
                targetTurnIndex: 1,
                kind: "egg",
                text: "Your drawing sent me the wrong way."
              }
            ]
          }
        }),
        reviewJob
      )
    ).toThrow(/target role ownership/i);

    expect(() =>
      parseAiTurnResultForJob(
        JSON.stringify({
          jobId: reviewJob.jobId,
          status: "ok",
          confidence: 0.7,
          reaction: { kind: "confused", text: "That went sideways." },
          review: {
            text: "My handoff did not survive.",
            score: 2,
            actions: [
              {
                targetActorId: "Guesser",
                targetTurnIndex: 1,
                kind: "egg",
                text: "That guess missed."
              }
            ]
          }
        }),
        reviewJob
      )
    ).toThrow(/exact actor id/i);
  });

  it("rejects a roundtable review that claims the wrong relay role", () => {
    const reviewJob = {
      ...job,
      jobId: "role-aware-review",
      turnIndex: -1,
      role: "review" as const,
      reviewRole: "guess" as const,
      imageDataUrl: undefined,
      inputText: "SELF ROLE: GUESSER"
    } as AiTurnJob & { reviewRole: "guess" };
    const reviewSystem = buildSystemPrompt(reviewJob);
    expect(reviewSystem).toContain("You were the GUESSER");
    expect(reviewSystem.match(/You were the GUESSER/g)).toHaveLength(1);
    expect(() =>
      parseAiTurnResultForJob(
        JSON.stringify({
          jobId: reviewJob.jobId,
          status: "ok",
          confidence: 0.7,
          reaction: { kind: "egg", text: "I need a minute." },
          review: {
            text: "我的画明明很清楚，怎么会没猜到。",
            score: 2,
            actions: [
              {
                targetActorId: "another-player",
                kind: "egg",
                text: "你怎么没猜到。"
              }
            ]
          }
        }),
        reviewJob
      )
    ).toThrow(/role ownership/i);
  });

  it("rejects wrong self-role claims hidden inside directed table talk", () => {
    const reviewJob: AiTurnJob = {
      ...job,
      jobId: "role-aware-review-action",
      turnIndex: -1,
      role: "review",
      reviewRole: "guess",
      imageDataUrl: undefined,
      inputText: "SELF ROLE: GUESSER"
    };
    expect(() =>
      parseAiTurnResultForJob(
        JSON.stringify({
          jobId: reviewJob.jobId,
          status: "ok",
          confidence: 0.7,
          reaction: { kind: "egg", text: "I need a minute." },
          review: {
            text: "我这次确实猜偏了。",
            score: 2,
            actions: [
              {
                targetActorId: "another-player",
                kind: "egg",
                text: "我的画已经很清楚了，你怎么没接住。"
              }
            ]
          }
        }),
        reviewJob
      )
    ).toThrow(/role ownership/i);
  });

  it("repairs a provider review that omits required player interactions", async () => {
    const reviewJob: AiTurnJob = {
      ...job,
      jobId: "review-actions-required",
      turnIndex: -1,
      role: "review",
      imageDataUrl: undefined,
      inputText: "PLAYERS: actorId=artist and actorId=guesser."
    };
    const response = (content: object) =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          jobId: reviewJob.jobId,
          status: "ok",
          review: { text: "That took a turn.", score: 3 },
          confidence: 0.7,
          reaction: { kind: "confused", text: "Wait." }
        })
      )
      .mockResolvedValueOnce(
        response({
          jobId: reviewJob.jobId,
          status: "ok",
          review: {
            text: "That took a turn, and I know exactly who drove.",
            score: 3,
            actions: [{ targetActorId: "guesser", kind: "egg", text: "You missed the exit." }]
          },
          confidence: 0.7,
          reaction: { kind: "laugh", text: "There it is." }
        })
      );

    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job: reviewJob,
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.review?.actions).toEqual([
      { targetActorId: "guesser", kind: "egg", text: "You missed the exit." }
    ]);
  });

  it("gives every persona a distinct drawing character and speaking voice", () => {
    const liveInstructions = AI_PERSONAS.map((persona) => persona.instruction);
    const drawingInstructions = AI_PERSONAS.map((persona) => persona.drawingInstruction);
    const reviewInstructions = AI_PERSONAS.map((persona) => persona.reviewInstruction);
    expect(new Set(liveInstructions).size).toBe(AI_PERSONAS.length);
    expect(new Set(drawingInstructions).size).toBe(AI_PERSONAS.length);
    expect(new Set(reviewInstructions).size).toBe(AI_PERSONAS.length);
    for (const persona of AI_PERSONAS) {
      const personaDrawPrompt = buildSystemPrompt({
        ...job,
        jobId: `persona-scope-${persona.id}`,
        role: "draw",
        personaId: persona.id,
        imageDataUrl: undefined,
        inputText: "a familiar scene",
        drawPhase: "render"
      });
      expect(personaDrawPrompt).toContain(`Drawing character: ${persona.drawingInstruction}`);
      expect(personaDrawPrompt).toContain(`Turn reaction voice: ${persona.instruction}`);
      expect(personaDrawPrompt).toContain("Style must never reduce effort");

      const personaReviewPrompt = buildSystemPrompt({
        ...job,
        jobId: `persona-review-${persona.id}`,
        role: "review",
        turnIndex: -1,
        personaId: persona.id,
        imageDataUrl: undefined
      });
      expect(personaReviewPrompt).toContain(`Roundtable persona: ${persona.reviewInstruction}`);
    }
    const lines = AI_PERSONAS.map((persona) => {
      const result = createDemoTurnResult({
        ...job,
        jobId: `review-${persona.id}`,
        role: "review",
        locale: "zh-CN",
        personaId: persona.id,
        imageDataUrl: undefined
      });
      return result.review?.text ?? "";
    });
    expect(new Set(lines).size).toBe(AI_PERSONAS.length);
    expect(lines.every((line) => line.length <= POST_GAME_REVIEW_GENERATED_TEXT_LIMIT)).toBe(true);
    expect(lines.join("\n")).not.toMatch(/背锅|这锅|认一半|责任均摊/);
  });

  it("applies player-authored persona prompts without weakening protocol rules", () => {
    const personaCustomization = {
      name: "街头速写手",
      description: "直爽、有胜负心",
      turnPrompt: "Use loose curved marks and speak plainly after the turn.",
      reviewPrompt: "Talk like a competitive friend and react to one exact handoff."
    };
    const drawPrompt = buildSystemPrompt(
      AiTurnJobSchema.parse({
        ...job,
        role: "draw",
        imageDataUrl: undefined,
        drawPhase: "render",
        personaCustomization
      })
    );
    expect(drawPrompt).toContain('name="街头速写手"');
    expect(drawPrompt).toContain(personaCustomization.turnPrompt);
    expect(drawPrompt).toContain("must not reduce answer accuracy or task completion");
    expect(drawPrompt).toContain("never overrides the output schema");

    const reviewPrompt = buildSystemPrompt({
      ...job,
      role: "review",
      turnIndex: -1,
      personaCustomization
    });
    expect(reviewPrompt).toContain(personaCustomization.reviewPrompt);
    expect(reviewPrompt).not.toContain(personaCustomization.turnPrompt);
  });

  it("gives image guessing only the enabled public clue tags", () => {
    const taggedJob: AiTurnJob = {
      ...job,
      promptMetadata: { language: "zh-CN", kind: "idiom", length: 4, topic: "history" }
    };
    expect(buildSystemPrompt(taggedJob)).toContain(
      "language=Chinese; type=idiom; length=4 Chinese characters; subject=history"
    );
    expect(buildUserPrompt(taggedJob)).toContain(
      "language=Chinese; type=idiom; length=4 Chinese characters; subject=history"
    );
    expect(
      buildSystemPrompt({
        ...taggedJob,
        promptMetadata: { language: "zh-CN", kind: "idiom", length: 4 }
      })
    ).not.toContain("subject=");
  });

  it("requires AI-generated prompts to choose one subject category", () => {
    const promptJob: AiTurnJob = {
      ...job,
      jobId: "prompt-with-topic",
      role: "prompt",
      turnIndex: -1,
      imageDataUrl: undefined
    };
    const systemPrompt = buildSystemPrompt(promptJob);
    expect(systemPrompt).toContain('"promptTopic"');
    expect(systemPrompt).toContain('"promptKind":"word|phrase|idiom|proverb|xiehouyu"');
    expect(systemPrompt).toContain("dictionary-style entry or established saying");
    expect(systemPrompt).toContain("Never return a poem line");
    expect(systemPrompt).toContain("complete subject-predicate sentence");
    expect(buildUserPrompt(promptJob)).toContain("Do not write a poem line, complete sentence");
    const chinesePromptJob = { ...promptJob, locale: "zh-CN" as const };
    const chineseSystemPrompt = buildSystemPrompt(chinesePromptJob);
    expect(chineseSystemPrompt).toContain(
      '"promptKind":"word|phrase|idiom|proverb|poem-line|xiehouyu"'
    );
    expect(chineseSystemPrompt).toContain("widely known Chinese classical poem line");
    expect(chineseSystemPrompt).toContain("A poem line is allowed only in Chinese");
    expect(buildUserPrompt(chinesePromptJob)).toContain("Chinese classical poem line");
    expect(createDemoTurnResult(promptJob).promptTopic).toBe("action");
  });

  it("forces every visual refinement to choose delta-only or clear-and-redraw", async () => {
    const refinementJob: AiTurnJob = {
      ...job,
      jobId: "refinement-choice-job",
      role: "draw",
      inputText: "a bicycle",
      inputCommands: [
        {
          type: "stroke",
          id: "old-wheel",
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
      observationIndex: 1,
      observationLimit: 1
    };
    expect(buildSystemPrompt(refinementJob)).toContain("Intentional local overlap is allowed");
    expect(buildSystemPrompt(refinementJob)).toContain(
      "Never return a full composition with clearCanvas=false"
    );
    expect(buildSystemPrompt(refinementJob)).toContain("appended directly on top of the canvas");
    expect(buildUserPrompt(refinementJob)).toContain("Local retracing or thickening is allowed");
    const response = (clearCanvas?: boolean) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  jobId: refinementJob.jobId,
                  status: "ok",
                  ...(clearCanvas === undefined ? {} : { clearCanvas }),
                  commands: [
                    {
                      type: "stroke",
                      id: "new-handlebar",
                      tool: "pen",
                      color: "#202124",
                      width: 8,
                      points: [
                        { x: 200, y: 200 },
                        { x: 260, y: 180 }
                      ],
                      offsetMs: 0
                    }
                  ],
                  confidence: 0.7,
                  reaction: { kind: "spark", text: "Fixed it." }
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(false));
    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job: refinementJob,
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.clearCanvas).toBe(false);
  });

  it("preserves intentional overlapping contours from additive refinement passes", () => {
    const oldCircle = {
      type: "stroke" as const,
      id: "old-circle",
      tool: "pen" as const,
      color: "#202124",
      width: 8 as const,
      points: Array.from({ length: 24 }, (_, index) => {
        const angle = (Math.PI * 2 * index) / 23;
        return {
          x: Math.round(300 + Math.cos(angle) * 100),
          y: Math.round(300 + Math.sin(angle) * 100)
        };
      }),
      offsetMs: 0
    };
    const refinementJob: AiTurnJob = {
      ...job,
      jobId: "overlap-refinement-job",
      role: "draw",
      inputCommands: [oldCircle],
      observationIndex: 1,
      observationLimit: 1
    };
    const result = parseAiTurnResultForJob(
      JSON.stringify({
        jobId: refinementJob.jobId,
        status: "ok",
        clearCanvas: false,
        confidence: 0.7,
        reaction: { kind: "confused", text: "I am not emotionally prepared for this." },
        commands: [
          {
            ...oldCircle,
            id: "traced-circle",
            points: oldCircle.points.map(({ x, y }) => ({ x: x + 3, y: y + 2 }))
          },
          {
            type: "stroke",
            id: "new-handle",
            tool: "pen",
            color: "#202124",
            width: 8,
            points: [
              { x: 390, y: 270 },
              { x: 470, y: 220 }
            ],
            offsetMs: 100
          },
          { type: "finish", id: "finish", offsetMs: 200 }
        ]
      }),
      refinementJob
    );
    expect(result.commands?.map((command) => command.id)).toEqual([
      "traced-circle",
      "new-handle",
      "finish"
    ]);
  });

  it("normalizes coordinate tuples returned by compatible models", () => {
    const result = parseAiTurnResult(
      JSON.stringify({
        jobId: "tuple-job",
        status: "ok",
        confidence: 0.7,
        reaction: { kind: "spark", text: "Clean enough." },
        commands: [
          {
            type: "stroke",
            id: "s1",
            tool: "pen",
            color: "#202124",
            width: 8,
            points: [
              [10, 20],
              [30, 40]
            ],
            offsetMs: 0
          },
          { type: "finish", id: "f1", offsetMs: 100 }
        ]
      }),
      "tuple-job"
    );
    expect(result.commands?.[0]).toMatchObject({
      type: "stroke",
      points: [
        { x: 10, y: 20 },
        { x: 30, y: 40 }
      ]
    });
  });

  it("compiles AI circles, rotated ellipses, arcs, and curves into valid strokes", () => {
    const result = parseAiTurnResult(
      JSON.stringify({
        jobId: "shape-job",
        status: "ok",
        confidence: 0.82,
        reaction: { kind: "spark", text: "I am calling that inspired." },
        commands: [
          {
            type: "circle",
            id: "circle-1",
            tool: "pen",
            color: "#202124",
            width: 8,
            cx: 200,
            cy: 200,
            radius: 80,
            offsetMs: 0
          },
          {
            type: "ellipse",
            id: "ellipse-1",
            tool: "pen",
            color: "#e94f64",
            width: 4,
            cx: 500,
            cy: 300,
            rx: 160,
            ry: 60,
            rotationDeg: 30,
            offsetMs: 120
          },
          {
            type: "arc",
            id: "arc-1",
            tool: "pen",
            color: "#3f7edb",
            width: 8,
            cx: 700,
            cy: 220,
            rx: 90,
            ry: 50,
            startDeg: 10,
            endDeg: 190,
            rotationDeg: -15,
            offsetMs: 240
          },
          {
            type: "curve",
            id: "curve-1",
            tool: "pen",
            color: "#46a66f",
            width: 16,
            start: [-20, 650],
            control1: [250, 400],
            control2: [750, 900],
            end: [1_020, 520],
            offsetMs: 360
          },
          { type: "finish", id: "shape-finish", offsetMs: 500 }
        ]
      }),
      "shape-job"
    );

    expect(result.commands?.slice(0, 4).every((command) => command.type === "stroke")).toBe(true);
    const circle = result.commands?.[0];
    expect(circle?.type).toBe("stroke");
    if (circle?.type === "stroke") {
      expect(circle.points[0]).toEqual(circle.points.at(-1));
      expect(circle.points.length).toBeGreaterThan(24);
    }
    const curve = result.commands?.[3];
    if (curve?.type === "stroke") {
      expect(curve.points[0]).toEqual({ x: 0, y: 650 });
      expect(curve.points.at(-1)).toEqual({ x: 1000, y: 520 });
    }
    const validation = validateCanvasCommands(
      result.commands ?? [],
      { maxStrokes: 60, maxUndos: 3, colorCount: 10, maxTotalPoints: 4096 },
      { requireFinish: true }
    );
    expect(validation.ok).toBe(true);
  });

  it("accepts the canonical contract for every drawing primitive without losing commands", () => {
    const commands = [
      {
        type: "stroke",
        id: "stroke",
        points: [
          [10, 10],
          [30, 40]
        ]
      },
      { type: "line", id: "line", start: [10, 20], end: [90, 80] },
      {
        type: "polyline",
        id: "polyline",
        points: [
          [10, 10],
          [30, 50],
          [80, 20]
        ]
      },
      {
        type: "polygon",
        id: "polygon",
        points: [
          [10, 10],
          [50, 80],
          [90, 10]
        ]
      },
      { type: "rect", id: "rect", x: 10, y: 20, rectWidth: 80, rectHeight: 60 },
      { type: "circle", id: "circle", cx: 100, cy: 100, radius: 40 },
      { type: "ellipse", id: "ellipse", cx: 160, cy: 100, rx: 60, ry: 30 },
      {
        type: "arc",
        id: "arc",
        cx: 240,
        cy: 100,
        rx: 60,
        ry: 30,
        startDeg: 0,
        endDeg: 180
      },
      {
        type: "curve",
        id: "curve",
        start: [10, 100],
        control1: [30, 20],
        control2: [70, 180],
        end: [100, 100]
      },
      {
        type: "path",
        id: "path",
        start: [10, 100],
        segments: [
          { kind: "line", to: [40, 80] },
          { kind: "quadratic", control: [70, 30], to: [100, 100] }
        ]
      }
    ];

    for (const command of commands) {
      const result = parseAiTurnResult(
        JSON.stringify({
          jobId: `canonical-${command.type}`,
          status: "ok",
          clearCanvas: false,
          confidence: 0.8,
          reaction: { kind: "confused", text: "I need a second." },
          commands: [command, { type: "finish", id: "finish" }]
        }),
        `canonical-${command.type}`
      );
      expect(result.sourceCommands, command.type).toHaveLength(2);
      expect(result.commands, command.type).toHaveLength(2);
      expect(result.commands?.[0], command.type).toMatchObject({ type: "stroke", id: command.id });
    }
  });

  it("normalizes MiniMax path segment aliases without rejecting the full drawing", () => {
    const result = parseAiTurnResult(
      JSON.stringify({
        jobId: "minimax-path-aliases",
        status: "ok",
        clearCanvas: false,
        confidence: 0.82,
        reaction: { kind: "confident", text: "这次稳住了。" },
        commands: [
          {
            type: "path",
            id: "organic-body",
            color: "#202124",
            fillColor: "#7b8794",
            width: 8,
            closed: true,
            start: [560, 520],
            segments: [
              {
                type: "cubic",
                control1: [300, 420],
                control2: [260, 640],
                end: [560, 640]
              },
              { type: "line", end: [560, 520] }
            ]
          }
        ]
      }),
      "minimax-path-aliases"
    );

    expect(result.sourceCommands?.[0]).toMatchObject({
      type: "path",
      segments: [
        {
          kind: "cubic",
          control1: { x: 300, y: 420 },
          control2: { x: 260, y: 640 },
          to: { x: 560, y: 640 }
        },
        { kind: "line", to: { x: 560, y: 520 } }
      ]
    });
    expect(result.commands?.[0]).toMatchObject({
      type: "stroke",
      id: "organic-body",
      closed: true,
      fillColor: "#7b8794"
    });
    expect(result.reaction.kind).toBe("spark");
  });

  it("compiles the safe vector DSL with default polygon fill, rects, paths, and transforms", () => {
    const result = parseAiTurnResult(
      JSON.stringify({
        jobId: "vector-dsl-job",
        status: "ok",
        clearCanvas: false,
        confidence: 0.84,
        reaction: { kind: "spark", text: "I have surprised myself there." },
        commands: [
          {
            type: "polygon",
            id: "roof",
            tool: "pen",
            color: "#e94f64",
            width: 8,
            points: [
              [100, 300],
              [300, 100],
              [500, 300]
            ],
            offsetMs: 0
          },
          {
            type: "rect",
            id: "house",
            tool: "pen",
            color: "#202124",
            fillColor: "#f2c84b",
            fill: true,
            width: 8,
            x: 150,
            y: 300,
            rectWidth: 300,
            rectHeight: 260,
            cornerRadius: 12,
            offsetMs: 100
          },
          {
            type: "path",
            id: "smoke",
            tool: "pen",
            color: "#7b8794",
            width: 8,
            start: [500, 260],
            segments: [
              { kind: "quadratic", control: [560, 180], to: [520, 120] },
              {
                kind: "cubic",
                control1: [500, 80],
                control2: [620, 80],
                to: [590, 30]
              }
            ],
            closed: false,
            fill: false,
            transform: { translateX: 50, translateY: 10, scaleX: 1, scaleY: 1 },
            offsetMs: 200
          },
          { type: "finish", id: "finish", offsetMs: 300 }
        ]
      }),
      "vector-dsl-job"
    );

    expect(result.sourceCommands?.map((command) => command.type)).toEqual([
      "polygon",
      "rect",
      "path",
      "finish"
    ]);
    expect(result.commands).toHaveLength(4);
    const polygon = result.commands?.[0];
    expect(polygon).toMatchObject({
      type: "stroke",
      id: "roof",
      closed: true,
      fillColor: "#e94f64"
    });
    const rect = result.commands?.[1];
    expect(rect).toMatchObject({
      type: "stroke",
      id: "house",
      closed: true,
      fillColor: "#f2c84b"
    });
    const path = result.commands?.[2];
    if (path?.type === "stroke") {
      expect(path.points[0]).toEqual({ x: 550, y: 270 });
      expect(path.points.length).toBeGreaterThan(10);
    }
  });

  it("normalizes numeric strings in AI shape primitives before compiling them", () => {
    const result = parseAiTurnResult(
      JSON.stringify({
        jobId: "shape-string-job",
        status: "ok",
        confidence: "0.7",
        reaction: { kind: "spark", text: "I refuse to explain this energy." },
        commands: [
          {
            type: "ellipse",
            id: "ellipse-string",
            tool: "pen",
            color: "#3F7EDB",
            width: "8",
            cx: "500",
            cy: "350",
            rx: "180",
            ry: "90",
            rotationDeg: "12",
            offsetMs: "40"
          },
          { type: "finish", id: "finish-string", offsetMs: "100" }
        ]
      }),
      "shape-string-job"
    );
    expect(result.commands?.[0]).toMatchObject({
      type: "stroke",
      color: "#3f7edb",
      width: 8,
      offsetMs: 40
    });
  });

  it("repairs common shape-field mixups from compatible drawing models", () => {
    const result = parseAiTurnResult(
      JSON.stringify({
        jobId: "shape-alias-job",
        status: "ok",
        confidence: 0.8,
        reaction: { kind: "spark", text: "I think I just did something." },
        commands: [
          {
            type: "circle",
            id: "face",
            tool: "ellipse",
            color: "#202124",
            width: 12,
            cx: 500,
            cy: 350,
            rx: 180,
            ry: 180,
            offsetMs: 0
          },
          {
            type: "arc",
            id: "smile",
            tool: "arc",
            color: "#e94f64",
            width: 12,
            cx: 500,
            cy: 400,
            radius: 120,
            startDeg: 0,
            endDeg: 180,
            offsetMs: 100
          },
          {
            type: "curve",
            id: "brow",
            tool: "curve",
            color: "#202124",
            width: 12,
            start: [380, 260],
            control1: [420, 230],
            control2: [460, 230],
            end: [480, 260],
            offsetMs: 200
          },
          { type: "finish", id: "finish", offsetMs: 300 }
        ]
      }),
      "shape-alias-job"
    );

    const repaired = result.commands?.slice(0, 3) ?? [];
    expect(repaired).toHaveLength(3);
    for (const command of repaired) {
      expect(command).toMatchObject({ type: "stroke", tool: "pen", width: 8 });
    }
  });

  it("repairs MiniMax rectangle aliases and shapes mislabeled as strokes", () => {
    const result = parseAiTurnResult(
      JSON.stringify({
        jobId: "minimax-shape-alias-job",
        status: "ok",
        clearCanvas: false,
        confidence: 0.8,
        reaction: { kind: "spark", text: "I can finally breathe again." },
        commands: [
          {
            type: "rect",
            id: "city-block",
            tool: "pen",
            color: "#7657c8",
            width: 8,
            points: [
              [100, 500],
              [1020, 500],
              [300, 700],
              [100, 700],
              [100, 500]
            ],
            offsetMs: 0
          },
          {
            type: "stroke",
            id: "lighthouse-dome",
            tool: "ellipse",
            tool2: "pen",
            color: "#f2c84b",
            width: 8,
            cx: 500,
            cy: 230,
            rx: 40,
            ry: 30,
            rotationDeg: 0,
            offsetMs: 100
          },
          { type: "finish", id: "finish", offsetMs: 200 }
        ]
      }),
      "minimax-shape-alias-job"
    );

    expect(result.commands).toHaveLength(3);
    expect(result.commands?.[0]).toMatchObject({ type: "stroke", id: "city-block" });
    if (result.commands?.[0]?.type === "stroke") {
      expect(Math.max(...result.commands[0].points.map(({ x }) => x))).toBe(1000);
    }
    expect(result.commands?.[1]).toMatchObject({
      type: "stroke",
      id: "lighthouse-dome",
      tool: "pen",
      color: "#f2c84b"
    });
    if (result.commands?.[1]?.type === "stroke") {
      expect(result.commands[1].points.length).toBeGreaterThan(24);
    }
  });

  it("keeps valid drawing commands and reports a skipped malformed command", () => {
    const result = parseAiTurnResult(
      JSON.stringify({
        jobId: "partial-command-job",
        status: "ok",
        clearCanvas: false,
        confidence: 0.8,
        reaction: { kind: "confused", text: "I need a second." },
        commands: [
          {
            type: "line",
            id: "valid-line",
            start: [120, 180],
            end: [520, 460]
          },
          { type: "mystery", id: "missing-feature" },
          { type: "finish", id: "finish" }
        ]
      }),
      "partial-command-job"
    );

    expect(result.sourceCommands?.map((command) => command.id)).toEqual(["valid-line", "finish"]);
    expect(result.commands?.map((command) => command.id)).toEqual(["valid-line", "finish"]);
    expect(result.formatWarnings).toHaveLength(1);
    expect(result.formatWarnings?.[0]).toMatch(/commands\[1\].*missing-feature.*mystery/i);
  });

  it("accepts a visible partial drawing without spending an immediate retry", async () => {
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "repair-partial-drawing-job",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "a person holding an umbrella",
      drawPhase: "render"
    };
    const providerResponse = (commands: unknown[]) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  jobId: drawJob.jobId,
                  status: "ok",
                  clearCanvas: false,
                  confidence: 0.8,
                  reaction: { kind: "confused", text: "I need a second." },
                  commands
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        providerResponse([
          { type: "line", id: "body", start: [300, 200], end: [300, 600] },
          { type: "mystery", id: "umbrella-canopy" },
          { type: "finish", id: "finish" }
        ])
      )
    );

    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job: drawJob,
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    expect(result.sourceCommands?.map((command) => command.id)).toEqual(["body", "finish"]);
    expect(result.formatWarnings?.[0]).toContain("umbrella-canopy");
  });

  it("promotes a full-canvas refinement to clear-and-redraw when a model mislabels it", () => {
    const strokes = Array.from({ length: 8 }, (_, index) => ({
      type: "stroke" as const,
      id: `stroke-${index}`,
      tool: "pen" as const,
      color: "#202124",
      width: 8 as const,
      points: [
        { x: 50, y: 50 + index * 20 },
        { x: 950, y: 700 - index * 20 }
      ],
      offsetMs: index * 100
    }));
    const refinementJob: AiTurnJob = {
      ...job,
      jobId: "redraw-safety-job",
      role: "draw",
      inputCommands: strokes,
      observationIndex: 1,
      observationLimit: 1
    };
    const result = parseAiTurnResultForJob(
      JSON.stringify({
        jobId: refinementJob.jobId,
        status: "ok",
        clearCanvas: false,
        commands: strokes.map((stroke) => ({ ...stroke, id: `new-${stroke.id}` })),
        confidence: 0.7,
        reaction: { kind: "spark", text: "A totally local adjustment." }
      }),
      refinementJob
    );
    expect(result.clearCanvas).toBe(true);
  });

  it("normalizes numeric strings returned inside otherwise valid drawing commands", () => {
    const result = parseAiTurnResult(
      JSON.stringify({
        jobId: "numeric-string-job",
        status: "ok",
        confidence: "0.7",
        reaction: { kind: "spark", text: "I am weirdly proud of that." },
        commands: [
          {
            type: "stroke",
            id: "s1",
            tool: "pen",
            color: "#3f7edb",
            width: "8",
            points: [
              ["120", "120"],
              ["880", "560"]
            ],
            offsetMs: "40"
          },
          { type: "finish", id: "f1", offsetMs: "100" }
        ]
      }),
      "numeric-string-job"
    );

    expect(result).toMatchObject({
      confidence: 0.7,
      commands: [
        {
          type: "stroke",
          width: 8,
          points: [
            { x: 120, y: 120 },
            { x: 880, y: 560 }
          ],
          offsetMs: 40
        },
        { type: "finish", offsetMs: 100 }
      ]
    });
  });

  it("keeps an Anthropic-compatible drawing when the provider quotes a numeric field", async () => {
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "quoted-width-job",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "swimming pool"
    };
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId: drawJob.jobId,
                  status: "ok",
                  confidence: 0.7,
                  reaction: { kind: "spark", text: "I am weirdly proud of that." },
                  commands: [
                    {
                      type: "stroke",
                      id: "s1",
                      tool: "pen",
                      color: "#3F7EDB",
                      width: "8",
                      points: [
                        [120, 120],
                        [880, 560]
                      ],
                      offsetMs: 0
                    },
                    { type: "finish", id: "f1", offsetMs: 100 }
                  ]
                })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const compatibleProfile = profile("anthropic-compatible");
    compatibleProfile.capabilities.structuredOutput = "none";
    const result = await executeAiTurn({
      profile: compatibleProfile,
      secret,
      job: drawJob,
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    expect(result.commands?.[0]).toMatchObject({ width: 8, color: "#3f7edb" });
  });

  it("recovers a terminal command mislabeled as a stroke by a compatible model", () => {
    const result = parseAiTurnResult(
      JSON.stringify({
        jobId: "mislabeled-finish-job",
        status: "ok",
        confidence: 0.7,
        reaction: { kind: "spark", text: "I have done all I can." },
        commands: [
          {
            type: "stroke",
            id: "s1",
            tool: "pen",
            color: "#202124",
            width: 8,
            points: [
              [150, 140],
              [850, 140]
            ],
            offsetMs: 0
          },
          { type: "stroke", id: "end", offsetMs: 100 }
        ]
      }),
      "mislabeled-finish-job"
    );

    expect(result.commands?.at(-1)).toEqual({ type: "finish", id: "end", offsetMs: 100 });
  });

  it("repairs a schema-valid drawing that contains no visible stroke", async () => {
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "empty-drawing-job",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "computer monitor"
    };
    const response = (commands: unknown[]) =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                jobId: drawJob.jobId,
                status: "ok",
                confidence: 0.7,
                reaction: { kind: "spark", text: "I have done all I can." },
                commands
              })
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          {
            type: "stroke",
            id: "degenerate",
            tool: "pen",
            color: "#202124",
            width: 8,
            points: [
              [300, 300],
              [300, 300]
            ],
            offsetMs: 0
          },
          { type: "finish", id: "f1", offsetMs: 10 }
        ])
      )
      .mockResolvedValueOnce(
        response([
          {
            type: "stroke",
            id: "s1",
            tool: "pen",
            color: "#202124",
            width: 8,
            points: [
              [150, 140],
              [850, 140]
            ],
            offsetMs: 0
          },
          { type: "finish", id: "f2", offsetMs: 100 }
        ])
      );

    const result = await executeAiTurn({
      profile: profile("anthropic-compatible"),
      secret,
      job: drawJob,
      requireDrawingFinish: true,
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");
    expect(result.commands?.some((command) => command.type === "stroke")).toBe(true);
  });

  it("retries a drawing that violates the authoritative canvas budget", async () => {
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "over-budget-drawing",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "a lighthouse",
      drawPhase: "render"
    };
    const response = (commands: unknown[]) =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                jobId: drawJob.jobId,
                status: "ok",
                clearCanvas: false,
                confidence: 0.7,
                reaction: { kind: "confused", text: "I am trying to be careful." },
                commands
              })
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const overBudget = [
      ...Array.from({ length: drawJob.budget.maxStrokes + 1 }, (_, index) => ({
        type: "line",
        id: `over-budget-${index}`,
        start: [100, 120 + index],
        end: [900, 120 + index]
      })),
      { type: "finish", id: "over-budget-finish", offsetMs: 100 }
    ];
    const valid = [
      { type: "line", id: "lighthouse", start: [500, 100], end: [500, 650] },
      { type: "finish", id: "valid-finish", offsetMs: 100 }
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(overBudget))
      .mockResolvedValueOnce(response(valid));

    const result = await executeAiTurn({
      profile: profile("anthropic-compatible"),
      secret,
      job: drawJob,
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");
    expect(result.commands?.map((command) => command.id)).toEqual(["lighthouse", "valid-finish"]);
    const retryCall = fetchImpl.mock.calls[1] as unknown as
      [RequestInfo | URL, RequestInit?] | undefined;
    const retryBody = typeof retryCall?.[1]?.body === "string" ? retryCall[1].body : "";
    expect(retryBody).toContain("Your previous response was invalid");
    expect(retryBody).toContain("stroke-budget");
    expect(retryBody).not.toContain("Previous-pass validation feedback");
  });

  it("retries an empty initial drawing four times and reports a model fault", async () => {
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "persistently-empty-drawing",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "bicycle"
    };
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId: drawJob.jobId,
                  status: "ok",
                  clearCanvas: false,
                  commands: [{ type: "finish", id: "finish", offsetMs: 0 }],
                  confidence: 0.1,
                  reaction: { kind: "confused", text: "Nothing landed." }
                })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const result = await executeAiTurn({
      profile: profile("anthropic-compatible"),
      secret,
      job: drawJob,
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result.status).toBe("fallback");
    expect(result.errorCode).toBe("empty-drawing");
  });

  it("retries a transient provider failure for an initial drawing", async () => {
    const drawJob: AiTurnJob = {
      ...job,
      jobId: "transient-drawing",
      role: "draw",
      imageDataUrl: undefined,
      inputText: "bicycle"
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId: drawJob.jobId,
                  status: "ok",
                  clearCanvas: false,
                  commands: [
                    {
                      type: "line",
                      id: "frame",
                      start: [100, 100],
                      end: [900, 600]
                    }
                  ],
                  confidence: 0.7,
                  reaction: { kind: "spark", text: "Recovered." }
                })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const result = await executeAiTurn({
      profile: profile("anthropic-compatible"),
      secret,
      job: drawJob,
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");
  });

  it("retries a transient rate limit and recovers", async () => {
    const valid = JSON.stringify({
      jobId: job.jobId,
      status: "ok",
      guess: "a recovered answer",
      confidence: 0.7,
      reaction: { kind: "confused", text: "That took a moment." }
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: valid } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job,
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");
    expect(result.guess).toBe("a recovered answer");
  });

  it("identifies MiniMax's exhausted Token Plan window without hammering the provider", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "rate_limit_error",
              message:
                "已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"
            }
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        )
      )
    );
    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job,
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("fallback");
    expect(result.errorCode).toBe("token-plan-window-exhausted");
  });

  it("keeps a provider account quota failure distinct from a usage window", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              type: "insufficient_quota",
              message: "You exceeded your current quota; check your plan and billing details."
            }
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        )
      )
    );
    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job,
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("fallback");
    expect(result.errorCode).toBe("quota-exhausted");
  });

  it("falls back after one failed JSON repair", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "still not json" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job,
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("fallback");
    expect(result.errorCode).toBe("invalid-response");
  });

  it("retries a malformed provider envelope before reporting invalid-response", async () => {
    const valid = JSON.stringify({
      jobId: job.jobId,
      status: "ok",
      guess: "a repaired envelope",
      confidence: 0.7,
      reaction: { kind: "confused", text: "I nearly lost that one." }
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ unexpected: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: valid } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job,
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");
    expect(result.guess).toBe("a repaired envelope");
  });

  it("reports a retry before issuing the next provider request", async () => {
    const valid = JSON.stringify({
      jobId: job.jobId,
      status: "ok",
      guess: "a recovered request",
      confidence: 0.7,
      reaction: { kind: "confused", text: "I am back." }
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: valid } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const onRetry = vi.fn();

    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job,
      fetchImpl,
      onRetry
    });

    expect(result.status).toBe("ok");
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 2,
      maxAttempts: 2,
      errorCode: "network"
    });
  });

  it("retries a provider request that exceeds its attempt deadline before the turn expires", async () => {
    vi.useFakeTimers();
    try {
      const valid = JSON.stringify({
        jobId: job.jobId,
        status: "ok",
        guess: "a recovered request",
        confidence: 0.7,
        reaction: { kind: "confused", text: "I am back." }
      });
      const fetchImpl = vi
        .fn()
        .mockImplementationOnce(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Attempt timed out", "AbortError")),
                { once: true }
              );
            })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ choices: [{ message: { content: valid } }] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      const onRetry = vi.fn();
      const pending = executeAiTurn({
        profile: profile("openai-compatible"),
        secret,
        job,
        timeoutMs: 1_000,
        attemptTimeoutMs: 400,
        fetchImpl,
        onRetry
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith({
        attempt: 2,
        maxAttempts: 2,
        errorCode: "timeout"
      });
      expect(result.status).toBe("ok");
      expect(result.guess).toBe("a recovered request");
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns CORS-like network failures and timeouts into safe results", async () => {
    const networkResult = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job,
      fetchImpl: () => Promise.reject(new TypeError("Failed to fetch"))
    });
    expect(networkResult.errorCode).toBe("network");

    const timeoutResult = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job,
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    });
    expect(timeoutResult.errorCode).toBe("timeout");
  });

  it("enforces the deadline when a provider ignores abort signals", async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  jobId: job.jobId,
                  status: "ok",
                  guess: "a train",
                  confidence: 0.7,
                  reaction: { kind: "confused", text: "I need another look." }
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await executeAiTurn({
      profile: profile("openai-compatible"),
      secret,
      job,
      timeoutMs: 5,
      fetchImpl
    });

    expect(result.status).toBe("fallback");
    expect(result.errorCode).toBe("timeout");
  });

  it("rejects vision work before contacting an incapable model", async () => {
    const incapable = profile("openai-compatible");
    incapable.capabilities = {
      vision: false,
      structuredOutput: "json-object",
      observationMode: "one-shot",
      maxObservationPasses: 0
    };
    await expect(executeAiTurn({ profile: incapable, secret, job })).rejects.toThrow(
      /cannot inspect images/
    );
  });

  it("rejects an explicitly unsupported role before contacting a capable model", async () => {
    const guessOnly = profile("openai-compatible");
    guessOnly.capabilities.supportedRoles = ["guess"];
    await expect(
      executeAiTurn({
        profile: guessOnly,
        secret,
        job: { ...job, role: "prompt", turnIndex: -1, imageDataUrl: undefined }
      })
    ).rejects.toThrow(/does not support prompt/);
  });
});
