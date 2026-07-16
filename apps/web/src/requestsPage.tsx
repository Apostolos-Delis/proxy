import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";

import { downloadJson } from "./dashboard";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { promptRows, requestAdvancedFields, requestColumns, requestFilters, requestSearchValue } from "./requestsTable";
import { ConsoleTable } from "./table";
import { usageRangeOptions, usageRangeQuery, type UsageRangeKey } from "./usageAnalytics";
import { GlassCard, Segmented } from "./ui";

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
        requestedLogicalModel
        resolvedLogicalModelId
        deploymentId
        providerConnectionId
        selectedModel
        provider
        createdAt
        cost {
          selected
        }
      }
    }
    requests(start: $start, end: $end, limit: $limit) {
      requestId
      requestedModel
      requestedLogicalModel
      resolvedLogicalModelId
      accessProfileId
      routerKind
      deploymentId
      providerConnectionId
      ingressWireId
      egressWireId
      selectedModel
      terminalStatus
      latencyMs
      provider
      translated
      apiKeyId
      sessionId
      selectedCost
      usage {
        totalTokens
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

export function RequestLogsTable() {
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
  const { isLoading: queryIsLoading, error: queryError, data: queryData } = useQuery({
    queryKey: ["requests-page", range, window?.start ?? null, window?.end ?? null],
    queryFn: () => gqlFetch(RequestsPageDocument, variables)
  });

  if (queryIsLoading) return <RequestLogsState label="Loading prompts" />;
  if (queryError) return <RequestLogsState label={queryError.message} />;

  const rows = promptRows(queryData?.prompts.data ?? [], queryData?.requests ?? [], queryData?.users ?? []);
  return (
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
        <>
          <LogsRangeControl range={range} />
          <button className="btn" type="button" onClick={() => downloadJson("proxy-request-logs.json", visibleData)}>
            <Download />Export
          </button>
        </>
      )}
    />
  );
}

function RequestLogsState({ label }: { label: string }) {
  return (
    <GlassCard className="empty-state">
      <strong>{label}</strong>
      <span>Run traffic through the proxy and this surface will populate automatically.</span>
    </GlassCard>
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
