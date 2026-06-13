// The prompt-cache TTL windows the whole token-cost program pivots on. The
// 5-minute default is the provider's ephemeral cache TTL; the 1-hour window is
// what the adaptive cache_control upgrade can buy (see adapters.ts). Cache-bust
// detection, idle-gap bucketing, and active-session warm-window counts all key
// off these so they cannot silently disagree.
export const CACHE_TTL_DEFAULT_MS = 5 * 60 * 1000;
export const CACHE_TTL_UPGRADED_MS = 60 * 60 * 1000;
export const CACHE_TTL_POLICY_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
