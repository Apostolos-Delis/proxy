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

export const DIALECT_NAMES = ["anthropic-messages", "openai-responses", "openai-chat", "bedrock-converse"] as const;
export const HTTP_PROVIDER_DIALECT_NAMES = ["anthropic-messages", "openai-responses", "openai-chat"] as const;

export const DIALECTS = {
  ANTHROPIC_MESSAGES: DIALECT_NAMES[0],
  OPENAI_RESPONSES: DIALECT_NAMES[1],
  OPENAI_CHAT: DIALECT_NAMES[2],
  BEDROCK_CONVERSE: DIALECT_NAMES[3]
} as const;

export const BUILTIN_PROVIDER_NAMES = ["openai", "anthropic", "amazon-bedrock"] as const;

export const PROVIDERS = {
  OPENAI: BUILTIN_PROVIDER_NAMES[0],
  ANTHROPIC: BUILTIN_PROVIDER_NAMES[1],
  BEDROCK: BUILTIN_PROVIDER_NAMES[2]
} as const;

export const PROVIDER_AUTH_STYLES = ["bearer", "x-api-key", "none", "aws-sdk"] as const;
export const PROVIDER_ADAPTER_KINDS = ["generic-http-json", "aws-bedrock-converse"] as const;
export const BEDROCK_PROVIDER_OPERATIONS = ["Converse", "ConverseStream"] as const;
export const MODEL_CATALOG_SOURCES = ["models.dev-snapshot", "models.dev-refresh", "env", "manual", "bedrock-discovery"] as const;

export const PROVIDER_ACCOUNT_AUTH_TYPES = ["api_key", "oauth"] as const;

export const PROVIDER_CACHE_TTLS = ["5m", "1h", "24h"] as const;
export const PROVIDER_CACHE_KEY_FIELDS = ["prompt_cache_key", "routing_key"] as const;
export const PROVIDER_CACHE_RETENTION_FIELDS = ["prompt_cache_retention"] as const;
export const PROVIDER_CACHE_USAGE_SHAPES = ["openai", "anthropic", "gemini", "provider_specific"] as const;
export const PROMPT_CACHE_PREWARM_JOB_STATUSES = [
  "planned",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired_unused"
] as const;
export const PROMPT_CACHE_PREWARM_TRIGGER_SOURCES = [
  "route_config_publish",
  "session_resume",
  "workspace_bootstrap",
  "manual"
] as const;

// Claude subscription tokens minted by `claude setup-token`. Anthropic has
// rotated token prefixes before — keep every prefix check on this constant.
export const CLAUDE_SUBSCRIPTION_TOKEN_PREFIX = "sk-ant-oat01-";

export const PROVIDER_ACCOUNT_STATUSES = {
  ACTIVE: "active",
  DISABLED: "disabled"
} as const;

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export const OPENAI_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
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

export const PROVIDER_HEALTH_ERROR_TYPES = [
  "auth_invalid",
  "auth_expired",
  "rate_limited",
  "quota_exhausted",
  "provider_unavailable",
  "model_unavailable",
  "model_access_denied",
  "context_overflow",
  "request_incompatible",
  "stream_failed",
  "stream_disconnected",
  "unknown_transient",
  "unknown_terminal"
] as const;

export const PROVIDER_HEALTH_STATUSES = [
  "healthy",
  "cooldown",
  "locked_out",
  "terminal",
  "unknown"
] as const;

export const PROVIDER_HEALTH_CLASSIFICATION_SOURCES = [
  "provider_status",
  "provider_header",
  "response_body",
  "stream_observer",
  "proxy_policy"
] as const;

export const PROVIDER_HEALTH_CONFIDENCES = [
  "exact",
  "heuristic",
  "unknown"
] as const;

export const PROVIDER_HEALTH_SCOPES = [
  "provider",
  "provider_account",
  "provider_model",
  "provider_account_model",
  "request_only"
] as const;

export const PROVIDER_HEALTH_MESSAGE_MAX_CHARS = 500;
export const PROVIDER_HEALTH_METADATA_MAX_KEYS = 25;
export const PROVIDER_HEALTH_METADATA_STRING_MAX_CHARS = 500;

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

export const COMPRESSION_POLICY_MODES = [
  "disabled",
  "measure_only",
  "compress_lossless",
  "compress_explicit_lossy"
] as const;

