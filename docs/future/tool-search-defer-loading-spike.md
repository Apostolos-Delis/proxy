# Spike: `defer_loading` + tool search injection (T12)

## Question

Can the proxy transparently rewrite the outbound `tools` array to mark MCP tool
definitions `defer_loading: true` and inject Anthropic's tool search tool, so
that MCP-heavy sessions stop paying tens of thousands of schema tokens at
position 0 of every request — without the harness knowing?

**Conclusion: not transparently. This must stay a flagged, per-harness-verified
canary, not a default. The blocker is the response round-trip, not the request
rewrite.** Findings below; no production code shipped for this ticket by design.

## What tool search does (verified against platform.claude.com, 2026-06)

- You add a tool search tool (`tool_search_tool_regex_20251119` or
  `tool_search_tool_bm25_20251119`) to `tools`, and mark the bulk of tools
  `defer_loading: true`. At least one tool must be non-deferred (else 400).
- Deferred tools are **not** included in the system-prompt prefix. When Claude
  searches and discovers one, the API appends a `tool_reference` block inline in
  the conversation and expands it to the full definition before the model sees
  it. **The prefix is untouched, so prompt caching is preserved by design** —
  this is the property that makes it attractive versus a static schema strip.
- Model support includes Fable 5, Opus 4.x, Sonnet 4.0+, Haiku 4.5+. Up to
  10,000 tools; returns 3–5 per search. Reduces definition tokens ~85% on
  multi-server MCP setups.

## Why the proxy cannot do this transparently

The request mutation is the easy half and has one canonical home:
`GatewayRequestLifecycle.prepareResolvedBody`. That stage translates and clones
the provider-bound request through `gatewayRequestBody`, applies the gateway
system prompt, and computes the prompt-cache plan. A future tool-search transform
would run after `gatewayRequestBody` and before prompt-cache planning, so it sees
the egress dialect and remains shared by HTTP and WebSocket traffic. The generic
HTTP adapter preserves supported dialect headers, including `anthropic-beta`, so
the beta opt-in survives.

The blocker is the **response round-trip**:

1. When Claude searches, the response stream contains new block types —
   `server_tool_use`, `tool_search_tool_result` (carrying `tool_reference`
   blocks), and the eventual `tool_use`. The proxy streams these through
   byte-for-byte; `SseObserver` only observes usage/text and does not buffer or
   rewrite (`proxy.ts:154-160`, `sseObserver.ts`). So the blocks **do** reach
   the harness.
2. On the next turn the harness replays its assistant transcript. For tool
   search to keep working, the harness must **preserve those server-tool blocks
   verbatim and resend them** — the API expands `tool_reference` blocks
   throughout history so discovered tools stay available without re-searching.
3. A harness that was never told about tool search will almost certainly **drop
   or mangle** blocks it does not recognise when reconstructing its message
   history. Claude Code and Codex maintain their own transcript model; they
   round-trip the block shapes they know. There is no guarantee — and good
   reason to doubt — that an unrecognised `tool_search_tool_result` survives
   their serialization intact.

If the blocks do not round-trip cleanly, the failure modes are bad:

- **Cache busting** — the whole point inverted. If the harness re-sends a
  history that no longer matches what the API expanded, the prefix diverges and
  every subsequent turn re-bills at full price.
- **Tool unavailability / 400s** — a `tool_use` for a discovered tool whose
  `tool_reference` was dropped from history, or a `tool_reference` with no
  matching `defer_loading` definition in the rewritten `tools` array, is a hard
  error (`"Tool reference 'x' has no corresponding tool definition"`).
- **Silent capability loss** — the model searches, the harness swallows the
  result, the model never gets the tool, and the task quietly degrades.

This is the same class of constraint that already rules out transparent
server-side compaction injection (see `token-cost-reduction.md` §6): anything
that puts blocks in the response which the client must persist is not
transparently injectable behind a proxy.

## A second, structural problem: the proxy rewrites, the harness owns `tools`

`defer_loading` and the search tool must be byte-stable across the whole
session or they bust the cache themselves (tools render at prefix position 0).
But the harness owns the `tools` array and can add/remove tools mid-session
(e.g. an MCP server reconnects, or Claude Code toggles a tool). The proxy would
have to deterministically reproduce the exact same deferral decision on every
turn from the incoming tools alone — feasible (key on tool name), but it means
the proxy's rewrite must be a pure function of the incoming tool set, and any
drift in how the harness orders or names tools turns into a position-0 bust.

## Recommendation

1. **Do not ship as a default or even a transparent per-org flag.** The risk is
   a silent cache-bust or capability regression that looks like "the proxy made
   things worse."
2. **Gate behind an explicit per-org canary flag** (same `organization_settings`
   JSONB pattern as `cacheTtlUpgrade` / `toolResultCompression`), defaulted off,
   and document it as experimental.
3. **Verify the round-trip per harness before enabling**, with a concrete test
   harness:
   - Capture a real two-turn session where turn 1 triggers a tool search.
   - Diff turn 2's inbound `messages` against turn 1's outbound response: did the
     `server_tool_use` / `tool_search_tool_result` blocks come back verbatim?
   - Confirm `cache_read_input_tokens` stays high on turn 2 (no bust).
   - Confirm the discovered tool is actually callable on turn 2 without a 400.
   Only a harness that passes all four is a candidate.
4. **Prefer the native mechanism over the usage-driven schema strip** (the
   `token-cost-reduction.md` §4b fallback) *only if* the round-trip verifies —
   native preserves the cache; the strip pins a tool set per session and risks
   hiding a tool the model needs. If no harness round-trips cleanly, the
   usage-driven strip remains the safer (if cruder) lever.

## Where the code would go, when justified

- Request preparation: add one egress-dialect transform inside
  `GatewayRequestLifecycle.prepareResolvedBody`, immediately after
  `gatewayRequestBody`, to inject the search tool and set `defer_loading` on
  `mcp__*` tools. Resolve its per-organization flag with the other lifecycle
  policy settings; do not add separate HTTP and WebSocket implementations.
- Determinism: the deferral decision must be a pure function of the incoming
  `tools` (key on tool name; never on request-time state).
- Measurement: reuse the `tokens.attributed` tool-schema bucket (T1) to show
  schema-token reduction per org before/after.

No such code is included in this ticket — the spike's deliverable is this
go/no-go analysis, and the answer is "no-go until a harness round-trip is
proven."
