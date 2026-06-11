import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";

import {
  assignApiKeyProviderAccount,
  type ProviderAccountSummary,
  type ProviderName
} from "./providers/data";
import type { ApiKeySummary } from "./routing/data";
import { PROVIDER_ORDER } from "./providers";
import { AnchoredPopover } from "./table/PopoverShell";

export function ApiKeyProviderBinding({ apiKey, providerAccounts }: {
  apiKey: ApiKeySummary;
  providerAccounts: ProviderAccountSummary[];
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const assignMutation = useMutation({
    mutationFn: (input: { provider: ProviderName; providerAccountId: string | null }) =>
      assignApiKeyProviderAccount(apiKey.id, input.provider, input.providerAccountId),
    onSuccess: () => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
    }
  });

  if (apiKey.revokedAt) return <span className="faint">—</span>;

  const activeAccounts = providerAccounts.filter((account) => account.status === "active");
  const boundByProvider = new Map(apiKey.providerCredentials.map((binding) => [binding.provider, binding]));

  return (
    <div className="assignment-menu">
      <button
        ref={triggerRef}
        className={`cell-select${apiKey.providerCredentials.length > 0 ? "" : " unset"}`}
        type="button"
        disabled={assignMutation.isPending}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>{assignMutation.isPending ? "Updating…" : bindingLabel(apiKey)}</span>
        <ChevronDown />
      </button>
      {open ? (
        <AnchoredPopover anchorRef={triggerRef} onDismiss={() => setOpen(false)}>
          <div className="assignment-popover">
            {activeAccounts.length === 0 ? (
              <div className="assignment-blank">
                <strong>No provider keys</strong>
                <span>Upstream traffic uses the platform keys.</span>
                <Link to="/provider-keys" className="btn btn-sm" onClick={() => setOpen(false)}>Add provider keys</Link>
              </div>
            ) : (
              PROVIDER_ORDER.map((provider) => (
                <ProviderSection
                  key={provider}
                  provider={provider}
                  accounts={activeAccounts.filter((account) => account.provider === provider)}
                  boundId={boundByProvider.get(provider)?.providerAccountId ?? null}
                  onAssign={(providerAccountId) => assignMutation.mutate({ provider, providerAccountId })}
                />
              ))
            )}
            {assignMutation.error ? <div className="action-error">{assignMutation.error.message}</div> : null}
          </div>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}

function ProviderSection({ provider, accounts, boundId, onAssign }: {
  provider: ProviderName;
  accounts: ProviderAccountSummary[];
  boundId: string | null;
  onAssign: (providerAccountId: string | null) => void;
}) {
  return (
    <div className="assignment-section">
      <div className="assignment-section-label faint">{provider}</div>
      <button type="button" className={boundId === null ? "active" : ""} onClick={() => onAssign(null)}>
        <strong>None</strong>
        <span>Use the platform key</span>
      </button>
      {accounts.map((account) => (
        <button key={account.id} type="button" className={boundId === account.id ? "active" : ""} onClick={() => onAssign(account.id)}>
          <strong>{account.name}</strong>
          <span>{account.secretHint ?? "customer key"}</span>
        </button>
      ))}
      {accounts.length === 0 ? <div className="faint assignment-empty">No {provider} keys added</div> : null}
    </div>
  );
}

function bindingLabel(apiKey: ApiKeySummary) {
  const names = apiKey.providerCredentials.map((binding) => binding.name ?? binding.provider);
  if (names.length === 0) return "None";
  return names.join(", ");
}
