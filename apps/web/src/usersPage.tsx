import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, MailPlus, UserCheck, UserX, X } from "lucide-react";
import { useState } from "react";

import { fetchMe } from "./session";
import { displayUser } from "./consoleData";
import { downloadJson, InspectorPanel } from "./dashboard";
import { formatCompact, formatDateTime, formatMoney } from "./format";
import { graphql } from "./gql";
import type { MemberRole, UsersListQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { InvitationsCard } from "./invitationsCard";
import { InviteUserPanel, memberRoleOptions } from "./inviteUserPanel";
import { ConsoleTable, type ConsoleTableAdvancedField, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { MenuSelect } from "./table/MenuSelect";
import { Badge, PageState, PageTitle, StatusBadge, UserCell } from "./ui";

const UsersListDocument = graphql(`
  query UsersList {
    users {
      userId
      email
      name
      externalId
      membership {
        role
        status
      }
      requestCount
      sessionCount
      usage {
        totalTokens
      }
      cost {
        selected
      }
      recentActivity
      createdAt
    }
  }
`);

const UpdateUserRoleDocument = graphql(`
  mutation UpdateUserRole($userId: ID!, $role: MemberRole!) {
    updateUserRole(userId: $userId, role: $role) {
      userId
      role
      previousRole
    }
  }
`);

const DeactivateUserDocument = graphql(`
  mutation DeactivateUser($userId: ID!) {
    deactivateUser(userId: $userId) {
      userId
      status
    }
  }
`);

const ReactivateUserDocument = graphql(`
  mutation ReactivateUser($userId: ID!) {
    reactivateUser(userId: $userId) {
      userId
      status
    }
  }
`);

type UserSummary = UsersListQuery["users"][number];

export function UsersPage() {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["users"], queryFn: () => gqlFetch(UsersListDocument) });
  const meQuery = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const roleMutation = useMutation({
    mutationFn: (input: { userId: string; role: MemberRole }) =>
      gqlFetch(UpdateUserRoleDocument, { userId: input.userId, role: input.role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] })
  });

  if (query.isLoading) return <PageState title="Users" label="Loading users" />;
  if (query.error) return <PageState title="Users" label={query.error.message} />;

  const users = query.data?.users ?? [];
  const memberCount = users.filter((user) => user.membership).length;
  const activeCount = users.filter((user) => userStatus(user) === "active").length;
  const selectedUser = users.find((user) => user.userId === selectedUserId) ?? users[0];
  const currentUserId = meQuery.data?.user.userId;
  return (
    <div className="page page-enter">
      <PageTitle
        title="Users"
        subtitle={`${memberCount} members · ${activeCount} active · ${users.length - memberCount} observed`}
        actions={(
          <button className="btn btn-primary" type="button" onClick={() => setShowInvite((open) => !open)}>
            {showInvite ? <X /> : <MailPlus />}
            {showInvite ? "Close" : "Invite user"}
          </button>
        )}
      />
      {showInvite ? <InviteUserPanel /> : null}
      <ConsoleTable
        data={users}
        columns={userColumns({
          pendingUserId: roleMutation.isPending ? roleMutation.variables?.userId : undefined,
          errorUserId: roleMutation.error ? roleMutation.variables?.userId : undefined,
          errorMessage: roleMutation.error?.message,
          onRoleChange: (userId, role) => roleMutation.mutate({ userId, role })
        })}
        search={{ placeholder: "Search members...", getValue: userSearchValue }}
        filters={userFilters}
        advancedFields={userAdvancedFields}
        emptyLabel="No users match these filters."
        actions={({ visibleData }) => (
          <button className="btn" type="button" onClick={() => downloadJson("proxy-users.json", { users: visibleData, selectedUser })}>
            <Download />Export
          </button>
        )}
        getRowProps={(user) => ({
          className: selectedUser?.userId === user.userId ? "selectable-row selected" : "selectable-row",
          tabIndex: 0,
          role: "button",
          onClick: () => setSelectedUserId(user.userId),
          onKeyDown: (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setSelectedUserId(user.userId);
          }
        })}
      />
      <InvitationsCard />
      {selectedUser ? <UserInspector user={selectedUser} currentUserId={currentUserId} /> : null}
    </div>
  );
}

