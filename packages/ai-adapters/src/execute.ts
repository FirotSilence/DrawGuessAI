import {
  hasVisibleCanvasContent,
  MAX_POINTS_PER_TURN,
  validateCanvasCommands
} from "@drawguessai/canvas-protocol";

import { getPersona } from "./personas";
import { parseAiTurnResult } from "./parse";
import { AI_RESULT_JSON_SCHEMA, buildSystemPrompt, buildUserPrompt } from "./prompt";
import {
  AiTurnJobSchema,
  AiTurnResultSchema,
  ModelProfileSchema,
  ModelSecretSchema,
  modelSupportsRole,
  type AiTurnJob,
  type AiTurnResult,
  type ModelProfile,
  type ModelSecret
} from "./schema";
import { createDemoTurnResult } from "./demo";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ExecuteAiTurnOptions {
  profile: ModelProfile;
  secret?: ModelSecret;
  job: AiTurnJob;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  attemptTimeoutMs?: number;
  requireDrawingFinish?: boolean;
  onRetry?: (notice: AiRetryNotice) => void;
}

export interface ParseAiTurnResultOptions {
  requireDrawingFinish?: boolean;
}

export interface AiRetryNotice {
  attempt: number;
  maxAttempts: number;
  errorCode: string;
}

type AiAdapterErrorCode =
  | "missing-key"
  | "http"
  | "rate-limited"
  | "token-plan-window-exhausted"
  | "quota-exhausted"
  | "invalid-response"
  | "empty-drawing"
  | "timeout"
  | "capability";

export class AiAdapterError extends Error {
  constructor(
    readonly code: AiAdapterErrorCode,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "AiAdapterError";
  }
}

const QUOTA_EXHAUSTED_PATTERN =
  /(?:token\s*plan.{0,60}(?:usage|limit|quota|exhaust|上限)|用量上限|额度.{0,20}(?:不足|耗尽|用完|上限)|(?:quota|credit|balance).{0,60}(?:exhaust|deplet|insufficient|exceed|limit)|(?:insufficient|exhausted).{0,40}(?:quota|credit|balance))/iu;
const TOKEN_PLAN_WINDOW_EXHAUSTED_PATTERN =
  /token\s*plan[\s\S]{0,180}(?:\(\s*2056\s*\)|["']?(?:status_)?code["']?\s*[:=]\s*2056)/iu;

function responseRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (value === undefined || value === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(5_000, Math.max(0, date - Date.now())) : undefined;
}

async function providerErrorText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 4_096);
  } catch {
    return "";
  }
}

async function providerHttpError(response: Response): Promise<AiAdapterError> {
  const detail = await providerErrorText(response);
  if (response.status === 429 && TOKEN_PLAN_WINDOW_EXHAUSTED_PATTERN.test(detail)) {
    return new AiAdapterError(
      "token-plan-window-exhausted",
      "The provider reports that the current Token Plan usage window is exhausted",
      response.status
    );
  }
  if (
    response.status === 402 ||
    (response.status === 429 && QUOTA_EXHAUSTED_PATTERN.test(detail))
  ) {
    return new AiAdapterError(
      "quota-exhausted",
      "The provider quota or token plan is exhausted",
      response.status
    );
  }
  if (response.status === 429) {
    return new AiAdapterError(
      "rate-limited",
      "The provider is rate limiting requests",
      response.status,
      responseRetryAfterMs(response)
    );
  }
  return new AiAdapterError(
    "http",
    `Provider request failed with HTTP ${response.status}`,
    response.status
  );
}

