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
  ModelCapabilitiesSchema,
  ModelRoleSchema,
  ModelProfileSchema,
  modelSupportsRole,
  ProviderAuthModeSchema,
  ProviderProtocolSchema,
  StructuredOutputModeSchema,
  parseAiTurnResultForJob,
  type AiTurnJob,
  type AiTurnResult,
  type ModelCapabilities,
  type ModelProfile
} from "@drawguessai/ai-adapters";
import { z } from "zod";

export const MINIMAX_SERVER_PROFILE_ID = "server-minimax-m3";
export const DEFAULT_SERVER_PROFILE_ID = "server-default";

export const WORKERS_AI_PROFILE_IDS = {
  gemma: "cloudflare-workers-ai-gemma-4",
  llama: "cloudflare-workers-ai-llama-4-scout",
  kimi: "cloudflare-workers-ai-kimi-k2-6",
  moondream: "cloudflare-workers-ai-moondream-3-1",
  glm: "cloudflare-workers-ai-glm-4-7-flash"
} as const;

export const WORKERS_AI_PROFILE_ID = WORKERS_AI_PROFILE_IDS.llama;
export const WORKERS_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct" as const;

const WorkersAiDialectSchema = z.enum(["llama-guided", "chat-completions", "moondream-query"]);
type WorkersAiDialect = z.infer<typeof WorkersAiDialectSchema>;

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
    label: "Cloudflare · GLM-4.7 Flash (text only)",
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
const MAX_CONFIGURED_SERVER_PROFILES = 8;
const MAX_SERVER_PROFILE_JSON_BYTES = 5 * 1024;
const MAX_CUSTOM_WORKERS_AI_PROFILES = 5;

const WorkersAiProfileDefinitionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^cloudflare-workers-ai-custom-[a-z0-9][a-z0-9-]*$/),
    label: z.string().trim().min(1).max(40),
    model: z
      .string()
      .min(1)
      .max(120)
      .regex(/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i),
    dialect: WorkersAiDialectSchema,
    capabilities: ModelCapabilitiesSchema,
    chatTemplateKwargs: z
      .object({
        thinking: z.boolean().optional(),
        enable_thinking: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.dialect === "moondream-query") {
      if (
        !profile.capabilities.vision ||
        profile.capabilities.supportedRoles?.length !== 1 ||
        profile.capabilities.supportedRoles[0] !== "guess"
      ) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", "supportedRoles"],
          message: "Moondream query profiles must be vision-only guessing profiles"
        });
      }
    } else if (profile.capabilities.structuredOutput !== "json-schema") {
      context.addIssue({
        code: "custom",
        path: ["capabilities", "structuredOutput"],
        message: "Chat and guided JSON profiles must support JSON Schema output"
      });
    }
    if (profile.dialect !== "chat-completions" && profile.chatTemplateKwargs !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["chatTemplateKwargs"],
        message: "Only chat-completions profiles accept chat template arguments"
      });
    }
  });

const ServerAuthModeSchema = ProviderAuthModeSchema;
export type ServerAuthMode = z.infer<typeof ServerAuthModeSchema>;

const ServerModelProfileSchema = ModelProfileSchema.refine(
  (profile) => profile.execution === "server" && profile.protocol !== "demo",
  "Server profiles must use a remote compatible protocol and server execution"
);

const ServerProfileRecordSchema = z
  .object({
    profile: ServerModelProfileSchema,
    apiKey: z.string().min(1).max(4096).optional(),
    apiKeyRef: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
    authMode: ServerAuthModeSchema.optional()
  })
  .strict()
  .refine(
    (record) => Number(record.apiKey !== undefined) + Number(record.apiKeyRef !== undefined) === 1,
    {
      path: ["apiKeyRef"],
      message: "Provide exactly one of apiKey or apiKeyRef"
    }
  )
  .superRefine((record, context) => {
    if (
      record.authMode !== undefined &&
      record.profile.authMode !== undefined &&
      record.authMode !== record.profile.authMode
    ) {
      context.addIssue({
        code: "custom",
        path: ["authMode"],
        message: "Top-level and profile authentication modes must agree"
      });
    }
  });

export interface ServerProfileRecord {
  profile: ModelProfile;
  apiKey: string;
  authMode?: ServerAuthMode | undefined;
}

