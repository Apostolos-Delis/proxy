import type { SettingsViewQuery } from "./gql/graphql";

export type EditableSettings = SettingsViewQuery["settings"]["settings"];

export function settingsInput(settings: EditableSettings) {
  return {
    schemaVersion: settings.schemaVersion,
    systemPrompt: settings.systemPrompt,
    cacheTtlUpgrade: settings.cacheTtlUpgrade,
    classifier: {
      model: settings.classifier.model,
      timeoutMs: settings.classifier.timeoutMs,
      maxAttempts: settings.classifier.maxAttempts,
      allowRedactedExcerpt: settings.classifier.allowRedactedExcerpt
    },
    budgets: {
      warningEstimatedInputTokens: settings.budgets.warningEstimatedInputTokens,
      maxEstimatedInputTokens: settings.budgets.maxEstimatedInputTokens,
      maxRoute: settings.budgets.maxRoute
    },
    routeQuality: {
      lowConfidenceThreshold: settings.routeQuality.lowConfidenceThreshold
    },
    promptCapture: {
      promptCaptureMode: settings.promptCapture.promptCaptureMode,
      retentionDays: settings.promptCapture.retentionDays
    }
  };
}

export function visibleGroups(search: string) {
  const groups = [
    { key: "system", terms: "system prompt organization injected harness model requests" },
    { key: "classifier", terms: "classifier model timeout attempts redacted excerpt structured routing" },
    { key: "budgets", terms: "budgets warning max input tokens route guardrails policy limit" },
    { key: "prompt", terms: "prompt capture retention raw text hash redacted encrypted artifacts" },
    { key: "quality", terms: "quality confidence threshold route reporting" }
  ];
  const needle = search.trim().toLowerCase();
  if (!needle) return groups.map((group) => group.key);
  return groups
    .filter((group) => `${group.key} ${group.terms}`.includes(needle))
    .map((group) => group.key);
}

export function validate(settings: EditableSettings) {
  const errors: string[] = [];
  if (!settings.classifier.model.trim()) errors.push("Classifier model is required.");
  if (settings.classifier.timeoutMs < 1 || settings.classifier.timeoutMs > 30000) errors.push("Classifier timeout must be between 1 and 30000 ms.");
  if (settings.classifier.maxAttempts < 1 || settings.classifier.maxAttempts > 5) errors.push("Classifier attempts must be between 1 and 5.");
  if (settings.routeQuality.lowConfidenceThreshold < 0 || settings.routeQuality.lowConfidenceThreshold > 1) errors.push("Low confidence threshold must be between 0 and 1.");
  if (settings.promptCapture.retentionDays < 0) errors.push("Prompt retention must be zero or more days.");
  return errors;
}
