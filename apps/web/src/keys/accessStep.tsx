import { KeyRound } from "lucide-react";

import type { AccessProfileSummary, LogicalModelOption } from "./data";
import { SearchMultiSelect } from "../table/SearchMultiSelect";
import { SearchSelect } from "../table/SearchSelect";
import { GlassCard, Segmented } from "../ui";
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
          <div className="scope-options model-access-picker">
            <span className="scope-options-label">
              The key can request only the models checked here; a matching access profile is created with it.
            </span>
            <SearchMultiSelect
              value={draft.modelIds}
              options={models.map((model) => ({
                value: model.id,
                label: model.slug,
                hint: model.description ?? model.name,
                badge: model.kind === "router" ? "auto-router" : "direct",
                badgeAccent: model.kind === "router"
              }))}
              ariaLabel="Logical models"
              placeholder="Search logical models…"
              emptyLabel={models.length === 0 ? "No logical models configured." : "No matching models."}
              onChange={(modelIds) => onChange({ ...draft, modelIds })}
            />
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
