import {
  BRUSH_WIDTHS,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  CanvasCommandSchema
} from "@drawguessai/canvas-protocol";
import { POST_GAME_REVIEW_TEXT_LIMIT } from "@drawguessai/game-core";
import { jsonrepair } from "jsonrepair";

import { AiTurnResultSchema, type AiTurnResult } from "./schema";
import {
  AiCanvasSourceCommandSchema,
  compileAiCanvasCommands,
  normalizeAiCanvasSourceCommands
} from "./shapes";

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function normalizeNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const candidate = value.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(candidate)) return value;
  const number = Number(candidate);
  return Number.isFinite(number) ? number : value;
}

function normalizeBoolean(value: unknown): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function normalizeStringLimit(value: unknown, maximum: number): unknown {
  return typeof value === "string" ? value.slice(0, maximum) : value;
}

const REACTION_KIND_ALIASES: Readonly<Record<string, string>> = {
  clap: "applause",
  praise: "applause",
  proud: "applause",
  thumbs_up: "applause",
  dislike: "egg",
  frustrated: "egg",
  thumbs_down: "egg",
  funny: "laugh",
  laughter: "laugh",
  unsure: "confused",
  uncertainty: "confused",
  confident: "spark",
  confidence: "spark",
  surprise: "spark",
  surprised: "spark",
  like: "heart",
  love: "heart"
};

function normalizeReactionKind(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, "_");
  if (["applause", "egg", "laugh", "confused", "spark", "heart"].includes(normalized)) {
    return normalized;
  }
  return REACTION_KIND_ALIASES[normalized] ?? value;
}

const PROMPT_KIND_ALIASES: Readonly<Record<string, string>> = {
  action: "phrase",
  scene: "phrase",
  sentence: "phrase",
  poem: "poem-line",
  poetry: "poem-line",
  poem_line: "poem-line",
  xie_hou_yu: "xiehouyu"
};

function normalizePromptKind(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, "_");
  return PROMPT_KIND_ALIASES[normalized] ?? value;
}

function normalizeBrushWidth(value: unknown): unknown {
  const normalized = normalizeNumber(value);
  if (typeof normalized !== "number" || !Number.isFinite(normalized)) return normalized;
  return BRUSH_WIDTHS.reduce((closest, width) =>
    Math.abs(width - normalized) < Math.abs(closest - normalized) ? width : closest
  );
}

function normalizeCoordinate(value: unknown, maximum: number): unknown {
  const normalized = normalizeNumber(value);
  return typeof normalized === "number" && Number.isFinite(normalized)
    ? Math.max(0, Math.min(maximum, Math.round(normalized)))
    : normalized;
}

function normalizePoint(point: unknown): unknown {
  if (Array.isArray(point) && point.length === 2) {
    return {
      x: normalizeCoordinate(point[0], CANVAS_WIDTH),
      y: normalizeCoordinate(point[1], CANVAS_HEIGHT)
    };
  }
  if (typeof point !== "object" || point === null) return point;
  const candidate = point as Record<string, unknown>;
  return {
    ...candidate,
    x: normalizeCoordinate(candidate.x, CANVAS_WIDTH),
    y: normalizeCoordinate(candidate.y, CANVAS_HEIGHT)
  };
}

function normalizeTransform(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const transform = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(transform).map(([key, item]) => [key, normalizeNumber(item)])
  );
}

function normalizeWidthProfile(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const profile = value as Record<string, unknown>;
  return {
    startScale: normalizeNumber(profile.startScale ?? profile.start),
    peakScale: normalizeNumber(
      profile.peakScale ?? profile.middleScale ?? profile.middle ?? profile.peak
    ),
    endScale: normalizeNumber(profile.endScale ?? profile.end),
    peakAt: normalizeNumber(profile.peakAt ?? 0.5)
  };
}

function normalizeDrawingPlan(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const plan = value as Record<string, unknown>;
  return {
    ...plan,
    ...(Array.isArray(plan.objects)
      ? {
          objects: (plan.objects as unknown[]).map((item: unknown) => {
            if (typeof item !== "object" || item === null) return item;
            const object = item as Record<string, unknown>;
            const bounds =
              typeof object.bounds === "object" && object.bounds !== null
                ? (object.bounds as Record<string, unknown>)
                : undefined;
            return {
              ...object,
              ...(bounds === undefined
                ? {}
                : {
                    bounds: {
                      ...bounds,
                      x: normalizeNumber(bounds.x),
                      y: normalizeNumber(bounds.y),
                      width: normalizeNumber(bounds.width),
                      height: normalizeNumber(bounds.height)
                    }
                  })
            };
          })
        }
      : {})
  };
}

