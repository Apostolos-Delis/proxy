import type { SettingsViewQuery } from "./gql/graphql";

export type EditableSettings = SettingsViewQuery["settings"]["settings"];

export function settingsInput(settings: EditableSettings) {
  return {
    schemaVersion: settings.schemaVersion,
    systemPrompt: settings.systemPrompt,
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
    },
    consoleAgent: {
      model: settings.consoleAgent.model,
      thinkingLevel: settings.consoleAgent.thinkingLevel,
      maxTurns: settings.consoleAgent.maxTurns,
      maxToolCallsPerTurn: settings.consoleAgent.maxToolCallsPerTurn,
      timeoutSeconds: settings.consoleAgent.timeoutSeconds
    }
  };
}

export function visibleGroups(search: string) {
  const groups = [
    { key: "system", terms: "system prompt organization injected harness model requests" },
    { key: "classifier", terms: "classifier model timeout attempts redacted excerpt structured routing" },
    { key: "budgets", terms: "budgets warning max input tokens route guardrails policy limit" },
    { key: "prompt", terms: "prompt capture retention raw text hash redacted encrypted artifacts" },
    { key: "quality", terms: "quality confidence threshold route reporting" },
    { key: "consoleAgent", terms: "console agent copilot model thinking level turns tool calls timeout limits" }
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
  if (!settings.consoleAgent.model.trim()) errors.push("Console agent model is required.");
  if (settings.consoleAgent.maxTurns < 1 || settings.consoleAgent.maxTurns > 100) errors.push("Console agent max turns must be between 1 and 100.");
  if (settings.consoleAgent.maxToolCallsPerTurn < 1 || settings.consoleAgent.maxToolCallsPerTurn > 50) errors.push("Console agent max tool calls must be between 1 and 50.");
  if (settings.consoleAgent.timeoutSeconds < 1 || settings.consoleAgent.timeoutSeconds > 3600) errors.push("Console agent timeout must be between 1 and 3600 seconds.");
  return errors;
}
