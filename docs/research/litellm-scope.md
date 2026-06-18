# LiteLLM Scoping Review

Source: https://github.com/BerriAI/litellm  
Local clone reviewed: `.context/upstreams/litellm`  
Commit reviewed: `e4a53f50de24701c0d0c9334c2fb0ab5e770e828` from 2026-06-18  
Compared system: Prompt Proxy in this repository

## Executive Summary

LiteLLM is the most mature AI-gateway comparison point in this research set. It is both a Python SDK that normalizes many providers behind a common API and a FastAPI proxy that layers gateway behavior on top of that SDK: authentication, virtual keys, budgets, provider fallback, spend tracking, callbacks, guardrails, and a broad admin dashboard.

The strongest lesson for Prompt Proxy is operational maturity. LiteLLM has already crossed the boundary from "route a request" into "operate a fleet of provider deployments with budgets, users, teams, cooldowns, fallbacks, health, and reporting." Prompt Proxy should borrow those operating concepts, but not its broad SDK-normalization approach as the core request path. Prompt Proxy's current advantage is native harness fidelity, durable event/current-state writes, and narrower product intent. Losing that by adopting a single SDK-shaped intermediate request model would undermine the proxy's main design constraint.

## Architecture

### Runtime Shape

LiteLLM has two major runtime surfaces:

- A provider SDK that exposes common functions such as chat completion, Responses, embeddings, images, audio, rerank, batches, and provider-specific handlers.
- A proxy server that exposes OpenAI-compatible, Anthropic-compatible, MCP, A2A, management, and passthrough endpoints, then calls the SDK internally.

The proxy is not a thin reverse proxy. It is a full gateway application. The request path includes auth resolution, policy hooks, caching, routing, budget checks, provider client construction, response accounting, logging callbacks, and database writes before or after the upstream provider call.

Important reviewed areas:

- `litellm/proxy/proxy_server.py`
- `litellm/proxy/route_llm_request.py`
- `litellm/router.py`
- `litellm/proxy/auth/user_api_key_auth.py`
- `litellm/proxy/hooks/proxy_track_cost_callback.py`
- `litellm/proxy/db/db_spend_update_writer.py`
- `litellm/schema.prisma`
- `litellm/proxy/management_endpoints/*`
- `ui/litellm-dashboard/*`

### Request Flow

The high-level request flow is:

1. FastAPI endpoint receives an OpenAI-compatible, Anthropic-compatible, or management request.
2. Proxy auth extracts bearer, basic, JWT, OAuth, or cloud-provider auth signals.
3. Auth and policy hooks attach API key, team, user, org, route selectors, budget, limits, and metadata.
4. The router resolves the target model group or deployment.
5. LiteLLM SDK transforms and sends the provider request.
6. Success or failure callbacks compute usage, cost, spend logs, and budget updates.
7. Spend updates are batched and written to Postgres or queued through Redis-backed update paths.

Prompt Proxy has a thinner intended boundary: surface handlers should authenticate, parse envelopes, and delegate. LiteLLM shows how quickly a gateway can accumulate business logic in the request path when product scope grows.

### Routing Model

LiteLLM's `Router` is broad. It supports:

- Model groups and deployments.
- Per-deployment API keys and endpoint parameters.
- Retries and fallback chains.
- Default fallbacks, context-window fallbacks, content-policy fallbacks, and provider-specific fallback handling.
- Cooldowns and health checks.
- Redis-backed cache and deployment state.
- Tag filtering and model group aliases.
- Pre-call checks.
- Several routing strategies: simple shuffle, least busy, usage-based routing, latency-based routing, cost-based routing, health-check routing, weighted failover, and budget-aware provider routing.
- Adaptive and quality-aware routing experiments.

The key design distinction is that LiteLLM often routes among provider deployments that already share a user-selected model group. Prompt Proxy first classifies the request into an effort tier, then resolves that tier through a versioned routing config. That classifier-first design should remain. The LiteLLM lesson is to make the selected tier produce a richer execution plan: ordered targets, skip reasons, retry policy, cooldown rules, and terminal evidence.

### Adaptive Router

LiteLLM's adaptive router classifies request type, tracks quality signals, and uses a bandit-style score by request type and model. It combines quality, cost, and request category. It also explicitly acknowledges limitations: small sample windows, coarse quality signals, owner-cache assumptions, regex-based output scoring, and missing latency in early scoring.

Prompt Proxy should not begin with adaptive routing as a black box. A better sequence is:

1. Persist route outcomes and provider-attempt quality labels.
2. Add eval-backed route quality views.
3. Add suggested config changes.
4. Add controlled adaptive routing only for keys that opt in.

### Persistence And Accounting

LiteLLM's Prisma schema is extensive. It covers virtual keys, users, teams, organizations, projects, budgets, credentials, proxy models, agents, spend logs, and many management-plane concepts.

Spend tracking is a major strength:

- Costs are computed from provider response metadata and hidden parameters.
- Spend logs include key/user/team/org/end-user/tag attribution.
- Writes are batched.
- Redis queues can absorb high write volume.
- Daily spend and aggregate spend updates are separated from request handling.

