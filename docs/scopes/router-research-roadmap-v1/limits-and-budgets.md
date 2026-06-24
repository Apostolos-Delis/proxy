# Limits And Budgets V1

## Goal

Add API-key and workspace operating limits for requests, tokens, parallelism, and spend.

Limits should reject or reserve before provider spend, true up after actual usage, and record durable evidence.

## Why This Matters

LiteLLM and OmniRoute both show that serious routing gateways need budget and rate controls. Proxy currently has routing-config limits and cost tracking, but it needs stronger controls for organization use:

- prevent runaway spend
- isolate noisy API keys
- avoid provider account overload
- enforce workspace budgets
- make rejections explainable

## Current State

Proxy computes spend from normalized usage and model pricing. Routing configs have a `limits` block for route and estimated input guardrails. Provider forwarding handles upstream rate-limit retry behavior.

Missing:

- API-key RPM and TPM
- workspace RPM and TPM
- parallel request caps
- budget windows
- pre-call budget reservations
- post-call true-up
- rate/budget rejection events

## Limit Types

### Request Rate

Requests per minute:

- per API key
- per workspace
- optional per route tier

### Token Rate

Estimated input plus configured output cap per minute:

- per API key
- per workspace
- optional per provider account

### Parallel Requests

Concurrent active requests:

- per API key
- per workspace
- per provider account

### Budget Windows

Spend caps:

- daily
- weekly
- monthly
- custom reset time
- warning threshold

## Config Shape

Add to routing config or API key policy:

```json
{
  "limits": {
    "requestsPerMinute": 120,
    "tokensPerMinute": 200000,
    "parallelRequests": 5,
    "budget": {
      "dailyUsd": 25,
      "weeklyUsd": 100,
      "monthlyUsd": 300,
      "warningThreshold": 0.8,
      "resetTimeUtc": "00:00"
    }
  }
}
```

Workspace defaults should be set in organization/workspace settings. API key limits can override downward or specify stricter caps.

## Data Model

### api_key_limit_policies

```text
id text primary key
organization_id text not null
workspace_id text not null
api_key_id text not null
policy jsonb not null
created_at timestamptz not null
updated_at timestamptz not null

unique (organization_id, workspace_id, api_key_id)
```

### workspace_limit_policies

```text
id text primary key
organization_id text not null
workspace_id text not null
policy jsonb not null
created_at timestamptz not null
updated_at timestamptz not null

unique (organization_id, workspace_id)
```

### budget_windows

```text
id text primary key
organization_id text not null
workspace_id text not null
scope_type text not null
scope_id text not null
window_type text not null
period_start_at timestamptz not null
period_end_at timestamptz not null
limit_usd numeric not null
reserved_usd numeric not null default 0
actual_usd numeric not null default 0
warning_emitted_at timestamptz
created_at timestamptz not null
updated_at timestamptz not null

unique (organization_id, workspace_id, scope_type, scope_id, window_type, period_start_at)
```

### active_request_limits

For V1, active parallel request tracking can start in Postgres:

```text
id text primary key
organization_id text not null
workspace_id text not null
api_key_id text not null
provider_account_id text
request_id text not null
started_at timestamptz not null
expires_at timestamptz not null

unique (request_id)
index (organization_id, workspace_id, api_key_id)
index (provider_account_id)
```

Rows should have TTL-style cleanup for crashed workers.

## Preflight Flow

```text
request parsed
  -> resolve API key and workspace
  -> estimate input tokens
  -> estimate max output tokens from route config or request cap
  -> estimate spend
  -> check request rate
  -> check token rate
  -> check parallel request cap
  -> reserve budget if required
  -> continue to classifier/provider
```

Budget reservation should be conservative but not excessive. Use the route's target model pricing after route planning where possible; before classification, only apply broad workspace/API-key caps.

## True-Up Flow

After provider terminal status:

1. Extract actual usage.
2. Compute actual cost.
3. Release or adjust reservation.
4. Add actual spend to budget window.
5. Record warning or exceeded state.
6. Remove active request row.

If terminal reconciliation is pending, the budget row should retain reservation until reconciliation or expiry.

## Rate Limit Storage

V1 can use Postgres for correctness and simplicity. If throughput requires it later, add Redis as an implementation detail behind the same limiter interface.

Avoid introducing Redis in V1 unless needed by measured load.

## Events

Add:

```text
limit.request_rate_rejected
limit.token_rate_rejected
limit.parallel_rejected
budget.reserved
budget.reservation_released
budget.warning_emitted
budget.exceeded
budget.rejected
```

Events should include scope, limit, current usage, and reset time. No prompt text.

## Console

Add views for:

- API key limits
- workspace limits
- current active requests
- budget windows
- spend vs reserved
- rejection timeline
- warning thresholds

Request detail should show budget/rate preflight decisions in the route plan.

## Validation

Unit tests:

- per-key RPM rejects at threshold
- per-workspace TPM rejects at threshold
- active request cap creates and clears row
- expired active request rows do not block forever
- budget reservation and true-up handle lower actual spend
- budget true-up handles higher actual spend

Integration tests:

- rejected request never reaches provider mock
- rejection event is appended
- successful request updates actual spend
- streaming terminal usage true-up works

## Rollout

1. Add limit policy schemas and admin read APIs.
2. Add parallel request cap first.
3. Add budget windows with measure-only reporting.
4. Enforce budget rejection.
5. Add RPM and TPM enforcement.
6. Add console editing.

## Non-Goals

- No distributed Redis dependency in V1.
- No adaptive budget routing.
- No automatic model downgrade on budget pressure.
- No post-provider budget rejection.

## Acceptance Criteria

- Limits can reject before classifier or provider spend when configured.
- Budget reservations true up after actual usage.
- Active requests are cleaned up on terminal success, failure, and timeout.
- Rejections are visible in events, route plans, and console.
