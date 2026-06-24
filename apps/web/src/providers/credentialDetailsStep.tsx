import { ChevronDown, ChevronRight, Terminal } from "lucide-react";
import { useState } from "react";

import { WizardStepHead } from "../keys/stepHead";
import { MenuSelect } from "../table/MenuSelect";
import { GlassCard } from "../ui";
import type { ProviderName } from "./data";
import { CredentialOAuthCard, type CredentialOAuthState } from "./credentialOAuthCard";
import { CredentialSourceSelector } from "./credentialSourceSelector";
import { ProviderMark } from "./icons";
import { ClaudeSetupGuide, CodexSetupGuide } from "./subscriptionCredentialGuides";
import {
  namePlaceholderForDraft,
  secretLabelForDraft,
  secretPlaceholderForDraft,
  withCredentialSource,
  type CreateProviderCredentialDraft,
  type CreateProviderCredentialMode,
  type CreateProviderCredentialSource
} from "./createCredentialWizard";

export type ProviderOption = { value: ProviderName; label: string };

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
        ? "Sign into Claude in your browser. Proxy saves the credential, then you bind it to an API key."
        : "Connect your Claude subscription so Proxy can use it for Claude Code traffic."
    };
  }
  if (draft.mode === "codex_subscription") {
    return {
      title: "Sign in with OpenAI",
      sub: browserOAuth
        ? "Authorize Codex access with OpenAI. Proxy saves the credential, then you bind it to an API key."
        : "Connect your ChatGPT (Codex) subscription so Proxy can use it for Codex traffic."
    };
  }
  return {
    title: "Credential details",
    sub: "Paste the provider secret here; it is encrypted at rest and never shown again."
  };
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
