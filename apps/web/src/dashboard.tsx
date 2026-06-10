import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Delta, GlassCard, type ConsoleMetric } from "./ui";

export type AppPath = "/" | "/usage" | "/logs" | "/api-keys" | "/users" | "/billing" | "/settings" | "/prompts" | "/sessions";

export type InspectorRow = {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
};

type InteractiveCardProps = {
  children: ReactNode;
  className?: string;
  active?: boolean;
  ariaLabel: string;
  to?: AppPath;
  onClick?: () => void;
};

export function InteractiveCard({ children, className = "", active = false, ariaLabel, to, onClick }: InteractiveCardProps) {
  const classes = `glass card interactive-card${active ? " active" : ""}${className ? ` ${className}` : ""}`;
  if (to) {
    return <Link to={to} className={classes} aria-label={ariaLabel}>{children}</Link>;
  }
  if (onClick) {
    return <button className={`${classes} card-button`} type="button" aria-label={ariaLabel} onClick={onClick}>{children}</button>;
  }
  return <GlassCard className={className}>{children}</GlassCard>;
}

export function InteractiveStatCard({ metric, chart, to, onClick, active = false }: {
  metric: ConsoleMetric;
  chart?: ReactNode;
  to?: AppPath;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <InteractiveCard className="stat-card" active={active} ariaLabel={`Inspect ${metric.label}`} to={to} onClick={onClick}>
      <div className="card-head">
        <div className="card-title">{metric.icon}{metric.label}</div>
        {metric.delta === undefined ? null : <Delta value={metric.delta} positiveIsGood={metric.deltaPositiveIsGood} />}
      </div>
      <div className="stat-value">{metric.value}</div>
      {metric.detail ? <div className="stat-sub">{metric.detail}</div> : null}
      {chart ? <div className="stat-chart">{chart}</div> : null}
    </InteractiveCard>
  );
}

export function InspectorPanel({ title, subtitle, rows, action }: {
  title: string;
  subtitle?: ReactNode;
  rows: InspectorRow[];
  action?: ReactNode;
}) {
  return (
    <GlassCard className="dashboard-inspector">
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          {subtitle ? <div className="inspector-subtitle">{subtitle}</div> : null}
        </div>
        {action}
      </div>
      <div className="inspector-grid">
        {rows.map((row) => (
          <div key={row.label} className="inspector-row">
            <span>{row.label}</span>
            <strong>{row.value}</strong>
            {row.detail ? <em>{row.detail}</em> : null}
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

export function downloadJson(filename: string, value: unknown) {
  const payload = encodeURIComponent(JSON.stringify(value, null, 2));
  window.open(`data:application/json;charset=utf-8,${payload}`, filename, "noopener,noreferrer");
}
