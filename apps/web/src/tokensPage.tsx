import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { Sparkline } from "./charts";
import { formatCompact, formatPercent } from "./format";
import {
  bucketLabels,
  cacheHitRateOf,
  fetchTokenAttribution,
  type TokenAttributionOffender,
  type TokenAttributionReport
} from "./tokensData";
import { BarListRow, GlassCard, PageSkeleton, PageState, Segmented } from "./ui";
import { seriesColor, usageRangeOptions, usageRangeQuery, type UsageRangeKey } from "./usageAnalytics";
import { fetchUsageReport, fetchUsageTimeseries } from "./usageData";

export function TokensPage() {
  const [range, setRange] = useState<UsageRangeKey>("30");
  const [anchor, setAnchor] = useState(() => new Date());
  const { start, end, interval } = usageRangeQuery(range, anchor);
  const attributionQuery = useQuery({
    queryKey: ["token-attribution", start, end],
    queryFn: () => fetchTokenAttribution({ start, end }),
    placeholderData: keepPreviousData
  });
  const providerUsageQuery = useQuery({
    queryKey: ["usage", "provider", start, end],
    queryFn: () => fetchUsageReport("provider", { start, end }),
    placeholderData: keepPreviousData
  });
  const providerTimeseriesQuery = useQuery({
    queryKey: ["usage-timeseries", "provider", start, end, interval],
    queryFn: () => fetchUsageTimeseries("provider", { start, end, interval }),
    placeholderData: keepPreviousData
  });
  const error = attributionQuery.error ?? providerUsageQuery.error;

  if (error) return <PageState title="Tokens" label={error.message} />;

  const report = attributionQuery.data;
  const providerUsage = providerUsageQuery.data;
  if (!report || !providerUsage) return <PageSkeleton blocks={[420, 260]} />;

  const hitRate = cacheHitRateOf(providerUsage.data);
  const trend = (providerTimeseriesQuery.data?.points ?? []).map((point) =>
    cacheHitRateOf(Object.values(point.groups)) ?? 0
  );

  return (
    <div className="page page-enter">
      <div className="usage-console-layout">
        <GlassCard className="usage-primary">
          <div className="card-head">
            <div>
              <div className="card-title">Where tokens go</div>
              <div className="stat-value big">{formatCompact(totalEstimatedTokens(report))}</div>
              <div className="row gap-8 usage-spend-sub">
                <span className="faint">
                  estimated input tokens across {formatCompact(report.requestCount)} requests
                  {report.sampled ? " (newest sample — window truncated)" : ""}
                </span>
              </div>
            </div>
            <div className="row gap-8">
              <Segmented options={usageRangeOptions} value={range} onChange={setRange} />
              <button className="btn btn-icon" type="button" aria-label="Refresh" onClick={() => setAnchor(new Date())}>
                <RefreshCw />
              </button>
            </div>
          </div>
          <BucketBreakdown report={report} />
        </GlassCard>

        <div className="usage-side-rail">
          <GlassCard>
            <div className="card-title">Cache hit rate</div>
            <div className="stat-value side-spend">{hitRate === null ? "—" : formatPercent(hitRate)}</div>
            {trend.length > 0 ? <Sparkline data={trend} /> : null}
            <div className="stat-sub">
              reads ÷ total prompt input; misses re-bill the full context at write price
            </div>
          </GlassCard>
          <GlassCard>
            <div className="card-title">Top tool schemas</div>
            <OffenderList rows={report.toolSchemas} unit="schema" />
          </GlassCard>
        </div>
      </div>

      <section className="usage-breakdown">
        <GlassCard>
          <div className="card-title">Top tool results (frontier input)</div>
          <OffenderList rows={report.toolResults} unit="result" />
        </GlassCard>
      </section>
    </div>
  );
}

function BucketBreakdown({ report }: { report: TokenAttributionReport }) {
  const total = totalEstimatedTokens(report);
  if (total === 0) {
    return (
      <div className="empty">
        No attribution data in this window. The proxy emits a tokens.attributed
        event per request — traffic will populate this view.
      </div>
    );
  }
  const ranked = [...report.buckets].sort((left, right) => right.estimatedTokens - left.estimatedTokens);
  return (
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

function offenderValue(row: TokenAttributionOffender, unit: "schema" | "result") {
  const tokens = `${formatCompact(row.estimatedTokens)} tok`;
  if (unit === "result" && row.blocks !== null && row.blocks !== undefined) {
    return `${tokens} · ${formatCompact(row.blocks)} blocks`;
  }
  return tokens;
}

function totalEstimatedTokens(report: TokenAttributionReport) {
  return report.buckets.reduce((sum, bucket) => sum + bucket.estimatedTokens, 0);
}
