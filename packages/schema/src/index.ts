import { z } from "zod";

export const ROUTE_NAMES = ["fast", "balanced", "hard", "deep"] as const;

export const ROUTES = {
  FAST: ROUTE_NAMES[0],
  BALANCED: ROUTE_NAMES[1],
  HARD: ROUTE_NAMES[2],
  DEEP: ROUTE_NAMES[3]
} as const;

export const SURFACE_NAMES = ["openai-responses", "anthropic-messages", "openai-chat"] as const;

export const SURFACES = {
  OPENAI_RESPONSES: SURFACE_NAMES[0],
  ANTHROPIC_MESSAGES: SURFACE_NAMES[1],
  OPENAI_CHAT: SURFACE_NAMES[2]
} as const;

export const DIALECT_NAMES = ["anthropic-messages", "openai-responses", "openai-chat"] as const;

export const DIALECTS = {
  ANTHROPIC_MESSAGES: DIALECT_NAMES[0],
  OPENAI_RESPONSES: DIALECT_NAMES[1],
  OPENAI_CHAT: DIALECT_NAMES[2]
} as const;

export const BUILTIN_PROVIDER_NAMES = ["openai", "anthropic"] as const;

export const PROVIDERS = {
  OPENAI: BUILTIN_PROVIDER_NAMES[0],
  ANTHROPIC: BUILTIN_PROVIDER_NAMES[1]
} as const;

export const PROVIDER_AUTH_STYLES = ["bearer", "x-api-key", "none"] as const;

export const PROVIDER_ACCOUNT_AUTH_TYPES = ["api_key", "oauth"] as const;

// Claude subscription tokens minted by `claude setup-token`. Anthropic has
// rotated token prefixes before — keep every prefix check on this constant.
export const CLAUDE_SUBSCRIPTION_TOKEN_PREFIX = "sk-ant-oat01-";

export const PROVIDER_ACCOUNT_STATUSES = {
  ACTIVE: "active",
  DISABLED: "disabled"
} as const;

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export const CLASSIFIER_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

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

// A usage ledger row is either the billed provider response for a request
// ("provider") or the routing classifier's own LLM call that decided where to
// send it ("classifier"). Classifier rows carry cost but no provider attempt.
export const USAGE_LEDGER_KINDS = ["provider", "classifier"] as const;

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

export const ROUTING_HINT_NAMES = [
  "quick",
  "deep",
  "security",
  "migration",
  "concurrency",
  "failing_test",
  "production"
] as const;

export type RoutingHintName = typeof ROUTING_HINT_NAMES[number];

const CLASSIFIER_PROMPT_BODY = [
  "You are the routing classifier for a coding-agent prompt proxy. Pick the cheapest route tier that is likely to complete the request correctly: fast, balanced, hard, or deep.",
  "Classify only. Never answer, attempt, or rewrite the task itself.",
  "",
  "You receive a JSON feature view of the request, not the raw prompt:",
  "- input_excerpt: redacted excerpt of the routing input (null when excerpts are disabled). Long inputs keep the start and end around a [...excerpt truncated...] marker; the user's ask is usually near the end.",
  `- extracted_hints: keyword signals found in the routing input (${ROUTING_HINT_NAMES.join(", ")}).`,
  "- input_chars / estimated_input_tokens: size of the routing input, normally the latest user message. Treat these plus input_excerpt and extracted_hints as the user's latest intent.",
  "- full_input_chars / full_estimated_input_tokens: size of the whole request envelope, including harness prompts and tool definitions. Use them for context and cost awareness only; never pick hard or deep solely because the envelope is large or tools are present.",
  "- has_tools / tool_count / has_images / has_previous_response_id: request shape signals.",
  "- requested_model: what the client asked for. Ignore it; route on task complexity only.",
  "",
  "Route tiers:",
  "- fast: trivial, read-only, or low-risk asks. Status checks like git status or ls, reading or listing files, single obvious shell commands, formatting-only changes, renames, typo and one-line fixes, explaining a small snippet, summarizing short output.",
  "- balanced: the default for ordinary coding with modest ambiguity. Small features, straightforward bug fixes, simple test additions, focused refactors, doc updates, explaining a module, reading a few files.",
  "- hard: difficult implementation or debugging where mistakes are costly. Multi-file edits, failing tests, migrations, API changes, auth or business-logic bugs, concurrency and performance issues, integration debugging, unclear root causes, incident investigation.",
  "- deep: durable technical decisions and the highest-stakes reasoning; set needs_deep_reasoning=true. System design, architecture planning and reviews, database/schema/storage design, event-driven architecture, provider abstractions, agent and prompt architecture, model-routing and cost-governance strategy, organization-wide data collection, prompt/session storage, analytics pipelines, privacy/security/compliance/retention/access-control design, large refactors, cross-system reasoning, and broad planning.",
  "",
  "Decision rules:",
  "- Classify the latest user intent, not the conversation as a whole.",
  "- Pick fast only when the task is obviously simple and low risk; a trivial ask stays fast even inside a large repo or session.",
  "- When the user explicitly asks to scope, design, review deeply, think hard, dig in, or figure out what is happening, choose deep.",
  "- When torn between two tiers, pick the lower one unless risk signals (security, auth, payments, production, data loss) push upward. Never pick a cheaper tier when it is likely to cause rework.",
  "- Set can_use_fast_model=false when a small-looking request still carries risk.",
  "- complexity is your difficulty estimate; risk lists the risk signals you detected as short snake_case tokens.",
  "- reason_codes are short snake_case tokens explaining the decision; confidence is your 0-1 estimate."
].join("\n");