function retryDelayMs(error: unknown, attempt: number): number {
  if (error instanceof AiAdapterError && error.code === "rate-limited") {
    return error.retryAfterMs ?? Math.min(4_000, 500 * 2 ** attempt);
  }
  if (
    error instanceof AiAdapterError &&
    error.code === "http" &&
    (error.status === 408 || (error.status ?? 0) >= 500)
  ) {
    return Math.min(2_000, 250 * 2 ** attempt);
  }
  if (error instanceof TypeError) return Math.min(1_000, 200 * 2 ** attempt);
  return 0;
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function resolveEndpoint(profile: ModelProfile): string {
  const base = profile.baseUrl.replace(/\/$/, "");
  if (profile.protocol === "openai-compatible") {
    if (/\/chat\/completions$/.test(base)) return base;
    return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }
  if (/\/messages$/.test(base)) return base;
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

function parseDataUrl(dataUrl: string): { mediaType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new AiAdapterError("invalid-response", "Canvas image must be a base64 data URL");
  }
  return { mediaType: match[1], data: match[2] };
}

function isMiniMaxM3OpenAiProfile(profile: ModelProfile): boolean {
  if (
    profile.protocol !== "openai-compatible" ||
    !/^minimax-m3(?:\[1m\])?$/iu.test(profile.model)
  ) {
    return false;
  }
  try {
    return ["api.minimax.io", "api.minimaxi.com"].includes(
      new URL(profile.baseUrl).hostname.toLowerCase()
    );
  } catch {
    return false;
  }
}

function openAiBody(
  profile: ModelProfile,
  job: AiTurnJob,
  repairNote?: string
): Record<string, unknown> {
  const isMiniMaxM3 = isMiniMaxM3OpenAiProfile(profile);
  const content: Record<string, unknown>[] = [
    {
      type: "text",
      text: `${buildUserPrompt(job)}${repairNote === undefined ? "" : `\n${repairNote}`}`
    }
  ];
  if (job.imageDataUrl !== undefined) {
    content.push({ type: "image_url", image_url: { url: job.imageDataUrl } });
  }
  const body: Record<string, unknown> = {
    model: profile.model,
    ...(isMiniMaxM3
      ? { max_completion_tokens: modelMaxTokensForJob(job) }
      : { max_tokens: modelMaxTokensForJob(job) }),
    temperature: modelTemperatureForJob(job),
    messages: [
      { role: "system", content: buildSystemPrompt(job) },
      { role: "user", content }
    ]
  };
  if (isMiniMaxM3 && profile.capabilities.reasoningMode === "disabled") {
    body.thinking = { type: "disabled" };
  }
  if (profile.capabilities.structuredOutput === "json-schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "drawguessai_turn", strict: true, schema: AI_RESULT_JSON_SCHEMA }
    };
  } else if (profile.capabilities.structuredOutput === "json-object") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

function anthropicBody(
  profile: ModelProfile,
  job: AiTurnJob,
  repairNote?: string
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (job.imageDataUrl !== undefined) {
    const image = parseDataUrl(job.imageDataUrl);
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data }
    });
  }
  content.push({
    type: "text",
    text: `${buildUserPrompt(job)}${repairNote === undefined ? "" : `\n${repairNote}`}`
  });
  const body: Record<string, unknown> = {
    model: profile.model,
    max_tokens: modelMaxTokensForJob(job),
    temperature: modelTemperatureForJob(job),
    system: buildSystemPrompt(job),
    messages: [{ role: "user", content }]
  };
  if (profile.capabilities.reasoningMode === "disabled") {
    body.thinking = { type: "disabled" };
  }
  if (profile.capabilities.structuredOutput === "json-schema") {
    body.output_config = {
      format: { type: "json_schema", schema: AI_RESULT_JSON_SCHEMA }
    };
  }
  return body;
}

export function modelTemperatureForJob(job: AiTurnJob): number {
  return job.role === "draw" || job.role === "guess" ? 0.45 : 0.8;
}

export function modelMaxTokensForJob(job: AiTurnJob): number {
  if (job.role === "draw") {
    if (job.drawPhase === "plan") return 1_024;
    return job.drawPhase === "inspect" || job.observationIndex > 0 ? 4_096 : 6_144;
  }
  if (job.role === "guess") return 512;
  return job.role === "review" ? 384 : 512;
}

export const MAX_INITIAL_DRAW_ATTEMPTS = 4;

