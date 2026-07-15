import {
  AI_RESULT_JSON_SCHEMA,
  AiAdapterError,
  AiTurnJobSchema,
  aiRepairInstruction,
  aiResponseErrorCode,
  buildSystemPrompt,
  buildUserPrompt,
  createFallbackAiTurnResult,
  executeAiTurn,
  isRetryableAiRequestError,
  maxAiResponseAttemptsForJob,
  modelTemperatureForJob,
  modelMaxTokensForJob,
  ModelProfileSchema,
  modelSupportsRole,
  parseAiTurnResultForJob,
  type AiTurnJob,
  type AiTurnResult,
  type ModelCapabilities,
  type ModelProfile
} from "@drawguessai/ai-adapters";
import { z } from "zod";

export const MINIMAX_SERVER_PROFILE_ID = "server-minimax-m3";

export const WORKERS_AI_PROFILE_IDS = {
  gemma: "cloudflare-workers-ai-gemma-4",
  llama: "cloudflare-workers-ai-llama-4-scout",
  kimi: "cloudflare-workers-ai-kimi-k2-6",
  moondream: "cloudflare-workers-ai-moondream-3-1",
  glm: "cloudflare-workers-ai-glm-4-7-flash"
} as const;

export const WORKERS_AI_PROFILE_ID = WORKERS_AI_PROFILE_IDS.llama;
export const WORKERS_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct" as const;

type WorkersAiDialect = "llama-guided" | "chat-completions" | "moondream-query";

export interface WorkersAiProfileDefinition {
  id: string;
  label: string;
  model: string;
  dialect: WorkersAiDialect;
  capabilities: ModelCapabilities;
  chatTemplateKwargs?: Record<string, unknown>;
}

export const WORKERS_AI_PROFILES = [
  {
    id: WORKERS_AI_PROFILE_IDS.gemma,
    label: "Cloudflare · Gemma 4 26B",
    model: "@cf/google/gemma-4-26b-a4b-it",
    dialect: "chat-completions",
    capabilities: {
      vision: true,
      structuredOutput: "json-schema",
      observationMode: "checkpoint",
      maxObservationPasses: 1,
      drawingPlanMode: "inline",
      supportedRoles: ["prompt", "draw", "guess", "review"]
    }
  },
  {
    id: WORKERS_AI_PROFILE_IDS.llama,
    label: "Cloudflare · Llama 4 Scout",
    model: WORKERS_AI_MODEL,
    dialect: "llama-guided",
    capabilities: {
      vision: true,
      structuredOutput: "json-schema",
      observationMode: "checkpoint",
      maxObservationPasses: 1,
      drawingPlanMode: "inline",
      supportedRoles: ["prompt", "draw", "guess", "review"]
    }
  },
  {
    id: WORKERS_AI_PROFILE_IDS.kimi,
    label: "Cloudflare · Kimi K2.6",
    model: "@cf/moonshotai/kimi-k2.6",
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
  },
  {
    id: WORKERS_AI_PROFILE_IDS.moondream,
    label: "Cloudflare · Moondream 3.1 (guessing)",
    model: "@cf/moondream/moondream3.1-9B-A2B",
    dialect: "moondream-query",
    capabilities: {
      vision: true,
      structuredOutput: "none",
      observationMode: "one-shot",
      maxObservationPasses: 0,
      drawingPlanMode: "inline",
      supportedRoles: ["guess"]
    }
  },
  {
    id: WORKERS_AI_PROFILE_IDS.glm,
    label: "Cloudflare · GLM-4.7 Flash (drawing)",
    model: "@cf/zai-org/glm-4.7-flash",
    dialect: "chat-completions",
    capabilities: {
      vision: false,
      structuredOutput: "json-schema",
      observationMode: "one-shot",
      maxObservationPasses: 0,
      drawingPlanMode: "inline",
      supportedRoles: ["prompt", "draw", "review"]
    },
    chatTemplateKwargs: { enable_thinking: false }
  }
] satisfies readonly WorkersAiProfileDefinition[];

const workersAiProfileIds: ReadonlySet<string> = new Set(WORKERS_AI_PROFILES.map(({ id }) => id));

const ServerProfileRecordSchema = z
  .object({
    profile: ModelProfileSchema,
    apiKey: z.string().min(1).max(4096)
  })
  .strict();

export interface ServerProfileRecord {
  profile: ModelProfile;
  apiKey: string;
}

export interface ServerAiEnvironment {
  SERVER_AI_PROFILES_JSON?: string;
  MINIMAX_API_KEY?: string;
  MINIMAX_BASE_URL?: string;
  MINIMAX_MODEL?: string;
  MINIMAX_MAX_OBSERVATION_PASSES?: string;
}

