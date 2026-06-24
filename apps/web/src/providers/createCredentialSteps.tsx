import { Check, ClipboardCheck, KeySquare } from "lucide-react";

import { WizardStepHead } from "../keys/stepHead";
import { Badge, GlassCard } from "../ui";
export { CredentialDetailsStep } from "./credentialDetailsStep";
import { ProviderMark } from "./icons";
import {
  canVisitStep,
  credentialModeLabel,
  createProviderCredentialSteps,
  secretLabelForDraft,
  sourceLabelForDraft,
  stepRailState,
  withCredentialMode,
  type CreateProviderCredentialDraft,
  type CreateProviderCredentialMode,
  type CreateProviderCredentialStepId
} from "./createCredentialWizard";

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
