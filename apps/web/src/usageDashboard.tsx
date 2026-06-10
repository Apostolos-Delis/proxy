import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import type { UsageGroup, UsageResponse, UserSummary } from "./api";
import type { ModelUsageRow, UserUsageRow } from "./consoleData";
import { displayUser } from "./consoleData";
import { compactId, formatCompact, formatInteger, formatMoney, formatPercent } from "./format";
import { ConsoleTable, type ConsoleTableColumn } from "./table";
import { Avatar, GlassCard, ProgressMeter, RouteBadge } from "./ui";

export type UsageDimension = "route" | "provider" | "model" | "user" | "surface" | "session";

export type UsageSideTab = "users" | "models";

export const usageDimensions: { value: UsageDimension; label: string }[] = [
  { value: "route", label: "Routes" },
  { value: "provider", label: "Providers" },
  { value: "model", label: "Models" },
  { value: "user", label: "Users" },
  { value: "surface", label: "Surfaces" },
  { value: "session", label: "Sessions" }
];

export function UsageSummaryStrip({ totals }: { totals: UsageGroup }) {
  const requestCount = Math.max(totals.requestCount, 1);
  // Average spend per request, falling back to tokens while pricing is unset and every cost is $0.
  const average = totals.cost.selected > 0
    ? formatMoney(totals.cost.selected / requestCount)
    : `${formatCompact(totals.usage.totalTokens / requestCount)} tok`;
  return (
    <div className="usage-summary-strip">
      <Summary label="Requests" value={formatInteger(totals.requestCount)} />
      <Summary label="Tokens" value={formatCompact(totals.usage.totalTokens)} />
      <Summary label="Avg / request" value={average} />
      <Summary label="Failure rate" value={formatPercent(totals.failureRate)} tone={totals.failureRate > 0 ? "danger-text" : undefined} />
    </div>
  );
}

export function UsageSideRail({ totals, sideTab, users, modelRows, onSideTab }: {
  totals: UsageGroup;
  sideTab: UsageSideTab;
  users: UserUsageRow[];
  modelRows: ModelUsageRow[];
  onSideTab: (tab: UsageSideTab) => void;
}) {
  const comparison = Math.max(totals.cost.baseline, totals.cost.selected);
  // Rank users by spend, by tokens while pricing is unset and every cost is $0.
  const userMetric = users.some((user) => user.spend > 0)
    ? (user: UserUsageRow) => user.spend
    : (user: UserUsageRow) => user.tokens;
  const topUsers = [...users].sort((left, right) => userMetric(right) - userMetric(left)).slice(0, 6);
  const topModels = [...modelRows].sort((left, right) => right.tokens - left.tokens).slice(0, 6);
  const maxUserValue = Math.max(...topUsers.map(userMetric), 1);
  const maxModelTokens = Math.max(...topModels.map((row) => row.tokens), 1);
  return (
    <div className="usage-side-rail">
      <GlassCard>
        <div className="card-title">Routing savings</div>
        <div className="stat-value side-spend accent-text">{formatMoney(totals.cost.savings)}</div>
        <ProgressMeter value={totals.cost.selected} max={comparison} />
        <div className="row budget-row">
          <span className="faint">{formatMoney(totals.cost.selected)} spent</span>
          <span className="faint">{formatMoney(totals.cost.baseline)} baseline</span>
        </div>
      </GlassCard>
      <GlassCard>
        <div className="tabs">
          <button className={sideTab === "users" ? "active" : ""} type="button" onClick={() => onSideTab("users")}>Top users</button>
          <button className={sideTab === "models" ? "active" : ""} type="button" onClick={() => onSideTab("models")}>Top models</button>
        </div>
        <div className="barlist usage-top-list">
          {sideTab === "users" ? topUsers.map((user) => (
            <BarListRow
              key={user.id}
              label={user.name}
              value={user.spend > 0 ? formatMoney(user.spend, 0) : `${formatCompact(user.tokens)} tok`}
              width={(userMetric(user) / maxUserValue) * 100}
              avatar={<Avatar label={user.name} color={user.color} size={22} />}
            />
          )) : null}
          {sideTab === "models" ? topModels.map((model) => (
            <BarListRow
              key={model.label}
              label={model.label}
              value={formatCompact(model.tokens)}
              width={(model.tokens / maxModelTokens) * 100}
              color={model.color}
              mono
            />
          )) : null}
          {sideTab === "users" && topUsers.length === 0 ? <div className="empty compact-empty">No user usage yet.</div> : null}
          {sideTab === "models" && topModels.length === 0 ? <div className="empty compact-empty">No model usage yet.</div> : null}
        </div>
      </GlassCard>
    </div>
  );
}

export function UsageBreakdown({ responses, dimension, usersById, onDimension }: {
  responses: UsageResponse[];
  dimension: UsageDimension;
  usersById: Map<string, UserSummary>;
  onDimension: (dimension: UsageDimension) => void;
}) {
  const response = responses.find((item) => item.groupBy === dimension);
  const rows = [...(response?.data ?? [])].sort((left, right) => right.cost.selected - left.cost.selected);
  const share = shareOf(response?.totals);
  const label = dimensionLabel(dimension);
  return (
    <section className="usage-breakdown">
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
        <Link to="/logs" className="usage-breakdown-link">Open logs<ArrowUpRight /></Link>
      </div>
      <ConsoleTable
        key={dimension}
        data={rows}
        columns={breakdownColumns(dimension, share, usersById)}
        search={{ placeholder: `Search ${label.toLowerCase()}...`, getValue: (row) => breakdownSearchValue(row, dimension, usersById) }}
        emptyLabel={`No ${label.toLowerCase()} usage yet. Run traffic through the proxy and this ledger fills in.`}
      />
    </section>
  );
}

