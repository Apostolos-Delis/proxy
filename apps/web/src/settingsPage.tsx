import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileJson, RotateCcw, Save, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { InfoTip, NumberField, SelectField, SettingsSection, TextAreaField, TextField, ToggleField } from "./settingsFields";
import { settingsInput, validate, visibleGroups, type EditableSettings } from "./settingsPageData";
import { Badge, GlassCard, PageState, PageTitle } from "./ui";

const SettingsViewDocument = graphql(`
  query SettingsView {
    settings {
      organizationId
      databaseEnabled
      restartRequiredFor
      storage {
        path
        reason
      }
      settings {
        schemaVersion
        systemPrompt
        classifier {
          model
          timeoutMs
          maxAttempts
          allowRedactedExcerpt
        }
        budgets {
          warningEstimatedInputTokens
          maxEstimatedInputTokens
          maxRoute
        }
        routeQuality {
          lowConfidenceThreshold
        }
        promptCapture {
          promptCaptureMode
          retentionDays
        }
      }
    }
  }
`);

const UpdateSettingsDocument = graphql(`
  mutation UpdateSettings($input: SettingsInput!) {
    updateSettings(input: $input) {
      organizationId
      databaseEnabled
      restartRequiredFor
      storage {
        path
        reason
      }
      settings {
        schemaVersion
        systemPrompt
        classifier {
          model
          timeoutMs
          maxAttempts
          allowRedactedExcerpt
        }
        budgets {
          warningEstimatedInputTokens
          maxEstimatedInputTokens
          maxRoute
        }
        routeQuality {
          lowConfidenceThreshold
        }
        promptCapture {
          promptCaptureMode
          retentionDays
        }
      }
    }
  }
`);

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

export function SettingsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: async () => (await gqlFetch(SettingsViewDocument)).settings
  });
  const mutation = useMutation({
    mutationFn: async (settings: EditableSettings) =>
      (await gqlFetch(UpdateSettingsDocument, { input: settingsInput(settings) })).updateSettings,
    onSuccess: (data) => queryClient.setQueryData(["settings"], data)
  });

  if (query.isLoading) return <PageState title="Settings" label="Loading organization settings" />;
  if (query.error) return <PageState title="Settings" label={query.error.message} />;
  if (!query.data) return <PageState title="Settings" label="No settings data" />;

  return (
    <div className="page page-enter">
      <PageTitle
        title="Settings"
        subtitle={`Proxy runtime settings for ${query.data.organizationId}.`}
        actions={<Badge variant={query.data.databaseEnabled ? "success" : "warn"} dot>{query.data.databaseEnabled ? "Database on" : "File only"}</Badge>}
      />
      <SettingsForm
        key={JSON.stringify(query.data.settings)}
        initial={query.data.settings}
        databaseEnabled={query.data.databaseEnabled}
        storagePath={query.data.storage.path}
        storageReason={query.data.storage.reason}
        restartRequiredFor={query.data.restartRequiredFor}
        saving={mutation.isPending}
        justSaved={mutation.isSuccess}
        saveError={mutation.error?.message}
        onSave={(settings) => mutation.mutate(settings)}
      />
    </div>
  );
}

function SettingsForm({
  initial,
  databaseEnabled,
  storagePath,
  storageReason,
  restartRequiredFor,
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
              onChange={(value) => setSettings({ ...settings, classifier: { ...settings.classifier, timeoutMs: value ?? 1500 } })}
            />
            <NumberField
              label="Max attempts"
              info="Classification attempts before the request fails. There is no deterministic fallback route."
              value={settings.classifier.maxAttempts}
              min={1}
              max={5}
              onChange={(value) => setSettings({ ...settings, classifier: { ...settings.classifier, maxAttempts: value ?? 1 } })}
            />
            <ToggleField
              label="Allow redacted excerpt"
              info="Include a redacted excerpt of the prompt in the classifier call. When off, the classifier only sees derived features."
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

function saveStatus(dirty: boolean, justSaved: boolean) {
  if (dirty) return <Badge variant="warn" dot>Unsaved changes</Badge>;
  if (justSaved) return <Badge variant="success" dot>Saved</Badge>;
  return null;
}
