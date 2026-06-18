# Auditable Fallback V1

## Goal

Add provider fallback while preserving Prompt Proxy's audit guarantees.

Fallback means trying another eligible target after a selected target fails before the response has become committed to the client. It must be explicit in the route execution plan, provider attempts, events, and console.

## Why This Matters

LiteLLM, 9router, and OmniRoute all rely on fallback for reliability. Prompt Proxy needs the same reliability, but silent fallback would undermine cost, quality, and compliance analysis.

The rule for Prompt Proxy:

```text
fallback is allowed only when the configured route plan allows it, and every fallback is durable evidence
```

Classifier failure behavior does not change. If classification fails after configured classifier retries, the request still fails before provider spend.

## Current State

Prompt Proxy routes to a selected provider target and records provider attempts. Provider forwarding can retry upstream rate limits before response headers are sent, but there is no comprehensive cross-target fallback plan.

Existing constraints:

- Responses WebSocket traffic is native-only.
- OpenAI Responses requests with `previous_response_id` cannot be translated to another provider.
- Events and provider attempt rows must be persisted durably.
- Prompt text cannot be placed in event payloads.

## Fallback Types

V1 should support three fallback scopes:

### Same Provider Account Retry

Retry the same provider account after a retryable upstream response, respecting `Retry-After` and configured max attempts.

Examples:

- 429 with short retry-after
- 503 transient upstream failure
- network connect timeout before bytes are sent

### Same Provider Different Account

Try another credential/account for the same provider and model.

Examples:

- one BYOK credential is rate-limited
- one subscription credential has a temporary quota window
- one account has local parallelism cap

### Different Target In Route Plan

Try the next target in the configured route tier.

Examples:

- provider unavailable
- model unavailable
- account quota exhausted
- provider-specific request incompatibility

## Non-Fallback Cases

Do not fallback when:

- provider bytes have already been sent to the client and cannot be safely replaced
- the request is stateful Responses with `previous_response_id` and the fallback target cannot own that state
- the request is WebSocket Responses traffic
- the failure is a caller auth or API key policy rejection
- the failure is a budget rejection
- the classifier failed
- the route config does not allow fallback
- the request is non-idempotent and no idempotency key is available

## Config Shape

Add fallback policy to routing config route blocks:

```json
{
  "routes": {
    "balanced": {
      "fallback": {
        "enabled": true,
        "maxProviderAttempts": 3,
        "maxTargetAttempts": 2,
        "allowCrossProvider": true,
        "allowTranslatedFallback": false,
        "retryStatusCodes": [408, 429, 500, 502, 503, 504],
        "respectRetryAfter": true
      },
      "targets": []
    }
  }
}
```

Defaults should be conservative:

```text
enabled: false for existing configs until explicitly activated
same-provider retry: current behavior preserved
cross-provider fallback: opt in
translated fallback: opt in
```

## Data Model

Provider attempts:

```text
attempt_index integer not null
target_index integer not null
fallback_index integer not null default 0
previous_provider_attempt_id text
fallback_reason text
fallback_allowed boolean not null default false
```

Route decisions:

```text
fallback_policy jsonb
fallback_applied boolean not null default false
fallback_count integer not null default 0
```

Events:

```text
fallback.evaluated
fallback.applied
fallback.exhausted
fallback.blocked
```

## Runtime Flow

```text
route plan recorded
  -> provider attempt 0
  -> terminal failure before response committed
  -> classify failure
  -> check fallback policy
  -> update health state
  -> select next eligible account or target
  -> append fallback.applied
  -> provider attempt 1
```

Fallback selection uses the existing route execution plan. It should not invent new targets outside the active routing config.

## Idempotency

Fallback can create duplicate upstream work if a provider received the request but failed before Prompt Proxy observed a terminal response. V1 should:

- compute or accept an idempotency key before provider work
- include idempotency headers where providers support them
- record provider request id when available
- avoid fallback after ambiguous commit unless policy explicitly allows it
- mark ambiguous attempts as `terminal_pending` for reconciliation

## Streaming Rules

Fallback is allowed only before the client stream is committed.

Cases:

- upstream returns JSON error before stream: fallback allowed if policy allows
- upstream SSE emits provider error before first content: fallback allowed if response not committed
- upstream stream starts content then fails: no fallback; record stream failure
- client disconnects: no fallback; record cancellation

## Console

Request detail should show a fallback timeline:

```text
attempt 0: openai/gpt-5.2-mini, account A, failed 429, retry-after 60s
fallback: target skipped due account cooldown
attempt 1: anthropic/claude-sonnet, account B, success
```

Summary dashboards:

- fallback rate by route
- fallback rate by provider
- fallback reasons
- fallback success rate
- cost impact of fallback
- translated fallback rate

## Validation

Unit tests:

- classifier failure does not fallback
- budget rejection does not fallback
- 429 before stream can fallback
- stream failure after content does not fallback
- `previous_response_id` blocks translated fallback
- route plan constrains fallback targets

Integration tests:

- provider A mock fails, provider B succeeds
- fallback events are appended
- provider attempts are linked
- request detail renders fallback timeline

## Rollout

1. Add fallback policy schema with disabled default.
2. Preserve existing same-provider retry behavior.
3. Add route execution plan linkage.
4. Add cross-account fallback.
5. Add cross-target fallback behind explicit config.
6. Add translated fallback only after harness compatibility tests exist.

## Non-Goals

- No deterministic route fallback when the classifier fails.
- No fallback to provider targets outside the route config.
- No silent fallback.
- No post-content streaming fallback.
- No adaptive fallback ordering.

## Acceptance Criteria

- Fallback only happens when policy allows it.
- Every fallback has typed reason and event evidence.
- Provider attempts show attempt order and fallback relationship.
- Console request detail explains the fallback timeline.
- Stateful and already-committed requests do not fallback unsafely.
