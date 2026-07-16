import type { SettingsViewQuery } from "./gql/graphql";

export type EditableSettings = SettingsViewQuery["settings"]["settings"];

type RowBase = {
  id: string;
  label: string;
  desc: string;
};

type ToggleRow = RowBase & {
  type: "toggle";
  get: (settings: EditableSettings) => boolean;
  set: (settings: EditableSettings, value: boolean) => EditableSettings;
};

type TextRow = RowBase & {
  type: "text";
  mono?: boolean;
  get: (settings: EditableSettings) => string;
  set: (settings: EditableSettings, value: string) => EditableSettings;
};

type TextAreaRow = RowBase & {
  type: "textarea";
  placeholder?: string;
  get: (settings: EditableSettings) => string;
  set: (settings: EditableSettings, value: string) => EditableSettings;
};

type NumberRow = RowBase & {
  type: "number";
  min: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  get: (settings: EditableSettings) => number | null;
  set: (settings: EditableSettings, value: number | null) => EditableSettings;
};

type SelectRow = RowBase & {
  type: "select";
  options: readonly { value: string; label: string }[];
  get: (settings: EditableSettings) => string;
  set: (settings: EditableSettings, value: string) => EditableSettings;
};

export type SettingRowDef = ToggleRow | TextRow | TextAreaRow | NumberRow | SelectRow;

export type SettingsSectionDef = {
  id: string;
  title: string;
  description: string;
  requiresDatabase?: boolean;
  restartKey?: string;
  rows: SettingRowDef[];
};

const promptCaptureOptions = [
  { value: "none", label: "None" },
  { value: "hash_only", label: "Hash only" },
  { value: "redacted", label: "Redacted" },
  { value: "raw_text", label: "Raw text" },
  { value: "encrypted_raw", label: "Encrypted raw" }
] as const;

const defaultCompressionRules = [
  "mcp-json-whitespace",
  "json-whitespace",
  "bash-output-noise",
  "shell-command-lossy-summary"
] as const;

function toolResultCompressionPolicy(settings: EditableSettings, enabled: boolean) {
  return {
    ...settings.toolResultCompressionPolicy,
    mode: enabled ? "compress_lossless" : "disabled",
    minOriginalBytes: settings.toolResultCompressionPolicy.minOriginalBytes ?? 512,
    minSavingsTokens: settings.toolResultCompressionPolicy.minSavingsTokens ?? 0,
    enabledRules: settings.toolResultCompressionPolicy.enabledRules.length > 0
      ? settings.toolResultCompressionPolicy.enabledRules
      : [...defaultCompressionRules],
    storeOriginalArtifact: settings.toolResultCompressionPolicy.storeOriginalArtifact ?? false,
    storeCompressedArtifact: settings.toolResultCompressionPolicy.storeCompressedArtifact ?? false
  };
}

