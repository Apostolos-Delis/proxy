import { ChevronDown } from "lucide-react";
import { useRef } from "react";

import { displayUser } from "./consoleData";
import { formatCompact, formatDateTime, formatMoney, formatMonthYear } from "./format";
import type { MemberRole } from "./gql/graphql";
import { memberRoleOptions } from "./inviteUserPanel";
import type { ConsoleTableAdvancedField, ConsoleTableColumn, ConsoleTableFilter } from "./table";
import { AnchoredPopover } from "./table/PopoverShell";
import { userRole, userStatus, type UserSummary } from "./usersPageData";
import { StatusIndicator, UserCell } from "./ui";

export function userColumns({ openRoleUserId, pendingUserId, errorUserId, errorMessage, onRoleMenuOpenChange, onRoleChange }: {
  openRoleUserId: string | null;
  pendingUserId?: string;
  errorUserId?: string;
  errorMessage?: string;
  onRoleMenuOpenChange: (userId: string, open: boolean) => void;
  onRoleChange: (userId: string, role: MemberRole) => void;
}): ConsoleTableColumn<UserSummary>[] {
  return [
    { id: "member", header: "Member", size: 260, accessorFn: displayUser, cell: ({ row }) => <UserCell name={displayUser(row.original)} detail={row.original.email ?? row.original.externalId} /> },
    { id: "role", header: "Role", size: 150, accessorFn: userRole, cell: ({ row }) => (
      <>
        <RoleMenu
          user={row.original}
          open={openRoleUserId === row.original.userId}
          pending={pendingUserId === row.original.userId}
          onOpenChange={(open) => onRoleMenuOpenChange(row.original.userId, open)}
          onRoleChange={(role) => onRoleChange(row.original.userId, role)}
        />
        {errorUserId === row.original.userId && errorMessage ? <div className="action-error">{errorMessage}</div> : null}
      </>
    ) },
    { id: "status", header: "Status", size: 130, accessorFn: userStatus, cell: ({ row }) => <StatusIndicator status={userStatus(row.original)} /> },
    { id: "apiKeys", header: "API keys", size: 110, accessorFn: (user) => user.apiKeyCount, cell: ({ row }) => <span className="mono">{row.original.apiKeyCount}</span> },
    { id: "tokens30d", header: "Tokens (30d)", size: 130, accessorFn: (user) => user.usage30d.totalTokens, cell: ({ row }) => <span className="mono">{formatCompact(row.original.usage30d.totalTokens)}</span> },
    { id: "spend30d", header: "Spend (30d)", size: 130, accessorFn: (user) => user.cost30d.selected, cell: ({ row }) => <span className="mono">{formatMoney(row.original.cost30d.selected)}</span> },
    { id: "joined", header: "Joined", size: 110, accessorFn: (user) => user.createdAt, cell: ({ row }) => (
      <span className="nowrap" title={formatDateTime(row.original.createdAt)}>{formatMonthYear(row.original.createdAt)}</span>
    ) }
  ];
}

function RoleMenu({ user, open, pending, onOpenChange, onRoleChange }: {
  user: UserSummary;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onRoleChange: (role: MemberRole) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const role = user.membership?.role;
  if (!role) return <span className="faint">—</span>;
  const label = memberRoleOptions.find((option) => option.value === role)?.label ?? role;
  return (
    <div
      className="assignment-menu"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Escape" || !open) return;
        onOpenChange(false);
      }}
    >
      <button
        ref={triggerRef}
        className="cell-select"
        type="button"
        disabled={pending}
        aria-expanded={open}
        aria-label={`Change role for ${displayUser(user)}`}
        onClick={() => onOpenChange(!open)}
      >
        <span>{pending ? "Updating…" : label}</span>
        <ChevronDown />
      </button>
      {open ? (
        <AnchoredPopover anchorRef={triggerRef} onDismiss={() => onOpenChange(false)}>
          <div className="assignment-popover role-popover">
            {memberRoleOptions.map((option) => (
              <button key={option.value} type="button" disabled={pending} className={option.value === role ? "active" : ""} onClick={() => {
                if (option.value === role) onOpenChange(false);
                else onRoleChange(option.value);
              }}>
                <strong>{option.label}</strong>
              </button>
            ))}
          </div>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}

export const userFilters: ConsoleTableFilter<UserSummary>[] = [
  {
    id: "status",
    label: "Status",
    allLabel: "All users",
    options: [
      { value: "active", label: "Active" },
      { value: "deactivated", label: "Deactivated" }
    ],
    getValue: userStatus
  },
  {
    id: "role",
    label: "Role",
    allLabel: "All roles",
    options: memberRoleOptions,
    getValue: userRole
  }
];

export const userAdvancedFields: ConsoleTableAdvancedField<UserSummary>[] = [
  { id: "name", label: "Name", getValue: displayUser },
  { id: "email", label: "Email", getValue: (user) => user.email },
  { id: "externalId", label: "External ID", getValue: (user) => user.externalId },
  { id: "role", label: "Role", getValue: userRole },
  { id: "status", label: "Status", getValue: userStatus },
  { id: "apiKeys", label: "API keys", getValue: (user) => user.apiKeyCount },
  { id: "requests", label: "Requests", getValue: (user) => user.requestCount },
  { id: "sessions", label: "Sessions", getValue: (user) => user.sessionCount }
];
