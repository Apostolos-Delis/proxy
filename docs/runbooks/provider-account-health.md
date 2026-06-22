# Provider Account Health Runbook

Provider Account Health V1 tracks provider-account and provider-account/model health as durable current state. The router uses that state before provider spend, and the console exposes current health on Model providers plus request-level health skip evidence.

## Shipped Behavior

- A missing health row means "no health data yet" and does not block routing.
- Successful provider attempts and successful manual probes mark the provider account and model row `healthy`, reset consecutive failures, clear cooldown/lockout fields, and update `last_success_at` / `last_checked_at`.
- Account-scoped failures can mark `provider_account_health`:
  - `auth_invalid`: `terminal`, no expiry, skipped until a successful probe or replacement credential clears it.
  - `auth_expired`: `cooldown`, default 1 minute.
  - `rate_limited`: `cooldown`, `Retry-After` when present, otherwise default 1 minute.
  - `quota_exhausted`: `cooldown`, default 1 hour.
- Model-scoped failures can mark `provider_model_health`:
  - `model_access_denied`: `terminal`.
  - `model_unavailable`: `locked_out`, default 10 minutes.
- Request-only failures such as context overflow, incompatible request shape, stream disconnects, and unknown terminal errors do not poison account/model health.
- Expired cooldowns and lockouts stay in the table for operator context but are ignored by route planning.
- Provider-wide circuit breakers and scheduled background probes are not part of V1.

## Migration Order

Run migrations before deploying code that reads or writes health state:

```shell
pnpm db:migrate
```

The relevant migrations are:

- `0019_provider_health.sql`: adds `provider_account_health` and `provider_model_health`.
- `0020_provider_attempt_account.sql`: adds `provider_attempts.provider_account_id`.

The deploy is a hard cutover: code expects the tables and attempt column to exist when persistence is enabled.

## Operator Workflow

1. Open the console and go to Model providers.
2. Check the Health column for each provider key.
3. Open a provider key drawer to inspect account status, model lockouts, last error type, last success, and last checked time.
4. Enter a model id in the Probe form and run a manual probe.
5. After a probe, the drawer shows the latest result and refreshes current health.
6. For a request rejected or rerouted by health, open the request detail. The event timeline shows health skip rows from `routing.decision_recorded.healthSkips`.

Manual probes use a small fixed prompt, low output caps, and provider-compatible non-streaming plus streaming checks. Probe events do not include provider secrets or raw upstream response bodies. Tool-call probes are deferred until a provider capability contract exists.

## Clearing Stuck Health

For a temporary cooldown or lockout:

1. Wait until `cooldown_until` or `lockout_until` passes; the router ignores expired rows automatically.
2. Run a manual probe for the affected account/model to record fresh success state.

For `terminal` provider account health:

1. Verify or replace the upstream credential.
2. If the credential can be fixed in place, run a successful manual probe for a known-good model.
3. If the secret is invalid and cannot be updated in place, create a new provider key, bind affected API keys to it, then revoke the old provider key.

Direct table repair should be reserved for incident response after the credential is independently verified. Prefer a successful probe because it writes an audit event and projects the same current-state mutation path the router relies on.

## GraphQL Checks

List provider key health:

```graphql
query ProviderHealth {
  providerAccounts {
    id
    provider
    name
    health {
      status
      cooldownUntil
      lastErrorType
      lastErrorAt
      lastSuccessAt
      lastCheckedAt
      consecutiveFailures
      modelHealth {
        model
        status
        lastErrorType
        lockoutUntil
        consecutiveFailures
        lastSuccessAt
      }
    }
  }
}
```

Run a manual probe:

```graphql
mutation ProbeProviderKey($input: ProbeProviderCredentialInput!) {
  probeProviderCredential(input: $input) {
    status
    healthStatus
    errorType
    message
    statusCode
    latencyMs
    stateUpdated
    checkedAt
  }
}
```

Variables:

```json
{
  "input": {
    "providerAccountId": "provider-account-id",
    "model": "model-id"
  }
}
```

## Events To Monitor

Health-producing events:

- `provider.response_completed`
- `provider.response_failed`
- `provider.response_cancelled`
- `provider_account.health_probe_completed`

Health state events:

- `provider_account.health_changed`
- `provider_account.cooldown_started`
- `provider_model.lockout_started`

Routing evidence:

- `routing.decision_recorded` with `healthSkips`.
- Guardrail actions prefixed with:
  - `target_skipped_provider_account_cooldown`
  - `target_skipped_provider_account_terminal`
  - `target_skipped_provider_model_lockout`
  - `target_skipped_provider_model_terminal`

Post-deploy checks:

1. Confirm `provider_attempts.provider_account_id` is populated for BYOK traffic.
2. Confirm `provider_account_health` rows appear after a mocked 429 or manual probe.
3. Confirm request detail health skip evidence is visible for skipped accounts/models.
4. Watch for unexpected growth in `provider_health_unavailable` rejections.

## Follow-Ups

- Provider-wide circuit breakers: `provider_health`, half-open behavior, and provider-wide skip evidence.
- Background probe scheduler: rate-limited, jittered probes with operator controls.
- Provider registry cooldown overrides: provider-specific defaults without code changes.
- Metrics: cooldown count, model lockout count, health skip count, probe result count, and recovery latency.