export const settingsSections: SettingsSectionDef[] = [
  {
    id: "system",
    title: "System prompt",
    description: "Prepended ahead of harness prompts for new sessions and sessionless requests.",
    requiresDatabase: true,
    rows: [
      {
        id: "systemPrompt",
        type: "textarea",
        label: "Organization system prompt",
        desc: "Prepended to OpenAI instructions and Anthropic system blocks ahead of harness prompts. Active harness sessions keep the prompt they first used; leave empty to forward harness prompts unchanged.",
        placeholder: "e.g. Prefer TypeScript examples. Never include customer PII in completions.",
        get: (settings) => settings.systemPrompt ?? "",
        set: (settings, value) => ({ ...settings, systemPrompt: value })
      }
    ]
  },
  {
    id: "optimization",
    title: "Token optimization",
    description: "Request transforms that cut token spend on proxied traffic. Applied organization-wide. OpenAI API prompt caching is provider-managed; explicit prompt_cache_retention values are forwarded to public OpenAI upstreams when clients send them.",
    requiresDatabase: true,
    rows: [
      {
        id: "automaticCaching",
        type: "toggle",
        label: "Auto-enable prompt caching",
        desc: "Anthropic only. Adds the top-level automatic-caching field to requests that arrive without any cache breakpoints, so the API caches and reuses the growing conversation prefix. Applied only to multi-turn requests, so one-shot prompts never pay the cache-write surcharge. Requests that already set cache_control are left untouched.",
        get: (settings) => settings.automaticCaching,
        set: (settings, value) => ({ ...settings, automaticCaching: value })
      },
      {
        id: "cacheTtlUpgrade",
        type: "toggle",
        label: "Adapt cache TTL to 1 hour",
        desc: "Anthropic only. Lets large multi-turn requests upgrade ephemeral cache breakpoints to a 1-hour TTL after recent org reuse data shows idle gaps that 1-hour caching can recover. One-shot, small, and low-reuse requests stay on the default TTL.",
        get: (settings) => settings.cacheTtlUpgrade,
        set: (settings, value) => ({ ...settings, cacheTtlUpgrade: value })
      },
      {
        id: "toolResultCompression",
        type: "toggle",
        label: "Compress MCP tool results",
        desc: "Strips insignificant whitespace from pretty-printed JSON returned by MCP tools before forwarding. Lossless — numbers, nulls, keys, and ordering are preserved exactly. Reduces tokens on MCP-heavy sessions.",
        get: (settings) => settings.toolResultCompressionPolicy.mode !== "disabled",
        set: (settings, value) => ({ ...settings, toolResultCompressionPolicy: toolResultCompressionPolicy(settings, value) })
      },
      {
        id: "duplicateToolResultReferences",
        type: "toggle",
        label: "Reference duplicate tool results",
        desc: "Replaces later exact duplicate tool-result payloads with a deterministic hash reference when the earlier content is still present in the forwarded context. Requires tool-result compression to be enabled.",
        get: (settings) => settings.duplicateToolResultReferences,
        set: (settings, value) => ({ ...settings, duplicateToolResultReferences: value })
      }
    ]
  },
  {
    id: "baseline",
    title: "Cost baseline",
    description: "The counterfactual behind baseline cost and savings: what each request would have cost if it had gone directly to this upstream model.",
    requiresDatabase: true,
    rows: [
      {
        id: "anthropicMessagesBaselineModel",
        type: "text",
        mono: true,
        label: "Anthropic Messages baseline model",
        desc: "Anthropic Messages traffic is re-priced against this upstream model to compute baseline cost. Its deployment must have pricing configured.",
        get: (settings) => settings.costBaseline.anthropicMessagesModel,
        set: (settings, value) => ({ ...settings, costBaseline: { ...settings.costBaseline, anthropicMessagesModel: value } })
      },
      {
        id: "openaiResponsesBaselineModel",
        type: "text",
        mono: true,
        label: "OpenAI Responses baseline model",
        desc: "OpenAI Responses traffic is re-priced against this upstream model to compute baseline cost. Its deployment must have pricing configured.",
        get: (settings) => settings.costBaseline.openaiResponsesModel,
        set: (settings, value) => ({ ...settings, costBaseline: { ...settings.costBaseline, openaiResponsesModel: value } })
      },
      {
        id: "openaiChatBaselineModel",
        type: "text",
        mono: true,
        label: "OpenAI Chat baseline model",
        desc: "OpenAI Chat Completions traffic is re-priced against this upstream model to compute baseline cost. Its deployment must have pricing configured.",
        get: (settings) => settings.costBaseline.openaiChatModel,
        set: (settings, value) => ({ ...settings, costBaseline: { ...settings.costBaseline, openaiChatModel: value } })
      }
    ]
  },
  {
    id: "capture",
    title: "Prompt capture",
    description: "What the proxy persists from each prompt.",
    rows: [
      {
        id: "promptCaptureMode",
        type: "select",
        label: "Capture mode",
        desc: "How much prompt text is stored per request: nothing, a hash fingerprint, a redacted copy, full raw text, or encrypted raw text.",
        options: promptCaptureOptions,
        get: (settings) => settings.promptCapture.promptCaptureMode,
        set: (settings, value) => ({ ...settings, promptCapture: { ...settings.promptCapture, promptCaptureMode: value } })
      },
      {
        id: "promptRetentionDays",
        type: "number",
        label: "Retention",
        desc: "Days before captured prompt text is redacted by the retention sweep. 0 redacts immediately.",
        unit: "days",
        min: 0,
        get: (settings) => settings.promptCapture.retentionDays,
        set: (settings, value) => ({ ...settings, promptCapture: { ...settings.promptCapture, retentionDays: value ?? 0 } })
      }
    ]
  }
];