export function maxAiResponseAttemptsForJob(job: AiTurnJob): number {
  return job.role === "draw" && job.drawPhase !== "plan" && job.observationIndex === 0
    ? MAX_INITIAL_DRAW_ATTEMPTS
    : 2;
}

export function aiResponseErrorCode(error: unknown): string {
  if (error instanceof AiAdapterError) {
    if (error.code === "http") return `http-${error.status ?? "error"}`;
    return error.code;
  }
  if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
    return "invalid-response";
  }
  return "network";
}

export function isRetryableAiRequestError(error: unknown): boolean {
  if (error instanceof AiAdapterError) {
    if (error.code === "timeout") return true;
    if (error.code === "invalid-response" || error.code === "empty-drawing") return true;
    if (error.code === "rate-limited") return true;
    if (error.code !== "http") return false;
    const status = error.status ?? 0;
    return status === 408 || status === 429 || status >= 500;
  }
  if (error instanceof TypeError || error instanceof SyntaxError) return true;
  return false;
}

export function aiRepairInstruction(job: AiTurnJob, error: unknown): string {
  const detail = error instanceof Error ? error.message.slice(0, 180) : "schema mismatch";
  if (job.role === "draw" && job.drawPhase === "plan") {
    return `Your previous response was invalid: ${detail}. Return one corrected JSON object containing drawingPlan and no canvas commands.`;
  }
  if (
    job.role === "draw" &&
    error instanceof AiAdapterError &&
    error.message.includes("missing-finish")
  ) {
    return `Your previous drawing was incomplete: ${detail}. Return one corrected JSON object with visible drawing commands and exactly one finish command after the last drawing command.`;
  }
  if (aiResponseErrorCode(error) === "empty-drawing") {
    return `Your previous drawing was blank: ${detail}. Return one corrected JSON object with clearCanvas=false and at least one visible pen stroke or shape. Do not return finish by itself.`;
  }
  if (error instanceof AiAdapterError && error.message.includes("Live reaction")) {
    return "Your previous reaction leaked hidden content. Return one corrected JSON object. Replace reaction.text with content-free first-person emotion only, written as though the prompt, guess, image, and commands were redacted. Do not mention or imply anything drawn, guessed, seen, located, shaped, colored, counted, or related; if it could narrow the answer, rewrite it.";
  }
  if (
    job.role === "review" &&
    error instanceof AiAdapterError &&
    /(?:Review target|exact actor id|target turn)/iu.test(error.message)
  ) {
    return `Your previous review targeted the wrong player contribution: ${detail}. Return corrected JSON using only REVIEW TARGETS. Every action needs the exact targetActorId and targetTurnIndex. Address a DRAWER about that drawing and a GUESSER about that guess; never swap their roles.`;
  }
  if (error instanceof AiAdapterError && error.message.includes("role ownership")) {
    return `Your previous review confused player roles: ${detail}. Return corrected JSON after reading SELF ROLE, ROLE OWNERSHIP, PLAYERS, and YOUR TURNS. A GUESSER owns only their guess and never the incoming drawing; a DRAWER owns only their drawing and never the downstream guess. Correct both review.text and directed action text.`;
  }
  return `Your previous response was invalid: ${detail}. Return one corrected JSON object only. For a drawing refinement, explicitly include clearCanvas=false for delta-only additions or clearCanvas=true for a complete replacement.`;
}

function extractText(profile: ModelProfile, payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new AiAdapterError("invalid-response", "Provider returned a non-object response");
  }
  if (profile.protocol === "openai-compatible") {
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new AiAdapterError("invalid-response", "OpenAI-compatible response has no choices");
    }
    const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text)
            : ""
        )
        .join("");
    }
  } else {
    const content = (payload as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part !== "object" || part === null) return "";
          const candidate = part as { type?: unknown; text?: unknown };
          return candidate.type === "text" && typeof candidate.text === "string"
            ? candidate.text
            : "";
        })
        .join("");
    }
  }
  throw new AiAdapterError("invalid-response", "Provider response contains no text output");
}

