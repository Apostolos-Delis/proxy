import type { HarnessCompatibilityProfileId, TranslationDialect } from "@prompt-proxy/schema";

import { harnessCompatibilityReport, type HarnessCompatibilitySupport } from "./harnessCompatibilityReport.js";
import {
  harnessFixtureCountForPath,
  listHarnessFixtureManifests,
  type HarnessFixtureManifestSummary
} from "./harnessFixtureCounts.js";

export type HarnessSmokePathStatus = {
  profileId: HarnessCompatibilityProfileId;
  displayName: string;
  surface: TranslationDialect;
  targetDialect: TranslationDialect;
  support: HarnessCompatibilitySupport;
  status: "passed" | "missing_fixture" | "not_required";
  fixtureCount: number;
  coverageRequired: boolean;
};

export type RealHarnessSmokeStatus = {
  harness: "codex" | "claude-code";
  status: "passed" | "failed" | "skipped";
  reason?: string;
};

export type HarnessSmokeStatusArtifact = {
  generatedAt: string;
  paths: HarnessSmokePathStatus[];
  realHarnesses: RealHarnessSmokeStatus[];
};

export function buildHarnessSmokeStatusArtifact(input?: {
  fixtures?: readonly HarnessFixtureManifestSummary[];
  realHarnesses?: readonly RealHarnessSmokeStatus[];
  generatedAt?: string;
}): HarnessSmokeStatusArtifact {
  const fixtures = input?.fixtures ?? listHarnessFixtureManifests();
  return {
    generatedAt: input?.generatedAt ?? new Date().toISOString(),
    paths: harnessCompatibilityReport({ fixtures }).filter((row) =>
      row.nativeSupport || row.translatedSupport
    ).map((row) => {
      const fixtureCount = harnessFixtureCountForPath(row, fixtures);
      const coverageRequired = coverageRequiredFor(row.profileId, row.support);
      return {
        profileId: row.profileId,
        displayName: row.displayName,
        surface: row.surface,
        targetDialect: row.targetDialect,
        support: row.support,
        status: fixtureStatus(fixtureCount, coverageRequired),
        fixtureCount,
        coverageRequired
      };
    }),
    realHarnesses: [...(input?.realHarnesses ?? [])]
  };
}

export function missingRequiredHarnessFixtures(artifact: HarnessSmokeStatusArtifact) {
  return artifact.paths.filter((path) => path.coverageRequired && path.status === "missing_fixture");
}

function coverageRequiredFor(profileId: HarnessCompatibilityProfileId, support: HarnessCompatibilitySupport) {
  if (support === "translated") return true;
  return profileId !== "generic-openai-responses" &&
    profileId !== "generic-anthropic-messages";
}

function fixtureStatus(fixtureCount: number, coverageRequired: boolean): HarnessSmokePathStatus["status"] {
  if (fixtureCount > 0) return "passed";
  return coverageRequired ? "missing_fixture" : "not_required";
}
