import {
  AiTurnResultSchema,
  createFallbackAiTurnResult,
  modelObservationPassLimit,
  modelSupportsRole,
  type AiCanvasSourceCommand,
  type AiDrawingPlan,
  type AiTurnJob,
  type AiTurnResult
} from "@drawguessai/ai-adapters";
import {
  activeStrokeCommands,
  hasVisibleCanvasContent,
  validateCanvasCommands,
  type CanvasBudget,
  type CanvasCommand,
  type FinishCommand,
  type UndoCommand
} from "@drawguessai/canvas-protocol";

import { ApiRequestError, executeServerAi } from "./api";
import { commandsToAiImageDataUrl } from "./canvas-renderer";
import { secretFor, type StoredModelProfile } from "./model-store";
import type { RoomSession } from "./session-store";

interface WorkerResultResponse {
  requestId: string;
  type: "result";
  ok: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
}

interface WorkerRetryResponse {
  requestId: string;
  type: "retry";
  attempt: number;
  maxAttempts: number;
  errorCode: string;
}

type WorkerResponse = WorkerResultResponse | WorkerRetryResponse;

class AiExecutionFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AiExecutionFailure";
  }
}

export function aiExecutionErrorCode(error: unknown): string {
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return "timeout";
  }
  if (error instanceof AiExecutionFailure) return error.code;
  if (error instanceof ApiRequestError) {
    const serverCode = error.code
      ?.toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 48);
    return serverCode === undefined || serverCode === ""
      ? `server-http-${error.status}`
      : `server-${serverCode}`;
  }
  if (error instanceof Error && error.name === "ZodError") return "invalid-server-result";
  return "execution-error";
}

export interface AiPipelineActivity {
  stage:
    | "queued"
    | "planning"
    | "requesting"
    | "retrying"
    | "inspecting"
    | "refining"
    | "validating"
    | "complete";
  observationIndex: number;
  observationLimit: number;
  strokeCount: number;
}

export interface AiPipelineOptions {
  timeoutMs?: number;
  onActivity?: (activity: AiPipelineActivity) => void;
  onInspect?: () => void;
  onResume?: () => void;
  onClearCanvas?: () => void;
  onPreviewCommands?: (
    batch: readonly CanvasCommand[],
    accumulated: readonly CanvasCommand[]
  ) => void | Promise<void>;
}

export const MAX_CANVAS_CANDIDATE_ATTEMPTS = 4;

export function droppedCommandFeedback(
  warnings: readonly string[] | undefined
): string | undefined {
  if (warnings === undefined || warnings.length === 0) return undefined;
  const prefix = "Some commands from the previous pass were skipped: ";
  const suffix = " Inspect the canvas and restore only missing or corrupt marks.";
  const detailLimit = Math.max(0, 240 - prefix.length - suffix.length);
  return `${prefix}${warnings.join(" | ").slice(0, detailLimit)}${suffix}`;
}

function boundedCommandId(prefix: string, suffix: string): string {
  return `${prefix.slice(0, Math.max(0, 80 - suffix.length))}${suffix}`;
}

function runLocalWorker(
  record: StoredModelProfile,
  job: AiTurnJob,
  timeoutMs: number,
  onRetry?: () => void
): Promise<AiTurnResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/ai-worker.ts", import.meta.url), {
      type: "module"
    });
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new DOMException("AI worker timed out", "TimeoutError"));
    }, timeoutMs + 500);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.requestId !== requestId) return;
      if (event.data.type === "retry") {
        onRetry?.();
        return;
      }
      window.clearTimeout(timer);
      worker.terminate();
      if (!event.data.ok) {
        reject(
          new AiExecutionFailure(
            event.data.errorCode ?? "worker-error",
            event.data.error ?? "AI worker failed"
          )
        );
        return;
      }
      try {
        resolve(AiTurnResultSchema.parse(event.data.result));
      } catch (error) {
        reject(
          new AiExecutionFailure(
            "invalid-worker-result",
            error instanceof Error ? error.message : "AI worker returned an invalid result"
          )
        );
      }
    };
    worker.onerror = (event) => {
      window.clearTimeout(timer);
      worker.terminate();
      reject(new AiExecutionFailure("worker-error", event.message));
    };
    worker.postMessage({
      requestId,
      profile: record.profile,
      secret: secretFor(record),
      job,
      timeoutMs
    });
  });
}

function remapBatch(
  commands: readonly CanvasCommand[],
  prefix: string,
  existingIds: ReadonlyMap<string, string> = new Map()
): { commands: CanvasCommand[]; ids: Map<string, string> } {
  const ids = new Map(existingIds);
  const remapped = commands.map((command, index) => {
    const suffix = `-${index}`;
    const id = boundedCommandId(prefix, suffix);
    if (command.type === "undo") {
      const targetId = ids.get(command.targetId) ?? command.targetId;
      ids.delete(command.targetId);
      return {
        ...command,
        id,
        targetId
      } satisfies UndoCommand;
    }
    ids.set(command.id, id);
    return { ...command, id };
  });
  return { commands: remapped, ids };
}