export const COMPRESSION_RULE_IDS = [
  "search-result-grouping",
  "diff-compaction",
  "log-output-compaction",
  "json-array-compaction",
  "mcp-json-whitespace",
  "json-whitespace",
  "bash-output-noise",
  "shell-command-lossy-summary"
] as const;

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
  "You are the routing classifier for a coding-agent proxy. Pick the cheapest route tier that is likely to complete the request correctly: fast, balanced, hard, or deep.",
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
export type HttpProviderDialect = typeof HTTP_PROVIDER_DIALECT_NAMES[number];
export type BuiltinProvider = typeof BUILTIN_PROVIDER_NAMES[number];
export type Provider = string;
export type ProviderAuthStyle = typeof PROVIDER_AUTH_STYLES[number];
export type ProviderAdapterKind = typeof PROVIDER_ADAPTER_KINDS[number];
export type BedrockProviderOperation = typeof BEDROCK_PROVIDER_OPERATIONS[number];
export type ModelCatalogSource = typeof MODEL_CATALOG_SOURCES[number];
export type ProviderAccountAuthType = typeof PROVIDER_ACCOUNT_AUTH_TYPES[number];
export type ProviderAccountStatus = typeof PROVIDER_ACCOUNT_STATUSES[keyof typeof PROVIDER_ACCOUNT_STATUSES];
export type ProviderCacheTtl = typeof PROVIDER_CACHE_TTLS[number];
export type ProviderCacheKeyField = typeof PROVIDER_CACHE_KEY_FIELDS[number];
export type ProviderCacheRetentionField = typeof PROVIDER_CACHE_RETENTION_FIELDS[number];
export type ProviderCacheUsageShape = typeof PROVIDER_CACHE_USAGE_SHAPES[number];
export type PromptCachePrewarmJobStatus = typeof PROMPT_CACHE_PREWARM_JOB_STATUSES[number];
export type PromptCachePrewarmTriggerSource = typeof PROMPT_CACHE_PREWARM_TRIGGER_SOURCES[number];
export type Effort = typeof EFFORTS[number];
export type OpenAIReasoningEffort = typeof OPENAI_REASONING_EFFORTS[number];
export type Verbosity = typeof VERBOSITIES[number];
export type EventOutboxStatus = typeof EVENT_OUTBOX_STATUSES[keyof typeof EVENT_OUTBOX_STATUSES];
export type RequestStatus = typeof REQUEST_STATUSES[keyof typeof REQUEST_STATUSES];
export type ProviderAttemptStatus = typeof PROVIDER_ATTEMPT_STATUSES[keyof typeof PROVIDER_ATTEMPT_STATUSES];
export type ProviderHealthErrorType = typeof PROVIDER_HEALTH_ERROR_TYPES[number];
export type ProviderHealthStatus = typeof PROVIDER_HEALTH_STATUSES[number];
export type ProviderHealthClassificationSource = typeof PROVIDER_HEALTH_CLASSIFICATION_SOURCES[number];
export type ProviderHealthConfidence = typeof PROVIDER_HEALTH_CONFIDENCES[number];
export type ProviderHealthScope = typeof PROVIDER_HEALTH_SCOPES[number];
export type UsageLedgerKind = typeof USAGE_LEDGER_KINDS[number];
export type PromptCaptureMode = typeof PROMPT_CAPTURE_MODES[keyof typeof PROMPT_CAPTURE_MODES];
export type CompressionPolicyMode = typeof COMPRESSION_POLICY_MODES[number];
export type CompressionRuleId = typeof COMPRESSION_RULE_IDS[number];
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
  HARNESS_COMPATIBILITY_PROFILE_IDS,
  harnessCompatibilityForTarget,
  harnessCompatibilityMatrix,
  TRANSLATABLE_DIALECT_PAIRS,
  TRANSLATION_COMPATIBILITY_DIALECTS,
  translationCompatibilityForDialects,
  type HarnessCompatibilityProfile,
  type HarnessCompatibilityProfileId,
  type HarnessCompatibilityResult,
  type TranslationCompatibilityResult,
  type TranslationCompatibilityReason,
  type TranslationCompatibilityStatus,
  type TranslationDialect,
  type TranslationPair
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
export const httpProviderDialectSchema = z.enum(HTTP_PROVIDER_DIALECT_NAMES);
export const providerSchema = z.string().min(1, "Provider slug is required.").refine(
  (value) => value.trim().length > 0,
  { message: "Provider slug must contain non-whitespace text." }
).refine(
  (value) => value === value.trim(),
  { message: "Provider slug must not include leading or trailing whitespace." }
);
export const builtinProviderSchema = z.enum(BUILTIN_PROVIDER_NAMES);
export const providerAuthStyleSchema = z.enum(PROVIDER_AUTH_STYLES);
export const providerAdapterKindSchema = z.enum(PROVIDER_ADAPTER_KINDS);
export const bedrockProviderOperationSchema = z.enum(BEDROCK_PROVIDER_OPERATIONS);
export const providerCacheTtlSchema = z.enum(PROVIDER_CACHE_TTLS);
export const providerCacheKeyFieldSchema = z.enum(PROVIDER_CACHE_KEY_FIELDS);
export const providerCacheRetentionFieldSchema = z.enum(PROVIDER_CACHE_RETENTION_FIELDS);
export const providerCacheUsageShapeSchema = z.enum(PROVIDER_CACHE_USAGE_SHAPES);
export const effortSchema = z.enum(EFFORTS);
export const openAIReasoningEffortSchema = z.enum(OPENAI_REASONING_EFFORTS);
export const classifierEffortSchema = z.enum(CLASSIFIER_EFFORTS);
export const verbositySchema = z.enum(VERBOSITIES);
export const providerHealthErrorTypeSchema = z.enum(PROVIDER_HEALTH_ERROR_TYPES);
export const providerHealthStatusSchema = z.enum(PROVIDER_HEALTH_STATUSES);
export const providerHealthClassificationSourceSchema = z.enum(PROVIDER_HEALTH_CLASSIFICATION_SOURCES);
export const providerHealthConfidenceSchema = z.enum(PROVIDER_HEALTH_CONFIDENCES);
export const providerHealthScopeSchema = z.enum(PROVIDER_HEALTH_SCOPES);
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