const CLASSIFIER_OUTPUT_REMINDER = "Return only JSON matching the requested schema.";

export const ROUTING_CLASSIFIER_BASE_INSTRUCTIONS =
  `${CLASSIFIER_PROMPT_BODY}\n\n${CLASSIFIER_OUTPUT_REMINDER}`;

export function composeClassifierInstructions(rules?: string): string {
  const trimmed = rules?.trim();
  if (!trimmed) return ROUTING_CLASSIFIER_BASE_INSTRUCTIONS;
  return [
    CLASSIFIER_PROMPT_BODY,
    "",
    "Organization routing rules (override the defaults above when they conflict):",
    trimmed,
    "",
    CLASSIFIER_OUTPUT_REMINDER
  ].join("\n");
}

export type RouteName = typeof ROUTE_NAMES[number];
export type Surface = typeof SURFACE_NAMES[number];
export type Dialect = typeof DIALECT_NAMES[number];
export type BuiltinProvider = typeof BUILTIN_PROVIDER_NAMES[number];
export type Provider = string;
export type ProviderAuthStyle = typeof PROVIDER_AUTH_STYLES[number];
export type ProviderAccountAuthType = typeof PROVIDER_ACCOUNT_AUTH_TYPES[number];
export type ProviderAccountStatus = typeof PROVIDER_ACCOUNT_STATUSES[keyof typeof PROVIDER_ACCOUNT_STATUSES];
export type Effort = typeof EFFORTS[number];
export type Verbosity = typeof VERBOSITIES[number];
export type EventOutboxStatus = typeof EVENT_OUTBOX_STATUSES[keyof typeof EVENT_OUTBOX_STATUSES];
export type RequestStatus = typeof REQUEST_STATUSES[keyof typeof REQUEST_STATUSES];
export type ProviderAttemptStatus = typeof PROVIDER_ATTEMPT_STATUSES[keyof typeof PROVIDER_ATTEMPT_STATUSES];
export type UsageLedgerKind = typeof USAGE_LEDGER_KINDS[number];
export type PromptCaptureMode = typeof PROMPT_CAPTURE_MODES[keyof typeof PROMPT_CAPTURE_MODES];
export type OrganizationMemberRole = typeof ORGANIZATION_MEMBER_ROLES[keyof typeof ORGANIZATION_MEMBER_ROLES];
export type OrganizationMemberStatus = typeof ORGANIZATION_MEMBER_STATUSES[keyof typeof ORGANIZATION_MEMBER_STATUSES];
export type InvitationStatus = typeof INVITATION_STATUSES[keyof typeof INVITATION_STATUSES];

export function anthropicReasoningEffortsForModel(model: string): Effort[] {
  const id = model.toLowerCase();
  if (
    id.startsWith("claude-fable-5") ||
    id.startsWith("claude-mythos-5") ||
    id.startsWith("claude-mythos-preview") ||
    id.startsWith("claude-opus-4-8") ||
    id.startsWith("claude-opus-4-7")
  ) {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  if (id.startsWith("claude-opus-4-6") || id.startsWith("claude-sonnet-4-6")) {
    return ["low", "medium", "high", "max"];
  }
  if (id.startsWith("claude-opus-4-5")) return ["low", "medium", "high"];
  return [];
}

export function anthropicEffortForModel(model: string, requested: Effort) {
  const supported = anthropicReasoningEffortsForModel(model);
  if (supported.length === 0) return undefined;
  if (requested === "ultracode" && supported.includes("xhigh")) return "xhigh";
  return nearestAnthropicEffort(requested, supported);
}

export function supportsAnthropicAdaptiveThinking(model: string) {
  const id = model.toLowerCase();
  return (
    id.startsWith("claude-fable-5") ||
    id.startsWith("claude-mythos-5") ||
    id.startsWith("claude-mythos-preview") ||
    id.startsWith("claude-opus-4-8") ||
    id.startsWith("claude-opus-4-7") ||
    id.startsWith("claude-opus-4-6") ||
    id.startsWith("claude-sonnet-4-6")
  );
}

function nearestAnthropicEffort(requested: Effort, supported: readonly Effort[]) {
  if (supported.includes(requested)) return requested;
  const requestedIndex = EFFORTS.indexOf(requested);
  let closest: Effort | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const effort of supported) {
    const distance = Math.abs(EFFORTS.indexOf(effort) - requestedIndex);
    if (distance < bestDistance) {
      closest = effort;
      bestDistance = distance;
    }
  }
  return closest;
}

