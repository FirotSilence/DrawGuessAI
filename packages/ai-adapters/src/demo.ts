import {
  MASTER_PALETTE,
  validateCanvasCommands,
  type CanvasCommand,
  type Point
} from "@drawguessai/canvas-protocol";

import { getPersona } from "./personas";
import { AiTurnResultSchema, type AiTurnJob, type AiTurnResult } from "./schema";

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function stroke(
  job: AiTurnJob,
  index: number,
  points: Point[],
  colorIndex = 0,
  width = 8,
  fillColorIndex?: number
): CanvasCommand {
  return {
    type: "stroke",
    id: `${job.jobId}-s${index}`,
    tool: "pen",
    color: MASTER_PALETTE[colorIndex % job.budget.colorCount]!,
    ...(fillColorIndex === undefined
      ? {}
      : {
          closed: true,
          fillColor: MASTER_PALETTE[fillColorIndex % job.budget.colorCount]!
        }),
    width: width === 4 || width === 8 || width === 16 || width === 28 ? width : 8,
    points,
    offsetMs: index * 280
  };
}

function circle(cx: number, cy: number, radius: number, steps = 18): Point[] {
  return Array.from({ length: steps }, (_, index) => {
    const angle = (Math.PI * 2 * index) / (steps - 1);
    return {
      x: Math.round(cx + Math.cos(angle) * radius),
      y: Math.round(cy + Math.sin(angle) * radius)
    };
  });
}

function demoDrawing(job: AiTurnJob): CanvasCommand[] {
  const variant = hash(`${job.inputText ?? "scene"}:${job.observationIndex}`) % 3;
  const commands: CanvasCommand[] = [];
  if (variant === 0) {
    commands.push(
      stroke(
        job,
        0,
        [
          { x: 230, y: 500 },
          { x: 500, y: 230 },
          { x: 770, y: 500 }
        ],
        2,
        16,
        2
      ),
      stroke(
        job,
        1,
        [
          { x: 300, y: 440 },
          { x: 300, y: 650 },
          { x: 700, y: 650 },
          { x: 700, y: 440 }
        ],
        0,
        16,
        7
      ),
      stroke(
        job,
        2,
        [
          { x: 455, y: 650 },
          { x: 455, y: 520 },
          { x: 545, y: 520 },
          { x: 545, y: 650 }
        ],
        7,
        8
      ),
      stroke(job, 3, circle(760, 170, 70), 4, 8)
    );
  } else if (variant === 1) {
    commands.push(
      stroke(job, 0, circle(500, 355, 190), 4, 16),
      stroke(job, 1, circle(435, 315, 22), 0, 8),
      stroke(job, 2, circle(565, 315, 22), 0, 8),
      stroke(
        job,
        3,
        [
          { x: 410, y: 430 },
          { x: 500, y: 485 },
          { x: 590, y: 430 }
        ],
        2,
        16
      ),
      stroke(
        job,
        4,
        [
          { x: 310, y: 165 },
          { x: 500, y: 95 },
          { x: 690, y: 165 }
        ],
        6,
        28
      )
    );
  } else {
    commands.push(
      stroke(
        job,
        0,
        [
          { x: 220, y: 520 },
          { x: 780, y: 520 },
          { x: 650, y: 635 },
          { x: 350, y: 635 },
          { x: 220, y: 520 }
        ],
        7,
        16
      ),
      stroke(
        job,
        1,
        [
          { x: 500, y: 520 },
          { x: 500, y: 190 },
          { x: 710, y: 430 },
          { x: 500, y: 430 }
        ],
        2,
        16
      ),
      stroke(
        job,
        2,
        [
          { x: 500, y: 215 },
          { x: 340, y: 420 },
          { x: 500, y: 420 }
        ],
        4,
        8
      ),
      stroke(job, 3, circle(810, 170, 52), 4, 8)
    );
  }
  const limited = commands.slice(0, job.budget.remainingStrokes);
  limited.push({ type: "finish", id: `${job.jobId}-finish`, offsetMs: limited.length * 280 });
  return limited;
}

function mutateGuess(input: string | undefined, locale: AiTurnJob["locale"]): string {
  if (input !== undefined && input.trim().length > 0) {
    const compact = input.trim().slice(0, 68);
    return locale === "zh-CN"
      ? `${compact}，但似乎出了点意外`
      : `${compact}, but something went wrong`;
  }
  return locale === "zh-CN" ? "一次非常可疑的公共活动" : "a suspicious public event";
}

export function createDemoTurnResult(job: AiTurnJob): AiTurnResult {
  const persona = getPersona(job.personaId);
  const reactionText = persona.fallback[job.locale];
  if (job.role === "draw" && job.drawPhase === "plan") {
    return AiTurnResultSchema.parse({
      jobId: job.jobId,
      status: "ok",
      drawingPlan: {
        summary: job.inputText ?? "a centered party-game sketch",
        keyFeatures: [job.inputText ?? "recognizable silhouette"],
        objects: [
          {
            id: "subject",
            label: job.inputText ?? "subject",
            bounds: { x: 170, y: 100, width: 660, height: 550 },
            features: ["large central outline"]
          }
        ],
        relationships: []
      },
      confidence: 0.82,
      reaction: { kind: "spark", text: reactionText }
    });
  }
  if (job.role === "draw") {
    const commands = demoDrawing(job);
    const validation = validateCanvasCommands(
      commands,
      {
        maxStrokes: Math.max(20, job.budget.maxStrokes),
        maxUndos: job.budget.maxUndos,
        colorCount: job.budget.colorCount,
        maxTotalPoints: 4096
      },
      { requireFinish: true }
    );
    if (!validation.ok) throw new Error("Built-in demo produced invalid canvas commands");
    return AiTurnResultSchema.parse({
      jobId: job.jobId,
      status: "ok",
      commands,
      sourceCommands: commands,
      clearCanvas: job.drawPhase === "inspect",
      confidence: 0.78,
      reaction: { kind: "spark", text: reactionText }
    });
  }
  if (job.role === "guess") {
    return AiTurnResultSchema.parse({
      jobId: job.jobId,
      status: "ok",
      guess: mutateGuess(job.inputText, job.locale),
      confidence: 0.54,
      reaction: { kind: "confused", text: reactionText }
    });
  }
  if (job.role === "review") {
    return AiTurnResultSchema.parse({
      jobId: job.jobId,
      status: "ok",
      review: { text: persona.reviewFallback[job.locale], score: 3 },
      confidence: 0.76,
      reaction: { kind: persona.reviewReaction, text: reactionText }
    });
  }
  return AiTurnResultSchema.parse({
    jobId: job.jobId,
    status: "ok",
    prompt: job.locale === "zh-CN" ? "雨中放风筝" : "flying a kite in the rain",
    promptKind: "phrase",
    promptTopic: "action",
    confidence: 0.9,
    reaction: { kind: "heart", text: reactionText }
  });
}
