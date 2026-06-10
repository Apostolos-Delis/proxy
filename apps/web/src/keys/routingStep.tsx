import { GitBranch, KeySquare } from "lucide-react";

import type { ProviderAccountSummary, ProviderName } from "../providers/data";
import { PROVIDER_OPTIONS } from "../providers";
import type { RoutingConfigSummary } from "../routing/data";
import { MenuSelect } from "../table/MenuSelect";
import { GlassCard } from "../ui";
import type { CreateKeyDraft } from "./wizard";

export function RoutingStep({ draft, configs, providerAccounts, onChange }: {
  draft: CreateKeyDraft;
  configs: RoutingConfigSummary[];
  providerAccounts: ProviderAccountSummary[];
  onChange: (draft: CreateKeyDraft) => void;
}) {
  return (
    <>
      <GlassCard>
        <div className="card-head">
          <div>
            <div className="card-title"><GitBranch />Routing config</div>
            <div className="faint">Controls which models each route tier uses for traffic on this key.</div>
          </div>
        </div>
        <div className="wizard-step-body">
          <label className="routing-create-field wizard-name-field">
            <span>Routing config</span>
            <MenuSelect
              value={draft.routingConfigId ?? ""}
              options={[
                { value: "", label: "Organization default" },
                ...configs.map((config) => ({ value: config.id, label: config.name }))
              ]}
              ariaLabel="Routing config"
              onChange={(routingConfigId) => onChange({ ...draft, routingConfigId: routingConfigId || null })}
            />
          </label>
        </div>
      </GlassCard>
      <GlassCard>
        <div className="card-head">
          <div>
            <div className="card-title"><KeySquare />Provider keys</div>
            <div className="faint">Bill this key's upstream traffic to your own provider credentials instead of the platform key.</div>
          </div>
        </div>
        <div className="wizard-step-body wizard-provider-grid">
          {PROVIDER_OPTIONS.map((provider) => (
            <ProviderBindingField
              key={provider.value}
              provider={provider}
              accounts={providerAccounts.filter(
                (account) => account.provider === provider.value && account.status === "active"
              )}
              value={draft.providerBindings[provider.value]}
              onChange={(providerAccountId) => onChange({
                ...draft,
                providerBindings: { ...draft.providerBindings, [provider.value]: providerAccountId }
              })}
            />
          ))}
        </div>
      </GlassCard>
    </>
  );
}

function ProviderBindingField({ provider, accounts, value, onChange }: {
  provider: { value: ProviderName; label: string };
  accounts: ProviderAccountSummary[];
  value: string | null;
  onChange: (providerAccountId: string | null) => void;
}) {
  return (
    <div className="routing-create-field">
      <span>{provider.label}</span>
      <MenuSelect
        value={value ?? ""}
        options={[
          { value: "", label: "Company default" },
          ...accounts.map((account) => ({
            value: account.id,
            label: `${account.name} (${account.secretHint ?? "customer key"})`
          }))
        ]}
        ariaLabel={`${provider.label} provider key`}
        onChange={(providerAccountId) => onChange(providerAccountId || null)}
      />
      {accounts.length === 0 ? <span className="faint">No {provider.value} keys added — the platform key is used.</span> : null}
    </div>
  );
}
