# OmniRoute Scoping Review

Source: https://github.com/diegosouzapw/OmniRoute
Local clone reviewed: `.context/upstreams/OmniRoute`
Commit reviewed: `dd5a3db55ed9bca1f71398e6e584da2983a70bea` from 2026-06-17
Compared system: Prompt Proxy in this repository

## Executive Summary

OmniRoute is a local-first AI gateway and dashboard aimed at coding agents, free/subscription provider aggregation, automatic fallback, RTK plus prompt compression, MCP/A2A, CLI setup, evals, plugins, memory, and many provider integrations. It overlaps heavily with 9router in architecture and goals, but it is larger and more feature-heavy.

The useful parts for Prompt Proxy are its explicit resilience vocabulary, quota preflight work, auto-combo scoring factors, continuous model assessment, compression harnesses, and extensive compatibility tests. The risky parts are the same features taken too far: very broad request-path complexity, aggressive provider hopping, local-secret trust model, product features that encourage using fragile unofficial provider surfaces, and a large static provider catalog.

Prompt Proxy should treat OmniRoute as a catalog of product ideas and edge-case handling patterns, not as an architecture to replicate.

## Architecture

### Runtime Shape

OmniRoute is a Next.js application with an `open-sse` routing core. It ships as a local app, CLI package, Docker image, and Electron/PWA-oriented product. The repo includes:

- Compatibility endpoints under `/v1`.
- Management APIs and dashboard pages.
- A TypeScript routing domain layer.
- Provider registry and executor implementations.
- Translation among OpenAI, Responses, Claude, Gemini, Cursor, Kiro, Antigravity, and more.
- Combos and auto-combo routing.
- Quota, cooldown, circuit breaker, and model lockout logic.
- Compression engines including RTK filters.
- SQLite-backed local persistence.
- Evals, probes, monitoring, webhooks, memory, guardrails, MCP/A2A, plugins, and MITM tooling.

Important reviewed areas:

- `README.md`
- `src/app/api/v1/*`
- `src/sse/handlers/chat.ts`
- `open-sse/handlers/chatCore.ts`
- `open-sse/handlers/responsesHandler.ts`
- `src/domain/*`
- `src/domain/assessment/*`
- `src/lib/db/*`
- `open-sse/config/providers/*`
- `open-sse/services/combo.ts`
- `open-sse/services/autoCombo/*`
- `open-sse/services/compression/*`
- `open-sse/translator/*`

### Request Flow

The primary request path is:

1. Next API route receives a compatibility request such as `/v1/chat/completions`, `/v1/responses`, or `/v1/messages`.
2. The route initializes translators and runs an injection guard.
3. `handleChat` parses the request, applies Accept-header stream negotiation, logs request shape, resolves API key and session, enforces API key policy, runs guardrails, and checks session limits.
4. Pre-request hooks and task-aware routing can mutate routing intent.
5. The request resolves combo vs single-model handling.
6. Combo handling applies strategy, quota preflight, account selection, circuit breakers, provider cooldowns, and fallback.
7. Single-model handling resolves model/provider, credential, health gates, quota constraints, cooldown-aware retry, and proxy settings.
8. `handleChatCore` performs provider-specific request mutation, translation, plugin hook, compression, semantic/idempotency cache, upstream execution, streaming readiness checks, response translation, usage, cost, guardrails, memory extraction, call logs, and quota consumption.

This is a very capable path but also a warning. Prompt Proxy should avoid letting every feature live in the hot path without a strict phase model and typed context.

### Domain Modules

OmniRoute has extracted some domain modules that are useful reference points:

- `fallbackPolicy.ts`: declarative fallback chains backed by SQLite.
- `lockoutPolicy.ts`: identifier lockout with attempts and expiry.
- `costRules.ts`: API-key budget windows, reset schedules, warnings, and cost recording.
- `quotaCache.ts`: provider quota snapshots, exhaustion checks, background refresh, and reset-time handling.
- `connectionModelRules.ts`: per-connection model exclusions.
- `policyEngine.ts`: combines lockout, budget, and fallback-chain adjustments.
- `pipeline.ts`: pure multi-stage LLM pipeline orchestration with caller-provided execution.
- `degradation.ts`: full/reduced/default capability tracking for dependent services.
- `assessment/*`: model/provider probing for status, latency, capability, and health.

