import { displayUser } from "./consoleData";
import type { UsageGroup, UsageLookupApiKey, UsageLookupUser, UsageTimeseries } from "./usageData";

export type UsageRangeKey = "1" | "7" | "30" | "90";

export const usageRangeOptions = [
  { value: "1", label: "24h" },
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" }
] as const;

export type UsageDimension = "route" | "provider" | "model" | "model_effort" | "user" | "api_key" | "surface" | "session";

export const usageDimensions: { value: UsageDimension; label: string }[] = [
  { value: "route", label: "Routes" },
  { value: "provider", label: "Providers" },
  { value: "model", label: "Models" },
  { value: "model_effort", label: "Model + effort" },
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

/** The equal-length window immediately before the selected one, for period-over-period deltas. */
export function usagePreviousRangeQuery(range: UsageRangeKey, anchor: Date) {
  const days = Number(range);
  const end = anchor.getTime() - days * 86_400_000;
  return {
    start: new Date(end - days * 86_400_000).toISOString(),
    end: new Date(end).toISOString()
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
  usersById?: Map<string, UsageLookupUser>;
  apiKeysById?: Map<string, UsageLookupApiKey>;
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

export type SeriesPoint = { label: string; value: number };

/** Per-bucket series over whole-window totals; the same regardless of the grouping dimension. */
export function usagePointSeries(timeseries: UsageTimeseries, value: (totals: UsageGroup) => number): SeriesPoint[] {
  return timeseries.points.map((point) => ({
    label: bucketLabel(point.ts, timeseries.interval),
    value: value(point.totals)
  }));
}

export function totalsPointSeries(timeseries: UsageTimeseries, metric: UsageMetric): SeriesPoint[] {
  return usagePointSeries(timeseries, (totals) => metricValue(totals, metric));
}

/**
 * Share of prompt tokens read from cache; null when the window carried no
 * input tokens. Normalized convention: inputTokens is the TOTAL prompt input
 * with cache reads/writes as subsets, so writes count as misses on their own.
 */
export function cacheHitRate(group: UsageGroup | null | undefined): number | null {
  if (!group) return null;
  if (group.usage.inputTokens <= 0) return null;
  return group.usage.cachedInputTokens / group.usage.inputTokens;
}

/** Per-bucket cache hit rate scaled to 0-100 so mini bar heights read as percentages. */
export function cacheHitPointSeries(timeseries: UsageTimeseries): SeriesPoint[] {
  return usagePointSeries(timeseries, (totals) => (cacheHitRate(totals) ?? 0) * 100);
}

/** Relative change in percent; undefined (delta hidden) when there is no prior signal. */
export function percentDelta(current: number, previous: number | null | undefined): number | undefined {
  if (previous === null || previous === undefined || previous <= 0) return undefined;
  return ((current - previous) / previous) * 100;
}

/** Whether any group carries priced spend; spend widgets fall back to tokens when not. */
export function hasPricedSpend(groups: UsageGroup[] | undefined) {
  return (groups ?? []).some((row) => row.cost.selected > 0);
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
