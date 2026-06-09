import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Coins, Download, KeyRound, Send, Settings, Sparkles, Zap } from "lucide-react";
import { useState } from "react";

import { fetchOverview, fetchRequests, fetchUsage } from "./api";
import { AreaChart, type ChartSelection, MiniBars, Sparkline } from "./charts";
import { modelRowsFromUsage, seriesFromRequests } from "./consoleData";
import { downloadJson, InspectorPanel, InteractiveStatCard, type InspectorRow } from "./dashboard";
import { formatCompact, formatInteger, formatMoney, formatPercent } from "./format";
import { ConsoleButton, GlassCard, PageState, ProgressMeter, Segmented } from "./ui";

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
  const loading = overviewQuery.isLoading || requestsQuery.isLoading || modelUsageQuery.isLoading;
  const error = overviewQuery.error ?? requestsQuery.error ?? modelUsageQuery.error;

  if (loading) return <PageState title="Overview" label="Loading overview" />;
  if (error) return <PageState title="Overview" label={error.message} />;
  if (!overviewQuery.data) return <PageState title="Overview" label="No overview data" />;

  const overview = overviewQuery.data;
  const requests = requestsQuery.data?.data ?? [];
  const days = Number(rangeDays);
  const spendSeries = seriesFromRequests(requests, "cost", days);
  const tokenSeries = seriesFromRequests(requests, "tokens", days);
  const requestSeries = seriesFromRequests(requests, "requests", days);
  const modelRows = modelRowsFromUsage(modelUsageQuery.data?.data ?? []);
  const comparison = Math.max(overview.cost.baseline, overview.cost.selected);
  const comparisonPct = comparison > 0 ? Math.min(100, (overview.cost.selected / comparison) * 100) : 0;
  const inspector = selectedPoint
    ? chartSelection(selectedPoint)
    : selection ?? overviewSelection(overview.cost.savings, overview.cost.baseline, overview.routeQuality.cheaperLikelyWouldWorkCount);
  const exportOverview = () => downloadJson("proxy-overview.json", { overview, requests, rangeDays, modelRows });
  const updateRange = (value: "1" | "7" | "30" | "90") => {
    setRangeDays(value);
    setSelectedPoint(null);
  };

  return (
    <div className="page page-enter">
      <div className="row gap-12 page-hero-row">
        <div>
          <div className="hero-greeting">Good evening, Apostolos</div>
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
          metric={{ label: "Total tokens", value: formatCompact(overview.totals.totalTokens), icon: <Zap />, delta: 18.4 }}
          chart={<Sparkline data={tokenSeries.slice(-7)} />}
          to="/usage"
        />
        <InteractiveStatCard
          metric={{ label: "Requests", value: formatInteger(overview.requestCount), icon: <Send />, delta: 9.1 }}
          chart={<MiniBars data={requestSeries.slice(-7)} />}
          to="/logs"
        />
        <InteractiveStatCard
          metric={{ label: "Spend", value: formatMoney(overview.cost.selected, 0), icon: <Coins />, delta: -4.2 }}
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
          <div className="card-title">June spend</div>
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
                className="barlist-row barlist-button"
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
          <button type="button" onClick={() => setSelection(metricSelection("Baseline spend", formatMoney(overview.cost.baseline), "What the selected model policy would have cost without routing savings."))}>
            <span>Baseline spend</span><strong>{formatMoney(overview.cost.baseline)}</strong>
          </button>
          <button type="button" onClick={() => setSelection(metricSelection("Savings", formatMoney(overview.cost.savings), "Avoided spend from routing to cheaper capable models."))}>
            <span>Savings</span><strong>{formatMoney(overview.cost.savings)}</strong>
          </button>
          <button type="button" onClick={() => setSelection(metricSelection("Low confidence", formatInteger(overview.routeQuality.lowConfidenceCount), "Route decisions the classifier marked as lower confidence."))}>
            <span>Low confidence</span><strong>{overview.routeQuality.lowConfidenceCount}</strong>
          </button>
          <button type="button" onClick={() => setSelection(metricSelection("Cheaper likely worked", formatInteger(overview.routeQuality.cheaperLikelyWouldWorkCount), "Cases where logs suggest a cheaper route probably would have been acceptable."))}>
            <span>Cheaper likely worked</span><strong>{overview.routeQuality.cheaperLikelyWouldWorkCount}</strong>
          </button>
        </div>
      </GlassCard>

      <InspectorPanel
        title={inspector.title}
        subtitle={inspector.subtitle}
        rows={inspector.rows}
        action={<Link to="/logs" className="btn btn-sm"><Settings />Open logs</Link>}
      />
    </div>
  );
}

function rangeLabel(value: "1" | "7" | "30" | "90") {
  return value === "1" ? "24h" : `${value}d`;
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
