import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Download, Shield, Users } from "lucide-react";
import { useState } from "react";

import { isListedPromptArtifact, promptArtifactRank } from "./artifactKinds";
import { displayUser } from "./consoleData";
import { downloadJson } from "./dashboard";
import { compactId, formatCompact, formatDateTime, formatMoney } from "./format";
import { graphql } from "./gql";
import type { RequestsPageQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { promptDetailQueryOptions } from "./promptDetailPage";
import { RoutingConfigMicro } from "./routingSnapshot";
import { ConsoleTable, optionItems, uniqueOptionItems, type ConsoleTableAdvancedField, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { usageRangeOptions, usageRangeQuery, type UsageRangeKey } from "./usageAnalytics";
import { PageState, PageTitle, Segmented, StatusBadge, UserCell } from "./ui";

const RequestsPageDocument = graphql(`
  query RequestsPage($start: String, $end: String, $limit: Int) {
    prompts(start: $start, end: $end, limit: $limit) {
      data {
        artifactId
        requestId
        sessionId
        userId
        surface
        kind
        preview
        tokenEstimate
        selectedModel
        finalRoute
        provider
        createdAt
        routingConfig {
          configId
          configName
          version
          configHash
        }
        cost {
          selected
        }
      }
    }
    requests(start: $start, end: $end, limit: $limit) {
      requestId
      selectedModel
      terminalStatus
      latencyMs
      finalRoute
      provider
      apiKeyId
      sessionId
      selectedCost
      usage {
        totalTokens
      }
      routingConfig {
        configId
        configName
        version
        configHash
      }
    }
    users {
      userId
      name
      email
    }
  }
`);

const LOGS_RANGE_ALL = "all";
type LogsRange = UsageRangeKey | typeof LOGS_RANGE_ALL;
const logsRangeOptions = [...usageRangeOptions, { value: LOGS_RANGE_ALL, label: "All" }] as const;
// Wider than the default 50-prompt page so a multi-day window isn't silently truncated.
const SCOPED_LOG_LIMIT = 200;

function isLogsRange(value: unknown): value is LogsRange {
  return logsRangeOptions.some((option) => option.value === value);
}

type PromptSummary = RequestsPageQuery["prompts"]["data"][number];
type RequestSummary = RequestsPageQuery["requests"][number];

type PromptLogRow = {
  prompt: PromptSummary;
  request?: RequestSummary;
  userName: string;
  userEmail?: string | null;
};

export function RequestsPage() {
  const search = useSearch({ strict: false }) as { range?: unknown };
  const range: LogsRange = isLogsRange(search.range) ? search.range : LOGS_RANGE_ALL;
  // Pin "now" on mount so the query key stays stable across re-renders/refetches.
  const [anchor] = useState(() => new Date());
  const window = range === LOGS_RANGE_ALL ? undefined : usageRangeQuery(range, anchor);
  const variables = {
    start: window?.start,
    end: window?.end,
    limit: window ? SCOPED_LOG_LIMIT : undefined
  };
  const query = useQuery({
    queryKey: ["requests-page", range, window?.start ?? null, window?.end ?? null],
    queryFn: () => gqlFetch(RequestsPageDocument, variables)
  });

  if (query.isLoading) return <PageState title="Request logs" label="Loading prompts" />;
  if (query.error) return <PageState title="Request logs" label={query.error.message} />;

  const rows = promptRows(query.data?.prompts.data ?? [], query.data?.requests ?? [], query.data?.users ?? []);
  return (
    <div className="page page-enter">
      <PageTitle
        title="Request logs"
        subtitle={range === LOGS_RANGE_ALL ? "Recent prompts and requests across all time." : `Prompts and requests from the ${rangeLabel(range)}.`}
        actions={<LogsRangeControl range={range} />}
      />
      <ConsoleTable
        className="logs-table-card"
        urlState
        data={rows}
        columns={requestColumns}
        search={{ placeholder: "Search prompts, users, request IDs...", getValue: requestSearchValue }}
        filters={requestFilters(rows)}
        advancedFields={requestAdvancedFields}
        emptyLabel="No requests match these filters."
        actions={({ visibleData }) => (
          <button className="btn" type="button" onClick={() => downloadJson("proxy-request-logs.json", visibleData)}>
            <Download />Export
          </button>
        )}
      />
    </div>
  );
}

function LogsRangeControl({ range }: { range: LogsRange }) {
  const navigate = useNavigate();
  return (
    <Segmented
      options={logsRangeOptions}
      value={range}
      onChange={(next) =>
        void navigate({ to: ".", search: (current) => ({ ...current, range: next === LOGS_RANGE_ALL ? undefined : next }), replace: true })
      }
    />
  );
}

function rangeLabel(range: UsageRangeKey) {
  return `last ${usageRangeOptions.find((option) => option.value === range)?.label ?? range}`;
}

const requestColumns: ConsoleTableColumn<PromptLogRow>[] = [
  { id: "prompt", header: "Prompt", size: 420, accessorFn: (row) => row.prompt.preview ?? "", cell: ({ row }) => <PromptCell row={row.original} /> },
  { id: "status", header: "Status", size: 126, accessorFn: terminalStatus, cell: ({ row }) => <StatusBadge status={terminalStatus(row.original)} /> },
  { id: "user", header: "User", size: 200, accessorFn: (row) => row.userName, cell: ({ row }) => <UserCell name={row.original.userName} detail={row.original.prompt.surface} email={row.original.userEmail} size={24} /> },
  { id: "model", header: "Model", size: 230, accessorFn: selectedModel, cell: ({ row }) => <ModelCell row={row.original} /> },
  { id: "tokens", header: "Tokens", size: 96, accessorFn: totalTokens, cell: ({ row }) => <span className="mono">{formatCompact(totalTokens(row.original))}</span> },
  { id: "cost", header: "Cost", size: 96, accessorFn: selectedCost, cell: ({ row }) => <span className="mono">{formatMoney(selectedCost(row.original))}</span> },
  { id: "latency", header: "Latency", size: 104, accessorFn: (row) => row.request?.latencyMs ?? 0, cell: ({ row }) => <span className="mono faint">{formatLatency(row.original.request?.latencyMs)}</span> },
  { id: "time", header: "Time", size: 130, accessorFn: (row) => row.prompt.createdAt, cell: ({ row }) => <span className="faint nowrap table-time">{formatDateTime(row.original.prompt.createdAt)}</span> }
];

const requestAdvancedFields: ConsoleTableAdvancedField<PromptLogRow>[] = [
  { id: "prompt", label: "Prompt", getValue: (row) => row.prompt.preview },
  { id: "requestId", label: "Request ID", getValue: (row) => row.prompt.requestId },
  { id: "user", label: "User", getValue: (row) => [row.userName, row.prompt.userId ?? ""] },
  { id: "model", label: "Model", getValue: selectedModel },
  { id: "status", label: "Status", getValue: terminalStatus },
  { id: "surface", label: "Surface", getValue: (row) => row.prompt.surface },
  { id: "route", label: "Route", getValue: (row) => row.prompt.finalRoute ?? row.request?.finalRoute },
  { id: "provider", label: "Provider", getValue: (row) => row.prompt.provider ?? row.request?.provider },
  { id: "session", label: "Session", getValue: (row) => row.prompt.sessionId ?? row.request?.sessionId },
  { id: "apiKey", label: "API key", getValue: (row) => row.request?.apiKeyId },
  { id: "routingConfig", label: "Routing config", getValue: (row) => row.prompt.routingConfig?.configName ?? row.request?.routingConfig?.configName }
];

function PromptCell({ row }: { row: PromptLogRow }) {
  const preview = row.prompt.preview;
  const queryClient = useQueryClient();
  const prefetchDetail = () => {
    void queryClient.prefetchQuery({
      ...promptDetailQueryOptions(row.prompt.artifactId),
      staleTime: 30_000
    });
  };
  return (
    <div className="prompt-cell">
      <Link
        to="/logs/$artifactId"
        params={{ artifactId: row.prompt.artifactId }}
        className={`table-link${preview ? "" : " table-link-placeholder"}`}
        onMouseEnter={prefetchDetail}
        onFocus={prefetchDetail}
      >
        {preview ?? "Prompt not stored"}
      </Link>
      <div className="mono faint">
        {compactId(row.prompt.requestId)}
        {row.prompt.sessionId ? (
          <>
            {" · "}
            <Link to="/sessions/$sessionId" params={{ sessionId: row.prompt.sessionId }} className="session-link">
              session
            </Link>
          </>
        ) : null}
      </div>
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

function promptRows(prompts: PromptSummary[], requests: RequestSummary[], users: RequestsPageQuery["users"]): PromptLogRow[] {
  const requestsById = new Map(requests.map((request) => [request.requestId, request]));
  const usersById = new Map(users.map((user) => [user.userId, user]));
  const promptsByRequest = new Map<string, PromptSummary>();
  prompts.filter(isVisiblePromptArtifact).forEach((prompt) => {
    const existing = promptsByRequest.get(prompt.requestId);
    if (!existing || artifactRank(prompt) < artifactRank(existing)) {
      promptsByRequest.set(prompt.requestId, prompt);
    }
  });
  return [...promptsByRequest.values()].map((prompt) => {
    const user = prompt.userId ? usersById.get(prompt.userId) : undefined;
    return {
      prompt,
      request: requestsById.get(prompt.requestId),
      userName: user ? displayUser(user) : prompt.userId ?? "unknown",
      userEmail: user?.email
    };
  });
}

function isVisiblePromptArtifact(prompt: PromptSummary) {
  return isListedPromptArtifact(prompt.kind);
}

function artifactRank(prompt: PromptSummary) {
  return promptArtifactRank(prompt.kind);
}

function formatLatency(value?: number | null) {
  return value === undefined || value === null ? "unknown" : `${formatCompact(value)}ms`;
}
