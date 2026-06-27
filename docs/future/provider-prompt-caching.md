# Provider Prompt Caching Expansion

## Summary

Proxy already captures cache-read/cache-write usage, prices cached tokens separately, detects cache busts with evidence-backed operator causes, attributes token mass by request bucket, pins session routes, pins org system prompts, and has Anthropic-only request transforms for automatic caching and adaptive 1-hour TTL upgrades.

What it does not yet have is a provider-agnostic prompt-caching layer like the Deep Agents approach: one policy surface that can choose the best available cache controls for each provider, preserve prompt-cache locality across translations and route changes, and report whether those controls actually saved money.

This document scopes the path from today's Anthropic-specific behavior to a provider-capability-based caching system. It complements [Token Cost Reduction](token-cost-reduction.md), which covers the broader attribution, cache hygiene, compression, schema diet, and output-control program. The PR-sized implementation breakdown lives in [Provider Prompt Caching Expansion Tickets](provider-prompt-caching-tickets.md).

## Current State

Implemented:

- Anthropic Messages can inject top-level `cache_control: { type: "ephemeral" }` for multi-turn requests that do not already carry any cache markers.
- Anthropic Messages can upgrade eligible ephemeral cache markers to `ttl: "1h"` when org history shows recoverable idle gaps and the current request has a large cacheable prefix.
- Native OpenAI rewrites preserve `prompt_cache_key` when clients send it; translations that cannot round-trip the field drop it. Codex/opencode session detection can use inbound values before forwarding.
- OpenAI rewrites preserve client-sent `prompt_cache_retention` for public OpenAI API upstreams. Proxy does not add the field automatically.
- Usage normalization records total input, cached input, cache-creation input, output, reasoning, and total tokens across OpenAI and Anthropic wire shapes.
- Cache-bust detection reports likely TTL expiry, model switch, provider switch, org prompt edit, tool schema churn, translator change, compression policy change, route config change, or unknown causes from usage-ledger rows plus request-scoped event evidence.
- Token attribution emits `tokens.attributed` with system prompt, org prompt, tool schemas, history, new tool results, latest user text, and per-tool breakdowns.
- The console has a Caching view backed by token attribution, cache-bust, cache-savings, and usage analytics queries.

Current alignment:

- The settings page, runtime, and tests now agree that OpenAI prompt caching is provider-managed: clients may send documented `prompt_cache_retention` values, and Proxy forwards them to public OpenAI API upstreams without adding retention policy on its own.

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

## Provider Usage Normalization Contract

Before cache analytics or request mutation is enabled for a new provider, its adapter must prove how wire usage maps into Proxy's normalized usage shape:

- `inputTokens` is total model input, including cache reads and cache writes.
- `cachedInputTokens` is the cache-read subset of `inputTokens`.
- `cacheCreationInputTokens` is the cache-write subset of `inputTokens`.
- `outputTokens`, `reasoningTokens`, and `totalTokens` must come from documented fields or deterministic sums.
- Missing, partial, or unknown usage shapes must degrade to zero/default values rather than inventing provider-specific totals.

Provider fixture tests must cover cached reads, cache writes, uncached input, output, reasoning, total tokens, partial usage, missing usage, unknown shapes, and the canonical adapter output shape. Billing, rollups, metrics, and the Caching page consume only the normalized contract; provider-specific branches belong inside the normalizer or provider adapter fixture, not downstream analytics.

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
  usageShape: "openai" | "anthropic" | "gemini" | "provider_specific";
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

- Keep OpenAI `prompt_cache_retention` support aligned with official provider docs.
- Proxy forwards client-sent values to public OpenAI API upstreams, but it does not add retention policy automatically.
- Add policy/settings only if Proxy later owns that control instead of preserving client intent.
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

#### Static-prefix spike result

Status: defer production mutation; keep `static_prefix` as an observe-only candidate until Proxy can prove stable-prefix value from plan events, token attribution, cache-bust data, and session pins.

Anthropic constraints checked against the [Claude prompt-caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) on 2026-06-27:

- Prompt-cache prefixes are ordered as `tools`, then `system`, then `messages`.
- Automatic caching uses a top-level `cache_control` field and moves the breakpoint to the last cacheable block as conversations grow.
- Explicit block-level cache breakpoints can target tool definitions, system blocks, or message content blocks.
- A request can use up to 4 cache breakpoints. Automatic caching is compatible with explicit breakpoints but consumes one of those slots.
- The default TTL is 5 minutes; `ttl: "1h"` is available at higher write cost.
- Explicit cache lookup walks backward through up to 20 blocks from each breakpoint, so a static-prefix breakpoint only helps if a previous request wrote that exact prefix.

