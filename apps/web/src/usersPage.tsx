import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { useState } from "react";

import { type UserSummary, fetchUsers } from "./api";
import { displayUser } from "./consoleData";
import { downloadJson, InspectorPanel } from "./dashboard";
import { formatCompact, formatDateTime, formatMoney } from "./format";
import { Badge, DataTable, GlassCard, PageState, PageTitle, StatusBadge, UserCell } from "./ui";

const filters = ["all", "active", "inactive"];

export function UsersPage() {
  const [queryText, setQueryText] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["users"], queryFn: fetchUsers });

  if (query.isLoading) return <PageState title="Users" label="Loading users" />;
  if (query.error) return <PageState title="Users" label={query.error.message} />;

  const users = query.data?.data ?? [];
  const filtered = users.filter((user) => matchesUser(user, queryText, status));
  const selectedUser = users.find((user) => user.userId === selectedUserId) ?? filtered[0];
  const exportUsers = () => downloadJson("proxy-users.json", { users: filtered, selectedUser });
  return (
    <div className="page page-enter">
      <PageTitle
        title="Users"
        subtitle={`${users.length} observed users · ${users.filter((user) => user.recentActivity).length} active`}
        actions={<button className="btn" type="button" onClick={exportUsers}><Download />Export</button>}
      />
      <div className="logs-filter-row">
        <div className="input logs-search">
          <Search />
          <input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="Search members..." />
        </div>
        <div className="row gap-8 role-filter-row">
          {filters.map((item) => (
            <button key={item} type="button" className={`chip${status === item ? " active" : ""}`} onClick={() => setStatus(item)}>
              {item === "all" ? "All users" : item}
            </button>
          ))}
        </div>
      </div>
      <GlassCard className="table-wrap">
        <DataTable>
          <thead><tr><th>Member</th><th>Activity</th><th>Status</th><th>Sessions</th><th>Requests</th><th>Tokens</th><th>Spend</th><th>Created</th></tr></thead>
          <tbody>
            {filtered.map((user) => (
              <tr
                key={user.userId}
                className={selectedUser?.userId === user.userId ? "selectable-row selected" : "selectable-row"}
                tabIndex={0}
                role="button"
                onClick={() => setSelectedUserId(user.userId)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setSelectedUserId(user.userId);
                }}
              >
                <td><UserCell name={displayUser(user)} detail={user.email ?? user.externalId} /></td>
                <td><Badge>{user.recentActivity ? formatDateTime(user.recentActivity) : "none"}</Badge></td>
                <td><StatusBadge status={user.recentActivity ? "active" : "inactive"} /></td>
                <td className="mono">{user.sessionCount}</td>
                <td className="mono">{user.requestCount}</td>
                <td className="mono">{formatCompact(user.usage.totalTokens)}</td>
                <td className="mono">{formatMoney(user.cost.selected)}</td>
                <td>{formatDateTime(user.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
        {filtered.length === 0 ? <div className="empty">No users match these filters.</div> : null}
      </GlassCard>
      {selectedUser ? <UserInspector user={selectedUser} /> : null}
    </div>
  );
}

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

function matchesUser(user: UserSummary, queryText: string, status: string) {
  const isActive = Boolean(user.recentActivity);
  const statusMatches = status === "all" || (status === "active" ? isActive : !isActive);
  const haystack = [user.userId, user.name, user.email, user.externalId].join(" ").toLowerCase();
  return statusMatches && haystack.includes(queryText.toLowerCase());
}
