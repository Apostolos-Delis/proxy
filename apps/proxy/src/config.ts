import { z } from "zod";

import { buildModelPricingTable } from "./pricing.js";
import {
  readSettingsFileSync,
  settingsPathFromEnv,
  settingsToEnv
} from "./settings.js";

const DEFAULT_PROXY_TOKEN = "dev-token";
const DEFAULT_OPENAI_API_KEY = "test-openai-key";
const DEFAULT_ANTHROPIC_API_KEY = "test-anthropic-key";

function normalizeBooleanEnv(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return value;
}

const booleanEnvSchema = z.preprocess(normalizeBooleanEnv, z.boolean().default(false));
const subscriptionOAuthEnvSchema = z.preprocess(normalizeBooleanEnv, z.boolean().default(true));
const optionalBooleanEnvSchema = z.preprocess(normalizeBooleanEnv, z.boolean().optional());
const metricsExporterSchema = z.enum(["none", "prometheus"]).default("prometheus");
const metricsAuthModeSchema = z.enum(["token", "none"]).default("token");
const optionalNonEmptyStringSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);
const metricsPathSchema = z
  .string()
  .trim()
  .default("/metrics")
  .refine(
    (value) => value.startsWith("/") && !value.includes("?") && !value.includes("#") && !/\s/.test(value),
    "METRICS_PATH must be an absolute path without whitespace, query string, or fragment"
  );

const optionalPositiveIntSchema = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  return value;
}, z.coerce.number().int().positive().optional());

const positiveIntEnvSchema = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  return value;
}, z.coerce.number().int().positive());

const localRequestBodyLimitBytes = 1024 * 1024 * 50;
const productionRequestBodyLimitBytes = 1024 * 1024 * 15;
const defaultEventWriterMaxEntries = 10_000;
const defaultEventWriterMaxBytes = 1024 * 1024 * 8;
const defaultEventWriterBatchSize = 25;
const defaultEventWriterShutdownTimeoutMs = 5_000;

const modelCostsSchema = z.preprocess((value) => {
  if (value === undefined || value === "") return {};
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}, z.record(z.string(), z.object({
  inputCostPerMtok: z.coerce.number().nonnegative().default(0),
  outputCostPerMtok: z.coerce.number().nonnegative().default(0),
  cacheReadCostPerMtok: z.coerce.number().nonnegative().optional(),
  cacheWriteCostPerMtok: z.coerce.number().nonnegative().optional()
})).default({}));

const configSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8787),
  PROXY_TOKEN: z.string().min(1).default(DEFAULT_PROXY_TOKEN),
  PROXY_SETTINGS_PATH: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1).default(DEFAULT_OPENAI_API_KEY),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_CHATGPT_BASE_URL: z.string().url().default("https://chatgpt.com/backend-api/codex"),
  OPENAI_FAST_MODEL: z.string().min(1).default("gpt-5.4-mini"),
  OPENAI_BALANCED_MODEL: z.string().min(1).default("gpt-5.4"),
  OPENAI_HARD_MODEL: z.string().min(1).default("gpt-5.5"),
  OPENAI_DEEP_MODEL: z.string().min(1).default("gpt-5.5-pro"),
  ANTHROPIC_API_KEY: z.string().min(1).default(DEFAULT_ANTHROPIC_API_KEY),
  ANTHROPIC_BASE_URL: z.string().url().default("https://api.anthropic.com/v1"),
  ANTHROPIC_FAST_MODEL: z.string().min(1).default("claude-haiku-4-5"),
  ANTHROPIC_BALANCED_MODEL: z.string().min(1).default("claude-sonnet-4-5"),
  ANTHROPIC_HARD_MODEL: z.string().min(1).default("claude-sonnet-4-5"),
  ANTHROPIC_DEEP_MODEL: z.string().min(1).default("claude-opus-4-5"),
  CLASSIFIER_PROVIDER: z.string().trim().min(1).default("openai"),
  // A real, catalog-priced model: the classifier makes a billed call per request.
  CLASSIFIER_MODEL: z.string().min(1).default("gpt-5-nano-2025-08-07"),
  CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  CLASSIFIER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),
  PROVIDER_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
  PROVIDER_RATE_LIMIT_BASE_DELAY_MS: z.coerce.number().int().nonnegative().default(500),
  PROVIDER_RATE_LIMIT_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(60000),
  BEDROCK_OPERATOR_DEFAULT_CHAIN_ENABLED: booleanEnvSchema,
  BEDROCK_LOCAL_CREDENTIALS_ENABLED: booleanEnvSchema,
  BEDROCK_AWS_PROFILE: optionalNonEmptyStringSchema,
  CLASSIFIER_ALLOW_REDACTED_EXCERPT: booleanEnvSchema,
  MODEL_COSTS_JSON: modelCostsSchema,
  ROUTE_QUALITY_LOW_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.55),
  EVENT_STORE_PATH: z.string().optional(),
  REQUEST_BODY_LIMIT_BYTES: optionalPositiveIntSchema,
  GATEWAY_LIMIT_WINDOW_MS: positiveIntEnvSchema.default(60_000),
  GATEWAY_GLOBAL_CONCURRENCY_LIMIT: optionalPositiveIntSchema,
  GATEWAY_ORGANIZATION_CONCURRENCY_LIMIT: optionalPositiveIntSchema,
  GATEWAY_WORKSPACE_CONCURRENCY_LIMIT: optionalPositiveIntSchema,
  GATEWAY_API_KEY_CONCURRENCY_LIMIT: optionalPositiveIntSchema,
  GATEWAY_USER_CONCURRENCY_LIMIT: optionalPositiveIntSchema,
  GATEWAY_PROVIDER_MODEL_CONCURRENCY_LIMIT: optionalPositiveIntSchema,
  GATEWAY_GLOBAL_RPM_LIMIT: optionalPositiveIntSchema,
  GATEWAY_ORGANIZATION_RPM_LIMIT: optionalPositiveIntSchema,
  GATEWAY_WORKSPACE_RPM_LIMIT: optionalPositiveIntSchema,
  GATEWAY_API_KEY_RPM_LIMIT: optionalPositiveIntSchema,
  GATEWAY_USER_RPM_LIMIT: optionalPositiveIntSchema,
  GATEWAY_PROVIDER_MODEL_RPM_LIMIT: optionalPositiveIntSchema,
  GATEWAY_GLOBAL_TPM_LIMIT: optionalPositiveIntSchema,
  GATEWAY_ORGANIZATION_TPM_LIMIT: optionalPositiveIntSchema,
  GATEWAY_WORKSPACE_TPM_LIMIT: optionalPositiveIntSchema,
  GATEWAY_API_KEY_TPM_LIMIT: optionalPositiveIntSchema,
  GATEWAY_USER_TPM_LIMIT: optionalPositiveIntSchema,
  GATEWAY_PROVIDER_MODEL_TPM_LIMIT: optionalPositiveIntSchema,
  EVENT_WRITER_MAX_ENTRIES: positiveIntEnvSchema.default(defaultEventWriterMaxEntries),
  EVENT_WRITER_MAX_BYTES: positiveIntEnvSchema.default(defaultEventWriterMaxBytes),
  EVENT_WRITER_BATCH_SIZE: positiveIntEnvSchema.default(defaultEventWriterBatchSize),
  EVENT_WRITER_SHUTDOWN_TIMEOUT_MS: positiveIntEnvSchema.default(defaultEventWriterShutdownTimeoutMs),
  DATABASE_URL: z.string().optional(),
  DB_POOL_MAX: positiveIntEnvSchema.default(5),
  PROVIDER_SECRET_ENCRYPTION_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .optional()
      .refine(
        (value) => value === undefined || Buffer.from(value, "base64").length === 32,
        "PROVIDER_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key"
      )
  ),
  DEFAULT_ORGANIZATION_ID: z.string().min(1).default("local"),
  // Operator-level kill switch for subscription-token auth. Env-only by
  // design (never settings-file editable) and internal-only — must not be
  // surfaced to external customers. See docs/scopes/subscription-auth-v1/PLAN.md.
  SUBSCRIPTION_OAUTH_ENABLED: subscriptionOAuthEnvSchema,
  ALLOWED_PRIVATE_UPSTREAM_CIDRS: z.string().default(""),
  ALLOW_DEV_PROXY_TOKEN_FALLBACK: booleanEnvSchema,
  DEBUG_ENDPOINTS_ENABLED: booleanEnvSchema,
  ADMIN_DEV_LOGIN_ENABLED: booleanEnvSchema,
  ADMIN_GRAPHIQL_ENABLED: optionalBooleanEnvSchema,
  ADMIN_DEV_LOGIN_EMAIL: z.string().email().default("local@example.com"),
  ADMIN_DEV_LOGIN_PASSWORD: z.string().min(1).default("dev-password"),
  ADMIN_SESSION_COOKIE_NAME: z.string().min(1).default("proxy_session"),
  ADMIN_SESSION_COOKIE_SECURE: optionalBooleanEnvSchema,
  ADMIN_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 8),
  SEED_USER_ID: z.string().min(1).default("local-user"),
  ADMIN_CORS_ORIGIN: z.string().default("http://127.0.0.1:5173,http://localhost:5173"),
  ADMIN_CONSOLE_URL: z.string().url().default("http://127.0.0.1:5173"),
  METRICS_ENABLED: booleanEnvSchema,
  METRICS_EXPORTER: metricsExporterSchema,
  METRICS_PATH: metricsPathSchema,
  METRICS_AUTH_MODE: metricsAuthModeSchema,
  METRICS_TOKEN: optionalNonEmptyStringSchema,
  RESEND_API_KEY: z.string().optional(),
  RESEND_BASE_URL: z.string().url().default("https://api.resend.com"),
  EMAIL_FROM: z.string().min(1).default("Proxy <onboarding@resend.dev>"),
  INVITATION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  LOG_LEVEL: z.string().default("info")
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const settingsPath = settingsPathFromEnv(env);
  const fileSettings = readSettingsFileSync(settingsPath);
  const parsed = configSchema.parse({
    ...settingsToEnv(fileSettings),
    ...env,
    PROXY_SETTINGS_PATH: settingsPath
  });
  const production = parsed.NODE_ENV === "production";
  const metricsExporter = parsed.METRICS_ENABLED ? parsed.METRICS_EXPORTER : "none";
  const debugEndpointsEnabled = parsed.DEBUG_ENDPOINTS_ENABLED || (!production && !parsed.DATABASE_URL);
  if (production && parsed.PROXY_TOKEN === DEFAULT_PROXY_TOKEN) {
    throw new Error("PROXY_TOKEN must be changed in production.");
  }
  if (production && parsed.OPENAI_API_KEY === DEFAULT_OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY must be set in production.");
  }
  if (production && parsed.ANTHROPIC_API_KEY === DEFAULT_ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY must be set in production.");
  }
  if (production && parsed.DATABASE_URL && parsed.ADMIN_DEV_LOGIN_ENABLED && parsed.ADMIN_DEV_LOGIN_PASSWORD === "dev-password") {
    throw new Error("ADMIN_DEV_LOGIN_PASSWORD must be changed before enabling dev login with DATABASE_URL.");
  }
  if (production && parsed.METRICS_ENABLED && parsed.METRICS_AUTH_MODE === "none") {
    throw new Error("METRICS_AUTH_MODE=none cannot be used with METRICS_ENABLED in production.");
  }
  if (production && parsed.METRICS_ENABLED && parsed.METRICS_AUTH_MODE === "token" && !parsed.METRICS_TOKEN) {
    throw new Error("METRICS_TOKEN must be set before enabling token-authenticated metrics in production.");
  }

  return {
    port: parsed.PORT,
    proxyToken: parsed.PROXY_TOKEN,
    settingsPath,
    openaiApiKey: parsed.OPENAI_API_KEY,
    openaiBaseUrl: trimTrailingSlash(parsed.OPENAI_BASE_URL),
    openaiChatgptBaseUrl: trimTrailingSlash(parsed.OPENAI_CHATGPT_BASE_URL),
    openaiFastModel: parsed.OPENAI_FAST_MODEL,
    openaiBalancedModel: parsed.OPENAI_BALANCED_MODEL,
    openaiHardModel: parsed.OPENAI_HARD_MODEL,
    openaiDeepModel: parsed.OPENAI_DEEP_MODEL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    anthropicBaseUrl: trimTrailingSlash(parsed.ANTHROPIC_BASE_URL),
    anthropicFastModel: parsed.ANTHROPIC_FAST_MODEL,
    anthropicBalancedModel: parsed.ANTHROPIC_BALANCED_MODEL,
    anthropicHardModel: parsed.ANTHROPIC_HARD_MODEL,
    anthropicDeepModel: parsed.ANTHROPIC_DEEP_MODEL,
    classifierProvider: parsed.CLASSIFIER_PROVIDER,
    classifierModel: parsed.CLASSIFIER_MODEL,
    classifierTimeoutMs: parsed.CLASSIFIER_TIMEOUT_MS,
    classifierMaxAttempts: parsed.CLASSIFIER_MAX_ATTEMPTS,
    providerRateLimitMaxAttempts: parsed.PROVIDER_RATE_LIMIT_MAX_ATTEMPTS,
    providerRateLimitBaseDelayMs: parsed.PROVIDER_RATE_LIMIT_BASE_DELAY_MS,
    providerRateLimitMaxDelayMs: parsed.PROVIDER_RATE_LIMIT_MAX_DELAY_MS,
    bedrockOperatorDefaultChainEnabled: parsed.BEDROCK_OPERATOR_DEFAULT_CHAIN_ENABLED,
    bedrockLocalCredentialsEnabled: parsed.BEDROCK_LOCAL_CREDENTIALS_ENABLED,
    bedrockAwsProfile: parsed.BEDROCK_AWS_PROFILE,
    classifierAllowRedactedExcerpt: parsed.CLASSIFIER_ALLOW_REDACTED_EXCERPT,
    modelCosts: buildModelPricingTable(parsed.MODEL_COSTS_JSON),
    modelCostsFromEnv: Object.keys(parsed.MODEL_COSTS_JSON),
    routeQualityLowConfidenceThreshold: parsed.ROUTE_QUALITY_LOW_CONFIDENCE_THRESHOLD,
    eventStorePath: parsed.EVENT_STORE_PATH,
    requestBodyLimitBytes: parsed.REQUEST_BODY_LIMIT_BYTES ?? (parsed.NODE_ENV === "production" ? productionRequestBodyLimitBytes : localRequestBodyLimitBytes),
    trafficLimits: {
      windowMs: parsed.GATEWAY_LIMIT_WINDOW_MS,
      globalConcurrent: parsed.GATEWAY_GLOBAL_CONCURRENCY_LIMIT,
      organizationConcurrent: parsed.GATEWAY_ORGANIZATION_CONCURRENCY_LIMIT,
      workspaceConcurrent: parsed.GATEWAY_WORKSPACE_CONCURRENCY_LIMIT,
      apiKeyConcurrent: parsed.GATEWAY_API_KEY_CONCURRENCY_LIMIT,
      userConcurrent: parsed.GATEWAY_USER_CONCURRENCY_LIMIT,
      providerModelConcurrent: parsed.GATEWAY_PROVIDER_MODEL_CONCURRENCY_LIMIT,
      globalRpm: parsed.GATEWAY_GLOBAL_RPM_LIMIT,
      organizationRpm: parsed.GATEWAY_ORGANIZATION_RPM_LIMIT,
      workspaceRpm: parsed.GATEWAY_WORKSPACE_RPM_LIMIT,
      apiKeyRpm: parsed.GATEWAY_API_KEY_RPM_LIMIT,
      userRpm: parsed.GATEWAY_USER_RPM_LIMIT,
      providerModelRpm: parsed.GATEWAY_PROVIDER_MODEL_RPM_LIMIT,
      globalTpm: parsed.GATEWAY_GLOBAL_TPM_LIMIT,
      organizationTpm: parsed.GATEWAY_ORGANIZATION_TPM_LIMIT,
      workspaceTpm: parsed.GATEWAY_WORKSPACE_TPM_LIMIT,
      apiKeyTpm: parsed.GATEWAY_API_KEY_TPM_LIMIT,
      userTpm: parsed.GATEWAY_USER_TPM_LIMIT,
      providerModelTpm: parsed.GATEWAY_PROVIDER_MODEL_TPM_LIMIT
    },
    eventWriterMaxEntries: parsed.EVENT_WRITER_MAX_ENTRIES,
    eventWriterMaxBytes: parsed.EVENT_WRITER_MAX_BYTES,
    eventWriterBatchSize: parsed.EVENT_WRITER_BATCH_SIZE,
    eventWriterShutdownTimeoutMs: parsed.EVENT_WRITER_SHUTDOWN_TIMEOUT_MS,
    databaseUrl: parsed.DATABASE_URL,
    dbPoolMax: parsed.DB_POOL_MAX,
    providerSecretEncryptionKey: parsed.PROVIDER_SECRET_ENCRYPTION_KEY,
    defaultOrganizationId: parsed.DEFAULT_ORGANIZATION_ID,
    subscriptionOAuthEnabled: parsed.SUBSCRIPTION_OAUTH_ENABLED,
    allowedPrivateUpstreamCidrs: parsed.ALLOWED_PRIVATE_UPSTREAM_CIDRS.split(",").map((cidr) => cidr.trim()).filter(Boolean),
    allowDevProxyTokenFallback: parsed.ALLOW_DEV_PROXY_TOKEN_FALLBACK || (!production && !parsed.DATABASE_URL),
    debugEndpointsEnabled,
    adminDevLoginEnabled: parsed.ADMIN_DEV_LOGIN_ENABLED,
    adminGraphiqlEnabled: parsed.ADMIN_GRAPHIQL_ENABLED ?? !production,
    adminDevLoginEmail: parsed.ADMIN_DEV_LOGIN_EMAIL,
    adminDevLoginPassword: parsed.ADMIN_DEV_LOGIN_PASSWORD,
    adminSessionCookieName: parsed.ADMIN_SESSION_COOKIE_NAME,
    adminSessionCookieSecure: parsed.ADMIN_SESSION_COOKIE_SECURE ?? parsed.ADMIN_CONSOLE_URL.startsWith("https://"),
    adminSessionTtlSeconds: parsed.ADMIN_SESSION_TTL_SECONDS,
    seedUserId: parsed.SEED_USER_ID,
    adminCorsOrigins: parsed.ADMIN_CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean),
    adminConsoleUrl: trimTrailingSlash(parsed.ADMIN_CONSOLE_URL),
    metricsEnabled: parsed.METRICS_ENABLED,
    metricsExporter,
    metricsPath: parsed.METRICS_PATH,
    metricsAuthMode: parsed.METRICS_AUTH_MODE,
    metricsToken: parsed.METRICS_TOKEN,
    resendApiKey: parsed.RESEND_API_KEY,
    resendBaseUrl: trimTrailingSlash(parsed.RESEND_BASE_URL),
    emailFrom: parsed.EMAIL_FROM,
    invitationTtlSeconds: parsed.INVITATION_TTL_SECONDS,
    logLevel: parsed.LOG_LEVEL
  };
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
