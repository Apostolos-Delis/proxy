# Provider Account Health V1

## Goal

Track provider, provider account, and provider/model health as durable current state. Use that state during route planning and expose it in the console.

This gives Proxy the operational maturity seen in LiteLLM and OmniRoute while preserving Proxy's audit model.

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

## Shipped V1 State

Proxy now supports provider accounts, BYOK bindings, provider attempts, usage, route decisions, and provider account/model health current state. Provider HTTP forwarding retries upstream `429` responses with provider-aware delay handling, and terminal provider outcomes are classified into typed health state when persistence is enabled.

Implemented V1 pieces:

- provider account cooldown state
- provider/model lockout state
- typed provider error taxonomy
- operator-triggered health probes
- skip evidence tied to provider state
- operator view of account health

Deferred pieces:

- provider-level circuit breaker state
- scheduled background probes
- provider-registry cooldown overrides
- first-class health metrics

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

Provider-level `provider_health` rows were explicitly deferred from V1. Add them later if provider-level circuit breakers are in scope:

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

Shipped V1 events:

```text
provider_account.health_changed
provider_account.cooldown_started
provider_model.lockout_started
provider_account.health_probe_completed
```

Expired cooldowns and lockouts are ignored at route time; V1 does not append explicit expiry events. Provider breaker events remain deferred. Events should not contain raw prompt text. Probe result payloads do not include raw upstream response bodies.

## Runtime Behavior

During route planning:

1. Resolve candidate provider targets.
2. Resolve candidate provider accounts.
3. Load current health rows for accounts and provider/model pairs.
4. Skip accounts whose cooldown is active or whose account status is terminal.
5. Skip provider-account/model pairs whose lockout is active.
6. Add skip reasons to route decision evidence.
7. Select the first eligible account.

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

- Probes are operator-triggered from the console or admin GraphQL.
- Probes use small safe prompts and low output caps.
- Probes write `provider_account.health_probe_completed` events and project current-state rows from that event.
- Probes do not override routing config by themselves.
- Probe failures can mark health state when confidence is high.

Probe dimensions:

- basic chat availability
- streaming availability
- tool-call support is deferred until a provider capability contract exists
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

1. Run migrations before deploying health-aware code: `0019_provider_health.sql`, then `0020_provider_attempt_account.sql`.
2. Deploy code that projects terminal provider events and probe events into health state.
3. Watch `routing.decision_recorded.healthSkips`, `provider_account.cooldown_started`, `provider_model.lockout_started`, and `provider_account.health_probe_completed`.
4. Use the Model providers console or admin GraphQL probe mutation to clear false-positive terminal/cooldown state after validating credentials.
5. See the current [provider health runbook](../../runbooks/provider-health.md) for operational commands and post-deploy checks.

## Non-Goals

- No adaptive routing based on health scores.
- No provider-wide automatic outage declarations from one request.
- No uncapped upstream error body persistence.
- No Redis dependency in V1.
- No scheduled background probes in V1.

## Acceptance Criteria

- Provider account cooldowns are durable and affect target selection.
- Provider/model lockouts are durable and visible.
- Health-related skips appear in route execution plans.
- Provider terminal failures update typed health state.
- Operators can see why a provider account is unavailable.
