import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { AreaChart } from "../charts";
import { seriesFromRequests } from "../consoleData";
import { Drawer } from "../drawer";
import { compactId, formatCompact, formatCompactMoney, formatDateTime, formatMoney } from "../format";
import { graphql } from "../gql";
import type { ProviderKeyRequestsQuery } from "../gql/graphql";
import { gqlFetch } from "../graphql";
import { fetchApiKeys, type ApiKeySummary } from "../routing/data";
import { usageRangeOptions, usageRangeQuery, type UsageRangeKey } from "../usageAnalytics";
import { Segmented, StatusBadge } from "../ui";
import type { ProviderAccountSummary } from "./data";

const ProviderKeyRequestsDocument = graphql(`
  query ProviderKeyRequests($start: String, $end: String, $limit: Int) {
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
const REQUEST_LIMIT = 1000;
const LOG_ROWS = 10;

type ProviderRequest = ProviderKeyRequestsQuery["requests"][number];

const metricOptions = [
  { value: "requests", label: "Requests" },
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Spend" }
] as const;

type MetricKey = (typeof metricOptions)[number]["value"];

export function ProviderKeyDetailPanel({ account, onClose }: {
  account: ProviderAccountSummary;
  onClose: () => void;
}) {
  const [range, setRange] = useState<UsageRangeKey>("7");
  const [metric, setMetric] = useState<MetricKey>("requests");
  // Pin "now" on mount so the query key stays stable across re-renders/refetches.
  const [anchor] = useState(() => new Date());
  const window = usageRangeQuery(range, anchor);
  const keysQuery = useQuery({ queryKey: ["api-keys"], queryFn: fetchApiKeys });
  const requestsQuery = useQuery({
    queryKey: ["provider-key-requests", window.start, window.end],
    queryFn: () => gqlFetch(ProviderKeyRequestsDocument, { start: window.start, end: window.end, limit: REQUEST_LIMIT }),
    placeholderData: keepPreviousData
  });

  const boundKeys = (keysQuery.data ?? []).filter((apiKey) =>
    apiKey.providerCredentials.some((credential) => credential.providerAccountId === account.id)
  );
  const allRequests = requestsQuery.data?.requests ?? [];
  const accountRequests = accountTraffic(allRequests, account, boundKeys);
  const error = keysQuery.error ?? requestsQuery.error;

  return (
    <Drawer
      label={`Provider key ${account.name}`}
      title={account.name}
      subtitle={(
        <span className="row gap-8">
          <span className="code-pill">{account.provider}</span>
          <StatusBadge status={account.status} />
        </span>
      )}
      onClose={onClose}
    >
      <div className="provider-key-panel">
        <div className="fact-grid provider-key-facts">
          <Fact label="Key ID"><span className="mono" title={account.id}>{compactId(account.id, 8)}</span></Fact>
          <Fact label="Secret"><span className="mono">{account.secretHint ?? "—"}</span></Fact>
          <Fact label="Owner">{account.ownerUserId ? <span className="mono">{compactId(account.ownerUserId, 8)}</span> : "organization"}</Fact>
          <Fact label="Bound keys"><span className="mono">{boundKeys.length}</span></Fact>
          <Fact label="Created">{formatDateTime(account.createdAt)}</Fact>
          <Fact label="Last used">{account.lastUsedAt ? formatDateTime(account.lastUsedAt) : "never"}</Fact>
        </div>
        {error ? <div className="empty">{error.message}</div> : (
          <>
            <UsageSection
              loading={keysQuery.isLoading || requestsQuery.isLoading}
              hasBoundKeys={boundKeys.length > 0}
              requests={accountRequests}
              truncated={allRequests.length >= REQUEST_LIMIT}
              range={range}
              onRangeChange={setRange}
              metric={metric}
              onMetricChange={setMetric}
            />
            <BoundKeysSection boundKeys={boundKeys} accountId={account.id} />
            <RecentRequestsSection requests={accountRequests} hasBoundKeys={boundKeys.length > 0} />
          </>
        )}
      </div>
    </Drawer>
  );
}

/** Requests served by this provider key: traffic on its provider from API keys bound to it. */
function accountTraffic(requests: ProviderRequest[], account: ProviderAccountSummary, boundKeys: ApiKeySummary[]) {
  const boundKeyIds = new Set(boundKeys.map((apiKey) => apiKey.id));
  return requests.filter((request) =>
    request.provider === account.provider && request.apiKeyId != null && boundKeyIds.has(request.apiKeyId)
  );
}

function UsageSection({ loading, hasBoundKeys, requests, truncated, range, onRangeChange, metric, onMetricChange }: {
  loading: boolean;
  hasBoundKeys: boolean;
  requests: ProviderRequest[];
  truncated: boolean;
  range: UsageRangeKey;
  onRangeChange: (range: UsageRangeKey) => void;
  metric: MetricKey;
  onMetricChange: (metric: MetricKey) => void;
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
      <UsageSectionBody loading={loading} hasBoundKeys={hasBoundKeys} requests={requests} truncated={truncated} range={range} metric={metric} />
    </section>
  );
}

function UsageSectionBody({ loading, hasBoundKeys, requests, truncated, range, metric }: {
  loading: boolean;
  hasBoundKeys: boolean;
  requests: ProviderRequest[];
  truncated: boolean;
  range: UsageRangeKey;
  metric: MetricKey;
}) {
  if (loading) return <div className="empty">Loading usage…</div>;
  if (!hasBoundKeys) {
    return <div className="empty">No API keys are bound to this provider key, so no traffic flows through it.</div>;
  }
  const spend = requests.reduce((sum, request) => sum + request.selectedCost, 0);
  const tokens = requests.reduce((sum, request) => sum + request.usage.totalTokens, 0);
  return (
    <>
      <div className="provider-key-stats">
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
      <div className="faint provider-key-caption">
        Traffic from API keys currently bound to this provider key.
        {truncated ? " Showing the most recent 1,000 requests in this range." : ""}
      </div>
    </>
  );
}

function BoundKeysSection({ boundKeys, accountId }: { boundKeys: ApiKeySummary[]; accountId: string }) {
  if (boundKeys.length === 0) {
    return (
      <section>
        <div className="card-title">Bound API keys</div>
        <div className="empty">
          Bind an API key on the <Link to="/api-keys" className="session-link">API keys</Link> page to route its traffic through this key.
        </div>
      </section>
    );
  }
  return (
    <section>
      <div className="card-title">Bound API keys</div>
      <div className="provider-key-bound-list">
        {boundKeys.map((apiKey) => (
          <div key={apiKey.id} className="provider-key-bound-row">
            <strong>{apiKey.name}</strong>
            <span className="mono faint" title={apiKey.id}>{compactId(apiKey.id, 8)}</span>
            {bindingStatus(apiKey, accountId)}
          </div>
        ))}
      </div>
    </section>
  );
}

function bindingStatus(apiKey: ApiKeySummary, accountId: string) {
  const binding = apiKey.providerCredentials.find((credential) => credential.providerAccountId === accountId);
  if (apiKey.revokedAt) return <StatusBadge status="revoked" />;
  if (binding?.status && binding.status !== "active") return <StatusBadge status={binding.status} />;
  return null;
}

function RecentRequestsSection({ requests, hasBoundKeys }: { requests: ProviderRequest[]; hasBoundKeys: boolean }) {
  if (!hasBoundKeys) return null;
  const recent = requests.slice(0, LOG_ROWS);
  return (
    <section>
      <div className="card-head">
        <div className="card-title">Recent requests</div>
        <Link to="/logs" className="btn btn-sm">Open logs</Link>
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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}
