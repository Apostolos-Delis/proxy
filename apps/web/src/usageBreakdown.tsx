import { Link } from "@tanstack/react-router";
import { ArrowUpRight, KeyRound } from "lucide-react";

import { displayUser } from "./consoleData";
import type { UsageGroup, UsageLookupApiKey, UsageLookupUser } from "./usageData";
import { compactId, formatCompact, formatDurationMs, formatInteger, formatMoney, formatPercent } from "./format";
import { ConsoleTable, type ConsoleTableColumn } from "./table";
import { Avatar, BarListRow, RouteBadge } from "./ui";
import {
  OTHER_GROUP_KEY,
  dimensionLabel,
  groupKeyLabel,
  hasPricedSpend,
  seriesColor,
  spendShareOf,
  tokenShareOf,
  usageDimensions,
  type GroupLabelLookups,
  type UsageDimension,
  type UsageRangeKey
} from "./usageAnalytics";

export function UsageDimensionTabs({ dimension, onDimension, canOpenDetails }: {
  dimension: UsageDimension;
  onDimension: (dimension: UsageDimension) => void;
  canOpenDetails: boolean;
}) {
  return (
    <div className="tabs usage-dimension-tabs" aria-label="Usage breakdown dimension">
      {usageDimensions.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={dimension === item.value}
          className={dimension === item.value ? "active" : ""}
          onClick={() => onDimension(item.value)}
        >
          {item.label}
        </button>
      ))}
      {canOpenDetails ? <Link to="/logs" className="usage-breakdown-link">Open logs<ArrowUpRight /></Link> : null}
    </div>
  );
}

/** Top groups as a bar list, ranked by spend with a token fallback while pricing is unset. */
export function TopGroupsList({ dimension, rows, lookups, limit, emptyLabel }: {
  dimension: UsageDimension;
  rows: UsageGroup[];
  lookups: GroupLabelLookups;
  limit: number;
  emptyLabel: string;
}) {
  const priced = hasPricedSpend(rows);
  const valueOf = priced
    ? (row: UsageGroup) => row.cost.selected
    : (row: UsageGroup) => row.usage.totalTokens;
  const top = rows
    .filter((row) => valueOf(row) > 0)
    .sort((left, right) => valueOf(right) - valueOf(left))
    .slice(0, limit);
  const max = Math.max(...top.map(valueOf), 1);
  return (
    <div className="barlist usage-top-list">
      {top.map((row, index) => {
        const label = groupKeyLabel(dimension, row.key, lookups);
        return (
          <BarListRow
            key={row.key}
            label={label}
            value={priced ? formatMoney(row.cost.selected, row.cost.selected < 1 ? undefined : 0) : `${formatCompact(row.usage.totalTokens)} tok`}
            width={(valueOf(row) / max) * 100}
            avatar={dimension === "user" ? <Avatar label={label} size={22} /> : undefined}
            color={dimension === "user" ? undefined : seriesColor(index, row.key)}
            mono={dimension === "model"}
          />
        );
      })}
      {top.length === 0 ? <div className="empty compact-empty">{emptyLabel}</div> : null}
    </div>
  );
}

export function UsageBreakdownTable({ mode, dimension, range, rows, totals, lookups, canOpenDetails }: {
  mode: "tokens" | "cost";
  dimension: UsageDimension;
  range: UsageRangeKey;
  rows: UsageGroup[];
  totals: UsageGroup | undefined;
  lookups: GroupLabelLookups;
  canOpenDetails: boolean;
}) {
  const label = dimensionLabel(dimension);
  const share = mode === "tokens" ? tokenShareOf(totals) : spendShareOf(totals);
  const columns = [
    keyColumn(dimension, lookups, canOpenDetails),
    shareColumn(share),
    ...(mode === "tokens" ? tokenColumns(dimension, range, canOpenDetails) : costColumns())
  ];
  return (
    <ConsoleTable
      stateKey={`${mode}:${dimension}`}
      data={rows}
      columns={columns}
      search={{ placeholder: `Search ${label.toLowerCase()}...`, getValue: (row) => searchValue(row, dimension, lookups) }}
      emptyLabel={`No ${label.toLowerCase()} usage yet. Run traffic through the proxy and this ledger fills in.`}
    />
  );
}

function keyColumn(dimension: UsageDimension, lookups: GroupLabelLookups, canOpenDetails: boolean): ConsoleTableColumn<UsageGroup> {
  return {
    id: "key",
    header: dimensionLabel(dimension).replace(/s$/, ""),
    size: keyColumnSize(dimension),
    accessorFn: (row) => row.key,
    cell: ({ row }) => <UsageKeyCell dimension={dimension} group={row.original} lookups={lookups} canOpenDetails={canOpenDetails} />
  };
}

