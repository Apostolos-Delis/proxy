import { Link } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { Boxes, Download, Shield, Users } from "lucide-react";

import { type PromptSummary, type RequestSummary, fetchPrompts, fetchRequests, fetchUsers } from "./api";
import { displayUser } from "./consoleData";
import { downloadJson } from "./dashboard";
import { compactId, formatCompact, formatMoney } from "./format";
import { RoutingConfigMicro } from "./routingSnapshot";
import { ConsoleTable, type ConsoleTableAdvancedField, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { PageState, PageTitle, StatusBadge, UserCell } from "./ui";

type PromptLogRow = {
  prompt: PromptSummary;
  request?: RequestSummary;
  userName: string;
};

export function RequestsPage() {
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
  return (
    <div className="page page-enter">
      <PageTitle
        title="Request logs"
        subtitle="Every prompt routed through Proxy, in real time."
        actions={null}
      />
      <ConsoleTable
        className="logs-table-card"
        data={rows}
        columns={requestColumns}
        search={{ placeholder: "Search prompts, users, request IDs...", getValue: requestSearchValue }}
        filters={requestFilters(rows)}
        advancedFields={requestAdvancedFields}
        emptyLabel="No requests match these filters."
        resultLabel={(count) => `${count} prompts`}
        actions={({ visibleData }) => (
          <button className="btn" type="button" onClick={() => downloadJson("proxy-request-logs.json", visibleData)}>
            <Download />Export
          </button>
        )}
      />
    </div>
  );
}

const requestColumns: ConsoleTableColumn<PromptLogRow>[] = [
  { id: "prompt", header: "Prompt", size: 460, accessorFn: (row) => row.prompt.preview ?? "", cell: ({ row }) => <PromptCell row={row.original} /> },
  { id: "user", header: "User", size: 220, accessorFn: (row) => row.userName, cell: ({ row }) => <UserCell name={row.original.userName} detail={row.original.prompt.surface} /> },
  { id: "model", header: "Model", size: 230, accessorFn: selectedModel, cell: ({ row }) => <ModelCell row={row.original} /> },
  { id: "tokens", header: "Tokens", size: 118, accessorFn: totalTokens, cell: ({ row }) => <span className="mono">{formatCompact(totalTokens(row.original))}</span> },
  { id: "cost", header: "Cost", size: 118, accessorFn: selectedCost, cell: ({ row }) => <span className="mono">{formatMoney(selectedCost(row.original))}</span> },
  { id: "latency", header: "Latency", size: 124, accessorFn: (row) => row.request?.latencyMs ?? 0, cell: ({ row }) => <span className="mono faint">{formatLatency(row.original.request?.latencyMs)}</span> },
  { id: "status", header: "Status", size: 138, accessorFn: terminalStatus, cell: ({ row }) => <StatusBadge status={terminalStatus(row.original)} /> }
];

const requestAdvancedFields: ConsoleTableAdvancedField<PromptLogRow>[] = [
  { id: "prompt", label: "Prompt", getValue: (row) => row.prompt.preview },
  { id: "requestId", label: "Request ID", getValue: (row) => row.prompt.requestId },
  { id: "user", label: "User", getValue: (row) => [row.userName, row.prompt.userId ?? ""] },
  { id: "model", label: "Model", getValue: selectedModel },
  { id: "status", label: "Status", getValue: terminalStatus },
  { id: "surface", label: "Surface", getValue: (row) => row.prompt.surface },
  { id: "route", label: "Route", getValue: (row) => row.prompt.finalRoute ?? row.request?.finalRoute },
  { id: "routingConfig", label: "Routing config", getValue: (row) => row.prompt.routingConfig?.configName ?? row.request?.routingConfig?.configName }
];

function PromptCell({ row }: { row: PromptLogRow }) {
  const promptText = row.prompt.preview ?? "Prompt text was not stored for this request.";
  return (
    <div className="prompt-cell">
      <Link to="/logs/$artifactId" params={{ artifactId: row.prompt.artifactId }} className="table-link">
        {promptText}
      </Link>
      <div className="mono faint">{compactId(row.prompt.requestId)}</div>
    </div>
  );
}

function ModelCell({ row }: { row: PromptLogRow }) {
  return (
    <>
      <span className="row gap-8"><span className="model-dot" /><span className="mono">{selectedModel(row)}</span></span>
      <RoutingConfigMicro snapshot={row.prompt.routingConfig ?? row.request?.routingConfig} />
    </>
  );
}

function requestFilters(rows: PromptLogRow[]): ConsoleTableFilter<PromptLogRow>[] {
  return [
    { id: "user", label: "User", allLabel: "All users", icon: <Users />, options: uniqueOptionItems(rows.map((row) => ({ value: row.prompt.userId ?? "unknown", label: row.userName }))), getValue: (row) => row.prompt.userId ?? "unknown" },
    { id: "model", label: "Model", allLabel: "All models", icon: <Boxes />, options: optionItems(rows.map(selectedModel)), getValue: selectedModel },
    { id: "status", label: "Status", allLabel: "All statuses", icon: <Shield />, options: optionItems(rows.map(terminalStatus)), getValue: terminalStatus }
  ];
}

function requestSearchValue(row: PromptLogRow) {
  const { prompt, request } = row;
  return [
    prompt.preview,
    prompt.requestId,
    prompt.routingConfig?.configName,
    prompt.routingConfig?.configHash,
    request?.routingConfig?.configName,
    request?.routingConfig?.configHash,
    row.userName,
    prompt.userId,
    selectedModel(row),
    terminalStatus(row),
    prompt.surface
  ].filter((value): value is string => Boolean(value));
}

function totalTokens(row: PromptLogRow) {
  return row.request?.usage.totalTokens ?? row.prompt.tokenEstimate ?? 0;
}

function selectedCost(row: PromptLogRow) {
  return row.request?.selectedCost ?? row.prompt.cost.selected;
}

function selectedModel(row: PromptLogRow) {
  return row.prompt.selectedModel ?? row.request?.selectedModel ?? "unknown";
}

function terminalStatus(row: PromptLogRow) {
  return row.request?.terminalStatus ?? "unknown";
}

function optionItems(values: string[]) {
  return uniqueOptions(values).map((value) => ({ value, label: value }));
}

function uniqueOptionItems(values: { value: string; label: string }[]) {
  const options = new Map<string, string>();
  values.forEach((item) => {
    if (!options.has(item.value)) options.set(item.value, item.label);
  });
  return [...options].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
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

function formatLatency(value?: number) {
  return value === undefined ? "unknown" : `${formatCompact(value)}ms`;
}
