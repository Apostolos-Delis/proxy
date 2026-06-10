import type { RequestSummary, UsageGroup, UserSummary } from "./api";

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

export type UserUsageRow = {
  id: string;
  name: string;
  email?: string;
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

export function modelRowsFromUsage(rows: UsageGroup[]): ModelUsageRow[] {
  return rows.map((row, index) => ({
    label: row.key,
    tokens: row.usage.totalTokens,
    spend: row.cost.selected,
    color: colors[index % colors.length]
  }));
}

export function topUsersFromUsage(rows: UsageGroup[], usersById: Map<string, UserSummary>): UserUsageRow[] {
  return rows.map((row, index) => {
    const user = usersById.get(row.key);
    return {
      id: row.key,
      name: user ? displayUser(user) : row.key,
      email: user?.email,
      tokens: row.usage.totalTokens,
      spend: row.cost.selected,
      color: colors[index % colors.length]
    };
  });
}

export function displayUser(user: Pick<UserSummary, "userId" | "name" | "email">) {
  return user.name ?? user.email ?? user.userId;
}

function requestMetric(request: RequestSummary, metric: SeriesMetric) {
  if (metric === "cost") return request.selectedCost;
  if (metric === "baseline") return request.baselineCost;
  if (metric === "tokens") return request.usage.totalTokens;
  return 1;
}

function timestamp(value?: string) {
  return value ? new Date(value).getTime() : 0;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
