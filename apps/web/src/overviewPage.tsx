import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ArrowUpRight, Coins, Download, KeyRound, Send, Sparkles, Zap } from "lucide-react";
import { useState } from "react";

import { fetchMe, fetchOverview, fetchRequests, fetchUsage } from "./api";
import { AreaChart, type ChartSelection, MiniBars, Sparkline } from "./charts";
import { modelRowsFromUsage, periodDelta, seriesFromRequests } from "./consoleData";
import { downloadJson, InspectorPanel, InteractiveStatCard, type InspectorRow } from "./dashboard";
import { formatCompact, formatInteger, formatMoney, formatPercent } from "./format";
import { ConsoleButton, GlassCard, PageSkeleton, PageState, ProgressMeter, Segmented } from "./ui";

type OverviewSelection = {
  title: string;
  subtitle: string;
  rows: InspectorRow[];
};

const rangeOptions = [
  { value: "1", label: "24h" },
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" }
] as const;

export function OverviewPage() {
  const [rangeDays, setRangeDays] = useState<"1" | "7" | "30" | "90">("7");
  const [selectedPoint, setSelectedPoint] = useState<ChartSelection | null>(null);
  const [selection, setSelection] = useState<OverviewSelection | null>(null);
  const overviewQuery = useQuery({ queryKey: ["overview"], queryFn: fetchOverview });
  const requestsQuery = useQuery({ queryKey: ["requests"], queryFn: fetchRequests });
  const modelUsageQuery = useQuery({ queryKey: ["usage", "model"], queryFn: () => fetchUsage("model") });
  const meQuery = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const loading = overviewQuery.isLoading || requestsQuery.isLoading || modelUsageQuery.isLoading;
  const error = overviewQuery.error ?? requestsQuery.error ?? modelUsageQuery.error;

  if (loading) return <PageSkeleton blocks={[186, 380, 150]} />;
  if (error) return <PageState title="Overview" label={error.message} />;
  if (!overviewQuery.data) return <PageState title="Overview" label="No overview data" />;

  const overview = overviewQuery.data;
  const requests = requestsQuery.data?.data ?? [];
  const days = Number(rangeDays);
  const spendSeries = seriesFromRequests(requests, "cost", days);
  const tokenSeries = seriesFromRequests(requests, "tokens", days);
  const requestSeries = seriesFromRequests(requests, "requests", days);
  // Deltas compare the last 7 days against the 7 days before, independent of the selected range.
  const tokenDelta = periodDelta(seriesFromRequests(requests, "tokens", 14));
  const requestDelta = periodDelta(seriesFromRequests(requests, "requests", 14));
  const spendDelta = periodDelta(seriesFromRequests(requests, "cost", 14));
  const modelRows = modelRowsFromUsage(modelUsageQuery.data?.data ?? []);
  const comparison = Math.max(overview.cost.baseline, overview.cost.selected);
  const comparisonPct = comparison > 0 ? Math.min(100, (overview.cost.selected / comparison) * 100) : 0;
  const inspector = selectedPoint
    ? chartSelection(selectedPoint)
    : selection ?? overviewSelection(overview.cost.savings, overview.cost.baseline, overview.routeQuality.cheaperLikelyWouldWorkCount);
  const activeMetric = selectedPoint ? null : selection?.title ?? null;
  const impactMetrics = [
    {
      label: "Baseline spend",
      value: formatMoney(overview.cost.baseline),
      caption: "without smart routing",
      detail: "What the selected model policy would have cost without routing savings."
    },
    {
      label: "Savings",
      value: formatMoney(overview.cost.savings),
      caption: "avoided spend",
      detail: "Avoided spend from routing to cheaper capable models.",
      tone: overview.cost.savings > 0 ? "accent-text" : undefined
    },
    {
      label: "Low confidence",
      value: formatInteger(overview.routeQuality.lowConfidenceCount),
      caption: "flagged route decisions",
      detail: "Route decisions the classifier marked as lower confidence.",
      tone: overview.routeQuality.lowConfidenceCount > 0 ? "warn-text" : undefined
    },
    {
      label: "Cheaper likely worked",
      value: formatInteger(overview.routeQuality.cheaperLikelyWouldWorkCount),
      caption: "downgrade candidates",
      detail: "Cases where logs suggest a cheaper route probably would have been acceptable.",
      tone: overview.routeQuality.cheaperLikelyWouldWorkCount > 0 ? "warn-text" : undefined
    }
  ];
  const exportOverview = () => downloadJson("proxy-overview.json", { overview, requests, rangeDays, modelRows });
  const updateRange = (value: "1" | "7" | "30" | "90") => {
    setRangeDays(value);
    setSelectedPoint(null);
  };

  return (
    <div className="page page-enter">
      <div className="row gap-12 page-hero-row">
        <div>
          <div className="hero-greeting">{greetingFor(meQuery.data?.user)}</div>
          <div className="muted">Here's what's happening across Proxy Labs.</div>
        </div>
        <div className="row gap-8">
          <Link to="/api-keys" className="btn"><KeyRound />Get API key</Link>
          <Link to="/settings" className="btn btn-primary"><Sparkles />Configure routing</Link>
          <ConsoleButton variant="ghost" onClick={exportOverview}><Download />Export</ConsoleButton>
        </div>
      </div>

      <div className="overview-kpis">
        <InteractiveStatCard
          metric={{ label: "Total tokens", value: formatCompact(overview.totals.totalTokens), icon: <Zap />, delta: tokenDelta }}
          chart={<Sparkline data={tokenSeries.slice(-7)} />}
          to="/usage"
        />
        <InteractiveStatCard
          metric={{ label: "Requests", value: formatInteger(overview.requestCount), icon: <Send />, delta: requestDelta }}
          chart={<MiniBars data={requestSeries.slice(-7)} />}
          to="/logs"
        />
        <InteractiveStatCard
          metric={{ label: "Spend", value: formatMoney(overview.cost.selected, 0), icon: <Coins />, delta: spendDelta, deltaPositiveIsGood: false }}
          chart={<Sparkline data={spendSeries.slice(-7)} />}
          to="/billing"
        />
      </div>

      <div className="row overview-range-row">
        <Segmented options={rangeOptions} value={rangeDays} onChange={updateRange} />
      </div>

      <div className="overview-main-grid">
        <GlassCard>
          <div className="card-head">
            <div className="card-title">Request volume</div>
            <span className="muted mono">{formatInteger(overview.requestCount)} requests · {rangeLabel(rangeDays)}</span>
          </div>
          <AreaChart
            data={requestSeries}
            height={330}
            selectedIndex={selectedPoint?.index}
            onSelect={setSelectedPoint}
            valueFormatter={formatInteger}
          />
        </GlassCard>

        <GlassCard>
          <div className="card-title">Total spend</div>
          <div className="stat-value spend-value">{formatMoney(overview.cost.selected)}</div>
          <div className="stat-sub">against {formatMoney(overview.cost.baseline)} baseline</div>
          <ProgressMeter value={overview.cost.selected} max={comparison} />
          <div className="row budget-row">
            <span className="faint">{Math.round(comparisonPct)}% of baseline</span>
            <span className="badge badge-accent">{formatMoney(overview.cost.savings)} saved</span>
          </div>
          <div className="sep" />
          <div className="card-title">Top models</div>
          <div className="barlist">
            {modelRows.slice(0, 4).map((row) => (
              <button
                key={row.label}
                className={`barlist-row barlist-button${activeMetric === row.label ? " active" : ""}`}
                type="button"
                onClick={() => setSelection(modelSelection(row.label, row.tokens, row.spend))}
              >
                <div className="barlist-label"><span className="model-dot" style={{ background: row.color }} /><span className="mono">{row.label}</span></div>
                <div className="barlist-val">{formatCompact(row.tokens)}</div>
                <div className="barlist-track"><i style={{ width: `${row.tokens / Math.max(modelRows[0]?.tokens ?? 1, 1) * 100}%`, background: row.color }} /></div>
              </button>
            ))}
            {modelRows.length === 0 ? <div className="empty compact-empty">No model usage yet.</div> : null}
          </div>
        </GlassCard>
      </div>

      <GlassCard>
        <div className="card-head">
          <div className="card-title"><ArrowUp />Routing impact</div>
          <span className="muted">Avoided spend and quality flags</span>
        </div>
        <div className="impact-grid">
          {impactMetrics.map((metric) => (
            <button
              key={metric.label}
              type="button"
              className={activeMetric === metric.label ? "active" : undefined}
              aria-pressed={activeMetric === metric.label}
              onClick={() => setSelection(metricSelection(metric.label, metric.value, metric.detail))}
            >
              <span>{metric.label}</span>
              <strong className={metric.tone}>{metric.value}</strong>
              <em>{metric.caption}</em>
            </button>
          ))}
        </div>
      </GlassCard>

      <InspectorPanel
        title={inspector.title}
        subtitle={inspector.subtitle}
        rows={inspector.rows}
        action={<Link to="/logs" className="btn btn-sm"><ArrowUpRight />Open logs</Link>}
      />
    </div>
  );
}