function shareColumn(share: (row: UsageGroup) => number): ConsoleTableColumn<UsageGroup> {
  return {
    id: "share",
    header: "Share",
    size: 140,
    accessorFn: share,
    cell: ({ row }) => <ShareCell share={share(row.original)} />
  };
}

function tokenColumns(dimension: UsageDimension, range: UsageRangeKey, canOpenDetails: boolean): ConsoleTableColumn<UsageGroup>[] {
  return [
    { id: "requests", header: "Requests", size: 96, accessorFn: (row) => row.requestCount, cell: ({ row }) => <span className="mono">{formatInteger(row.original.requestCount)}</span> },
    { id: "input", header: "Input", size: 92, accessorFn: (row) => row.usage.inputTokens, cell: ({ row }) => <TokenCell value={row.original.usage.inputTokens} /> },
    { id: "cached", header: "Cached", size: 92, accessorFn: (row) => row.usage.cachedInputTokens, cell: ({ row }) => <TokenCell value={row.original.usage.cachedInputTokens} /> },
    { id: "output", header: "Output", size: 92, accessorFn: (row) => row.usage.outputTokens, cell: ({ row }) => <TokenCell value={row.original.usage.outputTokens} /> },
    { id: "tokens", header: "Total", size: 96, accessorFn: (row) => row.usage.totalTokens, cell: ({ row }) => <span className="mono">{formatCompact(row.original.usage.totalTokens)}</span> },
    { id: "p95", header: "p95", size: 84, accessorFn: (row) => row.latency.p95Ms ?? -1, cell: ({ row }) => <LatencyCell group={row.original} /> },
    { id: "failures", header: "Failures", size: 88, accessorFn: (row) => row.failureRate, cell: ({ row }) => <FailureCell group={row.original} dimension={dimension} range={range} canOpenDetails={canOpenDetails} /> }
  ];
}

function costColumns(): ConsoleTableColumn<UsageGroup>[] {
  return [
    { id: "spend", header: "Spend", size: 104, accessorFn: (row) => row.cost.selected, cell: ({ row }) => <span className="mono">{formatMoney(row.original.cost.selected)}</span> },
    { id: "baseline", header: "Baseline", size: 104, accessorFn: (row) => row.cost.baseline, cell: ({ row }) => <span className="mono faint">{formatMoney(row.original.cost.baseline)}</span> },
    { id: "savings", header: "Savings", size: 104, accessorFn: (row) => row.cost.savings, cell: ({ row }) => <SavingsCell value={row.original.cost.savings} /> },
    { id: "requests", header: "Requests", size: 96, accessorFn: (row) => row.requestCount, cell: ({ row }) => <span className="mono">{formatInteger(row.original.requestCount)}</span> },
    { id: "avg", header: "Avg / req", size: 100, accessorFn: avgCostPerRequest, cell: ({ row }) => <span className="mono">{formatMoney(avgCostPerRequest(row.original))}</span> },
    { id: "tokens", header: "Tokens", size: 92, accessorFn: (row) => row.usage.totalTokens, cell: ({ row }) => <span className="mono">{formatCompact(row.original.usage.totalTokens)}</span> }
  ];
}

function avgCostPerRequest(row: UsageGroup) {
  return row.requestCount === 0 ? 0 : row.cost.selected / row.requestCount;
}

function UsageKeyCell({ dimension, group, lookups, canOpenDetails }: {
  dimension: UsageDimension;
  group: UsageGroup;
  lookups: GroupLabelLookups;
  canOpenDetails: boolean;
}) {
  if (group.key === OTHER_GROUP_KEY) return <span className="faint">Other</span>;
  if (dimension === "route") return <RouteBadge route={group.key} />;
  if (dimension === "model" || dimension === "model_effort") return <span className="row gap-8"><span className="model-dot" /><span className="mono">{group.key}</span></span>;
  if (dimension === "user") return <UserKeyCell userId={group.key} usersById={lookups.usersById} />;
  if (dimension === "api_key") return <ApiKeyCell apiKeyId={group.key} apiKeysById={lookups.apiKeysById} />;
  if (dimension === "session") return <SessionKeyCell sessionId={group.key} canOpenDetails={canOpenDetails} />;
  return <span className="mono">{group.key}</span>;
}

function UserKeyCell({ userId, usersById }: { userId: string; usersById?: Map<string, UsageLookupUser> }) {
  if (userId === "unknown") return <span className="faint">Unknown user</span>;
  const user = usersById?.get(userId);
  const name = user ? displayUser(user) : userId;
  return (
    <span className="usage-user-key" title={userId}>
      <Avatar label={name} size={22} />
      <span>{name}</span>
    </span>
  );
}

