# Prompt Caching Runbook

Use this runbook when enabling, changing, or rolling back prompt-cache controls. The safe rollout path is:

1. Measure current traffic.
2. Review observe-only prompt-cache plans and cache-bust causes.
3. Canary one mutating control on the narrowest scope the control actually supports.
4. Hold until cache reads, cost, and error rates are stable.
5. Ramp gradually or roll back.

Durable data in `usage_ledger`, `events`, resolution decisions, and the Caching console is the source of truth. Metrics are useful for alerting, but they can reset on deploy.

## Before You Start

Confirm:

- Persistence is enabled. Without `DATABASE_URL`, cache-bust history, prompt-cache plans, prewarm events, and usage rollups are not durable.
- Deployment pricing is configured for the physical targets you will compare. Unpriced cached tokens are reported but cannot produce reliable savings.
- The target workspace, API key, logical model, and deployment set are known.
- Provider connections and deployments are healthy.
- You know whether the selected traffic is native or translated. Native targets preserve provider-owned cache semantics better than translated targets.

Choose the smallest rollout scope that still has repeated sessions:

- Prefer one workspace or one API key.
- Prefer one provider/model pair.
- Avoid changing logical-model targets, org system prompts, compression policy, or tool schema sets during the baseline and canary windows.
- Current **Settings -> Token optimization** toggles are org-wide across all logical models. For those controls, use a staging org or treat all Anthropic traffic in the org as the rollout scope. Workspace and API-key scoping remain useful for observe-only analysis and future per-scope controls.

## Baseline

Use at least one cache TTL window for fast checks and at least 24 hours for rollout decisions.

In the console:

1. Open **Caching**.
2. Record cache read ratio, cached input tokens, cache creation tokens, estimated cache savings, idle gaps, and cache miss tokens.
3. Check **Prompt-cache plans** for applied and skipped controls.
4. Check **Cache miss tokens** by cause. Treat `org_prompt_edit`, `tool_schema_churn`, `translator_change`, `compression_policy_change`, and `logical_model_change` as operator-controlled churn.
5. Check **Cache read ratio by model** for model-level read ratios across providers.
6. Check **Prewarm jobs** only if a prewarm adapter and trigger are explicitly enabled.

In **Usage / Cost**:

1. Group by logical model, deployment, API key, provider, model, and surface.
2. Record total input, cached input, cache creation input, output, and total cost.
3. Open example requests from the target scope and confirm the logical model, selected deployment/model, session ID, and prompt-cache evidence match the rollout target.

Stop before enabling mutation if the baseline already has:

- Elevated provider failures or proxy 5xxs.
- Missing usage rows for successful provider attempts.
- Unknown cache-bust causes dominating the target scope.
- Cache creation cost rising without later cache reads.
- Sampling warnings on Caching cards for the target time window.

## Observe-Only Rollout

Prompt-cache plan events let operators see what Proxy would apply or skip without changing request bytes. Use this phase before every mutating control.

Required checks:

- `prompt_cache.plan_applied` events exist for the target traffic.
- The Caching page shows provider, model, mode, applied controls, skipped controls, and skipped reasons.
- Skipped reasons match the expected provider capabilities. Unsupported provider fields should be skipped evidence, not best-effort rewrites.
- Cache-bust causes stay stable while no mutating cache control is enabled.

GraphQL spot check:

```graphql
query PromptCacheRolloutCheck($start: String, $end: String) {
  promptCachePlans(start: $start, end: $end) {
    totalPlans
    sampled
    controls {
      provider
      model
      mode
      control
      status
      reason
      count
    }
  }
  cacheBusts(start: $start, end: $end) {
    sampled
    countsByCause
  }
}
```

Do not move to mutation when:

- Plans are missing for the canary scope.
- Most planned controls are skipped for reasons you cannot explain.
- New operator-controlled bust causes appear during observe-only.
- The target deployment or provider changes mid-session.

## Anthropic Controls