export const providerCachingCapabilitiesSchema = z.strictObject({
  implicitPrefixCaching: z.boolean(),
  explicitBreakpoints: z.boolean(),
  supportedTtls: z.array(providerCacheTtlSchema),
  cacheKeyField: providerCacheKeyFieldSchema.optional(),
  retentionField: providerCacheRetentionFieldSchema.optional(),
  prewarm: z.boolean(),
  usageShape: providerCacheUsageShapeSchema
});

export type ProviderCachingCapabilities = z.infer<typeof providerCachingCapabilitiesSchema>;

export const promptCachePrewarmJobStatusSchema = z.enum(PROMPT_CACHE_PREWARM_JOB_STATUSES);
export const promptCachePrewarmTriggerSourceSchema = z.enum(PROMPT_CACHE_PREWARM_TRIGGER_SOURCES);

export const promptCachePrewarmSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  maxDailySpendMicros: z.number().int().nonnegative(),
  maxHourlyJobs: z.number().int().nonnegative(),
  maxInputTokensPerJob: z.number().int().positive(),
  providerAllowlist: z.array(providerSchema),
  modelAllowlist: z.array(z.string().trim().min(1))
});

export type PromptCachePrewarmSettings = z.infer<typeof promptCachePrewarmSettingsSchema>;

export const promptCachePrewarmJobSchema = z.strictObject({
  id: z.string().trim().min(1),
  organizationId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  provider: providerSchema,
  model: z.string().trim().min(1),
  triggerSource: promptCachePrewarmTriggerSourceSchema,
  status: promptCachePrewarmJobStatusSchema,
  idempotencyKey: z.string().trim().min(1),
  prefixDigest: z.string().trim().min(1),
  routingConfigVersionId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  scheduledFor: z.string().datetime(),
  expiresAt: z.string().datetime(),
  estimatedInputTokens: z.number().int().nonnegative(),
  spendCapMicros: z.number().int().nonnegative(),
  estimatedCostMicros: z.number().int().nonnegative(),
  actualCostMicros: z.number().int().nonnegative().optional(),
  providerCacheRef: z.string().trim().min(1).optional(),
  metadata: jsonObjectSchema.default({})
}).refine((job) => Date.parse(job.expiresAt) > Date.parse(job.scheduledFor), {
  path: ["expiresAt"],
  message: "Prewarm expiration must be after the scheduled time."
});

