import type { ReactNode } from "react";

import { AreaChart, DonutChart, MiniBars, Sparkline, type DonutDatum } from "./charts";
import { formatCompact, formatCompactMoney, formatInteger, formatMoney, formatPercent } from "./format";
import { Badge, DataTable, Delta, GlassCard, Segmented, StatCard } from "./ui";
import {
  OTHER_GROUP_KEY,
  cacheHitPointSeries,
  cacheHitRate,
  hasPricedSpend,
  metricValue,
  percentDelta,
  seriesColor,
  totalsPointSeries,
  type GroupLabelLookups,
  type UsageMetric
} from "./usageAnalytics";
import { TopGroupsList } from "./usageBreakdown";
import type { UsageGroup, UsageTimeseries } from "./usageData";

export type UsageDashboardData = {
  totals: UsageGroup;
  previousTotals: UsageGroup | undefined;
  timeseries: UsageTimeseries;
  modelGroups: UsageGroup[] | undefined;
  userGroups: UsageGroup[] | undefined;
  lookups: GroupLabelLookups;
};

const usageMetricOptions = [
  { value: "cost", label: "Spend" },
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" }
] as const;

const metricConfigs: Record<UsageMetric, {
  color: string;
  format: (value: number) => string;
  tickFormat: (value: number) => string;
}> = {
  cost: {
    color: "var(--accent)",
    format: (value) => formatMoney(value, Math.abs(value) < 100 ? undefined : 0),
    tickFormat: formatCompactMoney
  },
  tokens: { color: "var(--accent-2)", format: formatCompact, tickFormat: formatCompact },
  requests: { color: "#38bdf8", format: formatInteger, tickFormat: formatCompact }
};

function metricLabel(metric: UsageMetric) {
  return usageMetricOptions.find((option) => option.value === metric)?.label ?? metric;
}

export function UsageGridLayout({ data, metric, onMetric, rangeControl }: {
  data: UsageDashboardData;
  metric: UsageMetric;
  onMetric: (metric: UsageMetric) => void;
  rangeControl: ReactNode;
}) {
  const { totals, previousTotals, timeseries, modelGroups, userGroups, lookups } = data;
  const config = metricConfigs[metric];
  const rate = cacheHitRate(totals);
  const spendPriced = hasPricedSpend(modelGroups);

  return (
    <>
      <div className="row usage-grid-range">{rangeControl}</div>
      <div className="usage-kpi-grid">
        <StatCard
          metric={{
            label: "Spend",
            value: metricConfigs.cost.format(totals.cost.selected),
            delta: percentDelta(totals.cost.selected, previousTotals?.cost.selected),
            deltaPositiveIsGood: false
          }}
          chart={<Sparkline data={totalsPointSeries(timeseries, "cost")} valueFormatter={formatMoney} />}
        />
        <StatCard
          metric={{
            label: "Tokens",
            value: formatCompact(totals.usage.totalTokens),
            delta: percentDelta(totals.usage.totalTokens, previousTotals?.usage.totalTokens)
          }}
          chart={<MiniBars data={totalsPointSeries(timeseries, "tokens")} color={metricConfigs.tokens.color} valueFormatter={formatCompact} />}
        />
        <StatCard
          metric={{
            label: "Requests",
            value: formatInteger(totals.requestCount),
            delta: percentDelta(totals.requestCount, previousTotals?.requestCount)
          }}
          chart={<Sparkline data={totalsPointSeries(timeseries, "requests")} color={metricConfigs.requests.color} valueFormatter={formatInteger} />}
        />
        <StatCard
          metric={{
            label: "Cache hit rate",
            value: rate === null ? "—" : formatPercent(rate),
            delta: rate === null ? undefined : percentDelta(rate, cacheHitRate(previousTotals))
          }}
          chart={<MiniBars data={cacheHitPointSeries(timeseries)} color="var(--success)" valueFormatter={(value) => `${Math.round(value)}%`} />}
        />
      </div>

      <GlassCard>
        <div className="card-head">
          <div className="card-title">{metricLabel(metric)} over time</div>
          <Segmented options={usageMetricOptions} value={metric} onChange={onMetric} />
        </div>
        <AreaChart
          data={totalsPointSeries(timeseries, metric)}
          height={280}
          color={config.color}
          valueFormatter={config.format}
          tickFormatter={config.tickFormat}
        />
      </GlassCard>

      <div className="usage-grid-split">
        <GlassCard>
          <div className="card-title donut-card-title">{spendPriced ? "Spend by model" : "Tokens by model"}</div>
          <ModelDonut groups={modelGroups} metric={spendPriced ? "cost" : "tokens"} />
        </GlassCard>
        <GlassCard>
          <div className="card-title donut-card-title">{topUsersTitle(userGroups)}</div>
          <TopUsersList groups={userGroups} lookups={lookups} />
        </GlassCard>
      </div>
    </>
  );
}