These modules are smaller and more reusable than the larger request handler. Prompt Proxy should borrow the domain boundaries, not the exact local storage approach.

### Provider Registry

OmniRoute's provider registry is extensive. Each provider entry can include:

- Id and public alias.
- Provider format.
- Executor.
- Base URL and path behavior.
- Auth type and header.
- OAuth metadata.
- Headers and request defaults.
- Model list.
- Model capabilities such as tools, reasoning, vision, context, target format, unsupported params.
- Passthrough model behavior and provider defaults.

The registry is useful as a seed catalog. It is not a good production source of truth for Prompt Proxy because:

- Operational provider accounts need workspace and organization scoping.
- Secrets need encrypted storage or references.
- Catalog data changes over time.
- Routing configs should reference durable ids and versions.
- Static provider lists are difficult to govern.

### Combos And Auto-Combo

OmniRoute's flagship routing primitive is the combo: an ordered or strategy-driven set of targets. It supports priority, weighted, round-robin, random, least-used, cost-optimized, reset-aware, p2c, last-known-good, context-aware, auto, and other strategies.

Auto-combo scoring considers factors such as:

- Quota remaining.
- Health and circuit-breaker state.
- Cost inverse.
- Latency inverse.
- Task fit.
- Stability.
- Account tier priority.
- Tier affinity.
- Specificity match.
- Context affinity.
- Reset-window affinity.
- Connection pool density.

Prompt Proxy should not adopt auto-combo wholesale. It should use these factors as route-decision evidence and optional target ordering inside a configured route. The LLM classifier should remain the primary tier selector.

### Quota And Resilience

OmniRoute has useful resilience distinctions:

- Provider-level circuit breaker.
- Connection cooldown.
- Model lockout for provider plus account plus model.
- Quota cache.
- Quota preflight.
- Provider cooldown tracker.
- Cooldown-aware retry.
- Daily quota classification.
- Account extra-key health.
- Session/account affinity.

This vocabulary maps well to Prompt Proxy's provider-attempt model. We should represent each as durable current state and event-backed route evidence.

### Translation And Streaming

OmniRoute has a large translator registry and extensive tests for OpenAI Chat, OpenAI Responses, Claude, Gemini, Cursor, Kiro, Antigravity, web tools, streaming transforms, and response sanitization.

It also includes important streaming edge-case handling:

- Accept-header stream negotiation.
- Streaming readiness timeout.
- SSE heartbeat.
- JSON-to-SSE synthesis when an upstream returns JSON for a streaming request.
- Stream failure finalization.
- Client disconnect handling.
- Time-to-first-token recording.

Prompt Proxy should borrow this testing and streaming-edge discipline while keeping native paths byte-preserving where possible.

### Compression

OmniRoute has a broad compression system:

- RTK-style command output filters.
- Caveman prompt compression.
- Language-specific rule sets.
- Aggressive, lite, ultra, and caching-aware modes.
- Benchmark and replay harnesses.
- Token savings analytics.

For Prompt Proxy, RTK-style tool result compression is the most appropriate first feature. Prompt rewriting and general prompt compression are higher risk because they can change user intent and harness behavior.

### Persistence

OmniRoute uses SQLite and migrations for local state. It stores provider connections, provider nodes, key-value settings, combos, API keys, usage history, call logs, proxy logs, fallback chains, budgets, cost history, lockout state, circuit breakers, semantic cache, quota snapshots, plugins, evals, and many more product tables.

This is sophisticated for a local app. Prompt Proxy should not use it as a production model because Prompt Proxy already has:

- Postgres.
- Drizzle schema and migrations.
- Organization and workspace scoping.
- Durable events and outbox.
- Prompt artifact boundaries.