export type PromptCachePrewarmJob = z.infer<typeof promptCachePrewarmJobSchema>;

export const CONSERVATIVE_PROVIDER_CACHING_CAPABILITIES = {
  implicitPrefixCaching: false,
  explicitBreakpoints: false,
  supportedTtls: [],
  prewarm: false,
  usageShape: "provider_specific"
} satisfies ProviderCachingCapabilities;

export const OPENAI_PROVIDER_CACHING_CAPABILITIES = {
  implicitPrefixCaching: true,
  explicitBreakpoints: false,
  supportedTtls: ["24h"],
  cacheKeyField: "prompt_cache_key",
  retentionField: "prompt_cache_retention",
  prewarm: false,
  usageShape: "openai"
} satisfies ProviderCachingCapabilities;

export const ANTHROPIC_PROVIDER_CACHING_CAPABILITIES = {
  implicitPrefixCaching: false,
  explicitBreakpoints: true,
  supportedTtls: ["5m", "1h"],
  prewarm: true,
  usageShape: "anthropic"
} satisfies ProviderCachingCapabilities;

export const GEMINI_PROVIDER_CACHING_CAPABILITIES = {
  implicitPrefixCaching: true,
  explicitBreakpoints: false,
  supportedTtls: [],
  prewarm: false,
  usageShape: "gemini"
} satisfies ProviderCachingCapabilities;

export function builtinProviderCachingCapabilities(provider: Provider): ProviderCachingCapabilities {
  if (provider === PROVIDERS.OPENAI) return OPENAI_PROVIDER_CACHING_CAPABILITIES;
  if (provider === PROVIDERS.ANTHROPIC) return ANTHROPIC_PROVIDER_CACHING_CAPABILITIES;
  return CONSERVATIVE_PROVIDER_CACHING_CAPABILITIES;
}

export const providerCapabilitiesSchema = z.object({
  efforts: z.array(effortSchema).optional(),
  promptCaching: providerCachingCapabilitiesSchema.optional()
}).catchall(jsonValueSchema);

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export function providerCapabilitiesWithDefaults(
  provider: Provider,
  capabilities: Record<string, unknown> = {}
): ProviderCapabilities {
  const parsed = providerCapabilitiesSchema.safeParse(capabilities);
  const safeCapabilities = parsed.success ? parsed.data : {};
  return {
    ...safeCapabilities,
    promptCaching: safeCapabilities.promptCaching ?? builtinProviderCachingCapabilities(provider)
  };
}

export const compressionPolicySchema = z.strictObject({
  mode: z.enum(COMPRESSION_POLICY_MODES),
  minOriginalBytes: z.number().int().positive().optional(),
  minSavingsTokens: z.number().int().nonnegative().optional(),
  enabledRules: z.array(z.enum(COMPRESSION_RULE_IDS)).optional(),
  storeOriginalArtifact: z.boolean().optional(),
  storeCompressedArtifact: z.boolean().optional()
});

export type CompressionPolicy = z.infer<typeof compressionPolicySchema>;

export function defaultCompressionPolicy(): CompressionPolicy {
  return {
    mode: "disabled",
    minOriginalBytes: 512,
    minSavingsTokens: 0,
    enabledRules: [...COMPRESSION_RULE_IDS],
    storeOriginalArtifact: false,
    storeCompressedArtifact: false
  };
}

export const providerHealthMetadataValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string().max(PROVIDER_HEALTH_METADATA_STRING_MAX_CHARS)
]);

export const providerHealthMetadataSchema = z.record(
  z.string().min(1),
  providerHealthMetadataValueSchema
).refine((value) => Object.keys(value).length <= PROVIDER_HEALTH_METADATA_MAX_KEYS, {
  message: `Provider health metadata must have ${PROVIDER_HEALTH_METADATA_MAX_KEYS} keys or fewer.`
});

