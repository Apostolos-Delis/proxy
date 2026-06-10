import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, KeySquare, Plus, X } from "lucide-react";
import { useState } from "react";

import {
  fetchProviderAccounts,
  revokeProviderCredential,
  type ProviderAccountSummary
} from "./providers/data";
import { CreateProviderCredentialPanel } from "./createProviderCredentialPanel";
import { compactId, formatDateTime } from "./format";
import { ConsoleTable, optionItems, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { PageState, PageTitle, StatusBadge } from "./ui";

export function ProvidersPage() {
  const [showCreate, setShowCreate] = useState(false);
  const queryClient = useQueryClient();
  const accountsQuery = useQuery({ queryKey: ["provider-accounts"], queryFn: fetchProviderAccounts });
  const revokeMutation = useMutation({
    mutationFn: (providerAccountId: string) => revokeProviderCredential(providerAccountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    }
  });

  if (accountsQuery.isLoading) return <PageState title="Provider keys" label="Loading provider keys" />;
  if (accountsQuery.error) return <PageState title="Provider keys" label={accountsQuery.error.message} />;

  const accounts = accountsQuery.data ?? [];
  return (
    <div className="page page-enter">
      <PageTitle
        title="Provider keys"
        subtitle="Customer-supplied provider keys (BYOK). Unbound traffic keeps using the company key."
        actions={(
          <button className="btn btn-primary" type="button" onClick={() => setShowCreate((open) => !open)}>
            {showCreate ? <X /> : <Plus />}
            {showCreate ? "Close" : "Add provider key"}
          </button>
        )}
      />
      {showCreate ? <CreateProviderCredentialPanel onClose={() => setShowCreate(false)} /> : null}
      <ConsoleTable
        className="routing-configs-card"
        urlState
        data={accounts}
        columns={providerAccountColumns({
          revokePendingId: revokeMutation.isPending ? revokeMutation.variables : undefined,
          revokeErrorId: revokeMutation.error ? revokeMutation.variables : undefined,
          revokeErrorMessage: revokeMutation.error?.message,
          onRevoke: (providerAccountId) => revokeMutation.mutate(providerAccountId)
        })}
        search={{ placeholder: "Search keys, providers, owners...", getValue: providerAccountSearchValue }}
        filters={providerAccountFilters(accounts)}
        emptyLabel="No third-party provider keys yet."
      />
    </div>
  );
}

function providerAccountColumns({
  revokePendingId,
  revokeErrorId,
  revokeErrorMessage,
  onRevoke
}: {
  revokePendingId?: string;
  revokeErrorId?: string;
  revokeErrorMessage?: string;
  onRevoke: (providerAccountId: string) => void;
}): ConsoleTableColumn<ProviderAccountSummary>[] {
  return [
    { id: "name", header: "Name", size: 240, accessorFn: (account) => account.name, cell: ({ row }) => <ProviderKeyNameCell account={row.original} /> },
    { id: "provider", header: "Provider", size: 130, accessorFn: (account) => account.provider, cell: ({ row }) => <span className="code-pill">{row.original.provider}</span> },
    { id: "owner", header: "Owner", size: 160, accessorFn: (account) => account.ownerUserId ?? "", cell: ({ row }) => ownerCell(row.original) },
    { id: "status", header: "Status", size: 120, accessorFn: (account) => account.status, cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    { id: "secret", header: "Secret", size: 130, enableSorting: false, accessorFn: (account) => account.secretHint ?? "", cell: ({ row }) => <span className="mono faint">{row.original.secretHint ?? "—"}</span> },
    { id: "boundKeys", header: "Bound keys", size: 110, accessorFn: (account) => account.boundKeyCount, cell: ({ row }) => <span className="mono">{row.original.boundKeyCount}</span> },
    { id: "lastUsed", header: "Last used", size: 160, accessorFn: (account) => account.lastUsedAt ?? "", cell: ({ row }) => lastUsedCell(row.original) },
    { id: "created", header: "Created", size: 160, accessorFn: (account) => account.createdAt, cell: ({ row }) => formatDateTime(row.original.createdAt) },
    { id: "actions", header: "", size: 120, enableSorting: false, enableHiding: false, accessorFn: () => "", cell: ({ row }) => (
      <RevokeCredentialAction
        account={row.original}
        pending={revokePendingId === row.original.id}
        error={revokeErrorId === row.original.id ? revokeErrorMessage : undefined}
        onRevoke={() => onRevoke(row.original.id)}
      />
    ) }
  ];
}

function ownerCell(account: ProviderAccountSummary) {
  if (!account.ownerUserId) return <span className="faint">organization</span>;
  return <span className="mono">{compactId(account.ownerUserId, 12)}</span>;
}

function lastUsedCell(account: ProviderAccountSummary) {
  if (!account.lastUsedAt) return <span className="faint">never</span>;
  return formatDateTime(account.lastUsedAt);
}

function ProviderKeyNameCell({ account }: { account: ProviderAccountSummary }) {
  return (
    <>
      <div className="row gap-8"><KeySquare /><strong>{account.name}</strong></div>
      <div className="key-id faint" title={account.id}>
        <span>Key ID</span>
        <span className="mono">{compactId(account.id, 14)}</span>
      </div>
    </>
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
        className={`btn btn-sm${confirming ? " btn-danger" : ""}`}
        type="button"
        disabled={pending}
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
        <Ban />
        {revokeLabel(pending, confirming)}
      </button>
      {error ? <div className="action-error">{error}</div> : null}
    </>
  );
}

function revokeLabel(pending: boolean, confirming: boolean) {
  if (pending) return "Revoking";
  return confirming ? "Confirm revoke" : "Revoke";
}

function providerAccountSearchValue(account: ProviderAccountSummary) {
  return [account.id, account.name, account.provider, account.ownerUserId, account.secretHint]
    .filter((value): value is string => Boolean(value));
}

function providerAccountFilters(accounts: ProviderAccountSummary[]): ConsoleTableFilter<ProviderAccountSummary>[] {
  return [
    {
      id: "provider",
      label: "Provider",
      allLabel: "All providers",
      options: optionItems(accounts.map((account) => account.provider)),
      getValue: (account) => account.provider
    },
    {
      id: "status",
      label: "Status",
      allLabel: "All statuses",
      options: optionItems(accounts.map((account) => account.status)),
      getValue: (account) => account.status
    }
  ];
}
