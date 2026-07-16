import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

const promptCaptureModeSchema = z.enum(["none", "hash_only", "raw_text", "redacted", "encrypted_raw"]);

const nullableNonnegativeIntSchema = z.preprocess((value) => value === null ? undefined : value, z.number().int().nonnegative().optional());

export const proxySettingsSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  promptCapture: z.strictObject({
    promptCaptureMode: promptCaptureModeSchema.optional(),
    retentionDays: nullableNonnegativeIntSchema
  }).default({})
}).default({
  schemaVersion: 1,
  promptCapture: {}
});

export type ProxySettings = z.infer<typeof proxySettingsSchema>;

export const emptyProxySettings: ProxySettings = {
  schemaVersion: 1,
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

export function settingsToEnv(_settings: ProxySettings): NodeJS.ProcessEnv {
  return {};
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
