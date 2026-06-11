import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Ban, KeySquare, Plus, X } from "lucide-react";
import { useState } from "react";

import {
  fetchProviderAccounts,
  revokeProviderCredential,
  type ProviderAccountSummary
} from "./providers/data";
import { ProviderKeyDetailPanel } from "./providers/detailPanel";
import { CreateProviderCredentialPanel } from "./createProviderCredentialPanel";
import { compactId, formatDateTime } from "./format";
import { ConsoleTable, optionItems, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { PageState, PageTitle, StatusBadge } from "./ui";

export function ProvidersPage() {
  const [showCreate, setShowCreate] = useState(false);
  // The open slideout lives in the URL (?key=<id>) so provider keys can be deep-linked.
  const search = useSearch({ strict: false }) as { key?: unknown };
  const openAccountId = typeof search.key === "string" ? search.key : null;
  const navigate = useNavigate();
  const setOpenAccountId = (accountId: string | null) =>
    void navigate({ to: ".", search: (current) => ({ ...current, key: accountId ?? undefined }), replace: true });
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
  const openAccount = accounts.find((account) => account.id === openAccountId);
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
      {openAccount ? <ProviderKeyDetailPanel account={openAccount} onClose={() => setOpenAccountId(null)} /> : null}
      <ConsoleTable
        className="routing-configs-card"
        urlState
        data={accounts}
        columns={providerAccountColumns({
          revokePendingId: revokeMutation.isPending ? revokeMutation.variables : undefined,
          revokeErrorId: revokeMutation.error ? revokeMutation.variables : undefined,
          revokeErrorMessage: revokeMutation.error?.message,
          onRevoke: (providerAccountId) => revokeMutation.mutate(providerAccountId),
          onOpen: (providerAccountId) => setOpenAccountId(providerAccountId)
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
  onRevoke,
  onOpen
}: {
  revokePendingId?: string;
  revokeErrorId?: string;
  revokeErrorMessage?: string;
  onRevoke: (providerAccountId: string) => void;
  onOpen: (providerAccountId: string) => void;
}): ConsoleTableColumn<ProviderAccountSummary>[] {
  return [
    { id: "name", header: "Name", size: 240, accessorFn: (account) => account.name, cell: ({ row }) => <ProviderKeyNameCell account={row.original} onOpen={() => onOpen(row.original.id)} /> },
    { id: "provider", header: "Provider", size: 130, accessorFn: (account) => account.provider, cell: ({ row }) => <span className="code-pill">{row.original.provider}</span> },
    { id: "auth", header: "Auth", size: 130, accessorFn: (account) => authTypeLabel(account), cell: ({ row }) => <span className="code-pill">{authTypeLabel(row.original)}</span> },
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

function authTypeLabel(account: ProviderAccountSummary) {
  return account.authType === "oauth" ? "subscription" : "api key";
}

function ownerCell(account: ProviderAccountSummary) {
  if (!account.ownerUserId) return <span className="faint">organization</span>;
  return <span className="mono">{compactId(account.ownerUserId, 12)}</span>;
}

function lastUsedCell(account: ProviderAccountSummary) {
  if (!account.lastUsedAt) return <span className="faint">never</span>;
  return formatDateTime(account.lastUsedAt);
}

function ProviderKeyNameCell({ account, onOpen }: { account: ProviderAccountSummary; onOpen: () => void }) {
  return (
    <>
      <button type="button" className="table-link row gap-8" onClick={onOpen} aria-label={`Inspect ${account.name}`}>
        <KeySquare /><strong>{account.name}</strong>
      </button>
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
  return [account.id, account.name, account.provider, authTypeLabel(account), account.ownerUserId, account.secretHint]
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
      id: "auth",
      label: "Auth",
      allLabel: "All auth types",
      options: optionItems(accounts.map((account) => authTypeLabel(account))),
      getValue: (account) => authTypeLabel(account)
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
