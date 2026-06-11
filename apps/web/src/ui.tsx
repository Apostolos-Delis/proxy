import type { CSSProperties, ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Box, Copy, Info } from "lucide-react";

import { compactId } from "./format";
import { JsonView } from "./jsonView";

export type ConsoleMetric = {
  label: string;
  value: string;
  detail?: string;
  icon?: ReactNode;
  delta?: number;
  deltaPositiveIsGood?: boolean;
};

export function GlassCard({ children, className = "", style }: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return <section className={`glass card ${className}`} style={style}>{children}</section>;
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-title-row">
      <div>
        <h2>{title}</h2>
        {subtitle ? <div className="muted">{subtitle}</div> : null}
      </div>
      {actions ? <div className="row gap-8">{actions}</div> : null}
    </div>
  );
}

export function PageState({ title, label }: { title: string; label: string }) {
  return (
    <div className="page page-enter">
      <PageTitle title={title} subtitle={label} />
      <GlassCard className="empty-state">
        <Box />
        <strong>{label}</strong>
        <span>Run traffic through the proxy and this surface will populate automatically.</span>
      </GlassCard>
    </div>
  );
}

export function StatCard({ metric, chart }: { metric: ConsoleMetric; chart?: ReactNode }) {
  return (
    <GlassCard className="stat-card">
      <div className="card-head">
        <div className="card-title">{metric.icon}{metric.label}</div>
        {metric.delta === undefined ? null : <Delta value={metric.delta} positiveIsGood={metric.deltaPositiveIsGood} />}
      </div>
      <div className="stat-value">{metric.value}</div>
      {metric.detail ? <div className="stat-sub">{metric.detail}</div> : null}
      {chart ? <div className="stat-chart">{chart}</div> : null}
    </GlassCard>
  );
}

export function PageSkeleton({ blocks = [200, 320, 160] }: { blocks?: number[] }) {
  return (
    <div className="page page-enter" aria-busy="true" aria-label="Loading">
      {blocks.map((height, index) => (
        <div key={index} className="glass card skeleton-card skeleton-pulse" style={{ height }} />
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, accent = false }: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  accent?: boolean;
}) {
  return (
    <div className={`segmented${accent ? " accent" : ""}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, variant, dot = false }: { children: ReactNode; variant?: "accent" | "success" | "danger" | "warn"; dot?: boolean }) {
  return <span className={`badge${variant ? ` badge-${variant}` : ""}`}>{dot ? <span className="dot" /> : null}{children}</span>;
}

export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="info-hint" tabIndex={0} role="note" aria-label={label}>
      <Info />
      <span className="info-hint-bubble" role="tooltip">{children}</span>
    </span>
  );
}

export function StatusBadge({ status }: { status?: string | null }) {
  const tone = statusTone(status ?? "unknown");
  if (tone === "success") return <Badge variant="success" dot>{status === "paid" ? "Success" : status ?? "success"}</Badge>;
  if (tone === "danger") return <Badge variant="danger" dot>{status ?? "error"}</Badge>;
  if (tone === "warn") return <Badge variant="warn" dot>{status ?? "pending"}</Badge>;
  return <Badge dot>{status ?? "unknown"}</Badge>;
}

export function RouteBadge({ route }: { route?: string | null }) {
  const value = route ?? "unknown";
  return <span className={`chip route-chip route-${routeTone(value)}`}>{value}</span>;
}

export function Avatar({ label, color = "var(--accent)", size = 30 }: { label: string; color?: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.4 }}>
      {initials(label)}
    </span>
  );
}

export function UserCell({ name, detail, color, size }: { name: string; detail?: string | null; color?: string; size?: number }) {
  return (
    <div className="user-cell">
      <Avatar label={name} color={color} size={size} />
      <div>
        <div className="user-name">{name}</div>
        {detail ? <div className="user-email">{detail}</div> : null}
      </div>
    </div>
  );
}

export function ProgressMeter({ value, max, tone = "accent" }: { value: number; max: number; tone?: "accent" | "success" | "danger" }) {
  const width = max <= 0 || value <= 0 ? 0 : Math.max(2, Math.min(100, (value / max) * 100));
  return <div className={`meter ${tone}`}><i style={{ width: `${width}%` }} /></div>;
}

export function DataTable({ children }: { children: ReactNode }) {
  return <table className="tbl">{children}</table>;
}

export function BarListRow({ label, value, width, avatar, color, mono = false }: {
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

export function CodePill({ value, copy = false }: { value: string; copy?: boolean }) {
  return (
    <span className="code-pill">
      {value}
      {copy ? <Copy /> : null}
    </span>
  );
}

export function Delta({ value, positiveIsGood = true }: { value: number; positiveIsGood?: boolean }) {
  const up = value >= 0;
  const good = up === positiveIsGood;
  return (
    <span className={`delta ${good ? "up" : "down"}`} title="vs previous period">
      {up ? <ArrowUpRight /> : <ArrowDownRight />}
      {Math.round(Math.abs(value))}%
    </span>
  );
}

export function ConsoleButton({ children, type = "button", disabled = false, variant = "primary", onClick }: {
  children: ReactNode;
  type?: "button" | "submit";
  disabled?: boolean;
  variant?: "primary" | "default" | "ghost";
  onClick?: () => void;
}) {
  const variantClass = buttonVariantClass(variant);
  return <button className={`btn ${variantClass}`} type={type} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <GlassCard className="code-panel">
      <div className="card-title">{title}</div>
      <JsonView value={value} maxHeight={520} />
    </GlassCard>
  );
}

export function CompactId({ value }: { value: string }) {
  return <span className="mono faint">{compactId(value)}</span>;
}

export function FormField({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="routing-create-field">
      <span>{label}</span>
      {children}
      {error ? <small>{error}</small> : null}
    </label>
  );
}

function initials(value: string) {
  return value.split(/[\s._-]+/).map((word) => word[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

function routeTone(route: string) {
  const value = route.toLowerCase();
  if (value === "fast" || value === "low" || value === "minimal") return "fast";
  if (value === "balanced" || value === "medium" || value === "auto") return "balanced";
  if (value === "hard" || value === "high") return "hard";
  if (value === "deep" || value === "xhigh" || value === "max") return "deep";
  return "unknown";
}

function statusTone(status: string) {
  const value = status.toLowerCase();
  if (value === "completed" || value === "success" || value === "paid" || value === "active" || value === "accepted") return "success";
  if (value === "failed" || value === "error" || value === "inactive" || value === "revoked" || value === "expired" || value === "deactivated" || value === "disabled") return "danger";
  if (value === "pending" || value === "received" || value === "provider_pending" || value === "invited") return "warn";
  return "default";
}

function buttonVariantClass(variant: "primary" | "default" | "ghost") {
  if (variant === "primary") return "btn-primary";
  if (variant === "ghost") return "btn-ghost";
  return "";
}