function breakdownColumns(dimension: UsageDimension, share: (row: UsageGroup) => number, usersById: Map<string, UserSummary>): ConsoleTableColumn<UsageGroup>[] {
  return [
    {
      id: "key",
      header: dimensionLabel(dimension).replace(/s$/, ""),
      size: keyColumnSize(dimension),
      accessorFn: (row) => row.key,
      cell: ({ row }) => <UsageKeyCell dimension={dimension} group={row.original} usersById={usersById} />
    },
    {
      id: "share",
      header: "Share",
      size: 150,
      accessorFn: share,
      cell: ({ row }) => <ShareCell share={share(row.original)} />
    },
    { id: "requests", header: "Requests", size: 104, accessorFn: (row) => row.requestCount, cell: ({ row }) => <span className="mono">{formatInteger(row.original.requestCount)}</span> },
    { id: "tokens", header: "Tokens", size: 104, accessorFn: (row) => row.usage.totalTokens, cell: ({ row }) => <span className="mono">{formatCompact(row.original.usage.totalTokens)}</span> },
    { id: "spend", header: "Spend", size: 112, accessorFn: (row) => row.cost.selected, cell: ({ row }) => <span className="mono">{formatMoney(row.original.cost.selected)}</span> },
    { id: "retries", header: "Retries", size: 96, accessorFn: (row) => row.retryRate, cell: ({ row }) => <RateCell rate={row.original.retryRate} tone="warn-text" /> },
    { id: "failures", header: "Failures", size: 96, accessorFn: (row) => row.failureRate, cell: ({ row }) => <RateCell rate={row.original.failureRate} tone="danger-text" /> }
  ];
}

function UsageKeyCell({ dimension, group, usersById }: {
  dimension: UsageDimension;
  group: UsageGroup;
  usersById: Map<string, UserSummary>;
}) {
  if (dimension === "route") return <RouteBadge route={group.key} />;
  if (dimension === "model") return <span className="row gap-8"><span className="model-dot" /><span className="mono">{group.key}</span></span>;
  if (dimension === "user") return <UserKeyCell userId={group.key} usersById={usersById} />;
  if (dimension === "session") return <SessionKeyCell sessionId={group.key} />;
  return <span className="mono">{group.key}</span>;
}

function UserKeyCell({ userId, usersById }: { userId: string; usersById: Map<string, UserSummary> }) {
  const user = usersById.get(userId);
  const name = user ? displayUser(user) : userId;
  return (
    <span className="usage-user-key" title={userId}>
      <Avatar label={name} size={22} />
      <span>{name}</span>
    </span>
  );
}

function SessionKeyCell({ sessionId }: { sessionId: string }) {
  const { scope, tail } = splitSessionKey(sessionId);
  return (
    <Link to="/sessions/$sessionId" params={{ sessionId }} className="usage-session-key" title={sessionId}>
      <span className="mono">{compactId(tail, 9)}</span>
      {scope ? <span className="usage-session-scope">{scope}</span> : null}
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

function RateCell({ rate, tone }: { rate: number; tone: "warn-text" | "danger-text" }) {
  if (rate <= 0) return <span className="mono faint">—</span>;
  return <span className={`mono ${tone}`}>{formatPercent(rate)}</span>;
}

function BarListRow({ label, value, width, avatar, color, mono = false }: {
  label: string;
  value: string;
  width: number;
  avatar?: ReactNode;
  color?: string;
  mono?: boolean;
}) {
  return (
    <div className="barlist-row">
      <div className="barlist-label">
        {avatar}
        {color ? <span className="model-dot" style={{ background: color }} /> : null}
        <span className={mono ? "mono" : undefined}>{label}</span>
      </div>
      <div className="barlist-val">{value}</div>
      <div className="barlist-track"><i style={{ width: `${width}%`, background: color }} /></div>
    </div>
  );
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="card-title">{label}</div>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function breakdownSearchValue(row: UsageGroup, dimension: UsageDimension, usersById: Map<string, UserSummary>) {
  if (dimension !== "user") return row.key;
  const user = usersById.get(row.key);
  return [row.key, user?.name ?? "", user?.email ?? ""];
}

/** Share of spend; falls back to token share while pricing is unset and every cost is $0. */
function shareOf(totals?: UsageGroup) {
  const totalSpend = totals?.cost.selected ?? 0;
  if (totalSpend > 0) return (row: UsageGroup) => row.cost.selected / totalSpend;
  const totalTokens = totals?.usage.totalTokens ?? 0;
  if (totalTokens > 0) return (row: UsageGroup) => row.usage.totalTokens / totalTokens;
  return () => 0;
}

function splitSessionKey(key: string) {
  const separator = key.lastIndexOf(":");
  if (separator <= 0 || separator === key.length - 1) return { scope: null, tail: key };
  return { scope: key.slice(0, separator), tail: key.slice(separator + 1) };
}

function keyColumnSize(dimension: UsageDimension) {
  if (dimension === "session") return 280;
  if (dimension === "model" || dimension === "user") return 230;
  return 170;
}

function dimensionLabel(dimension: UsageDimension) {
  return usageDimensions.find((item) => item.value === dimension)?.label ?? "Usage";
}
