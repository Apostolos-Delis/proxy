// Distribution of idle gaps between consecutive requests inside a session.
// Sizes the cache TTL policy win: gaps past the ~5 minute default TTL force a
// full prefix rewrite on the next request; gaps under an hour are recoverable
// by upgrading breakpoints to the 1-hour TTL.

import { CACHE_TTL_DEFAULT_MS, CACHE_TTL_UPGRADED_MS } from "../cacheWindows.js";

export type IdleGapRequestRow = {
  sessionId: string;
  createdAt: Date;
};

// Newest-first sample cap applied by the caller's query.
export const IDLE_GAP_SAMPLE_CAP = 20_000;

const GAP_BUCKETS = [
  { key: "lt_1m", label: "< 1m", maxMs: 60 * 1000 },
  { key: "1m_5m", label: "1–5m", maxMs: CACHE_TTL_DEFAULT_MS },
  { key: "5m_15m", label: "5–15m", maxMs: 15 * 60 * 1000 },
  { key: "15m_60m", label: "15–60m", maxMs: CACHE_TTL_UPGRADED_MS },
  { key: "gt_60m", label: "> 60m", maxMs: Number.POSITIVE_INFINITY }
] as const;

export function aggregateIdleGaps(rows: IdleGapRequestRow[], sampled: boolean) {
  const bySession = new Map<string, number[]>();
  for (const row of rows) {
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row.createdAt.getTime());
    bySession.set(row.sessionId, list);
  }

  const counts = new Map<string, number>(GAP_BUCKETS.map((bucket) => [bucket.key, 0]));
  let totalGaps = 0;
  let overTtl = 0;
  let recoverableByOneHourTtl = 0;

  for (const times of bySession.values()) {
    times.sort((left, right) => left - right);
    for (let index = 1; index < times.length; index += 1) {
      const gapMs = times[index] - times[index - 1];
      totalGaps += 1;
      if (gapMs >= CACHE_TTL_DEFAULT_MS) overTtl += 1;
      if (gapMs >= CACHE_TTL_DEFAULT_MS && gapMs < CACHE_TTL_UPGRADED_MS) recoverableByOneHourTtl += 1;
      const bucket = GAP_BUCKETS.find((candidate) => gapMs < candidate.maxMs) ?? GAP_BUCKETS[GAP_BUCKETS.length - 1];
      counts.set(bucket.key, (counts.get(bucket.key) ?? 0) + 1);
    }
  }

  return {
    buckets: GAP_BUCKETS.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      count: counts.get(bucket.key) ?? 0
    })),
    totalGaps,
    overTtl,
    recoverableByOneHourTtl,
    sessionsScanned: bySession.size,
    sampled
  };
}
