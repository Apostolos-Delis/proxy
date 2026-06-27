# Provider Prompt Caching Expansion

## Summary

Proxy already captures cache-read/cache-write usage, prices cached tokens separately, detects cache busts, attributes token mass by request bucket, pins session routes, pins org system prompts, and has Anthropic-only request transforms for automatic caching and adaptive 1-hour TTL upgrades.

What it does not yet have is a provider-agnostic prompt-caching layer like the Deep Agents approach: one policy surface that can choose the best available cache controls for each provider, preserve prompt-cache locality across translations and route changes, and report whether those controls actually saved money.

This document scopes the path from today's Anthropic-specific behavior to a provider-capability-based caching system. It complements [Token Cost Reduction](token-cost-reduction.md), which covers the broader attribution, cache hygiene, compression, schema diet, and output-control program.

## Current State

Implemented:

- Anthropic Messages can inject top-level `cache_control: { type: "ephemeral" }` for multi-turn requests that do not already carry any cache markers.
- Anthropic Messages can upgrade eligible ephemeral cache markers to `ttl: "1h"` when org history shows recoverable idle gaps and the current request has a large cacheable prefix.
- Native OpenAI rewrites preserve `prompt_cache_key` when clients send it; translations that cannot round-trip the field drop it. Codex/opencode session detection can use inbound values before forwarding.
- OpenAI `prompt_cache_retention` is currently stripped by request rewrites.
- Usage normalization records total input, cached input, cache-creation input, output, reasoning, and total tokens across OpenAI and Anthropic wire shapes.
- Cache-bust detection reports likely TTL expiry, model switch, provider switch, or unknown causes from usage-ledger rows.
- Token attribution emits `tokens.attributed` with system prompt, org prompt, tool schemas, history, new tool results, latest user text, and per-tool breakdowns.
- The console has a Caching view backed by token attribution, cache-bust, cache-savings, and usage analytics queries.

Known drift to fix first:

- The settings page says OpenAI requests always get 24-hour prompt-cache retention, but the runtime deletes `prompt_cache_retention` and tests assert it is not forwarded. The product copy or the runtime needs to change before adding more controls.

## Goals

- Provide one internal caching policy model that can target Anthropic, OpenAI, and future providers without scattering provider-specific branches across request rewrites, usage normalization, settings, and docs.
- Preserve provider prompt-cache hits by keeping the static prefix stable across route decisions, translations, compression, org prompt edits, and config changes.
- Add provider controls only when they are measurable, safe for the selected provider/dialect, and compatible with the active harness.
- Make cache effectiveness visible per org, workspace, provider, model, route, API key, session, and cache key.
- Keep request mutation deterministic. Any transform that touches cacheable bytes must be a stable function of request content and pinned session state.

## Non-Goals

- No LLM summarization in the request path. It is nondeterministic, adds latency, and can bust caches.
- No transparent server-side conversation compaction unless the harness stores the resulting compacted transcript. A proxy-only compaction that the client never sees is not durable.
- No provider feature emulation. If a provider does not support explicit breakpoints, TTLs, prewarm, or routing keys, Proxy should not pretend it does.
- No route fallback that silently sacrifices provider-owned state or known warm caches. Stateful OpenAI Responses continuations still fail closed when the pinned provider is unavailable.

## Design Principles

1. Provider controls live at the selected provider edge.
   The shared router should decide intent; provider/dialect transforms should map that intent to wire fields.

2. Measure before mutating.
   New controls should start in observe-only mode where possible, using existing cache-hit, cache-bust, and token-attribution data to estimate impact.

3. Preserve client intent.
   If the harness already sent explicit cache markers or a cache key, Proxy should not override them unless an org policy explicitly owns that behavior and tests prove the harness tolerates it.

4. Keep prefix bytes stable.
   Tool order, system prompts, compression output, translated request shape, and cache marker placement must remain stable for a session once the first cacheable turn has been sent.

5. Normalize, then price.
   Provider-specific usage fields should normalize into the existing `cachedInputTokens` and `cacheCreationInputTokens` convention before rollups, pricing, metrics, and console views.

6. Fail closed on unsupported controls.
   A selected target that cannot preserve required state or cache markers should be skipped during route planning, not rewritten into a best-effort approximation.

## Proposed Architecture

### Provider caching capabilities

Add a provider capability model near provider registry/catalog data:

```ts
type ProviderCachingCapabilities = {
  implicitPrefixCaching: boolean;
  explicitBreakpoints: boolean;
  supportedTtls: Array<"5m" | "1h" | "24h">;
  cacheKeyField?: "prompt_cache_key" | "routing_key";
  retentionField?: "prompt_cache_retention";
  prewarm: boolean;
  usageShape: "openai" | "anthropic" | "provider_specific";
};
```

