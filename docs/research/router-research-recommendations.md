# Router Research Aggregate Recommendations

Sources reviewed:

- [LiteLLM](litellm-scope.md)
- [9router](9router-scope.md)
- [Kong](kong-scope.md)
- [OmniRoute](omniroute-scope.md)
- [Second-pass implementation follow-up](router-upstream-implementation-follow-up.md)

Compared system: Prompt Proxy in this repository

## Executive Summary

The four upstream projects point toward the same conclusion: Prompt Proxy should become more operationally mature without becoming a broad, opaque AI gateway.

Prompt Proxy's strongest current advantages are:

- Classifier-first routing with no deterministic fallback when classification fails.
- Native harness fidelity for Codex, Claude Code, and OpenAI/Anthropic-compatible clients.
- Durable request, route, provider-attempt, usage, prompt-artifact, event, and outbox capture.
- Organization and workspace scoping.
- Versioned routing configs.
- A narrow enough architecture to reason about.

The main gap is operating depth. LiteLLM and OmniRoute show mature provider-account handling, budget controls, fallback, quota, and health. 9router and OmniRoute show how much harness-specific translation testing is needed. Kong shows how gateway policy, config activation, metrics, and runtime reloading should be structured.

The recommended direction is:

1. Keep Prompt Proxy's core routing philosophy.
2. Add a typed policy pipeline and route execution plan.
3. Add provider/account/model health, cooldown, quota, and fallback evidence.
4. Add translator golden tests and harness profiles before broad cross-dialect expansion.
5. Add rate, budget, and parallelism controls at API-key and workspace boundaries.
6. Add explicit, audited token compression for tool outputs.
7. Add operational dashboards and metrics backed by durable events.
8. Defer adaptive routing and broad plugin ecosystems until enough event-backed evidence exists.

## Cross-Repo Themes

### Provider Breadth Is Easy To Add And Hard To Operate

LiteLLM, 9router, and OmniRoute all support many providers. The hard part is not adding a base URL and auth header. The hard part is:

- Provider-specific error classification.
- Auth refresh and credential ownership.
- Model capability drift.
- Rate-limit and quota semantics.
- Streaming edge cases.
- Tool-call differences.
- Cost and usage normalization.
- Operator trust boundaries.

Prompt Proxy should prioritize durable provider account state and capability metadata before racing to provider count.

### Fallback Must Be Observable

All comparison routers use fallback heavily. Prompt Proxy should add fallback, but never silently. Every fallback decision should answer:

- What target was planned?
- What target was skipped?
- Why was it skipped?
- What retry-after, health, quota, or policy evidence caused the skip?
- What target was tried?
- What terminal status did it produce?
- Did the request cross dialects?
- Did the route stay within the configured policy?

This should be captured in route decisions, provider attempts, and events.

### Native Fidelity Is A Product Advantage

9router and OmniRoute show the large cost of translating among OpenAI Chat, OpenAI Responses, Claude, Gemini, Cursor, Kiro, and related shapes. Translation is valuable, but native pass-through paths are safer for coding harnesses.

Prompt Proxy should continue to prefer native endpoints, then allow translated paths only when the routing config and translator registry declare compatibility.

### Events Are Better Than Logs For This Product

LiteLLM, 9router, and OmniRoute all have useful request and usage logging. Kong has strong metrics. Prompt Proxy's event-backed model is still stronger for replay, audit, and governance. The improvement is to add the missing operational event types and projections, not to replace events with logs.

### Policy Needs A Phase Model

Kong has the cleanest answer: request handling should have named phases. Prompt Proxy does not need arbitrary plugins yet, but it does need a built-in phase model so auth, budgets, classification, target resolution, translation, streaming, and accounting do not keep spreading across handlers and helpers.

## Recommended Product Shape

Prompt Proxy should remain a protocol-aware model-routing gateway for organizations and workspaces. It should not become:

- A generic API gateway.
- A free-tier aggregator.
- A local personal subscription drainer.
- A prompt-rewriting engine.
- A plugin marketplace in the hot path.
- A universal provider SDK.

The product should become:

- A reliable routing control plane for coding-agent traffic.
- A durable audit trail for route, cost, prompt, and provider behavior.
- An operations console for provider health, spend, budgets, keys, and route quality.
- A safe translation gateway for explicitly supported harness/provider combinations.
- A measured token-cost reduction layer where mutations are opt-in and auditable.

## Highest-Leverage Improvements

### 1. Route Execution Plan

