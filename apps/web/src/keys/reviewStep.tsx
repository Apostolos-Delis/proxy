import { ClipboardCheck } from "lucide-react";

import type { ProviderAccountSummary } from "../providers/data";
import { PROVIDER_OPTIONS } from "../providers";
import type { RoutingConfigSummary } from "../routing/data";
import { GlassCard } from "../ui";
import type { CreateKeyDraft } from "./wizard";

export function ReviewStep({ draft, configs, providerAccounts }: {
  draft: CreateKeyDraft;
  configs: RoutingConfigSummary[];
  providerAccounts: ProviderAccountSummary[];
}) {
  const routingConfigName = configs.find((config) => config.id === draft.routingConfigId)?.name
    ?? "Organization default";
  return (
    <GlassCard>
      <div className="card-head">
        <div>
          <div className="card-title"><ClipboardCheck />Review & create</div>
          <div className="faint">The key secret is generated once and stored as a hash — copy it right away.</div>
        </div>
      </div>
      <dl className="wizard-review">
        <div>
          <dt>Name</dt>
          <dd>{draft.name.trim()}</dd>
        </div>
        <div>
          <dt>Scopes</dt>
          <dd className="cell-tags">
            {draft.scopes.map((scope) => <span key={scope} className="code-pill">{scope}</span>)}
          </dd>
        </div>
        <div>
          <dt>Routing config</dt>
          <dd>{routingConfigName}</dd>
        </div>
        {PROVIDER_OPTIONS.map((provider) => (
          <div key={provider.value}>
            <dt>{provider.label} key</dt>
            <dd>{bindingLabel(draft.providerBindings[provider.value], providerAccounts)}</dd>
          </div>
        ))}
      </dl>
    </GlassCard>
  );
}

function bindingLabel(providerAccountId: string | null, providerAccounts: ProviderAccountSummary[]) {
  if (!providerAccountId) return "Company default";
  const account = providerAccounts.find((candidate) => candidate.id === providerAccountId);
  return account ? `${account.name} (${account.secretHint ?? "customer key"})` : providerAccountId;
}
