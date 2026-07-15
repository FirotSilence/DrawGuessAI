import { CanvasCommandSchema } from "@drawguessai/canvas-protocol";
import {
  GameLocaleSchema,
  POST_GAME_REVIEW_TEXT_LIMIT,
  PromptKindSchema,
  PromptMetadataSchema,
  PromptTopicSchema,
  QuickReactionSchema,
  TurnRoleSchema
} from "@drawguessai/game-core";
import { z } from "zod";

import { AiCanvasSourceCommandSchema } from "./shapes";

export const ProviderProtocolSchema = z.enum(["demo", "openai-compatible", "anthropic-compatible"]);
export const ExecutionModeSchema = z.enum(["local", "server"]);
export const ProviderAuthModeSchema = z.enum(["protocol-default", "bearer", "x-api-key"]);
export const StructuredOutputModeSchema = z.enum(["none", "json-object", "json-schema"]);
export const ModelRoleSchema = z.union([TurnRoleSchema, z.literal("prompt"), z.literal("review")]);
export const DrawPhaseSchema = z.enum(["plan", "render", "inspect"]);
export const ReviewRoleSchema = z.enum(["draw", "guess", "mixed"]);

export const AiPersonaCustomizationSchema = z
  .object({
    name: z.string().trim().min(1).max(24),
    description: z.string().trim().max(80),
    turnPrompt: z.string().trim().min(1).max(1_500),
    reviewPrompt: z.string().trim().min(1).max(1_500)
  })
  .strict();

export const AiReviewActorSchema = z
  .object({
    actorId: z.string().min(1).max(80),
    displayName: z.string().min(1).max(40),
    actorType: z.enum(["human", "ai"]).optional(),
    turns: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(11),
            role: TurnRoleSchema
          })
          .strict()
      )
      .min(1)
      .max(12)
  })
  .strict();

export const AiDrawingPlanSchema = z
  .object({
    summary: z.string().min(1).max(240),
    keyFeatures: z.array(z.string().min(1).max(80)).min(1).max(12),
    objects: z
      .array(
        z
          .object({
            id: z.string().min(1).max(60),
            label: z.string().min(1).max(80),
            bounds: z
              .object({
                x: z.number().min(0).max(1000),
                y: z.number().min(0).max(750),
                width: z.number().positive().max(1000),
                height: z.number().positive().max(750)
              })
              .strict(),
            features: z.array(z.string().min(1).max(80)).max(8)
          })
          .strict()
      )
      .min(1)
      .max(16),
    relationships: z.array(z.string().min(1).max(120)).max(16)
  })
  .strict();

export const ModelCapabilitiesSchema = z
  .object({
    vision: z.boolean(),
    structuredOutput: StructuredOutputModeSchema,
    observationMode: z.enum(["one-shot", "checkpoint"]),
    maxObservationPasses: z.number().int().min(0).max(2),
    drawingPlanMode: z.enum(["inline", "separate"]).optional(),
    reasoningMode: z.enum(["provider-default", "disabled"]).optional(),
    supportedRoles: z.array(ModelRoleSchema).min(1).max(4).optional()
  })
  .strict()
  .superRefine((capabilities, context) => {
    if (capabilities.observationMode === "checkpoint" && !capabilities.vision) {
      context.addIssue({
        code: "custom",
        path: ["observationMode"],
        message: "Checkpoint observation requires vision support"
      });
    }
    if (
      capabilities.maxObservationPasses > 0 &&
      (!capabilities.vision || capabilities.observationMode !== "checkpoint")
    ) {
      context.addIssue({
        code: "custom",
        path: ["maxObservationPasses"],
        message: "Positive observation limits require checkpoint vision support"
      });
    }
    if (capabilities.supportedRoles?.includes("guess") === true && !capabilities.vision) {
      context.addIssue({
        code: "custom",
        path: ["supportedRoles"],
        message: "A model that supports guessing must support vision"
      });
    }
  });

export type ModelRole = z.infer<typeof ModelRoleSchema>;
export type DrawPhase = z.infer<typeof DrawPhaseSchema>;
export type ReviewRole = z.infer<typeof ReviewRoleSchema>;
export type AiPersonaCustomization = z.infer<typeof AiPersonaCustomizationSchema>;
export type AiDrawingPlan = z.infer<typeof AiDrawingPlanSchema>;
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export function modelObservationPassLimit(capabilities: ModelCapabilities): number {
  return capabilities.vision && capabilities.observationMode === "checkpoint"
    ? capabilities.maxObservationPasses
    : 0;
}

export function observationPassLimitForRole(
  role: ModelRole,
  requestedPasses: number,
  capabilities: ModelCapabilities
): number {
  if (role !== "draw") return 0;
  return Math.min(Math.max(0, requestedPasses), modelObservationPassLimit(capabilities));
}

export function modelSupportsRole(capabilities: ModelCapabilities, role: ModelRole): boolean {
  if (capabilities.supportedRoles !== undefined) {
    return capabilities.supportedRoles.includes(role);
  }
  return role !== "guess" || capabilities.vision;
}

export const ModelProfileSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(40),
    protocol: ProviderProtocolSchema,
    authMode: ProviderAuthModeSchema.optional(),
    execution: ExecutionModeSchema,
    baseUrl: z
      .string()
      .url()
      .or(z.string().regex(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/)),
    model: z.string().min(1).max(120),
    capabilities: ModelCapabilitiesSchema,
    secretRef: z.string().min(1).max(120).optional(),
    enabled: z.boolean()
  })
  .strict();

