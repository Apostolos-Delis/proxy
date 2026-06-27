import { useState } from "react";

import { JsonEditor } from "../jsonView";
import type { RouteTargetDraft, RoutingEditorCatalog } from "../routingConfigEditor";
import { MenuSelect } from "../table/MenuSelect";
import {
  activeProviderAccounts,
  bedrockSettings,
  targetCompatibility,
  withBedrockSettings
} from "./targetCompatibility";

export function TargetControls({ target, catalog, onChange }: {
  target: RouteTargetDraft;
  catalog: RoutingEditorCatalog;
  onChange: (target: RouteTargetDraft) => void;
}) {
  const compatibility = targetCompatibility(target, catalog);
  if (!compatibility.provider) return null;
  if (compatibility.provider.adapterKind === "aws-bedrock-converse") {
    return <BedrockTargetControls target={target} catalog={catalog} onChange={onChange} />;
  }
  if (compatibility.provider.adapterKind === "generic-http-json" && !compatibility.provider.builtin) {
    return <GenericHttpTargetControls target={target} catalog={catalog} onChange={onChange} />;
  }
  return null;
}

function BedrockTargetControls({ target, catalog, onChange }: {
  target: RouteTargetDraft;
  catalog: RoutingEditorCatalog;
  onChange: (target: RouteTargetDraft) => void;
}) {
  const compatibility = targetCompatibility(target, catalog);
  const accounts = activeProviderAccounts(compatibility.providerAccounts);
  const settings = bedrockSettings(target.metadata);
  const selectedModel = compatibility.model;
  const updateSetting = (key: string, value: unknown) => {
    const nextSettings = { ...settings };
    if (typeof value === "string" && value.trim()) nextSettings[key] = value.trim();
    else if (value && typeof value === "object") nextSettings[key] = value;
    else delete nextSettings[key];
    onChange(withBedrockSettings(target, nextSettings));
  };
  return (
    <div className="route-target-controls route-target-bedrock">
      <div className="route-target-control">
        <span>Credential / region</span>
        <MenuSelect
          className="target-control-select"
          value={target.providerAccountId ?? ""}
          ariaLabel="Bedrock provider account"
          options={[
            { value: "", label: "Select account" },
            ...accounts.map((account) => ({
              value: account.id,
              label: `${account.name}${account.region ? ` · ${account.region}` : ""}`
            }))
          ]}
          onChange={(providerAccountId) => onChange({ ...target, providerAccountId: providerAccountId || undefined })}
        />
      </div>
      <LabeledInput
        label="Inference profile"
        value={stringSetting(settings.inferenceProfile) ?? stringSetting(settings.inferenceProfileId) ?? selectedModel?.bedrockInferenceProfileId ?? ""}
        onChange={(value) => updateSetting("inferenceProfile", value)}
      />
      <LabeledInput
        label="Profile geography"
        value={stringSetting(settings.inferenceProfileGeography) ?? stringSetting(settings.profileGeography) ?? selectedModel?.bedrockInferenceProfileGeography ?? ""}
        onChange={(value) => updateSetting("inferenceProfileGeography", value)}
      />
      <div className="route-target-control">
        <span>Service tier</span>
        <MenuSelect
          className="target-control-select"
          value={stringSetting(settings.serviceTier) ?? ""}
          ariaLabel="Bedrock service tier"
          options={[
            { value: "", label: "default" },
            { value: "standard", label: "standard" },
            { value: "optimized", label: "optimized" }
          ]}
          onChange={(serviceTier) => updateSetting("serviceTier", serviceTier)}
        />
      </div>
      <LabeledInput label="Guardrail ID" value={stringSetting(settings.guardrailIdentifier) ?? ""} onChange={(value) => updateSetting("guardrailIdentifier", value)} />
      <LabeledInput label="Guardrail version" value={stringSetting(settings.guardrailVersion) ?? ""} onChange={(value) => updateSetting("guardrailVersion", value)} />
      <RequestMetadataEditor
        key={`${target.providerId}:${target.model}`}
        value={settings.requestMetadata}
        onChange={(requestMetadata) => updateSetting("requestMetadata", requestMetadata)}
      />
    </div>
  );
}

function GenericHttpTargetControls({ target, catalog, onChange }: {
  target: RouteTargetDraft;
  catalog: RoutingEditorCatalog;
  onChange: (target: RouteTargetDraft) => void;
}) {
  const compatibility = targetCompatibility(target, catalog);
  const accounts = activeProviderAccounts(compatibility.providerAccounts);
  if (compatibility.provider?.authStyle === "none" && accounts.length === 0) return null;
  return (
    <div className="route-target-controls route-target-generic">
      <div className="route-target-control">
        <span>Provider account</span>
        <MenuSelect
          className="target-control-select"
          value={target.providerAccountId ?? ""}
          ariaLabel="Custom HTTP provider account"
          options={[
            { value: "", label: accounts.length > 0 ? "API key binding" : "No account" },
            ...accounts.map((account) => ({
              value: account.id,
              label: `${account.name}${account.credentialSourceCategory ? ` · ${account.credentialSourceCategory}` : ""}`
            }))
          ]}
          onChange={(providerAccountId) => onChange({ ...target, providerAccountId: providerAccountId || undefined })}
        />
      </div>
    </div>
  );
}

function LabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="route-target-control">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function RequestMetadataEditor({ value, onChange }: { value: unknown; onChange: (value: Record<string, string> | undefined) => void }) {
  const [text, setText] = useState(() => JSON.stringify(isRecord(value) ? value : {}, null, 2));
  const [error, setError] = useState<string>();
  return (
    <div className="route-target-control route-target-json-control">
      <span>Request metadata template</span>
      <JsonEditor
        value={text}
        onChange={(next) => {
          setText(next);
          const parsed = parseStringRecord(next);
          setError(parsed.error);
          if (!parsed.error) onChange(parsed.value);
        }}
      />
      {error ? <small>{error}</small> : null}
    </div>
  );
}

function parseStringRecord(text: string): { value?: Record<string, string>; error?: string } {
  if (!text.trim()) return { value: undefined };
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) return { error: "Use a JSON object." };
    const entries = Object.entries(value);
    const invalid = entries.find(([, entry]) => typeof entry !== "string");
    if (invalid) return { error: "Values must be strings." };
    return entries.length > 0 ? { value: Object.fromEntries(entries) as Record<string, string> } : { value: undefined };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid JSON." };
  }
}

function stringSetting(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
