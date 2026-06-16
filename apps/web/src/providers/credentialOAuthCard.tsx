import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";

import type { CreateProviderCredentialDraft } from "./createCredentialWizard";

export type CredentialOAuthState = {
  start: { verificationUrl: string; userCode: string } | null;
  status: { status: string; error?: string | null } | null;
  pending: boolean;
  checking: boolean;
  locked: boolean;
  error?: string;
  onStart: () => void;
};

export function CodexOAuthDeviceCard({ draft, oauth }: {
  draft: CreateProviderCredentialDraft;
  oauth?: CredentialOAuthState;
}) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  if (!oauth) return null;
  const status = oauth.status?.status ?? (oauth.start ? "pending" : "idle");
  const codeCopied = copiedCode === oauth.start?.userCode;
  return (
    <div className="provider-credential-oauth">
      <div>
        <strong>OpenAI sign-in</strong>
        <span className="faint">{oauthStatusText(status, oauth.checking)}</span>
      </div>
      <button
        className="btn btn-primary"
        type="button"
        disabled={oauth.pending || oauth.locked || !draft.name.trim()}
        onClick={oauth.onStart}
      >
        {oauthButtonLabel(oauth)}
      </button>
      {oauth.start ? (
        <div className="provider-credential-oauth-code">
          <div className="provider-credential-oauth-code-main">
            <span className="provider-credential-oauth-code-label">Copy this code into OpenAI</span>
            <span className="provider-credential-oauth-user-code">{oauth.start.userCode}</span>
          </div>
          <div className="provider-credential-oauth-code-actions">
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(oauth.start?.userCode ?? "");
                setCopiedCode(oauth.start?.userCode ?? null);
              }}
            >
              {codeCopied ? <Check /> : <Copy />}
              {codeCopied ? "Copied" : "Copy code"}
            </button>
            <a href={oauth.start.verificationUrl} target="_blank" rel="noreferrer" className="btn btn-sm provider-credential-oauth-link">
              Open OpenAI <ExternalLink />
            </a>
          </div>
        </div>
      ) : null}
      {oauth.error ? <span className="action-error">{oauth.error}</span> : null}
      {oauth.status?.status === "failed" ? <span className="action-error">{oauth.status.error || "OpenAI sign-in failed."}</span> : null}
    </div>
  );
}

function oauthStatusText(status: string, checking: boolean) {
  if (status === "completed") return "Credential saved.";
  if (status === "failed") return "Sign-in failed.";
  if (status === "pending") return checking ? "Checking OpenAI confirmation." : "Waiting for OpenAI confirmation.";
  return "No sign-in started.";
}

function oauthButtonLabel(oauth: CredentialOAuthState) {
  if (oauth.pending) return "Starting…";
  if (oauth.locked) return "Waiting for sign-in";
  if (oauth.start) return "Restart sign-in";
  return "Start sign-in";
}
