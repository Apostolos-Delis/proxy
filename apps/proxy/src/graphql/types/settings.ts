import type { AppPersistence } from "../context.js";
import { builder } from "../builder.js";
import type { SettingsPayload } from "../settingsPayload.js";

export type PromptCaptureConfigModel = Awaited<
  ReturnType<AppPersistence["promptArtifacts"]["configure"]>
>;

type ClassifierRuntimeModel = SettingsPayload["classifier"];
type PromptCaptureStateModel = SettingsPayload["promptCapture"];
type StorageInfoModel = SettingsPayload["storage"];
type EditableSettingsModel = SettingsPayload["settings"];
type EditableClassifierModel = EditableSettingsModel["classifier"];
type CostBaselineSettingsModel = EditableSettingsModel["costBaseline"];
type RouteQualitySettingsModel = EditableSettingsModel["routeQuality"];
type RuntimeSettingsModel = SettingsPayload["runtime"];

export const ClassifierRuntime = builder
  .objectRef<ClassifierRuntimeModel>("ClassifierRuntime")
  .implement({
    fields: (t) => ({
      provider: t.exposeString("provider"),
      model: t.exposeString("model"),
      timeoutMs: t.exposeInt("timeoutMs"),
      maxAttempts: t.exposeInt("maxAttempts"),
      contentMode: t.exposeString("contentMode")
    })
  });

export const PromptCaptureState = builder
  .objectRef<PromptCaptureStateModel>("PromptCaptureState")
  .implement({
    fields: (t) => ({
      promptCaptureMode: t.exposeString("promptCaptureMode"),
      retentionDays: t.exposeInt("retentionDays")
    })
  });

export const PromptCaptureConfig = builder
  .objectRef<PromptCaptureConfigModel>("PromptCaptureConfig")
  .implement({
    fields: (t) => ({
      organizationId: t.exposeString("organizationId"),
      promptCaptureMode: t.exposeString("promptCaptureMode"),
      retentionDays: t.exposeInt("retentionDays")
    })
  });

export const StorageInfo = builder.objectRef<StorageInfoModel>("StorageInfo").implement({
  fields: (t) => ({
    format: t.exposeString("format"),
    path: t.exposeString("path"),
    reason: t.exposeString("reason")
  })
});

export const EditableClassifier = builder
  .objectRef<EditableClassifierModel>("EditableClassifier")
  .implement({
    fields: (t) => ({
      model: t.exposeString("model"),
      timeoutMs: t.exposeInt("timeoutMs"),
      maxAttempts: t.exposeInt("maxAttempts"),
      allowRedactedExcerpt: t.exposeBoolean("allowRedactedExcerpt")
    })
  });

export const RouteQualitySettings = builder
  .objectRef<RouteQualitySettingsModel>("RouteQualitySettings")
  .implement({
    fields: (t) => ({
      lowConfidenceThreshold: t.exposeFloat("lowConfidenceThreshold")
    })
  });

export const CostBaselineSettings = builder
  .objectRef<CostBaselineSettingsModel>("CostBaselineSettings")
  .implement({
    fields: (t) => ({
      anthropicModel: t.exposeString("anthropicModel"),
      openaiModel: t.exposeString("openaiModel")
    })
  });

export const EditableSettings = builder
  .objectRef<EditableSettingsModel>("EditableSettings")
  .implement({
    fields: (t) => ({
      schemaVersion: t.exposeInt("schemaVersion"),
      systemPrompt: t.exposeString("systemPrompt", { nullable: true }),
      cacheTtlUpgrade: t.exposeBoolean("cacheTtlUpgrade"),
      automaticCaching: t.exposeBoolean("automaticCaching"),
      toolResultCompression: t.exposeBoolean("toolResultCompression"),
      costBaseline: t.expose("costBaseline", { type: CostBaselineSettings }),
      classifier: t.expose("classifier", { type: EditableClassifier }),
      routeQuality: t.expose("routeQuality", { type: RouteQualitySettings }),
      promptCapture: t.expose("promptCapture", { type: PromptCaptureState })
    })
  });

export const RuntimeSettings = builder
  .objectRef<RuntimeSettingsModel>("RuntimeSettings")
  .implement({
    fields: (t) => ({
      classifier: t.expose("classifier", { type: ClassifierRuntime })
    })
  });

export const Settings = builder.objectRef<SettingsPayload>("Settings").implement({
  fields: (t) => ({
    organizationId: t.exposeString("organizationId"),
    databaseEnabled: t.exposeBoolean("databaseEnabled"),
    subscriptionOAuthEnabled: t.exposeBoolean("subscriptionOAuthEnabled"),
    classifier: t.expose("classifier", { type: ClassifierRuntime }),
    promptCapture: t.expose("promptCapture", { type: PromptCaptureState }),
    storage: t.expose("storage", { type: StorageInfo }),
    restartRequiredFor: t.exposeStringList("restartRequiredFor"),
    settings: t.expose("settings", { type: EditableSettings }),
    runtime: t.expose("runtime", { type: RuntimeSettings }),
    file: t.field({ type: "JSON", resolve: (payload) => payload.file }),
    defaults: t.field({ type: "JSON", resolve: (payload) => payload.defaults })
  })
});

// Field optionality intentionally mirrors proxySettingsSchema: the zod schema
// in src/settings.ts remains the validator of record, so any subset that REST
// previously accepted still reaches it (invalid values come back as
// BAD_USER_INPUT with zod issues, exactly like the old PATCH endpoint).
export const ClassifierSettingsInput = builder.inputType("ClassifierSettingsInput", {
  fields: (t) => ({
    model: t.string(),
    timeoutMs: t.int(),
    maxAttempts: t.int(),
    allowRedactedExcerpt: t.boolean()
  })
});

export const RouteQualitySettingsInput = builder.inputType("RouteQualitySettingsInput", {
  fields: (t) => ({
    lowConfidenceThreshold: t.float()
  })
});

export const PromptCaptureSettingsInput = builder.inputType("PromptCaptureSettingsInput", {
  fields: (t) => ({
    promptCaptureMode: t.string(),
    retentionDays: t.int()
  })
});

// Both surfaces travel together — requiring them prevents a partial input
// from silently resetting the omitted surface. Empty string clears that
// surface back to its default baseline model.
export const CostBaselineSettingsInput = builder.inputType("CostBaselineSettingsInput", {
  fields: (t) => ({
    anthropicModel: t.string({ required: true }),
    openaiModel: t.string({ required: true })
  })
});

export const SettingsInput = builder.inputType("SettingsInput", {
  fields: (t) => ({
    schemaVersion: t.int(),
    systemPrompt: t.string(),
    cacheTtlUpgrade: t.boolean(),
    automaticCaching: t.boolean(),
    toolResultCompression: t.boolean(),
    costBaseline: t.field({ type: CostBaselineSettingsInput }),
    classifier: t.field({ type: ClassifierSettingsInput }),
    routeQuality: t.field({ type: RouteQualitySettingsInput }),
    promptCapture: t.field({ type: PromptCaptureSettingsInput })
  })
});
