type TokenTotals = {
  totalTokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
};

export type RequestSummary = {
  createdAt?: string | null;
  selectedCost: number;
  baselineCost: number;
  usage: TokenTotals;
};

export type UsageGroup = {
  key: string;
  usage: TokenTotals;
  cost: { selected: number; baseline?: number; savings?: number };
  latency?: { averageMs: number | null; p95Ms: number | null };
};

export type UserRef = {
  userId: string;
  name?: string | null;
  email?: string | null;
};

export type ChartPoint = {
  label: string;
  value: number;
};

export type ModelUsageRow = {
  label: string;
  tokens: number;
  spend: number;
  color: string;
};

type SeriesMetric = "cost" | "baseline" | "tokens" | "requests";

const colors = ["#14b8a6", "#38bdf8", "#34d399", "#5eead4", "#22d3ee", "#60a5fa", "#2dd4bf", "#0ea5e9"];

export function seriesFromRequests(requests: RequestSummary[], metric: SeriesMetric, days = 30): ChartPoint[] {
  const withDates = requests.filter((request) => request.createdAt);
  if (withDates.length === 0) return [];

  const latest = Math.max(...withDates.map((request) => timestamp(request.createdAt)));
  if (days === 1) return hourlySeries(withDates, metric, latest);

  const end = startOfDay(new Date(latest));
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));

  const buckets = new Map<string, number>();
  for (let index = 0; index < days; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    buckets.set(dayKey(date), 0);
  }

  for (const request of withDates) {
    const createdAt = new Date(request.createdAt ?? "");
    const key = dayKey(createdAt);
    if (!buckets.has(key)) continue;
    buckets.set(key, (buckets.get(key) ?? 0) + requestMetric(request, metric));
  }

  return [...buckets.entries()].map(([key, value]) => ({
    label: new Date(`${key}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    value
  }));
}

function hourlySeries(requests: RequestSummary[], metric: SeriesMetric, latest: number): ChartPoint[] {
  const end = startOfHour(new Date(latest));
  const start = new Date(end);
  start.setHours(start.getHours() - 23);

  const buckets = new Map<number, number>();
  for (let index = 0; index < 24; index += 1) {
    const date = new Date(start);
    date.setHours(start.getHours() + index);
    buckets.set(date.getTime(), 0);
  }

  for (const request of requests) {
    const key = startOfHour(new Date(request.createdAt ?? "")).getTime();
    if (!buckets.has(key)) continue;
    buckets.set(key, (buckets.get(key) ?? 0) + requestMetric(request, metric));
  }

  return [...buckets.entries()].map(([key, value]) => ({
    label: new Date(key).toLocaleTimeString("en-US", { hour: "numeric" }),
    value
  }));
}

/** Percent change between the first and second half of a series; undefined when the prior half is empty. */
export function periodDelta(series: ChartPoint[]): number | undefined {
  const half = Math.floor(series.length / 2);
  if (half === 0) return undefined;
  const previous = series.slice(0, half).reduce((sum, point) => sum + point.value, 0);
  const current = series.slice(series.length - half).reduce((sum, point) => sum + point.value, 0);
  if (previous <= 0) return undefined;
  return ((current - previous) / previous) * 100;
}

export function modelRowsFromUsage(rows: UsageGroup[]): ModelUsageRow[] {
  return rows
    .filter((row) => row.usage.totalTokens > 0)
    .sort((left, right) => right.usage.totalTokens - left.usage.totalTokens)
    .map((row, index) => ({
      label: row.key,
      tokens: row.usage.totalTokens,
      spend: row.cost.selected,
      color: colors[index % colors.length]
    }));
}

export function displayUser(user: UserRef) {
  return user.name ?? user.email ?? user.userId;
}

function requestMetric(request: RequestSummary, metric: SeriesMetric) {
  if (metric === "cost") return request.selectedCost;
  if (metric === "baseline") return request.baselineCost;
  if (metric === "tokens") return request.usage.totalTokens;
  return 1;
}

function timestamp(value?: string | null) {
  return value ? new Date(value).getTime() : 0;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfHour(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours());
}

function dayKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