Current top-level automatic shape:

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "cache_control": { "type": "ephemeral", "ttl": "1h" },
  "tools": [{ "name": "search", "input_schema": { "type": "object" } }],
  "system": [{ "type": "text", "text": "Pinned org and session instructions." }],
  "messages": [
    { "role": "user", "content": "first question" },
    { "role": "assistant", "content": "first answer" },
    { "role": "user", "content": "follow-up" }
  ]
}
```

Expected cacheable prefix: the provider chooses the last cacheable block and advances the breakpoint as the conversation grows. This is good for normal multi-turn agent sessions where the full history is stable and each new turn stays within the provider lookback window.

Static-prefix candidate shape:

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "tools": [
    {
      "name": "search",
      "input_schema": { "type": "object" },
      "cache_control": { "type": "ephemeral", "ttl": "1h" }
    }
  ],
  "system": [
    {
      "type": "text",
      "text": "Pinned org and session instructions.",
      "cache_control": { "type": "ephemeral", "ttl": "1h" }
    }
  ],
  "messages": [{ "role": "user", "content": "dynamic user request" }]
}
```

Expected cacheable prefix: the tool breakpoint writes the stable tool-schema prefix; the system breakpoint writes `tools + system`. This can help sessions with large tool schemas or pinned system prompts but short or highly variable message histories.

Reasons to defer mutation:

- Breakpoint slots are scarce. Tool and system markers plus top-level automatic caching can exhaust the provider limit before client-provided markers are considered.
- One-shot prompts and small prefixes can pay cache-write premiums without enough follow-up reads to recover the cost.
- Static-prefix markers are only safe when tool order, tool schemas, org prompt, session prompt, translator version, and compression policy are pinned or provably stable.
- Translated requests need markers inserted after translation; source-dialect cache fields must remain skipped evidence, not copied into the Anthropic body.
- Count-token requests must carry the same explicit TTL upgrades for existing markers, while still avoiding automatic top-level marker insertion.

Recommendation: do not add static-prefix request mutation in this milestone. Add an observe-only `static_prefix` candidate first: estimate `tools` and `tools + system` prefix size from token attribution, report why the candidate was skipped, and only graduate to opt-in mutation after cache-read/write data shows repeated misses that top-level automatic caching cannot recover.

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

#### Gemini observe-only adapter result

Status: add Gemini as the first third-provider observe-only cache capability and usage-normalization shape. Do not add a built-in provider, native Gemini request dialect, explicit cache creation, or request mutation in this milestone.

Google docs checked on 2026-06-27:

- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching) says the Interactions API supports implicit caching only, with no explicit cache-object management in that API version; Gemini 2.5 and newer models have implicit caching enabled by default.
- The same page says cache hits are visible in `usage_metadata` / `usageMetadata`.
- [Gemini token usage docs](https://ai.google.dev/gemini-api/docs/tokens) describe Interactions usage fields for total input, output, thinking, cached content, tool-use, and total tokens.
- [GenerateContent API UsageMetadata](https://ai.google.dev/api/generate-content#UsageMetadata) says `promptTokenCount` includes cached content, `cachedContentTokenCount` is the cached part of the prompt, `thoughtsTokenCount` records thinking tokens, and `totalTokenCount` is prompt plus thoughts plus response candidates.

Proxy representation:

- `GEMINI_PROVIDER_CACHING_CAPABILITIES` is an implicit-prefix, observe-only capability with no cache-key field, no retention field, no explicit breakpoint support, and no prewarm support.
- Gemini usage normalization maps Interactions `total_input_tokens` / `total_cached_tokens` / `total_output_tokens` / `total_thought_tokens` and GenerateContent `promptTokenCount` / `cachedContentTokenCount` / `candidatesTokenCount` / `thoughtsTokenCount` into the existing normalized usage contract.
- OpenAI-native `prompt_cache_key` and `prompt_cache_retention` sent to a Gemini-backed OpenAI-compatible endpoint are recorded as unsupported skipped controls, not forwarded policy owned by Proxy.

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

#### Provider-supported experiment result

Status: the first implementation is event-backed and adapter-gated. `PromptCachePrewarmService` enforces opt-in settings, provider/model allowlists, input and spend caps, hourly job caps, TTL-aware scheduling, idempotency, and provider timeouts before invoking a supplied provider-edge adapter. The service emits started, completed, failed, cancelled, and expired-unused events plus bounded metrics. The Caching page reports prewarm cost, expired-unused waste, and cache-read lift from those events.

There is still no default autonomous trigger and no default network adapter. Route-config publish, session-resume, workspace-bootstrap, or manual entry points must supply an eligible candidate and a provider adapter; unsupported providers are cancelled before provider work starts.

#### Prewarm job model

Status: the internal model, caps, event statuses, and accounting fields are defined before any autonomous trigger is enabled.

Settings:

- `enabled`: hard opt-in. `false` prevents new jobs from being planned or queued.
- `maxDailySpendMicros`: org/workspace spend ceiling for prewarm attempts.
- `maxHourlyJobs`: throttle for route-config publishes, session resumes, workspace bootstrap, and manual triggers.
- `maxInputTokensPerJob`: upper bound for the cacheable prefix sent to a provider.
- `providerAllowlist` and `modelAllowlist`: explicit targets; no default all-provider rollout.

Job identity:

- Scope every job by `organizationId`, `workspaceId`, `provider`, and `model`.
- Use `triggerSource` values `route_config_publish`, `session_resume`, `workspace_bootstrap`, or `manual`.
- Build `idempotencyKey` from org, workspace, provider, model, trigger source, routing config/session key, prefix digest, and TTL bucket.
- Store `prefixDigest`, not raw prompt bytes, tool schemas, API keys, provider secrets, or raw cache keys.
- Include optional `routingConfigVersionId`, `sessionId`, and provider cache reference only when they are already scoped to the same org/workspace.

State machine:

- `planned`: candidate passed static eligibility but has not consumed capacity.
- `queued`: capacity and spend caps were reserved.
- `running`: worker has started the provider operation.
- `succeeded`: provider returned a cache reference or documented success signal.
- `failed`: provider operation failed or returned an incompatible response.
- `cancelled`: disabled settings or operator cancellation stopped the job before provider work.
- `expired_unused`: TTL elapsed without a matching cache-read lift.

Caps and scheduling:

- Reject planning when the selected provider capability does not support prewarm.
- Reject planning when the target provider/model is absent from the allowlists.
- Reserve estimated cost against the daily cap before queueing.
- Do not schedule work whose `expiresAt` would arrive before the expected first reuse.
- Do not schedule duplicate jobs for the same idempotency key.
- Treat `maxDailySpendMicros: 0` or `maxHourlyJobs: 0` as observe-only/no-queue mode.

Accounting:

- Record prewarm cost separately from user request cost.
- `estimatedCostMicros` is reserved before queueing; `actualCostMicros` is written only after provider completion.
- `expired_unused` keeps cost attributed to prewarm waste, not user traffic.
- Hit-rate lift is measured by later provider usage rows that match the same org/workspace/provider/model/prefix digest or provider cache reference.
- Disabling prewarm cancels `planned` and `queued` jobs, prevents future jobs, and leaves `running`, `succeeded`, `failed`, and `expired_unused` records auditable.

### 6. Prompt-layout hygiene

- Pin any proxy-injected static prefix per active session.
- Keep tool schema order stable.
- Keep compression output deterministic and first-appearance-only.
- Do not change route/provider/model mid-session unless the session pin policy explicitly allows it.
- Extend cache-bust classification with org prompt edit, tool schema churn, translator change, and compression policy change when the event data can prove it.

Acceptance criteria:

- A session can explain why its warm prefix was preserved or busted.
- Cache-bust reports identify the top operator-controlled causes, not just `unknown`.

Status: cache-bust attribution now includes org prompt edits, tool schema churn, translator changes, compression policy changes, and route config changes when both adjacent session rows carry evidence. Missing evidence stays `unknown`. The [prompt caching runbook](../runbooks/prompt-caching.md) turns those causes into rollout block signals and rollback steps.

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
- `prompt_cache.prewarm_failed`
- `prompt_cache.prewarm_cancelled`
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
9. Use the rollout runbook for baseline, canary, block-signal, and rollback decisions before any mutating control is widened.
