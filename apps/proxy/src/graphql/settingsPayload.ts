import { defaultCompressionPolicy, type PromptCaptureMode } from "@proxy/schema";

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
    promptCapture
  };
  return {
    organizationId,
    databaseEnabled: Boolean(config.databaseUrl),
    promptCapture,
    storage: {
      format: "json",
      path: config.settingsPath,
      reason: "The repo already uses JSON package/config conventions and has no YAML parser dependency."
    },
    restartRequiredFor: [],
    settings,
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