function candidateFinish(id: string): FinishCommand {
  return {
    type: "finish",
    id: boundedCommandId(id, "-candidate-end"),
    offsetMs: 0
  };
}

export function validateAiDrawingCandidate(
  commands: readonly CanvasCommand[],
  budget: CanvasBudget,
  candidateId = "ai"
): ReturnType<typeof validateCanvasCommands> {
  return validateCanvasCommands([...commands, candidateFinish(candidateId)], budget, {
    requireFinish: true
  });
}

function canvasValidationFeedback(
  validation: ReturnType<typeof validateCanvasCommands>,
  visible: boolean
): string {
  const codes = validation.ok
    ? []
    : [...new Set(validation.issues.map((issue) => issue.code))].slice(0, 5);
  const problem = validation.ok
    ? visible
      ? "the candidate needs a smaller correction"
      : "the candidate left no visible pen content"
    : `canvas rules failed: ${codes.join(", ") || "invalid canvas"}`;
  return `${problem}. Return a smaller corrected candidate using only the allowed palette and remaining stroke, undo, and point budgets.`.slice(
    0,
    240
  );
}

async function executeOnce(
  record: StoredModelProfile,
  session: RoomSession,
  job: AiTurnJob,
  timeoutMs: number,
  onRetry?: () => void
): Promise<AiTurnResult> {
  try {
    if (record.profile.execution === "server") {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs + 1_000);
      try {
        return await executeServerAi(record.profile.id, session, job, controller.signal);
      } finally {
        window.clearTimeout(timer);
      }
    }
    return await runLocalWorker(record, job, timeoutMs, onRetry);
  } catch (error) {
    return createFallbackAiTurnResult(job, aiExecutionErrorCode(error));
  }
}

export function allocateAiPassSeconds(
  turnLimitSeconds: number,
  remainingMs: number,
  remainingPasses = 1
): number {
  const perPassMs = Math.floor(Math.max(5_000, remainingMs - 750) / remainingPasses);
  return Math.max(5, Math.min(turnLimitSeconds, Math.floor(perPassMs / 1_000)));
}

export function allocateAiPlanSeconds(remainingMs: number, totalCalls: number): number {
  const fairShare = Math.floor(Math.max(5_000, remainingMs - 750) / Math.max(1, totalCalls));
  return Math.max(5, Math.min(20, Math.floor(fairShare / 1_000)));
}

export function effectiveObservationLimit(
  requestedPasses: number,
  modelPasses: number,
  vision: boolean,
  timeoutMs: number
): number {
  const callsAllowedByTime = Math.floor(Math.max(0, timeoutMs - 750) / 5_500);
  return Math.min(
    requestedPasses,
    modelPasses,
    vision ? 2 : 0,
    Math.max(0, callsAllowedByTime - 2)
  );
}

export function mergeAiDrawingPass(
  existing: readonly CanvasCommand[],
  result: AiTurnResult,
  prefix: string,
  pass: number,
  existingIds: ReadonlyMap<string, string> = new Map()
): {
  accumulated: CanvasCommand[];
  batch: CanvasCommand[];
  cleared: boolean;
  ids: Map<string, string>;
} {
  const cleared = pass > 0 && result.clearCanvas === true;
  const rawBatch = (result.commands ?? []).filter(
    (command) => command.type !== "finish" && !(cleared && command.type === "undo")
  );
  const remapped = remapBatch(rawBatch, prefix, cleared ? new Map() : existingIds);
  return {
    accumulated: [...(cleared ? [] : existing), ...remapped.commands],
    batch: remapped.commands,
    cleared,
    ids: remapped.ids
  };
}

function sourceBatchForResult(result: AiTurnResult, cleared: boolean): AiCanvasSourceCommand[] {
  return [...(result.sourceCommands ?? result.commands ?? [])].filter(
    (command): command is AiCanvasSourceCommand =>
      command.type !== "finish" && command.type !== "fill" && !(cleared && command.type === "undo")
  );
}

export function compactAiCanvasSourceCommands(
  commands: readonly AiCanvasSourceCommand[]
): AiCanvasSourceCommand[] {
  const active = new Map<string, AiCanvasSourceCommand>();
  for (const command of commands) {
    if (command.type === "undo") {
      active.delete(command.targetId);
    } else if (command.type !== "finish") {
      active.set(command.id, command);
    }
  }
  return [...active.values()];
}

