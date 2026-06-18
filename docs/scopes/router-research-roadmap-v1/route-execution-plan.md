# Route Execution Plan V1

## Goal

Create a durable route execution plan for every proxied request. The plan explains how the router moved from an incoming harness request to the selected provider attempt.

The plan should be recorded after classification and before provider spend. It should survive config changes and be visible from the operations console.

## Why This Matters

The upstream routers all have useful fallback, cooldown, and provider selection behavior, but much of it is implicit. Prompt Proxy should add those capabilities without becoming a black box.

A route execution plan is the shared evidence layer for:

- provider target ordering
- native vs translated eligibility
- skipped targets
- budget and rate-limit gates
- provider account health
- fallback attempts
- final provider selection
- route quality analysis

Without this plan, later features will either hide important behavior in logs or spread explanations across unrelated tables.

## Current State

Prompt Proxy already records route decisions and provider attempts. Those records identify selected route information and provider attempt outcomes, but they do not fully explain:

- every candidate target considered
- why a candidate was skipped
- which compatibility rule matched
- which provider account was considered
- whether the target was native or translated
- whether fallback was planned or applied
- which pre-provider policies affected the route

The existing event and current-state model is the right foundation. This scope expands the route decision payload and projections.

## Target Behavior

For each incoming request:

1. The surface handler authenticates and parses enough envelope data to create route context.
2. The classifier returns a route tier.
3. The routing config version resolves to an ordered target list for that tier.
4. The router builds a plan by evaluating each target for compatibility, policy, account health, budget, and rate limits.
5. The router records the plan before making the provider call.
6. Provider attempts update the execution result as each attempt finishes.
7. The final request record links to the plan, selected target, and terminal provider attempt.

The plan should be immutable for the request. Runtime terminal outcomes can be written as provider attempt rows and terminal events linked to the plan.

## Plan Shape

Draft shape:

```ts
type RouteExecutionPlan = {
  schemaVersion: 1;
  requestId: string;
  organizationId: string;
  workspaceId: string;
  apiKeyId: string;
  surface: "openai-responses" | "openai-chat" | "anthropic-messages";
  dialect: "openai-responses" | "openai-chat" | "anthropic-messages";
  classifier: {
    provider: string;
    model: string;
    route: "fast" | "balanced" | "hard" | "deep";
    confidence: number | null;
    attempts: number;
    dataMode: "metadata" | "redacted_excerpt" | "raw_excerpt";
  };
  routingConfig: {
    id: string;
    versionId: string;
    version: number;
    hash: string;
  };
  candidates: RouteCandidateEvaluation[];
  selected: {
    candidateId: string;
    providerId: string;
    providerAccountId: string | null;
    model: string;
    dialect: string;
    translated: boolean;
  } | null;
  policyResults: RoutePolicyResult[];
};
```

Candidate shape:

```ts
type RouteCandidateEvaluation = {
  id: string;
  order: number;
  providerId: string;
  providerAccountIds: string[];
  model: string;
  endpointDialect: string;
  translated: boolean;
  translatorId: string | null;
  compatible: boolean;
  eligible: boolean;
  skipReasons: RouteSkipReason[];
  factors: {
    nativeDialect: boolean;
    capabilityMatch: boolean;
    contextWindowOk: boolean | null;
    providerHealthy: boolean | null;
    accountAvailable: boolean | null;
    budgetAllowed: boolean | null;
    rateLimitAllowed: boolean | null;
    sessionAffinityMatch: boolean | null;
  };
};
```

Skip reasons should be typed strings, not free-form prose. Examples:

```text
target_unavailable_translator_missing
target_unavailable_previous_response_id
target_unavailable_stateful_websocket
target_unavailable_model_capability
target_skipped_provider_disabled
target_skipped_account_cooldown
target_skipped_model_lockout
target_skipped_budget_limit
target_skipped_rate_limit
target_skipped_missing_credential
```

## Data Model

Add route execution plan storage to `route_decisions`:

```text
route_execution_plan jsonb not null default '{}'
selected_candidate_id text
translated boolean not null default false
translator_id text
```

If the JSON payload becomes too large later, split it into a separate `route_execution_plans` table. V1 should keep it on `route_decisions` to avoid premature table sprawl.

Provider attempt rows should gain:

```text
route_candidate_id text
attempt_index integer
fallback_index integer
skip_reason text
```

Events should include:

```text
routing.plan_recorded
routing.target_skipped
routing.target_selected
```

High-volume candidate skip events can be summarized inside `routing.plan_recorded`; individual skip events are only needed when a target was selected and then skipped at attempt time.

## Runtime Flow

```text
request received
  -> request context
  -> classifier
  -> active routing config
  -> candidate target list
  -> compatibility evaluation
  -> policy and account evaluation
  -> persist route decision + plan
  -> create provider attempt
  -> send provider request
  -> terminal provider event
```

The plan must be recorded before provider spend. If the plan cannot be recorded while persistence is enabled, the request should fail before upstream provider calls.

## Console

Add a route-plan panel to the request detail view:

- classifier route and confidence
- active config version and hash
- target candidates in order
- selected target
- native vs translated label
- skipped target reasons
- provider account selected
- provider attempt terminal status

Add filters:

- translated traffic
- fallback applied
- all candidates skipped
- account cooldown skip
- missing credential skip
- budget/rate-limit skip

## Validation

Unit tests:

- native first target selected
- translated target selected when native unavailable
- `previous_response_id` blocks translated target
- missing credential skips org-defined provider
- provider account cooldown skips candidate
- route plan recorded before provider attempt

Integration tests:

- request detail includes route plan
- route config version hash survives config update
- provider attempt links to selected candidate

## Rollout

1. Add route plan type and persistence column.
2. Populate plan for existing native routing behavior.
3. Render the plan in debug output or request detail.
4. Add candidate skip reasons for existing compatibility checks.
5. Make future fallback and health scopes depend on this plan.

## Non-Goals

- No new fallback behavior in this scope.
- No adaptive target ordering.
- No new providers.
- No broad translation expansion.

## Acceptance Criteria

- Every persisted request with a route decision has a non-empty route execution plan.
- The plan records routing config identity, candidates, selected target, and skip reasons.
- Provider attempts link back to the selected candidate.
- The operations console can explain why the final provider/model was chosen.
