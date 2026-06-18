# Kong Scoping Review

Source: https://github.com/Kong/kong  
Local clone reviewed: `.context/upstreams/kong`  
Commit reviewed: `1730282ec2f8ed097cf6ad6a3d69e55b7ba9ebb6` from 2026-06-17  
Compared system: Prompt Proxy in this repository

## Executive Summary

Kong is not primarily an LLM router. It is a mature API gateway built on OpenResty and Lua, with a router, plugin system, admin API, declarative configuration, load balancing, upstream health, rate limiting, observability, vault references, and hybrid control-plane/data-plane operation. Recent Kong versions include AI gateway plugins such as `ai-proxy`, AI prompt tools, and LLM analytics.

The most valuable lessons for Prompt Proxy are architectural rather than provider-specific:

- A gateway should have a small core request path and a clear policy/plugin phase model.
- Runtime configuration should be versioned, validated, hot-reloadable, and safe to reject without taking down the current router.
- Route, service, plugin, consumer, and workspace scoping should be explicit.
- Metrics should be first-class and standardized.
- Control-plane and data-plane concerns should be separable once deployment scale requires it.

Prompt Proxy should not copy Kong's general-purpose gateway scope or Lua/OpenResty execution model. It should borrow the gateway operating primitives that fit an LLM-specific TypeScript service.

## Architecture

### Runtime Shape

Kong runs as an Nginx/OpenResty gateway with Lua modules for router construction, plugin execution, balancer behavior, declarative config, clustering, cache, vaults, admin API routes, and observability.

Important reviewed areas:

- `kong/init.lua`
- `kong/runloop/handler.lua`
- `kong/runloop/plugins_iterator.lua`
- `kong/db/schema/entities/routes.lua`
- `kong/db/schema/entities/services.lua`
- `kong/db/schema/entities/plugins.lua`
- `kong/runloop/balancer/init.lua`
- `kong/db/declarative/*`
- `kong/clustering/*`
- `kong/plugins/ai-proxy/*`
- `kong/llm/*`
- `kong/plugins/prometheus/*`
- `kong/plugins/rate-limiting/*`
- `kong/vaults/env/*`

### Router And Runloop

Kong builds a versioned router from route and service entities. The runloop watches core-cache version keys and rebuilds the router and plugin iterator when configuration changes. If a rebuild fails, Kong can keep using the previous router rather than dropping traffic onto a broken config.

This is directly applicable to Prompt Proxy's routing configs:

- Validate new config versions before activation.
- Compute a config hash.
- Keep the last good active routing graph in memory.
- Reject bad reloads without affecting in-flight requests.
- Record which route-config version and hash served each request.

Prompt Proxy already stores routing configs durably. The Kong lesson is to make the in-memory routing graph an explicit, versioned runtime artifact with safe reload semantics.

### Plugin Phase Model

Kong plugins run in ordered phases such as certificate, rewrite, access, response, header filter, body filter, and log. The plugin iterator builds the applicable plugin list by route, service, consumer, and global scope. Precedence is explicit, including combinations such as route plus service plus consumer.

Prompt Proxy should not expose arbitrary plugins early, but it should define internal policy phases:

1. Parse and authenticate.
2. Prompt capture and redaction decision.
3. API key and workspace policy.
4. Budget and rate-limit preflight.
5. Classification.
6. Route target resolution.
7. Provider account health and cooldown filtering.
8. Request translation or native forwarding.
9. Stream observation.
10. Usage, cost, and terminal event recording.
11. Post-call guardrails or analytics.

Kong's phase model prevents policy from becoming scattered across route handlers.

### Entity Model

Kong's core entities are general gateway primitives:

- Routes match protocols, methods, hosts, paths, headers, SNIs, sources, destinations, and expressions.
- Services define upstream protocol, host, port, path, retries, timeouts, TLS, and enabled state.
- Plugins attach at route, service, consumer, or global scope.

Prompt Proxy's equivalent entities should remain LLM-specific:

- Surfaces and dialects.
- Provider registry rows.
- Provider accounts and credentials.
- Model catalog entries.
- Routing configs.
- API keys.
- Workspaces and organizations.
- Policy attachments.

The lesson is not to copy route/service names. The lesson is to keep matching, upstream target definition, credential identity, and policy attachment separate.

### Declarative Config

Kong supports DB-backed and DB-less modes. In DB-less mode, `/config` accepts a declarative config payload, parses and validates it, computes a hash, loads it into cache/LMDB, and returns errors without replacing the active config if validation fails.

Prompt Proxy should apply the same activation discipline to routing configs and provider registry changes:

- Parse.
- Validate references and capabilities.
- Compute hash.
- Dry-run compatibility checks.
- Activate as a new immutable version.
- Keep previous active version if activation fails.

### Control Plane And Data Plane

Kong's hybrid mode separates control-plane config from data-plane request serving. Data planes connect by mTLS/RPC, report status, receive deltas or full sync, validate config, and keep serving from local LMDB.

Prompt Proxy does not need this immediately. But it suggests a future deployment path:

- Admin API and console can be control-plane oriented.
- Proxy workers can cache active config and provider registry snapshots.
- Config distribution can be versioned and hash-checked.
- Workers can report active config version, health, and last sync.

This matters if Prompt Proxy runs multiple proxy instances behind a load balancer.

### Balancer And Health

Kong's balancer manages upstream targets, health checks, hash strategies, failover, and no-healthy-peer handling. It supports consistent hashing on consumer, IP, header, cookie, path, query arg, or URI capture.

