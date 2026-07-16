import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";

import { isAdminRole } from "./access";
import {
  fetchUsageDashboard,
  fetchUsageLookups,
  fetchUsageReport
} from "./usageData";
import { ChartLegend, StackedBarsChart } from "./charts";
import { downloadJson } from "./dashboard";
import { formatCompact, formatDurationMs, formatInteger, formatPercent } from "./format";
import { GlassCard, PageSkeleton, PageState, Segmented } from "./ui";
import {
  stackedUsageSeries,
  usagePreviousRangeQuery,
  usageRangeOptions,
  usageRangeQuery,
  type UsageDimension,
  type UsageMetric,
  type UsageRangeKey
} from "./usageAnalytics";
import { UsageBreakdownTable, UsageDimensionTabs } from "./usageBreakdown";
import { UsageFocusLayout, UsageGridLayout, type UsageDashboardData } from "./usageLayouts";
import { fetchMe } from "./session";

const metricOptions = [
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" }
] as const;

type UsageChartMetric = (typeof metricOptions)[number]["value"];

const layoutOptions = [
  { value: "console", label: "Console" },
  { value: "grid", label: "Grid" },
  { value: "focus", label: "Focus" }
] as const;

type UsageLayout = (typeof layoutOptions)[number]["value"];

const LAYOUT_STORAGE_KEY = "prompt.usage.layout";

function storedLayout(): UsageLayout {
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    return layoutOptions.find((option) => option.value === raw)?.value ?? "console";
  } catch {
    return "console";
  }
}

export function UsagePage() {
  const [layout, setLayout] = useState<UsageLayout>(storedLayout);
  const [range, setRange] = useState<UsageRangeKey>("30");
  const [anchor, setAnchor] = useState(() => new Date());
  const [metric, setMetric] = useState<UsageChartMetric>("tokens");
  const [dashboardMetric, setDashboardMetric] = useState<UsageMetric>("cost");
  const [dimension, setDimension] = useState<UsageDimension>("model");
  const { start, end, interval } = usageRangeQuery(range, anchor);
  const previousRange = usagePreviousRangeQuery(range, anchor);
  const { data: meQueryData } = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const isAdmin = isAdminRole(meQueryData?.user.role);
  // Individual useQuery calls, not useQueries: useQueries matches observers by query
  // hash, so a dimension/range switch spins up fresh observers and keepPreviousData
  // has no previous data to keep — the skeleton swap collapses the page scroll.
  const {
    error: dashboardQueryError,
    data: dashboardQueryData,
    isPlaceholderData: isDashboardPlaceholderData
  } = useQuery({
    queryKey: ["usage-dashboard", dimension, start, end, interval],
    queryFn: () => fetchUsageDashboard(dimension, { start, end, interval }),
    placeholderData: keepPreviousData
  });
  const dashboardReady = Boolean(dashboardQueryData) && !isDashboardPlaceholderData;
  const { data: usageReportQueryData } = useQuery({
    queryKey: ["usage-report", dimension, start, end],
    queryFn: () => fetchUsageReport(dimension, { start, end }),
    placeholderData: keepPreviousData,
    enabled: layout === "console" && dashboardReady
  });
  const { data: lookupsQueryData } = useQuery({
    queryKey: ["usage-lookups"],
    queryFn: fetchUsageLookups,
    enabled: isAdmin && dashboardReady
  });
  // The Grid/Focus widgets slice by model and user independently of the
  // console breakdown dimension, and compare against the preceding window.
  // When the main dashboard is already grouped by model, reuse that payload.
  const { data: modelQueryData } = useQuery({
    queryKey: ["usage", "model", start, end],
    queryFn: () => fetchUsageReport("model", { start, end }),
    placeholderData: keepPreviousData,
    enabled: layout !== "console" && dimension !== "model" && dashboardReady
  });
  const { data: userQueryData } = useQuery({
    queryKey: ["usage", "user", start, end],
    queryFn: () => fetchUsageReport("user", { start, end }),
    placeholderData: keepPreviousData,
    enabled: layout === "grid" && dashboardReady
  });
  const { data: previousQueryData } = useQuery({
    queryKey: ["usage", "model", previousRange.start, previousRange.end],
    queryFn: () => fetchUsageReport("model", previousRange),
    placeholderData: keepPreviousData,
    enabled: layout !== "console" && dashboardReady
  });
  const error = dashboardQueryError;

  if (error) return <PageState title="Usage" label={error.message} />;

  const usage = layout === "console" ? (usageReportQueryData ?? dashboardQueryData?.usage) : dashboardQueryData?.usage;
  const timeseries = dashboardQueryData?.timeseries;
  if (!usage || !timeseries) return <PageSkeleton blocks={[460, 260]} />;

  const totals = usage.totals;
  const visibleLookups = isAdmin ? lookupsQueryData : undefined;
  const lookups = {
    usersById: new Map((visibleLookups?.members ?? []).map((user) => [user.userId, user])),
    apiKeysById: new Map((visibleLookups?.apiKeys ?? []).map((key) => [key.id, key]))
  };
  const { series, rows } = stackedUsageSeries(timeseries, dimension, metric, lookups);
  const breakdownRows = usage.data;
  const refresh = () => setAnchor(new Date());
  const exportUsage = () => {
    downloadJson("proxy-usage.json", { range: { start, end }, usage, timeseries });
  };
  const changeLayout = (next: UsageLayout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, next);
    } catch {
      // Blocked storage just loses the preference.
    }
  };

  const rangeControl = <Segmented options={usageRangeOptions} value={range} onChange={setRange} />;
  const dashboardData: UsageDashboardData = {
    totals,
    previousTotals: previousQueryData?.totals,
    timeseries,
    modelGroups: dimension === "model" ? usage.data : modelQueryData?.data,
    userGroups: userQueryData?.data,
    lookups
  };

  return (
    <div className="page page-enter">
      <div className="usage-toolbar">
        <Segmented accent options={layoutOptions} value={layout} onChange={changeLayout} />
        <button className="btn btn-icon" type="button" aria-label="Refresh" onClick={refresh}><RefreshCw /></button>
        <button className="btn btn-icon" type="button" aria-label="Export" onClick={exportUsage}><Download /></button>
      </div>

      {layout === "console" ? (
        <>
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
              {rangeControl}
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
            <UsageDimensionTabs dimension={dimension} onDimension={setDimension} canOpenDetails={isAdmin} />
            <UsageBreakdownTable mode="tokens" dimension={dimension} range={range} rows={breakdownRows} totals={totals} lookups={lookups} canOpenDetails={isAdmin} />
          </section>
        </>
      ) : null}

      {layout === "grid" ? (
        <UsageGridLayout data={dashboardData} metric={dashboardMetric} onMetric={setDashboardMetric} rangeControl={rangeControl} />
      ) : null}

      {layout === "focus" ? (
        <UsageFocusLayout
          data={dashboardData}
          metric={dashboardMetric}
          onMetric={setDashboardMetric}
          rangeControl={rangeControl}
          rangeNote={rangeNoteLabel(range)}
        />
      ) : null}
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
  return `last ${rangeNoteLabel(range)}`;
}

function rangeNoteLabel(range: UsageRangeKey) {
  return usageRangeOptions.find((item) => item.value === range)?.label ?? range;
}
