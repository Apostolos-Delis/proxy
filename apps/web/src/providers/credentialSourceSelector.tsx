import { FileKey, Keyboard } from "lucide-react";
import type { ReactNode } from "react";

import {
  withCredentialSource,
  type CreateProviderCredentialDraft,
  type CreateProviderCredentialSource
} from "./createCredentialWizard";

type SourceOption = {
  source: CreateProviderCredentialSource;
  title: string;
  detail: string;
  icon: ReactNode;
};

export function CredentialSourceSelector({ draft, onChange }: {
  draft: CreateProviderCredentialDraft;
  onChange: (draft: CreateProviderCredentialDraft) => void;
}) {
  return (
    <div className="credential-source-grid">
      {sourceOptions(draft).map((option) => (
        <label className="credential-source-option" key={option.source}>
          <input
            type="radio"
            name="provider-credential-source"
            checked={draft.source === option.source}
            onChange={() => onChange(withCredentialSource(draft, option.source))}
          />
          <span className="credential-source-icon">{option.icon}</span>
          <strong>{option.title}</strong>
          <span className="faint">{option.detail}</span>
        </label>
      ))}
    </div>
  );
}

function sourceOptions(draft: CreateProviderCredentialDraft): SourceOption[] {
  if (draft.mode === "claude_subscription") {
    return [
      {
        source: "local_auth",
        title: "Import from Claude Code",
        detail: "Read CLAUDE_CODE_OAUTH_TOKEN from the proxy environment.",
        icon: <FileKey />
      },
      {
        source: "manual",
        title: "Paste setup token",
        detail: "Paste the token printed by claude setup-token.",
        icon: <Keyboard />
      }
    ];
  }

  return [
    {
      source: "local_auth",
      title: "Import from Codex",
      detail: "Read the proxy host's Codex auth JSON.",
      icon: <FileKey />
    },
    {
      source: "manual",
      title: "Paste token or JSON",
      detail: "Paste a Codex access token or auth JSON by hand.",
      icon: <Keyboard />
    }
  ];
}
