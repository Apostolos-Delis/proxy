import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HARNESS_COMPATIBILITY_PROFILE_IDS,
  TRANSLATION_COMPATIBILITY_DIALECTS,
  type HarnessCompatibilityProfileId,
  type TranslationDialect
} from "@proxy/schema";

export type HarnessFixtureMode = "native" | "translated" | "unsupported";

export type HarnessFixtureManifestSummary = {
  profileId: HarnessCompatibilityProfileId;
  caseId: string;
  surface: TranslationDialect;
  targetDialect?: TranslationDialect;
  mode: HarnessFixtureMode;
};

export type HarnessFixtureCounts = Record<HarnessCompatibilityProfileId, number>;

export type HarnessFixturePath = {
  profileId: HarnessCompatibilityProfileId;
  surface: TranslationDialect;
  targetDialect: TranslationDialect;
  nativeSupport: boolean;
  translatedSupport: boolean;
};

export function harnessFixtureCounts(root = defaultHarnessFixtureRoot()): HarnessFixtureCounts {
  const counts = emptyFixtureCounts();
  for (const manifest of listHarnessFixtureManifests(root)) {
    counts[manifest.profileId] += 1;
  }
  return counts;
}

export function listHarnessFixtureManifests(root = defaultHarnessFixtureRoot()): HarnessFixtureManifestSummary[] {
  if (!root || !isDirectory(root)) return [];
  const manifests: HarnessFixtureManifestSummary[] = [];
  for (const profileId of readdirSync(root)) {
    if (!isHarnessProfileId(profileId)) continue;
    const profileDir = join(root, profileId);
    if (!isDirectory(profileDir)) continue;
    for (const caseId of readdirSync(profileDir)) {
      const caseDir = join(profileDir, caseId);
      const manifestPath = join(caseDir, "manifest.json");
      if (!isDirectory(caseDir) || !existsSync(manifestPath)) continue;
      manifests.push(readManifest(manifestPath, profileId, caseId));
    }
  }
  return manifests;
}

export function harnessFixtureCountForPath(
  path: HarnessFixturePath,
  fixtures: readonly HarnessFixtureManifestSummary[]
) {
  if (path.nativeSupport) {
    return fixtures.filter((fixture) =>
      fixture.profileId === path.profileId &&
      fixture.mode === "native"
    ).length;
  }
  if (path.translatedSupport) {
    return fixtures.filter((fixture) =>
      fixture.profileId === path.profileId &&
      fixture.mode === "translated" &&
      fixture.surface === path.surface &&
      fixture.targetDialect === path.targetDialect
    ).length;
  }
  return 0;
}

export function defaultHarnessFixtureRoot() {
  return [
    fileURLToPath(new URL("../test/fixtures/harnesses", import.meta.url)),
    fileURLToPath(new URL("../../test/fixtures/harnesses", import.meta.url)),
    resolve(process.cwd(), "apps/proxy/test/fixtures/harnesses"),
    resolve(process.cwd(), "test/fixtures/harnesses")
  ].find(isDirectory);
}

function emptyFixtureCounts() {
  return Object.fromEntries(
    HARNESS_COMPATIBILITY_PROFILE_IDS.map((profileId) => [profileId, 0])
  ) as HarnessFixtureCounts;
}

function isHarnessProfileId(value: string): value is HarnessCompatibilityProfileId {
  return HARNESS_COMPATIBILITY_PROFILE_IDS.includes(value as HarnessCompatibilityProfileId);
}

function readManifest(
  path: string,
  profileId: HarnessCompatibilityProfileId,
  caseId: string
): HarnessFixtureManifestSummary {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (manifest.profileId !== profileId) throw new Error(`${path} profileId must match ${profileId}`);
  if (manifest.caseId !== caseId) throw new Error(`${path} caseId must match ${caseId}`);
  if (!isTranslationDialect(manifest.surface)) throw new Error(`${path} surface is not supported: ${String(manifest.surface)}`);
  if (!isFixtureMode(manifest.mode)) throw new Error(`${path} mode is not supported: ${String(manifest.mode)}`);
  if (manifest.targetDialect !== undefined && !isTranslationDialect(manifest.targetDialect)) {
    throw new Error(`${path} targetDialect is not supported: ${String(manifest.targetDialect)}`);
  }
  if (manifest.mode === "translated" && manifest.targetDialect === undefined) {
    throw new Error(`${path} translated fixtures must set targetDialect`);
  }
  return {
    profileId,
    caseId,
    surface: manifest.surface,
    targetDialect: manifest.targetDialect,
    mode: manifest.mode
  };
}

function isTranslationDialect(value: unknown): value is TranslationDialect {
  return typeof value === "string" &&
    TRANSLATION_COMPATIBILITY_DIALECTS.includes(value as TranslationDialect);
}

function isFixtureMode(value: unknown): value is HarnessFixtureMode {
  return value === "native" || value === "translated" || value === "unsupported";
}

function isDirectory(path: string | undefined): path is string {
  if (!path) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
