import { KeyRound } from "lucide-react";

import type { AccessProfileSummary, LogicalModelOption } from "./data";
import { SearchSelect } from "../table/SearchSelect";
import { Badge, GlassCard, Segmented } from "../ui";
import { WizardStepHead } from "./stepHead";
import type { CreateKeyDraft } from "./wizard";

export function AccessStep({ draft, models, profiles, onChange }: {
  draft: CreateKeyDraft;
  models: LogicalModelOption[];
  profiles: AccessProfileSummary[];
  onChange: (draft: CreateKeyDraft) => void;
}) {
  return (
    <GlassCard>
      <WizardStepHead
        icon={<KeyRound />}
        title="Name & model access"
        sub="Name the key after the workload that will hold it, then choose which logical models it may call."
      />
      <div className="wizard-step-body">
        <label className="inline-form-field wizard-name-field">
          <span>Name</span>
          <input
            value={draft.name}
            placeholder="CI harness key"
            autoComplete="off"
            maxLength={256}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </label>
        <div className="inline-form-field wizard-name-field">
          <span>Model access</span>
          <Segmented
            options={[
              { value: "models", label: "Pick models" },
              { value: "profile", label: "Existing access profile" }
            ]}
            value={draft.accessKind}
            onChange={(accessKind) => onChange({ ...draft, accessKind })}
          />
        </div>
        {draft.accessKind === "models" ? (
          <div className="scope-options" role="group" aria-label="Models">
            <span className="scope-options-label">
              The key can request only the models checked here; a matching access profile is created with it.
            </span>
            {models.map((model) => (
              <label key={model.id} className="scope-option">
                <input
                  type="checkbox"
                  checked={draft.modelIds.includes(model.id)}
                  onChange={(event) => onChange({
                    ...draft,
                    modelIds: event.target.checked
                      ? [...draft.modelIds, model.id]
                      : draft.modelIds.filter((id) => id !== model.id)
                  })}
                />
                <span className="mono">{model.slug}</span>
                <Badge variant={model.kind === "router" ? "accent" : undefined}>
                  {model.kind === "router" ? "auto-router" : "direct"}
                </Badge>
                <span className="faint">{model.description ?? model.name}</span>
              </label>
            ))}
            {models.length === 0 ? <span className="faint">No logical models configured.</span> : null}
          </div>
        ) : (
          <div className="inline-form-field wizard-name-field">
            <span>Access profile</span>
            <SearchSelect
              value={draft.accessProfileId}
              options={profiles.map((profile) => ({
                value: profile.id,
                label: profile.name,
                hint: profile.description ?? `${profile.slug} · ${profile.setupModel}`
              }))}
              ariaLabel="Access profile"
              placeholder="Search access profiles..."
              onChange={(accessProfileId) => onChange({ ...draft, accessProfileId })}
            />
          </div>
        )}
      </div>
    </GlassCard>
  );
}
