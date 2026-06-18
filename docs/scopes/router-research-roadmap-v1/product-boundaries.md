# Product Boundaries V1

## Goal

Define hard product boundaries for Prompt Proxy as it borrows ideas from LiteLLM, 9router, Kong, and OmniRoute.

This scope is a guardrail. It prevents the roadmap from turning Prompt Proxy into a generic gateway, local free-tier router, prompt mutation engine, or opaque plugin host.

## Why This Matters

The upstream projects are useful but pull in different directions:

- LiteLLM optimizes for broad AI gateway coverage.
- 9router optimizes for local coding-agent convenience and provider hopping.
- Kong optimizes for generic API gateway extensibility.
- OmniRoute optimizes for free/subscription aggregation and a very broad local product.

Prompt Proxy has a narrower, stronger product:

```text
an organization-scoped, protocol-aware model-routing gateway for coding-agent traffic with durable audit
```

The boundaries protect that product.

## Core Commitments

### Classifier-First Routing

The LLM classifier remains the route tier authority.

Allowed:

- classifier retries
- structured output validation
- low-confidence flagging
- route execution plan explanation

Not allowed:

- deterministic route fallback when classifier fails
- regex-based replacement for classifier route selection
- provider spend after classifier failure

### Native-First Forwarding

Native provider dialects are preferred.

Allowed:

- same-dialect byte-preserving forwarding
- explicit translated paths
- compatibility matrix
- translator golden tests

Not allowed:

- default SDK-shaped intermediate serialization for every request
- hidden protocol mutation
- WebSocket state emulation in V1

### Durable Audit Before Spend

When persistence is enabled, route decision evidence must be written before provider spend.

Allowed:

- terminal reconciliation when provider bytes were already committed
- event and outbox writes in the same transaction
- current-state projections

Not allowed:

- silent provider calls with no route decision
- raw prompt text in event payloads
- best-effort-only audit for production traffic

### Workspace-Scoped Governance

Traffic state is scoped by organization and workspace.

Allowed:

- organization provider defaults
- workspace routing config assignments
- API-key limits
- BYOK provider account binding

Not allowed:

- unscoped provider account state
- cross-workspace credential pooling unless explicitly designed and audited
- local-only state as production authority

## Explicit Non-Goals

### Generic API Gateway

Prompt Proxy should not become Kong.

Out of scope:

- arbitrary URL route matching
- generic request/response transformer plugins
- non-LLM service proxying
- consumer/plugin/service entity model copied wholesale

Borrow:

- phase model
- safe config activation
- metrics discipline
- control-plane readiness

### Free-Tier Aggregator

Prompt Proxy should not become a free-provider optimizer.

Out of scope:

- routing to maximize free quota
- subscription draining as a product goal
- anti-ban or anti-detection behavior
- provider terms evasion
- fragile unofficial web surfaces as default provider targets

Borrow:

- quota concepts
- provider health and cooldown
- capability-aware target selection

### Local Personal Credential Router

Prompt Proxy is organization/workspace scoped.

Out of scope:

- local SQLite as production authority
- plaintext local provider secrets
- default local password assumptions
- machine-local sync identity as a security model

Borrow:

- onboarding clarity
- CLI/harness setup flows
- local dev seeds

### Arbitrary Hot-Path Plugins

Prompt Proxy should not expose arbitrary user plugins in the request path yet.

Out of scope:

- untrusted code execution
- marketplace hooks for request mutation
- plugin-controlled provider selection

Borrow:

- internal phase pipeline
- typed context
- explicit policy extension points later

### General Prompt Rewriting

Prompt Proxy should not become a prompt rewriting engine by default.

Out of scope:

- hidden prompt summarization
- automatic instruction rewriting
- memory injection in proxy hot path
- model-generated prompt compression in V1

Allowed:

- explicit tool-output compression
- measure-only compression analytics
- opt-in deterministic filters
- artifact-backed receipts

### MITM And Tool Cloaking

Out of scope:

- TLS interception
- tool cloaking
- client impersonation beyond documented harness configuration
- anti-detection provider behavior

## Feature Admission Checklist

Every new router feature should answer:

1. Does it preserve classifier-first routing?
2. Does it preserve native-first forwarding?
3. Does it record durable route evidence before provider spend?
4. Is raw prompt text kept out of events?
5. Is traffic state scoped by organization and workspace?
6. Is the behavior visible in the console?
7. Is the behavior covered by harness fixtures or provider mocks?
8. Can an operator disable it per workspace or routing config?
9. Does it avoid leaking operator credentials to org-defined providers?
10. Does it improve routing reliability, cost visibility, or harness compatibility?

If the answer is no, the feature should be rejected or rescoped.

## Review Criteria

For PRs touching routing:

- route execution plan updated
- event taxonomy updated
- no raw prompt text in events
- provider account scoping preserved
- compatibility tests updated
- console visibility considered
- docs updated

For PRs touching providers:

- credential invariant preserved
- auth headers not stored in default headers
- private network validation considered
- model capabilities documented
- pricing source documented

For PRs touching compression:

- measure-only path exists
- deterministic tests exist
- no-growth guarantee exists
- receipts are persisted
- org prompt-capture policy is respected

## Console Visibility

Any feature that changes routing behavior should have operator-visible evidence:

- route plan details
- skip reasons
- fallback timeline
- health state
- limit rejection
- compression receipt
- translated path label

If operators cannot see it, it should not silently affect provider selection.

## Documentation Requirements

Product behavior changes should update:

- relevant scope doc
- README if operator-facing
- runbook if operational
- compatibility matrix if harness behavior changes
- architecture doc if event or provider model changes

## Acceptance Criteria

- The roadmap has explicit non-goals.
- Feature reviews can use a concrete checklist.
- Future scopes can refer to these boundaries instead of relitigating product direction.
- The project does not accidentally inherit unsafe upstream behaviors while borrowing useful ideas.
