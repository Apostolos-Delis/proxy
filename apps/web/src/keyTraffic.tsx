import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { AreaChart } from "./charts";
import { seriesFromRequests } from "./consoleData";
import { formatCompact, formatCompactMoney, formatDateTime, formatMoney } from "./format";
import { graphql } from "./gql";
import type { KeyTrafficRequestsQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { usageRangeOptions, usageRangeQuery, type UsageRangeKey } from "./usageAnalytics";
import { Segmented, StatusBadge } from "./ui";

// Shared by the API-key and provider-key slideouts: both attribute the same
// request stream to "their" key and render the same usage/log sections.
const KeyTrafficRequestsDocument = graphql(`
  query KeyTrafficRequests($start: String, $end: String, $limit: Int) {
    requests(start: $start, end: $end, limit: $limit) {
      requestId
      createdAt
      provider
      apiKeyId
      selectedModel
      terminalStatus
      selectedCost
      baselineCost
      usage {
        totalTokens
      }
    }
  }
`);

// Server caps the requests list at 1000 rows; the caption flags truncation.
export const REQUEST_LIMIT = 1000;
const LOG_ROWS = 10;

export type KeyTrafficRequest = KeyTrafficRequestsQuery["requests"][number];

const metricOptions = [
  { value: "requests", label: "Requests" },
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Spend" }
] as const;

export type MetricKey = (typeof metricOptions)[number]["value"];

export function useKeyTraffic() {
  const [range, setRange] = useState<UsageRangeKey>("7");
  const [metric, setMetric] = useState<MetricKey>("requests");
  // Pin "now" on mount so the query key stays stable across re-renders/refetches.
  const [anchor] = useState(() => new Date());
  const window = usageRangeQuery(range, anchor);
  const { data, error, isLoading } = useQuery({
    queryKey: ["key-traffic-requests", window.start, window.end],
    queryFn: () => gqlFetch(KeyTrafficRequestsDocument, { start: window.start, end: window.end, limit: REQUEST_LIMIT }),
    placeholderData: keepPreviousData
  });
  const requestsQuery = { data, error, isLoading };
  return { range, setRange, metric, setMetric, requestsQuery };
}

export function KeyUsageSection({ loading, empty, requests, truncated, range, onRangeChange, metric, onMetricChange, caption }: {
  loading: boolean;
  empty?: string;
  requests: KeyTrafficRequest[];
  truncated: boolean;
  range: UsageRangeKey;
  onRangeChange: (range: UsageRangeKey) => void;
  metric: MetricKey;
  onMetricChange: (metric: MetricKey) => void;
  caption: string;
}) {
  return (
    <section>
      <div className="card-head">
        <div className="card-title">Usage</div>
        <div className="row gap-8">
          <Segmented options={metricOptions} value={metric} onChange={onMetricChange} />
          <Segmented options={usageRangeOptions} value={range} onChange={onRangeChange} />
        </div>
      </div>
      <KeyUsageSectionBody loading={loading} empty={empty} requests={requests} truncated={truncated} range={range} metric={metric} caption={caption} />
    </section>
  );
}

function KeyUsageSectionBody({ loading, empty, requests, truncated, range, metric, caption }: {
  loading: boolean;
  empty?: string;
  requests: KeyTrafficRequest[];
  truncated: boolean;
  range: UsageRangeKey;
  metric: MetricKey;
  caption: string;
}) {
  if (loading) return <div className="empty">Loading usage…</div>;
  if (empty) return <div className="empty">{empty}</div>;
  const spend = requests.reduce((sum, request) => sum + request.selectedCost, 0);
  const tokens = requests.reduce((sum, request) => sum + request.usage.totalTokens, 0);
  return (
    <>
      <div className="key-panel-stats">
        <Fact label="Requests"><span className="mono">{formatCompact(requests.length)}</span></Fact>
        <Fact label="Tokens"><span className="mono">{formatCompact(tokens)}</span></Fact>
        <Fact label="Spend"><span className="mono">{formatMoney(spend)}</span></Fact>
      </div>
      <AreaChart
        data={seriesFromRequests(requests, metric, Number(range))}
        height={190}
        valueFormatter={metric === "cost" ? formatMoney : formatCompact}
        tickFormatter={metric === "cost" ? formatCompactMoney : formatCompact}
      />
      <div className="faint key-panel-caption">
        {caption}
        {truncated ? " Showing the most recent 1,000 requests in this range." : ""}
      </div>
    </>
  );
}

export function RecentKeyRequestsSection({ requests, logsSearch }: {
  requests: KeyTrafficRequest[];
  logsSearch?: Record<string, unknown>;
}) {
  const recent = requests.slice(0, LOG_ROWS);
  return (
    <section>
      <div className="card-head">
        <div className="card-title">Recent requests</div>
        <Link to="/logs" search={logsSearch} className="btn btn-sm">Open logs</Link>
      </div>
      {recent.length === 0 ? (
        <div className="empty">No requests through this key in the selected range.</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>Time</th><th>Model</th><th>Tokens</th><th>Cost</th><th>Status</th></tr>
          </thead>
          <tbody>
            {recent.map((request) => (
              <tr key={request.requestId}>
                <td className="mono faint">{request.createdAt ? formatDateTime(request.createdAt) : "—"}</td>
                <td><span className="row gap-8"><span className="model-dot" /><span className="mono">{request.selectedModel ?? "unknown"}</span></span></td>
                <td className="mono">{formatCompact(request.usage.totalTokens)}</td>
                <td className="mono">{formatMoney(request.selectedCost)}</td>
                <td><StatusBadge status={request.terminalStatus} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}
