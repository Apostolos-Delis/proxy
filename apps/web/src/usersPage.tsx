import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";

import { type UserSummary, fetchUsers } from "./api";
import { displayUser } from "./consoleData";
import { downloadJson, InspectorPanel } from "./dashboard";
import { formatCompact, formatDateTime, formatMoney } from "./format";
import { ConsoleTable, type ConsoleTableAdvancedField, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { Badge, PageState, PageTitle, StatusBadge, UserCell } from "./ui";

export function UsersPage() {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["users"], queryFn: fetchUsers });

  if (query.isLoading) return <PageState title="Users" label="Loading users" />;
  if (query.error) return <PageState title="Users" label={query.error.message} />;

  const users = query.data?.data ?? [];
  const selectedUser = users.find((user) => user.userId === selectedUserId) ?? users[0];
  return (
    <div className="page page-enter">
      <PageTitle
        title="Users"
        subtitle={`${users.length} observed users · ${users.filter((user) => user.recentActivity).length} active`}
        actions={null}
      />
      <ConsoleTable
        data={users}
        columns={userColumns}
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
      {selectedUser ? <UserInspector user={selectedUser} /> : null}
    </div>
  );
}

const userColumns: ConsoleTableColumn<UserSummary>[] = [
  { id: "member", header: "Member", size: 280, accessorFn: displayUser, cell: ({ row }) => <UserCell name={displayUser(row.original)} detail={row.original.email ?? row.original.externalId} /> },
  { id: "activity", header: "Activity", size: 220, accessorFn: (user) => user.recentActivity ?? "", cell: ({ row }) => <Badge>{row.original.recentActivity ? formatDateTime(row.original.recentActivity) : "none"}</Badge> },
  { id: "status", header: "Status", size: 130, accessorFn: userStatus, cell: ({ row }) => <StatusBadge status={userStatus(row.original)} /> },
  { id: "sessions", header: "Sessions", size: 120, accessorFn: (user) => user.sessionCount, cell: ({ row }) => <span className="mono">{row.original.sessionCount}</span> },
  { id: "requests", header: "Requests", size: 130, accessorFn: (user) => user.requestCount, cell: ({ row }) => <span className="mono">{row.original.requestCount}</span> },
  { id: "tokens", header: "Tokens", size: 140, accessorFn: (user) => user.usage.totalTokens, cell: ({ row }) => <span className="mono">{formatCompact(row.original.usage.totalTokens)}</span> },
  { id: "spend", header: "Spend", size: 130, accessorFn: (user) => user.cost.selected, cell: ({ row }) => <span className="mono">{formatMoney(row.original.cost.selected)}</span> },
  { id: "created", header: "Created", size: 180, accessorFn: (user) => user.createdAt, cell: ({ row }) => formatDateTime(row.original.createdAt) }
];

const userFilters: ConsoleTableFilter<UserSummary>[] = [
  {
    id: "status",
    label: "Status",
    allLabel: "All users",
    options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }],
    getValue: userStatus
  }
];

const userAdvancedFields: ConsoleTableAdvancedField<UserSummary>[] = [
  { id: "name", label: "Name", getValue: displayUser },
  { id: "email", label: "Email", getValue: (user) => user.email },
  { id: "externalId", label: "External ID", getValue: (user) => user.externalId },
  { id: "status", label: "Status", getValue: userStatus },
  { id: "requests", label: "Requests", getValue: (user) => user.requestCount },
  { id: "sessions", label: "Sessions", getValue: (user) => user.sessionCount }
];

function UserInspector({ user }: { user: UserSummary }) {
  return (
    <InspectorPanel
      title={displayUser(user)}
      subtitle={user.email ?? user.externalId ?? user.userId}
      rows={[
        { label: "Requests", value: user.requestCount },
        { label: "Sessions", value: user.sessionCount },
        { label: "Tokens", value: formatCompact(user.usage.totalTokens) },
        { label: "Spend", value: formatMoney(user.cost.selected) },
        { label: "Recent activity", value: user.recentActivity ? formatDateTime(user.recentActivity) : "none" }
      ]}
    />
  );
}

function userSearchValue(user: UserSummary) {
  return [user.userId, user.name, user.email, user.externalId].filter((value): value is string => Boolean(value));
}

function userStatus(user: UserSummary) {
  return user.recentActivity ? "active" : "inactive";
}
