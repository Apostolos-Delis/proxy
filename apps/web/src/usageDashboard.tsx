import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { ChartSelection } from "./charts";
import type { UsageGroup, UsageResponse } from "./api";
import type { ModelUsageRow, UserUsageRow } from "./consoleData";
import { InspectorPanel, type InspectorRow } from "./dashboard";
import { formatCompact, formatInteger, formatMoney, formatPercent } from "./format";
import { Avatar, DataTable, GlassCard, ProgressMeter, RouteBadge } from "./ui";

export type UsageSideTab = "users" | "models" | "keys";

export type UsageSelection = {
  id: string;
  title: string;
  subtitle: string;
  rows: InspectorRow[];
};

export function UsageSummaryStrip({ tokens, requests, averageCost }: {
  tokens: number;
  requests: number;
  averageCost: number;
}) {
  return (
    <div className="usage-summary-strip">
      <Summary label="Tokens" value={formatCompact(tokens)} />
      <Summary label="Requests" value={formatInteger(requests)} />
      <Summary label="Avg / request" value={formatMoney(averageCost)} />
    </div>
  );
}

export function UsageSideRail({ totals, comparison, sideTab, users, modelRows, onSideTab, onSelect, selectedId }: {
  totals: UsageGroup;
  comparison: number;
  sideTab: UsageSideTab;
  users: UserUsageRow[];
  modelRows: ModelUsageRow[];
  onSideTab: (tab: UsageSideTab) => void;
  onSelect: (selection: UsageSelection) => void;
  selectedId?: string;
}) {
  const maxUserSpend = Math.max(...users.map((user) => user.spend), 1);
  const maxModelTokens = Math.max(...modelRows.map((row) => row.tokens), 1);
  return (
    <div className="usage-side-rail">
      <GlassCard>
        <div className="card-title">Selected spend</div>
        <div className="stat-value side-spend">{formatMoney(totals.cost.selected)}</div>
        <ProgressMeter value={totals.cost.selected} max={comparison} />
        <div className="row budget-row">
          <span className="faint">{formatMoney(totals.cost.baseline)} baseline</span>
          <span className="mono accent-text">{formatMoney(totals.cost.savings)} saved</span>
        </div>
      </GlassCard>
      <GlassCard>
        <div className="tabs">
          <button className={sideTab === "users" ? "active" : ""} type="button" onClick={() => onSideTab("users")}>Users</button>
          <button className={sideTab === "models" ? "active" : ""} type="button" onClick={() => onSideTab("models")}>Models</button>
          <button className={sideTab === "keys" ? "active" : ""} type="button" onClick={() => onSideTab("keys")}>API keys</button>
        </div>
        <div className="barlist usage-user-list">
          {sideTab === "users" ? users.slice(0, 6).map((user) => (
            <BarListRow
              key={user.id}
              label={user.name}
              value={formatMoney(user.spend, 0)}
              width={(user.spend / maxUserSpend) * 100}
              active={selectedId === `user:${user.id}`}
              avatar={<Avatar label={user.name} color={user.color} size={22} />}
              onSelect={() => onSelect(userSelection(user))}
            />
          )) : null}
          {sideTab === "models" ? modelRows.slice(0, 6).map((model) => (
            <BarListRow
              key={model.label}
              label={model.label}
              value={formatCompact(model.tokens)}
              width={(model.tokens / maxModelTokens) * 100}
              color={model.color}
              active={selectedId === `model:${model.label}`}
              onSelect={() => onSelect(modelSelection(model))}
            />
          )) : null}
          {sideTab === "keys" ? <div className="empty compact-empty">API key usage needs an admin API key endpoint.</div> : null}
          {sideTab === "users" && users.length === 0 ? <div className="empty compact-empty">No user usage yet.</div> : null}
          {sideTab === "models" && modelRows.length === 0 ? <div className="empty compact-empty">No model usage yet.</div> : null}
        </div>
      </GlassCard>
    </div>
  );
}

export function UsageGroupPanel({ response, selectedId, onSelect }: {
  response: UsageResponse;
  selectedId?: string;
  onSelect: (selection: UsageSelection) => void;
}) {
  return (
    <GlassCard className="table-wrap usage-table-card">
      <div className="card-head">
        <div>
          <div className="card-title">{response.groupBy}</div>
          <h3>{titleForGroup(response.groupBy)}</h3>
        </div>
      </div>
      <DataTable>
        <thead>
          <tr><th>{response.groupBy}</th><th>Requests</th><th>Tokens</th><th>Cost</th><th>Retries</th><th>Failures</th></tr>
        </thead>
        <tbody>
          {response.data.map((row) => (
            <UsageRow
              key={row.key}
              row={row}
              groupBy={response.groupBy}
              active={selectedId === usageSelectionId(response.groupBy, row.key)}
              onSelect={() => onSelect(usageRowSelection(response.groupBy, row))}
            />
          ))}
        </tbody>
      </DataTable>
      {response.data.length === 0 ? <div className="empty">No {response.groupBy} usage yet.</div> : null}
    </GlassCard>
  );
}

