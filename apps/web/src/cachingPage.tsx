import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { RefreshCw, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";

import { isAdminRole } from "./access";
import { BucketBreakdown, CompressionSavings, IdleGaps, Offenders, PromptCachePlans } from "./cachingAnatomyPanels";
import {
  cacheSavings,
  fetchCacheBusts,
  fetchCompressionSavings,
  fetchCachePricingRates,
  fetchIdleGaps,
  fetchPromptCachePlans,
  fetchTokenAttribution,
  type CacheSavings
} from "./cachingData";
import { KeyHitRates, MissTable } from "./cachingMissPanels";
import { LayeredAreaChart, MiniBars, Sparkline, type LayeredAreaSeries } from "./charts";
import { formatCompact, formatMoney } from "./format";
import { Delta, GlassCard, PageSkeleton, PageState, Segmented } from "./ui";
import {
  cacheHitPointSeries,
  cacheHitRate,
  percentDelta,
  usagePointSeries,
  usagePreviousRangeQuery,
  usageRangeOptions,
  usageRangeQuery,
  type UsageRangeKey
} from "./usageAnalytics";
import { fetchUsageDashboard, fetchUsageLookups, fetchUsageReport } from "./usageData";
import { fetchMe } from "./session";

const flowSeries: LayeredAreaSeries[] = [
  { key: "reads", label: "Cache reads", color: "#38bdf8", filled: true },
  { key: "uncached", label: "Uncached input", color: "#34d399" }
];

export function CachingPage() {
  const [range, setRange] = useState<UsageRangeKey>("30");
  const [anchor, setAnchor] = useState(() => new Date());
  const { start, end, interval } = usageRangeQuery(range, anchor);
  const previousRange = usagePreviousRangeQuery(range, anchor);
  const { data: meQueryData } = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const isAdmin = isAdminRole(meQueryData?.user.role);
  const {
    error: dashboardQueryError,
    data: dashboardQueryData,
    isPlaceholderData: isDashboardPlaceholderData
  } = useQuery({
    queryKey: ["usage-dashboard", "provider", start, end, interval],
    queryFn: () => fetchUsageDashboard("provider", { start, end, interval }),
    placeholderData: keepPreviousData
  });
  const dashboardReady = Boolean(dashboardQueryData) && !isDashboardPlaceholderData;
  const { data: previousQueryData } = useQuery({
    queryKey: ["usage", "provider", previousRange.start, previousRange.end],
    queryFn: () => fetchUsageReport("provider", previousRange),
    placeholderData: keepPreviousData,
    enabled: dashboardReady
  });
  const { error: keyUsageQueryError, data: keyUsageQueryData } = useQuery({
    queryKey: ["usage", "api_key", start, end],
    queryFn: () => fetchUsageReport("api_key", { start, end }),
    placeholderData: keepPreviousData,
    enabled: dashboardReady
  });
  const { error: modelUsageQueryError, data: modelUsageQueryData } = useQuery({
    queryKey: ["usage", "model", start, end],
    queryFn: () => fetchUsageReport("model", { start, end }),
    placeholderData: keepPreviousData,
    enabled: dashboardReady
  });
  const { error: ratesQueryError, data: ratesQueryData } = useQuery({
    queryKey: ["cache-pricing-rates"],
    queryFn: fetchCachePricingRates,
    enabled: dashboardReady
  });
  const { data: lookupsQueryData } = useQuery({
    queryKey: ["usage-lookups"],
    queryFn: fetchUsageLookups,
    enabled: isAdmin && dashboardReady
  });
  const { error: bustsQueryError, data: bustsQueryData } = useQuery({
    queryKey: ["cache-busts", start, end],
    queryFn: () => fetchCacheBusts({ start, end }),
    placeholderData: keepPreviousData,
    enabled: dashboardReady
  });
  const { error: compressionSavingsQueryError, data: compressionSavingsQueryData } = useQuery({
    queryKey: ["compression-savings", start, end],
    queryFn: () => fetchCompressionSavings({ start, end }),
    placeholderData: keepPreviousData,
    enabled: dashboardReady
  });
  const { error: attributionQueryError, data: attributionQueryData } = useQuery({
    queryKey: ["token-attribution", start, end],
    queryFn: () => fetchTokenAttribution({ start, end }),
    placeholderData: keepPreviousData,
    enabled: dashboardReady
  });
  const { error: idleGapsQueryError, data: idleGapsQueryData } = useQuery({
    queryKey: ["idle-gaps", start, end],
    queryFn: () => fetchIdleGaps({ start, end }),
    placeholderData: keepPreviousData,
    enabled: dashboardReady
  });
  const { error: promptCachePlansQueryError, data: promptCachePlansQueryData } = useQuery({
    queryKey: ["prompt-cache-plans", start, end],
    queryFn: () => fetchPromptCachePlans({ start, end }),
    placeholderData: keepPreviousData,
    enabled: dashboardReady
  });

  const error = dashboardQueryError ?? bustsQueryError
    ?? keyUsageQueryError ?? modelUsageQueryError ?? ratesQueryError
    ?? compressionSavingsQueryError ?? attributionQueryError ?? idleGapsQueryError
    ?? promptCachePlansQueryError;
  if (error) return <PageState title="Caching" label={error.message} />;

  const usage = dashboardQueryData?.usage;
  const timeseries = dashboardQueryData?.timeseries;
  if (!usage || !timeseries) return <PageSkeleton blocks={[160, 320, 280]} />;

  const totals = usage.totals;
  const previousTotals = previousQueryData?.totals;
  const rate = cacheHitRate(totals);
  const previousRate = cacheHitRate(previousTotals);
  const readTokens = totals.usage.cachedInputTokens;
  const uncachedTokens = Math.max(0, totals.usage.inputTokens - totals.usage.cachedInputTokens);
  const previousRead = previousTotals?.usage.cachedInputTokens;
  const previousUncached = previousTotals === undefined
    ? undefined
    : Math.max(0, previousTotals.usage.inputTokens - previousTotals.usage.cachedInputTokens);
  const readPoints = usagePointSeries(timeseries, (point) => point.usage.cachedInputTokens);
  const uncachedPoints = usagePointSeries(timeseries, (point) => Math.max(0, point.usage.inputTokens - point.usage.cachedInputTokens));
  const flowRows = readPoints.map((point, index) => ({
    label: point.label,
    values: { reads: point.value, uncached: uncachedPoints[index]?.value ?? 0 }
  }));
  const savings = modelUsageQueryData && ratesQueryData
    ? cacheSavings(modelUsageQueryData.data, ratesQueryData)
    : undefined;
  const visibleLookups = isAdmin ? lookupsQueryData : undefined;
  const lookups = {
    usersById: new Map((visibleLookups?.members ?? []).map((user) => [user.userId, user])),
    apiKeysById: new Map((visibleLookups?.apiKeys ?? []).map((key) => [key.id, key]))
  };

  return (
    <div className="page page-enter">
      <div className="row usage-grid-range">
        <Segmented options={usageRangeOptions} value={range} onChange={setRange} />
        <button className="btn btn-icon" type="button" aria-label="Refresh" onClick={() => setAnchor(new Date())}>
          <RefreshCw />
        </button>
      </div>

      <div className="usage-kpi-grid">
        <KpiCard
          title="Cache read ratio"
          accent
          delta={rate === null ? undefined : percentDelta(rate, previousRate)}
          value={rate === null ? "—" : formatRatio(rate)}
          chart={<Sparkline data={cacheHitPointSeries(timeseries)} valueFormatter={(value) => `${Math.round(value)}%`} />}
        />
        <KpiCard
          title="Cache read tokens"
          delta={percentDelta(readTokens, previousRead)}
          value={formatCompact(readTokens)}
          chart={<Sparkline data={readPoints} color="#38bdf8" valueFormatter={formatCompact} />}
        />
        <KpiCard
          title="Uncached input"
          delta={percentDelta(uncachedTokens, previousUncached)}
          deltaPositiveIsGood={false}
          value={formatCompact(uncachedTokens)}
          chart={<MiniBars data={uncachedPoints} color="#34d399" valueFormatter={formatCompact} />}
        />
        <SavingsCard savings={savings} />
      </div>

      <GlassCard>
        <div className="card-head">
          <div className="card-title"><Zap />Cache reads vs uncached input</div>
          <div className="chart-series-legend">
            {flowSeries.map((item) => (
              <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>
            ))}
          </div>
        </div>
        <LayeredAreaChart data={flowRows} series={flowSeries} height={260} valueFormatter={formatCompact} />
      </GlassCard>

      <div className="caching-grid">
        <MissTable report={bustsQueryData} />
        <KeyHitRates groups={keyUsageQueryData?.data} lookups={lookups} />
      </div>

      <div className="caching-anatomy">
        <BucketBreakdown report={attributionQueryData} />
        <Offenders report={attributionQueryData} />
        <CompressionSavings report={compressionSavingsQueryData} />
        <PromptCachePlans report={promptCachePlansQueryData} />
        <IdleGaps report={idleGapsQueryData} />
      </div>
    </div>
  );
}

function KpiCard({ title, value, accent = false, delta, deltaPositiveIsGood = true, chart }: {
  title: string;
  value: string;
  accent?: boolean;
  delta?: number;
  deltaPositiveIsGood?: boolean;
  chart: ReactNode;
}) {
  return (
    <GlassCard className="stat-card">
      <div className="card-head">
        <div className="card-title">{title}</div>
        {delta === undefined ? null : <Delta value={delta} positiveIsGood={deltaPositiveIsGood} />}
      </div>
      <div className={`stat-value${accent ? " caching-accent" : ""}`}>{value}</div>
      <div className="stat-chart">{chart}</div>
    </GlassCard>
  );
}

function SavingsCard({ savings }: { savings: CacheSavings | undefined }) {
  return (
    <GlassCard className="stat-card">
      <div className="card-head">
        <div className="card-title">Est. cache savings</div>
      </div>
      <div className="stat-value caching-accent">{savings === undefined ? "—" : formatMoney(savings.gross)}</div>
      <div className="stat-sub">vs paying full input price for every prompt token</div>
      {savings === undefined ? null : <div className="caching-kpi-foot">{savingsFootnote(savings)}</div>}
    </GlassCard>
  );
}

function savingsFootnote(savings: CacheSavings) {
  if (savings.unpricedCachedTokens > 0) {
    return `${formatCompact(savings.unpricedCachedTokens)} cached tok on unpriced models excluded`;
  }
  if (savings.writePremium <= 0) return "no cache-write premium in this window";
  return `cache writes add ${formatMoney(savings.writePremium)} · net ${savings.net >= 0 ? "positive" : "negative"}`;
}

/** One decimal where it matters: 75.8% reads differently than 76%. */
function formatRatio(rate: number) {
  return `${(rate * 100).toFixed(1)}%`;
}
