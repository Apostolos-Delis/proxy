import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";

import { fetchApiKeys, fetchUsage, fetchUsageTimeseries, fetchUsers } from "./api";
import { ChartLegend, StackedBarsChart } from "./charts";
import { downloadJson } from "./dashboard";
import { formatCompact, formatInteger, formatPercent } from "./format";
import { GlassCard, PageSkeleton, PageState, Segmented } from "./ui";
import {
  stackedUsageSeries,
  usageRangeOptions,
  usageRangeQuery,
  type UsageDimension,
  type UsageRangeKey
} from "./usageAnalytics";
import { UsageBreakdownTable, UsageDimensionTabs, formatDurationMs } from "./usageBreakdown";

const metricOptions = [
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" }
] as const;

type UsageChartMetric = (typeof metricOptions)[number]["value"];

export function UsagePage() {
  const [range, setRange] = useState<UsageRangeKey>("30");
  const [anchor, setAnchor] = useState(() => new Date());
  const [metric, setMetric] = useState<UsageChartMetric>("tokens");
  const [dimension, setDimension] = useState<UsageDimension>("model");
  const { start, end, interval } = usageRangeQuery(range, anchor);
  const [usageQuery, timeseriesQuery, usersQuery, apiKeysQuery] = useQueries({
    queries: [
      {
        queryKey: ["usage", dimension, start, end],
        queryFn: () => fetchUsage(dimension, { start, end }),
        placeholderData: keepPreviousData
      },
      {
        queryKey: ["usage-timeseries", dimension, start, end, interval],
        queryFn: () => fetchUsageTimeseries(dimension, { start, end, interval }),
        placeholderData: keepPreviousData
      },
      { queryKey: ["users"], queryFn: fetchUsers },
      { queryKey: ["api-keys"], queryFn: fetchApiKeys }
    ]
  });
  const loading = (usageQuery.isLoading || timeseriesQuery.isLoading) && !usageQuery.data;
  const error = usageQuery.error ?? timeseriesQuery.error;

  if (loading) return <PageSkeleton blocks={[460, 260]} />;
  if (error) return <PageState title="Usage" label={error.message} />;

  const usage = usageQuery.data;
  const timeseries = timeseriesQuery.data;
  if (!usage || !timeseries) return <PageState title="Usage" label="No usage data" />;

  const totals = usage.totals;
  const lookups = {
    usersById: new Map((usersQuery.data?.data ?? []).map((user) => [user.userId, user])),
    apiKeysById: new Map((apiKeysQuery.data?.data ?? []).map((key) => [key.id, key]))
  };
  const { series, rows } = stackedUsageSeries(timeseries, dimension, metric, lookups);
  const breakdownRows = usage.data;
  const refresh = () => setAnchor(new Date());
  const exportUsage = () => {
    downloadJson("proxy-usage.json", { range: { start, end }, usage, timeseries });
  };

  return (
    <div className="page page-enter">
      <GlassCard className="usage-primary">
        <div className="card-head">
          <div>
            <div className="card-title">Tokens<span className="usage-scope-note">{rangeLabel(range)}</span></div>
            <div className="stat-value big">{formatCompact(totals.usage.totalTokens)}</div>
            <div className="row gap-8 usage-spend-sub">
              <span className="badge">{formatInteger(totals.requestCount)} requests</span>
              <span className="faint">
                {totals.requestCount > 0 ? `${formatCompact(totals.usage.totalTokens / totals.requestCount)} tok avg / request` : "no requests in range"}
              </span>
            </div>
          </div>
          <div className="row gap-8">
            <Segmented options={usageRangeOptions} value={range} onChange={setRange} />
            <button className="btn btn-icon" type="button" aria-label="Refresh" onClick={refresh}><RefreshCw /></button>
            <button className="btn btn-icon" type="button" aria-label="Export" onClick={exportUsage}><Download /></button>
          </div>
        </div>
        <div className="chart-controls">
          <Segmented options={metricOptions} value={metric} onChange={setMetric} />
          <ChartLegend series={series} />
        </div>
        <StackedBarsChart
          data={rows}
          series={series}
          height={280}
          valueFormatter={formatCompact}
          tickFormatter={formatCompact}
          zeroNote={metric === "tokens" ? "No tokens recorded in this window" : "No requests in this window"}
        />
        <div className="sep" />
        <div className="usage-summary-strip cols-6">
          <Summary label="Input" value={formatCompact(totals.usage.inputTokens)} />
          <Summary label="Cached" value={formatCompact(totals.usage.cachedInputTokens)} />
          <Summary label="Output" value={formatCompact(totals.usage.outputTokens)} />
          <Summary label="Reasoning" value={formatCompact(totals.usage.reasoningTokens)} />
          <Summary label="p95 latency" value={totals.latency.p95Ms === null ? "—" : formatDurationMs(totals.latency.p95Ms)} />
          <Summary
            label="Failure rate"
            value={formatPercent(totals.failureRate)}
            tone={totals.failureRate > 0 ? "danger-text" : undefined}
          />
        </div>
      </GlassCard>

      <section className="usage-breakdown">
        <UsageDimensionTabs dimension={dimension} onDimension={setDimension} />
        <UsageBreakdownTable mode="tokens" dimension={dimension} rows={breakdownRows} totals={totals} lookups={lookups} />
      </section>
    </div>
  );
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="card-title">{label}</div>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function rangeLabel(range: UsageRangeKey) {
  const option = usageRangeOptions.find((item) => item.value === range);
  return `last ${option?.label ?? range}`;
}