export function UsageInspector({ selection }: { selection: UsageSelection }) {
  return (
    <InspectorPanel
      title={selection.title}
      subtitle={selection.subtitle}
      rows={selection.rows}
      action={<Link to="/logs" className="btn btn-sm">Open logs</Link>}
    />
  );
}

export function defaultUsageSelection(totals: UsageGroup): UsageSelection {
  return {
    id: "totals",
    title: "Usage ledger",
    subtitle: "Click any chart bar, side-rail row, or table row to inspect a slice.",
    rows: [
      { label: "Requests", value: formatInteger(totals.requestCount) },
      { label: "Tokens", value: formatCompact(totals.usage.totalTokens) },
      { label: "Selected spend", value: formatMoney(totals.cost.selected) }
    ]
  };
}

export function chartSelection(selection: ChartSelection): UsageSelection {
  return {
    id: `day:${selection.index}`,
    title: selection.point.label,
    subtitle: "Selected spend bucket",
    rows: [
      { label: "Spend", value: formatMoney(selection.point.value) },
      { label: "Bucket", value: selection.index + 1 },
      { label: "Next step", value: "Open logs", detail: "Inspect prompts and models contributing to this bucket." }
    ]
  };
}

function UsageRow({ row, groupBy, active, onSelect }: {
  row: UsageGroup;
  groupBy: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <tr className={active ? "selectable-row selected" : "selectable-row"} tabIndex={0} role="button" onClick={onSelect} onKeyDown={(event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelect();
    }}>
      <td>{groupBy === "route" ? <RouteBadge route={row.key} /> : <span className="mono">{row.key}</span>}</td>
      <td>{formatInteger(row.requestCount)}</td>
      <td>{formatCompact(row.usage.totalTokens)}</td>
      <td>{formatMoney(row.cost.selected)}</td>
      <td>{formatPercent(row.retryRate)}</td>
      <td>{formatPercent(row.failureRate)}</td>
    </tr>
  );
}

function BarListRow({ label, value, width, avatar, color, active, onSelect }: {
  label: string;
  value: string;
  width: number;
  avatar?: ReactNode;
  color?: string;
  active?: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`barlist-row barlist-button${active ? " active" : ""}`} type="button" onClick={onSelect}>
      <div className="barlist-label">{avatar}<span>{label}</span></div>
      <div className="barlist-val">{value}</div>
      <div className="barlist-track"><i style={{ width: `${width}%`, background: color }} /></div>
    </button>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="card-title">{label}</div>
      <strong>{value}</strong>
    </div>
  );
}

function usageRowSelection(groupBy: string, row: UsageGroup): UsageSelection {
  return {
    id: usageSelectionId(groupBy, row.key),
    title: row.key,
    subtitle: `${titleForGroup(groupBy)} slice`,
    rows: usageRows(row)
  };
}

function modelSelection(model: ModelUsageRow): UsageSelection {
  return {
    id: `model:${model.label}`,
    title: model.label,
    subtitle: "Model ledger slice",
    rows: [
      { label: "Tokens", value: formatCompact(model.tokens) },
      { label: "Spend", value: formatMoney(model.spend) },
      { label: "Cost / token", value: model.tokens > 0 ? formatMoney(model.spend / model.tokens) : formatMoney(0) }
    ]
  };
}

function userSelection(user: UserUsageRow): UsageSelection {
  return {
    id: `user:${user.id}`,
    title: user.name,
    subtitle: user.email ?? user.id,
    rows: [
      { label: "Tokens", value: formatCompact(user.tokens) },
      { label: "Spend", value: formatMoney(user.spend) },
      { label: "User id", value: user.id }
    ]
  };
}

function usageRows(row: UsageGroup): InspectorRow[] {
  return [
    { label: "Requests", value: formatInteger(row.requestCount) },
    { label: "Tokens", value: formatCompact(row.usage.totalTokens) },
    { label: "Spend", value: formatMoney(row.cost.selected) },
    { label: "Retry rate", value: formatPercent(row.retryRate) },
    { label: "Failure rate", value: formatPercent(row.failureRate) }
  ];
}

function usageSelectionId(groupBy: string, key: string) {
  return `${groupBy}:${key}`;
}

function titleForGroup(groupBy: string) {
  if (groupBy === "route") return "Routes";
  if (groupBy === "provider") return "Providers";
  if (groupBy === "model") return "Models";
  if (groupBy === "user") return "Users";
  if (groupBy === "surface") return "Surfaces";
  return "Sessions";
}
