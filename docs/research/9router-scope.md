# 9router Scoping Review

Source: https://github.com/decolua/9router  
Local clone reviewed: `.context/upstreams/9router`  
Commit reviewed: `f2a7ae20309b4af55023eb11d1c02f63be1b80d1` from 2026-06-18  
Compared system: Prompt Proxy in this repository

## Executive Summary

9router is a local-first AI routing gateway aimed directly at coding agents and developer tools. It exposes OpenAI-compatible and Anthropic-compatible endpoints, translates among OpenAI Chat, OpenAI Responses, Claude, Gemini, and other formats, and routes across many providers, credentials, and local subscription accounts. Its product center is practical developer convenience: one local endpoint, many providers, automatic fallback, account rotation, combo models, and token compression.

9router is closer to Prompt Proxy's harness focus than LiteLLM, but its trust model is very different. It optimizes for a local single-user router that can aggressively mutate requests, compress tool outputs, fall back silently, and store provider credentials locally. Prompt Proxy is an organization/workspace-scoped gateway with durable audit, BYOK, versioned routing configs, and event-backed observability.

The strongest takeaways for Prompt Proxy are translator testing discipline, harness-specific compatibility coverage, provider capability metadata, account-level fallback, and explicit token-compression features. The main cautions are silent behavior changes, weak enterprise secret posture, and local current-state logging instead of auditable event streams.

## Architecture

### Runtime Shape

9router is a Next.js application with a shared routing core in `open-sse`. It combines:

- Compatibility endpoints for coding harnesses.
- A dashboard and management APIs.
- Local storage for providers, keys, aliases, combos, pricing, usage, and request details.
- A provider registry with transport/auth/model metadata.
- Translators between request and response formats.
- RTK-style tool-output compression.

Important reviewed areas:

- `docs/ARCHITECTURE.md`
- `src/proxy.js`
- `custom-server.js`
- `src/sse/handlers/chat.js`
- `open-sse/handlers/chatCore.js`
- `open-sse/services/model.js`
- `open-sse/services/accountFallback.js`
- `open-sse/services/combo.js`
- `open-sse/translator/*`
- `open-sse/rtk/*`
- `open-sse/config/providers.js`
- `src/lib/db/schema.js`

### Request Flow

The chat request flow is:

1. Next API route or proxy endpoint receives a compatibility request.
2. The handler parses JSON, optional API key, model, source format, and client hints.
3. Model aliases and provider prefixes resolve the requested model.
4. Combo requests select a model through fallback, round-robin, or fusion behavior.
5. Single-model requests resolve provider credentials, accounting for account fallback and cooldown.
6. `handleChatCore` detects source format, target format, streaming requirements, modality, unsupported fields, and provider-specific overrides.
7. Same-family requests may pass through natively. Cross-family requests translate through direct or OpenAI-pivot translators.
8. Compression and compatibility rewrites may mutate the request.
9. The executor sends the upstream request.
10. Usage and request detail logging are persisted locally.

Prompt Proxy has a similar high-level need but should keep transport handlers thinner. 9router's request path is dense because it performs most product features inline.

### Translation Architecture

The translator registry is 9router's most valuable technical contribution. It handles:

- Source format detection.
- Direct translators where available.
- Hub-and-spoke translation through OpenAI shape.
- Request and response conversion.
- Streaming shape conversion.
- Tool-call repair.
- Gemini, Claude, OpenAI Responses, and OpenAI Chat differences.
- Modality support and remote image handling.
- Thinking/reasoning fields.
- Finish reason and usage normalization.

9router also has many targeted translator tests and snapshots. This is directly relevant to Prompt Proxy. Our translator registry should have a harness-profile matrix and golden tests before we rely on translated routes broadly.

### Provider Registry

9router's provider registry co-locates:

- Provider id and aliases.
- Base URLs and path behavior.
- Auth shape.
- OAuth metadata where needed.
- Header defaults.
- Model lists.
- Capabilities.
- Pricing.
- Media and service kind metadata.

This is useful as a code-organization pattern, but Prompt Proxy should not use static code as the operational source of truth. The better design is:

- Seed provider and model definitions from a catalog.
- Store active provider registry rows and provider accounts in Postgres.
- Store secrets as encrypted material or secret references.
- Record capability source and last synced time.
- Make routing configs reference provider/account/deployment ids, not hardcoded registry branches.

### Routing And Fallback

9router supports several routing behaviors:

- Provider prefix and alias resolution.
- Account fallback when a credential is unavailable.
- Cooldowns for rate-limited or broken accounts.
- Combo models with fallback or round-robin behavior.
- Fusion and judge-style routes.
- Capability-aware model selection.
- Subscription/free-provider priority patterns.

The useful Prompt Proxy concept is an explicit fallback chain attached to the route decision. The risky 9router behavior is broad silent fallback. Prompt Proxy should return the selected route and all fallback evidence through durable events and dashboard views.

### RTK Compression

