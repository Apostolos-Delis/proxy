import { describe, expect, it } from "vitest";

import type { UsageGroup, UsageTimeseries } from "./usageData";
import {
  cacheHitPointSeries,
  cacheHitRate,
  hasPricedSpend,
  percentDelta,
  totalsPointSeries,
  usagePreviousRangeQuery,
  usageRangeQuery
} from "./usageAnalytics";

function group(overrides: {
  requestCount?: number;
  cost?: number;
  usage?: Partial<UsageGroup["usage"]>;
} = {}): UsageGroup {
  return {
    key: "total",
    requestCount: overrides.requestCount ?? 0,
    failedRequests: 0,
    retriedRequests: 0,
    failureRate: 0,
    retryRate: 0,
    latency: { averageMs: null, p95Ms: null },
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      ...overrides.usage
    },
    cost: { selected: overrides.cost ?? 0, baseline: 0, savings: 0, classifier: 0 }
  };
}

function timeseries(points: { ts: string; totals: UsageGroup }[]): UsageTimeseries {
  return {
    groupBy: "model",
    interval: "day",
    start: points[0]?.ts ?? "",
    end: points[points.length - 1]?.ts ?? "",
    groups: [],
    points: points.map((point) => ({ ...point, groups: {} }))
  };
}

describe("usagePreviousRangeQuery", () => {
  it("covers the equal-length window ending where the selected one starts", () => {
    const anchor = new Date("2026-06-11T12:00:00.000Z");
    const current = usageRangeQuery("7", anchor);
    const previous = usagePreviousRangeQuery("7", anchor);
    expect(previous.end).toBe(current.start);
    expect(previous.start).toBe("2026-05-28T12:00:00.000Z");
  });
});

describe("totalsPointSeries", () => {
  const series = timeseries([
    { ts: "2026-06-01T00:00:00.000Z", totals: group({ requestCount: 4, cost: 2.5, usage: { totalTokens: 1200 } }) },
    { ts: "2026-06-02T00:00:00.000Z", totals: group({ requestCount: 1, cost: 0.5, usage: { totalTokens: 300 } }) }
  ]);

  it("extracts the selected metric from each bucket's totals", () => {
    expect(totalsPointSeries(series, "cost").map((point) => point.value)).toEqual([2.5, 0.5]);
    expect(totalsPointSeries(series, "tokens").map((point) => point.value)).toEqual([1200, 300]);
    expect(totalsPointSeries(series, "requests").map((point) => point.value)).toEqual([4, 1]);
  });

  it("labels day buckets as UTC dates", () => {
    expect(totalsPointSeries(series, "tokens").map((point) => point.label)).toEqual(["Jun 1", "Jun 2"]);
  });
});

describe("cacheHitRate", () => {
  it("is the cached share of all prompt tokens, counting cache writes as misses", () => {
    // inputTokens is the normalized total: 600 reads + 200 writes + 200 fresh.
    const rate = cacheHitRate(group({ usage: { inputTokens: 1000, cachedInputTokens: 600, cacheCreationInputTokens: 200 } }));
    expect(rate).toBeCloseTo(0.6);
  });

  it("is null without a group or without prompt tokens", () => {
    expect(cacheHitRate(undefined)).toBeNull();
    expect(cacheHitRate(group({ usage: { outputTokens: 500 } }))).toBeNull();
  });

  it("charts bucket rates as 0-100 with empty buckets at zero", () => {
    const series = timeseries([
      { ts: "2026-06-01T00:00:00.000Z", totals: group({ usage: { inputTokens: 100, cachedInputTokens: 75 } }) },
      { ts: "2026-06-02T00:00:00.000Z", totals: group() }
    ]);
    expect(cacheHitPointSeries(series).map((point) => point.value)).toEqual([75, 0]);
  });
});

describe("hasPricedSpend", () => {
  it("is true once any group carries spend", () => {
    expect(hasPricedSpend([group(), group({ cost: 0.01 })])).toBe(true);
  });

  it("is false for unpriced, empty, or missing groups", () => {
    expect(hasPricedSpend([group({ usage: { totalTokens: 500 } })])).toBe(false);
    expect(hasPricedSpend([])).toBe(false);
    expect(hasPricedSpend(undefined)).toBe(false);
  });
});

describe("percentDelta", () => {
  it("is the relative change in percent", () => {
    expect(percentDelta(150, 100)).toBe(50);
    expect(percentDelta(75, 100)).toBe(-25);
  });

  it("is undefined when there is no prior signal", () => {
    expect(percentDelta(150, 0)).toBeUndefined();
    expect(percentDelta(150, undefined)).toBeUndefined();
    expect(percentDelta(150, null)).toBeUndefined();
  });
});
