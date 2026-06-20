import { KeyRound, TriangleAlert } from "lucide-react";
import { useState } from "react";

import {
  bustCauses,
  bustsByModel,
  type CacheBustReport,
  type ModelBustRow
} from "./cachingData";
import { formatCompact, formatInteger, formatPercent } from "./format";
import { DataTable, GlassCard } from "./ui";
import {
  OTHER_GROUP_KEY,
  cacheHitRate,
  groupKeyLabel,
  seriesColor,
  type GroupLabelLookups
} from "./usageAnalytics";
import type { UsageGroup } from "./usageData";

export function MissTable({ report }: { report: CacheBustReport | undefined }) {
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
const LOW_VALUE_HIT_RATE = 0.15;

export function KeyHitRates({ groups, lookups }: { groups: UsageGroup[] | undefined; lookups: GroupLabelLookups }) {
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
