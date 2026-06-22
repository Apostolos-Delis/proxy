import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HARNESS_COMPATIBILITY_PROFILE_IDS,
  TRANSLATION_COMPATIBILITY_DIALECTS,
  type HarnessCompatibilityProfileId,
  type TranslationDialect
} from "@prompt-proxy/schema";
import { expect } from "vitest";

export const harnessFixtureRoot = fileURLToPath(new URL("./fixtures/harnesses", import.meta.url));

export type HarnessFixtureManifest = {
  profileId: HarnessCompatibilityProfileId;
  caseId: string;
  surface: TranslationDialect;
  targetDialect?: TranslationDialect;
  description: string;
  mode: "native" | "translated" | "unsupported";
};

export type HarnessGoldenFixture = {
  dir: string;
  manifest: HarnessFixtureManifest;
  inboundRequest?: unknown;
  continuationRequest?: unknown;
  routeContext?: unknown;
  expectedUpstreamRequest?: unknown;
  expectedUpstreamRequests?: unknown[];
  expectedClientEvents?: unknown[];
  preconnectHeaders?: unknown;
  upstreamResponse?: unknown;
  expectedClientResponse?: unknown;
  upstreamSse?: string;
  expectedClientSse?: string;
  usage?: unknown;
  routePlanExcerpt?: unknown;
};

const jsonFiles = {
  inboundRequest: "inbound-request.json",
  continuationRequest: "continuation-request.json",
  routeContext: "route-context.json",
  expectedUpstreamRequest: "expected-upstream-request.json",
  expectedUpstreamRequests: "expected-upstream-requests.json",
  expectedClientEvents: "expected-client-events.json",
  preconnectHeaders: "preconnect-headers.json",
  upstreamResponse: "upstream-response.json",
  expectedClientResponse: "expected-client-response.json",
  usage: "usage.json",
  routePlanExcerpt: "route-plan-excerpt.json"
} as const;

export function loadHarnessFixture(
  profileId: HarnessCompatibilityProfileId,
  caseId: string,
  root = harnessFixtureRoot
): HarnessGoldenFixture {
  const dir = join(root, profileId, caseId);
  const manifest = manifestFrom(dir, profileId, caseId);
  return {
    dir,
    manifest,
    inboundRequest: readOptionalJson(dir, jsonFiles.inboundRequest),
    continuationRequest: readOptionalJson(dir, jsonFiles.continuationRequest),
    routeContext: readOptionalJson(dir, jsonFiles.routeContext),
    expectedUpstreamRequest: readOptionalJson(dir, jsonFiles.expectedUpstreamRequest),
    expectedUpstreamRequests: readOptionalJsonArray(dir, jsonFiles.expectedUpstreamRequests),
    expectedClientEvents: readOptionalJsonArray(dir, jsonFiles.expectedClientEvents),
    preconnectHeaders: readOptionalJson(dir, jsonFiles.preconnectHeaders),
    upstreamResponse: readOptionalJson(dir, jsonFiles.upstreamResponse),
    expectedClientResponse: readOptionalJson(dir, jsonFiles.expectedClientResponse),
    upstreamSse: readOptionalText(dir, "upstream.sse"),
    expectedClientSse: readOptionalText(dir, "expected-client.sse"),
    usage: readOptionalJson(dir, jsonFiles.usage),
    routePlanExcerpt: readOptionalJson(dir, jsonFiles.routePlanExcerpt)
  };
}

export function listHarnessFixtures(root = harnessFixtureRoot) {
  const entries: { profileId: HarnessCompatibilityProfileId; caseId: string }[] = [];
  for (const profileId of readdirSync(root)) {
    const profileDir = join(root, profileId);
    if (!isFixtureProfileId(profileId) || !statSync(profileDir).isDirectory()) continue;
    for (const caseId of readdirSync(profileDir)) {
      const caseDir = join(profileDir, caseId);
      if (statSync(caseDir).isDirectory() && existsSync(join(caseDir, "manifest.json"))) {
        entries.push({ profileId, caseId });
      }
    }
  }
  return entries;
}

export function expectExactJson(actual: unknown, expected: unknown, options?: { volatilePaths?: readonly string[] }) {
  expect(normalizeJson(actual, options?.volatilePaths ?? [])).toEqual(normalizeJson(expected, options?.volatilePaths ?? []));
}

