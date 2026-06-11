import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

const routeNameSchema = z.enum(["fast", "balanced", "hard", "deep"]);
const promptCaptureModeSchema = z.enum(["none", "hash_only", "raw_text", "redacted", "encrypted_raw"]);
const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

const nullablePositiveIntSchema = z.preprocess((value) => value === null ? undefined : value, z.number().int().positive().optional());
const nullableNonnegativeIntSchema = z.preprocess((value) => value === null ? undefined : value, z.number().int().nonnegative().optional());
const nullableRouteNameSchema = z.preprocess((value) => value === null ? undefined : value, routeNameSchema.optional());

export const proxySettingsSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  classifier: z.strictObject({
    model: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().max(30000).optional(),
    maxAttempts: z.number().int().positive().max(5).optional(),
    allowRedactedExcerpt: z.boolean().optional()
  }).default({}),
  budgets: z.strictObject({
    warningEstimatedInputTokens: nullablePositiveIntSchema,
    maxEstimatedInputTokens: nullablePositiveIntSchema,
    maxRoute: nullableRouteNameSchema
  }).default({}),
  routeQuality: z.strictObject({
    lowConfidenceThreshold: z.number().min(0).max(1).optional()
  }).default({}),
  promptCapture: z.strictObject({
    promptCaptureMode: promptCaptureModeSchema.optional(),
    retentionDays: nullableNonnegativeIntSchema
  }).default({}),
  consoleAgent: z.strictObject({
    model: z.string().trim().min(1).optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
    maxTurns: z.number().int().positive().max(100).optional(),
    maxToolCallsPerTurn: z.number().int().positive().max(50).optional(),
    timeoutSeconds: z.number().int().positive().max(3600).optional()
  }).default({})
}).default({
  schemaVersion: 1,
  classifier: {},
  budgets: {},
  routeQuality: {},
  promptCapture: {},
  consoleAgent: {}
});

export type ProxySettings = z.infer<typeof proxySettingsSchema>;

export const emptyProxySettings: ProxySettings = {
  schemaVersion: 1,
  classifier: {},
  budgets: {},
  routeQuality: {},
  promptCapture: {},
  consoleAgent: {}
};

export function defaultSettingsPath(cwd = process.cwd()) {
  return resolve(cwd, ".prompt-proxy", "settings.json");
}

export function settingsPathFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return resolve(env.PROMPT_PROXY_SETTINGS_PATH?.trim() || defaultSettingsPath());
}

export function readSettingsFileSync(path: string): ProxySettings {
  if (!existsSync(path)) return emptyProxySettings;
  return parseSettings(readFileSync(path, "utf8"));
}

export async function readSettingsFile(path: string): Promise<ProxySettings> {
  try {
    return parseSettings(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return emptyProxySettings;
    throw error;
  }
}

export async function writeSettingsFile(path: string, input: unknown): Promise<ProxySettings> {
  const settings = proxySettingsSchema.parse(input);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
  return settings;
}

export function settingsToEnv(settings: ProxySettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (settings.classifier.model !== undefined) env.CLASSIFIER_MODEL = settings.classifier.model;
  if (settings.classifier.timeoutMs !== undefined) env.CLASSIFIER_TIMEOUT_MS = String(settings.classifier.timeoutMs);
  if (settings.classifier.maxAttempts !== undefined) env.CLASSIFIER_MAX_ATTEMPTS = String(settings.classifier.maxAttempts);
  if (settings.classifier.allowRedactedExcerpt !== undefined) {
    env.CLASSIFIER_ALLOW_REDACTED_EXCERPT = String(settings.classifier.allowRedactedExcerpt);
  }
  if (settings.budgets.warningEstimatedInputTokens !== undefined) {
    env.BUDGET_WARNING_ESTIMATED_INPUT_TOKENS = String(settings.budgets.warningEstimatedInputTokens);
  }
  if (settings.budgets.maxEstimatedInputTokens !== undefined) {
    env.BUDGET_MAX_ESTIMATED_INPUT_TOKENS = String(settings.budgets.maxEstimatedInputTokens);
  }
  if (settings.budgets.maxRoute !== undefined) env.BUDGET_MAX_ROUTE = settings.budgets.maxRoute;
  if (settings.routeQuality.lowConfidenceThreshold !== undefined) {
    env.ROUTE_QUALITY_LOW_CONFIDENCE_THRESHOLD = String(settings.routeQuality.lowConfidenceThreshold);
  }
  if (settings.consoleAgent.model !== undefined) env.CONSOLE_AGENT_MODEL = settings.consoleAgent.model;
  if (settings.consoleAgent.thinkingLevel !== undefined) {
    env.CONSOLE_AGENT_THINKING_LEVEL = settings.consoleAgent.thinkingLevel;
  }
  if (settings.consoleAgent.maxTurns !== undefined) {
    env.CONSOLE_AGENT_MAX_TURNS = String(settings.consoleAgent.maxTurns);
  }
  if (settings.consoleAgent.maxToolCallsPerTurn !== undefined) {
    env.CONSOLE_AGENT_MAX_TOOL_CALLS_PER_TURN = String(settings.consoleAgent.maxToolCallsPerTurn);
  }
  if (settings.consoleAgent.timeoutSeconds !== undefined) {
    env.CONSOLE_AGENT_TIMEOUT_SECONDS = String(settings.consoleAgent.timeoutSeconds);
  }
  return env;
}

function parseSettings(raw: string) {
  try {
    return proxySettingsSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("settings_file_invalid_json");
    }
    throw error;
  }
}

function isNotFound(error: unknown) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT";
}
