import { z } from "zod";

export const ROUTE_NAMES = ["fast", "balanced", "hard", "deep"] as const;

export const ROUTES = {
  FAST: ROUTE_NAMES[0],
  BALANCED: ROUTE_NAMES[1],
  HARD: ROUTE_NAMES[2],
  DEEP: ROUTE_NAMES[3]
} as const;

export const SURFACE_NAMES = ["openai-responses", "anthropic-messages"] as const;

export const SURFACES = {
  OPENAI_RESPONSES: SURFACE_NAMES[0],
  ANTHROPIC_MESSAGES: SURFACE_NAMES[1]
} as const;

export const PROVIDER_NAMES = ["openai", "anthropic"] as const;

export const PROVIDERS = {
  OPENAI: PROVIDER_NAMES[0],
  ANTHROPIC: PROVIDER_NAMES[1]
} as const;

export const OPENAI_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const VERBOSITIES = ["low", "medium", "high"] as const;

export const ANTHROPIC_THINKING_DISPLAYS = ["summarized", "omitted"] as const;

export const EVENT_OUTBOX_STATUSES = {
  QUEUED: "queued",
  PROCESSING: "processing",
  SUCCEEDED: "succeeded",
  FAILED: "failed"
} as const;

export const REQUEST_STATUSES = {
  RECEIVED: "received",
  CLASSIFYING: "classifying",
  PROVIDER_PENDING: "provider_pending",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
} as const;

export const PROVIDER_ATTEMPT_STATUSES = {
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
} as const;

export const PROMPT_CAPTURE_MODES = {
  NONE: "none",
  HASH_ONLY: "hash_only",
  RAW_TEXT: "raw_text",
  REDACTED: "redacted",
  ENCRYPTED_RAW: "encrypted_raw"
} as const;

export const ORGANIZATION_MEMBER_ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
  VIEWER: "viewer"
} as const;

export const ORGANIZATION_MEMBER_STATUSES = {
  ACTIVE: "active",
  DEACTIVATED: "deactivated"
} as const;

export const INVITATION_STATUSES = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REVOKED: "revoked"
} as const;

export const DEFAULT_ROUTING_CLASSIFIER_INSTRUCTIONS = [
  "Classify the coding-agent request.",
  "Use input_* and extracted_hints as the latest user intent.",
  "full_input_* is envelope size for context/cost only; do not choose hard or deep solely because the envelope is large or tools are present.",
  "Simple status/list/format/read-only shell requests should route fast.",
  "System design, architecture planning, architecture reviews, database/schema/storage design, event-driven architecture, provider abstractions, organization-wide data collection, prompt/session storage, analytics pipelines, privacy/security/compliance/retention/access-control design, and cost-governance strategy must route deep with needs_deep_reasoning=true.",
  "Return only JSON matching the requested schema."
].join(" ");

export type RouteName = typeof ROUTE_NAMES[number];
export type Surface = typeof SURFACE_NAMES[number];
export type Provider = typeof PROVIDER_NAMES[number];
export type OpenAIReasoningEffort = typeof OPENAI_REASONING_EFFORTS[number];
export type AnthropicEffort = typeof ANTHROPIC_EFFORTS[number];
export type Verbosity = typeof VERBOSITIES[number];
export type EventOutboxStatus = typeof EVENT_OUTBOX_STATUSES[keyof typeof EVENT_OUTBOX_STATUSES];
export type RequestStatus = typeof REQUEST_STATUSES[keyof typeof REQUEST_STATUSES];
export type ProviderAttemptStatus = typeof PROVIDER_ATTEMPT_STATUSES[keyof typeof PROVIDER_ATTEMPT_STATUSES];
export type PromptCaptureMode = typeof PROMPT_CAPTURE_MODES[keyof typeof PROMPT_CAPTURE_MODES];
export type OrganizationMemberRole = typeof ORGANIZATION_MEMBER_ROLES[keyof typeof ORGANIZATION_MEMBER_ROLES];
export type OrganizationMemberStatus = typeof ORGANIZATION_MEMBER_STATUSES[keyof typeof ORGANIZATION_MEMBER_STATUSES];
export type InvitationStatus = typeof INVITATION_STATUSES[keyof typeof INVITATION_STATUSES];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export const routeNameSchema = z.enum(ROUTE_NAMES);
export const surfaceSchema = z.enum(SURFACE_NAMES);
export const providerSchema = z.enum(PROVIDER_NAMES);
export const openAIReasoningEffortSchema = z.enum(OPENAI_REASONING_EFFORTS);
export const anthropicEffortSchema = z.enum(ANTHROPIC_EFFORTS);
export const verbositySchema = z.enum(VERBOSITIES);
export const routingConfigTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Must contain non-whitespace text."
});
export const routingConfigIdentifierSchema = routingConfigTextSchema.refine((value) => value === value.trim(), {
  message: "Must not include leading or trailing whitespace."
});

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema)
]));

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export const routingConfigClassifierSchema = z.strictObject({
  provider: providerSchema,
  model: routingConfigIdentifierSchema,
  instructions: routingConfigTextSchema,
  timeoutMs: z.number().int().positive().max(30000),
  maxAttempts: z.number().int().positive().max(5),
  allowRedactedExcerpt: z.boolean(),
  structuredOutput: z.strictObject({
    mode: z.literal("json_schema"),
    schemaName: routingConfigIdentifierSchema.optional()
  })
});

