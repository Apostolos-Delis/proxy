import { GitBranch, KeySquare, Plus } from "lucide-react";
import { useState } from "react";

import { CreateProviderKeyModal } from "../createProviderKeyModal";
import type { ProviderAccountSummary, ProviderName } from "../providers/data";
import type { RoutingConfigSummary } from "../routing/data";
import { SearchSelect } from "../table/SearchSelect";
import { GlassCard } from "../ui";
import { providerCredentialHint, providerIdsForRoutingConfig, providerOptionsForAccounts } from "./providerOptions";
import { WizardStepHead } from "./stepHead";
import { orgDefaultConfigLabel, withCreatedProviderKey, withProviderKeyMode, type CreateKeyDraft } from "./wizard";

export function RoutingStep({ draft, configs, defaultConfig, providerAccounts, onChange }: {
  draft: CreateKeyDraft;
  configs: RoutingConfigSummary[];
  defaultConfig: RoutingConfigSummary | null;
  providerAccounts: ProviderAccountSummary[];
  onChange: (draft: CreateKeyDraft) => void;
}) {
  const [showAddKey, setShowAddKey] = useState(false);
  const activeAccounts = providerAccounts.filter((account) => account.status === "active");
  const selectedConfig = selectedRoutingConfig(draft.routingConfigId, configs, defaultConfig);
  const routingProviders = providerIdsForRoutingConfig(selectedConfig);
  const providerOptions = providerOptionsForAccounts(activeAccounts, draft.providerBindings, routingProviders);
  const routedProviderOptions = providerOptions.filter((provider) => routingProviders.includes(provider.value));
  const boundRoutingProviderCount = routingProviders.filter((provider) => draft.providerBindings[provider]).length;
  const hasProviderBindings = Object.values(draft.providerBindings).some(Boolean);
  const showProviderKeyControls = activeAccounts.length > 0 || draft.linkProviderKeys || hasProviderBindings;
  return (
    <>
      <GlassCard>
        <WizardStepHead
          icon={<GitBranch />}
          title="Routing config"
          sub="Controls which models each route tier uses for traffic on this key."
        />
        <div className="wizard-step-body">
          {/* A <label> here would re-trigger the select button when the
              popover backdrop (a label descendant) is clicked. */}
          <div className="routing-create-field wizard-name-field">
            <span>Routing config</span>
            <SearchSelect
              value={draft.routingConfigId ?? ""}
              options={[
                { value: "", label: orgDefaultConfigLabel(defaultConfig) },
                ...configs.map((config) => ({
                  value: config.id,
                  label: config.name,
                  hint: `v${config.activeVersion?.version ?? "?"}`
                }))
              ]}
              ariaLabel="Routing config"
              placeholder="Search routing configs…"
              onChange={(routingConfigId) => onChange({ ...draft, routingConfigId: routingConfigId || null })}
            />
          </div>
        </div>
      </GlassCard>
      <GlassCard>
        <WizardStepHead
          icon={<KeySquare />}
          title="Provider keys"
          sub="Bill this key's upstream traffic to your own provider credentials instead of the platform key."
        />
        {!showProviderKeyControls ? (
          <div className="wizard-step-body">
            <ProviderCoverageSummary providers={routedProviderOptions} />
            <div className="wizard-provider-note">
              <span className="faint">No provider credentials linked yet — this key's upstream traffic uses the platform keys.</span>
              <button type="button" className="btn btn-sm" onClick={() => setShowAddKey(true)}>
                <Plus />Add provider key
              </button>
            </div>
          </div>
        ) : (
          <div className="wizard-step-body">
            <ProviderCoverageSummary
              providers={routedProviderOptions}
              boundCount={draft.linkProviderKeys ? boundRoutingProviderCount : undefined}
            />
            <div className="scope-options" role="radiogroup" aria-label="Provider key mode">
              <label className="scope-option">
                <input
                  type="radio"
                  name="provider-key-mode"
                  checked={!draft.linkProviderKeys}
                  onChange={() => onChange(withProviderKeyMode(draft, false))}
                />
                <span>Company default</span>
                <span className="faint">Upstream traffic is billed to the platform provider credentials.</span>
              </label>
              <label className="scope-option">
                <input
                  type="radio"
                  name="provider-key-mode"
                  checked={draft.linkProviderKeys}
                  onChange={() => onChange(withProviderKeyMode(draft, true))}
                />
                <span>Use my own credentials</span>
                <span className="faint">Bill routed providers to credentials linked to the organization.</span>
              </label>
            </div>
            {draft.linkProviderKeys ? (
              <>
                <div className="wizard-provider-grid">
                  {providerOptions.map((provider) => (
                    <ProviderBindingField
                      key={provider.value}
                      provider={provider}
                      accounts={activeAccounts.filter((account) => account.provider === provider.value)}
                      value={draft.providerBindings[provider.value]}
                      onChange={(providerAccountId) => onChange({
                        ...draft,
                        providerBindings: { ...draft.providerBindings, [provider.value]: providerAccountId }
                      })}
                    />
                  ))}
                </div>
                <div>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAddKey(true)}>
                    <Plus />Add provider key
                  </button>
                </div>
              </>
            ) : null}
          </div>
        )}
      </GlassCard>
      {showAddKey ? (
        <CreateProviderKeyModal
          onClose={() => setShowAddKey(false)}
          onCreated={({ id, provider }) => onChange(withCreatedProviderKey(draft, provider, id))}
        />
      ) : null}
    </>
  );
}

function selectedRoutingConfig(
  routingConfigId: string | null,
  configs: RoutingConfigSummary[],
  defaultConfig: RoutingConfigSummary | null
) {
  if (!routingConfigId) return defaultConfig;
  return configs.find((config) => config.id === routingConfigId) ?? null;
}

function ProviderCoverageSummary({ providers, boundCount }: {
  providers: { value: ProviderName; label: string }[];
  boundCount?: number;
}) {
  if (providers.length === 0) return null;
  return (
    <div className="wizard-provider-summary">
      <span className="faint">Selected routing config can use</span>
      <div className="cell-tags">
        {providers.map((provider) => (
          <span key={provider.value} className="code-pill" title={provider.value}>{provider.label}</span>
        ))}
      </div>
      {boundCount === undefined ? null : (
        <span className="faint">{boundCount} of {providers.length} routed providers bound to your credentials.</span>
      )}
    </div>
  );
}

function ProviderBindingField({ provider, accounts, value, onChange }: {
  provider: { value: ProviderName; label: string };
  accounts: ProviderAccountSummary[];
  value: string | null;
  onChange: (providerAccountId: string | null) => void;
}) {
  const accountOptions = accounts.map((account) => ({
    value: account.id,
    label: account.name,
    hint: providerCredentialHint(account)
  }));
  return (
    <div className="routing-create-field">
      <span>{provider.label}</span>
      <SearchSelect
        value={value ?? ""}
        options={[
          { value: "", label: "Company default" },
          ...accountOptions,
          ...pendingSelectedOption(value, accountOptions)
        ]}
        ariaLabel={`${provider.label} provider key`}
        placeholder="Search provider keys…"
        onChange={(providerAccountId) => onChange(providerAccountId || null)}
      />
      {accounts.length === 0 && !value ? <span className="faint">No {provider.value} credentials added — the platform key is used.</span> : null}
    </div>
  );
}

function pendingSelectedOption(value: string | null, options: { value: string }[]) {
  if (!value || options.some((option) => option.value === value)) return [];
  return [{ value, label: "Selected provider credential", hint: "refreshing" }];
}