function rangeLabel(value: "1" | "7" | "30" | "90") {
  return value === "1" ? "24h" : `${value}d`;
}

function greetingFor(user?: { name?: string; email?: string }) {
  const hour = new Date().getHours();
  let timeOfDay = "evening";
  if (hour < 12) timeOfDay = "morning";
  else if (hour < 18) timeOfDay = "afternoon";
  const name = user?.name ?? user?.email?.split("@")[0];
  return name ? `Good ${timeOfDay}, ${name.split(/\s+/)[0]}` : `Good ${timeOfDay}`;
}

function chartSelection(selection: ChartSelection): OverviewSelection {
  return {
    title: `Request volume · ${selection.point.label}`,
    subtitle: "Selected chart bucket",
    rows: [
      { label: "Requests", value: formatInteger(selection.point.value) },
      { label: "Bucket index", value: selection.index + 1 },
      { label: "Action", value: "Inspect logs", detail: "Use the request stream to replay prompts from this period." }
    ]
  };
}

function modelSelection(model: string, tokens: number, spend: number): OverviewSelection {
  return {
    title: model,
    subtitle: "Selected model",
    rows: [
      { label: "Tokens", value: formatCompact(tokens) },
      { label: "Spend", value: formatMoney(spend) },
      { label: "Cost / token", value: tokens > 0 ? formatMoney(spend / tokens) : formatMoney(0) }
    ]
  };
}

function metricSelection(title: string, value: string, detail: string): OverviewSelection {
  return {
    title,
    subtitle: detail,
    rows: [
      { label: "Current value", value },
      { label: "Dashboard action", value: "Open logs", detail: "Review the request rows behind this signal." }
    ]
  };
}

function overviewSelection(savings: number, baseline: number, cheaperLikelyWorked: number): OverviewSelection {
  const savingsRate = baseline > 0 ? savings / baseline : 0;
  return {
    title: "Route quality watchlist",
    subtitle: "Click a chart point, model, or impact cell to inspect a specific signal.",
    rows: [
      { label: "Saved by routing", value: formatMoney(savings) },
      { label: "Cheaper likely worked", value: formatInteger(cheaperLikelyWorked) },
      { label: "Savings rate", value: formatPercent(savingsRate), detail: "Compared with baseline model cost." }
    ]
  };
}