export interface ServerAiEnvironment {
  SERVER_AI_PROFILES_JSON?: string;
  WORKERS_AI_PROFILES_JSON?: string;
  SERVER_AI_API_KEY?: string;
  SERVER_AI_PROFILE_ID?: string;
  SERVER_AI_LABEL?: string;
  SERVER_AI_PROTOCOL?: string;
  SERVER_AI_AUTH_MODE?: string;
  SERVER_AI_BASE_URL?: string;
  SERVER_AI_MODEL?: string;
  SERVER_AI_VISION?: string;
  SERVER_AI_STRUCTURED_OUTPUT?: string;
  SERVER_AI_MAX_OBSERVATION_PASSES?: string;
  SERVER_AI_DRAWING_PLAN_MODE?: string;
  SERVER_AI_REASONING_MODE?: string;
  SERVER_AI_SUPPORTED_ROLES?: string;
  MINIMAX_API_KEY?: string;
  MINIMAX_BASE_URL?: string;
  MINIMAX_MODEL?: string;
  MINIMAX_MAX_OBSERVATION_PASSES?: string;
}

export type ServerAiConfigIssueSource =
  "scalar" | "profiles-json" | "legacy-minimax" | "workers-ai-json";

export interface ServerAiConfigIssue {
  source: ServerAiConfigIssueSource;
  code: string;
  index?: number;
  path?: string;
}

export interface ServerAiConfiguration {
  profiles: ServerProfileRecord[];
  workersAiProfiles: WorkersAiProfileDefinition[];
  issues: ServerAiConfigIssue[];
}

function zodIssue(
  source: ServerAiConfigIssueSource,
  code: string,
  error: z.ZodError,
  index?: number
): ServerAiConfigIssue {
  const path = error.issues[0]?.path.map(String).join(".").slice(0, 120);
  return {
    source,
    code,
    ...(index === undefined ? {} : { index }),
    ...(path === undefined || path === "" ? {} : { path })
  };
}

function referencedSecret(environment: ServerAiEnvironment, reference: string): string | undefined {
  const value = (environment as unknown as Record<string, unknown>)[reference];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseServerProfilesWithDiagnostics(
  raw: string | undefined,
  environment: ServerAiEnvironment
): Pick<ServerAiConfiguration, "profiles" | "issues"> {
  if (raw === undefined) return { profiles: [], issues: [] };
  if (new TextEncoder().encode(raw).byteLength > MAX_SERVER_PROFILE_JSON_BYTES) {
    return {
      profiles: [],
      issues: [{ source: "profiles-json", code: "configuration-too-large" }]
    };
  }
  if (raw.trim() === "") return { profiles: [], issues: [] };
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      profiles: [],
      issues: [{ source: "profiles-json", code: "invalid-json" }]
    };
  }
  const entries = z.array(z.unknown()).max(MAX_CONFIGURED_SERVER_PROFILES).safeParse(decoded);
  if (!entries.success) {
    return {
      profiles: [],
      issues: [zodIssue("profiles-json", "invalid-profile-list", entries.error)]
    };
  }
  const profiles: ServerProfileRecord[] = [];
  const issues: ServerAiConfigIssue[] = [];
  entries.data.forEach((entry, index) => {
    const parsed = ServerProfileRecordSchema.safeParse(entry);
    if (!parsed.success) {
      issues.push(zodIssue("profiles-json", "invalid-profile", parsed.error, index));
      return;
    }
    const apiKey =
      parsed.data.apiKey ??
      (parsed.data.apiKeyRef === undefined
        ? undefined
        : referencedSecret(environment, parsed.data.apiKeyRef));
    if (apiKey === undefined) {
      issues.push({
        source: "profiles-json",
        code: "missing-referenced-secret",
        index,
        path: "apiKeyRef"
      });
      return;
    }
    profiles.push({
      profile: parsed.data.profile,
      apiKey,
      authMode: parsed.data.authMode ?? parsed.data.profile.authMode ?? "protocol-default"
    });
  });
  return { profiles, issues };
}

export function parseServerProfiles(
  raw: string | undefined,
  environment: ServerAiEnvironment = {}
): ServerProfileRecord[] {
  return parseServerProfilesWithDiagnostics(raw, environment).profiles;
}