Current Proxy-owned mutating controls are Anthropic-only.

### Auto-Enable Prompt Caching

This adds top-level `cache_control: { "type": "ephemeral" }` to eligible multi-turn Anthropic Messages requests when the request does not already contain cache markers.

Canary sequence:

1. Keep logical-model targets, org prompt, compression policy, and tool schema set stable.
2. Enable **Auto-enable prompt caching** for the rollout org.
3. Watch cache creation tokens for the first cacheable turns.
4. Confirm later turns show cache reads and estimated savings.
5. Confirm one-shot requests do not start paying cache-write cost.

Rollback:

1. Disable **Auto-enable prompt caching**.
2. Keep active sessions on their current provider/model until the provider TTL expires unless correctness requires an immediate target change.
3. Verify new prompt-cache plans show the control skipped or absent.
4. Watch cache creation tokens return to baseline.

Block rollout when:

- Cache write tokens increase without a later cache-read lift.
- Cache-bust causes show tool schema, org prompt, translator, compression policy, or logical-model churn.
- Provider rejects requests with cache fields.

### Adapt Cache TTL To 1 Hour

This upgrades eligible Anthropic ephemeral cache markers to `ttl: "1h"` after recent workspace history shows recoverable idle gaps.

Canary sequence:

1. Confirm idle gaps are over the 5-minute TTL and inside the 1-hour window.
2. Enable **Adapt cache TTL to 1 hour** for the rollout org only after auto caching or caller markers are already working.
3. Watch cache write premium, cache-read recovery, and estimated savings.

Rollback:

1. Disable **Adapt cache TTL to 1 hour**.
2. Leave existing sessions stable until their provider cache entries expire.
3. Verify new requests no longer receive `ttl: "1h"` upgrades.

Block rollout when:

- Idle-gap recovery is below the cache-write premium.
- The setting applies to small or one-shot requests.
- Provider errors, latency, or spend spikes after the change.

## OpenAI Implicit-Prefix Analytics

OpenAI prompt caching is provider-managed for public OpenAI API upstreams. Proxy preserves caller-sent `prompt_cache_key` and `prompt_cache_retention` on native OpenAI requests, but it does not add OpenAI cache controls on its own.

Use OpenAI analytics to find stable or unstable cache groups:

- Prefer native OpenAI targets for stateful Responses sessions.
- Keep static content early in the prompt.
- Preserve stable caller-provided `prompt_cache_key` values when the caller sends them.
- Avoid logical-model target, model, provider, translator, org prompt, compression, or tool schema changes during active cache-sensitive sessions.

Rollback for OpenAI cache regressions:

1. Restore the previous native OpenAI target set through GraphQL or gateway TOML.
2. Stop forwarding newly introduced caller cache fields if the caller rollout caused the regression.
3. Keep session pins stable until active sessions age out.
4. Verify OpenAI key/session hit rates return to baseline.

Block rollout when:

- Native OpenAI traffic is moved to translated targets for cache-sensitive sessions.
- `prompt_cache_key` groups fragment unexpectedly.
- Cache hit rate falls while input tokens and cache-bust counts rise.

## Translation And Logical-Model Changes

Translation can change prompt bytes and provider-specific cache fields. Logical-model target changes can move sessions away from warm provider/model prefixes.

Rules:

- Prefer native targets for active cache-sensitive sessions.
- Do not copy OpenAI-only cache fields into Anthropic requests.
- Do not copy Anthropic `cache_control` markers into OpenAI requests.
- Treat `translator_change` and `logical_model_change` cache-bust causes as operator-controlled churn.
- Use the gateway control-plane runbook to restore the previous target graph.

Rollback:

1. Restore the previous logical-model targets and deployment bindings.
2. Stop the rollout for new sessions.
3. Avoid forcing active sessions across providers unless correctness requires it.
4. Watch `provider_switch`, `model_switch`, `translator_change`, and `logical_model_change` bust counts.

## Compression And Tool Schema Changes