Add an explicit route execution plan to every route decision. It should be produced after classification and before provider spend.

The plan should include:

- Classifier result and confidence.
- Routing config id, version, and hash.
- Requested surface and dialect.
- Candidate targets in order.
- Native or translated path for each target.
- Provider account candidates.
- Compatibility checks.
- Budget and rate-limit gates.
- Cooldown and health skip reasons.
- Retry and fallback policy.
- Final selected provider attempt id.

This is the anchor that lets Prompt Proxy add LiteLLM/OmniRoute-style resilience without losing auditability.

### 2. Provider Registry And Capability Catalog

Expand provider architecture into a durable registry:

- Provider rows: id, display name, supported dialects, endpoints, auth style, default headers, timeout, retry policy.
- Provider account rows: workspace/org scope, credential reference, owner, status, cooldown, last health, last error.
- Model catalog rows: model id, provider id, dialect support, tools, vision, reasoning, context, max output, cost, unsupported params.
- Capability source: static seed, models.dev, provider API, operator override, assessment probe.
- Catalog version and last synced time.

Use code-seeded catalogs as defaults, but make Postgres the runtime authority.

### 3. Provider Health, Cooldown, And Lockout

Add current-state tables and events for:

- Provider account cooldown.
- Provider/model lockout.
- Provider-level circuit breaker.
- Quota exhaustion.
- Auth failure.
- Context overflow.
- Model unavailable.
- Retry-after source and expiry.

Use these states to filter route targets. Record every filter result as route decision evidence.

### 4. Budget, Rate, And Parallelism Controls

Add limits beyond routing-config max input:

- Requests per minute by API key and workspace.
- Tokens per minute by API key and workspace.
- Parallel requests by API key and provider account.
- Daily, weekly, monthly budget windows.
- Warning thresholds.
- Pre-call estimated spend reservation.
- Post-call true-up from actual usage.

Rejections should happen before provider spend and append typed events.

### 5. Harness Profiles And Translator Golden Tests

Create explicit harness profiles:

- Codex OpenAI Responses HTTP.
- Codex Responses WebSocket.
- Claude Code Anthropic Messages.
- OpenAI-compatible Chat Completions.
- opencode.
- Cursor BYOK.

Each profile should define:

- Accepted endpoints.
- Native dialect.
- Required request fields.
- Required response fields.
- Streaming event expectations.
- Tool-call behavior.
- Session/state fields.
- Known unsupported translated paths.

Then build golden tests for each allowed translation path. Do not expand translated routing without fixtures.

### 6. Internal Policy Pipeline

Define a typed pipeline with named phases:

1. `request.parse`
2. `caller.authenticate`
3. `workspace.resolve`
4. `prompt.capture_policy`
5. `api_key.policy`
6. `budget.preflight`
7. `rate_limit.preflight`
8. `routing.classify`
9. `routing.plan`
10. `provider.select_account`
11. `provider.prepare_request`
12. `provider.send`
13. `stream.observe`
14. `provider.finalize`
15. `usage.price`
16. `events.commit`
17. `metrics.emit`

This should be built-in and typed. Arbitrary user plugins should remain out of scope until the core phases are stable.

### 7. Tool-Output Compression

Add an explicit route-config option for compression:

- `disabled`
- `measure_only`
- `compress_safe_tool_outputs`

Start with tool results, not general prompt rewriting. For each compression action, record:

- Filter id.
- Original token estimate.
- Compressed token estimate.
- Original artifact hash.
- Compressed artifact hash.
- Savings estimate.
- Whether raw original was retained under prompt-capture policy.

This borrows from 9router and OmniRoute while respecting Prompt Proxy's audit model.

### 8. Model Assessment Jobs

Add background probes that write events and projections:

- Basic availability.
- Streaming availability.
- Tool-call support.
- Vision support when expected.
- Latency sample.
- Auth failure.
- Rate-limited status.
- Model unavailable status.

Assessment results should appear in the provider console and route planner. They should not silently override routing configs at first.

### 9. Metrics Layer

Add bounded-cardinality metrics:

- Requests by workspace, surface, route tier, provider, model, status.
- Provider attempts by terminal status.
- Fallback count.
- Retry count.
- Time to first token.
- Provider latency.
- Input/cache/output/reasoning tokens.
- Cost.
- Budget rejections.
- Rate-limit rejections.
- Active routing config version.
- Provider account cooldown count.

Metrics support operations. Events remain the source of truth.

### 10. Admin Console Improvements

The operations console should add pages or panels for:

