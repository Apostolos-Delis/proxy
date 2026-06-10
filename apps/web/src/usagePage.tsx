import { useQueries } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";

import { type UsageResponse, fetchRequests, fetchUsage, fetchUsers } from "./api";
import { SpendBaselineChart } from "./charts";
import { downloadJson } from "./dashboard";
import { modelRowsFromUsage, seriesFromRequests, topUsersFromUsage } from "./consoleData";
import { formatCompact, formatInteger, formatMoney } from "./format";
import { GlassCard, PageState, Segmented } from "./ui";
import {
  UsageBreakdown,
  UsageSideRail,
  UsageSummaryStrip,
  usageDimensions,
  type UsageDimension,
  type UsageSideTab
} from "./usageDashboard";

const rangeOptions = [
  { value: "1", label: "24h" },
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" }
] as const;

const metricOptions = [
  { value: "cost", label: "Spend" },
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" }
] as const;

type RangeDays = (typeof rangeOptions)[number]["value"];
type ChartMetric = (typeof metricOptions)[number]["value"];
type RequestsResponse = Awaited<ReturnType<typeof fetchRequests>>;
type UsersResponse = Awaited<ReturnType<typeof fetchUsers>>;

export function UsagePage() {
  const [rangeDays, setRangeDays] = useState<RangeDays>("30");
  const [metric, setMetric] = useState<ChartMetric | null>(null);
  const [sideTab, setSideTab] = useState<UsageSideTab>("users");
  const [dimension, setDimension] = useState<UsageDimension>("route");
  const queries = useQueries({
    queries: [
      ...usageDimensions.map(({ value }) => ({ queryKey: ["usage", value], queryFn: () => fetchUsage(value) })),
      { queryKey: ["requests"], queryFn: fetchRequests },
      { queryKey: ["users"], queryFn: fetchUsers }
    ]
  });
  const loading = queries.some((query) => query.isLoading);
  const error = queries.find((query) => query.error)?.error;
  const usageResponses = queries.slice(0, usageDimensions.length).map((query) => query.data).filter((item): item is UsageResponse => Boolean(item));
  const requestsResponse = queries[usageDimensions.length].data as RequestsResponse | undefined;
  const usersResponse = queries[usageDimensions.length + 1].data as UsersResponse | undefined;
  const requests = requestsResponse?.data ?? [];
  const usersData = usersResponse?.data ?? [];

  if (loading) return <PageState title="Usage" label="Loading usage" />;
  if (error) return <PageState title="Usage" label={error.message} />;
  if (usageResponses.length === 0) return <PageState title="Usage" label="No usage data" />;

  const totals = usageResponses[0].totals;
  const days = Number(rangeDays);
  // Spend is the lead metric, but fall back to tokens while pricing is unset and every cost is $0.
  const chartMetric = metric ?? (totals.cost.selected > 0 ? "cost" : "tokens");
  const chartSeries = seriesFromRequests(requests, chartMetric, days);
  const baselineSeries = chartMetric === "cost" ? seriesFromRequests(requests, "baseline", days) : [];
  const showBaseline = baselineSeries.some((point) => point.value > 0);
  const chartFormatter = metricFormatter(chartMetric);
  const modelRows = modelRowsFromUsage(usageResponses.find((response) => response.groupBy === "model")?.data ?? []);
  const usersById = new Map(usersData.map((user) => [user.userId, user]));
  const users = topUsersFromUsage(usageResponses.find((response) => response.groupBy === "user")?.data ?? [], usersById);
  const refresh = () => queries.forEach((query) => void query.refetch());
  const exportUsage = () => {
    downloadJson("proxy-usage.json", { totals, usage: usageResponses, requests });
  };

  return (
    <div className="page page-enter">
      <div className="usage-console-layout">
        <GlassCard className="usage-primary">
          <div className="card-head">
            <div>
              <div className="card-title">Total spend<span className="usage-scope-note">all time</span></div>
              <div className="stat-value big">{formatMoney(totals.cost.selected)}</div>
              <div className="row gap-8 usage-spend-sub">
                <span className="badge badge-accent">{formatMoney(totals.cost.savings)} saved</span>
                <span className="faint">vs {formatMoney(totals.cost.baseline)} baseline</span>
              </div>
            </div>
            <div className="row gap-8">
              <Segmented options={rangeOptions} value={rangeDays} onChange={setRangeDays} />
              <button className="btn btn-icon" type="button" aria-label="Refresh" onClick={refresh}><RefreshCw /></button>
              <button className="btn btn-icon" type="button" aria-label="Export" onClick={exportUsage}><Download /></button>
            </div>
          </div>
          <div className="chart-controls">
            <Segmented options={metricOptions} value={chartMetric} onChange={setMetric} />
            {showBaseline ? (
              <div className="chart-legend">
                <span><i className="legend-bar" />Spend</span>
                <span><i className="legend-baseline" />Baseline</span>
              </div>
            ) : null}
          </div>
          <SpendBaselineChart data={chartSeries} baseline={baselineSeries} height={280} valueFormatter={chartFormatter} />
          <div className="sep" />
          <UsageSummaryStrip totals={totals} />
        </GlassCard>

        <UsageSideRail totals={totals} sideTab={sideTab} users={users} modelRows={modelRows} onSideTab={setSideTab} />
      </div>

      <UsageBreakdown responses={usageResponses} dimension={dimension} usersById={usersById} onDimension={setDimension} />
    </div>
  );
}

function metricFormatter(metric: ChartMetric) {
  if (metric === "cost") return formatMoney;
  if (metric === "tokens") return formatCompact;
  return formatInteger;
}