Compression policy and tool schema order affect cacheable prefix bytes.

Rules:

- Change compression policy separately from prompt-cache controls.
- Keep compression output deterministic.
- Keep tool schema order and schema content stable within active sessions.
- Treat `compression_policy_change` and `tool_schema_churn` cache-bust causes as rollback signals.

Rollback:

1. Restore the previous compression policy.
2. Stop the tool schema rollout for new sessions.
3. Let already-busted sessions age out; changing back mid-session can cause another bust.
4. Verify the Caching page stops reporting the operator-controlled cause.

## Prewarm Experiment

Prewarm is allowed only when a provider has a documented prewarm primitive or equivalent and an explicit adapter is supplied. There is no default autonomous trigger or default network adapter.

Required controls:

- `enabled: true` is explicit opt-in.
- `providerAllowlist` and `modelAllowlist` are narrow.
- `maxDailySpendMicros`, `maxHourlyJobs`, and `maxInputTokensPerJob` are set before any job can run.
- `maxDailySpendMicros: 0` or `maxHourlyJobs: 0` is observe-only/no-queue mode.
- Jobs use idempotency keys and TTL buckets so the same prefix is not warmed repeatedly.
- Jobs store prefix digests, not raw prompt text, tool schemas, API keys, provider secrets, or raw cache keys.

Canary sequence:

1. Start with observe-only/no-queue caps.
2. Enable one provider/model pair.
3. Allow one trigger source, preferably manual or one workspace bootstrap.
4. Confirm `prompt_cache.prewarm_started` and terminal events are emitted.
5. Compare actual prewarm cost, expired-unused cost, and cache-read lift.

Rollback:

1. Set `enabled: false`, `maxHourlyJobs: 0`, or `maxDailySpendMicros: 0`.
2. Cancel `planned` and `queued` jobs.
3. Leave `running`, `succeeded`, `failed`, and `expired_unused` records auditable.
4. Verify no new `prompt_cache.prewarm_started` events appear.

Block rollout when:

- Provider capability does not support prewarm.
- Expired-unused cost grows faster than cache-read lift.
- Prewarm jobs retry or duplicate unexpectedly.
- Prewarm provider calls affect user-visible traffic.
- Provider error rate or latency rises after jobs start.

## Validation Signals That Block Rollout

Do not ramp if any signal below is true for the canary scope.

| Signal | Why it blocks |
| --- | --- |
| Provider 4xx/5xx or proxy 5xx rises | Cache controls may be rejected or destabilizing forwarding |
| Cache creation tokens rise without later cached input tokens | The control is adding write premium without reuse |
| `unknown` cache busts dominate | Operators cannot explain the misses yet |
| Operator-controlled bust causes appear | Prompt layout is changing during active sessions |
| OpenAI cache groups fragment | Session/key identity is unstable |
| Anthropic one-shot requests get cache writes | The control is charging where reuse is unlikely |
| `promptCachePlans.sampled` or `cacheBusts.sampled` is true for the rollout window | The query window is too broad for confident decisions |
| Prewarm expired-unused cost rises | Warming is spending before reuse is proven |
| Outbox or event persistence is failing | The evidence needed for rollback is incomplete |

## Final Ramp

After a clean canary:

1. Increase one supported dimension at a time: more API keys, more workspaces, one additional deployment, or one additional org-wide control.
2. Keep each ramp step for at least one business day or one representative session cycle.
3. Re-check Caching, Usage / Cost, request examples, and metrics after each step.
4. Record the baseline window, canary scope, enabled controls, rollback point, and observed savings in the rollout notes.

## Related Docs

- [Prompt caching user guide](../user-guide/prompt-caching.md)
- [Analytics and spend](../user-guide/analytics.md)
- [Gateway control-plane runbook](gateway-control-plane.md)
- [Proxy metrics runbook](proxy-metrics.md)
- [Archived provider prompt-caching research](../research/provider-prompt-caching.md)
