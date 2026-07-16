import type { AppPersistence } from "../context.js";
import { builder } from "../builder.js";
import type { SettingsPayload } from "../settingsPayload.js";
import type { CompressionRuleCatalogEntry } from "../../toolResultCompression.js";

export type PromptCaptureConfigModel = Awaited<
  ReturnType<AppPersistence["promptArtifacts"]["configure"]>
>;

type PromptCaptureStateModel = SettingsPayload["promptCapture"];
type StorageInfoModel = SettingsPayload["storage"];
type EditableSettingsModel = SettingsPayload["settings"];
type CostBaselineSettingsModel = EditableSettingsModel["costBaseline"];
type ToolResultCompressionPolicySettingsModel = EditableSettingsModel["toolResultCompressionPolicy"];

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

export const CostBaselineSettings = builder
  .objectRef<CostBaselineSettingsModel>("CostBaselineSettings")
  .implement({
    fields: (t) => ({
      anthropicMessagesModel: t.exposeString("anthropicMessagesModel"),
      openaiResponsesModel: t.exposeString("openaiResponsesModel"),
      openaiChatModel: t.exposeString("openaiChatModel")
    })
  });

export const ToolResultCompressionPolicySettings = builder
  .objectRef<ToolResultCompressionPolicySettingsModel>("ToolResultCompressionPolicySettings")
  .implement({
    fields: (t) => ({
      mode: t.exposeString("mode"),
      minOriginalBytes: t.exposeInt("minOriginalBytes", { nullable: true }),
      minSavingsTokens: t.exposeInt("minSavingsTokens", { nullable: true }),
      enabledRules: t.field({
        type: ["String"],
        resolve: (policy) => policy.enabledRules ?? []
      }),
      storeOriginalArtifact: t.exposeBoolean("storeOriginalArtifact", { nullable: true }),
      storeCompressedArtifact: t.exposeBoolean("storeCompressedArtifact", { nullable: true })
    })
  });

export const CompressionRuleCatalog = builder
  .objectRef<CompressionRuleCatalogEntry>("CompressionRuleCatalog")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      displayName: t.exposeString("displayName"),
      version: t.exposeInt("version"),
      classification: t.exposeString("classification"),
      supportedSurfaces: t.exposeStringList("supportedSurfaces"),
      eligibleToolNames: t.exposeStringList("eligibleToolNames"),
      minOriginalBytes: t.exposeInt("minOriginalBytes"),
      minSavingsTokens: t.exposeInt("minSavingsTokens"),
      knownRisks: t.exposeStringList("knownRisks")
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
      toolResultCompressionPolicy: t.expose("toolResultCompressionPolicy", { type: ToolResultCompressionPolicySettings }),
      duplicateToolResultReferences: t.exposeBoolean("duplicateToolResultReferences"),
      costBaseline: t.expose("costBaseline", { type: CostBaselineSettings }),
      promptCapture: t.expose("promptCapture", { type: PromptCaptureState })
    })
  });

export const Settings = builder.objectRef<SettingsPayload>("Settings").implement({
  fields: (t) => ({
    organizationId: t.exposeString("organizationId"),
    databaseEnabled: t.exposeBoolean("databaseEnabled"),
    promptCapture: t.expose("promptCapture", { type: PromptCaptureState }),
    storage: t.expose("storage", { type: StorageInfo }),
    restartRequiredFor: t.exposeStringList("restartRequiredFor"),
    settings: t.expose("settings", { type: EditableSettings }),
    file: t.field({ type: "JSON", resolve: (payload) => payload.file }),
    defaults: t.field({ type: "JSON", resolve: (payload) => payload.defaults })
  })
});

// Field optionality intentionally mirrors proxySettingsSchema: the zod schema
// in src/settings.ts remains the validator of record, so any subset that REST
// previously accepted still reaches it (invalid values come back as
// BAD_USER_INPUT with zod issues, exactly like the old PATCH endpoint).
export const PromptCaptureSettingsInput = builder.inputType("PromptCaptureSettingsInput", {
  fields: (t) => ({
    promptCaptureMode: t.string(),
    retentionDays: t.int()
  })
});

// All dialects travel together so a partial input cannot silently reset an
// omitted dialect. Empty string clears that dialect back to its default model.
export const CostBaselineSettingsInput = builder.inputType("CostBaselineSettingsInput", {
  fields: (t) => ({
    anthropicMessagesModel: t.string({ required: true }),
    openaiResponsesModel: t.string({ required: true }),
    openaiChatModel: t.string({ required: true })
  })
});

export const ToolResultCompressionPolicyInput = builder.inputType("ToolResultCompressionPolicyInput", {
  fields: (t) => ({
    mode: t.string(),
    minOriginalBytes: t.int(),
    minSavingsTokens: t.int(),
    enabledRules: t.field({ type: ["String"] }),
    storeOriginalArtifact: t.boolean(),
    storeCompressedArtifact: t.boolean()
  })
});

export const SettingsInput = builder.inputType("SettingsInput", {
  fields: (t) => ({
    schemaVersion: t.int(),
    systemPrompt: t.string(),
    cacheTtlUpgrade: t.boolean(),
    automaticCaching: t.boolean(),
    toolResultCompressionPolicy: t.field({ type: ToolResultCompressionPolicyInput }),
    duplicateToolResultReferences: t.boolean(),
    costBaseline: t.field({ type: CostBaselineSettingsInput }),
    promptCapture: t.field({ type: PromptCaptureSettingsInput })
  })
});
