import type { QueryClient } from "@tanstack/react-query";

import { apiBase, bumpGraphQLCacheEpoch } from "./graphql";

// Query-key prefixes refreshed when the proxy reports new traffic. Scoped
// /logs ranges pin their end timestamp at mount so a refetch cannot surface
// new rows — only the "all" range goes live.
const LIVE_QUERY_KEYS = [
  ["requests-page", "all"],
  ["sessions-page"],
  ["session"]
] as const;
const RECONNECT_DELAY_MS = 15_000;

let active: EventSource | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Holds one SSE connection to the proxy that emits coalesced invalidation
 * ticks whenever this org/workspace sees traffic. Invalidation refetches
 * mounted queries only; everything else is just marked stale.
 */
export function startLiveUpdates(queryClient: QueryClient) {
  if (active) return;
  connect(queryClient);
}

export function stopLiveUpdates() {
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  active?.close();
  active = undefined;
}

// The SSE connection is scoped to the org/workspace it authenticated as, so
// switching either requires a fresh connection.
export function restartLiveUpdates(queryClient: QueryClient) {
  stopLiveUpdates();
  startLiveUpdates(queryClient);
}

function connect(queryClient: QueryClient) {
  // At most one of {active, retryTimer} may exist, or an orphaned timer
  // could resurrect a connection after stopLiveUpdates.
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  const source = new EventSource(`${apiBase}/admin/events`, { withCredentials: true });
  active = source;
  source.onmessage = () => {
    bumpGraphQLCacheEpoch();
    for (const queryKey of LIVE_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey: [...queryKey] });
    }
  };
  source.onerror = () => {
    // CONNECTING means the browser is retrying on its own; CLOSED is fatal
    // (e.g. the session expired) and needs our own slow retry.
    if (source.readyState !== EventSource.CLOSED) return;
    source.close();
    if (active !== source) return;
    active = undefined;
    if (!queryClient.getQueryData(["me"])) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!active) connect(queryClient);
    }, RECONNECT_DELAY_MS);
  };
}
