# Policy Pipeline V1

## Goal

Introduce a typed, phase-based request pipeline for proxy traffic.

The pipeline should keep route handlers thin, centralize policy decisions, and make each request phase observable. This borrows Kong's strongest architectural lesson without adding arbitrary third-party plugins.

## Why This Matters

Prompt Proxy's architecture rule says transport handlers are boundaries. As provider health, budgets, fallback, translation, compression, and metrics grow, the request path needs structure or business logic will leak into route handlers and provider adapters.

A phase-based pipeline gives each concern a named place:

- auth
- workspace resolution
- prompt capture policy
- budget and rate limits
- classification
- route planning
- provider account selection
- translation
- streaming observation
- usage and cost
- events and metrics

## Current State

Prompt Proxy already has services for routing, provider forwarding, persistence, pricing, prompt artifacts, and events. The issue is not absence of primitives; it is that future policy features need a stable orchestration contract.

## Target Pipeline

Phases:

```text
request.parse
caller.authenticate
workspace.resolve
prompt.capture_policy
api_key.policy
budget.preflight
rate_limit.preflight
routing.classify
routing.plan
provider.select_account
provider.prepare_request
provider.send
stream.observe
provider.finalize
usage.price
events.commit
metrics.emit
```

Each phase receives a typed context and returns a typed result:

```ts
type PolicyPhaseResult =
  | { status: "continue"; contextPatch?: Partial<RequestPipelineContext> }
  | { status: "reject"; response: Response; eventType: string; reason: string }
  | { status: "defer"; reason: string };
```

## Pipeline Context

Draft context:

```ts
type RequestPipelineContext = {
  requestId: string;
  correlationId: string;
  organizationId: string | null;
  workspaceId: string | null;
  apiKeyId: string | null;
  userId: string | null;
  surface: string;
  dialect: string;
  harnessProfileId: string | null;
  rawRequestMetadata: Record<string, unknown>;
  parsedEnvelope: Record<string, unknown>;
  promptArtifactIds: string[];
  classifierResult: ClassifierResult | null;
  routingConfigIdentity: RoutingConfigIdentity | null;
  routeExecutionPlan: RouteExecutionPlan | null;
  selectedProviderAccountId: string | null;
  providerAttemptId: string | null;
  usage: NormalizedUsage | null;
  cost: CostBreakdown | null;
  events: PendingEvent[];
  metrics: PendingMetric[];
};
```

Do not put raw prompt text in this context unless it is already governed by prompt artifact policy. Prefer artifact ids and redacted excerpts.

## Phase Contracts

### request.parse

Extract request envelope, surface, dialect, model hint, stream flag, and content length.

Reject:

- invalid JSON
- unsupported endpoint
- body too large

### caller.authenticate

Resolve API key, organization, workspace, and user where possible.

Reject:

- missing key when required
- revoked key
- expired key
- invalid hash

### workspace.resolve

Attach workspace and organization identity. Every traffic-scoped table must have workspace scope.

### prompt.capture_policy

Decide whether to store raw prompt artifact, hash-only artifact, or no artifact based on org/workspace settings.

### api_key.policy

Apply allowed model/profile/route config policy for the API key.

### budget.preflight

Estimate spend and reject or reserve budget before classifier/provider spend when policy requires it.

### rate_limit.preflight

Apply request, token, and parallelism limits.

### routing.classify

Call the classifier. If classifier attempts are exhausted, fail before provider spend.

### routing.plan

Build and persist the route execution plan.

### provider.select_account

Resolve provider account, credential, health state, cooldown, and session affinity.

### provider.prepare_request

Apply native rewrite, translation, provider headers, and safe compression where configured.

### provider.send

Create provider attempt, send upstream request, and stream response.

### stream.observe

Observe SSE or JSON response without perturbing client behavior.

### provider.finalize

Record terminal provider attempt status and health updates.

### usage.price

Normalize usage, compute cost, and write usage ledger projection.

### events.commit

Append events and outbox records in the same transaction as current-state changes where persistence is enabled.

### metrics.emit

Emit bounded-cardinality metrics from the final context.

## Error Handling

Each phase should classify errors as:

```text
caller_error
policy_rejection
classifier_failure
route_unavailable
provider_failure
stream_failure
persistence_failure
internal_error
```

Persistence failure before provider spend should fail closed. Persistence failure after bytes are committed should mark terminal reconciliation work where possible.

## Implementation Shape

Suggested modules:

```text
apps/proxy/src/pipeline/context.ts
apps/proxy/src/pipeline/phases/*.ts
apps/proxy/src/pipeline/runPipeline.ts
apps/proxy/src/pipeline/results.ts
```

Surface handlers should call a small entry point:

```ts
return runProxyPipeline(request, { surface: "openai-responses" });
```

Provider adapters should stay focused on outbound HTTP details.

## Events And Audit

Do not emit one event for every successful phase by default. Instead:

- always emit request received
- always emit route plan recorded
- always emit provider attempt terminal
- emit rejection events for rejected phases
- emit health, fallback, and compression events when those features act
- add phase timings to request metadata or metrics

## Console

Request detail can show phase timing:

- parse
- auth
- classifier
- route planning
- provider connect
- time to first token
- terminal finalize

Failures should show which phase rejected or failed.

## Validation

Unit tests:

- phases run in order
- reject short-circuits later phases
- classifier failure stops before provider phase
- route plan phase persists before provider send
- context does not carry raw prompt text into events

Integration tests:

- successful native request traverses expected phases
- policy rejection records rejection event
- provider failure records terminal attempt

## Rollout

1. Add context type and no-op phase runner around current flow.
2. Move auth and workspace resolution into phases.
3. Move classification and route planning into phases.
4. Move provider finalization and usage into phases.
5. Add phase timings to metrics.

## Non-Goals

- No arbitrary user-defined plugins.
- No external hook marketplace.
- No behavioral changes to routing in the first refactor.
- No raw prompt text in phase events.

## Acceptance Criteria

- Route handlers call a shared pipeline entry point.
- Each policy decision has a named phase.
- Request detail can identify the phase that rejected or failed.
- Route execution plan persists before provider spend.
- New policy features have an obvious phase to integrate with.