async function requestOnce(
  profile: ModelProfile,
  secret: ModelSecret,
  job: AiTurnJob,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  repairNote?: string
): Promise<string> {
  const isOpenAi = profile.protocol === "openai-compatible";
  const headers: Record<string, string> = { "content-type": "application/json" };
  const authMode =
    profile.authMode === undefined || profile.authMode === "protocol-default"
      ? isOpenAi
        ? "bearer"
        : "x-api-key"
      : profile.authMode;
  if (authMode === "bearer") {
    headers.authorization = `Bearer ${secret.apiKey}`;
  } else {
    headers["x-api-key"] = secret.apiKey;
  }
  if (!isOpenAi) {
    headers["anthropic-version"] = "2023-06-01";
    if (profile.execution === "local") {
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }
  }
  const response = await fetchImpl(resolveEndpoint(profile), {
    method: "POST",
    headers,
    body: JSON.stringify(
      isOpenAi ? openAiBody(profile, job, repairNote) : anthropicBody(profile, job, repairNote)
    ),
    signal
  });
  if (!response.ok) throw await providerHttpError(response);
  return extractText(profile, (await response.json()) as unknown);
}

async function requestWithAttemptTimeout(
  profile: ModelProfile,
  secret: ModelSecret,
  job: AiTurnJob,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  attemptTimeoutMs: number | undefined,
  repairNote?: string
): Promise<string> {
  if (attemptTimeoutMs === undefined) {
    return requestOnce(profile, secret, job, fetchImpl, signal, repairNote);
  }
  const attemptController = new AbortController();
  const abortAttempt = () => attemptController.abort();
  if (signal.aborted) {
    abortAttempt();
  } else {
    signal.addEventListener("abort", abortAttempt, { once: true });
  }
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      requestOnce(profile, secret, job, fetchImpl, attemptController.signal, repairNote),
      new Promise<never>((_resolve, reject) => {
        timeout = globalThis.setTimeout(() => {
          timedOut = true;
          attemptController.abort();
          reject(new AiAdapterError("timeout", "Provider request attempt timed out"));
        }, attemptTimeoutMs);
      })
    ]);
  } catch (error) {
    if (timedOut) throw new AiAdapterError("timeout", "Provider request attempt timed out");
    throw error;
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    signal.removeEventListener("abort", abortAttempt);
  }
}

export function createFallbackAiTurnResult(job: AiTurnJob, errorCode: string): AiTurnResult {
  const persona = getPersona(job.personaId);
  const text = persona.fallback[job.locale];
  const common = {
    jobId: job.jobId,
    status: "fallback" as const,
    confidence: 0,
    reaction: { kind: "egg" as const, text },
    errorCode
  };
  if (job.role === "draw" && job.drawPhase === "plan") {
    return AiTurnResultSchema.parse({
      ...common,
      drawingPlan: {
        summary: job.inputText ?? "a readable central subject",
        keyFeatures: [job.inputText ?? "recognizable silhouette"],
        objects: [
          {
            id: "subject",
            label: job.inputText ?? "subject",
            bounds: { x: 150, y: 100, width: 700, height: 550 },
            features: ["clear silhouette"]
          }
        ],
        relationships: []
      }
    });
  }
  if (job.role === "draw") {
    return AiTurnResultSchema.parse({
      ...common,
      commands: [{ type: "finish", id: `${job.jobId}-fallback-finish`, offsetMs: 0 }]
    });
  }
  if (job.role === "guess") {
    return AiTurnResultSchema.parse({
      ...common,
      guess: job.locale === "zh-CN" ? "我完全没看懂" : "I have absolutely no idea"
    });
  }
  if (job.role === "review") {
    return AiTurnResultSchema.parse({
      ...common,
      review: { text: persona.reviewFallback[job.locale], score: 3 },
      reaction: { kind: persona.reviewReaction, text }
    });
  }
  return AiTurnResultSchema.parse({
    ...common,
    prompt: job.locale === "zh-CN" ? "雨中骑自行车" : "riding a bicycle in the rain",
    promptKind: "phrase",
    promptTopic: "action"
  });
}

