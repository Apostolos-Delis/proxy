import { Check, ClipboardCheck, KeySquare, Terminal } from "lucide-react";

import { WizardStepHead } from "../keys/stepHead";
import { MenuSelect } from "../table/MenuSelect";
import { Badge, GlassCard } from "../ui";
import type { ProviderName } from "./data";
import { CodexOAuthDeviceCard, type CredentialOAuthState } from "./credentialOAuthCard";
import { CredentialSourceSelector } from "./credentialSourceSelector";
import { ProviderMark } from "./icons";
import { ClaudeSetupGuide, CodexSetupGuide } from "./subscriptionCredentialGuides";
import {
  canVisitStep,
  credentialModeLabel,
  createProviderCredentialSteps,
  namePlaceholderForDraft,
  secretLabelForDraft,
  secretPlaceholderForDraft,
  sourceLabelForDraft,
  stepRailState,
  withCredentialMode,
  type CreateProviderCredentialDraft,
  type CreateProviderCredentialMode,
  type CreateProviderCredentialStepId
} from "./createCredentialWizard";

type ProviderOption = { value: ProviderName; label: string };

export function ProviderCredentialStepRail({ draft, created, onVisit }: {
  draft: CreateProviderCredentialDraft;
  created: boolean;
  onVisit: (stepId: CreateProviderCredentialStepId) => void;
}) {
  return (
    <ol className="wizard-rail provider-credential-rail">
      {createProviderCredentialSteps.map((step, index) => {
        const state = stepRailState(step.id, draft.stepId, created);
        const visitable = canVisitStep(step.id, draft, created);
        return (
          <li key={step.id}>
            <button
              type="button"
              className="wizard-rail-step"
              data-state={state}
              disabled={!visitable}
              aria-current={state === "current" ? "step" : undefined}
              onClick={() => onVisit(step.id)}
            >
              <span className="wizard-rail-marker">{state === "complete" ? <Check /> : index + 1}</span>
              <span className="wizard-rail-label">{step.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function CredentialTypeStep({ draft, subscriptionAuthEnabled, onChange }: {
  draft: CreateProviderCredentialDraft;
  subscriptionAuthEnabled: boolean;
  onChange: (draft: CreateProviderCredentialDraft) => void;
}) {
  return (
    <GlassCard>
      <WizardStepHead
        icon={<KeySquare />}
        title="Connection type"
        sub="Choose whether traffic should use a provider API key or a personal subscription credential."
      />
      <div className="credential-mode-grid">
        <ModeOption
          draft={draft}
          mode="api_key"
          title="Provider API key"
          detail="Anthropic, OpenAI, or any enabled custom provider."
          disabled={false}
          onChange={onChange}
        />
        <ModeOption
          draft={draft}
          mode="claude_subscription"
          title="Claude subscription"
          detail="Use a Claude setup-token for Claude Code traffic."
          disabled={!subscriptionAuthEnabled}
          onChange={onChange}
        />
        <ModeOption
          draft={draft}
          mode="codex_subscription"
          title="Codex subscription"
          detail="Use a ChatGPT-backed Codex access token."
          disabled={false}
          onChange={onChange}
        />
      </div>
      {!subscriptionAuthEnabled ? (
        <div className="provider-credential-note">
          <Badge variant="warn" dot>Claude subscription disabled</Badge>
          <span>Set <span className="mono">SUBSCRIPTION_OAUTH_ENABLED=true</span> on the proxy to create Claude subscription credentials.</span>
        </div>
      ) : null}
    </GlassCard>
  );
}

export function CredentialDetailsStep({ draft, providerOptions, oauth, onChange }: {
  draft: CreateProviderCredentialDraft;
  providerOptions: ProviderOption[];
  oauth?: CredentialOAuthState;
  onChange: (draft: CreateProviderCredentialDraft) => void;
}) {
  const fixedProvider = draft.mode !== "api_key";
  const managedSubscription = fixedProvider && (draft.source === "local_auth" || draft.source === "openai_oauth");
  let stepSub = "Paste the provider secret here; it is encrypted at rest and never shown again.";
  if (managedSubscription) stepSub = "Import provider auth already minted on the proxy host.";
  if (draft.source === "openai_oauth") stepSub = "Sign into OpenAI and let Prompt Proxy save the Codex credential.";
  return (
    <GlassCard>
      <WizardStepHead
        icon={<Terminal />}
        title="Credential details"
        sub={stepSub}
      />
      <div className="wizard-step-body">
        {fixedProvider ? <CredentialSourceSelector draft={draft} disabled={oauth?.locked ?? false} onChange={onChange} /> : null}
        {draft.mode === "claude_subscription" ? <ClaudeSetupGuide source={draft.source} /> : null}
        {draft.mode === "codex_subscription" ? <CodexSetupGuide source={draft.source} /> : null}
        <div className="routing-create-grid key-create-grid">
          {fixedProvider ? <FixedProviderField provider={draft.provider} /> : (
            <div className="routing-create-field">
              <span>Provider</span>
              <MenuSelect
                ariaLabel="Provider"
                value={draft.provider}
                options={providerOptions}
                onChange={(provider) => onChange({ ...draft, provider })}
              />
            </div>
          )}
          <label className="routing-create-field">
            <span>Label</span>
            <input
              value={draft.name}
              disabled={oauth?.locked ?? false}
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
              placeholder={namePlaceholderForDraft(draft)}
              autoComplete="off"
            />
          </label>
          {draft.mode === "codex_subscription" && draft.source === "manual" ? (
            <label className="routing-create-field">
              <span>ChatGPT account ID</span>
              <input
                value={draft.chatgptAccountId}
                disabled={oauth?.locked ?? false}
                onChange={(event) => onChange({ ...draft, chatgptAccountId: event.target.value })}
                placeholder="acct_..."
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : null}
          <label className="routing-create-field">
            <span>Base URL override</span>
            <input
              value={draft.baseUrl}
              disabled={oauth?.locked ?? false}
              onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
              placeholder="https://provider.example/v1"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
        {draft.mode === "codex_subscription" && draft.source === "openai_oauth" ? (
          <CodexOAuthDeviceCard draft={draft} oauth={oauth} />
        ) : null}
        {managedSubscription ? null : (
          <label className="routing-create-field">
            <span>{secretLabelForDraft(draft)}</span>
            {draft.mode === "codex_subscription" ? (
              <textarea
                value={draft.apiKey}
                onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
                placeholder={secretPlaceholderForDraft(draft)}
                autoComplete="off"
                spellCheck={false}
                rows={4}
              />
            ) : (
              <input
                value={draft.apiKey}
                onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
                placeholder={secretPlaceholderForDraft(draft)}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </label>
        )}
      </div>
    </GlassCard>
  );
}

function chatgptAccountReviewValue(draft: CreateProviderCredentialDraft) {
  if (draft.source === "openai_oauth") return "from OpenAI sign-in";
  if (draft.source === "local_auth") return "from Codex auth JSON";
  return draft.chatgptAccountId.trim() || "from auth JSON";
}

export function CredentialReviewStep({ draft }: { draft: CreateProviderCredentialDraft }) {
  return (
    <GlassCard>
      <WizardStepHead
        icon={<ClipboardCheck />}
        title="Review & create"
        sub="The secret is encrypted immediately and only a masked hint is retained."
      />
      <dl className="wizard-review">
        <div><dt>Type</dt><dd>{credentialModeLabel(draft.mode)}</dd></div>
        {draft.mode !== "api_key" ? <div><dt>Source</dt><dd>{sourceLabelForDraft(draft)}</dd></div> : null}
        <div><dt>Provider</dt><dd className="provider-credential-provider"><ProviderMark provider={draft.provider} />{draft.provider}</dd></div>
        <div><dt>Label</dt><dd>{draft.name.trim()}</dd></div>
        <div><dt>Secret</dt><dd>{secretLabelForDraft(draft)} encrypted at rest</dd></div>
        {draft.mode === "codex_subscription" ? (
          <div><dt>ChatGPT account</dt><dd>{chatgptAccountReviewValue(draft)}</dd></div>
        ) : null}
        <div><dt>Base URL</dt><dd>{draft.baseUrl.trim() || "Provider default"}</dd></div>
      </dl>
      {draft.mode !== "api_key" ? (
        <div className="provider-credential-note">
          <Badge variant="warn" dot>Owner-only binding</Badge>
          <span>Subscription credentials can only be bound to API keys owned by the same user who creates this credential.</span>
        </div>
      ) : null}
    </GlassCard>
  );
}

function ModeOption({ draft, mode, title, detail, disabled, onChange }: {
  draft: CreateProviderCredentialDraft;
  mode: CreateProviderCredentialMode;
  title: string;
  detail: string;
  disabled: boolean;
  onChange: (draft: CreateProviderCredentialDraft) => void;
}) {
  return (
    <label className={`credential-mode-option${disabled ? " disabled" : ""}`}>
      <input
        type="radio"
        name="provider-credential-mode"
        checked={draft.mode === mode}
        disabled={disabled}
        onChange={() => onChange(withCredentialMode(draft, mode))}
      />
      <strong>{title}</strong>
      <span className="faint">{detail}</span>
    </label>
  );
}

function FixedProviderField({ provider }: { provider: ProviderName }) {
  return (
    <div className="routing-create-field">
      <span>Provider</span>
      <div className="provider-credential-fixed-provider">
        <ProviderMark provider={provider} />
        <span>{provider === "anthropic" ? "Anthropic (Claude)" : "OpenAI"}</span>
      </div>
    </div>
  );
}
