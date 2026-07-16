import { ClipboardCheck } from "lucide-react";

import type { AccessProfileSummary, LogicalModelOption } from "./data";
import { GlassCard } from "../ui";
import { WizardStepHead } from "./stepHead";
import type { CreateKeyDraft } from "./wizard";

export function ReviewStep({ draft, models, profiles }: {
  draft: CreateKeyDraft;
  models: LogicalModelOption[];
  profiles: AccessProfileSummary[];
}) {
  const accessProfile = profiles.find((profile) => profile.id === draft.accessProfileId);
  const selectedModels = models.filter((model) => draft.modelIds.includes(model.id));
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
          <dt>Model access</dt>
          <dd>
            {draft.accessKind === "models"
              ? selectedModels.map((model) => model.slug).join(", ")
              : `${accessProfile?.name ?? draft.accessProfileId} (existing profile)`}
          </dd>
        </div>
      </dl>
    </GlassCard>
  );
}