function parseWorkersAiProfilesWithDiagnostics(
  raw: string | undefined
): Pick<ServerAiConfiguration, "workersAiProfiles" | "issues"> {
  if (raw === undefined) return { workersAiProfiles: [...WORKERS_AI_PROFILES], issues: [] };
  if (new TextEncoder().encode(raw).byteLength > MAX_SERVER_PROFILE_JSON_BYTES) {
    return {
      workersAiProfiles: [...WORKERS_AI_PROFILES],
      issues: [{ source: "workers-ai-json", code: "configuration-too-large" }]
    };
  }
  if (raw.trim() === "") return { workersAiProfiles: [...WORKERS_AI_PROFILES], issues: [] };
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      workersAiProfiles: [...WORKERS_AI_PROFILES],
      issues: [{ source: "workers-ai-json", code: "invalid-json" }]
    };
  }
  const entries = z.array(z.unknown()).max(MAX_CUSTOM_WORKERS_AI_PROFILES).safeParse(decoded);
  if (!entries.success) {
    return {
      workersAiProfiles: [...WORKERS_AI_PROFILES],
      issues: [zodIssue("workers-ai-json", "invalid-profile-list", entries.error)]
    };
  }

  const custom: WorkersAiProfileDefinition[] = [];
  const issues: ServerAiConfigIssue[] = [];
  const seen = new Set(workersAiProfileIds);
  entries.data.forEach((entry, index) => {
    const parsed = WorkersAiProfileDefinitionSchema.safeParse(entry);
    if (!parsed.success) {
      issues.push(zodIssue("workers-ai-json", "invalid-profile", parsed.error, index));
      return;
    }
    if (seen.has(parsed.data.id)) {
      issues.push({
        source: "workers-ai-json",
        code: "duplicate-profile-id",
        index,
        path: "id"
      });
      return;
    }
    seen.add(parsed.data.id);
    custom.push({
      id: parsed.data.id,
      label: parsed.data.label,
      model: parsed.data.model,
      dialect: parsed.data.dialect,
      capabilities: parsed.data.capabilities,
      ...(parsed.data.chatTemplateKwargs === undefined
        ? {}
        : { chatTemplateKwargs: parsed.data.chatTemplateKwargs })
    });
  });
  return { workersAiProfiles: [...WORKERS_AI_PROFILES, ...custom], issues };
}

export function configuredWorkersAiProfiles(
  environment: ServerAiEnvironment
): WorkersAiProfileDefinition[] {
  return parseWorkersAiProfilesWithDiagnostics(environment.WORKERS_AI_PROFILES_JSON)
    .workersAiProfiles;
}

const BooleanEnvironmentSettingSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(["true", "false"]).transform((value) => value === "true")
);

const ScalarServerProfileEnvironmentSchema = z.object({
  SERVER_AI_API_KEY: z.string().trim().min(1).max(4096),
  SERVER_AI_PROFILE_ID: z.string().trim().min(1).max(80).optional(),
  SERVER_AI_LABEL: z.string().trim().min(1).max(40).optional(),
  SERVER_AI_PROTOCOL: ProviderProtocolSchema.exclude(["demo"]).optional(),
  SERVER_AI_AUTH_MODE: ServerAuthModeSchema.optional(),
  SERVER_AI_BASE_URL: z.string().trim().min(1),
  SERVER_AI_MODEL: z.string().trim().min(1).max(120),
  SERVER_AI_VISION: BooleanEnvironmentSettingSchema.optional(),
  SERVER_AI_STRUCTURED_OUTPUT: StructuredOutputModeSchema.optional(),
  SERVER_AI_MAX_OBSERVATION_PASSES: z.coerce.number().int().min(0).max(2).optional(),
  SERVER_AI_DRAWING_PLAN_MODE: z.enum(["inline", "separate"]).optional(),
  SERVER_AI_REASONING_MODE: z.enum(["provider-default", "disabled"]).optional(),
  SERVER_AI_SUPPORTED_ROLES: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean)
    )
    .pipe(z.array(ModelRoleSchema).min(1).max(4))
    .optional()
});

