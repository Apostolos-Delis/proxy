import { z } from "zod";

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

export const GATEWAY_OPERATION_IDS = ["text.generate", "text.count_tokens", "model.list"] as const;
export const GATEWAY_PARAMETER_CAP_IDS = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;
export const GATEWAY_ACCESS_PROFILE_LIMIT_IDS = ["concurrent_requests", "requests_per_minute", "tokens_per_minute"] as const;
export const GATEWAY_RESOURCE_STATUSES = ["active", "disabled"] as const;
export const LOGICAL_MODEL_RESOLUTION_KINDS = ["direct", "router"] as const;
export const LOGICAL_MODEL_ROUTER_KINDS = ["classifier"] as const;
export const GATEWAY_SETUP_MODEL_PREFERENCE = ["coding-auto", "economy-auto", "fable"] as const;

export const BUILTIN_PROVIDER_NAMES = ["openai", "anthropic", "amazon-bedrock"] as const;

export const PROVIDERS = {
  OPENAI: BUILTIN_PROVIDER_NAMES[0],
  ANTHROPIC: BUILTIN_PROVIDER_NAMES[1],
  BEDROCK: BUILTIN_PROVIDER_NAMES[2]
} as const;

export const PROVIDER_AUTH_STYLES = ["bearer", "x-api-key", "none", "aws-sdk"] as const;
export const PROVIDER_ADAPTER_KINDS = ["generic-http-json", "aws-bedrock-converse"] as const;
export const PROVIDER_ADAPTER_CONTRACT_VERSIONS = ["1"] as const;
export const BEDROCK_PROVIDER_OPERATIONS = ["Converse", "ConverseStream"] as const;

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
  "session_resume",
  "workspace_bootstrap",
  "manual"
] as const;

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export const OPENAI_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

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
  "provider_connection",
  "deployment",
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

export const CLASSIFICATION_HINT_NAMES = [
  "quick",
  "architecture",
  "security",
  "migration",
  "concurrency",
  "failing_test",
  "production"
] as const;

export type ClassificationHintName = typeof CLASSIFICATION_HINT_NAMES[number];
export type Surface = typeof SURFACE_NAMES[number];
export type Dialect = typeof DIALECT_NAMES[number];
export type GatewayOperationId = typeof GATEWAY_OPERATION_IDS[number];
export type GatewayParameterCapId = typeof GATEWAY_PARAMETER_CAP_IDS[number];
export type GatewayAccessProfileLimitId = typeof GATEWAY_ACCESS_PROFILE_LIMIT_IDS[number];
export type GatewayResourceStatus = typeof GATEWAY_RESOURCE_STATUSES[number];
export type LogicalModelResolutionKind = typeof LOGICAL_MODEL_RESOLUTION_KINDS[number];
export type LogicalModelRouterKind = typeof LOGICAL_MODEL_ROUTER_KINDS[number];
export type GatewayModelCapability = boolean | number | string[];
export type GatewayModelCapabilities = Record<string, GatewayModelCapability>;
export type GatewayParameterCaps = Partial<Record<GatewayParameterCapId, number>>;
export type GatewayAccessProfileLimits = Partial<Record<GatewayAccessProfileLimitId, number>>;
export type HttpProviderDialect = typeof HTTP_PROVIDER_DIALECT_NAMES[number];
export type BuiltinProvider = typeof BUILTIN_PROVIDER_NAMES[number];
export type Provider = string;
export type ProviderAuthStyle = typeof PROVIDER_AUTH_STYLES[number];
export type ProviderAdapterKind = typeof PROVIDER_ADAPTER_KINDS[number];
export type ProviderAdapterContractVersion = typeof PROVIDER_ADAPTER_CONTRACT_VERSIONS[number];
export type BedrockProviderOperation = typeof BEDROCK_PROVIDER_OPERATIONS[number];
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

