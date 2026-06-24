# Metrics And Events V1

## Goal

Add an operational metrics layer while keeping durable events as the source of truth.

Metrics answer "what is happening right now?" Events answer "what happened and why?" Proxy needs both.

## Why This Matters

Kong's strongest operations lesson is first-class metrics. LiteLLM, 9router, and OmniRoute all expose useful operational counters and dashboards. Proxy already has durable events and projections; it should add bounded-cardinality metrics for live monitoring and alerting.

## Current State

Proxy records durable request, route, provider attempt, usage, prompt artifact, event, and outbox data. The console can query projections. There is not yet a formal metrics surface for:

- request latency
- time to first token
- fallback rate
- provider attempt failures
- budget/rate rejections
- active config version
- provider cooldown counts

## Principles

- Events remain authoritative.
- Metrics must not contain raw prompt text.
- Labels must be bounded-cardinality.
- Metrics should be emitted from pipeline facts, not duplicated logic.
- Request ids should not be metric labels.
- User ids should not be metric labels.
- Model labels should be controlled and optionally bucket unknown models.

## Metrics Surface

Expose one or both:

- Prometheus `/metrics`
- OpenTelemetry metrics exporter

V1 can start with Prometheus-style metrics if it fits the deployment better. The metric instrumentation should be abstract enough to add OpenTelemetry later.

## Metric Families

### Requests

```text
proxy_requests_total
labels: organization_scope, workspace_id_or_bucket, surface, route, status

proxy_request_duration_ms
labels: surface, route, status
```

Workspace labels should be configurable. In high-cardinality environments, bucket or omit them.

### Provider Attempts

```text
proxy_provider_attempts_total
labels: provider, model_bucket, surface, terminal_status, translated

proxy_provider_latency_ms
labels: provider, model_bucket, translated

proxy_provider_ttft_ms
labels: provider, model_bucket, translated
```

### Routing

```text
proxy_route_decisions_total
labels: route, surface, translated

proxy_target_skips_total
labels: route, provider, reason

proxy_fallbacks_total
labels: route, from_provider, to_provider, reason
```

### Usage And Cost

```text
proxy_tokens_total
labels: provider, model_bucket, token_type, route

proxy_cost_usd_total
labels: provider, model_bucket, route
```

`token_type`:

```text
input
cache_read
cache_write
output
reasoning
```

### Limits

```text
proxy_limit_rejections_total
labels: scope, limit_type, route

proxy_budget_reserved_usd
labels: scope

proxy_budget_actual_usd
labels: scope
```

### Provider Health

```text
proxy_provider_account_cooldowns
labels: provider, reason

proxy_provider_model_lockouts
labels: provider, reason

proxy_provider_breaker_state
labels: provider, state
```

### Runtime Config

```text
proxy_active_routing_config_version
labels: organization_bucket, workspace_bucket

proxy_routing_graph_info
labels: hash, status
```

Use care with config hash labels. It may be better to expose hash as an info metric only in low-cardinality admin deployments.

## Event Additions

The metrics layer depends on events and pipeline facts. Add or standardize event types:

```text
routing.plan_recorded
routing.target_skipped
fallback.applied
provider_account.cooldown_started
provider_model.lockout_started
budget.rejected
rate_limit.rejected
compression.measured
compression.applied
```

Events should include enough structured metadata to rebuild projections:

- organization id
- workspace id
- request id
- route tier
- provider id
- provider account id when relevant
- model
- reason code
- config version/hash

## Instrumentation Points

Emit metrics from pipeline phase outputs:

- request completion
- route decision recorded
- provider attempt terminal
- fallback applied
- limit rejected
- health state changed
- usage priced
- compression receipt written

Do not emit metrics from low-level helpers if the pipeline has a higher-level fact. That reduces double counting.

## Console

Metrics should support:

- live traffic rate
- error rate
- provider latency
- TTFT
- fallback rate
- top skip reasons
- budget rejection rate
- compression savings trend
- active config version

The console can still use database projections for detailed drilldowns.

## Alerts

Initial alert candidates:

- provider error rate above threshold
- fallback rate spike
- classifier failure spike
- budget rejection spike
- provider account cooldown count spike
- missing usage rate spike
- active routing graph activation failure

## Validation

Unit tests:

- metric label sanitization
- no raw prompt fields in labels or values
- provider attempt terminal increments once
- fallback increments once
- budget rejection increments without provider attempt

Integration tests:

- `/metrics` includes request counter
- provider mock failure increments failure counter
- successful request increments token and cost counters
- route config hash does not explode cardinality

## Rollout

1. Add metrics abstraction.
2. Add request and provider attempt counters.
3. Add latency and TTFT histograms.
4. Add usage/cost counters.
5. Add fallback/skip/limit counters.
6. Add dashboard panels or export docs.

## Non-Goals

- No raw prompt logging in metrics.
- No request id labels.
- No unbounded user/email labels.
- No replacing event projections with metrics.
- No high-cardinality labels by default.

## Acceptance Criteria

- Operators can scrape live request and provider metrics.
- Metrics are emitted from pipeline facts.
- Events remain sufficient to rebuild durable projections.
- No metric contains raw prompt text or unbounded identifiers by default.