const SCALAR_SERVER_SETTING_KEYS = [
  "SERVER_AI_API_KEY",
  "SERVER_AI_PROFILE_ID",
  "SERVER_AI_LABEL",
  "SERVER_AI_PROTOCOL",
  "SERVER_AI_AUTH_MODE",
  "SERVER_AI_BASE_URL",
  "SERVER_AI_MODEL",
  "SERVER_AI_VISION",
  "SERVER_AI_STRUCTURED_OUTPUT",
  "SERVER_AI_MAX_OBSERVATION_PASSES",
  "SERVER_AI_DRAWING_PLAN_MODE",
  "SERVER_AI_REASONING_MODE",
  "SERVER_AI_SUPPORTED_ROLES"
] as const satisfies readonly (keyof ServerAiEnvironment)[];

const LEGACY_MINIMAX_SETTING_KEYS = [
  "MINIMAX_API_KEY",
  "MINIMAX_BASE_URL",
  "MINIMAX_MODEL",
  "MINIMAX_MAX_OBSERVATION_PASSES"
] as const satisfies readonly (keyof ServerAiEnvironment)[];

function defaultServerProfileLabel(model: string): string {
  return [...`Server · ${model}`].slice(0, 40).join("");
}

function scalarServerProfile(
  environment: ServerAiEnvironment,
  issues?: ServerAiConfigIssue[]
): ServerProfileRecord | undefined {
  const configured = SCALAR_SERVER_SETTING_KEYS.some((key) => environment[key] !== undefined);
  if (!configured) return undefined;
  const settings = ScalarServerProfileEnvironmentSchema.safeParse(environment);
  if (!settings.success) {
    issues?.push(zodIssue("scalar", "invalid-profile", settings.error));
    return undefined;
  }

  const value = settings.data;
  const id = value.SERVER_AI_PROFILE_ID ?? DEFAULT_SERVER_PROFILE_ID;
  const vision = value.SERVER_AI_VISION ?? false;
  const maxObservationPasses = value.SERVER_AI_MAX_OBSERVATION_PASSES ?? 0;
  const supportedRoles =
    value.SERVER_AI_SUPPORTED_ROLES ??
    (vision ? ["prompt", "draw", "guess", "review"] : ["prompt", "draw", "review"]);
  const profile = ServerModelProfileSchema.safeParse({
    id,
    label: value.SERVER_AI_LABEL ?? defaultServerProfileLabel(value.SERVER_AI_MODEL),
    protocol: value.SERVER_AI_PROTOCOL ?? "openai-compatible",
    execution: "server",
    baseUrl: value.SERVER_AI_BASE_URL,
    model: value.SERVER_AI_MODEL,
    capabilities: {
      vision,
      structuredOutput: value.SERVER_AI_STRUCTURED_OUTPUT ?? "none",
      observationMode: maxObservationPasses > 0 ? "checkpoint" : "one-shot",
      maxObservationPasses,
      drawingPlanMode: value.SERVER_AI_DRAWING_PLAN_MODE ?? "inline",
      reasoningMode: value.SERVER_AI_REASONING_MODE ?? "provider-default",
      supportedRoles
    },
    secretRef: `server-key:${id}`,
    enabled: true
  });
  if (!profile.success) {
    issues?.push(zodIssue("scalar", "invalid-profile", profile.error));
    return undefined;
  }
  if (workersAiProfileIds.has(profile.data.id)) {
    issues?.push({
      source: "scalar",
      code: "reserved-profile-id",
      path: "SERVER_AI_PROFILE_ID"
    });
    return undefined;
  }
  return {
    profile: profile.data,
    apiKey: value.SERVER_AI_API_KEY,
    authMode: value.SERVER_AI_AUTH_MODE ?? "protocol-default"
  };
}

function miniMaxServerProfile(
  environment: ServerAiEnvironment,
  issues?: ServerAiConfigIssue[]
): ServerProfileRecord | undefined {
  const apiKey = environment.MINIMAX_API_KEY?.trim();
  const configured = LEGACY_MINIMAX_SETTING_KEYS.some((key) => environment[key] !== undefined);
  if (!configured) return undefined;
  if (apiKey === undefined || apiKey === "") {
    issues?.push({
      source: "legacy-minimax",
      code: "missing-api-key",
      path: "MINIMAX_API_KEY"
    });
    return undefined;
  }
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
  if (!profile.success) {
    issues?.push(zodIssue("legacy-minimax", "invalid-profile", profile.error));
    return undefined;
  }
  return { profile: profile.data, apiKey, authMode: "bearer" };
}

