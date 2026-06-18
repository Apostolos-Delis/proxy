import { Ban, ChevronDown } from "lucide-react";
import { useRef, useState } from "react";

import { ApiKeyProviderBinding } from "../apiKeyProviderBinding";
import { compactId, formatDate, formatDateTime } from "../format";
import type { ProviderAccountSummary } from "../providers/data";
import { isDefaultConfig, type ApiKeySummary, type RoutingConfigSummary } from "../routing/data";
import type { ConsoleTableColumn } from "../table";
import { AnchoredPopover } from "../table/PopoverShell";
import { StatusBadge } from "../ui";
import { OwnerCell, ownerLabel, type UserDirectory } from "../userDirectory";
import { apiKeyStatus, providerBindingValue, routingConfigLabel } from "./apiKeyTableData";

export type ApiKeyColumnConfig = {
  configs: RoutingConfigSummary[];
  providerAccounts: ProviderAccountSummary[];
  users: UserDirectory;
  openKeyId: string | null;
  pendingKeyId?: string;
  errorKeyId?: string;
  errorMessage?: string;
  onOpenChange: (apiKeyId: string, open: boolean) => void;
  onAssign: (apiKeyId: string, routingConfigId: string | null) => void;
  onInspect: (apiKeyId: string) => void;
  revokePendingKeyId?: string;
  revokeErrorKeyId?: string;
  revokeErrorMessage?: string;
  onRevoke: (apiKeyId: string) => void;
};

export function apiKeyColumns({
  configs,
  providerAccounts,
  users,
  openKeyId,
  pendingKeyId,
  errorKeyId,
  errorMessage,
  onOpenChange,
  onAssign,
  onInspect,
  revokePendingKeyId,
  revokeErrorKeyId,
  revokeErrorMessage,
  onRevoke
}: ApiKeyColumnConfig): ConsoleTableColumn<ApiKeySummary>[] {
  return [
    { id: "name", header: "Name", size: 225, accessorFn: (apiKey) => apiKey.name, cell: ({ row }) => <ApiKeyNameCell apiKey={row.original} onInspect={() => onInspect(row.original.id)} /> },
    { id: "status", header: "Status", size: 96, accessorFn: apiKeyStatus, cell: ({ row }) => <StatusBadge status={apiKeyStatus(row.original)} /> },
    { id: "owner", header: "Owner", size: 170, accessorFn: (apiKey) => ownerLabel(users, apiKey.userId), cell: ({ row }) => (
      <OwnerCell users={users} userId={row.original.userId} />
    ) },
    { id: "routingConfig", header: "Routing", size: 200, accessorFn: routingConfigLabel, cell: ({ row }) => (
      apiKeyStatus(row.original) === "active" ? (
        <>
          <AssignmentMenu
            apiKey={row.original}
            configs={configs}
            open={openKeyId === row.original.id}
            pending={pendingKeyId === row.original.id}
            onOpenChange={(open) => onOpenChange(row.original.id, open)}
            onAssign={(routingConfigId) => onAssign(row.original.id, routingConfigId)}
          />
          {errorKeyId === row.original.id && errorMessage ? <div className="action-error">{errorMessage}</div> : null}
        </>
      ) : (
        <span className="faint">{routingConfigLabel(row.original)}</span>
      )
    ) },
    { id: "providerKey", header: "Provider key", size: 220, enableSorting: false, accessorFn: providerBindingValue, cell: ({ row }) => <ApiKeyProviderBinding apiKey={row.original} providerAccounts={providerAccounts} /> },
    { id: "created", header: "Created", size: 105, accessorFn: (apiKey) => apiKey.createdAt, cell: ({ row }) => (
      <span className="nowrap" title={formatDateTime(row.original.createdAt)}>{formatDate(row.original.createdAt)}</span>
    ) },
    { id: "lastUsed", header: "Last used", size: 105, accessorFn: (apiKey) => apiKey.lastUsedAt ?? "", cell: ({ row }) => (
      row.original.lastUsedAt
        ? <span className="nowrap" title={formatDateTime(row.original.lastUsedAt)}>{formatDate(row.original.lastUsedAt)}</span>
        : <span className="faint">Never</span>
    ) },
    { id: "actions", header: "", size: 88, enableSorting: false, enableHiding: false, accessorFn: () => "", cell: ({ row }) => (
      <RevokeKeyAction
        apiKey={row.original}
        pending={revokePendingKeyId === row.original.id}
        error={revokeErrorKeyId === row.original.id ? revokeErrorMessage : undefined}
        onRevoke={() => onRevoke(row.original.id)}
      />
    ) }
  ];
}

function RevokeKeyAction({ apiKey, pending, error, onRevoke }: {
  apiKey: ApiKeySummary;
  pending: boolean;
  error?: string;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (apiKey.revokedAt) return null;
  return (
    <>
      <button
        className={confirming || pending ? "btn btn-sm btn-danger" : "btn btn-icon btn-ghost cell-action"}
        type="button"
        disabled={pending}
        title={confirming ? undefined : "Revoke key"}
        aria-label={confirming ? `Confirm revoking ${apiKey.name}` : `Revoke ${apiKey.name}`}
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

function revokeContent(pending: boolean, confirming: boolean) {
  if (pending) return "Revoking…";
  if (confirming) return "Revoke?";
  return <Ban />;
}

function ApiKeyNameCell({ apiKey, onInspect }: { apiKey: ApiKeySummary; onInspect: () => void }) {
  return (
    <>
      <button type="button" className="table-link key-name" onClick={onInspect} aria-label={`Inspect ${apiKey.name}`}>
        {apiKey.name}
      </button>
      <div className="key-id faint" title={apiKey.id}>
        <span>Key ID</span>
        <span className="mono">{compactId(apiKey.id, 9)}</span>
      </div>
    </>
  );
}

function AssignmentMenu({ apiKey, configs, open, pending, onOpenChange, onAssign }: {
  apiKey: ApiKeySummary;
  configs: RoutingConfigSummary[];
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onAssign: (routingConfigId: string | null) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = apiKey.routingConfig?.name ?? "Organization default";
  const options = configs.filter((config) => !isDefaultConfig(config) || apiKey.routingConfigId === config.id);
  return (
    <div
      className="assignment-menu"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        onOpenChange(false);
      }}
    >
      <button
        ref={triggerRef}
        className={`cell-select${apiKey.routingConfig ? "" : " unset"}`}
        type="button"
        disabled={pending}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span>{pending ? "Updating…" : label}</span>
        <ChevronDown />
      </button>
      {open ? (
        <AnchoredPopover anchorRef={triggerRef} onDismiss={() => onOpenChange(false)}>
          <div className="assignment-popover">
            <button type="button" className={!apiKey.routingConfigId ? "active" : ""} onClick={() => onAssign(null)}>
              <strong>Organization default</strong>
              <span>Clear key-specific routing</span>
            </button>
            {options.map((config) => (
              <button key={config.id} type="button" className={apiKey.routingConfigId === config.id ? "active" : ""} onClick={() => onAssign(config.id)}>
                <strong>{config.name}</strong>
                <span>v{config.activeVersion?.version ?? "?"} · {config.assignedApiKeyCount} keys</span>
              </button>
            ))}
          </div>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}