9router includes an RTK-like compression layer for tool outputs. It recognizes shell/tool results across OpenAI, Claude, Responses, and other harness shapes, then applies filters for outputs such as:

- Git diff.
- Git status.
- `grep` and `rg`.
- `find` and `fd`.
- Directory listings.
- Logs.
- Generic truncation and deduplication.

The strongest idea is not the exact filters; it is the contract:

- Detect compressible tool outputs.
- Do not compress errors unsafely.
- Cap output size.
- Avoid producing larger output.
- Preserve enough structure for the model to reason.
- Measure token savings.

Prompt Proxy can implement this as an explicit route-config feature, not an implicit mutation.

### Persistence

9router uses local storage for settings, provider connections, provider nodes, proxy pools, API keys, combos, aliases, pricing, usage history, daily aggregates, and request details.

This is pragmatic for a local tool but weaker than Prompt Proxy's durable model:

- No organization/workspace scoping equivalent.
- Request logs are local operational records, not event streams with outbox semantics.
- Secrets live in a local app database.
- Full request logging is a local toggle rather than an org/workspace prompt-capture policy.

Prompt Proxy should borrow the local UX clarity, not the storage trust model.

## Pros Compared To Prompt Proxy

- Very focused on coding-agent integration.
- Broad compatibility with real harness quirks.
- Rich translator coverage and many edge-case tests.
- Provider registry includes capability and display metadata close to transport behavior.
- Account fallback and cooldown are practical and user-visible.
- Combo models are a strong product primitive for ordered fallback and load sharing.
- RTK compression targets exactly the tool-heavy sessions Prompt Proxy expects.
- Local dashboard and CLI setup helpers reduce onboarding friction.
- Supports many practical provider/auth shapes.

## Cons And Risks Compared To Prompt Proxy

- Local-first security model is not enough for organization-scoped gateway use.
- Full request/header/body logs can easily violate Prompt Proxy's raw prompt storage boundary.
- Silent fallback can obscure which model actually handled a request.
- Aggressive translation and request mutation can break harness assumptions.
- Provider and capability data are mostly code/static config rather than durable, versioned operational state.
- Account fallback defaults may mask credential or policy errors.
- Subscription/free-provider routing and tool cloaking behaviors are not aligned with a conservative enterprise posture.

## What Prompt Proxy Should Borrow

### Harness Compatibility Matrix

Create `HarnessProfile` definitions for Codex, Claude Code, opencode, Cursor BYOK, and other target clients:

- Accepted endpoints.
- Required response fields.
- Streaming event requirements.
- Tool-call quirks.
- Token-count behavior.
- Unsupported translation cases.
- Known headers and session identifiers.

Each profile should drive golden tests and smoke tests.

### Translator Golden Tests

For every supported cross-dialect path:

- Request fixture in source format.
- Expected provider request.
- Provider response fixture.
- Expected client response.
- Streaming fixture where applicable.
- Rejection fixture for unsupported stateful features such as Responses `previous_response_id`.

9router shows that translation quality is an ongoing maintenance burden, not a one-time adapter.

### Explicit Token Compression

Add a route-config option for tool-output compression:

- `disabled`
- `measure_only`
- `compress_safe_tool_outputs`

Every compression event should record original token estimate, compressed estimate, filter name, hash of original artifact, hash of compressed artifact, and whether the original raw text was retained under prompt-capture policy.

### Account Fallback With Evidence

Borrow account fallback, but make it durable:

- Tried provider account ids.
- Skipped provider account ids.
- Skip reason.
- Cooldown expiry.
- Retry-after source.
- Final selected account.
- Fallback count.

### Capability-Aware Editor

Use capability metadata to improve the routing config UI:

- Tools.
- Vision.
- Search.
- Reasoning.
- OpenAI Responses.
- Anthropic Messages.
- Chat Completions.
- Max context and max output.
- Known unsupported params.

## What Prompt Proxy Should Avoid

- Do not silently rewrite or compress prompts without a route decision field.
- Do not store raw prompts in ordinary request logs.
- Do not make "free provider hopping" a product goal.
- Do not implement tool cloaking or anti-detection behavior.
- Do not make local SQLite state the production authority.
- Do not default to fallback for unclassified errors.

## Concrete Improvement Candidates

1. Build a translator fixture suite based on harness profiles.
2. Add explicit route-decision fields for translated vs native handling.
3. Add account cooldown rows and skip evidence.
4. Add tool-output compression as a measured, opt-in policy.
5. Add model capability metadata to provider registry and routing config screens.
6. Add combo-like ordered fallback plans, but only as auditable route execution plans.
7. Add request detail artifacts that respect Prompt Proxy's prompt artifact boundary.

## Bottom Line

9router is the best comparison for coding-agent compatibility and practical local routing. Prompt Proxy should adopt its discipline around translator edge cases, account fallback, and token compression. It should reject the parts that conflict with organization-grade audit: silent mutation, weak secret boundaries, and local logs as the source of truth.
