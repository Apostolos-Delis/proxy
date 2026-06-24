import {
  TRANSLATION_COMPATIBILITY_DIALECTS,
  harnessCompatibilityForTarget,
  type HarnessCompatibilityProfileId,
  type TranslationCompatibilityReason,
  type TranslationCompatibilityStatus,
  type TranslationDialect,
  type TranslationPair
} from "@proxy/schema";

import {
  harnessFixtureCountForPath,
  listHarnessFixtureManifests,
  type HarnessFixtureManifestSummary
} from "./harnessFixtureCounts.js";
import { harnessProfileByName, harnessSurfaceProfiles, type HarnessName } from "./harness.js";

export type HarnessCompatibilitySupport = "native" | "translated" | "blocked" | "unsupported";

export type HarnessSmokeStatusModel = {
  status: string;
  checkedAt?: string | null;
  detail?: string | null;
};

export type HarnessCompatibilityMatrixRow = {
  profileId: HarnessCompatibilityProfileId;
  displayName: string;
  harness: HarnessName;
  surface: TranslationDialect;
  transport: "http" | "websocket";
  targetDialect: TranslationDialect;
  effectiveDialect?: TranslationDialect | null;
  translatedFrom: TranslationDialect;
  translatedTo?: TranslationDialect | null;
  status: TranslationCompatibilityStatus;
  support: HarnessCompatibilitySupport;
  nativeSupport: boolean;
  translatedSupport: boolean;
  statefulFeatures: readonly string[];
  unsupportedStatefulFeatures: readonly string[];
  reasonCodes: readonly string[];
  testedFixtureCount: number;
  lastSmokeStatus?: HarnessSmokeStatusModel | null;
};

export function harnessCompatibilityReport(input?: {
  fixtures?: readonly HarnessFixtureManifestSummary[];
  lastSmokeStatuses?: Partial<Record<HarnessCompatibilityProfileId, HarnessSmokeStatusModel | null>>;
  targetDialects?: readonly TranslationDialect[];
  availableTranslators?: readonly TranslationPair[];
}): HarnessCompatibilityMatrixRow[] {
  const fixtures = input?.fixtures ?? listHarnessFixtureManifests();
  const targetDialects = input?.targetDialects ?? TRANSLATION_COMPATIBILITY_DIALECTS;

  return harnessSurfaceProfiles.flatMap((profile) =>
    targetDialects.map((targetDialect) => {
      const harness = harnessProfileByName(profile.harness);
      const result = harnessCompatibilityForTarget({
        profileId: profile.id,
        surface: profile.dialect,
        transport: profile.transport,
        statefulResponses: harness.statefulResponses,
        hasPreviousResponseId: false,
        unsupportedFields: [],
        targetDialects: [targetDialect],
        availableTranslators: input?.availableTranslators
      });
      const support = compatibilitySupport(result.status, result.reason);

      return {
        profileId: profile.id,
        displayName: profile.displayName,
        harness: profile.harness,
        surface: profile.dialect,
        transport: profile.transport,
        targetDialect,
        effectiveDialect: result.dialect ?? result.to ?? null,
        translatedFrom: result.from,
        translatedTo: result.to ?? null,
        status: result.status,
        support,
        nativeSupport: support === "native",
        translatedSupport: support === "translated",
        statefulFeatures: profile.statefulFeatures,
        unsupportedStatefulFeatures: profile.unsupportedTranslatedFeatures,
        reasonCodes: result.reason ? [result.reason] : [],
        testedFixtureCount: harnessFixtureCountForPath({
          profileId: profile.id,
          surface: profile.dialect,
          targetDialect,
          nativeSupport: support === "native",
          translatedSupport: support === "translated"
        }, fixtures),
        lastSmokeStatus: input?.lastSmokeStatuses?.[profile.id] ?? null
      };
    })
  );
}

function compatibilitySupport(
  status: TranslationCompatibilityStatus,
  reason: TranslationCompatibilityReason | undefined
): HarnessCompatibilitySupport {
  if (status === "native") return "native";
  if (status === "translated") return "translated";
  if (
    reason === "stateful_translation_unavailable" ||
    reason === "previous_response_translation_unavailable" ||
    reason === "websocket_native_only" ||
    reason === "unsupported_field"
  ) {
    return "blocked";
  }
  return "unsupported";
}
