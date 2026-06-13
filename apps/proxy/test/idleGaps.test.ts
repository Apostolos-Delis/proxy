import { describe, expect, it } from "vitest";

import { aggregateIdleGaps, type IdleGapRequestRow } from "../src/persistence/idleGaps.js";

function row(sessionId: string, at: string, overrides: Partial<IdleGapRequestRow> = {}) {
  return { sessionId, createdAt: new Date(at), ...overrides };
}

describe("aggregateIdleGaps", () => {
  it("buckets consecutive gaps within sessions", () => {
    const report = aggregateIdleGaps(
      [
        row("s1", "2026-06-08T12:00:00Z"),
        row("s1", "2026-06-08T12:00:30Z"), // 30s
        row("s1", "2026-06-08T12:03:30Z"), // 3m
        row("s1", "2026-06-08T12:13:30Z", { provider: "anthropic", cacheCreationInputTokens: 120_000 }), // 10m
        row("s2", "2026-06-08T13:00:00Z"),
        row("s2", "2026-06-08T15:00:00Z", { provider: "anthropic", cacheCreationInputTokens: 500_000 }) // 2h
      ],
      false
    );

    const counts = Object.fromEntries(report.buckets.map((bucket) => [bucket.key, bucket.count]));
    expect(counts).toEqual({ lt_1m: 1, "1m_5m": 1, "5m_15m": 1, "15m_60m": 0, gt_60m: 1 });
    expect(report.totalGaps).toBe(4);
    expect(report.overTtl).toBe(2);
    expect(report.recoverableByOneHourTtl).toBe(1);
    expect(report.estimatedRecoverableCacheReadTokens).toBe(120_000);
    expect(report.recommendedTtlUpgrade).toBe(true);
    expect(report.sessionsScanned).toBe(2);
    expect(report.sampledRequests).toBe(6);
    expect(report.sampleWindowStart).toBe("2026-06-08T12:00:00.000Z");
    expect(report.sampleWindowEnd).toBe("2026-06-08T15:00:00.000Z");
    expect(report.sampled).toBe(false);
  });

  it("handles unordered input and single-request sessions", () => {
    const report = aggregateIdleGaps(
      [
        row("s1", "2026-06-08T12:10:00Z"),
        row("s1", "2026-06-08T12:00:00Z"),
        row("solo", "2026-06-08T12:00:00Z")
      ],
      true
    );
    expect(report.totalGaps).toBe(1);
    expect(report.overTtl).toBe(1);
    expect(report.estimatedRecoverableCacheReadTokens).toBe(0);
    expect(report.recommendedTtlUpgrade).toBe(false);
    expect(report.sampled).toBe(true);
  });

  it("reports an honest empty state", () => {
    const report = aggregateIdleGaps([], false);
    expect(report.totalGaps).toBe(0);
    expect(report.buckets.every((bucket) => bucket.count === 0)).toBe(true);
    expect(report.sampledRequests).toBe(0);
    expect(report.sampleWindowStart).toBeNull();
    expect(report.sampleWindowEnd).toBeNull();
  });
});
