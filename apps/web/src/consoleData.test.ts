import { describe, expect, it } from "vitest";

import type { RequestSummary, UsageGroup } from "./api";
import { modelRowsFromUsage, periodDelta, seriesFromRequests } from "./consoleData";

function request(createdAt: string, totalTokens: number): RequestSummary {
  return {
    requestId: `req-${createdAt}`,
    routingConfig: null,
    terminalStatus: "completed",
    usage: { inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens },
    selectedCost: 0,
    baselineCost: 0,
    savings: 0,
    createdAt
  };
}

function usageGroup(key: string, totalTokens: number): UsageGroup {
  return {
    key,
    requestCount: 1,
    failedRequests: 0,
    retriedRequests: 0,
    failureRate: 0,
    retryRate: 0,
    latency: { averageMs: null, p95Ms: null },
    usage: { inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens },
    cost: { selected: 0, baseline: 0, savings: 0 }
  };
}

describe("modelRowsFromUsage", () => {
  it("sorts by tokens and drops zero-token rows", () => {
    const rows = modelRowsFromUsage([
      usageGroup("gpt-5.5", 56),
      usageGroup("unknown", 0),
      usageGroup("claude-sonnet-4-6", 132)
    ]);
    expect(rows.map((row) => row.label)).toEqual(["claude-sonnet-4-6", "gpt-5.5"]);
  });
});

describe("seriesFromRequests", () => {
  it("buckets by day with one point per day in range", () => {
    const series = seriesFromRequests(
      [request("2026-06-10T10:00:00", 50), request("2026-06-09T08:00:00", 20)],
      "tokens",
      7
    );
    expect(series).toHaveLength(7);
    expect(series.at(-1)?.value).toBe(50);
    expect(series.at(-2)?.value).toBe(20);
  });

  it("buckets by hour over the last 24 hours when range is one day", () => {
    const series = seriesFromRequests(
      [request("2026-06-10T14:10:00", 30), request("2026-06-10T14:40:00", 12), request("2026-06-10T03:05:00", 7)],
      "tokens",
      1
    );
    expect(series).toHaveLength(24);
    expect(series.at(-1)?.value).toBe(42);
    expect(series.some((point) => point.value === 7)).toBe(true);
  });

  it("returns empty for requests without dates", () => {
    expect(seriesFromRequests([request("", 10)], "tokens", 7)).toEqual([]);
  });
});

describe("periodDelta", () => {
  it("compares the two halves of a series as a percentage", () => {
    const series = [10, 10, 20, 20].map((value, index) => ({ label: `${index}`, value }));
    expect(periodDelta(series)).toBe(100);
  });

  it("is undefined when the prior half has no volume", () => {
    const series = [0, 0, 5, 5].map((value, index) => ({ label: `${index}`, value }));
    expect(periodDelta(series)).toBeUndefined();
  });
});