export function sectionsFor(databaseEnabled: boolean) {
  return settingsSections.filter((section) => databaseEnabled || !section.requiresDatabase);
}

export function filterSections(sections: SettingsSectionDef[], search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return sections;
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => `${section.title} ${row.label} ${row.desc}`.toLowerCase().includes(needle))
    }))
    .filter((section) => section.rows.length > 0);
}

export function rowChanged(row: SettingRowDef, settings: EditableSettings, initial: EditableSettings) {
  return !Object.is(row.get(settings), row.get(initial));
}

export function changedRowIds(sections: SettingsSectionDef[], settings: EditableSettings, initial: EditableSettings) {
  return sections.flatMap((section) => section.rows.filter((row) => rowChanged(row, settings, initial)).map((row) => row.id));
}

export function restartPending(
  sections: SettingsSectionDef[],
  restartRequiredFor: string[],
  settings: EditableSettings,
  initial: EditableSettings
) {
  return sections.some(
    (section) =>
      section.restartKey !== undefined &&
      restartRequiredFor.includes(section.restartKey) &&
      section.rows.some((row) => rowChanged(row, settings, initial))
  );
}

export function settingsInput(settings: EditableSettings) {
  return {
    schemaVersion: settings.schemaVersion,
    systemPrompt: settings.systemPrompt,
    cacheTtlUpgrade: settings.cacheTtlUpgrade,
    automaticCaching: settings.automaticCaching,
    toolResultCompressionPolicy: {
      mode: settings.toolResultCompressionPolicy.mode,
      minOriginalBytes: settings.toolResultCompressionPolicy.minOriginalBytes,
      minSavingsTokens: settings.toolResultCompressionPolicy.minSavingsTokens,
      enabledRules: settings.toolResultCompressionPolicy.enabledRules,
      storeOriginalArtifact: settings.toolResultCompressionPolicy.storeOriginalArtifact,
      storeCompressedArtifact: settings.toolResultCompressionPolicy.storeCompressedArtifact
    },
    duplicateToolResultReferences: settings.duplicateToolResultReferences,
    costBaseline: {
      anthropicMessagesModel: settings.costBaseline.anthropicMessagesModel,
      openaiResponsesModel: settings.costBaseline.openaiResponsesModel,
      openaiChatModel: settings.costBaseline.openaiChatModel
    },
    promptCapture: {
      promptCaptureMode: settings.promptCapture.promptCaptureMode,
      retentionDays: settings.promptCapture.retentionDays
    }
  };
}

export function validate(settings: EditableSettings) {
  const errors: string[] = [];
  if (!settings.costBaseline.anthropicMessagesModel.trim()) errors.push("Anthropic Messages baseline model is required.");
  if (!settings.costBaseline.openaiResponsesModel.trim()) errors.push("OpenAI Responses baseline model is required.");
  if (!settings.costBaseline.openaiChatModel.trim()) errors.push("OpenAI Chat baseline model is required.");
  if (settings.promptCapture.retentionDays < 0) errors.push("Prompt retention must be zero or more days.");
  return errors;
}