function normalizeStyle(candidate: Record<string, unknown>, providerTool: unknown) {
  const widthProfile =
    candidate.widthProfile ?? candidate.strokeProfile ?? candidate.pressureProfile;
  return {
    id: candidate.id,
    tool: providerTool === "eraser" ? "eraser" : "pen",
    color: typeof candidate.color === "string" ? candidate.color.toLowerCase() : "#202124",
    ...(typeof candidate.fillColor === "string"
      ? { fillColor: candidate.fillColor.toLowerCase() }
      : {}),
    width: normalizeBrushWidth(candidate.strokeWidth ?? candidate.width ?? 8),
    ...(widthProfile === undefined ? {} : { widthProfile: normalizeWidthProfile(widthProfile) }),
    ...(candidate.transform === undefined
      ? {}
      : { transform: normalizeTransform(candidate.transform) }),
    offsetMs: normalizeNumber(candidate.offsetMs ?? 0)
  };
}

function normalizePathSegment(segment: unknown): unknown {
  if (typeof segment !== "object" || segment === null) return segment;
  const candidate = segment as Record<string, unknown>;
  const rawKind = candidate.kind ?? candidate.type;
  const kind =
    rawKind === "line" || rawKind === "quadratic" || rawKind === "cubic"
      ? rawKind
      : candidate.control1 !== undefined && candidate.control2 !== undefined
        ? "cubic"
        : candidate.control !== undefined
          ? "quadratic"
          : rawKind === undefined
            ? "line"
            : undefined;
  const to = candidate.to ?? candidate.end;
  if (kind === undefined || to === undefined) return segment;
  if (kind === "line") {
    return { kind, to: normalizePoint(to) };
  }
  if (kind === "quadratic") {
    const control = candidate.control ?? candidate.controlPoint;
    return control === undefined
      ? segment
      : { kind, control: normalizePoint(control), to: normalizePoint(to) };
  }
  const control1 = candidate.control1 ?? candidate.controlPoint1;
  const control2 = candidate.control2 ?? candidate.controlPoint2;
  return control1 === undefined || control2 === undefined
    ? segment
    : {
        kind,
        control1: normalizePoint(control1),
        control2: normalizePoint(control2),
        to: normalizePoint(to)
      };
}

