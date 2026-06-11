import { z } from "zod";

import { buildModelPricingTable } from "./pricing.js";
import {
  readSettingsFileSync,
  settingsPathFromEnv,
  settingsToEnv
} from "./settings.js";
import type { RouteName } from "./types.js";

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
const enabledBooleanEnvSchema = z.preprocess(normalizeBooleanEnv, z.boolean().default(true));

const optionalPositiveIntSchema = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  return value;
}, z.coerce.number().int().positive().optional());

const routeNameSchema = z.enum(["fast", "balanced", "hard", "deep"]);

const optionalRouteNameSchema = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  return value;
}, routeNameSchema.optional());

const jsonNumberMapSchema = z.preprocess((value) => {
  if (value === undefined || value === "") return {};
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}, z.record(z.string(), z.coerce.number().int().positive()).default({}));

const routeNumberMapSchema = z.preprocess((value) => {
  if (value === undefined || value === "") return {};
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}, z.object({
  fast: z.coerce.number().int().positive().optional(),
  balanced: z.coerce.number().int().positive().optional(),
  hard: z.coerce.number().int().positive().optional(),
  deep: z.coerce.number().int().positive().optional()
}).strict().default({}));

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
  PORT: z.coerce.number().int().positive().default(8787),
  PROMPT_PROXY_TOKEN: z.string().min(1).default("dev-proxy-token"),
  PROMPT_PROXY_SETTINGS_PATH: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1).default("test-openai-key"),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_FAST_MODEL: z.string().min(1).default("gpt-5.4-mini"),
  OPENAI_BALANCED_MODEL: z.string().min(1).default("gpt-5.4"),
  OPENAI_HARD_MODEL: z.string().min(1).default("gpt-5.5"),
  OPENAI_DEEP_MODEL: z.string().min(1).default("gpt-5.5-pro"),
  ANTHROPIC_API_KEY: z.string().min(1).default("test-anthropic-key"),
  ANTHROPIC_BASE_URL: z.string().url().default("https://api.anthropic.com/v1"),
  ANTHROPIC_FAST_MODEL: z.string().min(1).default("claude-haiku-4-5"),
  ANTHROPIC_BALANCED_MODEL: z.string().min(1).default("claude-sonnet-4-5"),
  ANTHROPIC_HARD_MODEL: z.string().min(1).default("claude-sonnet-4-5"),
  ANTHROPIC_DEEP_MODEL: z.string().min(1).default("claude-opus-4-5"),
  CLASSIFIER_PROVIDER: z.literal("openai").default("openai"),
  CLASSIFIER_MODEL: z.string().min(1).default("route-classifier-cheap"),
  CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  CLASSIFIER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),
  CLASSIFIER_ALLOW_REDACTED_EXCERPT: booleanEnvSchema,
  BUDGET_MAX_ESTIMATED_INPUT_TOKENS: optionalPositiveIntSchema,
  BUDGET_WARNING_ESTIMATED_INPUT_TOKENS: optionalPositiveIntSchema,
  BUDGET_MAX_ROUTE: optionalRouteNameSchema,
  BUDGET_USER_ESTIMATED_INPUT_LIMITS: jsonNumberMapSchema,
  BUDGET_TEAM_ESTIMATED_INPUT_LIMITS: jsonNumberMapSchema,
  BUDGET_ROUTE_ESTIMATED_INPUT_LIMITS: routeNumberMapSchema,
  MODEL_COSTS_JSON: modelCostsSchema,
  ROUTE_QUALITY_LOW_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.55),
  EVENT_STORE_PATH: z.string().optional(),
  DATABASE_URL: z.string().optional(),
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
  ALLOW_DEV_PROXY_TOKEN_FALLBACK: booleanEnvSchema,
  ADMIN_DEV_LOGIN_ENABLED: booleanEnvSchema,
  ADMIN_GRAPHIQL_ENABLED: enabledBooleanEnvSchema,
  ADMIN_DEV_LOGIN_EMAIL: z.string().email().default("local@example.com"),
  ADMIN_DEV_LOGIN_PASSWORD: z.string().min(1).default("dev-password"),
  ADMIN_SESSION_COOKIE_NAME: z.string().min(1).default("prompt_proxy_session"),
  ADMIN_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 8),
  SEED_USER_ID: z.string().min(1).default("local-user"),
  ADMIN_CORS_ORIGIN: z.string().default("http://127.0.0.1:5173,http://localhost:5173"),
  ADMIN_CONSOLE_URL: z.string().url().default("http://127.0.0.1:5173"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_BASE_URL: z.string().url().default("https://api.resend.com"),
  EMAIL_FROM: z.string().min(1).default("Prompt Proxy <onboarding@resend.dev>"),
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
    PROMPT_PROXY_SETTINGS_PATH: settingsPath
  });

  return {
    port: parsed.PORT,
    proxyToken: parsed.PROMPT_PROXY_TOKEN,
    settingsPath,
    openaiApiKey: parsed.OPENAI_API_KEY,
    openaiBaseUrl: trimTrailingSlash(parsed.OPENAI_BASE_URL),
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
    classifierAllowRedactedExcerpt: parsed.CLASSIFIER_ALLOW_REDACTED_EXCERPT,
    budgetMaxEstimatedInputTokens: parsed.BUDGET_MAX_ESTIMATED_INPUT_TOKENS,
    budgetWarningEstimatedInputTokens: parsed.BUDGET_WARNING_ESTIMATED_INPUT_TOKENS,
    budgetMaxRoute: parsed.BUDGET_MAX_ROUTE,
    budgetUserEstimatedInputLimits: parsed.BUDGET_USER_ESTIMATED_INPUT_LIMITS,
    budgetTeamEstimatedInputLimits: parsed.BUDGET_TEAM_ESTIMATED_INPUT_LIMITS,
    budgetRouteEstimatedInputLimits: parsed.BUDGET_ROUTE_ESTIMATED_INPUT_LIMITS as Partial<Record<RouteName, number>>,
    modelCosts: buildModelPricingTable(parsed.MODEL_COSTS_JSON),
    modelCostsFromEnv: Object.keys(parsed.MODEL_COSTS_JSON),
    routeQualityLowConfidenceThreshold: parsed.ROUTE_QUALITY_LOW_CONFIDENCE_THRESHOLD,
    eventStorePath: parsed.EVENT_STORE_PATH,
    databaseUrl: parsed.DATABASE_URL,
    providerSecretEncryptionKey: parsed.PROVIDER_SECRET_ENCRYPTION_KEY,
    defaultOrganizationId: parsed.DEFAULT_ORGANIZATION_ID,
    allowDevProxyTokenFallback: parsed.ALLOW_DEV_PROXY_TOKEN_FALLBACK || !parsed.DATABASE_URL,
    adminDevLoginEnabled: parsed.ADMIN_DEV_LOGIN_ENABLED,
    adminGraphiqlEnabled: parsed.ADMIN_GRAPHIQL_ENABLED,
    adminDevLoginEmail: parsed.ADMIN_DEV_LOGIN_EMAIL,
    adminDevLoginPassword: parsed.ADMIN_DEV_LOGIN_PASSWORD,
    adminSessionCookieName: parsed.ADMIN_SESSION_COOKIE_NAME,
    adminSessionTtlSeconds: parsed.ADMIN_SESSION_TTL_SECONDS,
    seedUserId: parsed.SEED_USER_ID,
    adminCorsOrigins: parsed.ADMIN_CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean),
    adminConsoleUrl: trimTrailingSlash(parsed.ADMIN_CONSOLE_URL),
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
