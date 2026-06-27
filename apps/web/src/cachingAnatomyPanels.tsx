import { ListChecks, Zap } from "lucide-react";
import { useState } from "react";

import {
  bucketLabels,
  promptCacheControlRows,
  type CompressionSavingsReport,
  type CompressionSavingsRow,
  type IdleGapReport,
  type PromptCachePlanControl,
  type PromptCachePlanReport,
  type PromptCachePrewarmReport,
  type TokenAttributionOffender,
  type TokenAttributionReport,
  type TokenAttributionSchemaChurn
} from "./cachingData";
import { formatCompact, formatDateTime, formatMoney, formatPercent } from "./format";
import { BarListRow, GlassCard, Segmented } from "./ui";
import { seriesColor } from "./usageAnalytics";

export function BucketBreakdown({ report }: { report: TokenAttributionReport | undefined }) {
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

export function Offenders({ report }: { report: TokenAttributionReport | undefined }) {
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

export function CompressionSavings({ report }: { report: CompressionSavingsReport | undefined }) {
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

export function PromptCachePlans({ report }: { report: PromptCachePlanReport | undefined }) {
  if (!report) {
    return (
      <GlassCard>
        <div className="card-title"><ListChecks />Prompt-cache plans</div>
        <div className="inline-skeleton skeleton-pulse" style={{ height: 200 }} />
      </GlassCard>
    );
  }
  const rows = promptCacheControlRows(report);
  const max = Math.max(...rows.map((row) => row.count), 1);
  return (
    <GlassCard>
      <div className="card-head">
        <div className="card-title">
          <ListChecks />Prompt-cache plans
          <span className="usage-scope-note">observe-only controls</span>
        </div>
        <span className="mono faint caching-miss-total">{formatCompact(report.totalPlans)} plans</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty compact-empty">No prompt-cache plans in this window.</div>
      ) : (
        <>
          <div className="barlist usage-top-list">
            {rows.map((row, index) => (
              <BarListRow
                key={promptCacheControlKey(row)}
                label={promptCacheControlLabel(row)}
                value={promptCacheControlValue(row)}
                width={(row.count / max) * 100}
                color={seriesColor(index, promptCacheControlKey(row))}
                mono
              />
            ))}
          </div>
          <div className="stat-sub">
            {formatCompact(report.totalPlans)} plans across {formatCompact(report.plans.length)} provider/model/mode groups
            {report.sampled ? " · newest sample - window truncated" : ""}
          </div>
        </>
      )}
    </GlassCard>
  );
}

export function PromptCachePrewarms({ report }: { report: PromptCachePrewarmReport | undefined }) {
  if (!report) {
    return (
      <GlassCard>
        <div className="card-title"><Zap />Prewarm spend</div>
        <div className="inline-skeleton skeleton-pulse" style={{ height: 200 }} />
      </GlassCard>
    );
  }
  const rows = report.jobs.slice(0, 8);
  const max = Math.max(...rows.map((row) => row.actualCostMicros || row.estimatedCostMicros), 1);
  return (
    <GlassCard>
      <div className="card-head">
        <div className="card-title">
          <Zap />Prewarm spend
          <span className="usage-scope-note">cost and reuse lift</span>
        </div>
        <span className="mono faint caching-miss-total">{formatMicros(report.actualCostMicros)} actual</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty compact-empty">No prewarm jobs in this window.</div>
      ) : (
        <>
          <div className="barlist usage-top-list">
            {rows.map((row, index) => (
              <BarListRow
                key={`${row.provider}:${row.model}:${row.status}`}
                label={`${row.provider} · ${row.model} · ${prewarmStatusLabel(row.status)}`}
                value={`${formatMicros(row.actualCostMicros || row.estimatedCostMicros)} · ${formatCompact(row.count)} jobs`}
                width={((row.actualCostMicros || row.estimatedCostMicros) / max) * 100}
                color={seriesColor(index, `${row.provider}:${row.model}:${row.status}`)}
                mono
              />
            ))}
          </div>
          <div className="stat-sub">
            {formatMicros(report.expiredUnusedCostMicros)} expired unused · {formatCompact(report.cacheReadLiftTokens)} read-lift tokens
            {report.sampled ? " · newest sample - window truncated" : ""}
          </div>
        </>
      )}
    </GlassCard>
  );
}

function promptCacheControlKey(row: PromptCachePlanControl) {
  return `${row.provider}:${row.model}:${row.mode}:${row.control}:${row.status}:${row.reason}`;
}

function promptCacheControlLabel(row: PromptCachePlanControl) {
  return `${row.provider} · ${row.model} · ${modeLabel(row.mode)} · ${controlLabel(row.control)}`;
}

function promptCacheControlValue(row: PromptCachePlanControl) {
  const status = row.status === "skipped" ? `skipped · ${reasonLabel(row.reason)}` : row.status;
  return `${formatCompact(row.count)} · ${status}`;
}

function modeLabel(mode: string) {
  if (mode === "implicit") return "implicit";
  if (mode === "explicit") return "explicit";
  if (mode === "observe") return "observe";
  if (mode === "off") return "off";
  return mode;
}

function controlLabel(control: string) {
  if (control === "implicit_prefix_caching") return "implicit prefix";
  if (control === "cache_key_preserved") return "cache key";
  if (control === "retention_preserved") return "retention";
  if (control === "client_breakpoints_preserved") return "client breakpoints";
  if (control === "top_level_auto_breakpoint") return "auto breakpoint";
  if (control === "ttl_1h") return "1h TTL";
  if (control === "cross_dialect_cache_fields") return "cross-dialect fields";
  if (control === "prompt_cache") return "prompt cache";
  return control;
}

function reasonLabel(reason: string) {
  if (reason === "translated_request") return "translated";
  if (reason === "setting_disabled") return "setting disabled";
  if (reason === "not_eligible") return "not eligible";
  if (reason === "not_multi_turn_or_no_cacheable_target") return "not cacheable";
  if (reason === "provider_capability_unavailable") return "unsupported";
  if (reason === "missing_provider_settings") return "missing settings";
  if (reason === "none") return "none";
  return reason;
}

function prewarmStatusLabel(status: string) {
  if (status === "expired_unused") return "expired unused";
  return status;
}

function formatMicros(micros: number) {
  return formatMoney(micros / 1_000_000);
}

function compressionSavingsLabel(row: CompressionSavingsRow) {
  return `${row.rule} v${row.ruleVersion} · ${row.tool}`;
}

export function IdleGaps({ report }: { report: IdleGapReport | undefined }) {
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
