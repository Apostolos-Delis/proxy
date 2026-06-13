# Token Cost Reduction

## Summary

Prompt-proxy sits in the only position that can see and shape every token an org sends to a provider. This doc lays out a ranked program for reducing token cost across the board: attribution first, cache economics second, request-body compression third, with output-side and experimental levers behind them.

The thesis, in one line: **most of the win is not in clever compression — it is in cache hygiene and in shrinking content before it is ever cached.** Compression that ignores prompt caching makes bills go up, not down.

## Why caching dictates the design

Verified Anthropic pricing mechanics (OpenAI's caching is automatic-prefix but the same shape applies):

```text
cache read    0.1x   base input price
cache write   1.25x  (5-minute TTL)  /  2x (1-hour TTL)
output        5x     base input price (Opus $5/$25, Sonnet $3/$15, Haiku $1/$5 per MTok)
```

Prompt caching is an exact byte-prefix match. The harness resends the entire conversation on every agentic-loop iteration, so history is re-billed at 0.1x as long as the prefix is byte-stable — and re-billed at full-plus-write price the moment any earlier byte changes.

Three rules fall out of this:

1. **Compress at the frontier, never retroactively.** A tool result entering at turn 5 is cache-written once (1.25x) and then re-read at 0.1x on every subsequent request in the session. Shrinking it before first cache write compounds for the rest of the session. Rewriting it after it is cached busts the prefix and re-bills everything downstream at ~12x the read price.
2. **A cache bust is the most expensive single event in the system.** One mid-session model switch, one byte of drift in the injected org system prompt, one reordered tool schema, one >5-minute idle gap past the TTL — and a 150K-token context re-bills at full price instead of 0.1x. One avoided bust is worth more than dozens of compressed tool results.
3. **Output tokens are 5x input.** Per-route effort/verbosity control (which routing configs already do) is a larger per-token lever than any input-side compression.

A fourth, non-negotiable invariant for anything that mutates request bodies: **transforms must be deterministic** — a pure function of the block content. The same tool result reappears verbatim in every subsequent request of the session; if the transform ever produces different bytes for the same input, it invalidates the cache from that point forward on every turn.

## What the proxy already has

The infrastructure for most of this exists:

```text
usage capture        SseObserver copies the provider usage object verbatim
                     (incl. cache_read_input_tokens / cache_creation_input_tokens)
                     into usage.recorded events            sseObserver.ts, proxy.ts
body rewrite seam    rewriteSurfaceRequest / rewriteTokenCountRequest already
                     structuredClone + mutate every body   adapters.ts
session pinning      SessionRouteStore pins route + provider settings per session
                     to keep provider caches warm          policy.ts
per-org config       routing configs resolved per request  persistence/routingConfig.ts
event pipeline       append-only events -> projections -> console
tool visibility      hasTools/toolCount features; tool name/count artifacts
```

What is missing is (a) decomposition of *where* tokens go, (b) cache-aware policy, and (c) any body transform beyond model swap + system prompt injection.

## Workstream 1 — Token attribution profiler (build first)

You cannot rank the other levers without this, and it is pure read-path work: zero request-mutation risk.

Per request, decompose the parsed body into named buckets and emit a `tokens.attributed` event (estimates via `roughTokenEstimate` are fine; exactness is not the point):

```text
system_prompt_chars        (incl. proxy-injected org prompt, separately)
tool_schema_chars          per tool name; mcp__* grouped per server
history_chars              prior turns being resent
new_tool_result_chars      per tool name — the frontier, the compressible mass
latest_user_chars
```

Join against `usage.recorded` per session to compute:

```text
cache hit rate           cache_read / (cache_read + cache_creation + input)
cache bust events        cache_read collapses to ~0 mid-session; attribute cause
$ per session            priced via model catalog
output tokens per route  feeds Workstream 5
top offenders            by tool name, MCP server, org
```

Console deliverable: a "where do tokens go" view per org — ranked named offenders, cache hit rate trend, estimated $ waste per category. Every subsequent workstream gets justified (or killed) by this data.

## Workstream 2 — Cache hygiene

Likely the largest savings per line of code, and invisible to every client-side tool (RTK cannot touch any of this).

**2a. Bust detection and attribution.** Alert/surface when a session's `cache_read_input_tokens` collapses mid-session. Known causes to classify: model/route switch (should be eliminated by session pinning), org system prompt edit, `anthropic-beta` header drift, harness restart, TTL expiry on idle gaps. This is a projection over data already collected.

**2b. Adaptive cache TTL policy.** Developer sessions are gappy — any >5-minute pause (reading code, meetings) expires the default cache, and the next request rewrites the entire context at 1.25x. The proxy already rewrites bodies, so it can upgrade harness-set `cache_control` breakpoints to `{ttl: "1h"}` only when recent org/workspace request history shows recoverable 5-minute-to-1-hour idle gaps and the current request has proved it is a large multi-turn session. One-shot, small, and low-reuse requests stay on the default TTL to avoid the 2x write premium.

**2c. Byte-stability of our own injection.** The prepended org system prompt sits at position ~0 of the prefix; active sessions pin the prompt they first used so edits apply to new sessions instead of busting every warm prefix org-wide. Audit `rewriteSurfaceRequest` for any other nondeterminism on the prefix path.

## Workstream 3 — Frontier tool-result compression (RTK, generalized)

The proxy-side equivalent of RTK: shrink `tool_result` blocks in incoming request bodies before they are forwarded — and therefore before they are first cached.

Mechanism (new pass inside `rewriteSurfaceRequest`):

```text
1. Walk messages; build map tool_use_id -> {tool name, input}
   from prior assistant turns' tool_use blocks
   (OpenAI surface: function_call_output matched to function_call by call_id)
2. For each tool_result block above a size threshold (e.g. 2KB),
   apply the deterministic filter registered for that tool
3. Same pass in rewriteTokenCountRequest and in wsProxy.ts
```

Filter targets, in priority order (profiler confirms):

```text
mcp__* results      verbose JSON; deterministic JSON compaction (strip nulls,
                    collapse repeated keys, tabularize uniform object arrays)
Bash output         RTK-style per-command filters keyed on the command string
                    (pytest, git, build logs, linters)
Read results        dedupe identical large results inside a request with a
                    deterministic content-hash marker
generic             cap + head/tail elision with byte-count marker
```

Invariants:

```text
deterministic       pure function of block content — cache preservation depends on it
first-appearance    never touch blocks differently across requests
size threshold      never touch small results; keeps the hot path cheap
preserve markers    cache_control breakpoints on blocks must survive the transform
count_tokens parity /v1/messages/count_tokens must apply the identical transform,
                    or harness context accounting (compaction triggers) skews
escape hatch        per-org / per-tool allowlist to disable filters
measurement         emit compression.recorded {tool, before, after} events
```

Known risk — lossiness: the harness's local transcript keeps the full output while the model sees the filtered version. If a filter drops the line the model later needs, there is no in-turn recovery. Mitigations: conservative filters (structure-preserving, not summarizing), size thresholds, per-tool opt-out, and the profiler showing which filters correlate with retry/failure loops.

Explicit non-goal: **no LLM summarization in the hot path.** It is nondeterministic (cache-fatal) and adds latency. If rule-based filters prove insufficient, the upgrade path is compress-once + content-hash replay store — heavier machinery; only build when data demands it.

## Workstream 4 — MCP tool-schema diet

MCP-heavy sessions ship tens of thousands of schema tokens at position 0 of the prefix, re-read at 0.1x on every request org-wide, and re-written on every cold session. Two approaches:

**4a. Anthropic-native (preferred, experimental):** rewrite the tools array to mark MCP tool definitions `defer_loading: true` and inject the tool search tool. Discovered schemas are *appended*, not swapped, so the cache prefix survives by design. Requires per-harness verification that server-tool blocks round-trip cleanly through the harness transcript — gate behind a per-org flag and canary.

**4b. Usage-driven strip lists (cruder, harness-agnostic):** profiler identifies `mcp__*` tools with zero invocations org-wide over a window; strip their schemas at the proxy, pinned per session (never change the set mid-session — that is a position-0 cache bust), with an org allowlist override. Risk: the model cannot call what it cannot see; only strip on strong zero-usage evidence.

## Workstream 5 — Output-side controls

Output is 5x input. Routing configs already set effort/verbosity/max_tokens per route (`providerSettings`); what is missing is the feedback loop. Profiler reports output tokens per route per org; tune route defaults from data (e.g. classifier-identified `fast` requests run at low effort/verbosity). Cheapest workstream — mostly config + console.

## Workstream 6 — Experiments (after 1–4 prove out)

```text
server-side context editing   Anthropic context_management can prune stale tool
                              results server-side, stateless per request — in
                              principle proxy-injectable. Interacts with caching
                              (each edit shifts the prefix); flag-gated experiment.
exact-body response cache     replay identical requests (CI/automation traffic).
                              Profiler shows whether the hit rate justifies it.
NOT viable: server-side       compaction blocks must be preserved by the client
compaction injection          transcript; a harness behind a transparent proxy
                              will not do that.
NOT viable: retroactive       any rewrite of already-sent history busts the cache
history rewriting             from that point on every subsequent request.
```

## Positioning vs client-side RTK

Client-side RTK is strictly better placed for shell-output compression: it shrinks output before it enters the harness transcript, so model and harness agree on reality, and the user sees what the model sees. The proxy does not compete with that — it complements it:

```text
proxy-only levers    cache TTL policy, bust detection, schema diet,
                     output/effort policy, fleet-wide measurement
proxy coverage       MCP results, file reads, every harness, every developer,
                     zero per-machine install, org-level policy
compose              RTK at the source for shell output; proxy catches the rest
```

The sales pitch writes itself from Workstream 1: show an org its own cache hit rate and named token offenders, then turn on levers one at a time with measured before/after.

## Sequencing

```text
Phase 1  Workstream 1 (profiler)            read-only, zero risk, justifies the rest
Phase 2  Workstream 2 (cache hygiene)       2a projection; 2b first body-mutating
                                            feature, behind per-org flag
Phase 3  Workstream 3 (compression)         MCP JSON filter first, then Bash filters;
                                            per-org flag + per-tool allowlist
Phase 4  Workstreams 4 + 5                  schema diet experiment; output tuning
Phase 5  Workstream 6                       only what Phase 1 data justifies
```

Success metrics, per org: $ per session, cache hit rate, tokens saved by category (from `compression.recorded`), with retry/failure-loop rate watched as the quality regression signal.

## MVP Tickets

1. Emit `tokens.attributed` event per request with body decomposition by bucket and tool name.
2. Add per-session cache hit rate + $ per session projections from `usage.recorded`.
3. Console: per-org "where do tokens go" view with ranked offenders and cache trend.
4. Cache bust detection projection with cause classification; surface in console.
5. Idle-gap distribution report per org (sizes the TTL-policy win).
6. Adaptive per-org `cache_control` TTL upgrade policy in `rewriteSurfaceRequest`, gated to observed recoverable idle gaps and large multi-turn sessions.
7. Org prompt pinning for active sessions; prompt edits apply to new sessions.
8. `tool_use_id -> tool` mapper + transform pass scaffold in `rewriteSurfaceRequest`, `rewriteTokenCountRequest`, and `wsProxy`, with `compression.recorded` events.
9. Deterministic MCP JSON compaction filter, size-thresholded, per-org flag.
10. Deterministic duplicate large tool-result elision.
11. Bash output filters for top profiler-identified commands (pytest, git, build logs).
12. Per-route output-token report; tune route effort/verbosity defaults from it.
13. Spike: `defer_loading` + tool search injection behind a canary flag; verify harness round-trip per surface.