export const ModelSecretSchema = z
  .object({
    secretRef: z.string().min(1).max(120),
    apiKey: z.string().min(1).max(4096)
  })
  .strict();

export const AiTurnBudgetSchema = z
  .object({
    maxStrokes: z.number().int().min(1).max(120),
    maxUndos: z.number().int().min(0).max(10),
    colorCount: z.number().int().min(4).max(12),
    remainingStrokes: z.number().int().min(0).max(120),
    remainingUndos: z.number().int().min(0).max(10)
  })
  .strict();

export const AiTurnJobSchema = z
  .object({
    jobId: z.string().min(1).max(100),
    roomId: z.string().min(1).max(100),
    turnIndex: z.number().int().min(-1).max(11),
    role: ModelRoleSchema,
    locale: GameLocaleSchema,
    personaId: z.string().min(1).max(60),
    personaCustomization: AiPersonaCustomizationSchema.optional(),
    actorId: z.string().min(1).max(80).optional(),
    reviewRole: ReviewRoleSchema.optional(),
    reviewActors: z.array(AiReviewActorSchema).min(2).max(12).optional(),
    inputText: z.string().max(6000).optional(),
    promptMetadata: PromptMetadataSchema.optional(),
    imageDataUrl: z.string().max(8_000_000).optional(),
    inputCommands: z.array(CanvasCommandSchema).max(132).optional(),
    drawPhase: DrawPhaseSchema.optional(),
    drawingPlan: AiDrawingPlanSchema.optional(),
    sourceCommands: z.array(AiCanvasSourceCommandSchema).max(132).optional(),
    validationFeedback: z.string().min(1).max(240).optional(),
    observationIndex: z.number().int().min(0).max(2),
    observationLimit: z.number().int().min(0).max(2),
    timeLimitSeconds: z.number().int().min(5).max(180),
    budget: AiTurnBudgetSchema
  })
  .strict();

export const AiReactionSchema = z
  .object({
    kind: QuickReactionSchema,
    text: z.string().min(1).max(80)
  })
  .strict();

export const AiSocialActionSchema = z
  .object({
    targetActorId: z.string().min(1).max(80),
    targetTurnIndex: z.number().int().min(0).max(11).optional(),
    kind: QuickReactionSchema,
    text: z.string().min(1).max(80)
  })
  .strict();

export const AiReviewSchema = z
  .object({
    text: z.string().min(1).max(POST_GAME_REVIEW_TEXT_LIMIT),
    score: z.number().int().min(1).max(5),
    replyToActorId: z.string().min(1).max(80).optional(),
    actions: z.array(AiSocialActionSchema).max(3).optional()
  })
  .strict();

export const AiTurnResultSchema = z
  .object({
    jobId: z.string().min(1).max(100),
    status: z.enum(["ok", "fallback"]),
    commands: z.array(CanvasCommandSchema).max(132).optional(),
    clearCanvas: z.boolean().optional(),
    guess: z.string().min(1).max(80).optional(),
    prompt: z.string().min(1).max(80).optional(),
    promptKind: PromptKindSchema.optional(),
    promptTopic: PromptTopicSchema.optional(),
    review: AiReviewSchema.optional(),
    drawingPlan: AiDrawingPlanSchema.optional(),
    sourceCommands: z.array(AiCanvasSourceCommandSchema).max(132).optional(),
    formatWarnings: z.array(z.string().min(1).max(160)).max(12).optional(),
    confidence: z.number().min(0).max(1),
    reaction: AiReactionSchema,
    errorCode: z.string().max(80).optional()
  })
  .strict()
  .superRefine((result, context) => {
    const outputs = [
      result.commands !== undefined,
      result.guess !== undefined,
      result.prompt !== undefined,
      result.review !== undefined,
      result.drawingPlan !== undefined
    ];
    if (outputs.filter(Boolean).length !== 1) {
      context.addIssue({ code: "custom", message: "Exactly one turn output is required" });
    }
    if (result.promptKind !== undefined && result.prompt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["promptKind"],
        message: "Prompt kind is only valid for prompt generation"
      });
    }
    if (result.promptTopic !== undefined && result.prompt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["promptTopic"],
        message: "Prompt topic is only valid for prompt generation"
      });
    }
    if (result.clearCanvas !== undefined && result.commands === undefined) {
      context.addIssue({
        code: "custom",
        path: ["clearCanvas"],
        message: "Canvas clearing is only valid for drawing output"
      });
    }
    if (result.sourceCommands !== undefined && result.commands === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sourceCommands"],
        message: "Source commands are only valid for drawing output"
      });
    }
    if (result.formatWarnings !== undefined && result.commands === undefined) {
      context.addIssue({
        code: "custom",
        path: ["formatWarnings"],
        message: "Format warnings are only valid for drawing output"
      });
    }
  });

export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;
export type ProviderAuthMode = z.infer<typeof ProviderAuthModeSchema>;
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type ModelSecret = z.infer<typeof ModelSecretSchema>;
export type AiTurnBudget = z.infer<typeof AiTurnBudgetSchema>;
export type AiReviewActor = z.infer<typeof AiReviewActorSchema>;
export type AiTurnJob = z.infer<typeof AiTurnJobSchema>;
export type AiReaction = z.infer<typeof AiReactionSchema>;
export type AiSocialAction = z.infer<typeof AiSocialActionSchema>;
export type AiReview = z.infer<typeof AiReviewSchema>;
export type AiTurnResult = z.infer<typeof AiTurnResultSchema>;