The tradeoff is consistency. LiteLLM optimizes for throughput and gateway practicality. Prompt Proxy's rule is stricter: when persistence is enabled, event row, outbox row, and matching current-state mutation should happen in the same transaction. We should borrow LiteLLM's attribution dimensions and batching ideas for projections, not weaken the request event contract.

### Admin And Operations

LiteLLM's dashboard is a full operations surface. It includes model hub, key lifecycle, users, teams, guardrails, spend, settings, provider info, SSO, MCP, pricing, and many enterprise controls.

For Prompt Proxy, the main lesson is not "copy every page." The useful pattern is that every runtime control has an operator-facing workflow:

- Create and revoke virtual keys.
- Attach budgets and limits.
- Assign models and provider credentials.
- Inspect usage by identity and model.
- Inspect provider health and spend.
- Configure guardrails and integrations.

Prompt Proxy already has a TanStack operations console. It should keep the dense internal-console style but expand toward these operational workflows where they support routing reliability.

## Pros Compared To Prompt Proxy

- Much broader provider coverage and endpoint coverage.
- Mature virtual-key, team, project, organization, and budget model.
- Rich fallback and retry behavior by deployment, error type, context window, policy failure, and health.
- Multiple routing strategies that operators can select.
- Strong spend attribution across key, user, team, org, tags, end users, tools, and models.
- Built-in management APIs and a broad admin dashboard.
- Many provider integrations and callback integrations already exercised in production-like use.
- Health checks, cooldowns, Redis cache, and background spend writers address real gateway load.

## Cons And Risks Compared To Prompt Proxy

- The request path is much more complex. Logic spans proxy endpoints, auth hooks, router, SDK, callbacks, spend writers, and provider handlers.
- SDK-shaped normalization can perturb client wire behavior. Prompt Proxy is intentionally protocol-aware and native-first for Codex and Claude Code.
- Spend writes are optimized for eventual consistency. Prompt Proxy's event/outbox/current-state transaction rule is stricter and better for replayable audit.
- The configuration surface is powerful but sprawling: YAML, database rows, environment variables, model groups, callback hooks, and enterprise-only behavior.
- The product has far broader concerns than Prompt Proxy: generic AI gateway, SDK compatibility, enterprise features, and a commercial split.
- Adaptive quality signals are useful but currently rely on approximations that would be risky as routing authority without better ground truth.

## What Prompt Proxy Should Borrow

### Deployment-Level Health And Cooldown

Add provider account and deployment health as first-class current state:

- `provider_accounts.rate_limited_until`
- provider/model lockout rows
- last error category and last error time
- consecutive failure count
- retry-after source
- health probe status

Every skip should become route-decision evidence, not an invisible in-memory branch.

### Budget And Rate-Limit Controls

Prompt Proxy has routing-config limits, but LiteLLM shows the operator controls expected from a serious gateway:

- Per-key request and token limits.
- Per-key and per-workspace budget windows.
- Parallel request limits.
- Pre-call budget checks using estimated input plus configured output cap.
- Post-call true-up from actual usage.
- Clear budget rejection events before provider spend.

### Richer Route Execution Plans

Keep the LLM classifier as the route tier authority, but make the selected route produce an execution plan:

- Ordered targets.
- Native-vs-translated compatibility reason.
- Retry policy.
- Fallback policy.
- Cooldown and health filters.
- Budget gates.
- Provider credential selected.
- Terminal target and attempt outcomes.

This gives Prompt Proxy the reliability of LiteLLM fallbacks without adding deterministic classifier fallback logic.

### Spend Attribution

Borrow LiteLLM's attribution breadth:

- API key.
- User.
- Organization.
- Workspace.
- Provider account.
- Route tier.
- Routing config version.
- Model.
- Harness surface.
- Tool names when present.

Prompt Proxy should keep raw prompt text only in `prompt_artifacts.raw_text`, but usage and route metadata should be rich enough to answer spend questions without reading prompts.

### Admin Workflows

Add operator workflows around:

- Provider account health.
- Key-level budgets and limits.
- Credential binding.
- Route config activation history.
- Failed provider attempts and cooldowns.
- Unpriced or unknown models.

## What Prompt Proxy Should Avoid

- Do not make an SDK-normalized request shape the default internal contract. Keep surface dialects explicit.
- Do not put raw prompt text in event payloads.
- Do not make fallback silent. Every fallback or skip needs durable evidence.
- Do not add a broad plugin/callback surface before the built-in policy phases are stable.
- Do not ship adaptive routing until route quality labels and evals exist.
- Do not let environment variables remain the primary runtime control once persistence is enabled.

## Concrete Improvement Candidates

1. Add provider account health and model lockout tables.
2. Add a `route_execution_plan` shape to route decisions.
3. Add per-key budget windows and parallel request limits.
4. Add provider health probes that write durable probe events.
5. Add cost attribution dimensions to usage ledger projections.
6. Add dashboard panels for provider cooldowns, fallback rates, and budget rejections.
7. Add optional latency-based target ordering inside an already-classified tier.
8. Add an eval-backed route quality table before adaptive routing.

## Bottom Line

LiteLLM is the benchmark for gateway operating maturity. Prompt Proxy should use it to raise the bar on budgets, health, fallback evidence, key management, and admin workflows. It should not copy LiteLLM's broad SDK-first architecture, because Prompt Proxy's differentiator is native harness fidelity plus durable, replayable routing audit.