interface StrokeLike {
  type: "stroke";
  tool?: unknown;
  color?: unknown;
  fillColor?: unknown;
  width?: unknown;
  points: readonly { x: number; y: number }[];
}

function strokeLike(command: unknown): StrokeLike | undefined {
  if (typeof command !== "object" || command === null) return undefined;
  const candidate = command as Record<string, unknown>;
  if (candidate.type !== "stroke" || !Array.isArray(candidate.points)) return undefined;
  const points = candidate.points.flatMap((point): { x: number; y: number }[] => {
    if (typeof point !== "object" || point === null) return [];
    const value = point as Record<string, unknown>;
    return typeof value.x === "number" && typeof value.y === "number"
      ? [{ x: value.x, y: value.y }]
      : [];
  });
  return {
    type: "stroke",
    tool: candidate.tool,
    color: candidate.color,
    fillColor: candidate.fillColor,
    width: candidate.width,
    points
  };
}

export function appearsToBeFullRedraw(
  existingCommands: readonly unknown[],
  newCommands: readonly unknown[]
): boolean {
  const existingStrokes = existingCommands.flatMap((command) => strokeLike(command) ?? []);
  const newStrokes = newCommands.flatMap((command) => {
    const stroke = strokeLike(command);
    return stroke?.tool === "pen" && stroke.color !== "#f7f8fa" ? [stroke] : [];
  });
  if (newStrokes.length < Math.max(8, Math.ceil(existingStrokes.length * 0.75))) return false;
  const points = newStrokes.flatMap((command) => command.points);
  if (points.length === 0) return false;
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  return Math.max(...xs) - Math.min(...xs) >= 600 && Math.max(...ys) - Math.min(...ys) >= 350;
}