export const providerHealthClassificationSchema = z.strictObject({
  errorType: providerHealthErrorTypeSchema,
  source: providerHealthClassificationSourceSchema,
  confidence: providerHealthConfidenceSchema,
  retryable: z.boolean(),
  scope: providerHealthScopeSchema,
  cooldownUntil: z.string().datetime({ offset: true }).nullable(),
  message: z.string().max(PROVIDER_HEALTH_MESSAGE_MAX_CHARS).nullable(),
  metadata: providerHealthMetadataSchema.default({})
});

export type ProviderHealthMetadataValue = z.infer<typeof providerHealthMetadataValueSchema>;
export type ProviderHealthMetadata = z.infer<typeof providerHealthMetadataSchema>;
export type ProviderHealthClassification = z.infer<typeof providerHealthClassificationSchema>;

export const providerRegistryHttpEndpointSchema = z.strictObject({
  dialect: httpProviderDialectSchema,
  path: routingConfigIdentifierSchema.refine((value) => value.startsWith("/"), {
    message: "Endpoint path must start with '/'."
  })
});

export const providerRegistryBedrockEndpointSchema = z.strictObject({
  dialect: z.literal("bedrock-converse"),
  operation: bedrockProviderOperationSchema
});

export const providerRegistryEndpointSchema = z.union([
  providerRegistryHttpEndpointSchema,
  providerRegistryBedrockEndpointSchema
]);

export type ProviderRegistryHttpEndpoint = z.infer<typeof providerRegistryHttpEndpointSchema>;
export type ProviderRegistryBedrockEndpoint = z.infer<typeof providerRegistryBedrockEndpointSchema>;
export type ProviderRegistryEndpoint = z.infer<typeof providerRegistryEndpointSchema>;

export const providerRegistryEntrySchema = z.strictObject({
  slug: providerSchema,
  base_url: z.string().url().refine((value) => value === value.trim(), {
    message: "Base URL must not include leading or trailing whitespace."
  }),
  adapter_kind: providerAdapterKindSchema.default("generic-http-json"),
  adapter_config: jsonObjectSchema.default({}),
  auth_style: providerAuthStyleSchema,
  endpoints: z.array(providerRegistryEndpointSchema).min(1, "At least one endpoint is required."),
  default_headers: z.record(z.string(), routingConfigTextSchema),
  capabilities: providerCapabilitiesSchema.optional(),
  forward_harness_headers: z.boolean(),
  enabled: z.boolean()
}).superRefine((entry, ctx) => {
  if (entry.adapter_kind === "generic-http-json" && entry.auth_style === "aws-sdk") {
    ctx.addIssue({
      code: "custom",
      path: ["auth_style"],
      message: "aws-sdk auth requires the aws-bedrock-converse adapter."
    });
  }
  if (entry.adapter_kind === "aws-bedrock-converse" && entry.auth_style !== "aws-sdk") {
    ctx.addIssue({
      code: "custom",
      path: ["auth_style"],
      message: "Bedrock providers must use aws-sdk auth."
    });
  }
  entry.endpoints.forEach((endpoint, index) => {
    if (entry.adapter_kind === "generic-http-json" && "operation" in endpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["endpoints", index, "operation"],
        message: "Generic HTTP providers must use path endpoints."
      });
    }
    if (entry.adapter_kind === "aws-bedrock-converse" && "path" in endpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["endpoints", index, "path"],
        message: "Bedrock providers must use operation endpoints."
      });
    }
  });
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

const deploymentBaseSchema = z.strictObject({
  model: routingConfigIdentifierSchema,
  baseUrl: z.string().url().optional(),
  providerAccountId: routingConfigIdentifierSchema.optional(),
  order: z.number().int().min(0).max(10000),
  weight: z.number().int().min(0).max(100000),
  timeoutMs: z.number().int().positive().max(600000)
});

export const routingConfigOpenAIDeploymentSchema = deploymentBaseSchema.extend({
  provider: providerSchema,
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

export const routingConfigOpenAIRouteSchema = z.strictObject({
  deployments: z.array(routingConfigOpenAIDeploymentSchema).min(1)
}).superRefine(validateDeploymentWeights);

export const routingConfigAnthropicThinkingSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("disabled")
  }),
  z.strictObject({
    type: z.literal("adaptive"),
    display: z.enum(ANTHROPIC_THINKING_DISPLAYS).optional()
  })
]);

