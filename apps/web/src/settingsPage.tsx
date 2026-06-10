import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Save, Search, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import { type EditableSettings, fetchSettings, updateSettings } from "./api";
import { MenuSelect } from "./table/MenuSelect";
import { Badge, GlassCard, PageState, PageTitle } from "./ui";

const routeOptions = ["", "fast", "balanced", "hard", "deep"] as const;
const promptCaptureOptions = ["none", "hash_only", "redacted", "raw_text", "encrypted_raw"] as const;

export function SettingsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });
  const mutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: (data) => queryClient.setQueryData(["settings"], data)
  });

  if (query.isLoading) return <PageState title="Settings" label="Loading organization settings" />;
  if (query.error) return <PageState title="Settings" label={query.error.message} />;
  if (!query.data) return <PageState title="Settings" label="No settings data" />;

  return (
    <div className="page page-enter">
      <PageTitle
        title="Settings"
        subtitle={`Persistent JSON settings for ${query.data.organizationId}.`}
        actions={<Badge variant={query.data.databaseEnabled ? "success" : "warn"} dot>{query.data.databaseEnabled ? "Database on" : "File only"}</Badge>}
      />
      <SettingsForm
        key={JSON.stringify(query.data.settings)}
        initial={query.data.settings}
        storagePath={query.data.storage.path}
        storageReason={query.data.storage.reason}
        restartRequiredFor={query.data.restartRequiredFor}
        saving={mutation.isPending}
        saveError={mutation.error?.message}
        onSave={(settings) => mutation.mutate(settings)}
      />
    </div>
  );
}

