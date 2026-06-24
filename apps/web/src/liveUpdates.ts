import type { QueryClient } from "@tanstack/react-query";

import { adminApiBase, bumpGraphQLCacheEpoch } from "./graphql";

// Query-key prefixes refreshed when the proxy reports new traffic. Scoped
// /logs ranges pin their end timestamp at mount so a refetch cannot surface
// new rows — only the "all" range goes live.
const LIVE_QUERY_KEYS = [
  ["requests-page", "all"],
  ["sessions-page"],
  ["session"]
] as const;
const RECONNECT_DELAY_MS = 15_000;

type LiveUpdatesState = {
  active?: EventSource;
  retryTimer?: ReturnType<typeof setTimeout>;
};

type LiveUpdatesGlobal = typeof globalThis & {
  __proxyLiveUpdates?: LiveUpdatesState;
};

const state = ((globalThis as LiveUpdatesGlobal).__proxyLiveUpdates ??= {});

/**
 * Holds one SSE connection to the proxy that emits coalesced invalidation
 * ticks whenever this org/workspace sees traffic. Invalidation refetches
 * mounted queries only; everything else is just marked stale.
 */
export function startLiveUpdates(queryClient: QueryClient) {
  if (state.active) return;
  connect(queryClient);
}

export function stopLiveUpdates() {
  if (state.retryTimer !== undefined) {
    clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
  }
  state.active?.close();
  state.active = undefined;
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
  if (state.retryTimer !== undefined) {
    clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
  }
  const source = new EventSource(`${adminApiBase}/admin/events`, { withCredentials: true });
  state.active = source;
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
    if (state.active !== source) return;
    state.active = undefined;
    if (!queryClient.getQueryData(["me"])) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      if (!state.active) connect(queryClient);
    }, RECONNECT_DELAY_MS);
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(stopLiveUpdates);
}