export function parseAiTurnResultForJob(
  text: string,
  job: AiTurnJob,
  options: ParseAiTurnResultOptions = {}
): AiTurnResult {
  let result = parseAiTurnResult(text, job.jobId);
  if (job.role !== "review" && !isLiveReactionSpoilerFree(result, job)) {
    throw new AiAdapterError(
      "invalid-response",
      "Live reaction must not reveal or repeat the turn content"
    );
  }
  if (result.status === "fallback") {
    if (
      job.role === "draw" &&
      job.drawPhase !== "plan" &&
      job.observationIndex === 0 &&
      !hasVisibleCanvasContent(result.commands ?? [])
    ) {
      throw new AiAdapterError("empty-drawing", "Drawing result contains no visible stroke");
    }
    return result;
  }
  if (job.role === "guess" && result.guess === undefined) {
    throw new AiAdapterError("invalid-response", "Guessing result is missing a guess");
  }
  if (job.role === "prompt" && result.prompt === undefined) {
    throw new AiAdapterError("invalid-response", "Prompt result is missing a prompt");
  }
  if (job.role === "review") {
    if (result.review === undefined) {
      throw new AiAdapterError("invalid-response", "Review result is missing a public review");
    }
    if ((result.review.actions?.length ?? 0) === 0) {
      throw new AiAdapterError(
        "invalid-response",
        "Review result must include at least one directed player interaction"
      );
    }
    const authoredReviewText = [
      result.review.text,
      ...(result.review.actions ?? []).map((action) => action.text)
    ].join("\n");
    if (!reviewRespectsRoleOwnership(authoredReviewText, job.reviewRole)) {
      throw new AiAdapterError(
        "invalid-response",
        `Review role ownership mismatch: ${job.reviewRole === "guess" ? "the GUESSER claimed the drawing" : "the DRAWER claimed the guess"}`
      );
    }
    if (job.reviewActors !== undefined) {
      const seenTargets = new Set<string>();
      for (const action of result.review.actions ?? []) {
        const target = job.reviewActors.find(
          (candidate) => candidate.actorId === action.targetActorId
        );
        if (target === undefined) {
          throw new AiAdapterError(
            "invalid-response",
            `Review target must use an exact actor id: ${action.targetActorId}`
          );
        }
        if (target.actorId === job.actorId) {
          throw new AiAdapterError("invalid-response", "Review target must not be the reviewer");
        }
        const targetTurn =
          action.targetTurnIndex === undefined
            ? target.turns.length === 1
              ? target.turns[0]
              : undefined
            : target.turns.find((turn) => turn.index === action.targetTurnIndex);
        if (targetTurn === undefined) {
          throw new AiAdapterError(
            "invalid-response",
            `Review target turn is missing or does not belong to actorId=${target.actorId}`
          );
        }
        const targetKey = `${target.actorId}:${targetTurn.index}`;
        if (seenTargets.has(targetKey)) {
          throw new AiAdapterError(
            "invalid-response",
            `Review target turn was repeated: ${targetKey}`
          );
        }
        seenTargets.add(targetKey);
        if (!reviewActionRespectsTargetRole(action.text, targetTurn.role)) {
          throw new AiAdapterError(
            "invalid-response",
            `Review target role ownership mismatch: T${targetTurn.index + 1} belongs to a ${targetTurn.role.toUpperCase()}`
          );
        }
      }
      if (result.review.replyToActorId !== undefined) {
        const replyTarget = job.reviewActors.find(
          (candidate) => candidate.actorId === result.review?.replyToActorId
        );
        if (replyTarget === undefined) {
          throw new AiAdapterError(
            "invalid-response",
            `Review reply must use an exact actor id: ${result.review.replyToActorId}`
          );
        }
        if (replyTarget.actorId === job.actorId) {
          throw new AiAdapterError("invalid-response", "Review reply must not target the reviewer");
        }
      }
    }
  }
  if (job.role === "draw" && job.drawPhase === "plan") {
    if (result.drawingPlan === undefined) {
      throw new AiAdapterError("invalid-response", "Drawing plan result is missing a scene plan");
    }
    return result;
  }
  if (job.role === "draw") {
    if (result.commands === undefined) {
      throw new AiAdapterError("invalid-response", "Drawing result is missing commands");
    }
    const outputCommands = result.commands;
    if (job.observationIndex > 0 && result.clearCanvas === undefined) {
      throw new AiAdapterError(
        "invalid-response",
        "A refinement result must explicitly choose whether to clear the canvas"
      );
    }
    if (job.observationIndex === 0 && result.clearCanvas === true) {
      throw new AiAdapterError("invalid-response", "The initial blank canvas cannot be cleared");
    }
    if (
      job.observationIndex > 0 &&
      result.clearCanvas === false &&
      appearsToBeFullRedraw(job.inputCommands ?? [], outputCommands)
    ) {
      result = AiTurnResultSchema.parse({ ...result, clearCanvas: true });
    }
    const visibleCommands = [
      ...(result.clearCanvas === true ? [] : (job.inputCommands ?? [])),
      ...outputCommands
    ];
    const validation = validateCanvasCommands(
      visibleCommands,
      {
        maxStrokes: job.budget.maxStrokes,
        maxUndos: job.budget.maxUndos,
        colorCount: job.budget.colorCount,
        maxTotalPoints: MAX_POINTS_PER_TURN
      },
      { requireFinish: options.requireDrawingFinish === true }
    );
    if (!validation.ok) {
      const codes = [...new Set(validation.issues.map((issue) => issue.code))].join(", ");
      throw new AiAdapterError(
        "invalid-response",
        `Drawing commands violate the active canvas rules: ${codes || "invalid-canvas"}`
      );
    }
    if (!hasVisibleCanvasContent(visibleCommands)) {
      throw new AiAdapterError("empty-drawing", "Drawing result contains no visible stroke");
    }
  }
  return result;
}

function normalizedReactionContent(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

const REACTION_FRAGMENT_STOP_WORDS = new Set([
  "a",
  "an",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "to",
  "up",
  "the",
  "and",
  "with",
  "from",
  "into",
  "onto",
  "under",
  "over",
  "near",
  "this",
  "that"
]);

function protectedHanReactionFragments(value: string | undefined): string[] {
  if (value === undefined) return [];
  const fragments = new Set<string>();
  for (const run of value.normalize("NFKC").match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length === 1) {
      fragments.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      fragments.add(run.slice(index, index + 2));
    }
  }
  return [...fragments];
}