export async function executeAiPipeline(
  record: StoredModelProfile,
  session: RoomSession,
  originalJob: AiTurnJob,
  options: AiPipelineOptions = {}
): Promise<AiTurnResult> {
  if (!modelSupportsRole(record.profile.capabilities, originalJob.role)) {
    throw new Error(`The selected AI profile does not support ${originalJob.role} turns`);
  }
  const timeoutMs = options.timeoutMs ?? originalJob.timeLimitSeconds * 1_000;
  const deadline = Date.now() + timeoutMs;
  const plannedObservationLimit =
    originalJob.role === "draw"
      ? effectiveObservationLimit(
          originalJob.observationLimit,
          modelObservationPassLimit(record.profile.capabilities),
          record.profile.capabilities.vision,
          timeoutMs
        )
      : 0;
  const emit = (
    stage: AiPipelineActivity["stage"],
    observationIndex: number,
    observationLimit: number,
    strokeCount: number
  ) => options.onActivity?.({ stage, observationIndex, observationLimit, strokeCount });

  emit("queued", 0, plannedObservationLimit, 0);
  if (originalJob.role !== "draw") {
    const remainingMs = Math.max(5_000, deadline - Date.now());
    const job: AiTurnJob = {
      ...originalJob,
      timeLimitSeconds: allocateAiPassSeconds(originalJob.timeLimitSeconds, remainingMs),
      ...(originalJob.inputCommands === undefined
        ? {}
        : { imageDataUrl: commandsToAiImageDataUrl(originalJob.inputCommands) })
    };
    emit("requesting", 0, 0, 0);
    const result = await executeOnce(
      record,
      session,
      job,
      Math.min(remainingMs, job.timeLimitSeconds * 1_000),
      () => emit("retrying", 0, 0, 0)
    );
    emit("validating", 0, 0, 0);
    emit("complete", 0, 0, 0);
    return result;
  }

  const observationLimit = plannedObservationLimit;
  let drawingPlan: AiDrawingPlan | undefined;
  if (record.profile.capabilities.drawingPlanMode === "separate") {
    const planRemainingMs = Math.max(5_000, deadline - Date.now());
    const planSeconds = allocateAiPlanSeconds(planRemainingMs, observationLimit + 2);
    const planJob: AiTurnJob = {
      ...originalJob,
      drawPhase: "plan",
      drawingPlan: undefined,
      sourceCommands: undefined,
      imageDataUrl: undefined,
      inputCommands: undefined,
      observationIndex: 0,
      observationLimit,
      timeLimitSeconds: planSeconds
    };
    emit("planning", 0, observationLimit, 0);
    const planResult = await executeOnce(
      record,
      session,
      planJob,
      Math.min(planRemainingMs, planSeconds * 1_000),
      () => emit("retrying", 0, observationLimit, 0)
    );
    const fallbackPlan = createFallbackAiTurnResult(planJob, "missing-plan").drawingPlan;
    drawingPlan = planResult.drawingPlan ?? fallbackPlan;
  }

  const accumulated: CanvasCommand[] = [];
  const accumulatedSource: AiCanvasSourceCommand[] = [];
  let sourceIds = new Map<string, string>();
  let finalResult: AiTurnResult | undefined;
  let lastAttemptedPass = 0;
  let observationFeedback = originalJob.validationFeedback;
  for (let pass = 0; pass <= observationLimit; pass += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 5_500) break;
    lastAttemptedPass = pass;
    const usedStrokes = accumulated.filter((command) => command.type === "stroke").length;
    const usedUndos = accumulated.filter((command) => command.type === "undo").length;
    const remainingPasses = observationLimit - pass + 1;
    const activeInputCommands = activeStrokeCommands(accumulated);
    const job: AiTurnJob = {
      ...originalJob,
      drawPhase: pass === 0 ? "render" : "inspect",
      drawingPlan,
      sourceCommands: compactAiCanvasSourceCommands(accumulatedSource),
      observationIndex: pass,
      observationLimit,
      validationFeedback: observationFeedback,
      timeLimitSeconds: allocateAiPassSeconds(
        originalJob.timeLimitSeconds,
        remainingMs,
        remainingPasses
      ),
      ...(pass === 0 ? {} : { imageDataUrl: commandsToAiImageDataUrl(activeInputCommands) }),
      inputCommands: activeInputCommands,
      budget: {
        ...originalJob.budget,
        remainingStrokes: Math.max(0, originalJob.budget.maxStrokes - usedStrokes),
        remainingUndos: Math.max(0, originalJob.budget.maxUndos - usedUndos)
      }
    };
    if (pass > 0) {
      options.onInspect?.();
      emit("inspecting", pass, observationLimit, usedStrokes);
    }
    let accepted:
      | {
          result: AiTurnResult;
          merged: ReturnType<typeof mergeAiDrawingPass>;
        }
      | undefined;
    let lastResult: AiTurnResult | undefined;
    let hadCanvasLimitFailure = false;
    let validationFeedback = job.validationFeedback;
    try {
      for (let attempt = 0; attempt < MAX_CANVAS_CANDIDATE_ATTEMPTS; attempt += 1) {
        const candidateRemainingMs = deadline - Date.now();
        if (candidateRemainingMs < 1_000) break;
        const candidateJob =
          validationFeedback === undefined ? job : { ...job, validationFeedback };
        emit(
          attempt > 0 ? "retrying" : pass === 0 ? "requesting" : "refining",
          pass,
          observationLimit,
          usedStrokes
        );
        const result = await executeOnce(
          record,
          session,
          candidateJob,
          Math.min(candidateRemainingMs, candidateJob.timeLimitSeconds * 1_000),
          () => emit("retrying", pass, observationLimit, usedStrokes)
        );
        lastResult = result;
        const merged = mergeAiDrawingPass(
          accumulated,
          result,
          `${originalJob.jobId}-p${pass}-a${attempt}`,
          pass,
          sourceIds
        );
        const validation = validateAiDrawingCandidate(
          merged.accumulated,
          {
            maxStrokes: originalJob.budget.maxStrokes,
            maxUndos: originalJob.budget.maxUndos,
            colorCount: originalJob.budget.colorCount,
            maxTotalPoints: 4096
          },
          `${originalJob.jobId}-p${pass}-a${attempt}`
        );
        const visible = validation.ok && hasVisibleCanvasContent(validation.commands);
        emit(
          "validating",
          pass,
          observationLimit,
          merged.accumulated.filter((command) => command.type === "stroke").length
        );

        if (validation.ok && visible) {
          accepted = { result, merged };
          break;
        }
        if (result.status === "fallback") break;
        hadCanvasLimitFailure = true;
        validationFeedback = canvasValidationFeedback(validation, visible);
      }
    } finally {
      if (pass > 0) options.onResume?.();
    }

    if (accepted === undefined) {
      if (lastResult !== undefined) finalResult = lastResult;
      if (hadCanvasLimitFailure && lastResult?.status !== "fallback") {
        if (pass > 0 && hasVisibleCanvasContent(accumulated)) {
          finalResult = createFallbackAiTurnResult(originalJob, "canvas-limits");
          break;
        }
        return createFallbackAiTurnResult(originalJob, "canvas-limits");
      }
      break;
    }
    const { result, merged } = accepted;
    if (merged.cleared) options.onClearCanvas?.();
    sourceIds = merged.ids;
    accumulated.splice(0, accumulated.length, ...merged.accumulated);
    const sourceBatch = sourceBatchForResult(result, merged.cleared);
    if (merged.cleared) accumulatedSource.splice(0, accumulatedSource.length);
    accumulatedSource.push(...sourceBatch);
    const compactedSource = compactAiCanvasSourceCommands(accumulatedSource);
    accumulatedSource.splice(0, accumulatedSource.length, ...compactedSource);
    observationFeedback = droppedCommandFeedback(result.formatWarnings);
    await options.onPreviewCommands?.(merged.batch, [...accumulated]);
    finalResult = result;
    if (result.status === "fallback") break;
  }

  if (finalResult === undefined) {
    finalResult = createFallbackAiTurnResult(originalJob, "timeout");
  }
  const finish: FinishCommand = {
    type: "finish",
    id: boundedCommandId(originalJob.jobId, "-finish"),
    offsetMs: Math.max(0, accumulated.length * 250)
  };
  accumulated.push(finish);
  const validation = validateCanvasCommands(
    accumulated,
    {
      maxStrokes: originalJob.budget.maxStrokes,
      maxUndos: originalJob.budget.maxUndos,
      colorCount: originalJob.budget.colorCount,
      maxTotalPoints: 4096
    },
    { requireFinish: true }
  );
  if (!validation.ok) return createFallbackAiTurnResult(originalJob, "canvas-limits");
  if (!hasVisibleCanvasContent(validation.commands)) {
    return createFallbackAiTurnResult(originalJob, finalResult.errorCode ?? "empty-drawing");
  }
  emit(
    "complete",
    lastAttemptedPass,
    observationLimit,
    validation.commands.filter((command) => command.type === "stroke").length
  );
  return AiTurnResultSchema.parse({
    ...finalResult,
    jobId: originalJob.jobId,
    commands: validation.commands,
    clearCanvas: undefined,
    guess: undefined,
    prompt: undefined,
    promptKind: undefined,
    review: undefined,
    drawingPlan: undefined,
    sourceCommands: undefined,
    formatWarnings: undefined
  });
}