export {
  canTranslateDialect,
  TRANSLATABLE_DIALECT_PAIRS,
  TRANSLATION_COMPATIBILITY_DIALECTS,
  translationCompatibilityForDialects,
  type TranslationCompatibilityResult,
  type TranslationCompatibilityStatus,
  type TranslationDialect
} from "./translationCompatibility.js";

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
export const dialectSchema = z.enum(DIALECT_NAMES);
export const providerSchema = z.string().min(1, "Provider slug is required.").refine(
  (value) => value.trim().length > 0,
  { message: "Provider slug must contain non-whitespace text." }
).refine(
  (value) => value === value.trim(),
  { message: "Provider slug must not include leading or trailing whitespace." }
);
export const builtinProviderSchema = z.enum(BUILTIN_PROVIDER_NAMES);
export const providerAuthStyleSchema = z.enum(PROVIDER_AUTH_STYLES);
export const effortSchema = z.enum(EFFORTS);
export const classifierEffortSchema = z.enum(CLASSIFIER_EFFORTS);
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

export const providerRegistryEndpointSchema = z.strictObject({
  dialect: dialectSchema,
  path: routingConfigIdentifierSchema.refine((value) => value.startsWith("/"), {
    message: "Endpoint path must start with '/'."
  })
});

export const providerRegistryEntrySchema = z.strictObject({
  slug: providerSchema,
  base_url: z.string().url().refine((value) => value === value.trim(), {
    message: "Base URL must not include leading or trailing whitespace."
  }),
  auth_style: providerAuthStyleSchema,
  endpoints: z.array(providerRegistryEndpointSchema).min(1, "At least one endpoint is required."),
  default_headers: z.record(z.string(), routingConfigTextSchema),
  capabilities: jsonObjectSchema.optional(),
  forward_harness_headers: z.boolean(),
  enabled: z.boolean()
});

export const routingConfigClassifierSchema = z.strictObject({
  providerId: providerSchema,
  model: routingConfigIdentifierSchema,
  rules: routingConfigTextSchema.optional(),
  effort: classifierEffortSchema.optional(),
  timeoutMs: z.number().int().positive().max(30000),
  maxAttempts: z.number().int().positive().max(5),
  allowRedactedExcerpt: z.boolean(),
  structuredOutput: z.strictObject({
    mode: z.literal("json_schema"),
    schemaName: routingConfigIdentifierSchema.optional()
  })
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

export const routeTargetSchema = z.strictObject({
  providerId: providerSchema,
  model: routingConfigIdentifierSchema,
  effort: effortSchema.optional(),
  thinking: routingConfigAnthropicThinkingSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  verbosity: verbositySchema.optional(),
  metadata: jsonObjectSchema.optional()
});

export const routingConfigRouteSchema = z.strictObject({
  description: routingConfigTextSchema.optional(),
  targets: z.array(routeTargetSchema).min(1, "At least one route target is required.")
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
  schemaVersion: z.literal(2),
  displayName: routingConfigTextSchema,
  description: routingConfigTextSchema.optional(),
  classifier: routingConfigClassifierSchema,
  routes: routingConfigRoutesSchema,
  limits: routingConfigLimitsSchema,
  session: routingConfigSessionSchema
});

export type RoutingConfigClassifier = z.infer<typeof routingConfigClassifierSchema>;
export type RoutingConfigLimits = z.infer<typeof routingConfigLimitsSchema>;
export type RouteTarget = z.infer<typeof routeTargetSchema>;

export const sessionPinnedSettingsSchema = routeTargetSchema.extend({
  dialect: dialectSchema
});

export type SessionPinnedSettings = z.infer<typeof sessionPinnedSettingsSchema>;
export type RoutingConfigRoute = z.infer<typeof routingConfigRouteSchema>;
export type RoutingConfig = z.infer<typeof routingConfigSchema>;