export function parseServerProfiles(raw: string | undefined): ServerProfileRecord[] {
  if (raw === undefined || raw.trim() === "") return [];
  try {
    return z.array(ServerProfileRecordSchema).max(12).parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

function miniMaxServerProfile(environment: ServerAiEnvironment): ServerProfileRecord | undefined {
  const apiKey = environment.MINIMAX_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") return undefined;
  const configuredObservationPasses = Number(environment.MINIMAX_MAX_OBSERVATION_PASSES ?? "2");
  const maxObservationPasses =
    Number.isInteger(configuredObservationPasses) &&
    configuredObservationPasses >= 0 &&
    configuredObservationPasses <= 2
      ? configuredObservationPasses
      : 2;

  const profile = ModelProfileSchema.safeParse({
    id: MINIMAX_SERVER_PROFILE_ID,
    label: "MiniMax · MiniMax-M3",
    protocol: "anthropic-compatible",
    execution: "server",
    baseUrl: environment.MINIMAX_BASE_URL?.trim() || "https://api.minimaxi.com/anthropic",
    model: environment.MINIMAX_MODEL?.trim() || "MiniMax-M3",
    capabilities: {
      vision: true,
      structuredOutput: "none",
      observationMode: maxObservationPasses === 0 ? "one-shot" : "checkpoint",
      maxObservationPasses,
      drawingPlanMode: "inline",
      supportedRoles: ["prompt", "draw", "guess", "review"]
    },
    secretRef: "server-minimax-m3-key",
    enabled: true
  });
  if (!profile.success) return undefined;
  return { profile: profile.data, apiKey };
}

export function configuredServerProfiles(environment: ServerAiEnvironment): ServerProfileRecord[] {
  const generic = parseServerProfiles(environment.SERVER_AI_PROFILES_JSON).filter(
    ({ profile }) =>
      profile.id !== MINIMAX_SERVER_PROFILE_ID && !workersAiProfileIds.has(profile.id)
  );
  const miniMax = miniMaxServerProfile(environment);
  return miniMax === undefined ? generic : [miniMax, ...generic];
}

export function publicServerProfiles(
  records: readonly ServerProfileRecord[],
  workersAiConfigured: boolean
) {
  const profiles = records.map(({ profile }) => ({
    id: profile.id,
    label: profile.label,
    capabilities: profile.capabilities,
    execution: "server" as const
  }));
  if (workersAiConfigured) {
    profiles.push(
      ...WORKERS_AI_PROFILES.map(({ id, label, capabilities }) => ({
        id,
        label,
        capabilities,
        execution: "server" as const
      }))
    );
  }
  return profiles;
}

type WorkersAiContent =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type WorkersAiRun = (model: string, input: Record<string, unknown>) => Promise<unknown>;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = globalThis.setTimeout(
          () => reject(new AiAdapterError("timeout", "Workers AI request timed out")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}

function userText(job: AiTurnJob, repairNote?: string): string {
  return `${buildUserPrompt(job)}${repairNote === undefined ? "" : `\n${repairNote}`}`;
}

function workersAiMessages(job: AiTurnJob, repairNote?: string) {
  const content: WorkersAiContent[] = [{ type: "text", text: userText(job, repairNote) }];
  if (job.imageDataUrl !== undefined) {
    content.push({ type: "image_url", image_url: { url: job.imageDataUrl } });
  }
  return [
    { role: "system", content: buildSystemPrompt(job) },
    { role: "user", content: job.imageDataUrl === undefined ? userText(job, repairNote) : content }
  ];
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        if (typeof part !== "object" || part === null || !("text" in part)) return "";
        const candidate = part as { text?: unknown };
        return typeof candidate.text === "string" ? candidate.text : "";
      })
      .join("");
    return text === "" ? undefined : text;
  }
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return undefined;
}

function extractWorkersAiText(dialect: WorkersAiDialect, response: unknown): string {
  if (typeof response !== "object" || response === null) {
    throw new AiAdapterError("invalid-response", "Workers AI returned a non-object response");
  }
  if (dialect === "llama-guided") {
    const text = extractTextContent((response as { response?: unknown }).response);
    if (text !== undefined) return text;
  } else if (dialect === "moondream-query") {
    const text = extractTextContent((response as { answer?: unknown }).answer);
    if (text !== undefined) return text;
  } else {
    const choices = (response as { choices?: unknown }).choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const message = choices[0] as { message?: { content?: unknown } };
      const text = extractTextContent(message.message?.content);
      if (text !== undefined) return text;
    }
  }
  throw new AiAdapterError("invalid-response", "Workers AI returned no text output");
}