export function expectExactSse(actual: string, expected: string) {
  expect(normalizeSse(actual)).toBe(normalizeSse(expected));
}

export function expectRoutePlanExcerpt(actual: unknown, expectedExcerpt: unknown) {
  expect(actual).toMatchObject(expectedExcerpt as Record<string, unknown>);
}

function manifestFrom(
  dir: string,
  profileId: HarnessCompatibilityProfileId,
  caseId: string
): HarnessFixtureManifest {
  const manifest = readRequiredJson(dir, "manifest.json");
  assertRecord(manifest, `${dir}/manifest.json`);
  assertString(manifest.profileId, `${dir}/manifest.json profileId`);
  assertString(manifest.caseId, `${dir}/manifest.json caseId`);
  assertString(manifest.surface, `${dir}/manifest.json surface`);
  assertString(manifest.description, `${dir}/manifest.json description`);
  assertString(manifest.mode, `${dir}/manifest.json mode`);
  if (manifest.profileId !== profileId) {
    throw new Error(`${dir}/manifest.json profileId must match ${profileId}`);
  }
  if (manifest.caseId !== caseId) {
    throw new Error(`${dir}/manifest.json caseId must match ${caseId}`);
  }
  if (!isFixtureProfileId(manifest.profileId)) {
    throw new Error(`${dir}/manifest.json profileId is not supported: ${manifest.profileId}`);
  }
  if (!isTranslationDialect(manifest.surface)) {
    throw new Error(`${dir}/manifest.json surface is not supported: ${manifest.surface}`);
  }
  if (!["native", "translated", "unsupported"].includes(manifest.mode)) {
    throw new Error(`${dir}/manifest.json mode is not supported: ${manifest.mode}`);
  }
  if (manifest.targetDialect !== undefined && !isTranslationDialect(manifest.targetDialect)) {
    throw new Error(`${dir}/manifest.json targetDialect is not supported: ${manifest.targetDialect}`);
  }
  if (manifest.mode === "translated" && manifest.targetDialect === undefined) {
    throw new Error(`${dir}/manifest.json translated fixtures must set targetDialect`);
  }
  return manifest as HarnessFixtureManifest;
}

function readRequiredJson(dir: string, name: string) {
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`Missing harness fixture file: ${path}`);
  return parseJson(path);
}

function readOptionalJson(dir: string, name: string) {
  const path = join(dir, name);
  if (!existsSync(path)) return undefined;
  const value = parseJson(path);
  assertRecord(value, path);
  return value;
}

function readOptionalJsonArray(dir: string, name: string) {
  const path = join(dir, name);
  if (!existsSync(path)) return undefined;
  const value = parseJson(path);
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function readOptionalText(dir: string, name: string) {
  const path = join(dir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function parseJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON harness fixture file: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFixtureProfileId(value: string): value is HarnessCompatibilityProfileId {
  return HARNESS_COMPATIBILITY_PROFILE_IDS.includes(value as HarnessCompatibilityProfileId);
}

function isTranslationDialect(value: unknown): value is TranslationDialect {
  return typeof value === "string" &&
    TRANSLATION_COMPATIBILITY_DIALECTS.includes(value as TranslationDialect);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function normalizeSse(value: string) {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function normalizeJson(value: unknown, volatilePaths: readonly string[]) {
  if (volatilePaths.length === 0) return value;
  const copy = JSON.parse(JSON.stringify(value));
  for (const path of volatilePaths) replacePath(copy, path.split("."));
  return copy;
}

function replacePath(value: unknown, path: string[]): void {
  if (path.length === 0 || !value || typeof value !== "object") return;
  const [head, ...tail] = path;
  if (!head) return;
  if (Array.isArray(value)) {
    if (head === "*") {
      for (const item of value) replacePath(item, tail);
      return;
    }
    const index = Number(head);
    if (Number.isInteger(index)) replacePath(value[index], tail);
    return;
  }
  const record = value as Record<string, unknown>;
  if (tail.length === 0) {
    if (head in record) record[head] = "<volatile>";
    return;
  }
  replacePath(record[head], tail);
}
