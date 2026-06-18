# Provider Account Health V1

## Goal

Track provider, provider account, and provider/model health as durable current state. Use that state during route planning and expose it in the console.

This gives Prompt Proxy the operational maturity seen in LiteLLM and OmniRoute while preserving Prompt Proxy's audit model.

## Why This Matters

Provider failures are not all the same:

- an API key can be revoked
- a token can expire
- one account can be rate-limited
- one provider/model pair can be unavailable
- a provider can have a regional outage
- a model can reject a request because of context limits
- a request can be malformed for one provider dialect but valid for another

Today these can collapse into provider attempt failures and logs. The router needs durable state to avoid repeatedly selecting known-bad targets and to explain why targets were skipped.

## Current State

Prompt Proxy supports provider accounts, BYOK bindings, provider attempts, usage, and route decisions. Provider HTTP forwarding retries upstream `429` responses with provider-aware delay handling.

Missing pieces:

- provider account cooldown state
- provider/model lockout state
- provider-level circuit breaker state
- typed provider error taxonomy
- health probe status
- skip evidence tied to provider state
- operator view of account health

## Health Taxonomy

V1 should distinguish:

```text
auth_invalid
auth_expired
rate_limited
quota_exhausted
provider_unavailable
model_unavailable
model_access_denied
context_overflow
request_incompatible
stream_failed
stream_disconnected
unknown_transient
unknown_terminal
```

Each classification should include:

- source: provider status, provider header, response body pattern, stream observer, proxy policy
- confidence: exact, heuristic, unknown
- retryable: boolean
- scope: provider, provider_account, provider_model, provider_account_model, request_only
- cooldown until: timestamp or null

## Data Model

Add `provider_account_health`:

```text
id text primary key
organization_id text not null
workspace_id text
provider_account_id text not null
provider_id text not null
status text not null
last_error_type text
last_error_message text
last_error_at timestamptz
cooldown_until timestamptz
consecutive_failures integer not null default 0
last_success_at timestamptz
last_checked_at timestamptz
metadata jsonb not null default '{}'

unique (organization_id, provider_account_id)
index (organization_id, provider_id)
index (organization_id, cooldown_until)
```

Add `provider_model_health`:

```text
id text primary key
organization_id text not null
workspace_id text
provider_id text not null
provider_account_id text
model text not null
status text not null
last_error_type text
last_error_at timestamptz
lockout_until timestamptz
consecutive_failures integer not null default 0
last_success_at timestamptz
metadata jsonb not null default '{}'

unique (organization_id, provider_id, provider_account_id, model)
index (organization_id, provider_id, model)
index (organization_id, lockout_until)
```

Add optional `provider_health` if provider-level circuit breakers are in scope for the same migration:

```text
id text primary key
organization_id text not null
provider_id text not null
status text not null
breaker_state text not null
opened_at timestamptz
half_open_after timestamptz
last_error_type text
last_error_at timestamptz
metadata jsonb not null default '{}'

unique (organization_id, provider_id)
```

## Events

Add events:

```text
provider_account.health_changed
provider_account.cooldown_started
provider_account.cooldown_expired
provider_model.lockout_started
provider_model.lockout_expired
provider.breaker_opened
provider.breaker_half_opened
provider.breaker_closed
provider.health_probe_completed
```

Events should not contain raw prompt text. Provider response body excerpts must be sanitized and capped.

## Runtime Behavior

During route planning:

1. Resolve candidate provider targets.
2. Resolve candidate provider accounts.
3. Load current health rows for accounts and provider/model pairs.
4. Skip accounts whose cooldown or lockout is active.
5. Add skip reasons to the route execution plan.
6. Select the first eligible account.

After provider attempts:

1. Classify terminal status.
2. Update health state inside the same transaction as terminal provider attempt state when persistence is enabled.
3. Append health events when status changes.
4. Clear cooldown or reset failure counters on success.

## Cooldown Rules

Initial defaults:

```text
auth_invalid: terminal until credential changes
auth_expired: retry after refresh attempt; cooldown 1 minute if refresh fails
rate_limited: use Retry-After or provider reset header; fallback 60 seconds
quota_exhausted: use reset header if available; fallback 1 hour
provider_unavailable: exponential backoff capped at 5 minutes
model_unavailable: model lockout 10 minutes
context_overflow: request-only, no cooldown
request_incompatible: request-only, no cooldown
stream_failed: no account cooldown unless provider returned explicit failure
unknown_transient: short cooldown 30 seconds
unknown_terminal: no automatic cooldown; record error
```

These defaults should be provider-overridable through the provider registry later.

## Health Probes

V1 probe behavior:

- Probes are operator-triggered or background scheduled.
- Probes use small safe prompts and low output caps.
- Probes write events and current-state rows.
- Probes do not override routing config by themselves.
- Probe failures can mark health state when confidence is high.

Probe dimensions:

- basic chat availability
- streaming availability
- tool-call support
- vision support when expected
- latency sample

## Console

Add provider health views:

- provider account status
- cooldown expiry
- last error type
- last success
- model lockouts
- health probe history
- affected API keys
- affected routing configs

Request detail should show when a provider account was skipped due to health state.

## Validation

Unit tests:

- classify common provider status/error bodies
- cooldown expiry clears skip eligibility
- success resets consecutive failures
- context overflow does not poison account
- auth invalid marks account terminal

Integration tests:

- route plan skips account under cooldown
- terminal provider failure updates health state
- health change appends event
- console provider detail returns health rows

## Rollout

1. Add taxonomy and classifier helper.
2. Add health tables and projections.
3. Update route planning to read health state.
4. Update provider terminal handling to write health state.
5. Add console health panels.
6. Add probes.

## Non-Goals

- No adaptive routing based on health scores.
- No provider-wide automatic outage declarations from one request.
- No raw upstream error body persistence.
- No Redis dependency in V1.

## Acceptance Criteria

- Provider account cooldowns are durable and affect target selection.
- Provider/model lockouts are durable and visible.
- Health-related skips appear in route execution plans.
- Provider terminal failures update typed health state.
- Operators can see why a provider account is unavailable.