The exact fields should be verified against current provider docs during implementation. The important part is that request policy asks "what can this selected target do?" instead of hard-coding "Anthropic does X, OpenAI does Y" in every caller.

### Canonical prompt-cache plan

After route selection and before provider rewrite, compute a canonical plan:

```ts
type PromptCachePlan = {
  mode: "off" | "observe" | "implicit" | "explicit";
  provider: string;
  dialect: string;
  cacheKey?: string;
  retention?: "5m" | "1h" | "24h";
  breakpointStrategy?: "preserve_client" | "top_level_auto" | "static_prefix";
  appliedControls: string[];
  skippedControls: Array<{ control: string; reason: string }>;
};
```

Inputs:

- selected provider deployment and dialect
- provider caching capabilities
- org settings
- route decision and session pin state
- harness profile
- request surface and transport
- token attribution estimates
- recent cache-hit/cache-bust/idle-gap history

Outputs:

- provider rewrite options
- event payload for `prompt_cache.plan_applied`
- metrics labels for cache-control decisions
- route-plan metadata for debugging skipped targets

### Provider-edge application

Move caching transforms into a dedicated provider-edge stage:

```text
client body
  -> route context
  -> route decision / session pin
  -> tool-result compression
  -> translation if needed
  -> prompt-cache plan
  -> provider/dialect request rewrite
  -> provider forward
```

The provider-edge stage owns:

- adding or preserving cache keys
- adding explicit breakpoints when supported
- upgrading TTLs when policy allows it
- stripping unsupported fields from providers that reject them
- recording why a control was skipped

This keeps route handlers thin and prevents cache behavior from being split between `server.ts`, `wsProxy.ts`, `adapters.ts`, translators, and settings UI.

## Workstreams

### 0. Align current behavior and docs

- Decide whether OpenAI `prompt_cache_retention` should be supported.
- If no: update the settings-page copy and any docs that claim OpenAI retention is always applied.
- If yes: stop deleting the field, add policy/settings, add OpenAI Responses and Chat tests, and verify current OpenAI API behavior before shipping.
- Add a short current-state section to the user guide so operators know which controls are Anthropic-only.

### 1. Capability registry and observe-only plan

- Add provider caching capabilities to registry/catalog output.
- Add `PromptCachePlan` computation with no request mutation.
- Emit `prompt_cache.plan_applied` events with skipped-control reasons.
- Surface plan counts in the Caching page: provider, model, mode, skipped reason.
- Add golden tests for plan computation across OpenAI Responses, OpenAI Chat, Anthropic Messages, and translated requests.

Acceptance criteria:

- Existing request bodies are byte-identical with the feature off.
- Every provider attempt has a cache plan in persisted debug data or an explicit "not planned" reason.
- The console can show which controls would have applied without changing traffic.

### 2. Anthropic explicit breakpoint v2

- Move existing `automaticCaching` and `cacheTtlUpgrade` logic behind `PromptCachePlan`.
- Preserve all current tests for top-level automatic caching and TTL upgrades.
- Add plan-level tests for:
  - client-sent breakpoints
  - nested tool-result breakpoints
  - translated Anthropic targets
  - count-tokens parity
  - disabled org setting
  - small or one-shot requests
- Consider a `static_prefix` breakpoint strategy for tool schemas plus system blocks, gated by provider limits and harness compatibility.

Acceptance criteria:

- No behavior change for existing Anthropic settings unless the new strategy is explicitly enabled.
- TTL ordering remains valid.
- Replayed history remains byte-stable across turns.

### 3. OpenAI implicit-prefix optimization

- Treat OpenAI as an implicit-prefix provider unless verified docs support additional controls.
- Preserve client `prompt_cache_key` and use it as session identity where available.
- Consider deriving a provider routing/cache key only when the harness did not send one and the provider supports it.
- Keep org prompt pinning, session route pinning, compression determinism, and tool-order stability as the primary OpenAI cache levers.
- Add usage analytics by `prompt_cache_key` or derived session key where privacy rules allow it.

Acceptance criteria:

- Proxy does not add undocumented OpenAI cache fields.
- OpenAI cache-read usage remains normalized from `input_tokens_details.cached_tokens` / `prompt_tokens_details.cached_tokens`.
- Caching page can compare OpenAI hit rate by model, route, and session/key.

### 4. Third-provider adapter pattern

