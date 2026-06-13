// Distribution of idle gaps between consecutive requests inside a session.
// Sizes the cache TTL policy win: gaps past the ~5 minute default TTL force a
// full prefix rewrite on the next request; gaps under an hour are recoverable
// by upgrading breakpoints to the 1-hour TTL.

import { CACHE_TTL_DEFAULT_MS, CACHE_TTL_UPGRADED_MS } from "../cacheWindows.js";

export type IdleGapRequestRow = {
  sessionId: string;
  requestId?: string;
  provider?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  createdAt: Date;
};

// Newest-first sample cap applied by the caller's query.
export const IDLE_GAP_SAMPLE_CAP = 20_000;
export const CACHE_TTL_RECOMMENDATION_TOKEN_THRESHOLD = 100_000;

const GAP_BUCKETS = [
  { key: "lt_1m", label: "< 1m", maxMs: 60 * 1000 },
  { key: "1m_5m", label: "1–5m", maxMs: CACHE_TTL_DEFAULT_MS },
  { key: "5m_15m", label: "5–15m", maxMs: 15 * 60 * 1000 },
  { key: "15m_60m", label: "15–60m", maxMs: CACHE_TTL_UPGRADED_MS },
  { key: "gt_60m", label: "> 60m", maxMs: Number.POSITIVE_INFINITY }
] as const;

export function aggregateIdleGaps(rows: IdleGapRequestRow[], sampled: boolean) {
  const bySession = new Map<string, Map<string, IdleGapRequestRow>>();
  let fallbackId = 0;
  for (const row of rows) {
    const session = bySession.get(row.sessionId) ?? new Map<string, IdleGapRequestRow>();
    const requestKey = row.requestId ?? `row_${fallbackId}`;
    fallbackId += 1;
    const existing = session.get(requestKey);
    if (!existing || existing.createdAt.getTime() < row.createdAt.getTime()) {
      session.set(requestKey, row);
    }
    bySession.set(row.sessionId, session);
  }

  const counts = new Map<string, number>(GAP_BUCKETS.map((bucket) => [bucket.key, 0]));
  let totalGaps = 0;
  let overTtl = 0;
  let recoverableByOneHourTtl = 0;
  let estimatedRecoverableCacheReadTokens = 0;
  const sampledRows = [...bySession.values()].flatMap((session) => [...session.values()]);
  const sampleTimes = sampledRows.map((row) => row.createdAt.getTime());

  for (const session of bySession.values()) {
    const sessionRows = [...session.values()].sort((left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      (left.requestId ?? "").localeCompare(right.requestId ?? "")
    );
    for (let index = 1; index < sessionRows.length; index += 1) {
      const current = sessionRows[index];
      const gapMs = current.createdAt.getTime() - sessionRows[index - 1].createdAt.getTime();
      totalGaps += 1;
      if (gapMs >= CACHE_TTL_DEFAULT_MS) overTtl += 1;
      if (gapMs >= CACHE_TTL_DEFAULT_MS && gapMs < CACHE_TTL_UPGRADED_MS) {
        recoverableByOneHourTtl += 1;
        estimatedRecoverableCacheReadTokens += rebuiltContextTokens(current);
      }
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
    estimatedRecoverableCacheReadTokens,
    recommendationThresholdTokens: CACHE_TTL_RECOMMENDATION_TOKEN_THRESHOLD,
    recommendedTtlUpgrade: estimatedRecoverableCacheReadTokens > CACHE_TTL_RECOMMENDATION_TOKEN_THRESHOLD,
    sessionsScanned: bySession.size,
    sampledRequests: sampledRows.length,
    sampleWindowStart: sampleTimes.length === 0 ? null : new Date(Math.min(...sampleTimes)).toISOString(),
    sampleWindowEnd: sampleTimes.length === 0 ? null : new Date(Math.max(...sampleTimes)).toISOString(),
    sampled
  };
}

function rebuiltContextTokens(row: IdleGapRequestRow) {
  const inputTokens = row.inputTokens ?? 0;
  const cachedInputTokens = row.cachedInputTokens ?? 0;
  const cacheCreationInputTokens = row.cacheCreationInputTokens ?? 0;
  if (row.provider === "anthropic") return cacheCreationInputTokens;
  if (row.provider === "openai") return Math.max(0, inputTokens - cachedInputTokens);
  return Math.max(cacheCreationInputTokens, inputTokens - cachedInputTokens);
}
