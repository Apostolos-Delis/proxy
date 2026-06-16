import { Link } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";

import { GlassCard } from "../ui";
import {
  credentialModeLabel,
  type CreateProviderCredentialDraft,
  type CreateProviderCredentialMode
} from "./createCredentialWizard";
import type { ProviderName } from "./data";

export type CreatedProviderCredential = {
  id: string;
  provider: ProviderName;
  name: string;
  mode: CreateProviderCredentialMode;
};

export function oauthBlockerMessage(
  draft: CreateProviderCredentialDraft,
  oauthStartMutation: { data?: { loginId: string } | null; isPending: boolean; error: Error | null },
  oauthStatusQuery: { data?: { status: string; error?: string | null } | null }
) {
  const browserOAuth = (draft.mode === "codex_subscription" && draft.source === "openai_oauth") ||
    (draft.mode === "claude_subscription" && draft.source === "claude_oauth");
  if (!browserOAuth || draft.stepId !== "credentials") {
    return null;
  }
  const providerLabel = draft.mode === "claude_subscription" ? "Claude" : "OpenAI";
  if (!draft.name.trim()) return "Enter a credential label.";
  if (oauthStartMutation.isPending) return `Starting ${providerLabel} sign-in.`;
  if (oauthStartMutation.error) return oauthStartMutation.error.message;
  if (oauthStatusQuery.data?.status === "failed") {
    return oauthStatusQuery.data.error || `${providerLabel} sign-in failed.`;
  }
  if (oauthStatusQuery.data?.status === "completed") return null;
  if (oauthStartMutation.data?.loginId) return `Complete the ${providerLabel} sign-in in your browser.`;
  return `Start ${providerLabel} sign-in to create this credential.`;
}

export function CreatedCredentialStep({ created, embedded, onClose }: {
  created: CreatedProviderCredential;
  embedded: boolean;
  onClose: () => void;
}) {
  return (
    <GlassCard>
      <div className="provider-credential-created">
        <CheckCircle2 />
        <div>
          <strong>{created.name}</strong>
          <span>{credentialModeLabel(created.mode)} credential created for <span className="mono">{created.provider}</span>.</span>
        </div>
      </div>
      <p className="provider-credential-next">
        {embedded
          ? "Selected for the API key you are creating."
          : "Bind it to a Prompt Proxy API key you own before traffic can use it."}
      </p>
      {embedded ? null : (
        <Link to="/api-keys" className="btn btn-primary provider-credential-bind-link" onClick={onClose}>
          Bind on API keys
        </Link>
      )}
    </GlassCard>
  );
}

export function WizardActions({ draft, created, pending, blocker, fieldError, mutationError, onBack, onNext, onCreate, onDone }: {
  draft: CreateProviderCredentialDraft;
  created: boolean;
  pending: boolean;
  blocker: string | null;
  fieldError: string | null;
  mutationError?: string;
  onBack: () => void;
  onNext: () => void;
  onCreate: () => void;
  onDone: () => void;
}) {
  const showBack = draft.stepId !== "type" && !created;
  return (
    <div className="wizard-actions">
      <div className="wizard-actions-status">
        {blocker ? <span className="wizard-blocker">{blocker}</span> : null}
        {fieldError ? <span className="action-error">{fieldError}</span> : null}
        {mutationError ? <span className="action-error">{mutationError}</span> : null}
      </div>
      {showBack ? <button className="btn" type="button" disabled={pending} onClick={onBack}>Back</button> : null}
      {primaryAction(draft, created, pending, blocker, onNext, onCreate, onDone)}
    </div>
  );
}

function primaryAction(
  draft: CreateProviderCredentialDraft,
  created: boolean,
  pending: boolean,
  blocker: string | null,
  onNext: () => void,
  onCreate: () => void,
  onDone: () => void
) {
  if (draft.stepId === "bind" && created) {
    return <button className="btn btn-primary" type="button" onClick={onDone}>Done</button>;
  }
  if (draft.stepId === "review") {
    return (
      <button className="btn btn-primary" type="button" disabled={pending} onClick={onCreate}>
        {pending ? "Saving…" : "Save credential"}
      </button>
    );
  }
  return (
    <button className="btn btn-primary" type="button" disabled={Boolean(blocker)} onClick={onNext}>
      Next
    </button>
  );
}