The lesson is schema breadth, not storage architecture.

### Tests And Quality Gates

OmniRoute has many targeted tests for translation, combos, quota, resilience, chat pipeline, auto-combo, compression, and edge cases. This level of regression coverage is a major strength. Prompt Proxy should match this approach for the smaller set of behaviors it intentionally supports.

## Pros Compared To Prompt Proxy

- Strong coding-agent product focus.
- Very broad provider, executor, and protocol coverage.
- Rich combo and fallback product model.
- Explicit quota, cooldown, circuit-breaker, and model-lockout vocabulary.
- Many targeted tests for translation and routing edge cases.
- RTK-style compression filters are extensive.
- Model/provider assessment probes are a strong operational idea.
- Dashboard, CLI helpers, monitoring, webhooks, evals, and docs are broad.
- Local-first onboarding can be very fast.

## Cons And Risks Compared To Prompt Proxy

- Request path is too broad and feature-heavy for a clean auditable gateway.
- Local SQLite and local credential storage are not enough for organization-scoped BYOK.
- Many provider integrations rely on unofficial or fragile surfaces.
- Aggressive compression, memory injection, plugins, and tool execution are risky in a proxy that must preserve prompt integrity.
- Silent fallback and provider hopping can hide policy and quality changes.
- Static provider catalog is too large to govern manually as production truth.
- The product goal of maximizing free/subscription quota is not Prompt Proxy's goal.

## What Prompt Proxy Should Borrow

### Resilience Vocabulary

Adopt the distinction among:

- Provider outage.
- Provider account cooldown.
- Provider account quota exhaustion.
- Provider/model lockout.
- Request incompatibility.
- Context overflow.
- Authentication failure.
- Budget rejection.

Each should have a typed event and a current-state projection.

### Model Assessment

Add lightweight probes:

- Quick prompt for basic availability.
- Streaming check.
- Tool-call check where supported.
- Vision check where configured.
- Latency sample.
- Auth failure vs model unavailable vs rate-limited classification.

Assessment results should feed the provider health dashboard and routing skip evidence.

### Auto-Combo Factors As Evidence

Use OmniRoute's scoring factors as observability fields before using them as routing authority:

- Cost.
- Latency.
- Health.
- Quota.
- Context fit.
- Capability fit.
- Session affinity.
- Recent success rate.

These can explain route choices and support future target ordering.

### Compression Harness

Build a small replay harness for tool-output compression:

- Input fixture.
- Filter applied.
- Token estimate before and after.
- Semantic retention checks.
- No-growth guarantee.
- Golden output.

### Streaming Edge-Case Tests

Add tests for:

- Upstream JSON response to streaming request.
- Early EOF before useful content.
- Empty streaming response.
- Provider error frame in SSE.
- Client disconnect.
- Terminal usage missing.
- Responses stateful request rejection on translated paths.

## What Prompt Proxy Should Avoid

- Do not adopt free-provider/subscription-draining as product strategy.
- Do not add MITM or tool-cloaking behavior.
- Do not run arbitrary plugin hooks in the hot path.
- Do not add memory injection or skill execution inside the proxy request path.
- Do not silently mutate prompts with general compression.
- Do not use static catalog code as production configuration authority.

## Concrete Improvement Candidates

1. Add provider/account/model resilience state tables.
2. Add model assessment jobs and dashboard.
3. Add route skip reason taxonomy.
4. Add route execution plan factor fields for cost, latency, health, quota, context, and capability.
5. Add RTK-style compression in `measure_only` mode first.
6. Add golden translator and streaming tests for supported harnesses.
7. Add session/account affinity that is explicit and visible.
8. Add bounded local in-memory caches only as projections of durable state.

## Bottom Line

OmniRoute is a wide product map for coding-agent routing. Prompt Proxy should borrow the resilience taxonomy, assessment loops, test coverage patterns, and compression harnesses. It should avoid copying the large hot path, local trust model, free-provider orientation, and aggressive mutation features.