export const surfaceSchema = z.enum(SURFACE_NAMES);
export const dialectSchema = z.enum(DIALECT_NAMES);
export const gatewayOperationIdSchema = z.enum(GATEWAY_OPERATION_IDS);
export const gatewayParameterCapIdSchema = z.enum(GATEWAY_PARAMETER_CAP_IDS);
export const gatewayAccessProfileLimitIdSchema = z.enum(GATEWAY_ACCESS_PROFILE_LIMIT_IDS);
export const gatewayResourceStatusSchema = z.enum(GATEWAY_RESOURCE_STATUSES);
export const logicalModelResolutionKindSchema = z.enum(LOGICAL_MODEL_RESOLUTION_KINDS);
export const logicalModelRouterKindSchema = z.enum(LOGICAL_MODEL_ROUTER_KINDS);
export const gatewayModelCapabilitiesSchema: z.ZodType<GatewayModelCapabilities> = z.record(
  z.string(),
  z.union([z.boolean(), z.number().positive(), z.array(z.string())])
);
export const gatewayParameterCapsSchema: z.ZodType<GatewayParameterCaps> = z.object({
  max_tokens: z.number().int().nonnegative().optional(),
  max_output_tokens: z.number().int().nonnegative().optional(),
  max_completion_tokens: z.number().int().nonnegative().optional()
}).strict();
export const gatewayAccessProfileLimitsSchema: z.ZodType<GatewayAccessProfileLimits> = z.object({
  concurrent_requests: z.number().int().positive().optional(),
  requests_per_minute: z.number().int().positive().optional(),
  tokens_per_minute: z.number().int().positive().optional()
}).strict();
export const logicalModelClassifierConfigSchema = z.strictObject({
  classifierDeploymentId: z.string().min(1).max(1_024).refine((value) => value === value.trim(), {
    message: "Classifier deployment ID must not include leading or trailing whitespace."
  }),
  instructions: z.string().min(1).max(20_000).refine((value) => value.trim().length > 0, {
    message: "Classifier instructions must contain non-whitespace text."
  }),
  timeoutMs: z.number().int().positive().max(30_000),
  maxAttempts: z.number().int().positive().max(5)
});
export type LogicalModelClassifierConfig = z.infer<typeof logicalModelClassifierConfigSchema>;
export const logicalModelClassificationFeaturesSchema = z.strictObject({
  estimatedInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  inputChars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  hasTools: z.boolean().optional(),
  toolCount: z.number().int().nonnegative().max(10_000).optional(),
  hasImages: z.boolean().optional(),
  hasPreviousResponseId: z.boolean().optional(),
  extractedHints: z.array(z.string().min(1).max(64)).max(32).optional(),
  requestShapeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  redactedInputExcerpt: z.string().max(2_000).nullable().optional()
});
export type LogicalModelClassificationFeatures = z.infer<typeof logicalModelClassificationFeaturesSchema>;
export const logicalModelClassificationContextSchema = logicalModelClassificationFeaturesSchema.extend({
  requestedModel: z.string().min(1).max(512),
  operationId: gatewayOperationIdSchema
});
export type LogicalModelClassificationContext = z.infer<typeof logicalModelClassificationContextSchema>;
export const logicalModelClassifierCapabilitiesSchema = z.strictObject({
  contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  modalities: z.array(z.string().min(1).max(64)).max(16).optional(),
  efforts: z.array(z.string().min(1).max(64)).max(16).optional(),
  tools: z.boolean().optional(),
  images: z.boolean().optional(),
  toolCall: z.boolean().optional(),
  image: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  streaming: z.boolean().optional()
});
export type LogicalModelClassifierCapabilities = z.infer<typeof logicalModelClassifierCapabilitiesSchema>;
export const logicalModelClassifierCandidateSchema = z.strictObject({
  targetId: z.string().min(1).max(1_024),
  capabilities: logicalModelClassifierCapabilitiesSchema
});
export type LogicalModelClassifierCandidate = z.infer<typeof logicalModelClassifierCandidateSchema>;
export const logicalModelClassificationRequestSchema = z.strictObject({
  context: logicalModelClassificationContextSchema,
  candidates: z.array(logicalModelClassifierCandidateSchema).min(1).max(64)
}).superRefine((request, context) => {
  if (new Set(request.candidates.map((candidate) => candidate.targetId)).size !== request.candidates.length) {
    context.addIssue({
      code: "custom",
      message: "Classifier target IDs must be unique.",
      path: ["candidates"]
    });
  }
});
export type LogicalModelClassificationRequest = z.infer<typeof logicalModelClassificationRequestSchema>;

const LOGICAL_MODEL_CLASSIFIER_CAPABILITY_KEYS = [
  "contextWindow",
  "maxOutputTokens",
  "modalities",
  "efforts",
  "tools",
  "images",
  "toolCall",
  "image",
  "reasoning",
  "streaming"
] as const;

