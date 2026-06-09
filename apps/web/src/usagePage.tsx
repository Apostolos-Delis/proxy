import { useQueries } from "@tanstack/react-query";
import { Calendar, Download, RefreshCw, X, Zap } from "lucide-react";
import { useState } from "react";

import { type UsageResponse, fetchRequests, fetchUsage, fetchUsers } from "./api";
import { BarChart } from "./charts";
import { downloadJson } from "./dashboard";
import { modelRowsFromUsage, seriesFromRequests, topUsersFromUsers } from "./consoleData";
import { formatMoney } from "./format";
import { GlassCard, PageState, Segmented } from "./ui";
import {
  chartSelection,
  defaultUsageSelection,
  UsageGroupPanel,
  UsageInspector,
  UsageSideRail,
  UsageSummaryStrip,
  type UsageSelection,
  type UsageSideTab
} from "./usageDashboard";

const usageGroups = ["route", "provider", "model", "user", "surface", "session"];

type RequestsResponse = Awaited<ReturnType<typeof fetchRequests>>;
type UsersResponse = Awaited<ReturnType<typeof fetchUsers>>;

export function UsagePage() {
  const [layout, setLayout] = useState<"console" | "grid" | "focus">("console");
  const [rangeDays, setRangeDays] = useState<"1" | "7" | "30" | "90">("30");
  const [sideTab, setSideTab] = useState<UsageSideTab>("users");
  const [selection, setSelection] = useState<UsageSelection | null>(null);
  const queries = useQueries({
    queries: [
      ...usageGroups.map((groupBy) => ({ queryKey: ["usage", groupBy], queryFn: () => fetchUsage(groupBy) })),
      { queryKey: ["requests"], queryFn: fetchRequests },
      { queryKey: ["users"], queryFn: fetchUsers }
    ]
  });
  const loading = queries.some((query) => query.isLoading);
  const error = queries.find((query) => query.error)?.error;
  const usageResponses = queries.slice(0, usageGroups.length).map((query) => query.data).filter((item): item is UsageResponse => Boolean(item));
  const requestsResponse = queries[usageGroups.length].data as RequestsResponse | undefined;
  const usersResponse = queries[usageGroups.length + 1].data as UsersResponse | undefined;
  const requests = requestsResponse?.data ?? [];
  const usersData = usersResponse?.data ?? [];

  if (loading) return <PageState title="Usage" label="Loading usage" />;
  if (error) return <PageState title="Usage" label={error.message} />;
  if (usageResponses.length === 0) return <PageState title="Usage" label="No usage data" />;

  const totals = usageResponses[0].totals;
  const spendSeries = seriesFromRequests(requests, "cost", Number(rangeDays));
  const comparison = Math.max(totals.cost.baseline, totals.cost.selected);
  const modelRows = modelRowsFromUsage(usageResponses.find((response) => response.groupBy === "model")?.data ?? []);
  const users = topUsersFromUsers(usersData);
  const activeSelection = selection ?? defaultUsageSelection(totals);
  const refresh = () => queries.forEach((query) => void query.refetch());
  const exportUsage = () => {
    downloadJson("proxy-usage.json", { totals, usage: usageResponses, requests, selection: activeSelection });
  };
  const updateRange = (value: "1" | "7" | "30" | "90") => {
    setRangeDays(value);
    setSelection(null);
  };

  return (
    <div className="page page-enter">
      <div className="usage-toolbar">
        <div className="row gap-8">
          <div className="chip active"><Zap />Default project <X /></div>
          <div className="chip"><Calendar />{rangeDays === "1" ? "Last 24h" : `Last ${rangeDays}d`}</div>
        </div>
        <div className="row gap-8">
          <span className="faint">Layout</span>
          <Segmented accent options={[{ value: "console", label: "Console" }, { value: "grid", label: "Grid" }, { value: "focus", label: "Focus" }]} value={layout} onChange={setLayout} />
          <button className="btn btn-icon" type="button" aria-label="Refresh" onClick={refresh}><RefreshCw /></button>
          <button className="btn btn-icon" type="button" aria-label="Export" onClick={exportUsage}><Download /></button>
        </div>
      </div>

      <div className={`usage-console-layout layout-${layout}`}>
        <GlassCard className="usage-primary">
          <div className="card-head">
            <div>
              <div className="card-title">Total spend</div>
              <div className="stat-value big">{formatMoney(totals.cost.selected)}</div>
              <div className="row gap-8"><span className="delta up">up 12.6%</span><span className="faint">vs previous 30d</span></div>
            </div>
            <Segmented
              options={[{ value: "1", label: "24h" }, { value: "7", label: "7d" }, { value: "30", label: "30d" }, { value: "90", label: "90d" }]}
              value={rangeDays}
              onChange={updateRange}
            />
          </div>
          <BarChart
            data={spendSeries}
            height={330}
            budget={spendSeries.length > 0 ? comparison / spendSeries.length : undefined}
            selectedIndex={activeSelection.id.startsWith("day:") ? Number(activeSelection.id.slice("day:".length)) : undefined}
            onSelect={(value) => setSelection(chartSelection(value))}
            valueFormatter={formatMoney}
          />
          <div className="sep" />
          <UsageSummaryStrip tokens={totals.usage.totalTokens} requests={totals.requestCount} averageCost={totals.cost.selected / Math.max(totals.requestCount, 1)} />
        </GlassCard>

        <UsageSideRail
          totals={totals}
          comparison={comparison}
          sideTab={sideTab}
          users={users}
          modelRows={modelRows}
          onSideTab={setSideTab}
          onSelect={setSelection}
          selectedId={activeSelection.id}
        />
      </div>

      <UsageInspector selection={activeSelection} />

      <div className="usage-card-grid">
        {usageResponses.map((response) => (
          <UsageGroupPanel key={response.groupBy} response={response} selectedId={activeSelection.id} onSelect={setSelection} />
        ))}
      </div>
    </div>
  );
}