Prompt Proxy's LLM equivalent is provider-account and deployment selection:

- Target identity should be stable and visible.
- Health and cooldown should influence selection.
- Session affinity can keep provider prompt caches warm.
- Failover should distinguish account failure, model failure, provider failure, and request incompatibility.

### AI Proxy Plugin

Kong's `ai-proxy` plugin is implemented through an LLM plugin base with named filters. It has stages for request introspection, request transformation, response introspection, response transformation, streaming, and logging. Drivers such as OpenAI and Anthropic map an internal Kong LLM shape to provider requests and normalize responses.

Useful patterns:

- The AI layer is a plugin over gateway primitives, not the whole gateway.
- Filter stages are explicit and reusable.
- LLM analytics are extracted through shared context.
- The plugin schema validates incompatible options such as streaming and provider formats.

Prompt Proxy already has an LLM-specific core, so it does not need AI as a plugin. But the phase/filter structure is a good way to organize forwarding, translation, streaming observers, and accounting.

### Observability

The Prometheus plugin exposes standard gateway metrics and AI-specific metrics. AI metrics include request totals, cost totals, token totals, provider latency, cache status, provider, model, and workspace labels.

Prompt Proxy should add a similar metrics layer in addition to durable events:

- Request count by surface, route tier, provider, model, workspace, status.
- Provider latency and time to first token.
- Token totals by input, cache read, cache write, output, reasoning.
- Cost totals.
- Fallback and retry counts.
- Budget rejection counts.
- Provider account cooldown count.
- Active routing config version.

Events are the audit backbone. Metrics are the operations heartbeat.

### Rate Limiting

Kong's rate-limiting plugin supports multiple identifier types, periods, Redis/local/cluster policies, standard headers, and fault-tolerant behavior. Prompt Proxy needs a smaller LLM-aware version:

- API key.
- Workspace.
- Provider account.
- Model or route tier.
- Request per minute.
- Token per minute.
- Parallel requests.
- Budget window.

Rate-limit decisions should be represented in route decision events.

## Pros Compared To Prompt Proxy

- Mature gateway separation of router, service, plugin, balancer, cache, admin API, and observability.
- Safe runtime config reload model.
- Rich plugin phase lifecycle with explicit precedence and scoping.
- Declarative config validation and hashing.
- Hybrid control-plane/data-plane architecture.
- Built-in metrics and rate limiting.
- Upstream health and balancer concepts are deeply exercised.
- Vault/reference pattern for secrets.
- AI plugin shows LLM behavior can fit a gateway phase model.

## Cons And Risks Compared To Prompt Proxy

- Kong is far broader than Prompt Proxy's product goal.
- Lua/OpenResty architecture does not map directly to the existing TypeScript/Fastify codebase.
- General gateway plugins can become too dynamic and hard to reason about for LLM prompt security.
- Kong's LLM support is generic AI gateway behavior, not specifically optimized for Codex and Claude Code harness fidelity.
- Adopting general route/service/plugin terminology could obscure Prompt Proxy's LLM-specific concepts.

## What Prompt Proxy Should Borrow

### Phase-Based Policy Engine

Define a built-in internal policy pipeline with named phases and typed context. This gives us Kong-like organization without arbitrary third-party plugins.

### Safe Config Activation

Add a runtime routing graph:

- Built from active provider registry, provider accounts, model catalog, and routing config.
- Has version and hash.
- Can be validated before activation.
- Keeps last-known-good graph on activation failure.
- Is reported through health and debug endpoints.

### Typed Request Context

Kong's LLM context uses typed accessors and namespaced fields. Prompt Proxy should use a typed per-request context for:

- Request id.
- Organization and workspace.
- API key.
- Surface and dialect.
- Prompt artifact ids.
- Classifier result.
- Route execution plan.
- Provider attempt ids.
- Usage and cost.
- Policy decisions.

This is better than passing loosely shaped objects through helper chains.

### Metrics Layer

Add Prometheus or OpenTelemetry metrics derived from the same facts events persist:

- Do not replace events.
- Do not include raw prompts.
- Keep labels bounded.
- Include config version and workspace where cardinality is acceptable.

### Control Plane Readiness

Keep today's app simple, but design provider registry and routing config activation so future proxy workers can consume a versioned snapshot.

## What Prompt Proxy Should Avoid

- Do not implement arbitrary user plugins in the request path yet.
- Do not broaden into a general API gateway.
- Do not replace domain-specific route decisions with generic URL route matching.
- Do not expose high-cardinality prompt or model labels in metrics without bounds.
- Do not make config reload best-effort without durable activation events.

## Concrete Improvement Candidates

1. Add a named policy pipeline with typed phase context.
2. Add active routing graph hash and last-known-good reload behavior.
3. Add config activation validation that checks provider/account/model references before activation.
4. Add provider-account health and route graph status to `/healthz` or a management endpoint.
5. Add Prometheus/OpenTelemetry metrics for LLM gateway operations.
6. Add route decision precedence rules for global, workspace, API key, and route-specific policy.
7. Add secret reference support for provider credentials beyond encrypted inline material.

## Bottom Line

Kong is the benchmark for gateway architecture and operations discipline. Prompt Proxy should not become Kong. It should adopt Kong's safe config reloads, phase model, typed context, metrics, and eventual control-plane/data-plane readiness while staying an LLM routing gateway optimized for coding harnesses.
