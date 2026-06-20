import { defaultCompressionPolicy, type PromptCaptureMode } from "@prompt-proxy/schema";

import type { AppConfig } from "../config.js";
import { defaultCostBaseline } from "../pricing.js";
import { emptyProxySettings, type ProxySettings } from "../settings.js";
import type { AppPersistence } from "./context.js";

export async function settingsResponse(
  config: AppConfig,
  organizationId: string,
  fileSettings: ProxySettings,
  persistence: AppPersistence | undefined
) {
  const promptCapture = persistence
    ? await persistence.promptArtifacts.settings(organizationId)
    : {
        promptCaptureMode: fileSettings.promptCapture.promptCaptureMode ?? "raw_text",
        retentionDays: fileSettings.promptCapture.retentionDays ?? 30
      };
  const editable = persistence
    ? await persistence.organizationSettings.editable(organizationId)
    : {
        systemPrompt: null,
        cacheTtlUpgrade: false,
        automaticCaching: false,
        toolResultCompressionPolicy: defaultCompressionPolicy(),
        duplicateToolResultReferences: false,
        costBaseline: {
          anthropicMessagesModel: defaultCostBaseline["anthropic-messages"],
          openaiResponsesModel: defaultCostBaseline["openai-responses"],
          openaiChatModel: defaultCostBaseline["openai-chat"]
        }
      };
  const settings = {
    schemaVersion: 1,
    systemPrompt: editable.systemPrompt,
    cacheTtlUpgrade: editable.cacheTtlUpgrade,
    automaticCaching: editable.automaticCaching,
    toolResultCompressionPolicy: editable.toolResultCompressionPolicy,
    duplicateToolResultReferences: editable.duplicateToolResultReferences,
    costBaseline: editable.costBaseline,
    classifier: {
      model: fileSettings.classifier.model ?? config.classifierModel,
      timeoutMs: fileSettings.classifier.timeoutMs ?? config.classifierTimeoutMs,
      maxAttempts: fileSettings.classifier.maxAttempts ?? config.classifierMaxAttempts,
      allowRedactedExcerpt: fileSettings.classifier.allowRedactedExcerpt ?? config.classifierAllowRedactedExcerpt
    },
    routeQuality: {
      lowConfidenceThreshold: fileSettings.routeQuality.lowConfidenceThreshold ?? config.routeQualityLowConfidenceThreshold
    },
    promptCapture
  };
  return {
    organizationId,
    databaseEnabled: Boolean(config.databaseUrl),
    subscriptionOAuthEnabled: config.subscriptionOAuthEnabled,
    classifier: {
      provider: config.classifierProvider,
      model: config.classifierModel,
      timeoutMs: config.classifierTimeoutMs,
      maxAttempts: config.classifierMaxAttempts,
      contentMode: config.classifierAllowRedactedExcerpt ? "redacted_excerpt" : "features_only"
    },
    promptCapture,
    storage: {
      format: "json",
      path: config.settingsPath,
      reason: "The repo already uses JSON package/config conventions and has no YAML parser dependency."
    },
    restartRequiredFor: ["classifier", "routeQuality"],
    settings,
    runtime: {
      classifier: {
        provider: config.classifierProvider,
        model: config.classifierModel,
        timeoutMs: config.classifierTimeoutMs,
        maxAttempts: config.classifierMaxAttempts,
        contentMode: config.classifierAllowRedactedExcerpt ? "redacted_excerpt" : "features_only"
      }
    },
    file: fileSettings,
    defaults: emptyProxySettings
  };
}

export type SettingsPayload = Awaited<ReturnType<typeof settingsResponse>>;

export function promptCaptureSettings(input: { promptCaptureMode: string; retentionDays: number }) {
  const { promptCaptureMode, retentionDays } = input;
  if (
    promptCaptureMode !== "none" &&
    promptCaptureMode !== "hash_only" &&
    promptCaptureMode !== "raw_text" &&
    promptCaptureMode !== "redacted" &&
    promptCaptureMode !== "encrypted_raw"
  ) {
    throw badRequest("invalid_prompt_capture_mode");
  }
  if (retentionDays < 0) {
    throw badRequest("invalid_retention_days");
  }
  return {
    promptCaptureMode: promptCaptureMode as PromptCaptureMode,
    retentionDays
  };
}

function badRequest(message: string) {
  const error = new Error(message);
  (error as Error & { statusCode: number }).statusCode = 400;
  return error;
}