export function UsageFocusLayout({ data, metric, onMetric, rangeControl, rangeNote }: {
  data: UsageDashboardData;
  metric: UsageMetric;
  onMetric: (metric: UsageMetric) => void;
  rangeControl: ReactNode;
  rangeNote: string;
}) {
  const { totals, previousTotals, timeseries, modelGroups } = data;
  const config = metricConfigs[metric];
  const current = metricValue(totals, metric);
  const delta = percentDelta(current, previousTotals ? metricValue(previousTotals, metric) : undefined);

  return (
    <>
      <GlassCard className="usage-focus-hero">
        <div className="usage-focus-head">
          <div>
            <Segmented accent options={usageMetricOptions} value={metric} onChange={onMetric} />
            <div className="stat-value big usage-focus-value">{config.format(current)}</div>
            <div className="row gap-8 usage-focus-delta">
              {delta === undefined ? (
                <span className="faint">no previous period to compare · {rangeNote}</span>
              ) : (
                <>
                  <Delta value={delta} positiveIsGood={metric !== "cost"} />
                  <span className="faint">vs previous period · {rangeNote}</span>
                </>
              )}
            </div>
          </div>
          {rangeControl}
        </div>
        <AreaChart
          data={totalsPointSeries(timeseries, metric)}
          height={300}
          color={config.color}
          valueFormatter={config.format}
          tickFormatter={config.tickFormat}
        />
      </GlassCard>

      <div className="usage-focus-split">
        <GlassCard>
          <div className="card-title donut-card-title">Distribution by model</div>
          <ModelDonut groups={modelGroups} metric={metric} size={170} />
        </GlassCard>
        <GlassCard className="usage-focus-table table-wrap">
          <ModelBreakdownTable groups={modelGroups} totals={totals} metric={metric} />
        </GlassCard>
      </div>
    </>
  );
}

const DONUT_SEGMENTS = 5;

function ModelDonut({ groups, metric, size = 190 }: {
  groups: UsageGroup[] | undefined;
  metric: UsageMetric;
  size?: number;
}) {
  if (!groups) return <div className="inline-skeleton skeleton-pulse" style={{ height: size }} />;
  const rows = groups
    .map((row) => ({ key: row.key, value: metricValue(row, metric) }))
    .filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value);
  const data: DonutDatum[] = rows.slice(0, DONUT_SEGMENTS).map((row, index) => ({
    key: row.key,
    label: row.key,
    value: row.value,
    color: seriesColor(index, row.key)
  }));
  const rest = rows.slice(DONUT_SEGMENTS).reduce((sum, row) => sum + row.value, 0);
  if (rest > 0) data.push({ key: OTHER_GROUP_KEY, label: "Other", value: rest, color: seriesColor(0, OTHER_GROUP_KEY) });
  return (
    <DonutChart
      data={data}
      size={size}
      centerLabel={metricLabel(metric).toLowerCase()}
      valueFormatter={metricConfigs[metric].format}
      emptyLabel={metric === "cost" ? "No priced traffic in this window." : "No model usage in this window."}
    />
  );
}

function topUsersTitle(groups: UsageGroup[] | undefined) {
  return hasPricedSpend(groups) ? "Top users by spend" : "Top users by tokens";
}

function TopUsersList({ groups, lookups }: { groups: UsageGroup[] | undefined; lookups: GroupLabelLookups }) {
  if (!groups) return <div className="inline-skeleton skeleton-pulse" style={{ height: 190 }} />;
  return <TopGroupsList dimension="user" rows={groups} lookups={lookups} limit={5} emptyLabel="No user activity in this window." />;
}

function ModelBreakdownTable({ groups, totals, metric }: {
  groups: UsageGroup[] | undefined;
  totals: UsageGroup;
  metric: UsageMetric;
}) {
  if (!groups) return <div className="inline-skeleton skeleton-pulse" style={{ height: 220 }} />;
  const rows = groups
    .filter((row) => row.requestCount > 0 || row.usage.totalTokens > 0)
    .sort((left, right) => metricValue(right, metric) - metricValue(left, metric))
    .slice(0, 8);
  if (rows.length === 0) return <div className="empty compact-empty">No model usage in this window.</div>;
  const totalValue = metricValue(totals, metric);
  return (
    <DataTable>
      <thead>
        <tr>
          <th>Model</th>
          <th>Tokens</th>
          <th>Requests</th>
          <th>Spend</th>
          <th>Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.key}>
            <td>
              <span className="row gap-8">
                <span className="model-dot" style={{ background: seriesColor(index, row.key) }} />
                <span className="mono">{row.key}</span>
              </span>
            </td>
            <td><span className="mono muted">{formatCompact(row.usage.totalTokens)}</span></td>
            <td><span className="mono muted">{formatInteger(row.requestCount)}</span></td>
            <td><span className="mono">{formatMoney(row.cost.selected)}</span></td>
            <td><Badge variant="accent">{formatPercent(totalValue > 0 ? metricValue(row, metric) / totalValue : 0)}</Badge></td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}
