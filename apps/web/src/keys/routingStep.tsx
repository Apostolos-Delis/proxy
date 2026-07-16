import { ShieldCheck } from "lucide-react";

import type { AccessProfileSummary } from "../routing/data";
import { SearchSelect } from "../table/SearchSelect";
import { GlassCard } from "../ui";
import { WizardStepHead } from "./stepHead";
import type { CreateKeyDraft } from "./wizard";

export function RoutingStep({ draft, profiles, onChange }: {
  draft: CreateKeyDraft;
  profiles: AccessProfileSummary[];
  onChange: (draft: CreateKeyDraft) => void;
}) {
  return (
    <GlassCard>
      <WizardStepHead
        icon={<ShieldCheck />}
        title="Access profile"
        sub="Controls which logical models and operations this key can use."
      />
      <div className="wizard-step-body">
        <div className="routing-create-field wizard-name-field">
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
      </div>
    </GlassCard>
  );
}
