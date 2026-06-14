import { ClipboardCheck } from "lucide-react";

import type { ProviderAccountSummary } from "../providers/data";
import type { RoutingConfigSummary } from "../routing/data";
import { GlassCard } from "../ui";
import { providerOptionsForAccounts } from "./providerOptions";
import { harnessSetupLabel } from "./setupSnippets";
import { WizardStepHead } from "./stepHead";
import { orgDefaultConfigLabel, type CreateKeyDraft } from "./wizard";

export function ReviewStep({ draft, configs, defaultConfig, providerAccounts }: {
  draft: CreateKeyDraft;
  configs: RoutingConfigSummary[];
  defaultConfig: RoutingConfigSummary | null;
  providerAccounts: ProviderAccountSummary[];
}) {
  const routingConfigName = draft.routingConfigId
    ? configs.find((config) => config.id === draft.routingConfigId)?.name ?? draft.routingConfigId
    : orgDefaultConfigLabel(defaultConfig);
  const providerOptions = providerOptionsForAccounts(providerAccounts, draft.providerBindings);
  return (
    <GlassCard>
      <WizardStepHead
        icon={<ClipboardCheck />}
        title="Review & create"
        sub="The key secret is generated once and stored as a hash — copy it right away."
      />
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
          <dt>Harness setup</dt>
          <dd>{harnessSetupLabel(draft.harness)}</dd>
        </div>
        <div>
          <dt>Routing config</dt>
          <dd>{routingConfigName}</dd>
        </div>
        {draft.linkProviderKeys ? (
          providerOptions.map((provider) => (
            <div key={provider.value}>
              <dt>{provider.label} key</dt>
              <dd>{bindingLabel(draft.providerBindings[provider.value], providerAccounts)}</dd>
            </div>
          ))
        ) : (
          <div>
            <dt>Provider keys</dt>
            <dd>Company default (platform keys)</dd>
          </div>
        )}
      </dl>
    </GlassCard>
  );
}

function bindingLabel(providerAccountId: string | null, providerAccounts: ProviderAccountSummary[]) {
  if (!providerAccountId) return "Company default";
  const account = providerAccounts.find((candidate) => candidate.id === providerAccountId);
  return account ? `${account.name} (${account.secretHint ?? "customer key"})` : providerAccountId;
}