function protectedAsciiReactionWords(value: string | undefined): string[] {
  return (
    value
      ?.normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  ).filter((word) => word.length >= 2 && !REACTION_FRAGMENT_STOP_WORDS.has(word));
}

const LIVE_REACTION_DESCRIPTION_PATTERNS = [
  /\b(?:shape|outline|silhouette|colou?r|linework|background|foreground)\b/iu,
  /\b(?:there (?:is|are|was|were)|in the (?:image|drawing|picture)|on the (?:canvas|left|right|top|bottom))\b/iu,
  /\b(?:i|we|you|they)\s+(?:drew|painted|sketched|guessed|saw|see)\s+(?:a|an|the|one|two|three|some)\b/iu,
  /\b(?:it|this|that)\s+looks?\s+like\s+(?:a|an|the)\b/iu,
  /(?:我|你|他|她|它|我们|他们)(?:画了|画的|画成|画出|猜了|猜的|猜成|猜出|看见|看到)/u,
  /(?:图里|图上|图中|画里|画上|画中|左边|右边|上面|下面|中间|轮廓|颜色|形状|线条|背景|前景|主体|物体)/u,
  /像(?:是)?(?:一|个|只|条|把|辆|棵|张|座|朵|头|位)/u,
  /(?:这个|那个|这|那)(?:东西|玩意|物体|图案)/u,
  /\b(?:red|orange|yellow|green|blue|purple|pink|brown|black|white|gray|grey|circle|circular|oval|ellipse|square|rectangle|rectangular|triangle|triangular|left|right|upper|lower|fruit|animal|person|historical)\b/iu,
  /(?:红色|橙色|黄色|绿色|青色|蓝色|紫色|粉色|棕色|褐色|黑色|白色|灰色|圆形|圆圈|椭圆|方形|正方形|长方形|矩形|三角形|左侧|右侧|上方|下方|水果|动物|人物|历史人物)/u
];

function hasDescriptiveReactionContent(value: string): boolean {
  return LIVE_REACTION_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(value));
}

export function reviewRespectsRoleOwnership(
  text: string,
  reviewRole: AiTurnJob["reviewRole"]
): boolean {
  if (reviewRole === "guess") {
    return !(
      /(?:我画了|我画的|我画成|我画出|我的画|我的画作|我的作品|我的线条|我的配色|我的构图)/u.test(
        text
      ) ||
      /\b(?:i (?:drew|painted|sketched)|my (?:drawing|painting|sketch|artwork|lines|colou?rs?|composition))\b/iu.test(
        text
      )
    );
  }
  if (reviewRole === "draw") {
    return !(
      /(?:我猜了|我猜的|我猜成|我猜出|我的猜词|我的猜测|我的答案)/u.test(text) ||
      /\b(?:i guessed|my (?:guess|answer))\b/iu.test(text)
    );
  }
  return true;
}

export function reviewActionRespectsTargetRole(
  text: string,
  targetRole: "draw" | "guess"
): boolean {
  if (targetRole === "guess") {
    return !(
      /(?:你|您)(?:这|那)?(?:幅|张|个)?(?:画|图|画作|作品|线条|配色|构图)|(?:你|您)(?:画了|画的|画成|画出|绘制|涂|描)/u.test(
        text
      ) ||
      /\b(?:your (?:drawing|picture|painting|sketch|artwork|lines|colou?rs?|composition)|you (?:drew|draw|painted|sketched))\b/iu.test(
        text
      )
    );
  }
  return !(
    /(?:你|您)(?:猜了|猜的|猜成|猜出|猜词|猜测|答案|回答)|(?:你|您)的(?:猜词|猜测|答案|回答)/u.test(
      text
    ) || /\b(?:your (?:guess|answer)|you (?:guessed|answered))\b/iu.test(text)
  );
}