function ApiKeyCell({ apiKeyId, apiKeysById }: { apiKeyId: string; apiKeysById?: Map<string, UsageLookupApiKey> }) {
  if (apiKeyId === "unknown") return <span className="faint">No API key</span>;
  const apiKey = apiKeysById?.get(apiKeyId);
  return (
    <span className="usage-key-cell" title={apiKeyId}>
      <span className="usage-key-icon"><KeyRound /></span>
      <span className="usage-key-name">
        <span>{apiKey?.name ?? compactId(apiKeyId, 9)}</span>
        {apiKey?.revokedAt ? <em>revoked</em> : null}
      </span>
    </span>
  );
}

function SessionKeyCell({ sessionId, canOpenDetails }: { sessionId: string; canOpenDetails: boolean }) {
  if (sessionId === "unknown") return <span className="faint">No session</span>;
  const { scope, tail } = splitSessionKey(sessionId);
  const label = (
    <>
      <span className="mono">{compactId(tail, 9)}</span>
      {scope ? <span className="usage-session-scope">{scope}</span> : null}
    </>
  );
  if (!canOpenDetails) {
    return <span className="usage-session-key" title={sessionId}>{label}</span>;
  }
  return (
    <Link to="/sessions/$sessionId" params={{ sessionId }} className="usage-session-key" title={sessionId}>
      {label}
    </Link>
  );
}

function ShareCell({ share }: { share: number }) {
  return (
    <div className="usage-share-cell">
      <span className="usage-share-track"><i style={{ width: `${Math.min(100, share * 100)}%` }} /></span>
      <span className="mono">{formatPercent(share)}</span>
    </div>
  );
}

function TokenCell({ value }: { value: number }) {
  if (value <= 0) return <span className="mono faint">—</span>;
  return <span className="mono">{formatCompact(value)}</span>;
}

function LatencyCell({ group }: { group: UsageGroup }) {
  if (group.latency.p95Ms === null) return <span className="mono faint">—</span>;
  const average = group.latency.averageMs === null ? "" : `avg ${formatDurationMs(group.latency.averageMs)}`;
  return <span className="mono" title={average}>{formatDurationMs(group.latency.p95Ms)}</span>;
}

function SavingsCell({ value }: { value: number }) {
  if (value <= 0) return <span className="mono faint">{formatMoney(value)}</span>;
  return <span className="mono accent-text">{formatMoney(value)}</span>;
}

function FailureCell({ group, dimension, range, canOpenDetails }: { group: UsageGroup; dimension: UsageDimension; range: UsageRangeKey; canOpenDetails: boolean }) {
  if (group.failureRate <= 0) return <span className="mono faint">—</span>;
  const search = failuresLogsSearch(dimension, group.key, range);
  const rate = <span className="mono danger-text">{formatPercent(group.failureRate)}</span>;
  if (!search || !canOpenDetails) return rate;
  return (
    <Link to="/logs" search={search} className="failure-link" title="View these failed requests in logs">
      {rate}
    </Link>
  );
}

// Maps a breakdown row to logs URL params that isolate its failed requests over the same window.
// Model/User reuse the logs filter params; the other dimensions ride the advanced-rule (`adv`) param.
// Returns null when the key can't be expressed as a logs filter (the "Other" aggregate or an
// "unknown" group, which is an absent field rather than a filterable value).
function failuresLogsSearch(dimension: UsageDimension, key: string, range: UsageRangeKey) {
  if (key === OTHER_GROUP_KEY || key === "unknown") return null;
  const rangeParam = { range };
  if (dimension === "model") return { ...rangeParam, status: "failed", model: key };
  if (dimension === "user") return { ...rangeParam, status: "failed", user: key };
  const advFields: Partial<Record<UsageDimension, string>> = { route: "route", provider: "provider", surface: "surface", session: "session", api_key: "apiKey" };
  const advField = advFields[dimension];
  if (!advField) return null;
  return { ...rangeParam, status: "failed", adv: [[advField, "equals", key, "and"]] };
}

function searchValue(row: UsageGroup, dimension: UsageDimension, lookups: GroupLabelLookups) {
  if (dimension === "user") {
    const user = lookups.usersById?.get(row.key);
    return [row.key, user?.name ?? "", user?.email ?? ""];
  }
  if (dimension === "api_key") {
    const apiKey = lookups.apiKeysById?.get(row.key);
    return [row.key, apiKey?.name ?? ""];
  }
  return row.key;
}

function splitSessionKey(key: string) {
  const separator = key.lastIndexOf(":");
  if (separator <= 0 || separator === key.length - 1) return { scope: null, tail: key };
  return { scope: key.slice(0, separator), tail: key.slice(separator + 1) };
}

function keyColumnSize(dimension: UsageDimension) {
  if (dimension === "session") return 280;
  if (dimension === "model_effort") return 260;
  if (dimension === "model" || dimension === "user" || dimension === "api_key") return 230;
  return 170;
}