function SettingsForm({
  initial,
  storagePath,
  storageReason,
  restartRequiredFor,
  saving,
  saveError,
  onSave
}: {
  initial: EditableSettings;
  storagePath: string;
  storageReason: string;
  restartRequiredFor: string[];
  saving: boolean;
  saveError?: string;
  onSave: (settings: EditableSettings) => void;
}) {
  const [settings, setSettings] = useState(initial);
  const [search, setSearch] = useState("");
  const validation = validate(settings);
  const groups = useMemo(() => visibleGroups(search), [search]);

  return (
    <form className="settings-layout" onSubmit={(event) => {
      event.preventDefault();
      if (validation.length === 0) onSave(settings);
    }}>
      <GlassCard className="settings-toolbar">
        <div className="input settings-search">
          <Search />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search settings..." aria-label="Search settings" />
        </div>
        <div className="settings-meta">
          <SlidersHorizontal />
          <span className="mono">{storagePath}</span>
        </div>
        <div className="settings-actions">
          <button className="btn btn-ghost" type="button" onClick={() => setSettings(initial)}><RotateCcw />Reset</button>
          <button className="btn btn-primary" type="submit" disabled={saving || validation.length > 0}><Save />{saving ? "Saving" : "Save"}</button>
        </div>
      </GlassCard>

      <div className="settings-note">
        <span>{storageReason}</span>
        <span>Restart required for {restartRequiredFor.join(", ")} changes.</span>
      </div>

      {validation.concat(saveError ? [saveError] : []).map((message) => (
        <div key={message} className="settings-error">{message}</div>
      ))}

      <div className="settings-sections">
        {groups.includes("classifier") ? (
          <SettingsSection title="Classifier" description="Structured routing classifier controls.">
            <TextField label="Model" value={settings.classifier.model} onChange={(value) => setSettings({ ...settings, classifier: { ...settings.classifier, model: value } })} />
            <NumberField label="Timeout" suffix="ms" value={settings.classifier.timeoutMs} min={1} max={30000} onChange={(value) => setSettings({ ...settings, classifier: { ...settings.classifier, timeoutMs: value ?? 1500 } })} />
            <NumberField label="Max attempts" value={settings.classifier.maxAttempts} min={1} max={5} onChange={(value) => setSettings({ ...settings, classifier: { ...settings.classifier, maxAttempts: value ?? 1 } })} />
            <ToggleField label="Allow redacted excerpt" checked={settings.classifier.allowRedactedExcerpt} onChange={(value) => setSettings({ ...settings, classifier: { ...settings.classifier, allowRedactedExcerpt: value } })} />
          </SettingsSection>
        ) : null}

        {groups.includes("budgets") ? (
          <SettingsSection title="Budgets" description="Request-size guardrails used by routing policy.">
            <NumberField label="Warning input tokens" value={settings.budgets.warningEstimatedInputTokens} min={1} onChange={(value) => setSettings({ ...settings, budgets: { ...settings.budgets, warningEstimatedInputTokens: value } })} />
            <NumberField label="Max input tokens" value={settings.budgets.maxEstimatedInputTokens} min={1} onChange={(value) => setSettings({ ...settings, budgets: { ...settings.budgets, maxEstimatedInputTokens: value } })} />
            <SelectField label="Max route" value={settings.budgets.maxRoute ?? ""} options={routeOptions} onChange={(value) => setSettings({ ...settings, budgets: { ...settings.budgets, maxRoute: value || null } })} />
          </SettingsSection>
        ) : null}

        {groups.includes("prompt") ? (
          <SettingsSection title="Prompt Capture" description="Persistence policy for captured prompt artifacts.">
            <SelectField label="Capture mode" value={settings.promptCapture.promptCaptureMode} options={promptCaptureOptions} onChange={(value) => setSettings({ ...settings, promptCapture: { ...settings.promptCapture, promptCaptureMode: value } })} />
            <NumberField label="Retention" suffix="days" value={settings.promptCapture.retentionDays} min={0} onChange={(value) => setSettings({ ...settings, promptCapture: { ...settings.promptCapture, retentionDays: value ?? 0 } })} />
          </SettingsSection>
        ) : null}

        {groups.includes("quality") ? (
          <SettingsSection title="Route Quality" description="Thresholds used by operations reporting.">
            <NumberField label="Low confidence threshold" value={settings.routeQuality.lowConfidenceThreshold} min={0} max={1} step={0.01} onChange={(value) => setSettings({ ...settings, routeQuality: { lowConfidenceThreshold: value ?? 0 } })} />
          </SettingsSection>
        ) : null}
      </div>
    </form>
  );
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <GlassCard className="settings-section">
      <div className="settings-section-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="settings-fields">{children}</div>
    </GlassCard>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberField({ label, value, min, max, step = 1, suffix, onChange }: {
  label: string;
  value: number | null;
  min: number;
  max?: number;
  step?: number;
  suffix?: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <div className="settings-number">
        <input type="number" value={value ?? ""} min={min} max={max} step={step} onChange={(event) => onChange(numberOrNull(event.target.value))} />
        {suffix ? <em>{suffix}</em> : null}
      </div>
    </label>
  );
}

function SelectField<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (value: T) => void }) {
  return (
    <div className="settings-field">
      <span>{label}</span>
      <MenuSelect
        value={value}
        options={options.map((option) => ({ value: option, label: option || "No limit" }))}
        ariaLabel={label}
        onChange={(next) => onChange(next as T)}
      />
    </div>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="settings-toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function numberOrNull(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function visibleGroups(search: string) {
  const groups = [
    { key: "classifier", terms: "classifier model timeout attempts redacted excerpt structured routing" },
    { key: "budgets", terms: "budgets warning max input tokens route guardrails policy" },
    { key: "prompt", terms: "prompt capture retention raw text hash redacted encrypted artifacts" },
    { key: "quality", terms: "quality confidence threshold route reporting" }
  ];
  const needle = search.trim().toLowerCase();
  if (!needle) return groups.map((group) => group.key);
  return groups
    .filter((group) => `${group.key} ${group.terms}`.includes(needle))
    .map((group) => group.key);
}

function validate(settings: EditableSettings) {
  const errors: string[] = [];
  if (!settings.classifier.model.trim()) errors.push("Classifier model is required.");
  if (settings.classifier.timeoutMs < 1 || settings.classifier.timeoutMs > 30000) errors.push("Classifier timeout must be between 1 and 30000 ms.");
  if (settings.classifier.maxAttempts < 1 || settings.classifier.maxAttempts > 5) errors.push("Classifier attempts must be between 1 and 5.");
  if (settings.routeQuality.lowConfidenceThreshold < 0 || settings.routeQuality.lowConfidenceThreshold > 1) errors.push("Low confidence threshold must be between 0 and 1.");
  if (settings.promptCapture.retentionDays < 0) errors.push("Prompt retention must be zero or more days.");
  return errors;
}