function workersAiInput(
  profile: WorkersAiProfileDefinition,
  job: AiTurnJob,
  repairNote?: string
): Record<string, unknown> {
  if (profile.dialect === "moondream-query") {
    if (job.imageDataUrl === undefined) {
      throw new AiAdapterError("capability", "Moondream requires a canvas image");
    }
    return {
      task: "query",
      image: job.imageDataUrl,
      question: `${buildSystemPrompt(job)}\n\n${userText(job, repairNote)}`,
      reasoning: false,
      temperature: 0.2,
      max_tokens: modelMaxTokensForJob(job),
      stream: false
    };
  }
  if (profile.dialect === "llama-guided") {
    return {
      messages: workersAiMessages(job, repairNote),
      guided_json: AI_RESULT_JSON_SCHEMA,
      max_tokens: modelMaxTokensForJob(job),
      temperature: modelTemperatureForJob(job),
      stream: false
    };
  }
  return {
    messages: workersAiMessages(job, repairNote),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "drawguessai_turn",
        description: "A validated DrawGuessAI turn result",
        schema: AI_RESULT_JSON_SCHEMA,
        strict: true
      }
    },
    max_completion_tokens: modelMaxTokensForJob(job),
    temperature: modelTemperatureForJob(job),
    stream: false,
    ...(profile.chatTemplateKwargs === undefined
      ? {}
      : { chat_template_kwargs: profile.chatTemplateKwargs })
  };
}

async function requestWorkersAi(
  workersAi: Ai,
  profile: WorkersAiProfileDefinition,
  job: AiTurnJob,
  timeoutMs: number,
  repairNote?: string
): Promise<string> {
  const run = workersAi.run.bind(workersAi) as unknown as WorkersAiRun;
  const response = await withTimeout(
    run(profile.model, workersAiInput(profile, job, repairNote)),
    timeoutMs
  );
  return extractWorkersAiText(profile.dialect, response);
}

export async function executeWorkersAi(
  workersAi: Ai,
  profileId: string,
  inputJob: AiTurnJob,
  timeoutMs?: number
): Promise<AiTurnResult> {
  const profile = WORKERS_AI_PROFILES.find(({ id }) => id === profileId);
  if (profile === undefined) {
    throw new AiAdapterError("capability", "Workers AI profile is not allow-listed");
  }
  const job = AiTurnJobSchema.parse(inputJob);
  const effectiveTimeoutMs = timeoutMs ?? job.timeLimitSeconds * 1_000;
  if (!modelSupportsRole(profile.capabilities, job.role)) {
    throw new AiAdapterError("capability", `${profile.label} does not support ${job.role} turns`);
  }
  if (job.observationIndex > 0 && !profile.capabilities.vision) {
    throw new AiAdapterError("capability", `${profile.label} cannot inspect drawing checkpoints`);
  }
  if (profile.dialect === "moondream-query" && job.imageDataUrl === undefined) {
    throw new AiAdapterError("capability", "Moondream requires a canvas image");
  }

  const deadline = Date.now() + effectiveTimeoutMs;
  const maxAttempts = maxAiResponseAttemptsForJob(job);
  let repairNote: string | undefined;
  let lastError: unknown = new AiAdapterError("invalid-response", "No Workers AI response");
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return createFallbackAiTurnResult(job, "timeout");
    try {
      const response = await requestWorkersAi(workersAi, profile, job, remainingMs, repairNote);
      try {
        return parseAiTurnResultForJob(response, job);
      } catch (error) {
        lastError = error;
        repairNote = aiRepairInstruction(job, error);
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableAiRequestError(error)) break;
      repairNote = aiRepairInstruction(job, error);
    }
  }
  const errorCode = aiResponseErrorCode(lastError);
  return createFallbackAiTurnResult(
    job,
    errorCode === "network" && !(lastError instanceof TypeError) ? "workers-ai" : errorCode
  );
}

export async function executeServerProfile(
  records: readonly ServerProfileRecord[],
  workersAi: Ai | undefined,
  profileId: string,
  job: AiTurnJob
): Promise<AiTurnResult> {
  const workersAiProfile = WORKERS_AI_PROFILES.find(({ id }) => id === profileId);
  if (workersAiProfile !== undefined) {
    if (workersAi === undefined) throw new Error("Workers AI binding is not configured");
    return executeWorkersAi(workersAi, workersAiProfile.id, job, job.timeLimitSeconds * 1_000);
  }

  const record = records.find(({ profile }) => profile.id === profileId && profile.enabled);
  if (record === undefined) throw new Error("Server AI profile is not configured");
  const miniMaxFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const apiKey = headers.get("x-api-key");
    headers.delete("x-api-key");
    headers.delete("anthropic-dangerous-direct-browser-access");
    if (apiKey !== null) headers.set("authorization", `Bearer ${apiKey}`);
    return fetch(input, { ...init, headers });
  };
  return executeAiTurn({
    profile: record.profile,
    secret: { secretRef: record.profile.secretRef ?? record.profile.id, apiKey: record.apiKey },
    job,
    timeoutMs: job.timeLimitSeconds * 1_000,
    ...(record.profile.id === MINIMAX_SERVER_PROFILE_ID ? { fetchImpl: miniMaxFetch } : {})
  });
}