- Provider health and cooldowns.
- Provider account credential status.
- Route execution plan drilldowns.
- Fallback and retry analysis.
- Budget windows and spend alerts.
- Translation compatibility and harness profile status.
- Unpriced models and missing capability data.
- Compression savings.
- Assessment probe history.

Keep the UI dense and operational.

## Prioritized Roadmap

### Phase 1: Routing Evidence And Provider State

Goal: make route behavior explainable before adding more behavior.

- Add route execution plan shape.
- Add skip reason taxonomy.
- Add provider account health fields.
- Add provider/model lockout current state.
- Add events for cooldown, skip, retry, fallback, and budget/rate rejection.
- Show route execution plan and provider attempt evidence in the console.

### Phase 2: Provider Registry V2

Goal: make provider and model capability data durable and governable.

- Move runtime provider registry to Postgres-backed rows.
- Add provider account credential references.
- Add model catalog capabilities.
- Seed OpenAI, Anthropic, Codex subscription, and Claude subscription.
- Add registry validation and config activation checks.
- Add last-known-good runtime graph hash.

### Phase 3: Policy Pipeline And Limits

Goal: organize the request path and add core operating controls.

- Introduce typed policy context.
- Split phases out of route handlers.
- Add API-key/workspace rate limits.
- Add parallel request limits.
- Add budget windows and post-call true-up.
- Add metrics for each rejection and phase outcome.

### Phase 4: Translation Quality

Goal: expand cross-dialect routing safely.

- Add harness profiles.
- Add golden translator tests.
- Add streaming edge-case tests.
- Add compatibility matrix to docs and console.
- Reject unsupported translated paths before provider selection.

### Phase 5: Token Cost Reduction

Goal: reduce cost without hidden prompt mutation.

- Add compression measure-only mode.
- Add RTK-style safe tool-result filters.
- Add compression artifacts and savings projections.
- Add per-route compression enablement.
- Add replay harness and golden compression tests.

### Phase 6: Assessment And Adaptive Recommendations

Goal: use evidence to improve routing without ceding control too early.

- Add model assessment jobs.
- Add route quality labels from outcomes and evals.
- Add dashboard recommendations for routing config changes.
- Add opt-in latency or health target ordering inside a configured tier.
- Defer fully adaptive routing until enough labeled outcomes exist.

## Non-Goals

Do not pursue these now:

- Arbitrary user plugins in the request path.
- MITM behavior.
- Tool cloaking or anti-detection behavior.
- Free-provider aggregation as a product goal.
- Broad prompt rewriting.
- General API gateway routing.
- Rule-based route fallback when classifier calls fail.
- Static provider catalog as runtime authority.
- Silent fallback across provider families.

## Suggested Implementation Tickets

Detailed scoping documents for these recommendations now live under
[Router Research Roadmap V1](../scopes/router-research-roadmap-v1/README.md).

### Ticket A: Route Execution Plan V1

Add a `route_execution_plan` payload to route decisions. Include candidates, compatibility, skip reasons, selected target, and fallback policy. Persist it with the existing request and route decision transaction.

### Ticket B: Provider Account Health V1

Add provider account health fields and events for cooldown, rate limit, auth failure, model lockout, and provider failure. Use these states in target selection and expose them in the providers console.

### Ticket C: Harness Profile Test Matrix

Add test fixtures for Codex Responses, Claude Code Messages, and Chat Completions native paths. Add one explicit translated path only after the fixture harness exists.

### Ticket D: Rate And Budget Limits V1

Implement API-key/workspace request rate limits, token rate limits, parallel request caps, and budget windows. Emit pre-provider rejection events.

### Ticket E: Tool-Output Compression Measure Mode

Add compression detection and measurement for tool outputs without changing provider requests. Record estimated savings and candidate filters.

### Ticket F: Runtime Graph Activation

Build an in-memory active routing graph from provider registry, model catalog, provider accounts, and active routing config. Add hash, validation, last-known-good behavior, and health reporting.

## Final Recommendation

Prompt Proxy should take the operating maturity of LiteLLM, the harness compatibility discipline of 9router, the gateway phase/config discipline of Kong, and the resilience/test vocabulary of OmniRoute.

The architecture should stay hard-edged:

- Classifier-first routing.
- Native-first forwarding.
- Explicit translated paths.
- Durable events before provider spend.
- Workspace-scoped governance.
- No silent mutation.

That combination gives Prompt Proxy the best chance to become a serious production router without losing the properties that make it safer and easier to reason about than the broader upstream gateways.
