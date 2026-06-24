import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

const promptCaptureModeSchema = z.enum(["none", "hash_only", "raw_text", "redacted", "encrypted_raw"]);

const nullableNonnegativeIntSchema = z.preprocess((value) => value === null ? undefined : value, z.number().int().nonnegative().optional());

export const proxySettingsSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  classifier: z.strictObject({
    model: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().max(30000).optional(),
    maxAttempts: z.number().int().positive().max(5).optional(),
    allowRedactedExcerpt: z.boolean().optional()
  }).default({}),
  routeQuality: z.strictObject({
    lowConfidenceThreshold: z.number().min(0).max(1).optional()
  }).default({}),
  promptCapture: z.strictObject({
    promptCaptureMode: promptCaptureModeSchema.optional(),
    retentionDays: nullableNonnegativeIntSchema
  }).default({})
}).default({
  schemaVersion: 1,
  classifier: {},
  routeQuality: {},
  promptCapture: {}
});

export type ProxySettings = z.infer<typeof proxySettingsSchema>;

export const emptyProxySettings: ProxySettings = {
  schemaVersion: 1,
  classifier: {},
  routeQuality: {},
  promptCapture: {}
};

export function defaultSettingsPath(cwd = process.cwd()) {
  return resolve(cwd, ".proxy", "settings.json");
}

export function settingsPathFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return resolve(env.PROXY_SETTINGS_PATH?.trim() || defaultSettingsPath());
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
  if (settings.routeQuality.lowConfidenceThreshold !== undefined) {
    env.ROUTE_QUALITY_LOW_CONFIDENCE_THRESHOLD = String(settings.routeQuality.lowConfidenceThreshold);
  }
  return env;
}

function parseSettings(raw: string) {
  try {
    const value: unknown = JSON.parse(raw);
    // Files saved before budget limits moved to routing configs carry a
    // "budgets" key; the strict schema would reject it and fail boot.
    if (value && typeof value === "object" && "budgets" in value) {
      delete (value as Record<string, unknown>).budgets;
      if (!warnedLegacyBudgets) {
        warnedLegacyBudgets = true;
        console.warn("Ignoring legacy \"budgets\" block in settings file; budget limits now live in routing configs.");
      }
    }
    return proxySettingsSchema.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("settings_file_invalid_json");
    }
    throw error;
  }
}

let warnedLegacyBudgets = false;

function isNotFound(error: unknown) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT";
}
