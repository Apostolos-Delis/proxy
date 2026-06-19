# Route Execution Plan V1

## Status

Implemented as the durable evidence layer for current router behavior. V1 records how the router moved from a classified request to the selected provider target, without adding fallback, adaptive ordering, provider health enforcement, or new providers.

The plan is recorded after classification and before provider spend. It is persisted with the route decision, linked to provider attempts, and exposed to admin-only GraphQL consumers and the operations console.

## Goal

Create a stable route planning contract that later router scopes can build on:

- provider account health
- auditable fallback
- provider registry V2
- policy pipeline
- limits and budgets
- harness compatibility tests
- route quality analysis

The plan is immutable evidence for a request. Terminal outcomes still live on provider attempts and request/provider terminal events.

## Runtime Flow

```text
request received
  -> request context
  -> classifier
  -> active routing config version
  -> ordered targets for the selected route tier
  -> compatibility, credential, and budget evidence
  -> routing.plan_recorded
  -> provider.request_started
  -> upstream provider call
  -> provider/request terminal events
```

When persistence is enabled, failing to append the route plan event fails the request before an upstream provider call. This preserves the invariant that provider spend has durable pre-spend evidence.

## Contract

The shared contract lives in `packages/schema` as `routeExecutionPlanSchema` and `RouteExecutionPlan`.

```ts
type RouteExecutionPlan = {
  schemaVersion: 1;
  requestId: string;
  organizationId: string;
  workspaceId: string;
  apiKeyId: string;
  surface: "openai-responses" | "anthropic-messages" | "openai-chat";
  dialect: "anthropic-messages" | "openai-responses" | "openai-chat";
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
  selected: RouteSelectedTarget | null;
  policyResults: RoutePolicyResult[];
};
```

Candidate evaluations are ordered by the immutable routing config target order for the selected route tier:

