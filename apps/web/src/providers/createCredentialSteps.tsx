import { Check, ChevronDown, ChevronRight, ClipboardCheck, KeySquare, Terminal } from "lucide-react";
import { useState } from "react";

import { WizardStepHead } from "../keys/stepHead";
import { MenuSelect } from "../table/MenuSelect";
import { Badge, GlassCard } from "../ui";
import type { ProviderName } from "./data";
import { CredentialOAuthCard, type CredentialOAuthState } from "./credentialOAuthCard";
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
  withCredentialSource,
  type CreateProviderCredentialDraft,
  type CreateProviderCredentialMode,
  type CreateProviderCredentialSource,
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
          detail="Sign in with Claude for Claude Code traffic."
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
  const browserOAuth = draft.source === "claude_oauth" || draft.source === "openai_oauth";
  const managedSubscription = fixedProvider && (draft.source === "local_auth" || browserOAuth);
  const showBaseUrl = !browserOAuth;
  const [advancedOpen, setAdvancedOpen] = useState(fixedProvider && !browserOAuth);
  const head = detailsHeadCopy(draft, browserOAuth);
  const toggleAdvanced = () => {
    const oauthSource = subscriptionOAuthSource(draft.mode);
    if (advancedOpen && !browserOAuth && oauthSource) {
      onChange(withCredentialSource(draft, oauthSource));
    }
    setAdvancedOpen((open) => !open);
  };
  return (
    <GlassCard>
      <WizardStepHead
        icon={<Terminal />}
        title={head.title}
        sub={head.sub}
      />
      <div className="wizard-step-body">
        {fixedProvider ? (
          <div className="credential-advanced">
            <button
              type="button"
              className="credential-advanced-toggle"
              aria-expanded={advancedOpen}
              disabled={oauth?.locked ?? false}
              onClick={toggleAdvanced}
            >
              {advancedOpen ? <ChevronDown /> : <ChevronRight />}
              <span>Other ways to connect</span>
            </button>
            {advancedOpen ? (
              <CredentialSourceSelector draft={draft} disabled={oauth?.locked ?? false} onChange={onChange} />
            ) : null}
          </div>
        ) : null}
        {fixedProvider && !browserOAuth && draft.mode === "claude_subscription" ? <ClaudeSetupGuide source={draft.source} /> : null}
        {fixedProvider && !browserOAuth && draft.mode === "codex_subscription" ? <CodexSetupGuide source={draft.source} /> : null}
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
          {showBaseUrl ? (
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
          ) : null}
        </div>
        {browserOAuth ? (
          <CredentialOAuthCard draft={draft} oauth={oauth} />
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

function subscriptionOAuthSource(mode: CreateProviderCredentialMode): CreateProviderCredentialSource | null {
  if (mode === "claude_subscription") return "claude_oauth";
  if (mode === "codex_subscription") return "openai_oauth";
  return null;
}

function detailsHeadCopy(draft: CreateProviderCredentialDraft, browserOAuth: boolean) {
  if (draft.mode === "claude_subscription") {
    return {
      title: "Sign in with Claude",
      sub: browserOAuth
        ? "Sign into Claude in your browser. Prompt Proxy saves the credential, then you bind it to an API key."
        : "Connect your Claude subscription so Prompt Proxy can use it for Claude Code traffic."
    };
  }
  if (draft.mode === "codex_subscription") {
    return {
      title: "Sign in with OpenAI",
      sub: browserOAuth
        ? "Authorize Codex access with OpenAI. Prompt Proxy saves the credential, then you bind it to an API key."
        : "Connect your ChatGPT (Codex) subscription so Prompt Proxy can use it for Codex traffic."
    };
  }
  return {
    title: "Credential details",
    sub: "Paste the provider secret here; it is encrypted at rest and never shown again."
  };
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
        {draft.source === "claude_oauth" || draft.source === "openai_oauth" ? null : (
          <div><dt>Base URL</dt><dd>{draft.baseUrl.trim() || "Provider default"}</dd></div>
        )}
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