function userColumns({ pendingUserId, errorUserId, errorMessage, onRoleChange }: {
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

const userFilters: ConsoleTableFilter<UserSummary>[] = [
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

const userAdvancedFields: ConsoleTableAdvancedField<UserSummary>[] = [
  { id: "name", label: "Name", getValue: displayUser },
  { id: "email", label: "Email", getValue: (user) => user.email },
  { id: "externalId", label: "External ID", getValue: (user) => user.externalId },
  { id: "role", label: "Role", getValue: userRole },
  { id: "status", label: "Status", getValue: userStatus },
  { id: "requests", label: "Requests", getValue: (user) => user.requestCount },
  { id: "sessions", label: "Sessions", getValue: (user) => user.sessionCount }
];

function UserInspector({ user, currentUserId }: { user: UserSummary; currentUserId?: string }) {
  const queryClient = useQueryClient();
  const statusMutation = useMutation({
    mutationFn: async (input: { userId: string; deactivate: boolean }) => {
      if (input.deactivate) await gqlFetch(DeactivateUserDocument, { userId: input.userId });
      else await gqlFetch(ReactivateUserDocument, { userId: input.userId });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] })
  });

  return (
    <InspectorPanel
      title={displayUser(user)}
      subtitle={user.email ?? user.externalId ?? user.userId}
      action={(
        <MemberStatusAction
          user={user}
          isSelf={currentUserId === user.userId}
          pending={statusMutation.isPending}
          error={statusMutation.error?.message}
          onToggle={(deactivate) => statusMutation.mutate({ userId: user.userId, deactivate })}
        />
      )}
      rows={[
        { label: "Role", value: userRole(user) },
        { label: "Status", value: userStatus(user) },
        { label: "Requests", value: user.requestCount },
        { label: "Sessions", value: user.sessionCount },
        { label: "Tokens", value: formatCompact(user.usage.totalTokens) },
        { label: "Spend", value: formatMoney(user.cost.selected) },
        { label: "Recent activity", value: user.recentActivity ? formatDateTime(user.recentActivity) : "none" }
      ]}
    />
  );
}

function MemberStatusAction({ user, isSelf, pending, error, onToggle }: {
  user: UserSummary;
  isSelf: boolean;
  pending: boolean;
  error?: string;
  onToggle: (deactivate: boolean) => void;
}) {
  if (!user.membership) return <Badge>observed</Badge>;

  const deactivated = user.membership.status === "deactivated";
  const label = labelForStatusAction(deactivated, pending);
  return (
    <div className="member-status-action">
      <button
        className="btn btn-sm"
        type="button"
        disabled={pending || (isSelf && !deactivated)}
        title={isSelf && !deactivated ? "You cannot deactivate yourself." : undefined}
        onClick={() => onToggle(!deactivated)}
      >
        {deactivated ? <UserCheck /> : <UserX />}
        {label}
      </button>
      {error ? <div className="action-error">{error}</div> : null}
    </div>
  );
}

function labelForStatusAction(deactivated: boolean, pending: boolean) {
  if (pending) return deactivated ? "Reactivating" : "Deactivating";
  return deactivated ? "Reactivate" : "Deactivate";
}

function userSearchValue(user: UserSummary) {
  return [user.userId, user.name, user.email, user.externalId, userRole(user), userStatus(user)]
    .filter((value): value is string => Boolean(value));
}

function userStatus(user: UserSummary) {
  return user.membership?.status ?? "observed";
}

function userRole(user: UserSummary) {
  return user.membership?.role ?? "";
}