```ts
type RouteCandidateEvaluation = {
  id: string;
  order: number;
  providerId: string;
  providerAccountIds: string[];
  model: string;
  endpointDialect: "anthropic-messages" | "openai-responses" | "openai-chat";
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

Selected targets must reference one planned candidate:

```ts
type RouteSelectedTarget = {
  candidateId: string;
  providerId: string;
  providerAccountId: string | null;
  model: string;
  dialect: "anthropic-messages" | "openai-responses" | "openai-chat";
  translated: boolean;
};
```

Policy results capture pre-provider checks such as budget gates:

```ts
type RoutePolicyResult = {
  id?: string;
  policy: string;
  status: "allowed" | "blocked" | "skipped" | "unknown";
  skipReason: RouteSkipReason | null;
  current?: number | string | null;
  limit?: number | string | null;
};
```

Schema invariants:

- candidate ids are unique
- `selected.candidateId` references a candidate in the same plan
- selected provider, model, dialect, and translation flag match the referenced candidate
- selected provider account, when present, is listed on that candidate
- unknown schema versions and unknown skip reasons fail validation
- raw prompt text is not part of the contract

## Skip Reasons

V1 uses typed skip reasons only.

Populated by current runtime behavior:

```text
target_unavailable_translator_missing
target_unavailable_previous_response_id
target_unavailable_stateful_websocket
target_unavailable_stateful_translation
target_unavailable_dialect
target_unavailable_provider_not_found
target_unavailable_provider_registry
target_skipped_provider_disabled
target_skipped_missing_credential
```

Reserved for follow-up scopes:

```text
target_unavailable_model_capability
target_skipped_account_cooldown
target_skipped_model_lockout
target_skipped_budget_limit
target_skipped_rate_limit
```

Reserved values are accepted by the schema so provider health, fallback, rate-limit, and policy-pipeline work can use the same contract without another migration.

## Persistence

Migration `0019_route_execution_plan.sql` adds route plan evidence to existing current-state rows.

`route_decisions`:

```text
route_execution_plan jsonb not null default '{}'
selected_candidate_id text
translated boolean not null default false
translator_id text
```

`provider_attempts`:

```text
route_candidate_id text
attempt_index integer
fallback_index integer
skip_reason text
```

`routing.plan_recorded` is the V1 route plan event. The event projector validates the plan and writes the plan JSON, selected candidate id, selected provider/model, translation metadata, classifier route, and routing config snapshot into `route_decisions`.

`provider.request_started` carries `routeCandidateId`, `attemptIndex`, and `fallbackIndex`. Current single-attempt behavior writes `attemptIndex = 0` and `fallbackIndex = 0`; future fallback will increment these values instead of inventing another linkage model.

High-volume unselected candidate skips are summarized inside `route_execution_plan.candidates[].skipReasons`. V1 does not emit individual `routing.target_skipped` or `routing.target_selected` events.

## Admin API

Admin GraphQL exposes the plan through reusable routing evidence types:

- `RouteDecision.routeExecutionPlan`
- `RouteDecision.selectedCandidateId`
- `RouteDecision.translated`
- `RouteDecision.translatorId`
- `ProviderAttempt.routeCandidateId`
- `ProviderAttempt.attemptIndex`
- `ProviderAttempt.fallbackIndex`
- `ProviderAttempt.skipReason`

`request(requestId:)` and `promptDetail(artifactId:)` return route decisions and provider attempts for admin users. Lower-privilege users receive empty route evidence arrays and cannot read route plan JSON, classifier internals, routing config snapshots, selected candidate ids, translation flags, or skip reason filters.

Request list summaries stay lightweight. They select only summary columns from `route_decisions`; they do not fetch or serialize the `route_execution_plan` JSON. The list exposes admin-gated summary fields:

- `selectedCandidateId`
- `translated`
- `routeSkipReasons`

`routeSkipReasons` on the request list comes from persisted `provider_attempts.skip_reason`, not from scanning unexecuted candidates inside plan JSON. Candidate-level skip evidence is available in detail views.

## Console

The operations console shows route evidence in the prompt detail route plan card:

- classifier route, confidence, model, and data mode
- routing config id, version, and hash
- selected provider, model, dialect, and translation mode
- ordered candidate table
- candidate eligibility and skip reasons
- provider attempts linked to each candidate

The request log adds filters for:

- native vs translated traffic
- provider-attempt skip reasons

Older rows with the default empty plan continue to render without a route plan card.

## V1 Boundaries

Implemented:

- plan schema in `packages/schema`
- route decision and provider attempt persistence columns
- `routing.plan_recorded` event projection
- plan construction for the selected route tier's configured targets
- translation compatibility skip reason mapping
- custom-provider missing credential evidence
- allowed budget policy result evidence
- provider attempt candidate linkage
- admin GraphQL route evidence
- prompt detail route plan UI
- request log translated/skip filters

Not implemented in V1:

- fallback execution
- adaptive target ordering
- provider/account health scoring
- account cooldown or model lockout enforcement
- rate-limit enforcement
- context window estimation
- broad translation expansion
- new providers
- per-candidate skip events outside the plan JSON

## Rollout

For persistence-enabled environments:

1. Apply migration `0019_route_execution_plan.sql`.
2. Deploy proxy code that writes `routing.plan_recorded` before provider attempts.
3. Regenerate GraphQL schema and web client types when changing route evidence fields.
4. Expect existing rows to have `route_execution_plan = {}` and `translated = false`; no backfill is required.
5. Verify new requests produce non-empty plans before relying on route evidence in follow-up scopes.

Validation used for this scope:

```bash
pnpm --filter @prompt-proxy/schema test
pnpm --filter @prompt-proxy/db test
pnpm --filter @prompt-proxy/proxy schema:print
pnpm --filter @prompt-proxy/web codegen
pnpm --filter @prompt-proxy/proxy typecheck
pnpm --filter @prompt-proxy/web typecheck
pnpm --filter @prompt-proxy/web test
pnpm --dir apps/proxy exec vitest run test/persistence.test.ts test/routingConfigRuntime.test.ts test/adminAuthorization.test.ts
```

## Acceptance Criteria

- Every new persisted routed request records a validated route execution plan before provider spend.
- The plan records routing config identity, ordered candidates, selected target, policy evidence, and typed skip reasons.
- Provider attempts link back to the selected route candidate.
- Detail APIs can explain why the final provider/model was chosen.
- Request list APIs stay lightweight and admin-gated.
- Later provider health, fallback, limits, and policy scopes can extend evidence without replacing the contract.
