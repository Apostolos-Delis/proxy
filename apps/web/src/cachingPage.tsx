import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { KeyRound, RefreshCw, TriangleAlert, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";

import { isAdminRole } from "./access";
import {
  bucketLabels,
  bustCauses,
  bustsByModel,
  cacheSavings,
  fetchCacheBusts,
  fetchCompressionSavings,
  fetchCachePricingRates,
  fetchIdleGaps,
  fetchTokenAttribution,
  type CacheBustReport,
  type CacheSavings,
  type CompressionSavingsReport,
  type CompressionSavingsRow,
  type IdleGapReport,
  type ModelBustRow,
  type TokenAttributionOffender,
  type TokenAttributionReport,
  type TokenAttributionSchemaChurn
} from "./cachingData";
import { LayeredAreaChart, MiniBars, Sparkline, type LayeredAreaSeries } from "./charts";
import { formatCompact, formatDateTime, formatInteger, formatMoney, formatPercent } from "./format";
import { BarListRow, DataTable, Delta, GlassCard, PageSkeleton, PageState, Segmented } from "./ui";
import {
  OTHER_GROUP_KEY,
  cacheHitPointSeries,
  cacheHitRate,
  groupKeyLabel,
  percentDelta,
  seriesColor,
  usagePointSeries,
  usagePreviousRangeQuery,
  usageRangeOptions,
  usageRangeQuery,
  type GroupLabelLookups,
  type UsageRangeKey
} from "./usageAnalytics";
import { fetchUsageDashboard, fetchUsageLookups, fetchUsageReport, type UsageGroup } from "./usageData";
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
  const { error: dashboardQueryError, data: dashboardQueryData } = useQuery({
    queryKey: ["usage-dashboard", "provider", start, end, interval],
    queryFn: () => fetchUsageDashboard("provider", { start, end, interval }),
    placeholderData: keepPreviousData
  });
  const { data: previousQueryData } = useQuery({
    queryKey: ["usage", "provider", previousRange.start, previousRange.end],
    queryFn: () => fetchUsageReport("provider", previousRange),
    placeholderData: keepPreviousData
  });
  const { error: keyUsageQueryError, data: keyUsageQueryData } = useQuery({
    queryKey: ["usage", "api_key", start, end],
    queryFn: () => fetchUsageReport("api_key", { start, end }),
    placeholderData: keepPreviousData
  });
  const { error: modelUsageQueryError, data: modelUsageQueryData } = useQuery({
    queryKey: ["usage", "model", start, end],
    queryFn: () => fetchUsageReport("model", { start, end }),
    placeholderData: keepPreviousData
  });
  const { error: ratesQueryError, data: ratesQueryData } = useQuery({ queryKey: ["cache-pricing-rates"], queryFn: fetchCachePricingRates });
  const { data: lookupsQueryData } = useQuery({
    queryKey: ["usage-lookups"],
    queryFn: fetchUsageLookups,
    enabled: isAdmin
  });
  const { error: bustsQueryError, data: bustsQueryData } = useQuery({
    queryKey: ["cache-busts", start, end],
    queryFn: () => fetchCacheBusts({ start, end }),
    placeholderData: keepPreviousData
  });
  const { error: compressionSavingsQueryError, data: compressionSavingsQueryData } = useQuery({
    queryKey: ["compression-savings", start, end],
    queryFn: () => fetchCompressionSavings({ start, end }),
    placeholderData: keepPreviousData
  });
  const { error: attributionQueryError, data: attributionQueryData } = useQuery({
    queryKey: ["token-attribution", start, end],
    queryFn: () => fetchTokenAttribution({ start, end }),
    placeholderData: keepPreviousData
  });
  const { error: idleGapsQueryError, data: idleGapsQueryData } = useQuery({
    queryKey: ["idle-gaps", start, end],
    queryFn: () => fetchIdleGaps({ start, end }),
    placeholderData: keepPreviousData
  });

  const error = dashboardQueryError ?? bustsQueryError
    ?? keyUsageQueryError ?? modelUsageQueryError ?? ratesQueryError
    ?? compressionSavingsQueryError ?? attributionQueryError ?? idleGapsQueryError;
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

function MissTable({ report }: { report: CacheBustReport | undefined }) {
  const [hoverCause, setHoverCause] = useState<string | null>(null);
  if (!report) {
    return (
      <GlassCard>
        <div className="card-title"><TriangleAlert />Cache miss tokens</div>
        <div className="inline-skeleton skeleton-pulse" style={{ height: 200 }} />
      </GlassCard>
    );
  }
  const rows = bustsByModel(report.busts);
  const totalDropped = rows.reduce((sum, row) => sum + row.droppedTokens, 0);
  const maxDropped = rows[0]?.droppedTokens ?? 0;
  const counts = report.countsByCause as Record<string, number>;
  const causes = bustCauses.filter((cause) => (counts[cause.key] ?? 0) > 0);
  const dimmed = (key: string) => hoverCause !== null && hoverCause !== key;

  return (
    <GlassCard>
      <div className="card-head">
        <div className="card-title">
          <TriangleAlert />Cache miss tokens
          <span className="usage-scope-note">why warm prefixes broke</span>
        </div>
        <span className="mono faint caching-miss-total">{formatCompact(totalDropped)} dropped</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty compact-empty">
          No busts detected across {formatCompact(report.sessionsScanned)} sessions in this window.
        </div>
      ) : (
        <>
          <DataTable>
            <thead>
              <tr>
                <th>Model</th>
                <th>Busts</th>
                <th>Tokens</th>
                <th className="caching-reason-head">By cause</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.model}>
                  <td>
                    <span className="row gap-8">
                      <span className="model-dot" style={{ background: seriesColor(index, row.model) }} />
                      <span className="mono caching-model-name" title={row.model}>{row.model}</span>
                    </span>
                  </td>
                  <td><span className="mono muted">{formatInteger(row.busts)}</span></td>
                  <td><span className="mono">{formatCompact(row.droppedTokens)}</span></td>
                  <td>
                    <ReasonBar row={row} maxDropped={maxDropped} dimmed={dimmed} onHover={setHoverCause} />
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          <div className="chart-series-legend caching-reason-legend">
            {causes.map((cause) => (
              <span
                key={cause.key}
                style={{ opacity: dimmed(cause.key) ? 0.4 : 1 }}
                onMouseEnter={() => setHoverCause(cause.key)}
                onMouseLeave={() => setHoverCause(null)}
              >
                <i style={{ background: cause.color }} />
                {cause.label} × {counts[cause.key]}
              </span>
            ))}
          </div>
          {report.sampled ? <div className="stat-sub">newest sample — window truncated</div> : null}
        </>
      )}
    </GlassCard>
  );
}