export const routingConfigAnthropicDeploymentSchema = deploymentBaseSchema.extend({
  provider: providerSchema,
  model: routingConfigIdentifierSchema,
  thinking: routingConfigAnthropicThinkingSchema.optional(),
  output_config: z.strictObject({
    effort: effortSchema
  }).optional(),
  maxTokens: z.number().int().positive().optional(),
  metadata: jsonObjectSchema.optional()
});

export const routingConfigAnthropicRouteSchema = z.strictObject({
  deployments: z.array(routingConfigAnthropicDeploymentSchema).min(1)
}).superRefine(validateDeploymentWeights);

export const routingConfigRetryPolicySchema = z.strictObject({
  maxAttempts: z.number().int().positive().max(5),
  retryableStatusCodes: z.array(z.number().int().min(400).max(599)).min(1).max(20)
});

export const routingConfigRouteSchema = z.strictObject({
  description: routingConfigTextSchema.optional(),
  retry: routingConfigRetryPolicySchema,
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
  schemaVersion: z.literal(3),
  displayName: routingConfigTextSchema,
  description: routingConfigTextSchema.optional(),
  classifier: routingConfigClassifierSchema,
  routes: routingConfigRoutesSchema,
  limits: routingConfigLimitsSchema,
  session: routingConfigSessionSchema
});

export type RoutingConfigClassifier = z.infer<typeof routingConfigClassifierSchema>;
export type RoutingConfigOpenAIDeployment = z.infer<typeof routingConfigOpenAIDeploymentSchema>;
export type RoutingConfigAnthropicDeployment = z.infer<typeof routingConfigAnthropicDeploymentSchema>;
export type RoutingConfigOpenAIRoute = z.infer<typeof routingConfigOpenAIRouteSchema>;
export type RoutingConfigAnthropicRoute = z.infer<typeof routingConfigAnthropicRouteSchema>;
export type RoutingConfigRetryPolicy = z.infer<typeof routingConfigRetryPolicySchema>;
export type RoutingConfigLimits = z.infer<typeof routingConfigLimitsSchema>;

export const selectedDeploymentSchema = z.strictObject({
  key: routingConfigTextSchema,
  provider: providerSchema,
  model: routingConfigIdentifierSchema,
  baseUrl: z.string().url().optional(),
  providerAccountId: routingConfigIdentifierSchema.optional(),
  order: z.number().int().min(0).max(10000),
  weight: z.number().int().min(0).max(100000),
  timeoutMs: z.number().int().positive().max(600000)
});

export const sessionPinnedSettingsSchema = z.union([
  z.strictObject({
    provider: providerSchema,
    model: routingConfigIdentifierSchema,
    dialect: dialectSchema,
    deployment: selectedDeploymentSchema,
    openai: routingConfigOpenAIDeploymentSchema
  }),
  z.strictObject({
    provider: providerSchema,
    model: routingConfigIdentifierSchema,
    dialect: dialectSchema,
    deployment: selectedDeploymentSchema,
    anthropic: routingConfigAnthropicDeploymentSchema
  })
]);

export type SelectedDeployment = z.infer<typeof selectedDeploymentSchema>;
export type SessionPinnedSettings = z.infer<typeof sessionPinnedSettingsSchema>;
export type RoutingConfigRoute = z.infer<typeof routingConfigRouteSchema>;
export type RoutingConfig = z.infer<typeof routingConfigSchema>;

export const ROUTE_EXECUTION_PLAN_SCHEMA_VERSION = 1;

export const ROUTE_CLASSIFIER_DATA_MODES = ["metadata", "redacted_excerpt", "raw_excerpt"] as const;

export const ROUTE_SKIP_REASONS = [
  "target_unavailable_translator_missing",
  "target_unavailable_previous_response_id",
  "target_unavailable_stateful_websocket",
  "target_unavailable_stateful_translation",
  "target_unavailable_encrypted_reasoning",
  "target_unavailable_signed_reasoning",
  "target_unavailable_bedrock_settings",
  "target_unavailable_tool_capability",
  "target_unavailable_image_capability",
  "target_unavailable_streaming_capability",
  "target_unavailable_model_capability",
  "target_unavailable_provider_adapter",
  "target_unavailable_dialect",
  "target_unavailable_provider_not_found",
  "target_unavailable_provider_registry",
  "target_skipped_provider_disabled",
  "target_skipped_account_cooldown",
  "target_skipped_model_lockout",
  "target_skipped_budget_limit",
  "target_skipped_rate_limit",
  "target_skipped_missing_credential"
] as const;

