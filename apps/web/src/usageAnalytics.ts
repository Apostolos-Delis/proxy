import type { ApiKeySummary, UsageGroup, UsageTimeseries, UserSummary } from "./api";
import { displayUser } from "./consoleData";

export type UsageRangeKey = "1" | "7" | "30" | "90";

export const usageRangeOptions = [
  { value: "1", label: "24h" },
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" }
] as const;

export type UsageDimension = "route" | "provider" | "model" | "user" | "api_key" | "surface" | "session";

export const usageDimensions: { value: UsageDimension; label: string }[] = [
  { value: "route", label: "Routes" },
  { value: "provider", label: "Providers" },
  { value: "model", label: "Models" },
  { value: "user", label: "Users" },
  { value: "api_key", label: "API keys" },
  { value: "surface", label: "Surfaces" },
  { value: "session", label: "Sessions" }
];

export function dimensionLabel(dimension: UsageDimension) {
  return usageDimensions.find((item) => item.value === dimension)?.label ?? "Usage";
}

/** Server-side range filter; the anchor pins "now" so query keys stay stable between refreshes. */
export function usageRangeQuery(range: UsageRangeKey, anchor: Date) {
  const days = Number(range);
  return {
    start: new Date(anchor.getTime() - days * 86_400_000).toISOString(),
    end: anchor.toISOString(),
    interval: (days === 1 ? "hour" : "day") as "hour" | "day"
  };
}

export const OTHER_GROUP_KEY = "__other__";

const seriesPalette = [
  "#2dd4bf",
  "#38bdf8",
  "#a78bfa",
  "#fb923c",
  "#34d399",
  "#f472b6",
  "#facc15",
  "#60a5fa",
  "#f87171",
  "#22d3ee"
];

const otherColor = "#64748b";

export function seriesColor(index: number, key: string) {
  if (key === OTHER_GROUP_KEY) return otherColor;
  return seriesPalette[index % seriesPalette.length];
}

export type GroupLabelLookups = {
  usersById?: Map<string, UserSummary>;
  apiKeysById?: Map<string, ApiKeySummary>;
};

export function groupKeyLabel(dimension: UsageDimension, key: string, lookups: GroupLabelLookups = {}) {
  if (key === OTHER_GROUP_KEY) return "Other";
  if (dimension === "user") {
    if (key === "unknown") return "Unknown user";
    const user = lookups.usersById?.get(key);
    return user ? displayUser(user) : key;
  }
  if (dimension === "api_key") {
    if (key === "unknown") return "No API key";
    return lookups.apiKeysById?.get(key)?.name ?? key;
  }
  if (dimension === "session") {
    const separator = key.lastIndexOf(":");
    return separator > 0 && separator < key.length - 1 ? key.slice(separator + 1) : key;
  }
  return key;
}

export type UsageMetric = "cost" | "tokens" | "requests";

export function metricValue(group: UsageGroup | undefined, metric: UsageMetric) {
  if (!group) return 0;
  if (metric === "cost") return group.cost.selected;
  if (metric === "tokens") return group.usage.totalTokens;
  return group.requestCount;
}

export type StackedSeries = {
  key: string;
  label: string;
  color: string;
};

export type StackedRow = {
  label: string;
  ts: string;
  total: number;
  values: Record<string, number>;
};

export function stackedUsageSeries(
  timeseries: UsageTimeseries,
  dimension: UsageDimension,
  metric: UsageMetric,
  lookups: GroupLabelLookups = {}
): { series: StackedSeries[]; rows: StackedRow[] } {
  const series = timeseries.groups.map((group, index) => ({
    key: group.key,
    label: groupKeyLabel(dimension, group.key, lookups),
    color: seriesColor(index, group.key)
  }));
  const rows = timeseries.points.map((point) => ({
    label: bucketLabel(point.ts, timeseries.interval),
    ts: point.ts,
    total: metricValue(point.totals, metric),
    values: Object.fromEntries(
      timeseries.groups.map((group) => [group.key, metricValue(point.groups[group.key], metric)])
    )
  }));
  return { series, rows };
}

/** Day buckets are UTC dates; render them as UTC so bars do not bleed across local midnight. */
function bucketLabel(ts: string, interval: "hour" | "day") {
  const date = new Date(ts);
  if (interval === "hour") {
    return date.toLocaleTimeString("en-US", { hour: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Token share; falls back to request share when nothing metered tokens. */
export function tokenShareOf(totals: UsageGroup | undefined) {
  const totalTokens = totals?.usage.totalTokens ?? 0;
  if (totalTokens > 0) return (row: UsageGroup) => row.usage.totalTokens / totalTokens;
  const totalRequests = totals?.requestCount ?? 0;
  if (totalRequests > 0) return (row: UsageGroup) => row.requestCount / totalRequests;
  return () => 0;
}

/** Spend share; falls back to token share while pricing is unset and every cost is $0. */
export function spendShareOf(totals: UsageGroup | undefined) {
  const totalSpend = totals?.cost.selected ?? 0;
  if (totalSpend > 0) return (row: UsageGroup) => row.cost.selected / totalSpend;
  return tokenShareOf(totals);
}