function normalizeProviderCommand(command: unknown): unknown {
  if (typeof command !== "object" || command === null) return command;
  const candidate = command as Record<string, unknown>;
  if (
    candidate.type === "stroke" &&
    typeof candidate.id === "string" &&
    /^(?:end|fin|finish|done)$/i.test(candidate.id) &&
    candidate.tool === undefined &&
    candidate.color === undefined &&
    candidate.width === undefined &&
    candidate.points === undefined
  ) {
    return {
      type: "finish",
      id: candidate.id,
      offsetMs: normalizeNumber(candidate.offsetMs)
    };
  }
  if (candidate.type === "undo" || candidate.type === "finish") {
    return candidate.type === "undo"
      ? {
          type: "undo",
          id: candidate.id,
          targetId: candidate.targetId,
          offsetMs: normalizeNumber(candidate.offsetMs ?? 0)
        }
      : {
          type: "finish",
          id: candidate.id,
          offsetMs: normalizeNumber(candidate.offsetMs ?? 0)
        };
  }

  const vectorTypes = [
    "line",
    "polyline",
    "polygon",
    "rect",
    "circle",
    "ellipse",
    "arc",
    "curve",
    "path"
  ] as const;
  const shapeAlias =
    typeof candidate.shape === "string" &&
    vectorTypes.includes(candidate.shape as (typeof vectorTypes)[number])
      ? candidate.shape
      : undefined;
  const toolAsShape =
    candidate.type === "stroke" &&
    typeof candidate.tool === "string" &&
    vectorTypes.includes(candidate.tool as (typeof vectorTypes)[number]);
  const inferredType =
    Array.isArray(candidate.segments) && candidate.start !== undefined
      ? "path"
      : candidate.start !== undefined &&
          candidate.control1 !== undefined &&
          candidate.control2 !== undefined &&
          candidate.end !== undefined
        ? "curve"
        : candidate.start !== undefined && candidate.end !== undefined
          ? "line"
          : candidate.radius !== undefined
            ? "circle"
            : candidate.rx !== undefined &&
                candidate.ry !== undefined &&
                candidate.startDeg !== undefined &&
                candidate.endDeg !== undefined
              ? "arc"
              : candidate.rx !== undefined && candidate.ry !== undefined
                ? "ellipse"
                : Array.isArray(candidate.points)
                  ? "stroke"
                  : undefined;
  const rawProviderType =
    shapeAlias ?? (toolAsShape ? candidate.tool : candidate.type) ?? inferredType;
  const providerType = rawProviderType === "rectangle" ? "rect" : rawProviderType;
  const providerTool = toolAsShape ? candidate.tool2 : candidate.tool;
  const style = normalizeStyle(candidate, providerTool);

  if (providerType === "stroke" || (providerType === "rect" && Array.isArray(candidate.points))) {
    return {
      type: "stroke",
      ...style,
      ...(candidate.closed === undefined ? {} : { closed: normalizeBoolean(candidate.closed) }),
      points: Array.isArray(candidate.points)
        ? candidate.points.map(normalizePoint)
        : candidate.points
    };
  }
  if (providerType === "line") {
    return {
      type: "line",
      ...style,
      start: normalizePoint(candidate.start),
      end: normalizePoint(candidate.end)
    };
  }
  if (providerType === "polyline" || providerType === "polygon") {
    return {
      type: providerType,
      ...style,
      points: Array.isArray(candidate.points)
        ? candidate.points.map(normalizePoint)
        : candidate.points,
      ...(providerType === "polygon" ? { fill: normalizeBoolean(candidate.fill ?? true) } : {})
    };
  }
  if (providerType === "rect") {
    return {
      type: "rect",
      ...style,
      x: normalizeNumber(candidate.x),
      y: normalizeNumber(candidate.y),
      rectWidth: normalizeNumber(
        candidate.rectWidth ?? candidate.w ?? candidate.widthPx ?? candidate.width
      ),
      rectHeight: normalizeNumber(
        candidate.rectHeight ?? candidate.h ?? candidate.heightPx ?? candidate.height
      ),
      cornerRadius: normalizeNumber(candidate.cornerRadius ?? candidate.radius ?? 0),
      fill: normalizeBoolean(candidate.fill ?? candidate.fillColor !== undefined)
    };
  }

  const number = (key: string, fallback?: unknown) => normalizeNumber(candidate[key] ?? fallback);
  const radius = number("radius", candidate.rx ?? candidate.ry);
  if (providerType === "circle") {
    return {
      type: "circle",
      ...style,
      cx: number("cx"),
      cy: number("cy"),
      radius,
      fill: normalizeBoolean(candidate.fill ?? candidate.fillColor !== undefined)
    };
  }
  if (providerType === "ellipse") {
    return {
      type: "ellipse",
      ...style,
      cx: number("cx"),
      cy: number("cy"),
      rx: number("rx", radius),
      ry: number("ry", radius),
      rotationDeg: number("rotationDeg", 0),
      fill: normalizeBoolean(candidate.fill ?? candidate.fillColor !== undefined)
    };
  }
  if (providerType === "arc") {
    return {
      type: "arc",
      ...style,
      cx: number("cx"),
      cy: number("cy"),
      rx: number("rx", radius),
      ry: number("ry", radius),
      startDeg: number("startDeg"),
      endDeg: number("endDeg"),
      rotationDeg: number("rotationDeg", 0)
    };
  }
  if (providerType === "curve") {
    return {
      type: "curve",
      ...style,
      start: normalizePoint(candidate.start),
      control1: normalizePoint(candidate.control1),
      control2: normalizePoint(candidate.control2),
      end: normalizePoint(candidate.end)
    };
  }
  if (providerType === "path") {
    return {
      type: "path",
      ...style,
      start: normalizePoint(candidate.start),
      segments: Array.isArray(candidate.segments)
        ? candidate.segments.map(normalizePathSegment)
        : candidate.segments,
      closed: normalizeBoolean(candidate.closed ?? false),
      fill: normalizeBoolean(
        candidate.fill ?? (candidate.fillColor !== undefined && candidate.closed === true)
      )
    };
  }
  return command;
}

function normalizeProviderResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const providerRecord = { ...record };
  delete providerRecord.formatWarnings;
  delete providerRecord.sourceCommands;
  const review =
    typeof record.review === "object" && record.review !== null
      ? (record.review as Record<string, unknown>)
      : undefined;
  const normalizedReview =
    review === undefined
      ? undefined
      : (() => {
          const {
            replyToPersonaId: personaReplyAlias,
            replyToSeatId: seatReplyAlias,
            ...currentReview
          } = review;
          const replyToActorId = review.replyToActorId ?? seatReplyAlias ?? personaReplyAlias;
          return { currentReview, replyToActorId };
        })();
  const reaction =
    typeof record.reaction === "object" && record.reaction !== null
      ? (record.reaction as Record<string, unknown>)
      : undefined;
  const normalizedSources = Array.isArray(record.commands)
    ? normalizeAiCanvasSourceCommands(record.commands.map(normalizeProviderCommand))
    : undefined;
  const formatWarnings: string[] = [];
  const validEntries = normalizedSources?.flatMap((command, index) => {
    const candidate =
      typeof command === "object" && command !== null
        ? (command as Record<string, unknown>)
        : undefined;
    const marker = [
      `commands[${index}]`,
      typeof candidate?.id === "string" ? `id=${JSON.stringify(candidate.id)}` : undefined,
      typeof candidate?.type === "string" ? `type=${JSON.stringify(candidate.type)}` : undefined
    ]
      .filter((part) => part !== undefined)
      .join(" ");
    const source = AiCanvasSourceCommandSchema.safeParse(command);
    if (!source.success) {
      const detail = source.error.issues
        .slice(0, 2)
        .map((issue) => `${issue.path.join(".") || "command"}: ${issue.message}`)
        .join("; ");
      formatWarnings.push(`${marker} skipped: ${detail}`.slice(0, 160));
      return [];
    }
    const compiled = compileAiCanvasCommands([source.data])[0];
    const canvas = CanvasCommandSchema.safeParse(compiled);
    if (!canvas.success) {
      const detail = canvas.error.issues
        .slice(0, 2)
        .map((issue) => `${issue.path.join(".") || "command"}: ${issue.message}`)
        .join("; ");
      formatWarnings.push(`${marker} skipped after compilation: ${detail}`.slice(0, 160));
      return [];
    }
    return [{ source: source.data, canvas: canvas.data }];
  });
  const validSources = validEntries?.map((entry) => entry.source);
  const compiledCommands = validEntries?.map((entry) => entry.canvas);

  return {
    ...providerRecord,
    confidence: normalizeNumber(record.confidence),
    clearCanvas: normalizeBoolean(record.clearCanvas),
    guess: normalizeStringLimit(record.guess, 80),
    prompt: normalizeStringLimit(record.prompt, 80),
    promptKind: normalizePromptKind(record.promptKind),
    drawingPlan: normalizeDrawingPlan(record.drawingPlan),
    ...(reaction === undefined
      ? {}
      : {
          reaction: {
            ...reaction,
            kind: normalizeReactionKind(reaction.kind),
            text: normalizeStringLimit(reaction.text, 80)
          }
        }),
    ...(review === undefined || normalizedReview === undefined
      ? {}
      : {
          review: {
            ...normalizedReview.currentReview,
            text: normalizeStringLimit(review.text, POST_GAME_REVIEW_TEXT_LIMIT),
            score: normalizeNumber(review.score),
            ...(normalizedReview.replyToActorId === undefined
              ? {}
              : {
                  replyToActorId: normalizeStringLimit(normalizedReview.replyToActorId, 80)
                }),
            ...(Array.isArray(review.actions)
              ? {
                  actions: (review.actions as unknown[]).map((action: unknown) => {
                    if (typeof action !== "object" || action === null) return action;
                    const candidate = action as Record<string, unknown>;
                    const {
                      targetSeatId: targetSeatAlias,
                      reaction: reactionAlias,
                      ...normalizedAction
                    } = candidate;
                    return {
                      ...normalizedAction,
                      targetActorId: candidate.targetActorId ?? targetSeatAlias,
                      ...(candidate.targetTurnIndex === undefined
                        ? {}
                        : { targetTurnIndex: normalizeNumber(candidate.targetTurnIndex) }),
                      kind: normalizeReactionKind(candidate.kind ?? reactionAlias),
                      text: normalizeStringLimit(candidate.text, 80)
                    };
                  })
                }
              : {})
          }
        }),
    ...(compiledCommands === undefined
      ? {}
      : {
          commands: compiledCommands,
          sourceCommands: validSources,
          ...(formatWarnings.length === 0 ? {} : { formatWarnings: formatWarnings.slice(0, 12) })
        })
  };
}

export function parseAiTurnResult(text: string, expectedJobId: string): AiTurnResult {
  const repaired = jsonrepair(extractJson(text));
  const parsed: unknown = JSON.parse(repaired);
  const result = AiTurnResultSchema.parse(normalizeProviderResult(parsed));
  if (result.jobId !== expectedJobId) {
    throw new Error("AI response jobId does not match the active job");
  }
  return result;
}
