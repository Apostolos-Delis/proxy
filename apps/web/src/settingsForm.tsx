import { FileJson, RotateCcw, Save, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { InfoTip, NumberField, SelectField, SettingsSection, TextAreaField, TextField, ToggleField } from "./settingsFields";
import { validate, visibleGroups, type EditableSettings } from "./settingsPageData";
import { Badge, GlassCard } from "./ui";

const routeOptions = [
  { value: "", label: "No limit" },
  { value: "fast", label: "fast" },
  { value: "balanced", label: "balanced" },
  { value: "hard", label: "hard" },
  { value: "deep", label: "deep" }
];

const promptCaptureOptions = [
  { value: "none", label: "None" },
  { value: "hash_only", label: "Hash only" },
  { value: "redacted", label: "Redacted" },
  { value: "raw_text", label: "Raw text" },
  { value: "encrypted_raw", label: "Encrypted raw" }
];

export function SettingsForm({
  initial,
  databaseEnabled,
  storagePath,
  storageReason,
  restartRequiredFor,
  activeSessions,
  activeWindowMs,
  saving,
  justSaved,
  saveError,
  onSave
}: {
  initial: EditableSettings;
  databaseEnabled: boolean;
  storagePath: string;
  storageReason: string;
  restartRequiredFor: string[];
  activeSessions: number | null;
  activeWindowMs: number | null;
  saving: boolean;
  justSaved: boolean;
  saveError?: string;
  onSave: (settings: EditableSettings) => void;
}) {
  const [settings, setSettings] = useState(initial);
  const [search, setSearch] = useState("");
  const validation = validate(settings);
  const groups = useMemo(() => visibleGroups(search), [search]);
  const dirty = JSON.stringify(settings) !== JSON.stringify(initial);
  // Compare trimmed: the save path trims, so a whitespace-only change is a
  // no-op that does not actually shift the cached prefix.
  const systemPromptEdited = (settings.systemPrompt ?? "").trim() !== (initial.systemPrompt ?? "").trim();

  return (
    <form className="settings-layout" onSubmit={(event) => {
      event.preventDefault();
      if (dirty && validation.length === 0) onSave(settings);
    }}>
      <GlassCard className="settings-toolbar">
        <div className="input settings-search">
          <Search />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search settings..." aria-label="Search settings" />
        </div>
        <div className="settings-actions">
          {saveStatus(dirty, justSaved)}
          <button className="btn btn-ghost" type="button" disabled={!dirty} onClick={() => setSettings(initial)}><RotateCcw />Reset</button>
          <button className="btn btn-primary" type="submit" disabled={!dirty || saving || validation.length > 0}><Save />{saving ? "Saving" : "Save"}</button>
        </div>
      </GlassCard>

      {validation.concat(saveError ? [saveError] : []).map((message) => (
        <div key={message} className="settings-error">{message}</div>
      ))}

      <div className="settings-sections">
        {databaseEnabled && groups.includes("system") ? (
          <SettingsSection title="System Prompt" description="Prepended to the harness system prompt on every proxied request, across all routing configs. Leave empty to forward harness prompts unchanged.">
            <TextAreaField
              label="Organization system prompt"
              info="Stored on organization settings and applied immediately to every routed request: prepended to OpenAI instructions and Anthropic system blocks ahead of harness prompts."
              value={settings.systemPrompt ?? ""}
              placeholder="Organization-wide guidance injected ahead of every model request."
              onChange={(value) => setSettings({ ...settings, systemPrompt: value })}
            />
            {systemPromptEdited && activeSessions !== null && activeSessions > 0 ? (
              <div className="settings-warning">
                Editing the system prompt shifts the front of every cached prefix.
                {" "}
                <strong>{activeSessions}</strong> {activeSessions === 1 ? "session" : "sessions"} active in the
                {" "}{windowLabel(activeWindowMs)} as of page load will pay a full cache rebuild on the next request.
              </div>
            ) : null}
          </SettingsSection>
        ) : null}

        {databaseEnabled && groups.includes("optimization") ? (
          <SettingsSection title="Token Optimization" description="Request transforms that cut token spend on proxied traffic. Applied org-wide across all routing configs.">
            <ToggleField
              label="Upgrade cache TTL to 1 hour"
              info="Anthropic only. Rewrites ephemeral cache breakpoints to a 1-hour TTL. Costs 2x to write vs 1.25x for the 5-minute default, but breaks even at 3 reads — worth it when sessions have idle gaps past 5 minutes."
              checked={settings.cacheTtlUpgrade}
              onChange={(value) => setSettings({ ...settings, cacheTtlUpgrade: value })}
            />
            <ToggleField
              label="Compress MCP tool results"
              info="Strips insignificant whitespace from pretty-printed JSON returned by MCP tools before forwarding. Lossless — numbers, nulls, keys, and ordering are preserved exactly; only formatting whitespace is removed. Reduces tokens on MCP-heavy sessions."
              checked={settings.toolResultCompression}
              onChange={(value) => setSettings({ ...settings, toolResultCompression: value })}
            />
          </SettingsSection>
        ) : null}

        {databaseEnabled && groups.includes("baseline") ? (
          <SettingsSection title="Cost Baseline" description="The no-routing counterfactual behind baseline cost and savings: what each request would have cost if it had gone straight to this model. Requests that pin an explicit route tier are baselined against that tier's model instead.">
            <TextField
              label="Anthropic baseline model"
              info="Anthropic-surface traffic is re-priced against this model to compute baseline cost. Use the model your engineers would run without the proxy. The model must have pricing configured on the Models page."
              value={settings.costBaseline.anthropicModel}
              onChange={(value) => setSettings({ ...settings, costBaseline: { ...settings.costBaseline, anthropicModel: value } })}
            />
            <TextField
              label="OpenAI baseline model"
              info="OpenAI-surface traffic is re-priced against this model to compute baseline cost. Use the model your engineers would run without the proxy. The model must have pricing configured on the Models page."
              value={settings.costBaseline.openaiModel}
              onChange={(value) => setSettings({ ...settings, costBaseline: { ...settings.costBaseline, openaiModel: value } })}
            />
          </SettingsSection>
        ) : null}

        {groups.includes("classifier") ? (
          <SettingsSection title="Classifier" description="The LLM call that picks a route for each request." restartRequired={restartRequiredFor.includes("classifier")}>
            <TextField
              label="Model"
              info="Model that classifies each request to choose a route. Called with structured output through the OpenAI Responses API."
              value={settings.classifier.model}
              onChange={(value) => setSettings({ ...settings, classifier: { ...settings.classifier, model: value } })}
            />
            <NumberField
              label="Timeout"
              info="Time limit for each classification attempt. Attempts that exceed it are aborted and retried."
              suffix="ms"
              value={settings.classifier.timeoutMs}
              min={1}
              max={30000}
              onChange={(value) => setSettings({ ...settings, classifier: { ...settings.classifier, timeoutMs: value ?? 10000 } })}
            />
            <NumberField
              label="Max attempts"
              info="Classification attempts before the request falls back to the balanced route."
              value={settings.classifier.maxAttempts}
              min={1}
              max={5}
              onChange={(value) => setSettings({ ...settings, classifier: { ...settings.classifier, maxAttempts: value ?? 1 } })}
            />
            <ToggleField
              label="Allow redacted excerpt"
              info="Sends a ~1,000-character excerpt of the prompt (emails and API keys masked, harness boilerplate stripped) to the classifier model so it can judge complexity from actual content. When off, the classifier only sees metadata — length, tool count, keyword hints — which is more private but routes less accurately."
              checked={settings.classifier.allowRedactedExcerpt}
              onChange={(value) => setSettings({ ...settings, classifier: { ...settings.classifier, allowRedactedExcerpt: value } })}
            />
          </SettingsSection>
        ) : null}

        {groups.includes("budgets") ? (
          <SettingsSection title="Budgets" description="Request-size guardrails enforced by routing policy." restartRequired={restartRequiredFor.includes("budgets")}>
            <NumberField
              label="Warning input tokens"
              info="Records a budget warning when a request's estimated input tokens exceed this value. The request still proceeds."
              placeholder="No limit"
              value={settings.budgets.warningEstimatedInputTokens}
              min={1}
              onChange={(value) => setSettings({ ...settings, budgets: { ...settings.budgets, warningEstimatedInputTokens: value } })}
            />
            <NumberField
              label="Max input tokens"
              info="Rejects requests whose estimated input tokens exceed this value."
              placeholder="No limit"
              value={settings.budgets.maxEstimatedInputTokens}
              min={1}
              onChange={(value) => setSettings({ ...settings, budgets: { ...settings.budgets, maxEstimatedInputTokens: value } })}
            />
            <SelectField
              label="Max route"
              info="Caps routing at this route tier (fast < balanced < hard < deep). Requests routed above the cap are rejected."
              value={settings.budgets.maxRoute ?? ""}
              options={routeOptions}
              onChange={(value) => setSettings({ ...settings, budgets: { ...settings.budgets, maxRoute: value || null } })}
            />
          </SettingsSection>
        ) : null}

        {groups.includes("prompt") ? (
          <SettingsSection title="Prompt Capture" description="What the proxy persists from each prompt." restartRequired={restartRequiredFor.includes("promptCapture")}>
            <SelectField
              label="Capture mode"
              info="How much prompt text is stored per request: nothing, a hash fingerprint, a redacted copy, full raw text, or encrypted raw text."
              value={settings.promptCapture.promptCaptureMode}
              options={promptCaptureOptions}
              onChange={(value) => setSettings({ ...settings, promptCapture: { ...settings.promptCapture, promptCaptureMode: value } })}
            />
            <NumberField
              label="Retention"
              info="Days before captured prompt text is redacted by the retention sweep. 0 redacts immediately."
              suffix="days"
              value={settings.promptCapture.retentionDays}
              min={0}
              onChange={(value) => setSettings({ ...settings, promptCapture: { ...settings.promptCapture, retentionDays: value ?? 0 } })}
            />
          </SettingsSection>
        ) : null}

        {groups.includes("quality") ? (
          <SettingsSection title="Route Quality" description="Thresholds used by operations reporting." restartRequired={restartRequiredFor.includes("routeQuality")}>
            <NumberField
              label="Low confidence threshold"
              info="Classifier decisions below this confidence are counted as low-confidence in route quality reporting. Reporting only — routing is unaffected."
              value={settings.routeQuality.lowConfidenceThreshold}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => setSettings({ ...settings, routeQuality: { lowConfidenceThreshold: value ?? 0 } })}
            />
          </SettingsSection>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <div className="settings-empty">No settings match &ldquo;{search.trim()}&rdquo;.</div>
      ) : null}

      <div className="settings-storage">
        <FileJson />
        <span className="mono">{storagePath}</span>
        <InfoTip text={`Settings persist to this JSON file on the proxy host. ${storageReason}`} />
      </div>
    </form>
  );
}

function windowLabel(windowMs: number | null) {
  const minutes = Math.round((windowMs ?? 5 * 60 * 1000) / 60000);
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `last ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `last ${minutes} minutes`;
}

function saveStatus(dirty: boolean, justSaved: boolean) {
  if (dirty) return <Badge variant="warn" dot>Unsaved changes</Badge>;
  if (justSaved) return <Badge variant="success" dot>Saved</Badge>;
  return null;
}