export function configuredServerProfilesWithDiagnostics(
  environment: ServerAiEnvironment
): ServerAiConfiguration {
  const issues: ServerAiConfigIssue[] = [];
  const workersConfiguration = parseWorkersAiProfilesWithDiagnostics(
    environment.WORKERS_AI_PROFILES_JSON
  );
  issues.push(...workersConfiguration.issues);
  const reservedProfileIds = new Set(workersConfiguration.workersAiProfiles.map(({ id }) => id));
  const primary =
    scalarServerProfile(environment, issues) ?? miniMaxServerProfile(environment, issues);
  const parsedJson = parseServerProfilesWithDiagnostics(
    environment.SERVER_AI_PROFILES_JSON,
    environment
  );
  issues.push(...parsedJson.issues);
  const candidates = [...(primary === undefined ? [] : [primary]), ...parsedJson.profiles];
  const seen = new Set<string>();
  const validProfiles = candidates.filter(({ profile }) => {
    if (!profile.enabled) return false;
    if (reservedProfileIds.has(profile.id)) {
      issues.push({
        source: profile === primary?.profile ? "scalar" : "profiles-json",
        code: "reserved-profile-id",
        path: "profile.id"
      });
      return false;
    }
    if (seen.has(profile.id)) {
      issues.push({
        source: "profiles-json",
        code: "duplicate-profile-id",
        path: "profile.id"
      });
      return false;
    }
    seen.add(profile.id);
    return true;
  });
  if (validProfiles.length > MAX_CONFIGURED_SERVER_PROFILES) {
    issues.push({ source: "profiles-json", code: "profile-limit-exceeded" });
  }
  const profiles = validProfiles.slice(0, MAX_CONFIGURED_SERVER_PROFILES);
  return {
    profiles,
    workersAiProfiles: workersConfiguration.workersAiProfiles,
    issues: issues.slice(0, 24)
  };
}

export function configuredServerProfiles(environment: ServerAiEnvironment): ServerProfileRecord[] {
  return configuredServerProfilesWithDiagnostics(environment).profiles;
}

export function publicServerProfiles(
  records: readonly ServerProfileRecord[],
  workersAiConfigured: boolean,
  workersAiProfiles: readonly WorkersAiProfileDefinition[] = WORKERS_AI_PROFILES
) {
  const profiles = records.map(({ profile }) => ({
    id: profile.id,
    label: profile.label,
    capabilities: profile.capabilities,
    execution: "server" as const
  }));
  if (workersAiConfigured) {
    profiles.push(
      ...workersAiProfiles.map(({ id, label, capabilities }) => ({
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
  timeoutMs?: number,
  profiles: readonly WorkersAiProfileDefinition[] = WORKERS_AI_PROFILES
): Promise<AiTurnResult> {
  const profile = profiles.find(({ id }) => id === profileId);
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
  job: AiTurnJob,
  workersAiProfiles: readonly WorkersAiProfileDefinition[] = WORKERS_AI_PROFILES
): Promise<AiTurnResult> {
  const workersAiProfile = workersAiProfiles.find(({ id }) => id === profileId);
  if (workersAiProfile !== undefined) {
    if (workersAi === undefined) throw new Error("Workers AI binding is not configured");
    return executeWorkersAi(
      workersAi,
      workersAiProfile.id,
      job,
      job.timeLimitSeconds * 1_000,
      workersAiProfiles
    );
  }

  const record = records.find(({ profile }) => profile.id === profileId && profile.enabled);
  if (record === undefined) throw new Error("Server AI profile is not configured");
  const serverFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete("anthropic-dangerous-direct-browser-access");
    if (record.authMode === "bearer") {
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${record.apiKey}`);
    } else if (record.authMode === "x-api-key") {
      headers.delete("authorization");
      headers.set("x-api-key", record.apiKey);
    }
    return fetch(input, { ...init, headers });
  };
  return executeAiTurn({
    profile: record.profile,
    secret: { secretRef: record.profile.secretRef ?? record.profile.id, apiKey: record.apiKey },
    job,
    timeoutMs: job.timeLimitSeconds * 1_000,
    fetchImpl: serverFetch
  });
}
