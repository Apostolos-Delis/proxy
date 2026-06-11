// The prompt-cache TTL windows the whole token-cost program pivots on. The
// 5-minute default is the provider's ephemeral cache TTL; the 1-hour window is
// what the per-org cache_control upgrade buys (see adapters.ts). Cache-bust
// detection, idle-gap bucketing, and the prompt-edit blast-radius count all
// key off these — keep them in one place so they can never silently disagree.
export const CACHE_TTL_DEFAULT_MS = 5 * 60 * 1000;
export const CACHE_TTL_UPGRADED_MS = 60 * 60 * 1000;