function ReasonBar({ row, maxDropped, dimmed, onHover }: {
  row: ModelBustRow;
  maxDropped: number;
  dimmed: (key: string) => boolean;
  onHover: (key: string | null) => void;
}) {
  if (row.droppedTokens === 0 || maxDropped === 0) return null;
  return (
    <div className="caching-reason-bar" style={{ width: `${(row.droppedTokens / maxDropped) * 100}%` }}>
      {bustCauses.map((cause) => {
        const share = (row.tokensByCause[cause.key] ?? 0) / row.droppedTokens;
        if (share <= 0) return null;
        return (
          <i
            key={cause.key}
            title={`${cause.label} · ${formatPercent(share)}`}
            style={{ width: `${share * 100}%`, background: cause.color, opacity: dimmed(cause.key) ? 0.25 : 1 }}
            onMouseEnter={() => onHover(cause.key)}
            onMouseLeave={() => onHover(null)}
          />
        );
      })}
    </div>
  );
}

const KEY_LIST_LIMIT = 8;
// Below this read share the write premium usually outweighs the read discount.
const LOW_VALUE_HIT_RATE = 0.15;

function KeyHitRates({ groups, lookups }: { groups: UsageGroup[] | undefined; lookups: GroupLabelLookups }) {
  if (!groups) {
    return (
      <GlassCard>
        <div className="card-title"><KeyRound />Hit rate by API key</div>
        <div className="inline-skeleton skeleton-pulse" style={{ height: 200 }} />
      </GlassCard>
    );
  }
  const rows = groups
    .filter((group) => group.key !== OTHER_GROUP_KEY && group.usage.inputTokens > 0)
    .map((group) => ({ group, rate: cacheHitRate(group) ?? 0 }))
    .sort((left, right) => right.rate - left.rate)
    .slice(0, KEY_LIST_LIMIT);

  return (
    <GlassCard>
      <div className="card-head">
        <div className="card-title"><KeyRound />Hit rate by API key</div>
      </div>
      {rows.length === 0 ? (
        <div className="empty compact-empty">No proxied traffic in this window.</div>
      ) : (
        <div className="barlist caching-key-list">
          {rows.map(({ group, rate }) => (
            <div key={group.key} className="barlist-row">
              <div className="barlist-label">
                <span className="mono">{groupKeyLabel("api_key", group.key, lookups)}</span>
                <span className="caching-key-hint">
                  {formatCompact(group.usage.cachedInputTokens)} / {formatCompact(group.usage.inputTokens)} tok
                </span>
              </div>
              <div className="barlist-val" style={{ color: keyRateColor(rate) }}>{formatPercent(rate)}</div>
              <div className="barlist-track">
                <i style={{ width: `${rate * 100}%`, background: rate > 0.5 ? undefined : "var(--fg-faint)" }} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="sep" />
      <div className="caching-advice">
        Keys under ~{formatPercent(LOW_VALUE_HIT_RATE)} rarely benefit from caching — usually rotating or
        unique prompts. Consider disabling cache writes for those workloads to save the write premium.
      </div>
    </GlassCard>
  );
}

function keyRateColor(rate: number) {
  if (rate > 0.5) return "var(--accent)";
  if (rate > LOW_VALUE_HIT_RATE) return undefined;
  return "var(--fg-faint)";
}

function BucketBreakdown({ report }: { report: TokenAttributionReport | undefined }) {
  if (!report) {
    return (
      <GlassCard>
        <div className="card-title">Where input tokens go</div>
        <div className="inline-skeleton skeleton-pulse" style={{ height: 200 }} />
      </GlassCard>
    );
  }
  const total = report.buckets.reduce((sum, bucket) => sum + bucket.estimatedTokens, 0);
  const ranked = [...report.buckets].sort((left, right) => right.estimatedTokens - left.estimatedTokens);
  return (
    <GlassCard>
      <div className="card-head">
        <div className="card-title">
          Where input tokens go
          <span className="usage-scope-note">what the prefix is made of</span>
        </div>
        <span className="mono faint caching-miss-total">{formatCompact(total)} est.</span>
      </div>
      {total === 0 ? (
        <div className="empty compact-empty">
          No attribution data in this window. The proxy emits a tokens.attributed
          event per request — traffic will populate this view.
        </div>
      ) : (
        <>
          <div className="barlist">
            {ranked.map((bucket, index) => (
              <BarListRow
                key={bucket.key}
                label={bucketLabels[bucket.key] ?? bucket.key}
                value={`${formatCompact(bucket.estimatedTokens)} tok · ${formatPercent(bucket.estimatedTokens / total)}`}
                width={(bucket.estimatedTokens / total) * 100}
                color={seriesColor(index, bucket.key)}
              />
            ))}
          </div>
          <div className="stat-sub">
            estimated across {formatCompact(report.requestCount)} requests
            {report.sampled ? " · newest sample — window truncated" : ""}
          </div>
        </>
      )}
    </GlassCard>
  );
}

const offenderTabs = [
  { value: "schemas", label: "Schemas" },
  { value: "results", label: "Results" }
] as const;

type OffenderTab = (typeof offenderTabs)[number]["value"];

function Offenders({ report }: { report: TokenAttributionReport | undefined }) {
  const [tab, setTab] = useState<OffenderTab>("schemas");
  if (!report) {
    return (
      <GlassCard>
        <div className="card-title">Largest tool payloads</div>
        <div className="inline-skeleton skeleton-pulse" style={{ height: 200 }} />
      </GlassCard>
    );
  }
  const rows = tab === "schemas" ? report.toolSchemas : report.toolResults;
  const churningSchemas = report.schemaChurn
    .filter((row) => row.status === "churning")
    .slice(0, 3);
  return (
    <GlassCard>
      <div className="card-head">
        <div className="card-title">Largest tool payloads</div>
        <Segmented options={offenderTabs} value={tab} onChange={setTab} />
      </div>
      {tab === "schemas" ? <SchemaChurnWarning rows={churningSchemas} /> : null}
      <OffenderList rows={rows} unit={tab === "schemas" ? "schema" : "result"} />
      <div className="stat-sub">
        {tab === "schemas"
          ? "schemas ride in every request — stable ones cache, churning ones bust the prefix"
          : "fresh tool results are never cache reads; trim the biggest to shrink uncached input"}
      </div>
    </GlassCard>
  );
}

function SchemaChurnWarning({ rows }: { rows: TokenAttributionSchemaChurn[] }) {
  if (rows.length === 0) return null;
  return (
    <>
      <div className="caching-advice">
        Schema churn detected: {rows.map(schemaChurnLabel).join("; ")}
      </div>
      <div className="sep" />
    </>
  );
}

function OffenderList({ rows, unit }: { rows: TokenAttributionOffender[]; unit: "schema" | "result" }) {
  // Server returns up to 20 for export/drill-down headroom; the cards stay dense at 8.
  const top = rows.slice(0, 8);
  if (top.length === 0) {
    return <div className="empty compact-empty">Nothing recorded in this window.</div>;
  }
  const max = Math.max(...top.map((row) => row.estimatedTokens), 1);
  return (
    <div className="barlist usage-top-list">
      {top.map((row, index) => (
        <BarListRow
          key={row.name}
          label={row.name}
          value={offenderValue(row, unit)}
          width={(row.estimatedTokens / max) * 100}
          color={seriesColor(index, row.name)}
          mono
        />
      ))}
    </div>
  );
}

function CompressionSavings({ report }: { report: CompressionSavingsReport | undefined }) {
  if (!report) {
    return (
      <GlassCard>
        <div className="card-title"><Zap />Compression savings</div>
        <div className="inline-skeleton skeleton-pulse" style={{ height: 200 }} />
      </GlassCard>
    );
  }
  const rows = report.rows.slice(0, 8);
  const max = Math.max(...rows.map((row) => row.savedEstimatedTokens), 1);
  return (
    <GlassCard>
      <div className="card-head">
        <div className="card-title">
          <Zap />Compression savings
          <span className="usage-scope-note">by rule and tool</span>
        </div>
        <span className="mono faint caching-miss-total">{formatCompact(report.savedEstimatedTokens)} tok</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty compact-empty">No compression events in this window.</div>
      ) : (
        <>
          <div className="barlist usage-top-list">
            {rows.map((row, index) => (
              <BarListRow
                key={`${row.rule}:${row.ruleVersion}:${row.tool}`}
                label={compressionSavingsLabel(row)}
                value={`${formatCompact(row.savedEstimatedTokens)} tok · ${formatCompact(row.blocks)} blocks`}
                width={(row.savedEstimatedTokens / max) * 100}
                color={seriesColor(index, `${row.rule}:${row.tool}`)}
                mono
              />
            ))}
          </div>
          <div className="stat-sub">
            {formatCompact(report.savedEstimatedTokens)} estimated tokens saved across {formatCompact(report.blocks)} blocks
            {report.sampled ? " · newest sample - window truncated" : ""}
          </div>
        </>
      )}
    </GlassCard>
  );
}

function compressionSavingsLabel(row: CompressionSavingsRow) {
  return `${row.rule} v${row.ruleVersion} · ${row.tool}`;
}

function IdleGaps({ report }: { report: IdleGapReport | undefined }) {
  if (!report) {
    return (
      <GlassCard>
        <div className="card-title">Session idle gaps</div>
        <div className="inline-skeleton skeleton-pulse" style={{ height: 200 }} />
      </GlassCard>
    );
  }
  const maxCount = Math.max(...report.buckets.map((bucket) => bucket.count), 1);
  return (
    <GlassCard>
      <div className="card-head">
        <div className="card-title">
          Session idle gaps
          <span className="usage-scope-note">sizes the TTL upgrade win</span>
        </div>
      </div>
      {report.totalGaps === 0 ? (
        <div className="empty compact-empty">No multi-request sessions in this window.</div>
      ) : (
        <>
          <div className="barlist usage-top-list">
            {report.buckets.map((bucket) => (
              <BarListRow
                key={bucket.key}
                label={bucket.label}
                value={formatCompact(bucket.count)}
                width={(bucket.count / maxCount) * 100}
              />
            ))}
          </div>
          <div className="stat-sub">
            {formatPercent(report.overTtl / report.totalGaps)} of gaps outlive the 5m cache TTL;{" "}
            {formatPercent(report.recoverableByOneHourTtl / report.totalGaps)} recoverable with a 1h TTL
          </div>
          <div className="sep" />
          <div className="caching-advice">
            {idleGapRecommendation(report)}
          </div>
          <div className="stat-sub">{idleGapSampleNote(report)}</div>
        </>
      )}
    </GlassCard>
  );
}

function idleGapRecommendation(report: IdleGapReport) {
  const tokens = formatCompact(report.estimatedRecoverableCacheReadTokens);
  const threshold = formatCompact(report.recommendationThresholdTokens);
  if (report.recommendedTtlUpgrade) {
    return `Enable 1-hour TTL: ${tokens} cache-read tokens were recoverable from idle gaps in this window.`;
  }
  return `Keep the current TTL: ${tokens} recoverable tokens is below the ${threshold} recommendation threshold.`;
}

function idleGapSampleNote(report: IdleGapReport) {
  const requestCount = formatCompact(report.sampledRequests);
  const prefix = report.sampled ? `newest ${requestCount} requests` : `${requestCount} requests`;
  if (!report.sampleWindowStart || !report.sampleWindowEnd) return `${prefix} sampled`;
  const window = `from ${formatDateTime(report.sampleWindowStart)} to ${formatDateTime(report.sampleWindowEnd)}`;
  return `${prefix} sampled ${window}${report.sampled ? " - window truncated" : ""}`;
}

function offenderValue(row: TokenAttributionOffender, unit: "schema" | "result") {
  const tokens = `${formatCompact(row.estimatedTokens)} tok`;
  if (unit === "result" && row.blocks !== null) {
    return `${tokens} · ${formatCompact(row.blocks)} blocks`;
  }
  return tokens;
}

function schemaChurnLabel(row: TokenAttributionSchemaChurn) {
  const sessionText = row.churningSessions > 0
    ? `${formatCompact(row.churningSessions)} churning sessions`
    : `${formatCompact(row.sessions)} sessions`;
  return `${row.name} has ${formatCompact(row.schemaHashes)} hashes across ${formatCompact(row.requests)} requests (${sessionText})`;
}

/** One decimal where it matters: 75.8% reads differently than 76%. */
function formatRatio(rate: number) {
  return `${(rate * 100).toFixed(1)}%`;
}