export const ROUTE_POLICY_RESULT_STATUSES = ["allowed", "blocked", "skipped", "unknown"] as const;

export type RouteSkipReason = typeof ROUTE_SKIP_REASONS[number];

const compatibilityReasonToSkipReason: Record<string, RouteSkipReason> = {
  translator_unavailable: "target_unavailable_translator_missing",
  previous_response_translation_unavailable: "target_unavailable_previous_response_id",
  websocket_native_only: "target_unavailable_stateful_websocket",
  stateful_translation_unavailable: "target_unavailable_stateful_translation",
  encrypted_reasoning_unavailable: "target_unavailable_encrypted_reasoning",
  signed_reasoning_unavailable: "target_unavailable_signed_reasoning",
  bedrock_settings_on_non_bedrock_target: "target_unavailable_bedrock_settings",
  tool_capability_unavailable: "target_unavailable_tool_capability",
  image_capability_unavailable: "target_unavailable_image_capability",
  streaming_capability_unavailable: "target_unavailable_streaming_capability",
  model_capability: "target_unavailable_model_capability",
  provider_adapter_unavailable: "target_unavailable_provider_adapter",
  dialect_unavailable: "target_unavailable_dialect",
  provider_not_found: "target_unavailable_provider_not_found",
  provider_registry_unavailable: "target_unavailable_provider_registry",
  provider_disabled: "target_skipped_provider_disabled",
  provider_credential_unresolved: "target_skipped_missing_credential"
};

export function routeSkipReasonForCompatibilityReason(reason: string | undefined) {
  if (!reason) return undefined;
  return compatibilityReasonToSkipReason[reason];
}

export const routeClassifierDataModeSchema = z.enum(ROUTE_CLASSIFIER_DATA_MODES);
export const routeSkipReasonSchema = z.enum(ROUTE_SKIP_REASONS);
export const routePolicyResultStatusSchema = z.enum(ROUTE_POLICY_RESULT_STATUSES);

export const routeExecutionClassifierSchema = z.strictObject({
  provider: providerSchema,
  model: routingConfigIdentifierSchema,
  route: routeNameSchema,
  confidence: z.number().min(0).max(1).nullable(),
  attempts: z.number().int().nonnegative(),
  dataMode: routeClassifierDataModeSchema
});

export const routeExecutionRoutingConfigSchema = z.strictObject({
  id: routingConfigIdentifierSchema,
  versionId: routingConfigIdentifierSchema,
  version: z.number().int().positive(),
  hash: routingConfigIdentifierSchema
});

export const routeCandidateFactorsSchema = z.strictObject({
  nativeDialect: z.boolean(),
  capabilityMatch: z.boolean(),
  contextWindowOk: z.boolean().nullable(),
  providerHealthy: z.boolean().nullable(),
  accountAvailable: z.boolean().nullable(),
  budgetAllowed: z.boolean().nullable(),
  rateLimitAllowed: z.boolean().nullable(),
  sessionAffinityMatch: z.boolean().nullable()
});

export const routeCandidateEvaluationSchema = z.strictObject({
  id: routingConfigIdentifierSchema,
  order: z.number().int().nonnegative(),
  providerId: providerSchema,
  providerAccountIds: z.array(routingConfigIdentifierSchema),
  model: routingConfigIdentifierSchema,
  endpointDialect: dialectSchema,
  translated: z.boolean(),
  translatorId: routingConfigIdentifierSchema.nullable(),
  compatible: z.boolean(),
  eligible: z.boolean(),
  skipReasons: z.array(routeSkipReasonSchema),
  factors: routeCandidateFactorsSchema
});

export const routeSelectedTargetSchema = z.strictObject({
  candidateId: routingConfigIdentifierSchema,
  providerId: providerSchema,
  providerAccountId: routingConfigIdentifierSchema.nullable(),
  model: routingConfigIdentifierSchema,
  dialect: dialectSchema,
  translated: z.boolean()
});

export const routePolicyResultSchema = z.strictObject({
  id: routingConfigIdentifierSchema.optional(),
  policy: routingConfigIdentifierSchema,
  status: routePolicyResultStatusSchema,
  skipReason: routeSkipReasonSchema.nullable(),
  current: z.union([z.number(), z.string()]).nullable().optional(),
  limit: z.union([z.number(), z.string()]).nullable().optional()
});

