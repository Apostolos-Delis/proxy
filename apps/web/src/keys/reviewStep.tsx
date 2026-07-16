import { ClipboardCheck } from "lucide-react";

import type { AccessProfileSummary } from "../routing/data";
import { GlassCard } from "../ui";
import { harnessSetupLabel } from "./setupSnippets";
import { WizardStepHead } from "./stepHead";
import type { CreateKeyDraft } from "./wizard";

export function ReviewStep({ draft, profiles }: {
  draft: CreateKeyDraft;
  profiles: AccessProfileSummary[];
}) {
  const accessProfile = profiles.find((profile) => profile.id === draft.accessProfileId);
  return (
    <GlassCard>
      <WizardStepHead
        icon={<ClipboardCheck />}
        title="Review & create"
        sub="The key secret is generated once and stored as a hash."
      />
      <dl className="wizard-review">
        <div>
          <dt>Name</dt>
          <dd>{draft.name.trim()}</dd>
        </div>
        <div>
          <dt>Harness setup</dt>
          <dd>{harnessSetupLabel(draft.harnesses)}</dd>
        </div>
        <div>
          <dt>Access profile</dt>
          <dd>{accessProfile?.name ?? draft.accessProfileId}</dd>
        </div>
        <div>
          <dt>Setup model</dt>
          <dd>{accessProfile?.setupModel ?? "Unavailable"}</dd>
        </div>
      </dl>
    </GlassCard>
  );
}