export function isLiveReactionSpoilerFree(result: AiTurnResult, job: AiTurnJob): boolean {
  const reaction = normalizedReactionContent(result.reaction.text);
  if (hasDescriptiveReactionContent(result.reaction.text)) return false;
  const protectedValues = [
    ...(job.role === "draw" ? [job.inputText] : []),
    ...(job.role === "guess" ? [result.guess] : []),
    ...(job.role === "prompt" ? [result.prompt] : [])
  ];
  const reactionWords = new Set(
    result.reaction.text
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  );
  return !protectedValues.some(
    (value) =>
      protectedHanReactionFragments(value).some((fragment) => reaction.includes(fragment)) ||
      protectedAsciiReactionWords(value).some((word) => reactionWords.has(word))
  );
}

export async function executeAiTurn(options: ExecuteAiTurnOptions): Promise<AiTurnResult> {
  const profile = ModelProfileSchema.parse(options.profile);
  const job = AiTurnJobSchema.parse(options.job);
  if (!modelSupportsRole(profile.capabilities, job.role)) {
    if (job.role === "guess" && !profile.capabilities.vision) {
      throw new AiAdapterError("capability", "This AI profile cannot inspect images");
    }
    throw new AiAdapterError("capability", `This AI profile does not support ${job.role} turns`);
  }
  if (profile.protocol === "demo") return createDemoTurnResult(job);
  if (job.observationIndex > 0 && !profile.capabilities.vision) {
    throw new AiAdapterError("capability", "This AI profile cannot inspect drawing checkpoints");
  }
  if (options.secret === undefined) {
    throw new AiAdapterError("missing-key", "No provider key is available for this profile");
  }
  const secret = ModelSecretSchema.parse(options.secret);
  if (profile.secretRef !== secret.secretRef) {
    throw new AiAdapterError("missing-key", "The selected key does not match this profile");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 90_000;
  const attemptTimeoutMs =
    options.attemptTimeoutMs === undefined
      ? undefined
      : Math.max(1, Math.min(options.attemptTimeoutMs, timeoutMs));
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const deadlineResult = new Promise<AiTurnResult>((resolve) => {
    timeout = globalThis.setTimeout(() => {
      controller.abort();
      resolve(createFallbackAiTurnResult(job, "timeout"));
    }, timeoutMs);
  });
  const requestResult = (async (): Promise<AiTurnResult> => {
    const maxAttempts = maxAiResponseAttemptsForJob(job);
    let repairNote: string | undefined;
    let lastError: unknown = new AiAdapterError("invalid-response", "No provider response");
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await requestWithAttemptTimeout(
          profile,
          secret,
          job,
          fetchImpl,
          controller.signal,
          attemptTimeoutMs,
          repairNote
        );
        try {
          return parseAiTurnResultForJob(response, job, {
            requireDrawingFinish: options.requireDrawingFinish === true
          });
        } catch (error) {
          lastError = error;
          repairNote = aiRepairInstruction(job, error);
        }
      } catch (error) {
        lastError = error;
        if (!isRetryableAiRequestError(error)) break;
        if (
          error instanceof SyntaxError ||
          (error instanceof AiAdapterError &&
            (error.code === "invalid-response" || error.code === "empty-drawing"))
        ) {
          repairNote = aiRepairInstruction(job, error);
        }
      }
      if (controller.signal.aborted) break;
      if (attempt + 1 >= maxAttempts) break;
      options.onRetry?.({
        attempt: attempt + 2,
        maxAttempts,
        errorCode: aiResponseErrorCode(lastError)
      });
      await waitForRetry(retryDelayMs(lastError, attempt), controller.signal);
    }
    if (controller.signal.aborted) return createFallbackAiTurnResult(job, "timeout");
    if (lastError instanceof AiAdapterError && lastError.code === "missing-key") throw lastError;
    return createFallbackAiTurnResult(job, aiResponseErrorCode(lastError));
  })();
  try {
    return await Promise.race([requestResult, deadlineResult]);
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}

export function publicModelProfile(profile: ModelProfile): ModelProfile {
  const parsed = ModelProfileSchema.parse(profile);
  return { ...parsed, secretRef: parsed.secretRef };
}
