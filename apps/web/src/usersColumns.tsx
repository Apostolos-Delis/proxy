import { displayUser } from "./consoleData";
import { formatCompact, formatDateTime, formatMoney } from "./format";
import type { MemberRole } from "./gql/graphql";
import { memberRoleOptions } from "./inviteUserPanel";
import type { ConsoleTableAdvancedField, ConsoleTableColumn, ConsoleTableFilter } from "./table";
import { MenuSelect } from "./table/MenuSelect";
import { userRole, userStatus, type UserSummary } from "./usersPageData";
import { Badge, StatusBadge, UserCell } from "./ui";

export function userColumns({ pendingUserId, errorUserId, errorMessage, onRoleChange }: {
  pendingUserId?: string;
  errorUserId?: string;
  errorMessage?: string;
  onRoleChange: (userId: string, role: MemberRole) => void;
}): ConsoleTableColumn<UserSummary>[] {
  return [
    { id: "member", header: "Member", size: 260, accessorFn: displayUser, cell: ({ row }) => <UserCell name={displayUser(row.original)} detail={row.original.email ?? row.original.externalId} /> },
    { id: "role", header: "Role", size: 160, accessorFn: userRole, cell: ({ row }) => (
      <RoleCell
        user={row.original}
        pending={pendingUserId === row.original.userId}
        error={errorUserId === row.original.userId ? errorMessage : undefined}
        onRoleChange={(role) => onRoleChange(row.original.userId, role)}
      />
    ) },
    { id: "status", header: "Status", size: 140, accessorFn: userStatus, cell: ({ row }) => <StatusBadge status={userStatus(row.original)} /> },
    { id: "activity", header: "Activity", size: 200, accessorFn: (user) => user.recentActivity ?? "", cell: ({ row }) => <Badge>{row.original.recentActivity ? formatDateTime(row.original.recentActivity) : "none"}</Badge> },
    { id: "sessions", header: "Sessions", size: 110, accessorFn: (user) => user.sessionCount, cell: ({ row }) => <span className="mono">{row.original.sessionCount}</span> },
    { id: "requests", header: "Requests", size: 120, accessorFn: (user) => user.requestCount, cell: ({ row }) => <span className="mono">{row.original.requestCount}</span> },
    { id: "tokens", header: "Tokens", size: 130, accessorFn: (user) => user.usage.totalTokens, cell: ({ row }) => <span className="mono">{formatCompact(row.original.usage.totalTokens)}</span> },
    { id: "spend", header: "Spend", size: 120, accessorFn: (user) => user.cost.selected, cell: ({ row }) => <span className="mono">{formatMoney(row.original.cost.selected)}</span> },
    { id: "created", header: "Created", size: 170, accessorFn: (user) => user.createdAt, cell: ({ row }) => formatDateTime(row.original.createdAt) }
  ];
}

function RoleCell({ user, pending, error, onRoleChange }: {
  user: UserSummary;
  pending: boolean;
  error?: string;
  onRoleChange: (role: MemberRole) => void;
}) {
  if (!user.membership) return <span className="faint">—</span>;
  if (pending) return <Badge>updating…</Badge>;
  return (
    <>
      <MenuSelect
        value={user.membership.role}
        options={memberRoleOptions}
        ariaLabel={`Change role for ${displayUser(user)}`}
        onChange={(role) => {
          if (role !== user.membership?.role) onRoleChange(role as MemberRole);
        }}
      />
      {error ? <div className="action-error">{error}</div> : null}
    </>
  );
}

export const userFilters: ConsoleTableFilter<UserSummary>[] = [
  {
    id: "status",
    label: "Status",
    allLabel: "All users",
    options: [
      { value: "active", label: "Active" },
      { value: "deactivated", label: "Deactivated" },
      { value: "observed", label: "Observed" }
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
  { id: "requests", label: "Requests", getValue: (user) => user.requestCount },
  { id: "sessions", label: "Sessions", getValue: (user) => user.sessionCount }
];
