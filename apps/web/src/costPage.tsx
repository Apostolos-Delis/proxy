import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";

import { fetchUsageLookups, fetchUsageReport, fetchUsageTimeseries, type UsageGroup } from "./usageData";
import { ChartLegend, StackedBarsChart } from "./charts";
import { downloadJson } from "./dashboard";
import { formatCompact, formatCompactMoney, formatMoney, formatPercent } from "./format";
import { Avatar, BarListRow, GlassCard, PageSkeleton, PageState, ProgressMeter, Segmented } from "./ui";
import {
  groupKeyLabel,
  seriesColor,
  stackedUsageSeries,
  usageRangeOptions,
  usageRangeQuery,
  type GroupLabelLookups,
  type UsageDimension,
  type UsageRangeKey
} from "./usageAnalytics";
import { UsageBreakdownTable, UsageDimensionTabs } from "./usageBreakdown";

const spendTabs = [
  { value: "user", label: "Top users" },
  { value: "api_key", label: "Top keys" },
  { value: "model", label: "Top models" }
] as const;

type SpendTab = (typeof spendTabs)[number]["value"];

export function CostPage() {
  const [range, setRange] = useState<UsageRangeKey>("30");
  const [anchor, setAnchor] = useState(() => new Date());
  const [dimension, setDimension] = useState<UsageDimension>("model");
  const [spendTab, setSpendTab] = useState<SpendTab>("user");
  const { start, end, interval } = usageRangeQuery(range, anchor);
  // Individual useQuery calls, not useQueries: useQueries matches observers by query
  // hash, so a dimension/range switch spins up fresh observers and keepPreviousData
  // has no previous data to keep — the skeleton swap collapses the page scroll.
  const usageQuery = useQuery({
    queryKey: ["usage", dimension, start, end],
    queryFn: () => fetchUsageReport(dimension, { start, end }),
    placeholderData: keepPreviousData
  });
  const timeseriesQuery = useQuery({
    queryKey: ["usage-timeseries", dimension, start, end, interval],
    queryFn: () => fetchUsageTimeseries(dimension, { start, end, interval }),
    placeholderData: keepPreviousData
  });
  const lookupsQuery = useQuery({ queryKey: ["usage-lookups"], queryFn: fetchUsageLookups });
  const spendTabQuery = useQuery({
    queryKey: ["usage", spendTab, start, end],
    queryFn: () => fetchUsageReport(spendTab, { start, end }),
    placeholderData: keepPreviousData
  });
  const error = usageQuery.error ?? timeseriesQuery.error;

  if (error) return <PageState title="Cost" label={error.message} />;

  const usage = usageQuery.data;
  const timeseries = timeseriesQuery.data;
  if (!usage || !timeseries) return <PageSkeleton blocks={[460, 260]} />;

  const totals = usage.totals;
  const lookups: GroupLabelLookups = {
    usersById: new Map((lookupsQuery.data?.users ?? []).map((user) => [user.userId, user])),
    apiKeysById: new Map((lookupsQuery.data?.apiKeys ?? []).map((key) => [key.id, key]))
  };
  const { series, rows } = stackedUsageSeries(timeseries, dimension, "cost", lookups);
  const days = Number(range);
  const runRate = totals.cost.selected / days * 30;
  const savingsRate = totals.cost.baseline > 0 ? totals.cost.savings / totals.cost.baseline : 0;
  const refresh = () => setAnchor(new Date());
  const exportCost = () => {
    downloadJson("proxy-cost.json", { range: { start, end }, usage, timeseries });
  };

  return (
    <div className="page page-enter">
      <div className="usage-console-layout">
        <GlassCard className="usage-primary">
          <div className="card-head">
            <div>
              <div className="card-title">Total spend<span className="usage-scope-note">{rangeLabel(range)}</span></div>
              <div className="stat-value big">{formatMoney(totals.cost.selected)}</div>
              <div className="row gap-8 usage-spend-sub">
                <span className="badge badge-accent">{formatMoney(totals.cost.savings)} saved</span>
                <span className="faint">vs {formatMoney(totals.cost.baseline)} baseline</span>
              </div>
            </div>
            <div className="row gap-8">
              <Segmented options={usageRangeOptions} value={range} onChange={setRange} />
              <button className="btn btn-icon" type="button" aria-label="Refresh" onClick={refresh}><RefreshCw /></button>
              <button className="btn btn-icon" type="button" aria-label="Export" onClick={exportCost}><Download /></button>
            </div>
          </div>
          <div className="chart-controls">
            <ChartLegend series={series} />
          </div>
          <StackedBarsChart
            data={rows}
            series={series}
            height={280}
            valueFormatter={formatMoney}
            tickFormatter={formatCompactMoney}
            zeroNote="No spend recorded in this window — model pricing may be unset"
          />
          <div className="sep" />
          <div className="usage-summary-strip">
            <Summary label="Baseline" value={formatMoney(totals.cost.baseline)} />
            <Summary
              label="Savings"
              value={formatMoney(totals.cost.savings)}
              detail={totals.cost.baseline > 0 ? `${formatPercent(savingsRate)} of baseline` : undefined}
              tone="accent-text"
            />
            <Summary
              label="Avg / request"
              value={totals.requestCount > 0 ? formatMoney(totals.cost.selected / totals.requestCount) : "—"}
            />
            <Summary label="Run rate / mo" value={formatMoney(runRate)} detail="projected from this window" />
          </div>
        </GlassCard>

        <div className="usage-side-rail">
          <GlassCard>
            <div className="card-title">Routing savings</div>
            <div className="stat-value side-spend accent-text">{formatMoney(totals.cost.savings)}</div>
            <ProgressMeter value={totals.cost.selected} max={Math.max(totals.cost.baseline, totals.cost.selected)} />
            <div className="row budget-row">
              <span className="faint">{formatMoney(totals.cost.selected)} spent</span>
              <span className="faint">{formatMoney(totals.cost.baseline)} baseline</span>
            </div>
          </GlassCard>
          <GlassCard>
            <div className="tabs">
              {spendTabs.map((tab) => (
                <button
                  key={tab.value}
                  className={spendTab === tab.value ? "active" : ""}
                  type="button"
                  onClick={() => setSpendTab(tab.value)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <TopSpendList dimension={spendTab} rows={spendTabQuery.data?.data ?? []} lookups={lookups} />
          </GlassCard>
        </div>
      </div>

      <section className="usage-breakdown">
        <UsageDimensionTabs dimension={dimension} onDimension={setDimension} />
        <UsageBreakdownTable mode="cost" dimension={dimension} rows={usage.data} totals={totals} lookups={lookups} />
      </section>
    </div>
  );
}

function TopSpendList({ dimension, rows, lookups }: {
  dimension: SpendTab;
  rows: UsageGroup[];
  lookups: GroupLabelLookups;
}) {
  const top = rows.slice(0, 6);
  const priced = top.some((row) => row.cost.selected > 0);
  const valueOf = priced
    ? (row: UsageGroup) => row.cost.selected
    : (row: UsageGroup) => row.usage.totalTokens;
  const max = Math.max(...top.map(valueOf), 1);
  return (
    <div className="barlist usage-top-list">
      {top.map((row, index) => {
        const label = groupKeyLabel(dimension, row.key, lookups);
        return (
          <BarListRow
            key={row.key}
            label={label}
            value={priced ? formatMoney(row.cost.selected, row.cost.selected < 1 ? undefined : 0) : `${formatCompact(row.usage.totalTokens)} tok`}
            width={(valueOf(row) / max) * 100}
            avatar={dimension === "user" ? <Avatar label={label} size={22} /> : undefined}
            color={dimension === "user" ? undefined : seriesColor(index, row.key)}
            mono={dimension === "model"}
          />
        );
      })}
      {top.length === 0 ? <div className="empty compact-empty">No spend recorded yet.</div> : null}
    </div>
  );
}

function Summary({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div>
      <div className="card-title">{label}</div>
      <strong className={tone}>{value}</strong>
      {detail ? <div className="stat-sub">{detail}</div> : null}
    </div>
  );
}

function rangeLabel(range: UsageRangeKey) {
  const option = usageRangeOptions.find((item) => item.value === range);
  return `last ${option?.label ?? range}`;
}
