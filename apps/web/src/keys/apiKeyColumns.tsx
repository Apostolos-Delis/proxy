import { Ban, ChevronDown } from "lucide-react";
import { useRef, useState } from "react";

import { compactId, formatDate, formatDateTime } from "../format";
import type { ConsoleTableColumn } from "../table";
import { AnchoredPopover } from "../table/PopoverShell";
import { StatusIndicator } from "../ui";
import { OwnerCell, ownerLabel, type UserDirectory } from "../userDirectory";
import { accessProfileLabel, apiKeyStatus } from "./apiKeyTableData";
import type { AccessProfileSummary, ApiKeySummary } from "./data";

export type ApiKeyColumnConfig = {
  profiles: AccessProfileSummary[];
  users: UserDirectory;
  openKeyId: string | null;
  pendingKeyId?: string;
  errorKeyId?: string;
  errorMessage?: string;
  onOpenChange: (apiKeyId: string, open: boolean) => void;
  onAssign: (apiKeyId: string, accessProfileId: string) => void;
  onInspect: (apiKeyId: string) => void;
  revokePendingKeyId?: string;
  revokeErrorKeyId?: string;
  revokeErrorMessage?: string;
  onRevoke: (apiKeyId: string) => void;
};

export function apiKeyColumns({
  profiles,
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
    { id: "status", header: "Status", size: 96, accessorFn: apiKeyStatus, cell: ({ row }) => <StatusIndicator status={apiKeyStatus(row.original)} /> },
    { id: "owner", header: "Owner", size: 170, accessorFn: (apiKey) => ownerLabel(users, apiKey.userId), cell: ({ row }) => (
      <OwnerCell users={users} userId={row.original.userId} />
    ) },
    { id: "accessProfile", header: "Access profile", size: 220, accessorFn: accessProfileLabel, cell: ({ row }) => (
      apiKeyStatus(row.original) === "active" ? (
        <>
          <AssignmentMenu
            apiKey={row.original}
            profiles={profiles}
            open={openKeyId === row.original.id}
            pending={pendingKeyId === row.original.id}
            onOpenChange={(open) => onOpenChange(row.original.id, open)}
            onAssign={(accessProfileId) => onAssign(row.original.id, accessProfileId)}
          />
          {errorKeyId === row.original.id && errorMessage ? <div className="action-error">{errorMessage}</div> : null}
        </>
      ) : (
        <span className="faint">{accessProfileLabel(row.original)}</span>
      )
    ) },
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
  if (pending) return "Revoking...";
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

function AssignmentMenu({ apiKey, profiles, open, pending, onOpenChange, onAssign }: {
  apiKey: ApiKeySummary;
  profiles: AccessProfileSummary[];
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onAssign: (accessProfileId: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
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
        className={`cell-select${apiKey.accessProfile ? "" : " unset"}`}
        type="button"
        disabled={pending}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span>{pending ? "Updating..." : accessProfileLabel(apiKey)}</span>
        <ChevronDown />
      </button>
      {open ? (
        <AnchoredPopover anchorRef={triggerRef} onDismiss={() => onOpenChange(false)}>
          <div className="assignment-popover">
            {profiles.map((profile) => (
              <button key={profile.id} type="button" className={apiKey.accessProfileId === profile.id ? "active" : ""} onClick={() => onAssign(profile.id)}>
                <strong>{profile.name}</strong>
                <span>{profile.description ?? profile.slug}</span>
              </button>
            ))}
          </div>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}
