import { Link } from "@tanstack/react-router";

import { Badge, GlassCard } from "../ui";
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
  if (draft.mode !== "codex_subscription" || draft.source !== "openai_oauth" || draft.stepId !== "credentials") {
    return null;
  }
  if (!draft.name.trim()) return "Enter a credential label.";
  if (oauthStartMutation.isPending) return "Starting OpenAI sign-in.";
  if (oauthStartMutation.error) return oauthStartMutation.error.message;
  if (oauthStatusQuery.data?.status === "failed") {
    return oauthStatusQuery.data.error || "OpenAI sign-in failed.";
  }
  if (oauthStatusQuery.data?.status === "completed") return null;
  if (oauthStartMutation.data?.loginId) return "Complete the OpenAI sign-in in your browser.";
  return "Start OpenAI sign-in to create this credential.";
}

export function CreatedCredentialStep({ created, embedded, onClose }: {
  created: CreatedProviderCredential;
  embedded: boolean;
  onClose: () => void;
}) {
  return (
    <GlassCard>
      <div className="invite-result">
        <div className="row gap-8">
          <Badge variant="success" dot>{created.name} saved</Badge>
          <span className="faint">{credentialModeLabel(created.mode)} credential created for <span className="mono">{created.provider}</span>.</span>
        </div>
      </div>
      {embedded ? (
        <div className="provider-credential-note">
          <Badge variant="success" dot>Selected</Badge>
          <span>This provider key is selected for the API key you are creating.</span>
        </div>
      ) : (
        <div className="provider-credential-note">
          <Badge variant="warn" dot>Bind next</Badge>
          <span>Bind it to a Prompt Proxy API key you own before traffic can use it.</span>
        </div>
      )}
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