export const routeExecutionPlanSchema = z.strictObject({
  schemaVersion: z.literal(ROUTE_EXECUTION_PLAN_SCHEMA_VERSION),
  requestId: routingConfigIdentifierSchema,
  organizationId: routingConfigIdentifierSchema,
  workspaceId: routingConfigIdentifierSchema,
  apiKeyId: routingConfigIdentifierSchema,
  surface: surfaceSchema,
  dialect: dialectSchema,
  classifier: routeExecutionClassifierSchema,
  routingConfig: routeExecutionRoutingConfigSchema,
  candidates: z.array(routeCandidateEvaluationSchema).min(1, "At least one route candidate is required."),
  selected: routeSelectedTargetSchema.nullable(),
  policyResults: z.array(routePolicyResultSchema)
}).superRefine((plan, context) => {
  const candidatesById = new Map<string, RouteCandidateEvaluation>();
  for (const [index, candidate] of plan.candidates.entries()) {
    if (candidatesById.has(candidate.id)) {
      context.addIssue({
        code: "custom",
        message: "Candidate ids must be unique.",
        path: ["candidates", index, "id"]
      });
    }
    candidatesById.set(candidate.id, candidate);
  }
  if (plan.selected) {
    const candidate = candidatesById.get(plan.selected.candidateId);
    if (!candidate) {
      context.addIssue({
        code: "custom",
        message: "Selected candidate must reference a planned candidate.",
        path: ["selected", "candidateId"]
      });
      return;
    }
    if (plan.selected.providerId !== candidate.providerId) {
      context.addIssue({
        code: "custom",
        message: "Selected provider must match the planned candidate.",
        path: ["selected", "providerId"]
      });
    }
    if (plan.selected.model !== candidate.model) {
      context.addIssue({
        code: "custom",
        message: "Selected model must match the planned candidate.",
        path: ["selected", "model"]
      });
    }
    if (plan.selected.dialect !== candidate.endpointDialect) {
      context.addIssue({
        code: "custom",
        message: "Selected dialect must match the planned candidate.",
        path: ["selected", "dialect"]
      });
    }
    if (plan.selected.translated !== candidate.translated) {
      context.addIssue({
        code: "custom",
        message: "Selected translation flag must match the planned candidate.",
        path: ["selected", "translated"]
      });
    }
    if (plan.selected.providerAccountId && !candidate.providerAccountIds.includes(plan.selected.providerAccountId)) {
      context.addIssue({
        code: "custom",
        message: "Selected provider account must be one of the planned candidate accounts.",
        path: ["selected", "providerAccountId"]
      });
    }
  }
});

export type RouteClassifierDataMode = typeof ROUTE_CLASSIFIER_DATA_MODES[number];
export type RoutePolicyResultStatus = typeof ROUTE_POLICY_RESULT_STATUSES[number];
export type RouteExecutionClassifier = z.infer<typeof routeExecutionClassifierSchema>;
export type RouteExecutionRoutingConfig = z.infer<typeof routeExecutionRoutingConfigSchema>;
export type RouteCandidateFactors = z.infer<typeof routeCandidateFactorsSchema>;
export type RouteCandidateEvaluation = z.infer<typeof routeCandidateEvaluationSchema>;
export type RouteSelectedTarget = z.infer<typeof routeSelectedTargetSchema>;
export type RoutePolicyResult = z.infer<typeof routePolicyResultSchema>;
export type RouteExecutionPlan = z.infer<typeof routeExecutionPlanSchema>;

function validateDeploymentWeights(
  route: { deployments: Array<{ order: number; weight: number }> },
  context: z.RefinementCtx
) {
  const orders = new Map<number, number>();
  for (const deployment of route.deployments) {
    orders.set(deployment.order, (orders.get(deployment.order) ?? 0) + deployment.weight);
  }
  for (const [order, weight] of orders) {
    if (weight > 0) continue;
    context.addIssue({
      code: "custom",
      message: "At least one deployment per order group must have positive weight.",
      path: ["deployments", route.deployments.findIndex((deployment) => deployment.order === order), "weight"]
    });
  }
}
