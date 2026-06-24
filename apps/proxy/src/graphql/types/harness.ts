import { builder } from "../builder.js";
import type {
  HarnessCompatibilityMatrixRow,
  HarnessSmokeStatusModel
} from "../../harnessCompatibilityReport.js";

export const HarnessSmokeStatus = builder
  .objectRef<HarnessSmokeStatusModel>("HarnessSmokeStatus")
  .implement({
    fields: (t) => ({
      status: t.exposeString("status"),
      checkedAt: t.exposeString("checkedAt", { nullable: true }),
      detail: t.exposeString("detail", { nullable: true })
    })
  });

export const HarnessCompatibilityMatrixEntry = builder
  .objectRef<HarnessCompatibilityMatrixRow>("HarnessCompatibilityMatrixEntry")
  .implement({
    fields: (t) => ({
      profileId: t.exposeString("profileId"),
      displayName: t.exposeString("displayName"),
      harness: t.exposeString("harness"),
      surface: t.exposeString("surface"),
      transport: t.exposeString("transport"),
      targetDialect: t.exposeString("targetDialect"),
      effectiveDialect: t.exposeString("effectiveDialect", { nullable: true }),
      translatedFrom: t.exposeString("translatedFrom"),
      translatedTo: t.exposeString("translatedTo", { nullable: true }),
      status: t.exposeString("status"),
      support: t.exposeString("support"),
      nativeSupport: t.exposeBoolean("nativeSupport"),
      translatedSupport: t.exposeBoolean("translatedSupport"),
      statefulFeatures: t.exposeStringList("statefulFeatures"),
      unsupportedStatefulFeatures: t.exposeStringList("unsupportedStatefulFeatures"),
      reasonCodes: t.exposeStringList("reasonCodes"),
      testedFixtureCount: t.exposeInt("testedFixtureCount"),
      lastSmokeStatus: t.expose("lastSmokeStatus", {
        type: HarnessSmokeStatus,
        nullable: true
      })
    })
  });