- Add one additional provider family only after the provider architecture can represent non-OpenAI/non-Anthropic capabilities without schema churn.
- Start with observe-only cache plans and usage normalization fixtures.
- Add provider-specific request rewrite tests before enabling mutation.
- Treat unsupported explicit breakpoints or TTLs as skipped controls, not errors, unless the org policy requires them.

Acceptance criteria:

- New provider support requires adding capabilities and one provider-edge mapper, not changing shared routing logic.
- Usage ledger still stores normalized cache-read/cache-write fields.
- Caching page works without provider-specific UI branches.

### 5. Cache prewarm experiment

- Add only for providers with a real prewarm API or documented equivalent.
- Trigger candidates:
  - route config publish
  - known long-running session resume
  - workspace bootstrap with stable tool schema set
- Require idempotency keys, spend caps, TTL-aware scheduling, and explicit org opt-in.
- Record prewarm attempts separately from user requests so spend and hit-rate impact can be evaluated.

Acceptance criteria:

- Prewarm cannot recursively trigger user-visible provider work.
- Operators can see prewarm cost, resulting cache-hit lift, and expired/unused prewarm counts.
- Disabling the feature stops future prewarm jobs without affecting normal traffic.

### 6. Prompt-layout hygiene

- Pin any proxy-injected static prefix per active session.
- Keep tool schema order stable.
- Keep compression output deterministic and first-appearance-only.
- Do not change route/provider/model mid-session unless the session pin policy explicitly allows it.
- Extend cache-bust classification with org prompt edit, tool schema churn, translator change, and compression policy change when the event data can prove it.

Acceptance criteria:

- A session can explain why its warm prefix was preserved or busted.
- Cache-bust reports identify the top operator-controlled causes, not just `unknown`.

## Settings and UI

Replace today's two Anthropic-specific toggles with a policy model once the provider-edge plan exists:

```json
{
  "promptCaching": {
    "mode": "off | observe | provider_default | optimize",
    "explicitBreakpoints": "preserve_client | auto_when_safe",
    "ttl": "provider_default | adaptive",
    "cacheKey": "preserve_client | derive_when_missing",
    "prewarm": false
  }
}
```

Hard cutover path:

- In the change that lands the new policy, convert seeds and settings writes.
- Remove old settings names from GraphQL and UI in the same change.
- Do not keep deprecated aliases.

## Events and Metrics

Add:

- `prompt_cache.plan_applied`
- `prompt_cache.control_skipped`
- `prompt_cache.prewarm_started`
- `prompt_cache.prewarm_completed`
- `prompt_cache.prewarm_expired_unused`

Reuse:

- `usage.recorded`
- `tokens.attributed`
- `compression.recorded`
- route decision and provider attempt events

Metrics:

- `proxy_prompt_cache_controls_total{provider,model,control,status,reason}`
- `proxy_prompt_cache_hit_rate{provider,model,route}`
- `proxy_prompt_cache_busts_total{provider,model,cause}`
- `proxy_prompt_cache_prewarm_cost_usd_total{provider,model,status}`

## Testing

Required test coverage:

- Request rewrite golden tests per surface and provider dialect.
- Streaming usage extraction with cache-read/cache-write fields.
- Non-streaming usage extraction with cache-read/cache-write fields.
- Translation tests proving cache fields are preserved, transformed, or deliberately skipped.
- Count-token parity for Anthropic request mutations.
- Session pinning tests proving warm cache targets do not silently change.
- Caching-page data tests for plan, hit-rate, bust, and savings summaries.

Validation commands:

```bash
pnpm --filter @proxy/proxy test
pnpm --filter @proxy/web test
pnpm typecheck
```

## Risks

- Provider docs change quickly. Capability data must be easy to update and should be validated by fixture tests.
- Adding cache fields can change billing. Every mutating control needs observe-only measurement, explicit org enablement, and spend reporting.
- Explicit breakpoints can hurt if placed on unstable bytes. Default to preserving client markers until Proxy can prove a stable prefix.
- Translation can drop provider-specific cache semantics. Route planning should prefer native dialects for cache-sensitive sessions.
- Prewarm can waste spend. It needs strict caps and visible unused-expiry reporting.

## Suggested Sequence

1. Fix OpenAI retention copy/runtime drift.
2. Add provider caching capabilities and observe-only `PromptCachePlan`.
3. Move current Anthropic auto-caching and TTL upgrade behind the plan without behavior change.
4. Add cache-plan reporting to the Caching page.
5. Add OpenAI implicit-prefix reporting by cache/session key.
6. Add richer cache-bust attribution for org prompt, tool schema, translator, and compression policy changes.
7. Add a third provider in observe-only mode.
8. Experiment with provider-supported prewarm only after the reporting loop can prove value.