export const routingConfigOpenAIRouteSchema = z.strictObject({
  model: routingConfigIdentifierSchema,
  reasoning: z.strictObject({
    effort: openAIReasoningEffortSchema
  }).optional(),
  text: z.strictObject({
    verbosity: verbositySchema
  }).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  metadata: jsonObjectSchema.optional()
});

export const routingConfigAnthropicThinkingSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("disabled")
  }),
  z.strictObject({
    type: z.literal("adaptive"),
    display: z.enum(ANTHROPIC_THINKING_DISPLAYS).optional()
  })
]);

export const routingConfigAnthropicRouteSchema = z.strictObject({
  model: routingConfigIdentifierSchema,
  thinking: routingConfigAnthropicThinkingSchema.optional(),
  output_config: z.strictObject({
    effort: anthropicEffortSchema
  }).optional(),
  maxTokens: z.number().int().positive().optional(),
  metadata: jsonObjectSchema.optional()
});

export const routingConfigRouteSchema = z.strictObject({
  description: routingConfigTextSchema.optional(),
  openai: routingConfigOpenAIRouteSchema.optional(),
  anthropic: routingConfigAnthropicRouteSchema.optional()
}).superRefine((route, context) => {
  if (!route.openai && !route.anthropic) {
    context.addIssue({
      code: "custom",
      message: "At least one provider block is required.",
      path: ["openai"]
    });
  }
});

export const routingConfigRoutesSchema = z.strictObject({
  fast: routingConfigRouteSchema,
  balanced: routingConfigRouteSchema,
  hard: routingConfigRouteSchema,
  deep: routingConfigRouteSchema
});

const routeRanks: Record<RouteName, number> = {
  fast: 0,
  balanced: 1,
  hard: 2,
  deep: 3
};

export const routingConfigLimitsSchema = z.strictObject({
  maxRoute: routeNameSchema,
  fallbackRoute: routeNameSchema,
  maxEstimatedInputTokens: z.number().int().positive().optional(),
  routeEstimatedInputLimits: z.partialRecord(routeNameSchema, z.number().int().positive()).optional()
}).superRefine((limits, context) => {
  if (routeRanks[limits.fallbackRoute] > routeRanks[limits.maxRoute]) {
    context.addIssue({
      code: "custom",
      message: "fallbackRoute cannot exceed maxRoute.",
      path: ["fallbackRoute"]
    });
  }
});

export const routingConfigSessionSchema = z.strictObject({
  pinInitialRoute: z.boolean(),
  allowUpgrade: z.boolean(),
  allowDowngrade: z.boolean()
});

export const routingConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  displayName: routingConfigTextSchema,
  description: routingConfigTextSchema.optional(),
  classifier: routingConfigClassifierSchema,
  routes: routingConfigRoutesSchema,
  limits: routingConfigLimitsSchema,
  session: routingConfigSessionSchema
});

export type RoutingConfigClassifier = z.infer<typeof routingConfigClassifierSchema>;
export type RoutingConfigOpenAIRoute = z.infer<typeof routingConfigOpenAIRouteSchema>;
export type RoutingConfigAnthropicRoute = z.infer<typeof routingConfigAnthropicRouteSchema>;
export type RoutingConfigRoute = z.infer<typeof routingConfigRouteSchema>;
export type RoutingConfig = z.infer<typeof routingConfigSchema>;
