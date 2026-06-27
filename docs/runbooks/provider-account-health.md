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
- Bedrock adapter failures preserve sanitized metadata such as region, operation, model/profile, and `bedrockErrorKind`. Secrets and raw upstream response bodies are not stored.
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

## Bedrock Failure Handling

The Bedrock admin health filter exposes these categories:

| Category | Health state | Common cause | Operator action |
| --- | --- | --- | --- |
| Model access denied | Model `terminal` with `last_error_type: model_access_denied` | The IAM principal can call Bedrock but the AWS account has not enabled access to the selected model/profile, or the model ARN is not allowed by IAM | Enable model access in the Bedrock console for the target region and account, or update IAM resources to include the foundation model or inference profile. Run a manual probe after access is granted. |
| Stream permission denied | Model `terminal` only for streaming targets | The principal can use non-streaming `Converse` but lacks `bedrock:InvokeModelWithResponseStream` or the model/profile does not allow streaming | Add `bedrock:InvokeModelWithResponseStream`, verify the model supports streaming, or route non-streaming callers to that model until streaming access is fixed. Non-streaming successes do not clear this streaming-specific model health row. |
| Quota exceeded | Account cooldown with `last_error_type: quota_exhausted` | AWS service quota, throughput, provisioned throughput, or account-level usage limit is exhausted | Check AWS Service Quotas and Bedrock usage, reduce traffic, add fallback targets, request quota increase, or switch to a profile/region with capacity. |
| Throttling | Account cooldown with `last_error_type: rate_limited` | Bedrock returned throttling or too-many-requests | Wait for cooldown, lower concurrency/RPM, add route fallbacks, or use inference profiles/provisioned throughput. |
| Region unavailable | Account cooldown with `last_error_type: provider_unavailable` and Bedrock region metadata | The selected model/profile is unavailable in the configured region, or the regional Bedrock endpoint is unavailable | Confirm runtime region and discovery regions, choose a model available in that region, use a cross-region inference profile, or fail over to another Bedrock account/region. |

Bedrock guardrail interventions are request-only incompatibilities. They produce provider attempt and event evidence but should not poison account or model health because the credential and model can still be healthy for other prompts.

Unknown model metadata appears in the routing editor as missing catalog rows, unknown context/tool/streaming support, or unknown pricing. Add a manual catalog row, run Bedrock discovery for the provider account/region, or add/update the curated metadata overlay before routing production traffic to that model. Unknown metadata should be treated as an operational warning, not as proof that the model is unavailable.

For any Bedrock incident, collect:

1. Provider account id and credential source category.
2. Runtime region and discovery region.
3. Selected model id and resolved inference profile id, if any.
4. Bedrock operation, `Converse` or `ConverseStream`.
5. Request route tier and routing config version.
6. Health skip evidence from the request timeline.

Do not copy AWS access keys, bearer tokens, raw prompt text, or full upstream response bodies into incident notes.

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
5. For Bedrock, confirm `bedrockErrorKind`, region, operation, and model/profile metadata appear in health detail rows without secret material.

## Follow-Ups

- Provider-wide circuit breakers: `provider_health`, half-open behavior, and provider-wide skip evidence.
- Background probe scheduler: rate-limited, jittered probes with operator controls.
- Provider registry cooldown overrides: provider-specific defaults without code changes.
- Metrics: cooldown count, model lockout count, health skip count, probe result count, and recovery latency.