export function projectLogicalModelClassifierCapabilities(
  capabilities: GatewayModelCapabilities
): Record<string, GatewayModelCapability> {
  return Object.fromEntries(
    LOGICAL_MODEL_CLASSIFIER_CAPABILITY_KEYS.flatMap((key) => (
      capabilities[key] === undefined ? [] : [[key, capabilities[key]]]
    ))
  );
}
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
export const providerAdapterContractVersionSchema = z.enum(PROVIDER_ADAPTER_CONTRACT_VERSIONS);
const gatewayEvidenceIdSchema = z.string().min(1).max(1_024).refine((value) => value === value.trim(), {
  message: "Gateway evidence IDs must not include leading or trailing whitespace."
});
const gatewayEvidenceModelSchema = z.string().min(1).max(512).refine((value) => value === value.trim(), {
  message: "Gateway evidence model names must not include leading or trailing whitespace."
});
const gatewayEvidenceVersionSchema = z.string().min(1).max(128).refine((value) => value === value.trim(), {
  message: "Gateway evidence versions must not include leading or trailing whitespace."
});
export const gatewayRequestAdmissionEvidenceSchema = z.strictObject({
  ingressWireId: dialectSchema,
  operationId: gatewayOperationIdSchema,
  requestedLogicalModel: gatewayEvidenceModelSchema
});
export type GatewayRequestAdmissionEvidence = z.infer<typeof gatewayRequestAdmissionEvidenceSchema>;
export const gatewayResolutionEvidenceSchema = gatewayRequestAdmissionEvidenceSchema.extend({
  resolvedLogicalModelId: gatewayEvidenceIdSchema,
  accessProfileId: gatewayEvidenceIdSchema,
  routerKind: logicalModelRouterKindSchema.nullable(),
  deploymentId: gatewayEvidenceIdSchema,
  providerConnectionId: gatewayEvidenceIdSchema,
  egressWireId: dialectSchema,
  wireAdapterVersion: gatewayEvidenceVersionSchema.nullable()
});
export type GatewayResolutionEvidence = z.infer<typeof gatewayResolutionEvidenceSchema>;
export const gatewayProviderAttemptEvidenceSchema = z.strictObject({
  deploymentId: gatewayEvidenceIdSchema,
  providerConnectionId: gatewayEvidenceIdSchema,
  egressWireId: dialectSchema,
  providerAdapterContractVersion: providerAdapterContractVersionSchema
});
export type GatewayProviderAttemptEvidence = z.infer<typeof gatewayProviderAttemptEvidenceSchema>;
export const bedrockProviderOperationSchema = z.enum(BEDROCK_PROVIDER_OPERATIONS);
export const providerCacheTtlSchema = z.enum(PROVIDER_CACHE_TTLS);
export const providerCacheKeyFieldSchema = z.enum(PROVIDER_CACHE_KEY_FIELDS);
export const providerCacheRetentionFieldSchema = z.enum(PROVIDER_CACHE_RETENTION_FIELDS);
export const providerCacheUsageShapeSchema = z.enum(PROVIDER_CACHE_USAGE_SHAPES);
export const effortSchema = z.enum(EFFORTS);
export const openAIReasoningEffortSchema = z.enum(OPENAI_REASONING_EFFORTS);
export const verbositySchema = z.enum(VERBOSITIES);
export const providerHealthErrorTypeSchema = z.enum(PROVIDER_HEALTH_ERROR_TYPES);
export const providerHealthStatusSchema = z.enum(PROVIDER_HEALTH_STATUSES);
export const providerHealthClassificationSourceSchema = z.enum(PROVIDER_HEALTH_CLASSIFICATION_SOURCES);
export const providerHealthConfidenceSchema = z.enum(PROVIDER_HEALTH_CONFIDENCES);
export const providerHealthScopeSchema = z.enum(PROVIDER_HEALTH_SCOPES);
const nonEmptyTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Must contain non-whitespace text."
});
const identifierSchema = nonEmptyTextSchema.refine((value) => value === value.trim(), {
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
  prefixDigest: z.string().trim().refine((value) => value.startsWith("sha256:"), {
    message: "Prewarm prefix digest must be a sha256 digest."
  }),
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
  path: identifierSchema.refine((value) => value.startsWith("/"), {
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
