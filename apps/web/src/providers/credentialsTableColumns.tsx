import { Ban, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { compactId, formatDateTime } from "../format";
import type { ApiKeySummary } from "../routing/data";
import type { ConsoleTableColumn } from "../table";
import { StatusIndicator } from "../ui";
import { OwnerCell, ownerLabel, type UserDirectory } from "../userDirectory";
import type { ProviderAccountSummary } from "./data";
import {
  authTypeLabel,
  providerBoundKeyCountLabel,
  providerCredentialAuthLabel,
  providerCredentialBindingLabel,
  providerCredentialLabel,
  providerCredentialStatus,
  type ProviderCredentialRow
} from "./credentialsTableData";
import { providerHealthSearchTokens } from "./healthData";
import { ProviderCredentialHealthCell } from "./healthViews";
import { ProviderMark } from "./icons";

type ProviderCredentialColumnConfig = {
  users: UserDirectory;
  boundKeys: Map<string, ApiKeySummary[]> | null;
  revokePendingId?: string;
  revokeErrorId?: string;
  revokeErrorMessage?: string;
  onRevoke: (providerAccountId: string) => void;
  onOpen: (providerAccountId: string) => void;
};

export function providerCredentialColumns({
  users,
  boundKeys,
  revokePendingId,
  revokeErrorId,
  revokeErrorMessage,
  onRevoke,
  onOpen
}: ProviderCredentialColumnConfig): ConsoleTableColumn<ProviderCredentialRow>[] {
  return [
    {
      id: "provider",
      header: "Provider",
      accessorFn: (row) => row.providerLabel,
      size: 190,
      cell: ({ row }) => <ProviderCell row={row.original} />
    },
    {
      id: "credential",
      header: "Credential",
      accessorFn: providerCredentialLabel,
      size: 260,
      cell: ({ row }) => <CredentialCell row={row.original} onOpen={onOpen} />
    },
    {
      id: "auth",
      header: "Auth",
      accessorFn: providerCredentialAuthLabel,
      size: 150,
      cell: ({ row }) => <AuthCell row={row.original} />
    },
    {
      id: "bindings",
      header: "Bindings",
      accessorFn: (row) => providerCredentialBindingLabel(row, boundKeys),
      size: 270,
      cell: ({ row }) => <BindingsCell row={row.original} boundKeys={boundKeys} />
    },
    {
      id: "owner",
      header: "Owner",
      accessorFn: (row) => row.kind === "account" ? ownerLabel(users, row.account.ownerUserId) : "Organization",
      size: 170,
      cell: ({ row }) => row.original.kind === "account"
        ? <OwnerCell users={users} userId={row.original.account.ownerUserId} />
        : <span className="faint">Organization</span>
    },
    {
      id: "lastUsed",
      header: "Last used",
      accessorFn: (row) => row.kind === "account" ? row.account.lastUsedAt ?? "" : "",
      size: 135,
      cell: ({ row }) => <LastUsedCell row={row.original} />
    },
    {
      id: "health",
      header: "Health",
      accessorFn: (row) => row.kind === "account" ? providerHealthAccessor(row.account) : "not tracked",
      size: 170,
      cell: ({ row }) => <ProviderCredentialHealthCell row={row.original} />
    },
    {
      id: "status",
      header: "Status",
      accessorFn: providerCredentialStatus,
      size: 130,
      cell: ({ row }) => <StatusIndicator status={providerCredentialStatus(row.original)} />
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      enableHiding: false,
      size: 118,
      cell: ({ row }) => {
        const original = row.original;
        if (original.kind !== "account") return null;
        const account = original.account;
        return (
          <div className="provider-key-actions">
            <RevokeCredentialAction
              account={account}
              pending={revokePendingId === account.id}
              error={revokeErrorId === account.id ? revokeErrorMessage : undefined}
              onRevoke={() => onRevoke(account.id)}
            />
          </div>
        );
      }
    }
  ];
}

function ProviderCell({ row }: { row: ProviderCredentialRow }) {
  return (
    <div className="provider-table-provider-cell">
      <span className="provider-mark"><ProviderMark provider={row.provider} /></span>
      <div>
        <strong>{row.providerLabel}</strong>
        {row.providerDomain ? <div className="provider-group-domain mono">{row.providerDomain}</div> : null}
      </div>
    </div>
  );
}

function CredentialCell({ row, onOpen }: { row: ProviderCredentialRow; onOpen: (providerAccountId: string) => void }) {
  if (row.kind === "default") {
    return (
      <div className="provider-key-main">
        <div className="provider-key-default-title">
          <ShieldCheck />
          <span>{row.labels.title}</span>
        </div>
        <span className="provider-key-secret-pill mono">{row.labels.secret}</span>
      </div>
    );
  }
  return (
    <div className="provider-key-main">
      <button type="button" className="table-link key-name" onClick={() => onOpen(row.account.id)} aria-label={`Inspect ${row.account.name}`}>
        {row.account.name}
      </button>
      <div className="provider-key-secret-pill mono" title={row.account.id}>{secretLabel(row.account)}</div>
    </div>
  );
}

function AuthCell({ row }: { row: ProviderCredentialRow }) {
  if (row.kind === "default") return <span className="code-pill">{row.registryProvider?.authStyle ?? "provider default"}</span>;
  return <AuthPill account={row.account} />;
}

function AuthPill({ account }: { account: ProviderAccountSummary }) {
  const subscription = account.authType === "oauth";
  return (
    <span className={`code-pill auth-pill auth-pill-${account.provider}${subscription ? " auth-pill-subscription" : ""}`}>
      {subscription ? <ProviderMark provider={account.provider} /> : <KeyRound />}
      {authTypeLabel(account)}
    </span>
  );
}

function BindingsCell({ row, boundKeys }: { row: ProviderCredentialRow; boundKeys: Map<string, ApiKeySummary[]> | null }) {
  if (row.kind === "default") {
    return (
      <div className="provider-default-meta">
        <span className="code-pill provider-default-pill">{row.labels.status}</span>
        <span className="provider-default-note mono">{row.labels.note}</span>
      </div>
    );
  }
  return (
    <BoundKeyTags
      boundKeys={boundKeys?.get(row.account.id)}
      boundKeyCount={row.account.boundKeyCount}
      boundKeysAvailable={Boolean(boundKeys)}
    />
  );
}

function LastUsedCell({ row }: { row: ProviderCredentialRow }) {
  if (row.kind === "default") return <span className="provider-key-lastused faint">provider default</span>;
  return <span className="provider-key-lastused">{row.account.lastUsedAt ? formatDateTime(row.account.lastUsedAt) : "never"}</span>;
}

function providerHealthAccessor(account: ProviderAccountSummary) {
  return providerHealthSearchTokens(account).join(" ");
}

function BoundKeyTags({
  boundKeys,
  boundKeyCount,
  boundKeysAvailable
}: {
  boundKeys?: ApiKeySummary[];
  boundKeyCount: number;
  boundKeysAvailable: boolean;
}) {
  if (!boundKeysAvailable) return <span className="faint">{providerBoundKeyCountLabel(boundKeyCount)}</span>;
  if (!boundKeys || boundKeys.length === 0) return <span className="faint">no keys bound</span>;
  const hiddenCount = boundKeys.length - visibleBoundKeyCount;
  return (
    <div className="cell-tags scope-tags" title={boundKeys.map((apiKey) => apiKey.name).join("\n")}>
      {boundKeys.slice(0, visibleBoundKeyCount).map((apiKey) => (
        <span key={apiKey.id} className="code-pill">{apiKey.name}</span>
      ))}
      {hiddenCount > 0 ? <span className="code-pill scope-more">+{hiddenCount}</span> : null}
    </div>
  );
}

function RevokeCredentialAction({ account, pending, error, onRevoke }: {
  account: ProviderAccountSummary;
  pending: boolean;
  error?: string;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (account.status !== "active") return null;
  return (
    <>
      <button
        className={confirming || pending ? "btn btn-sm btn-danger" : "btn btn-icon btn-ghost cell-action"}
        type="button"
        disabled={pending}
        title={confirming ? undefined : "Revoke key"}
        aria-label={confirming ? `Confirm revoking ${account.name}` : `Revoke ${account.name}`}
        onBlur={() => setConfirming(false)}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          onRevoke();
        }}
      >
        {revokeContent(pending, confirming)}
      </button>
      {error ? <div className="action-error">{error}</div> : null}
    </>
  );
}

function secretLabel(account: ProviderAccountSummary) {
  if (account.authType === "oauth" || !account.secretHint) return compactId(account.id, 12);
  return account.secretHint;
}

const visibleBoundKeyCount = 2;

function revokeContent(pending: boolean, confirming: boolean) {
  if (pending) return "Revoking...";
  if (confirming) return "Revoke?";
  return <Ban />;
}
