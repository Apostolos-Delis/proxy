import { Link } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { Download, Search, Shield, Users } from "lucide-react";
import { useState } from "react";

import { type PromptSummary, type RequestSummary, fetchPrompts, fetchRequests, fetchUsers } from "./api";
import { displayUser } from "./consoleData";
import { downloadJson, FilterMenu } from "./dashboard";
import { compactId, formatCompact, formatMoney } from "./format";
import { RoutingConfigMicro } from "./routingSnapshot";
import { DataTable, GlassCard, PageState, PageTitle, StatusBadge, UserCell } from "./ui";

type PromptLogRow = {
  prompt: PromptSummary;
  request?: RequestSummary;
  userName: string;
};

export function RequestsPage() {
  const [queryText, setQueryText] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [promptsQuery, requestsQuery, usersQuery] = useQueries({
    queries: [
      { queryKey: ["prompts"], queryFn: fetchPrompts },
      { queryKey: ["requests"], queryFn: fetchRequests },
      { queryKey: ["users"], queryFn: fetchUsers }
    ]
  });
  const loading = promptsQuery.isLoading || requestsQuery.isLoading || usersQuery.isLoading;
  const error = promptsQuery.error ?? requestsQuery.error ?? usersQuery.error;

  if (loading) return <PageState title="Request logs" label="Loading prompts" />;
  if (error) return <PageState title="Request logs" label={error.message} />;

  const rows = promptRows(promptsQuery.data?.data ?? [], requestsQuery.data?.data ?? [], usersQuery.data?.data ?? []);
  const filtered = rows.filter((row) => matchesPrompt(row, queryText, statusFilter, userFilter, modelFilter));
  const users = uniqueOptions(rows.map((row) => row.prompt.userId ?? "unknown"));
  const models = uniqueOptions(rows.map((row) => row.prompt.selectedModel ?? row.request?.selectedModel ?? "unknown"));
  const statuses = uniqueOptions(rows.map((row) => row.request?.terminalStatus ?? "unknown"));
  const exportRows = () => {
    downloadJson("proxy-request-logs.json", filtered);
  };

  return (
    <div className="page page-enter">
      <PageTitle
        title="Request logs"
        subtitle="Every prompt routed through Proxy, in real time."
        actions={<button className="btn" type="button" onClick={exportRows}><Download />Export</button>}
      />
      <div className="logs-filter-row">
        <div className="input logs-search">
          <Search />
          <input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="Search prompts, users, request IDs..." />
        </div>
        <FilterMenu
          icon={<Users />}
          label={userFilter === "all" ? "All users" : userFilter}
          open={userMenuOpen}
          active={userFilter !== "all"}
          options={["all", ...users]}
          onOpenChange={setUserMenuOpen}
          onSelect={setUserFilter}
        />
        <FilterMenu
          label={modelFilter === "all" ? "All models" : modelFilter}
          open={modelMenuOpen}
          active={modelFilter !== "all"}
          options={["all", ...models]}
          onOpenChange={setModelMenuOpen}
          onSelect={setModelFilter}
        />
        <FilterMenu
          icon={<Shield />}
          label={statusFilter === "all" ? "All statuses" : statusFilter}
          open={statusMenuOpen}
          active={statusFilter !== "all"}
          options={["all", ...statuses]}
          onOpenChange={setStatusMenuOpen}
          onSelect={setStatusFilter}
        />
        <span className="faint">{filtered.length} prompts</span>
      </div>
      <GlassCard className="table-wrap logs-table-card">
        <DataTable>
          <thead>
            <tr><th>Prompt</th><th>User</th><th>Model</th><th>Tokens</th><th>Cost</th><th>Latency</th><th>Status</th></tr>
          </thead>
          <tbody>
            {filtered.map((row) => <PromptRequestRow key={row.prompt.artifactId} row={row} />)}
          </tbody>
        </DataTable>
        {filtered.length === 0 ? <div className="empty">No requests match these filters.</div> : null}
      </GlassCard>
    </div>
  );
}

function PromptRequestRow({ row }: { row: PromptLogRow }) {
  const { prompt, request } = row;
  const tokens = request?.usage.totalTokens ?? prompt.tokenEstimate ?? 0;
  const cost = request?.selectedCost ?? prompt.cost.selected;
  const promptText = prompt.preview ?? "Prompt text was not stored for this request.";
  return (
    <tr>
      <td className="prompt-cell">
        <Link to="/logs/$artifactId" params={{ artifactId: prompt.artifactId }} className="table-link">
          {promptText}
        </Link>
        <div className="mono faint">{compactId(prompt.requestId)}</div>
      </td>
      <td><UserCell name={row.userName} detail={prompt.surface} /></td>
      <td>
        <span className="row gap-8"><span className="model-dot" /><span className="mono">{prompt.selectedModel ?? request?.selectedModel ?? "unknown"}</span></span>
        <RoutingConfigMicro snapshot={prompt.routingConfig ?? request?.routingConfig} />
      </td>
      <td className="mono">{formatCompact(tokens)}</td>
      <td className="mono">{formatMoney(cost)}</td>
      <td className="mono faint">{formatLatency(request?.latencyMs)}</td>
      <td><StatusBadge status={request?.terminalStatus ?? "unknown"} /></td>
    </tr>
  );
}

function promptRows(prompts: PromptSummary[], requests: RequestSummary[], users: Parameters<typeof displayUser>[0][]): PromptLogRow[] {
  const requestsById = new Map(requests.map((request) => [request.requestId, request]));
  const usersById = new Map(users.map((user) => [user.userId, user]));
  return prompts
    .filter(isVisiblePromptArtifact)
    .map((prompt) => {
      const user = prompt.userId ? usersById.get(prompt.userId) : undefined;
      return {
        prompt,
        request: requestsById.get(prompt.requestId),
        userName: user ? displayUser(user) : prompt.userId ?? "unknown"
      };
    });
}

function isVisiblePromptArtifact(prompt: PromptSummary) {
  return prompt.kind !== "tool_schema_metadata" && prompt.kind !== "request_input";
}

function matchesPrompt(row: PromptLogRow, queryText: string, statusFilter: string, userFilter: string, modelFilter: string) {
  const status = row.request?.terminalStatus ?? "unknown";
  const model = row.prompt.selectedModel ?? row.request?.selectedModel ?? "unknown";
  const user = row.prompt.userId ?? "unknown";
  const haystack = [
    row.prompt.preview,
    row.prompt.requestId,
    row.prompt.routingConfig?.configName,
    row.prompt.routingConfig?.configHash,
    row.request?.routingConfig?.configName,
    row.request?.routingConfig?.configHash,
    row.userName,
    user,
    model,
    status,
    row.prompt.surface
  ].join(" ").toLowerCase();
  return (
    (statusFilter === "all" || status === statusFilter) &&
    (userFilter === "all" || user === userFilter) &&
    (modelFilter === "all" || model === modelFilter) &&
    haystack.includes(queryText.toLowerCase())
  );
}

function uniqueOptions(values: string[]) {
  return [...new Set(values)].filter(Boolean).sort();
}

function formatLatency(value?: number) {
  return value === undefined ? "unknown" : `${formatCompact(value)}ms`;
}
