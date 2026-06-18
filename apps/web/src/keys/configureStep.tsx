import { KeyRound } from "lucide-react";

import { GlassCard } from "../ui";
import { harnessSetupOptions } from "./setupSnippets";
import { WizardStepHead } from "./stepHead";
import type { CreateKeyDraft } from "./wizard";

export function ConfigureStep({ draft, onChange }: {
  draft: CreateKeyDraft;
  onChange: (draft: CreateKeyDraft) => void;
}) {
  return (
    <GlassCard>
      <WizardStepHead
        icon={<KeyRound />}
        title="Name & harnesses"
        sub="Name the key after the workload that will hold it, then choose the harness setup snippets to generate."
      />
      <div className="wizard-step-body">
        <label className="routing-create-field wizard-name-field">
          <span>Name</span>
          <input
            value={draft.name}
            placeholder="CI harness key"
            autoComplete="off"
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </label>
        <div className="scope-options" role="group" aria-label="Harness setup">
          <span className="scope-options-label">Harness setup</span>
          {harnessSetupOptions.map((target) => (
            <label key={target.value} className="scope-option">
              <input
                type="checkbox"
                checked={draft.harnesses.includes(target.value)}
                onChange={(event) => onChange({
                  ...draft,
                  harnesses: harnessSetupOptions
                    .map((option) => option.value)
                    .filter((value) => value === target.value ? event.target.checked : draft.harnesses.includes(value))
                })}
              />
              <span>{target.label}</span>
              <span className="faint">{target.description}</span>
            </label>
          ))}
        </div>
      </div>
    </GlassCard>
  );
}
