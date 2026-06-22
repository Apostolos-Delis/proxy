import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Boxes, Languages, Layers, Shield, TriangleAlert, Users } from "lucide-react";

import { compactId, formatCompact, formatDateTime, formatMoney } from "./format";
import { promptDetailQueryOptions } from "./promptDetailPage";
import {
  formatLatency,
  promptRows,
  requestSearchValue,
  selectedCost,
  selectedModel,
  skipReasonLabel,
  terminalStatus,
  totalTokens,
  translationMode,
  type PromptLogRow
} from "./requestsPageData";
import { RoutingConfigMicro } from "./routingSnapshot";
import { optionItems, uniqueOptionItems, type ConsoleTableAdvancedField, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { StatusBadge, UserCell } from "./ui";

export { promptRows, requestSearchValue };

export const requestColumns: ConsoleTableColumn<PromptLogRow>[] = [
  { id: "prompt", header: "Prompt", size: 420, accessorFn: (row) => row.prompt.preview ?? "", cell: ({ row }) => <PromptCell row={row.original} /> },
  { id: "status", header: "Status", size: 126, accessorFn: terminalStatus, cell: ({ row }) => <StatusBadge status={terminalStatus(row.original)} /> },
  { id: "user", header: "User", size: 200, accessorFn: (row) => row.userName, cell: ({ row }) => <UserCell name={row.original.userName} detail={row.original.prompt.surface} email={row.original.userEmail} size={24} /> },
  { id: "model", header: "Model", size: 230, accessorFn: selectedModel, cell: ({ row }) => <ModelCell row={row.original} /> },
  { id: "tokens", header: "Tokens", size: 96, accessorFn: totalTokens, cell: ({ row }) => <span className="mono">{formatCompact(totalTokens(row.original))}</span> },
  { id: "cost", header: "Cost", size: 96, accessorFn: selectedCost, cell: ({ row }) => <span className="mono">{formatMoney(selectedCost(row.original))}</span> },
  { id: "latency", header: "Latency", size: 104, accessorFn: (row) => row.request?.latencyMs ?? 0, cell: ({ row }) => <span className="mono faint">{formatLatency(row.original.request?.latencyMs)}</span> },
  { id: "time", header: "Time", size: 130, accessorFn: (row) => row.prompt.createdAt, cell: ({ row }) => <span className="faint nowrap table-time">{formatDateTime(row.original.prompt.createdAt)}</span> }
];

export const requestAdvancedFields: ConsoleTableAdvancedField<PromptLogRow>[] = [
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

export function requestFilters(rows: PromptLogRow[]): ConsoleTableFilter<PromptLogRow>[] {
  return [
    { id: "user", label: "User", allLabel: "All users", icon: <Users />, options: uniqueOptionItems(rows.map((row) => ({ value: row.prompt.userId ?? "unknown", label: row.userName }))), getValue: (row) => row.prompt.userId ?? "unknown" },
    { id: "surface", label: "Surface", allLabel: "All surfaces", icon: <Layers />, options: optionItems(rows.map((row) => row.prompt.surface)), getValue: (row) => row.prompt.surface },
    { id: "model", label: "Model", allLabel: "All models", icon: <Boxes />, options: optionItems(rows.map(selectedModel)), getValue: selectedModel },
    { id: "translation", label: "Translation", allLabel: "All modes", icon: <Languages />, options: optionItems(rows.map(translationMode)), getValue: translationMode },
    { id: "skipReason", label: "Skip reason", allLabel: "All skips", icon: <TriangleAlert />, options: uniqueOptionItems(rows.flatMap((row) => row.request?.routeSkipReasons.map(skipReasonLabel) ?? [])), getValue: (row) => row.request?.routeSkipReasons.map(skipReasonLabel) ?? [] },
    { id: "status", label: "Status", allLabel: "All statuses", icon: <Shield />, options: optionItems(rows.map(terminalStatus)), getValue: terminalStatus }
  ];
}

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
      <span className="row gap-8">
        <span className="model-dot" />
        <span className="mono">{selectedModel(row)}</span>
      </span>
      <RoutingConfigMicro snapshot={row.prompt.routingConfig ?? row.request?.routingConfig} />
    </>
  );
}
