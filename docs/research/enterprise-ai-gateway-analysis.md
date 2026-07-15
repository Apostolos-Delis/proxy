# Enterprise AI Gateway Strategy and Target Architecture

- **Status:** Proposed strategic direction
- **Date:** 2026-07-14
- **Decision horizon:** The next major architecture of Proxy
- **Audience:** Product and engineering leaders deciding whether and how Proxy should become Opendoor's shared AI gateway
- **Repository baseline:** `origin/main` at the start of this analysis
- **Implementation starting point:** [AI Gateway Core Data Model V1](../scopes/ai-gateway-core-model-v1/PLAN.md)

This file is the exhaustive research record. Use the linked scope documents for implementation and approval rather than treating Appendix B as an implementation-ready schema.

## Executive Decision

Proxy should become an **enterprise AI traffic control plane**: the single governed path through which Opendoor workloads discover, authorize, invoke, observe, and account for external and self-hosted AI inference.

It should not become:

- a TypeScript rewrite of every LiteLLM feature;
- a generic API gateway with a thin OpenAI-compatible plugin;
- an agent framework, prompt-management suite, or MCP orchestration product;
- a reseller billing platform;
- a universal lowest-common-denominator request schema that erases provider features.

The recommended architecture is to keep Proxy's strongest existing foundations, but replace its coding-specific product model before broadening endpoint coverage.

The decisive changes are:

1. **Make supported SDK integration a drop-in contract.** An application changes its OpenAI or Anthropic base URL, uses a gateway credential, and requests an enabled logical model. Ordinary inference requires no gateway-specific SDK or request body.
2. **Make caller-selected logical models the default contract.** Classification, semantic routing, and complexity routing become optional route nodes. The current `fast`, `balanced`, `hard`, and `deep` tiers become one bundled `coding/auto` route, not global schema constants.
3. **Separate protocol, provider, and model concepts.** API wire definitions and wire codecs own external request contracts; translation adapters own directed conversion between wires; provider adapters and connections own physical provider integration; canonical models, deployments, and logical models own model identity and routing. Clients never need to know a provider credential or physical endpoint.
4. **Replace routing-config V3 with a versioned, compiled route DAG.** The graph is deliberately constrained, acyclic, auditable, and publishable. It supports conditions, classifiers, weighted splits, deployment pools, ordered fallbacks, and explicit rejection without allowing arbitrary code.
5. **Make operation definitions and API wires first-class but separate.** Code-owned operation definitions give text generation, embeddings, media, catalog, realtime, and job/resource actions explicit resolution and lifecycle semantics. OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, Gemini GenerateContent, and Bedrock Converse are versioned API wires that own their network binding, encoding, and framing. Runtime derives `unary`, `stream`, `session`, or `job` interaction mode from the validated wire request; none of these facts comes from a model name.
6. **Preserve native protocol paths and certify translations explicitly.** Translation is an operation-specific compatibility graph with `native`, `exact`, `lossy`, or `unsupported` edges. Unsupported fields fail before the provider call; they are never silently dropped.
7. **Separate administration roles from inference entitlements.** Organizations and workspaces remain tenancy boundaries. Teams are many-to-many identity groups. Humans, service accounts, workload identities, and API credentials are principals or credentials with different trust semantics. Typed, versioned policies determine allowed logical models, operations, providers, regions, parameters, data-handling properties, rates, and budgets.
8. **Use one runtime configuration truth with multiple authoring paths.** Console/API-managed resources and declarative TOML resources reconcile into the same versioned database and compiled workspace revision. Resource ownership is explicit; there is no bidirectional live merge.
9. **Compile control-plane state into immutable data-plane artifacts.** Keep Fastify for the first production data plane. Do not rewrite on Envoy merely to look like a gateway. Remove Postgres from the per-request configuration/authentication path, distribute workspace snapshots plus separate signed identity/credential and provider-credential directories with component ACK/NACK and a bounded-staleness narrowing overlay, add shared operational state for bounded-overshoot controls and a durable firm admission authority for exact limits/spend, and preserve request-level evidence through a durable telemetry path.
10. **Broaden capability in a controlled order.** Rebuild existing coding flows on the new core first, then add embeddings, enterprise provider breadth and shared governance, then other modalities. Realtime and asynchronous media require their own execution semantics and should not be squeezed through the text pipeline.

This is a hard cutover. Proxy is still at the point where one coherent schema and API break is less expensive than years of compatibility code around a coding-agent abstraction.

## Recommendation in One Diagram

```text
Control plane

 IdP/SCIM     Admin API + console     Provider discovery     Pricing feeds
    |                 |                       |                    |
    +--------> versioned resources + policy compiler <-------------+
                     |                              |
          immutable workspace revision   signed identity + provider-credential directories
                     |                    + narrowing + state-retention generations
                     +-------- stage / ACK / activate --------+
                                                              |
Data plane                                                    v

 client -> pre-buffer limits -> resolve wire + operation -> common admission
        -> catalog execution -------------------------------------------+
        -> logical model + no hard state -> preflight -> route ----------|
        -> logical model + hard state -> exact authorized target --------|
        -> state-bound action -> exact retained/current target ----------|
        -> workspace resource profile -> bounded create target ----------|
        -> bounded native/translated provider I/O when needed -----------|
        -> output/state release gates -> ingress wire response -> client
                              |
                  request, decision, attempt, usage evidence
                              |
                durable stream -> ledger / analytics / audit
```

For model operations, the unit exposed to a caller is a **logical model** and the upstream unit is a **model deployment**. Catalog, resource-creation, and state-bound actions use explicit resolution contracts. Every branch, preflight, provider attempt, and release is versioned, policy-constrained, and explainable.

## 1. Decision Context

### 1.1 What "a true AI gateway" should mean

For this project, a true AI gateway should own six responsibilities:

1. **Stable inference interfaces:** applications can use supported OpenAI, Anthropic, and eventually provider-native protocols without binding credentials or endpoint topology into application code.
2. **Model and provider abstraction:** operators can add provider connections, discover or configure deployments, publish logical models, and replace physical endpoints without changing clients.
3. **Traffic policy:** every request is authorized against identity, model entitlements, data constraints, parameter limits, rate limits, and budgets before routing.
4. **Reliable execution:** routing accounts for capability, health, capacity, state affinity, retry safety, and explicit fallback semantics.
5. **Evidence and economics:** the system records which revision and policy admitted the call, why a deployment was selected, every provider attempt, normalized usage, pricing provenance, and final cost.
6. **Operations:** administrators can simulate, publish, roll back, observe, and audit configuration without editing opaque YAML on production hosts.

"All things AI" should mean **all governed inference traffic**, not every adjacent AI-product concern. Prompt authoring, eval authoring, vector-database hosting, agent orchestration, tool execution, and application memory can integrate with the gateway, but do not belong inside its core.

### 1.2 Working assumptions

These recommendations assume:

- the first serious deployment is an internal Opendoor platform, not a public multi-customer resale product;
- service-to-service workloads will dominate production traffic, even though humans and coding harnesses remain supported;
- AWS is a primary infrastructure environment, while models may come from OpenAI, Anthropic, Amazon Bedrock, Azure OpenAI, Google Vertex AI/Gemini, and self-hosted inference;
- prompts and outputs may contain confidential company, customer, property, financial, or operational data;
- correctness, tenant isolation, policy enforcement, and explainability are more important than routing every request to the theoretically cheapest model;
- the repository can still make breaking schema and configuration changes before broad production adoption;
- high-volume production traffic will eventually make synchronous Postgres work on every request undesirable.

If any of those assumptions is false, the open decisions near the end of this document should be resolved before implementation.

### 1.3 Product principles

The architecture should follow these principles:

- **Native first:** preserve provider-native semantics whenever the caller and deployment use the same API wire and contract version.
- **Explicit compatibility:** translation is a certified capability, not a hopeful best effort.
- **Policy before preference:** an organization rule cannot be weakened by a workspace, team, route, API key, or request.
- **Configuration is code-like:** validate, diff, simulate, publish, version, attribute, and roll it back.
- **Every decision is explainable:** the selected deployment and every excluded candidate have machine-readable reasons.
- **State is a routing constraint:** provider conversation IDs, files, caches, batch jobs, and realtime sessions create affinity that cannot be ignored.
- **Control plane and data plane fail differently:** an unavailable admin database should not automatically interrupt already-published inference traffic.
- **Provider breadth follows abstraction quality:** add a provider only after the provider-adapter and deployment model can express its behavior without provider-specific leakage into shared policy.

## 2. Current Repository Assessment

Proxy is not a disposable V0. Several hard parts are already implemented or carefully designed. The right move is a domain-model cutover that retains these foundations, not a rewrite from scratch.

### 2.1 What is already strong

The current repository has:

- organization and workspace scoping;
- API-key hashing and provider secret-reference boundaries;
- versioned routing configurations;
- an event service, outbox, projection cursors, and current-state tables;
- route decisions with execution plans and candidate evidence;
- provider attempts, normalized usage, cache-token details, and cost capture;
- provider account and provider-model health;
- generic HTTP and Bedrock Converse runtime adapters;
- direct translators among OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, and Bedrock Converse;
- streaming observers and explicit handling of provider attempts;
- a hosted `/setup.sh`, marker-owned Codex/Claude Code configuration, and harness smoke tests;
- session affinity and provider prompt-cache awareness;
- a TanStack operations console with routing, provider, spend, and request evidence;
- a substantial set of plans and operational runbooks.

Those are the beginnings of an enterprise gateway, especially the audit trail and native-first translation approach. The existing [provider architecture plan](../scopes/provider-architecture-v1/PLAN.md), [translation plan](../scopes/harness-model-translation-v1/PLAN.md), [model access profile plan](../scopes/model-access-profiles-v1/PLAN.md), and [persistence plan](../scopes/persistence-admin-v1/PLAN.md) remain useful source material.

### 2.2 The architectural mismatch

The current product contract is still explicitly coding-agent shaped:

- `ROUTE_NAMES` is a fixed enum of `fast`, `balanced`, `hard`, and `deep`.
- `SURFACES` is limited to OpenAI Responses, Anthropic Messages, and OpenAI Chat.
- routing config V3 requires one global classifier and those four routes.
- each route embeds optional `openai` and `anthropic` deployment blocks.
- the classifier prompt describes itself as a coding-agent proxy.
- `agent_sessions` and turns are the state model.
- the published [product boundaries](../scopes/router-research-roadmap-v1/product-boundaries.md) explicitly reject becoming a generic AI gateway and make classifier-first routing a core invariant.

The provider registry is more general than that contract: provider slugs, URLs, auth styles, endpoints, capabilities, and adapter kinds are stored as data. However, runtime adapter selection still has hard-coded branches for generic HTTP and Bedrock, and the routing schema still embeds provider-family assumptions. Adding more providers or modalities on top of this shape would multiply special cases.

### 2.3 Current-to-target disposition

| Current concept | Disposition | Target concept |
|---|---|---|
| Organization | Keep | Tenant and ownership boundary |
| Workspace | Keep and clarify | Application/environment policy boundary |
| User and organization membership | Keep, extend | Control-plane human identity and RBAC |
| API key | Keep, generalize | Credential bound to a principal and workspace; can only narrow permissions |
| Provider registry row | Split responsibilities | Trusted provider-adapter manifest plus code-owned API-wire/translation registries and optional custom endpoint metadata |
| Provider account | Split and extend | Stable provider connection plus immutable credential slot/set versions and one signed directory for ordinary and certified lifecycle-only access |
| Model catalog row | Split | Canonical model definition, deployment, capability evidence, and price schedule |
| Routing config/version | Replace | Logical model, route, immutable route version, compiled workspace revision |
| `fast/balanced/hard/deep` | Remove globally | Labels inside the bundled `coding/auto` route |
| Surface | Replace | Operation kind + ingress API wire + derived interaction mode |
| Agent session | Generalize | Inference session/state binding, with coding metadata as optional attributes |
| Request, route decision, provider attempt | Keep and hard-cut | Immutable execution-decision header, unique terminal outcome, normalized candidate sets, selected-target transitions, and protocol-neutral attempt evidence |
| Usage ledger | Keep and extend | Versioned price attribution, reservation, settlement, adjustments |
| Prompt artifacts | Keep with stricter defaults | HMAC/hash, redacted sample, or approved encrypted capture |
| Event/outbox architecture | Keep for control plane | Strong control-plane audit plus separate high-volume traffic telemetry path |

### 2.4 The most important corrective action

Do not add embeddings, images, dozens of providers, teams, and budgets to routing config V3. That would preserve the wrong center of gravity.

First replace the global classifier/tier abstraction with logical models, model deployments, and a compiled route. Then migrate the existing coding behavior onto that core as a preset. Once that is done, provider and operation breadth becomes additive rather than combinatorial.

## 3. Comparative Research

### 3.1 Research method and freshness

This review used the current repository, existing internal research, official product documentation, and local source checkouts of the requested open-source projects. The open-source snapshots were:

- [LiteLLM `b200d664`](https://github.com/BerriAI/litellm/tree/b200d664eec1c8917ebb80539a2666f596b9bfe3), 2026-07-13;
- [New API `b6b97a66`](https://github.com/QuantumNous/new-api/tree/b6b97a66e39cfe45aab8cfb01ed96bba77cb279e), 2026-07-14;
- [9router `9845a170`](https://github.com/decolua/9router/tree/9845a1702f7766607bd7ac3315d1f87e59e45fb5), 2026-07-10;
- [OmniRoute `7ee5bbc6`](https://github.com/diegosouzapw/OmniRoute/tree/7ee5bbc64dbb03e967521227f2afffeb7c9dad1e), 2026-07-13.

Hosted products change quickly. The source register records the official pages consulted on 2026-07-14.

### 3.2 Comparative matrix

| System | Center of gravity | Strongest lesson | Main caution for Proxy |
|---|---|---|---|
| LiteLLM | Broad provider SDK plus proxy | Feature inventory, provider reach, routing and operational controls | Configuration/schema sprawl, JSON escape hatches, duplicated policy fields, mixed SDK/proxy concerns |
| Cloudflare AI Gateway | Managed traffic, observability, policy, edge routing | Named versioned dynamic routes with publish/rollback and typed nodes | Managed-platform dependency; compatibility endpoint changes show facade stability risk |
| Vercel AI Gateway | Developer-facing logical model endpoint | Clean separation of logical model ID, provider endpoint, provider order, and model fallback | Platform-specific control plane; request BYOK and fallback semantics need stricter enterprise policy |
| Portkey | Composable gateway configuration | Nested conditions, retries, cache, load balance, and fallbacks with attempt traces | Request or key-bound configs must never bypass organization constraints |
| Kong AI Gateway | API-gateway plugin ecosystem | Mature ingress, plugin phases, traffic policies, semantic routing/cache | An outer gateway does not replace protocol fidelity, deployment catalog, or AI-specific state semantics |
| Envoy AI Gateway | Kubernetes control/data plane and inference routing | Explicit planes and two-tier routing for hosted/self-hosted inference | Premature rewrite cost; use only when scale or inference infrastructure requires it |
| Azure API Management | Enterprise policy gateway | Shared per-consumer token limits, quotas, backend balancing | Cloud/vendor coupling and limited ownership of the AI domain model |
| New API | Broad provider/endpoint aggregation | Pragmatic operation breadth, channel priority/weight, model mapping, multi-key operation | Overloaded channel model, simpler tenancy/governance, credential model, AGPL obligations |
| 9router | Local coding-harness router | Compatibility testing, multi-account routing, quota/headroom awareness | Coding/local trust model; not an enterprise identity, audit, or compliance base |
| OmniRoute | Desktop/local multi-provider router | Provider breadth, routing strategy inventory, local UX | Local interception and subscription aggregation goals do not transfer to an enterprise gateway |

### 3.3 LiteLLM: use as a feature checklist, not the foundation

LiteLLM is the broadest reference in this review. It supports many providers and operation types, model aliases and groups, multiple load-balancing strategies, retries, fallbacks, cooldowns, budgets, teams, projects, users, keys, guardrails, policies, spend logs, caches, MCP, and adaptive or semantic routing.

The current source makes three realities visible:

1. The router has accumulated many strategies and special paths. Its router exposes simple shuffle, least busy, usage-based variants, latency-based, cost-based, weighted failover, several fallback classes, and multiple auto-router families in one large implementation ([router source](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/router.py)). This is valuable as a scenario inventory, but it is not a target module shape.
2. The proxy schema is powerful but sprawling. Budget, allowed-model, spend, rate, and metadata fields recur across organization, team, project, user, token, and related records, while proxy models retain broad JSON configuration ([schema](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/schema.prisma)). This makes features easy to add locally but makes precedence and invariants harder to reason about globally.
3. API shape is represented by several overlapping mechanisms rather than one first-class contract. LiteLLM has call types and route-to-call-type mappings ([call types](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/types/utils.py#L295-L325), [route mapping](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/types/utils.py#L833-L878)), a single model [`mode`](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/types/utils.py#L254-L265), deployment `supported_endpoints` used by paths such as [Anthropic passthrough](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/llms/anthropic/experimental_pass_through/messages/handler.py#L48-L74), and a Codex client setting named `wire_api = "responses"` ([agent CLI](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/proxy/client/cli/commands/agents.py#L76-L100)). These are useful clues, but they do not form one versioned API-wire object with explicit request, response, error, streaming, and translation guarantees.

LiteLLM's unified Anthropic endpoint proves the value of accepting one SDK shape and targeting multiple providers ([Anthropic-compatible endpoint](https://docs.litellm.ai/docs/anthropic_unified/)). It also demonstrates why translation fidelity must be explicit: its published Messages-to-Responses mapping documents fields such as `stop_sequences`, `top_k`, and `speed` as silently dropped ([mapping](https://docs.litellm.ai/docs/anthropic_unified/messages_to_responses_mapping)). Proxy should support the former behavior but reject the latter. An endpoint can be routable without being semantically compatible with every request sent to it.

Proxy should borrow:

- its provider and endpoint coverage checklist;
- its failure, retry, cooldown, and fallback scenario inventory;
- its model alias and deployment-group concept;
- its budget, rate, health, spend, cache, guardrail, and audit feature inventory;
- its provider-specific parameter knowledge and compatibility tests, where licensing permits independent implementation;
- its evidence that semantic, complexity, and adaptive routing are useful optional modes.

Proxy should not borrow:

- a single SDK-normalized request path for every provider and operation;
- unrestricted provider/model JSON as the primary domain contract;
- separate copies of budget and allowed-model fields on every identity entity;
- a monolithic router with operation, provider, retry, fallback, cache, and policy behavior intertwined;
- features whose only implementation is in LiteLLM's separately licensed enterprise area;
- LiteLLM itself as an opaque upstream hop. That would add latency, split evidence across two gateways, hide translation decisions, and make Proxy dependent on LiteLLM's configuration and edition boundaries.

The non-enterprise LiteLLM repository is MIT licensed, while enterprise content has separate commercial terms. Any code reuse requires a file-level license check; the recommendation here is architectural learning, not copying.

### 3.4 Cloudflare: learn route lifecycle and policy composition

Cloudflare's dynamic routing is a strong control-plane reference. A route is named, versioned, drafted, published, rolled back, and composed from constrained node types such as conditional, percentage, model, rate-limit, budget-limit, and terminal nodes. Requests invoke a published route by name rather than embedding an entire router configuration ([dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)).

Other relevant patterns are:

- spend limits can filter on model, provider, and custom metadata and can block or branch traffic ([spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/));
- model nodes expose timeout, retry-count, success, and fallback edges in one versioned JSON graph ([dynamic-route JSON](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/json-configuration/));
- provider credentials can use multiple keys and aliases ([bring your own keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/));
- fallbacks expose which step served the request ([fallbacks](https://developers.cloudflare.com/ai-gateway/configuration/fallbacks/));
- the product separates provider-native endpoints from compatibility endpoints and supports broad observability, caching, guardrails, and data controls ([AI Gateway documentation map](https://developers.cloudflare.com/ai-gateway/llms.txt)).

The caution is equally useful. Cloudflare deprecated its unified Chat Completions compatibility endpoint in favor of another REST path in June 2026 ([compatibility endpoint](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)). A gateway facade is an API product: endpoint, error, stream, and state semantics need explicit stability guarantees. "OpenAI compatible" is not a sufficient contract.

Proxy should use a similarly versioned route lifecycle, but keep mandatory authorization and data constraints outside the route graph so a branch cannot bypass them. It should also improve on the generic retry-count and best-effort spend model: the target codec classifies semantic outcomes; stateful retries need explicit idempotency authority; mutually exclusive funding leases the logical branch while each retry gets fresh subordinate spend authority; chargeable retry/fallback rewrites require a signed deterministic readmission plan; and firm budgets reserve before dispatch, select one canonical actual-cost representation before period partitioning, then settle it exactly once rather than relying on estimated analytics.

### 3.5 Vercel: learn the logical-model contract

Vercel's cleanest idea is the separation between a model ID and its provider endpoints. A caller requests a logical ID such as `creator/model`; the gateway knows which providers offer it, their supported parameters, caching behavior, and pricing ([models and providers](https://vercel.com/docs/ai-gateway/models-and-providers)).

Vercel also separates two fallback axes:

- try alternate provider endpoints for the same logical model;
- only then move to a different fallback model.

That distinction is documented directly in its [model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks) behavior and should be first-class in Proxy. Provider selection options such as ordered providers, allow-only filters, timeout, caching, and provider-specific options are request or route concerns ([provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)).

For enterprise governance, organization policy must dominate request preference. Vercel's [team provider allowlist](https://vercel.com/changelog/team-wide-provider-allowlist-on-ai-gateway) and [zero-data-retention controls](https://vercel.com/changelog/zero-data-retention-no-prompt-training-on-ai-gateway) illustrate this pattern. A request can narrow the eligible set, but it must not broaden an organizational allowlist or data-handling requirement.

Vercel's request-scoped BYOK behavior should not be copied literally for Opendoor. Its documentation allows system credentials to serve as fallback after a BYOK failure in some configurations ([BYOK](https://vercel.com/docs/ai-gateway/authentication-and-byok/byok)). In Proxy, a provider-credential fallback must be an explicit route transition authorized by policy and visible in evidence. It can never happen silently.

### 3.6 New API: learn breadth, not the domain model

New API demonstrates the breadth users expect from an "AI gateway": Chat Completions, Responses, Messages, embeddings, moderation, image generation and editing, audio speech/transcription/translation, reranking, realtime WebSockets, Gemini-native paths, and multiple asynchronous media/task APIs. Its relay-mode list and router make those operation families concrete ([relay modes](https://github.com/QuantumNous/new-api/blob/b6b97a66e39cfe45aab8cfb01ed96bba77cb279e/relay/constant/relay_mode.go), [relay routes](https://github.com/QuantumNous/new-api/blob/b6b97a66e39cfe45aab8cfb01ed96bba77cb279e/router/relay-router.go)).

Its `Channel` combines provider type, credential material, base URL, comma-delimited models, group, model mapping, priority, weight, status, multiple-key state, header overrides, parameter overrides, and other settings in one record ([channel model](https://github.com/QuantumNous/new-api/blob/b6b97a66e39cfe45aab8cfb01ed96bba77cb279e/model/channel.go)). This is operationally pragmatic but is the opposite of the separation Proxy needs for enterprise policy and audit.

Proxy should borrow:

- the operation coverage checklist;
- explicit channel priority plus weight semantics;
- model-name mapping and custom-endpoint use cases;
- multi-key health and quota scenarios;
- the practical evidence that media, reranking, realtime, and asynchronous tasks cannot all share one text request type.

Proxy should not borrow:

- the channel as the credential, endpoint, deployment, route, capability, and override unit;
- raw credential storage assumptions;
- a single group string as the primary access-control model;
- broad parameter/header override strings without publish-time typed validation.

New API is AGPLv3 with additional terms. Do not copy code or schemas into Proxy without legal approval and an explicit licensing decision.

### 3.7 9router and OmniRoute: retain coding lessons, reject local trust assumptions

9router and OmniRoute remain relevant because coding harnesses stress long-lived sessions, streaming, tool calls, prompt caches, multiple accounts, headroom, context limits, and API-wire translation. The existing [9router review](9router-scope.md) and [OmniRoute review](omniroute-scope.md) identify useful test and routing scenarios.

Their local-product priorities should not become enterprise architecture:

- desktop interception or man-in-the-middle behavior;
- subscription-account aggregation as a credential model;
- silent prompt or request mutation;
- implicit fallback to a "free" provider;
- local quota state as organization-wide truth;
- broad best-effort translation without a policy and audit boundary.

The current coding support should remain a demanding first workload for the new core, not the definition of the core.

### 3.8 Kong, Portkey, Envoy, and Azure APIM

These products fill gaps in the requested comparison:

- **Kong** demonstrates a mature gateway plugin/phase model with AI proxying, retries/fallbacks, semantic caching, guardrails, and load-balancing strategies including consistent hash, latency, usage, round robin, and semantic selection ([Kong AI Gateway](https://developer.konghq.com/ai-gateway/)). Kong or the company's existing ingress can remain the outer network/API gateway while Proxy owns AI semantics.
- **Portkey** demonstrates composable JSON configurations: conditions, fallback, retry, cache, load balance, and nested strategies, with every attempt represented in a trace ([configs](https://portkey.ai/docs/product/ai-gateway/configs), [fallbacks](https://portkey.ai/docs/product/ai-gateway/fallbacks), [conditional routing](https://portkey.ai/docs/product/ai-gateway/conditional-routing)). Proxy should adopt composability but not allow request-supplied config to bypass published policy.
- **Envoy AI Gateway** makes the control-plane/data-plane separation explicit and describes two-tier routing in which a first tier owns authorization and global traffic policy while a second tier selects self-hosted inference endpoints ([architecture](https://aigateway.envoyproxy.io/docs/concepts/architecture/), [inference routing](https://aigateway.envoyproxy.io/docs/capabilities/inference/)). This is a credible future transport for self-hosted models or Kubernetes-scale routing, not a prerequisite for the next Proxy version.
- **Azure API Management** illustrates centralized token-based rate limits and quotas per consumer, prompt-token estimation, semantic caching, and backend balancing ([GenAI gateway capabilities](https://learn.microsoft.com/en-us/azure/api-management/genai-gateway-capabilities)). The important lesson is that enterprise limits must use shared atomic state, not per-process maps.

### 3.9 Cross-cutting conclusions

The market converges on a common set of ideas:

1. Callers need stable logical model names.
2. Operators need separate provider credentials/endpoints and model deployments.
3. Routing configuration needs named versions, simulation, publication, and rollback.
4. Provider failover and model fallback are different operations.
5. Hard organization policy must override request or route preference.
6. Broad endpoint support requires operation-specific API-wire codecs and translation adapters.
7. Cost, rate, health, and cache state must be shared across data-plane instances.
8. Every provider attempt must be visible.
9. Compatibility facades are lossy unless native paths and capability matrices are preserved.
10. The strongest differentiation for Proxy is not provider count. It is trustworthy policy, evidence, protocol fidelity, and internal integration.

## 4. Product Boundary

### 4.1 Recommended product statement

> Proxy is Opendoor's governed AI inference gateway. It gives applications stable model interfaces while centralizing provider credentials, model availability, routing, data policy, access control, limits, cost attribution, reliability, and audit evidence.

### 4.2 In scope

- provider connections and credential references;
- model discovery, catalog curation, deployment configuration, and lifecycle;
- logical model publication and access-filtered discovery;
- OpenAI, Anthropic, and selected provider-native inference APIs;
- native forwarding and explicitly certified translation;
- routing, load balancing, retry, fallback, health, capacity, affinity, and cache-aware decisions;
- organizations, workspaces, teams, principals, roles, credentials, and model entitlements;
- data-handling and regional routing constraints;
- rate limits, concurrency limits, quotas, budgets, pricing, usage, and chargeback attribution;
- request, decision, attempt, and administrative audit evidence;
- guardrail integration points and policy-ordered execution;
- an operations console and administrative API;
- external and self-hosted model deployments.

### 4.3 Explicitly out of scope for the gateway core

- an agent runtime or multi-agent orchestrator;
- execution of application tools;
- MCP server discovery and execution;
- a prompt editor, prompt marketplace, or generalized prompt-versioning product;
- application conversation memory beyond the state needed to route or translate a request;
- vector database hosting or RAG pipeline orchestration;
- model training, fine-tuning job orchestration, and training-dataset management;
- general provider-account administration unrelated to inference connections;
- eval authoring and experiment analysis beyond routing certification and operational canaries;
- public payment processing, credit top-ups, model resale, or consumer subscription aggregation;
- arbitrary user plugins in the data plane;
- a generic HTTP reverse proxy for non-AI APIs;
- automatic semantic caching as a default behavior;
- silent provider, credential, model, or data-policy fallback.

### 4.4 The "thin waist" of the platform

The durable center of the gateway should be small:

```text
identity + workspace revision + operation requirements
              -> catalog | logical-model candidates | state-bound target
              -> optional route/provider attempt
              -> result/usage/evidence
```

Provider-specific request fields belong at adapter boundaries. UI concerns belong in the control plane. High-level application workflows belong above the gateway. This thin waist lets the product broaden without turning every new provider feature into a shared-schema field.

### 4.5 SDK-compatible application contract

The primary application experience should require only:

1. create or obtain a gateway credential bound to an organization, workspace, and principal;
2. change the SDK base URL to the gateway;
3. use the gateway credential instead of a provider credential;
4. request a published logical model enabled for that credential.

Illustrative OpenAI Python usage:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://ai-gateway.example.com/v1",
    api_key=GATEWAY_API_KEY,
)

response = client.responses.create(
    model="openai/gpt-5.4",
    input="Summarize this document.",
)
```

Illustrative Anthropic Python usage:

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="https://ai-gateway.example.com",
    api_key=GATEWAY_API_KEY,
)

message = client.messages.create(
    model="anthropic/claude-sonnet",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Summarize this document."}],
)
```

The model IDs are illustrative. Reserve maker-prefixed namespaces such as `openai/*` and `anthropic/*` for logical models pinned to that canonical model or an explicitly bounded family. Cross-model or classifier routes use an organization-owned namespace such as `opendoor/*`. A provider-looking name must never silently change to a different model maker.

The gateway must accept the authentication presentation emitted by each certified SDK/harness surface, including bearer authentication for OpenAI-compatible clients and `x-api-key` for Anthropic-compatible clients. Each request still resolves to exactly one normalized gateway credential. Duplicate values within one header, ambiguous token formats, conflicting bearer/API-key values, or an independently established workload identity plus a header credential are rejected.

One narrow exception is code-owned and conformance-tested: Claude Code's documented `apiKeyHelper` gateway flow may send the same token in both `Authorization: Bearer` and `x-api-key` ([Anthropic gateway configuration](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)). The Anthropic wire auth-presentation profile may normalize that exact equal pair to one credential using constant-time comparison; it never applies precedence or accepts unequal values. A workload-only mTLS/SPIFFE listener still rejects API-key headers. After authentication, strip every ingress credential and provider-selection header; only the provider adapter can materialize upstream authentication.

The gateway credential, not a caller-controlled header, determines organization and workspace. Applications should not need gateway-specific request fields for ordinary inference.

Optional trusted attribution, cache opt-out, or provider preference can use a small allowlisted header/metadata contract. Those preferences can only narrow published policy and are not required for basic use.

"Compatible" is a tested contract, not a marketing label. Maintain a versioned compatibility matrix for supported OpenAI and Anthropic SDK versions, endpoint methods, streaming, cancellation, errors, token counting, and provider-managed state. A supported SDK upgrade is released only after its conformance suite passes.

### 4.6 Model availability has three gates

A discovered upstream model is not automatically usable. It passes three independent gates:

1. **Deployed:** a model deployment exists against an active provider connection and has capability/certification evidence.
2. **Published:** a workspace exposes a logical model ID backed by that deployment, pool, or route.
3. **Entitled:** the calling principal and credential are allowed to invoke that logical model and operation.

Model discovery is its own operation and API wire, such as `model.list` over `openai.models` or an Anthropic-specific discovery contract. An OpenAI `GET /v1/models` request cannot predict whether the caller will later use Chat Completions or Responses, so it returns the credential-entitled union for that client family and includes operation/wire capability metadata only where the response schema permits it. `/gateway/v1/catalog` is the authoritative compatibility view. An application never sees every model discovered from a provider account.

If a caller requests a logical model that is unpublished or not entitled, the gateway returns the ingress wire's model-access/not-found error before creating a provider attempt. Restricted model existence is not disclosed to an unauthorized caller.

### 4.7 Direct models, deployment pools, and routed models

Applications should choose direct versus routed behavior through the `model` value; they should not set a separate router flag.

- **Direct logical model:** resolves to exactly one model deployment. There is no load balancing or model selection.
- **Pooled logical model:** resolves to multiple deployments of the same canonical model, allowing region/provider failover or load balancing without changing model semantics.
- **Routed logical model:** resolves through a route that may choose different canonical models using conditions, classifiers, cost/quality policy, experiments, or explicit model fallback.

Examples:

```text
openai/gpt-5.4          -> direct or same-model deployment pool
anthropic/claude-sonnet -> direct or same-model deployment pool
opendoor/fable          -> direct or same-model pool for the approved Fable release
opendoor/text-default   -> policy-managed route across approved models
opendoor/coding-auto    -> classifier route with coding tiers
```

An Opendoor engineering credential can therefore be entitled to both `opendoor/coding-auto` and a direct model such as `opendoor/fable`. Selecting `opendoor/fable` bypasses classification and invokes only its pinned deployment/pool; selecting `opendoor/coding-auto` opts into the published router. The gateway never auto-routes merely because routing is available.

Internally, all three compile to the same bounded execution-plan representation. The control-plane API and TOML format provide concise `direct` and `pool` forms so operators do not have to author a graph for common cases. The compiler expands those forms into trivial routes.

This keeps LiteLLM's useful property that routing is optional while avoiding the implicit behavior where repeating the same model name in a list silently creates a router group.

### 4.8 Application-owned versus gateway-owned choices

The application owns:

- which published logical model it requests;
- standard SDK request parameters allowed by policy;
- stream versus non-stream behavior;
- optional trusted attribution and an explicit cache bypass;
- optional provider/deployment preference only when the workspace permits it.

The gateway owns:

- provider credentials and physical endpoint selection;
- model entitlement and data-policy enforcement;
- forced/defaulted/capped parameters;
- routing, health, retry, fallback, affinity, and cache policy;
- audit, usage, and cost evidence.

An application can request a more specific allowed target or disable an optional optimization. It cannot select an unpublished deployment, bypass a required guardrail, broaden its model allowlist, or force a provider that violates workspace policy.

### 4.9 Application and harness onboarding contract

Applications and coding harnesses use the same data plane and authorization model. They differ only in how configuration is installed.

For application code, the supported contract remains three values:

```text
base URL + gateway credential + logical model ID
```

The application keeps using its normal OpenAI or Anthropic SDK. The selected SDK method determines the ingress API wire; the logical model determines direct, pooled, or routed behavior. No application-specific proxy library, route flag, provider name, or gateway request body is required.

Coding harnesses need an equally small but file-oriented setup. Keep two separate concepts:

- **SDK compatibility profile:** part of the code-owned API-wire conformance matrix. It declares supported SDK versions, methods, base-URL shape, authentication presentation, session-key source (`state_id`, registered header/token, or `none`), and test results. It does not mutate application files or enter a workspace runtime revision.
- **Harness configurator manifest:** a code-owned, versioned installer for a client such as Codex, Claude Code, or Cowork that requires local settings. It declares supported client versions, ingress wire, owned config fields/files, credential-helper integration, model setting, any certified session-token mechanism, serializer, uninstall behavior, and conformance probe.
- **Credential issuance template:** a workspace-owned, versioned control-plane object for creating a credential. It references one exact access-profile version and, when needed, optional exact credential-narrowing policy versions already present in the active workspace revision, plus principal eligibility, credential type, maximum TTL, authentication-presentation constraints, and allowed harness configurators. It contains no independent allow/deny rules and is never interpreted by the data plane.
- **Onboarding profile:** a workspace-owned, versioned control-plane resource that selects harness configurators, a default logical model, a pre-approved credential issuance template, and a named synthetic principal context for preview/simulation. It can be authored through the API/console or TOML. It does not grant access by itself or enter the data-plane snapshot; credential issuance reauthorizes the actor, resolves the template's exact references, and proves the real subject fingerprint against the active revision.

The target operator experience is:

```text
proxy setup codex --profile opendoor-engineering
proxy setup claude-code --profile external-coding
```

The existing hosted `/setup.sh` and marker-owned client settings are the bootstrap for this experience. Keep their idempotent/conflict-aware behavior, but generate client-specific logic from harness configurator manifests instead of one growing shell script. A packaged or signed setup client authenticates interactively or through an approved workload flow; a newly issued raw token is never passed as a shell argument or embedded in a copied command.

The setup flow authenticates the user, resolves the profile, verifies that the intended logical model is visible, reauthorizes credential issuance, previews the local configuration diff, writes only the client's owned settings atomically, and runs a non-billable or tightly bounded compatibility probe. A newly created compatibility key is returned exactly once over the authenticated channel to the local setup binary, only after every traffic-receiving ingress gate has ACKed the granting identity-directory tuple or been fenced by a successor membership epoch, and stored in an approved OS keychain or credential helper. If a client cannot use a helper, the fallback token file is mode `0600`, contains only a gateway key, and is never printed, logged, or passed through process arguments. Selecting an existing credential is valid only when a matching local secret reference already exists. Uninstall removes owned configuration and revokes the dedicated credential.

Illustrative generated configuration is:

| Client | Ingress API wire | Base URL |
|---|---|---|
| OpenAI SDK / Codex | `openai.responses` | `https://ai-gateway.example.com/v1` |
| Anthropic SDK / Claude Code / compatible Cowork release | `anthropic.messages` | `https://ai-gateway.example.com` |

A client-specific value such as Codex's `wire_api = "responses"` is an installation detail mapped by the Codex harness configurator to the gateway wire `openai.responses`. It is not itself the gateway's provider, model mode, or API-wire registry.

The same logical model can therefore be published on multiple ingress wires. Its compiled candidate set may differ by wire and requested features, but every candidate remains subject to the same effective policy evaluation, including any wire-specific permission.

Do not make an access policy silently change a route's quality contract. `opendoor-engineering` may default to `opendoor/coding-auto`; `external-coding` defaults to a distinct `opendoor/coding-economy` contract over the complete reachable execution plan, not only its visible terminals. Every classifier output must have an inexpensive eligible terminal; every classifier, input/output guardrail, or connector target must use an economy-approved provider/model class; and the plan declares maximum routing overhead plus total request cost. External processor-service-principal policy explicitly denies frontier targets, so a hidden child cannot spend on a model the caller cannot select.

Publication proves route and mandatory-processor totality for every active subject/credential fingerprint and the onboarding profile's named synthetic principal context. A classifier-failure reject edge is valid failure handling, but a reject edge does not make a promised classifier output total; a named degradation edge counts only when it ends at an eligible terminal. If policy or the complete-plan cost ceiling can empty a promised output, publication fails or the onboarding profile is unavailable. Editing the local model setting therefore cannot unlock a frontier model or turn an economy route into a partial route.

`external-coding` is a sponsored workforce profile, not public signup. Setup requires an approved guest/partner principal bound to one workspace, a named internal sponsor/owner, an access expiry, and a successful identity/access review. Issue a dedicated short-lived credential per harness installation; sponsor removal, guest deactivation, expiry, or workspace removal revokes it through the credential directory. External attribution never substitutes for this principal or expands its policy.

Sharing an API wire does not make two clients equivalent. Claude Code and Cowork require separate harness configurator manifests and tests even if both emit Anthropic Messages. A client version is supported for setup and troubleshooting only when it exposes a documented endpoint/credential override or another approved integration mechanism; Proxy must not rely on local interception or silently patch the client.

A bearer API key cannot prove which harness binary is presenting it. Harness-version matrices govern configurator generation, compatibility claims, and support, not runtime authorization. Runtime safety comes from the credential's exact operation/model/provider/resource/processor/data/budget entitlements and remains intact if the bearer is replayed by another client. A future policy that truly requires device or binary binding must use a separately designed sender-constrained mechanism such as mTLS, DPoP-style proof of possession, or approved device attestation; it must never trust `User-Agent` or another caller-asserted version string.

Onboarding is a control-plane convenience, not a second runtime path. Profile approval resolves its issuance template's exact access profile, optional narrowing policies, default model, and explicitly declared synthetic principal context against the current workspace revision and stores compatibility evidence. The synthetic context names principal type and required team/attribute inputs; it is preview evidence, not authority. Credential issuance computes and proves the real subject's effective fingerprint against the then-active revision. The issued credential persists the issuance-template version, exact access-profile version, fully expanded credential-scoped policy attachments plus any exact narrowing policies, immutable restrictions, effective-policy fingerprint, issuing workspace revision, and expiry. Changing a template or profile affects only future credentials. A later workspace publication must retain those referenced policy versions or explicitly rebind or revoke every affected credential and wait for the identity-directory ACK; it may never reinterpret an existing credential through new template/profile contents.

Conversely, workspace publication proves every concrete active principal/credential fingerprint and separately simulates each approved onboarding profile's named synthetic context. It blocks activation, revokes/rebinds affected credentials, or marks a profile unavailable when totality or issuance references fail. This validation linkage does not place configurators, templates, or onboarding profiles in the data-plane snapshot. Generated client configuration contains only standard client settings and a gateway credential reference. It must be idempotent, reversible, version-aware, and covered by golden configuration plus real harness smoke tests. An onboarding profile cannot approve a harness configurator until that exact manifest and client-version matrix exist in the code registry and pass conformance.

## 5. Target Domain Model

### 5.1 Core definitions

#### Operation definition

A code-owned, versioned semantic contract for one action such as `model.list`, `text.generate`, `embedding.create`, `batch.result`, or `realtime.session`. It declares:

- a stable operation ID and contract version;
- one resolution mode: `workspace_catalog`, `logical_model`, `state_binding`, or `workspace_resource`;
- required request inputs and state-resource actions;
- whether the action can create externally visible state;
- idempotency, retry, commitment, cancellation, and result-lifecycle semantics;
- a billing lifecycle of `request_terminal` or `resource_terminal`; the latter resolves one discriminated cost plan: `firm` with a provider/contract-backed maximum lifetime or charge horizon, or `operational` with authorized-use and cleanup deadlines, rolling reservation/forecast rules, overrun handling, and terminal actions but no claimed lifecycle ceiling;
- for session operations, the closed-world inbound/outbound event actions and per-event admission/ordering rules;
- whether input/output guardrails, request transformation, exact caching, provider dispatch, and usage settlement can apply;
- the feature and policy vocabulary that API wires and deployments must implement.

`workspace_catalog` operations resolve an authorized workspace view without a model route. `logical_model` operations require a caller-visible logical model and use its compiled route when no hard provider state is present. A logical-model request may also carry authorized state references. A binding declared hard by its operation/state-mapping contract, such as a prior response or conversation, pins execution to one exact target before cache or route traversal. A certified reusable resource such as a provider file may instead contribute a bounded compatible-deployment set; all references are reduced to one aggregate intersection before routing, and cache remains disabled. `state_binding` is reserved for resource-only actions such as job result, cancel, read, or delete whose target comes entirely from authorized gateway resources. Such an operation rejects a caller model field unless its exact wire contract requires an origin-model assertion, in which case equality is validated without opening a route. `workspace_resource` covers model-less creation such as a file upload whose registered kind and purpose resolve to an authorized workspace resource profile.

The initial operation registry does not support moving provider-owned state to another logical model. A future migration feature must introduce a distinct code-owned `state_migration` resolution contract that accepts both an authorized source binding and an authorized target logical model, proves materialization/translation fidelity, and creates a new lineage. It is not an option on `state_binding` and cannot be approximated by changing the request's model field.

An operation definition owns semantic lifecycle rules, not HTTP paths, encoding, framing, provider credentials, or deployment selection. API-wire definitions expose exact operation-definition versions. Built-in definitions are registered by code at startup; database or TOML configuration can enable and authorize them but cannot invent executable operation semantics.

#### API wire definition

A code-owned, versioned contract for one externally observable API structure. Examples are `openai.responses`, `openai.chat_completions`, `anthropic.messages`, `google.generate_content`, and `aws.bedrock.converse`.

An API wire definition owns:

- a stable wire ID and contract version;
- exposed operation-definition IDs and versions;
- HTTP methods and path templates;
- request, response, and error schemas;
- required version and feature-negotiation headers;
- authentication/header conventions expected by compatible clients;
- HTTP, WebSocket, or WebRTC bindings plus SSE, multipart, binary, or job framing;
- the allowed interaction modes, such as `unary`, `stream`, `session`, or `job`;
- externally visible ID, state, pagination, and resource semantics;
- any caller idempotency token, code-owned namespace, caller-intent normalization, pending-collision behavior, replay-artifact limits/retention, and certified cross-wire equivalence semantics;
- the feature vocabulary used for compatibility checks;
- absolute ingress limits and parsing rules for headers, encoded and decompressed bodies, multipart parts, stream frames, compression, chunking, upload deadlines, and backpressure.

An API wire is not a provider, model, deployment, or operation. Its code-owned definition does include the network protocol, paths, encoding, framing, and lifecycle contract needed to make that API observable. For example, `anthropic.messages` can be an ingress contract for a request ultimately served by Anthropic, Bedrock, or another provider. The exact wire version is resolved from the network route and explicit version headers where available before authorization and routing.

Built-in wire definitions are registered by code at startup. Operators may enable a wire or bind it to a deployment, but cannot define executable schemas or arbitrary public paths in database JSON.

#### Wire codec

A trusted code module that implements one API wire. It owns:

- route recognition and envelope validation;
- extraction of the registered operation, model, stream intent, requested features, and state references;
- request/response parsing and serialization for translation paths;
- bounded incremental request/response and streaming decoders/encoders with backpressure;
- gateway-generated success, error, and close envelopes;
- wire-level usage and identifier shapes;
- a closed-world registry of fields, headers, content blocks, tools, and events, including any explicitly safe extension points.

Wire codecs do not own provider credentials, deployment selection, routing, or access policy. A native same-wire path should preserve the exact supported syntax where possible; it should not round-trip every request through a generic object merely because a codec exists. Production requests containing an unknown field, header, content block, tool type, or event-producing option fail before egress unless the exact wire release registers the extension, classifies its policy and data effects, and makes it visible to capability matching.

Unknown provider response fields or stream events are forwarded only when that same release explicitly classifies them as safe for the active response and guardrail policy. Otherwise the gateway fails that response in the ingress wire's valid form, emits a conformance incident, and records the exact deployment/wire/feature binding. A configured repeated-event threshold may open a shared runtime quarantine circuit for only that binding with a bounded TTL; it does not mutate certification. Suspending certification requires a signed narrowing delta or an approved control-plane transition, preventing one malicious or malformed response from globally changing durable configuration. Provider beta and feature headers are exact, versioned allowlists, never prefix-based passthrough.

#### Translation adapter

A trusted, directed adapter from one API wire and contract version to another for one operation. It owns request, response, error, stream-event, usage, stop-reason, identifier, and state mapping for an explicitly declared feature subset.

Translation adapters are registered by code and certified independently. Each adapter declares `exact`, `lossy`, or `unsupported` behavior by feature. A deployment is eligible only when the request's complete feature set has a certified path. Unknown or unrepresentable behavior is rejected before the provider call, never silently dropped.

A translation adapter may use a small operation-specific intermediate representation internally or map directly between the two codecs. It does not create a universal gateway request schema.

#### Provider adapter

A trusted code module for the physical integration with one provider family. It owns:

- connection and credential-slot configuration JSON Schemas plus physical deployment-hosting fields;
- authentication materialization and secret handling;
- endpoint, region, project, API-version, and safe URL construction;
- the egress API wires and endpoint variants the provider can host;
- discovery and health probes;
- typed transport observations for connection failures, protocol status, provider headers, request IDs, quota/capacity headers, and whether any bytes may have left the process;
- physical request/response transport beneath a shared safety wrapper that bounds headers, raw/compressed/decompressed bytes, deadlines, throughput, and backpressure before the target egress wire codec parses semantic frames;
- physical request-ID extraction plus pricing and discovery hooks.

Provider adapters compose with wire codecs. Provider-specific semantic or billing-affecting request options are versioned extension schemas of the target egress wire release and are enabled only by the deployment binding and certification. The target codec alone validates and serializes those fields, parses success/error/usage semantics, and owns SSE, WebSocket, multipart, event, and other semantic framing plus frame-level limits. The provider adapter owns only physical endpoint/region/project/API-version paths, authentication, network controls, non-semantic headers, discovery/health, and bounded raw transport. It never interprets semantic body fields, service tier, safety policy, billing behavior, or retryability and never owns route traversal, fallback, or cross-wire translation. The shared attempt orchestrator applies compiled retry/fallback policy to codec outcomes and typed transport observations; the transport performs no implicit retry. Adapters are registered by code at process startup; a database row can enable and configure one but cannot inject executable adapter code.

#### Provider connection

An organization-owned connection to an upstream account, project, subscription, or self-hosted cluster. It contains:

- provider-adapter ID and version;
- account, project, subscription, or organization identifiers;
- allowed base URL and network profile;
- regions and API versions;
- default safe headers;
- connection status and compatibility metadata;
- versioned supported auth contracts, each naming one code-owned adapter mechanism plus the required upstream account/scope verification;
- ownership, tags, and workspace grants.

Connections do not list logical models, contain raw/inline credentials, or choose among keys. Deployments, resource targets, and state bindings pin this stable upstream-account/network identity; routine credential rotation does not create a fake deployment or state migration.

#### Provider credential slot, set, and directory generation

A provider credential slot is an organization-owned, immutable authentication-source version beneath one provider connection. A static-secret slot pins the secret manager's exact immutable object version, expected upstream account/project identity, credential scope, auth method, activation/expiry, and status. Materialization requests that exact version and fails closed if the returned version or a provider identity/scope probe differs. A mutable alias such as `latest` may let discovery propose a new slot version, but it is never runtime authority.

A workload-identity slot instead pins its issuer, audience, subject/service account, role, auth scope, and versioned trust/permission-policy contract. Short-lived token/session IDs are attempt evidence, not slot identity; changing the role binding or trust/permission policy requires a new slot version. Directory activation and materialization require a fresh signed attestation from the authoritative identity/secret system plus any provider account/scope probe. A provider or IAM mechanism that cannot expose an immutable version or attest the pinned contract is ineligible for production workload-identity slots. Neither slot form contains secret material in the gateway database.

An immutable **credential-set version** names exact compatible slot versions and their bounded ordered/weighted/quota-aware selection policy. A separately signed, hash-chained **ProviderCredentialDirectoryGeneration** is the sole runtime credential selector. Its ordinary mapping names exactly one active set for every reachable `(connection version, auth-contract version)`. Each separately typed retained-access entry matches one stable continuity requirement and authorizes a certified successor set, the exact historical source required by `exact_auth_source`, or an incident-only originating slot for namespace-bound reconciliation. The entry, not the lease, carries generation-specific successor or incident authorization. Publication enforces that an exact-auth entry names the requirement's identical slot and that an incident namespace entry names `originatingCredentialSlotVersionId`; the latter is legal only for `reconciliation`, one exact lease/target/operation, the named lifecycle principal, and a signed incident authorization. It can never serve caller continuation. The directory advances through the same staged, tuple-stamped activation protocol as the identity directory and is included in request admission; removals first enter the narrowing channel, while routine rotations use pinned rollout without workspace-wide quiescence. Workspace revisions and state-retention generations carry only compatibility floors and stable requirements, never another credential mapping.

Credential continuity for provider-owned state is not inferred from equal account labels or OAuth scopes. An immutable lease pins a stable `provider_state_namespace` requirement containing the namespace and originating slot, or `exact_auth_source` when the provider binds objects to the creating key or identity. Each directory generation may satisfy the namespace requirement with a different successor set only through an exact target/operation certification proving that set can access predecessor-created resources, jobs, upstream idempotency outcomes, and billing records. Certification fixtures exercise create with the named origin and every lifecycle/reconciliation action with the proposed successor. Rotation from B to C therefore publishes new evidence for C against the original requirement; it neither mutates the lease nor treats an A-to-B certificate as proof for C.

Each admitted request pins one directory generation before processors or target selection and retains it through terminal request/child/attempt cleanup. Ordinary stateless attempts select only through that admitted generation. A newly introduced slot/set may serve stateless request-terminal traffic as soon as its pinned rollout reaches the admitting gate, but it is not **lifecycle-creator eligible** merely because one newer gate can see it. Before any attempt that might create provider state or leave an ambiguous outcome can dispatch, a linearizable credential-coordinator gate preallocates the outcome/lease/registration IDs, registers its exact selected-slot continuity requirement, creates the attempt's reconciliation lease, and freezes the complete set of directory generations still admissible at every traffic-receiving gate/ring. Its signed coverage receipt proves that every member of that set contains a matching retained-access entry, or that the lagging gate/ring was fenced before the receipt. A generation introducing slot B therefore cannot create externally durable state while any gate can still admit a generation that cannot continue B-created work.

Directory activation, traffic-gate admission-set changes, and requirement registration serialize: either the registration commits first and every candidate/admissible generation must cover it, or the admission-set change commits first and the receipt covers its new high-water. V1 keeps the requirement registry, traffic-gate directory-admission set, provider-outcome/reconciliation-lease records, and directory activation log in the same serializable Postgres authority; a future split must use an equivalent fenced prepare/commit protocol, not an asynchronous receipt. If an admitted request chooses a slot that lacks this all-gate creator coverage, it fails before provider I/O or undergoes full readmission and reselection. On binding activation, the registration atomically gains the state/reconciliation lease owners, each state lease records the minimum compatible directory generation, and public state or job handles remain unreleasable until a fresh receipt covers every directory generation still admissible anywhere. A follow-up request whose pinned generation is below a referenced lease's floor or lacks its retained entry is re-admitted through a compatible gate before upstream-ID decryption or receives the wire-native unavailable response; it never attempts provider access under the lagging generation.

A retained attempt involving state resolves the retained entry for every referenced binding/lease without decrypting any upstream ID, intersects the physical slots authorized by all entries, and rejects an empty intersection before credential materialization. It persists one authoritative common-slot selection, then separate evidence rows prove for each exact lease/requirement that this one slot is a certified successor-set member, equals the exact auth source, or equals the namespace origin under incident reconciliation. Evidence rows never copy the slot; one entry or lease can never stand in for the aggregate set. Reconciliation-only work uses the same shape for its single exact lease, and incident entries cannot join caller state continuation.

The coordinator owns four monotonic reference high-waters: admitted-request directory references, provisional lifecycle-creator requirements, state-lease requirements, and reconciliation-lease requirements. A new directory must cover every requirement through all three lifecycle high-waters; post-snapshot registrations carry signed all-gate coverage receipts and are serialized into the next publication. An external secret version or workload-identity contract can be destroyed only after ordinary and retained selection are blocked, active/staged/rollback references and admitted requests drain, and all three lifecycle indexes prove no exact-auth-source or namespace-origin requirement still needs it. Compromise blocks ordinary use immediately. The narrowing contract either disables the slot for every purpose or restricts it to an exact lease-matched, separately authorized incident-reconciliation entry that derives the physical slot from the exact-auth requirement or the namespace requirement's immutable originating slot, removing it from ordinary sets and `state_continuation`. If the provider revokes that source and no certified successor exists, the lease remains unresolved rather than falsely declaring cleanup or cost reconciliation complete.

V1 may publish a one-slot set, but that slot still pins an exact secret version or workload-identity contract. Rotation always creates a new slot/set/directory generation; it never mutates a referenced secret behind an active generation or silently selects an unregistered alternate key.

#### Canonical model definition

A deployment-independent catalog identity for an immutable model release or an explicitly bounded family, such as a specific OpenAI model, a Claude version, or an internal fine-tune. It identifies the model and its maker regardless of which approved provider channel serves it. It contains descriptive facts, not credentials or live routing state:

- canonical ID, maker, family, version, lifecycle, and immutable naming aliases;
- supported input and output modalities;
- operation capabilities and limits;
- context and maximum-output limits;
- tool, structured-output, reasoning, streaming, batch, and caching capabilities;
- known data-handling characteristics;
- source provenance and confidence.

A catalog feed such as [models.dev](https://github.com/anomalyco/models.dev) can seed facts, but it must never be the sole runtime truth. Provider discovery, provider-adapter knowledge, certification tests, and operator overrides all contribute evidence. Mutable upstream selectors such as `latest` are discovery inputs only: the control plane resolves them, records the observed release, and production egress uses a provider-callable immutable upstream identifier. A provider channel that cannot expose an immutable callable release remains experimental/non-production. Drift discovery creates a new candidate deployment revision for recertification; it never allows an active production deployment to call an uncertified release.

#### Model deployment

The concrete routable unit. It joins one provider connection to one upstream model identifier and endpoint context:

- organization and workspace eligibility;
- provider connection;
- canonical model definition;
- immutable callable upstream model/deployment release ID for production;
- region, API version, endpoint variant, and processing tier;
- one or more egress API-wire bindings with exact contract versions and one required provider auth-contract version each;
- operation, interaction-mode, and feature support per wire binding;
- an egress-response safety profile covering headers, encoded/decompressed bytes, compression ratio, events/frames, billable/output units, idle time, total duration, and throughput/backpressure;
- effective capability snapshot;
- effective price schedule;
- data-handling attributes;
- capacity/rate metadata;
- health, certification status, and lifecycle state.

Health, cooldown, quota, and session affinity refer to deployments, not abstract models.

The required auth contract is part of each egress wire binding because one connection may expose different provider scopes or authentication mechanisms for inference, files, batches, and administration. Publication rejects a binding whose `(connection version, auth-contract version)` is missing, ambiguous, incompatible with the adapter/wire, or absent from the candidate provider-credential directory. Routing never infers an auth contract from provider type or chooses a more privileged contract at runtime.

#### Logical model

The stable model identifier exposed to clients. Examples could include:

- `opendoor/text-default`;
- `opendoor/coding-auto`;
- `openai/gpt-5.4-pinned`;
- `anthropic/claude-enterprise`;
- `opendoor/embedding-default`.

A logical model declares supported operation-definition versions and ingress API-wire promises and points to one published route version. A one-to-one direct model is still represented by a route with one deployment target. The compiler calculates eligible deployments separately for every promised wire, operation version, interaction mode, and feature profile. That uniformity makes access, rollout, evidence, and rollback consistent without pretending every target supports every client contract.

#### Route and route version

A route is the named control-plane resource. A route version is immutable configuration that chooses among canonical-model or deployment selectors within the already-authorized candidate universe. Public logical models are route roots, never route targets. This prevents recursive model resolution and keeps one routing language. A route is compiled and validated before publication.

#### Resource profile

A resource profile is an immutable, versioned workspace runtime resource for a model-less provider-resource creation purpose, such as an OpenAI-compatible file upload. It declares:

- the code-owned operation version, resource kind, and registered purpose values it serves;
- one or more immutable profile-owned resource-target entries, each binding an exact provider connection/adapter version, required auth-contract version, region, resource endpoint variant, egress wire/codec, response-safety profile, and state-mapping certification;
- an exact target or bounded, non-recursive resource-target pool with deterministic selection and no classifier;
- data classification, residency, retention, deletion, size, billing lifecycle, and discriminated firm or operational resource-cost-plan inputs;
- the exact logical-model/deployment targets with which each resulting binding may later be used and whether that compatibility is a bounded candidate intersection or hard affinity;
- a complete operation-preflight manifest, state-creation barrier, and price references.

The compiler maps `(wire/version, operation/version, resource kind, registered purpose/discriminator, effective-policy fingerprint class)` to exactly one authorized profile version. Overlapping profiles for any active fingerprint or onboarding synthetic context fail publication; provider rollout and fallback belong inside one profile's bounded target pool, not profile priority. An additional discriminator is allowed only when the code-owned wire/operation registry defines and validates it, and it enters preflight/evidence.

The caller cannot supply a provider endpoint, connection, deployment, or arbitrary profile ID. A created resource is bound to one exact resource target before its public ID is released and stores the profile's immutable later-deployment compatibility. Moving it to another resource target or outside that certified deployment set requires a separately code-owned and certified migration/materialization operation; profile compatibility is not permission to fabricate portability.

Every resource target similarly pins one required auth-contract version. Certification proves that the contract's scope permits only the registered resource actions and expected upstream account; runtime does not borrow an inference binding's credentials or infer a contract from the endpoint path.

#### Execution target reference

Every provider-bound runtime owner uses one canonical discriminated reference: an exact immutable **model-deployment wire-binding version** or an exact immutable **provider-resource-target version**. That referenced version resolves the provider connection, required auth contract, provider adapter, egress wire/codec, region/endpoint, response-safety profile, and certification. These facts are never reconstructed from parallel nullable deployment/resource/connection/auth fields. Candidate evaluation may materialize derived facts for indexing, but the versioned target reference remains the authority recorded by routing decisions, bindings, leases, cost plans, obligations, attempts, and evidence.

A state constraint is likewise discriminated without copying the selected target. Provider-managed conversations and other nonportable state carry `hard_selected_target`, which resolves through the binding's immutable selected-execution ID. A certified reusable provider resource resolves its exact provider-resource target through that same ID and carries only a nonempty set of exact compatible model-deployment wire bindings for model use. Resolution converts all authorized member constraints into either one aggregate hard target or one compatible model-target intersection; it never carries a nullable hard target beside an unrelated compatibility list.

#### Processor profile and connector

A processor profile is an immutable, versioned runtime resource for a gateway-internal route classifier, guardrail, approved enrichment call, or request transformation. It is never a public logical model or caller-selectable endpoint. It declares:

- purpose plus typed input/output schemas and a closed certified outcome envelope;
- an in-process, model-backed, or connector-backed implementation;
- data minimization/redaction, classification, residency, capture, and retention rules;
- transport timeout, bounded retry, error classification, rate limit, invocation mode/cardinality, and maximum billable exposure;
- for transformations, a versioned input/output contract, worst-case byte/token expansion, and whether feature, modality, data-classification, or state-reference effects are certified monotonic;
- required executable component versions and certification evidence.

A model-backed profile contains a non-recursive terminal plan whose compiled candidates are exact deployment-wire-binding references. A connector-backed profile references a versioned processor connector. An in-process profile pins the code-owned implementation and schema-validator hashes. The connector binds a code-owned processor adapter to an approved endpoint, exact immutable secret version or versioned workload-identity trust/permission contract, network profile, schemas, data-handling facts, and either a complete versioned billable-unit/cost schedule or an explicit certified zero-cost declaration. The adapter owns safe URL/auth construction, serialization, result validation, and error classification. Generic arbitrary HTTP is not a processor implementation.

The profile owns only the outcomes an invocation can produce, not what those outcomes mean to its parent. The invoking route node owns classifier reject/degradation edges, the invoking guardrail policy owns fail-open/fail-closed/observation behavior, the operation stage owns transformation/enrichment failure behavior, and publication rejects any parent action not representable by the profile's certified outcome envelope.

Processor profiles, connectors, and their grants are included by exact version in the workspace revision. Executable processor adapters, in-process implementations, and schema validators remain code-owned components with hashes that the serving ring must ACK.

#### Access profile

An access profile is an immutable, versioned workspace runtime resource that contains only a named set of exact typed policy-version references for reuse. It cannot contain policy bindings or scope: mandatory organization/workspace/team/logical-model bindings remain independent resources, while attaching a profile to a principal or credential supplies that attachment's one explicit scope.

The compiler expands each profile attachment into concrete `ScopedPolicyAttachment` records, records the profile version as provenance, and then evaluates normal policy precedence and deny rules. An issued credential persists the exact profile version plus every expanded credential-scoped attachment and effective fingerprint; runtime authority never depends on later profile contents. A workspace revision must retain those exact policy versions or explicitly rebind/revoke affected credentials through the identity-directory activation protocol.

#### Workspace revision

An immutable manifest of the exact published operation-definition versions, logical-model versions, route versions and preflight manifests, provider-connection/auth-contract requirements, resource-profile/cost-plan versions, access-profile and policy versions, processor-profile/connector versions, canonical-model catalog versions, deployment revisions, API-wire/codec versions, translation/provider/processor adapter versions, minimum compatible provider-credential-directory/state-retention generations and retirement epoch, and pricing/FX-selection references active for a workspace. It contains no active credential mapping, retention-manifest contents, request valuation quote/epoch, or observed mutable retirement state. Every request records its revision ID and hash. SDK compatibility profiles, harness configurators, credential issuance templates, and onboarding profiles are control-plane release artifacts and do not enter this runtime revision.

This is more reliable than independently reading "current" rows for routes, policies, prices, and deployments during a request.

### 5.2 Ownership matrix

| Concept | Authority | Changes when | Must not own |
|---|---|---|---|
| Operation definition | Code registry | An action's resolution, state, idempotency, commitment, guardrail, cache, or lifecycle semantics change | Network paths/framing, provider credentials, model routing |
| API wire definition | Code registry | A public request/response/error/stream/state contract changes | Provider credentials, model routing, account endpoints |
| Wire codec | Code registry | Parsing, validation, serialization, or stream framing changes for one wire | Provider selection, access policy, cross-wire semantics |
| Translation adapter | Code registry + certification artifact | A directed wire-to-wire semantic mapping changes | Provider auth, route selection, arbitrary multi-hop behavior |
| Provider adapter | Code registry | Physical auth, endpoint/region/project/API-version paths, network controls, non-semantic headers, discovery, health, raw bounded transport, or typed transport-observation changes | Semantic or billing-affecting body fields, service tier, safety policy, retry/fallback decisions, framing, client ingress contracts, logical models, cross-wire translation |
| Processor adapter/implementation | Code registry | An internal processor's executable serialization, validation, or in-process behavior changes | Caller entitlement, arbitrary endpoints, mutable profile policy |
| Provider connection | Versioned DB resource or TOML | An account/project identity, region, endpoint, or network path changes | Models, credential/key selection, public IDs, route behavior |
| Provider credential slot/set version | Versioned DB resource or TOML + immutable secret/workload-identity contract reference | An auth source, slot lifecycle, or bounded per-connection selection set changes | Connection/model identity, raw secret values, caller-visible routing |
| Provider credential directory generation | Credential coordinator + signed ACKed distribution | Ordinary-set or requirement-matched certified-successor/exact-slot access rotates; creator/lease and traffic-gate-admission high-waters advance | Slot/set contents, workspace routing, caller authorization, immutable lease requirements |
| Processor connector | Versioned DB resource or TOML | An approved non-model processor endpoint, auth/network path, or data contract changes | Public inference, route selection, arbitrary schemas |
| Canonical model definition | Curated/discovered catalog | A model release's identity, lifecycle, limits, or intrinsic capability facts change | Credentials, endpoint health, public entitlement |
| Model deployment | Versioned DB resource or TOML | An upstream model is bound to a connection, region, price, or egress wire | Client-facing model identity, organization policy |
| Logical model | Versioned DB resource or TOML | A stable public model ID, ingress-wire promise, or route changes | Provider credentials, raw endpoint details |
| Resource profile | Versioned DB resource or TOML | A model-less resource purpose, bounded create target, compatibility, state mapping, data, retention, or cost contract changes | Caller-selected endpoints, arbitrary provider administration, executable state migration |
| Resource cost plan | Versioned DB resource or TOML | Relative firm/operational lifecycle, estimator, valuation-selection, budget-compatibility, terminal-action, or rolling-reservation rules change for one operation/target | Request-specific timestamps, mutable price guesses, selected target |
| Canonical actual-cost evidence mapping + budget funding-plan transformation | Code registry + conformance certification | Canonical usage/invoice/correction evidence maps to selected cost components differently, or a retained-charge retry/fallback produces a different successor operand/topology contract | Runtime source choice, mutable price/FX data, per-request amounts, unsigned expression rewrites, policy authorization |
| Resolution + decision header/outcome + candidates/selection admission + selected execution | Durable admission authority | A request resolves existing idempotency or normal operation before work, a request/processor seals context-bound candidates, chosen-branch/current feasibility and canonical cost admit a strategic target, and decision plus attempt-progress CAS close the chains | Per-attempt consumptive authority, target reconstruction, mutable plan rules, copied selection arrays |
| Provider/connector/reconciliation attempt progress + admission + dispatch intent/authority | Durable admission authority | Every actual network attempt consumes one owner-scoped progress epoch plus fresh runtime, credential, quota, cost, and budget authority; one executor crosses the durable send-start fence and ambiguous work uses a typed recovery contract | Strategic route choice, mutable payload, forked retry/fallback/poll/terminal chains, reusing attempt authority, TTL-only send ownership |
| Upstream idempotency certification + recovery authorization | Code-owned certification registry + durable recovery authority | An exact target/connector operation proves key scope/payload/retention/concurrency/replay semantics, one ambiguous request-terminal recovery is authorized, or one orphan-fenced resource recovery consumes a non-resetting cumulative bound for a read-only lifecycle poll chain with typed codec/transport/cancellation attempt outcomes, separate no-synthetic-attempt control exhaustion, and retained cleanup closure | Caller idempotency, generic provider capability flags, parallel/resettable resource-recovery roots, erased active cleanup chains, resource-create redispatch, unadmitted reconciliation I/O, implicit retries |
| Processor invocation input/intent/state/outcome | Durable admission authority | An exact minimized input and immutable intent become pending before child/connector work; remote work owns canonical cost and exclusive dispatch; one typed output or denial closes it | Fake preselection IDs, public model identity, arbitrary targets, unbound payloads |
| Budget quote slices + owner-discriminated settlement authority + compiler-bound funding trees/shared maxima + canonical cost-attribution components + request/lifecycle reservation bundles + lifecycle-funding admissions/valuation epochs | Durable admission/obligation authority | Before period slicing, every rule/authority/scope/currency cost subject freezes one shared actual-source contract and code-owned evidence mapping; holds preserve exact compiler sum/max topology, logical route branches own sequential leases with fresh attempt allocations, signed readmission adds retained charge, and one runtime source selection partitions the chosen actual/correction exactly once across every eligible reservation-bound period component | Per-slice competing provider/accounting selection, period arrays, one conversion on an aggregate hold, additive or reusable maximum leaves, attempt-owned leases, opaque runtime expression rewrites, free-form topology, a single convenient base currency, duplicated period settlement, schedule rereads, fabricated request ownership, uncovered correction settlement, expired attempt quote reuse, partial slice commit |
| Processor profile | Versioned DB resource or TOML | A classifier/remote-policy purpose, schemas, target plan, or execution constraints change | Public model identity, caller-selectable endpoints, executable code |
| Access profile | Versioned DB resource or TOML | An immutable named set of exact typed policy-version references changes | Policy binding scope, new policy vocabulary, mutable credential authority |
| State binding + retention lease | Encrypted durable binding store | A provider resource moves through unprepared/prepared pending, reconciling, active, resource-lifecycle cleanup-retained tombstone when applicable, ordinary/aborted terminal tombstone, descent, or expiry | New-route authorization, component retirement policy, plaintext upstream IDs, successor certification |
| Request-state orphan + reconciliation-retention lease | Durable provider-outcome/orphan store | Ambiguous request-terminal state creation transfers into one owner with an immutable certification-hashed key binding, derived non-extendable recovery deadline, lifecycle-free lease, and single recovery/cleanup control; exact shared-result activation or certified absence/expiry closes it | Continuing provider liability, resource-cost exposure, lifecycle polling/funding, invoice adjustment, retargeting |
| Attempt-scoped prepared/active/orphan/aborted cost exposure + liability-component chain + reconciliation-retention lease | Durable provider-outcome/obligation/orphan store | Each resource-terminal attempt owns its lifecycle start/quote/initial epoch; possibly billable work transfers atomically to exactly one lifecycle/reconciliation owner whose per-epoch/invoice FX components derive cumulative totals, or definitive nonacceptance aborts only that attempt | Strategic selection, another attempt's valuation/reservation, one conversion on aggregate liability, caller permission, current pricing reconstruction |
| State-retention generation | Retirement coordinator + signed ring distribution | Grouped state/reconciliation target/profile/component classes, creator/lease high-waters, partition counts/digests, or a completed creator-absorption proof change | Per-resource selected IDs/requirements, active credential-set mapping, workspace routing grants, caller permission, rollbackable revision contents |
| State-target retirement | Durable retirement-coordinator state and target-scoped creator registry, projected only through retention generations | A target blocks root/descendant registration, root-seals and drains creator-capable executions across current/historical authorities, retains state/reconciliation leases, is durably cancelled, or irreversibly releases components/credential requirements | Caller permission, rollbackable workspace semantics, a second runtime distribution format |
| Narrowing overlay | Durable signed high-priority distribution | Security authority is removed/tightened or absorbed by an ACKed base generation | New grants, automatic time-based widening, executable components |
| Shared-resource fence | Organization/platform security authority + signed fanout/resume | A shared resource is fenced, absorbed by its owning/local authorities, or explicitly restored | Ordinary configuration publication, local-only clearance, implicit expiry |
| SDK compatibility profile | Code registry | A supported SDK version, method, or compatibility claim changes | Local configuration mutation, runtime authorization |
| Harness configurator manifest | Code registry | A supported harness version or owned configuration format changes | Runtime authorization, provider routing |
| Credential issuance template | Versioned control-plane DB resource or TOML | Issuance eligibility, credential form/TTL, harness scope, exact access-profile reference, or optional narrowing-policy references change | Independent access rules, runtime policy evaluation, reinterpretation of issued credentials |
| Onboarding profile | Versioned control-plane DB resource or TOML | A workspace changes supported configurators, default logical model, credential issuance template, or synthetic preview context | Executable config writers, model entitlement enforcement, runtime snapshots |

This matrix is the hard boundary. A new provider normally adds a provider adapter and connections/deployments; it does not add a new ingress wire. A new SDK endpoint normally adds or updates an API wire and codec; it does not create a provider or canonical model. Supporting a new source/target combination adds a translation adapter and certification; it does not change either endpoint's contract.

### 5.3 Entity relationships

```text
organization
  +-- workspaces
  +-- teams <-> users
  +-- principals
  |     +-- human principal
  |     +-- service account / workload principal
  +-- credentials -> principal + workspace
  +-- provider connections
  |     +-- credential slots -> credential-set versions
  |     +-- provider-credential directory -> ordinary set + requirement-matched retained access
  |     +-- lifecycle requirement registry -> all-admissible-gate coverage receipts
  |     +-- workspace grants
  |     +-- model deployments -> canonical model definitions
  |           +-- egress API-wire bindings
  +-- policies + versions
  |     +-- bindings -> org/workspace/team/principal/credential/route
  +-- logical models -> published route versions
  |     +-- ingress API-wire promises
  +-- resource profiles -> profile-owned provider resource targets
  |     +-- provider connection + resource endpoint/wire + later deployment compatibility
  +-- processor profiles
  |     +-- code-owned in-process implementation, or
  |     +-- terminal model plan -> exact deployment-wire-binding candidates, or
  |     +-- processor connector -> code-owned processor adapter
  +-- access profiles -> exact typed policy-version references
  |     +-- scoped attachments -> principal or credential
  +-- state bindings -> state-retention leases -> exact target constraints/components
  +-- provider outcomes -> request-state orphans -> same-key activation or terminal cleanup
  |     +-- reconciliation-retention leases
  +-- provider outcomes -> prepared cost exposures -> active-binding or resource-orphan obligations
  |     +-- resource reconciliation-retention leases
  +-- state-target retirements -> retention generations + ring ACKs
  +-- shared-resource fences -> organization/platform fanout + signed resume
  +-- credential issuance templates -> exact access profile + optional narrowing policies
  +-- onboarding profiles -> code-owned harness configurator manifests
  +-- workspace revisions

request -> ingress API wire -> operation definition -> workspace revision
        -> workspace catalog, logical model, state-bound action, or resource profile
        -> immutable decision header -> normalized candidate epoch when applicable
        -> unique terminal outcome + selected target transitions when provider-bound
        -> translation path -> model deployment/provider-resource target -> provider connection
        -> provider attempts -> usage entries -> pinned valuation basis
```

### 5.4 Why a deployment must be first-class

The same model can be available through OpenAI, Azure OpenAI, Bedrock, or a self-hosted endpoint. Even when the model name is identical, these targets differ in:

- credential and quota pools;
- regions and data handling;
- API versions and supported fields;
- price and contract discounts;
- context limits or feature rollout;
- prompt-cache behavior;
- latency, health, and capacity;
- provider-managed state IDs;
- certification status.

Putting those facts on a model row or inside a route deployment JSON blob makes policy and evidence ambiguous. The deployment is the smallest model-inference unit that can be selected, attempted, cooled down, priced, and audited. A model-less resource operation instead uses its profile-owned resource target, so connection-level file/job endpoints are not misrepresented as models.

### 5.5 Capability derivation

Effective deployment capability should be the intersection of:

```text
provider-adapter capability
  AND egress API-wire binding
  AND canonical model facts
  AND provider discovery result
  AND deployment configuration
  AND wire/translation certification evidence
  AND temporary health/capacity state
```

Operators may narrow capabilities manually. They should not be able to claim an unsupported capability without wire-codec/provider-adapter support or an explicit experimental certification state.

Recommended certification states are:

- `native_certified`;
- `translated_certified` for a named ingress/egress wire pair, contract versions, operation, interaction mode, and feature profile;
- `experimental` and excluded from production by default;
- `suspended`;
- `retired`.

### 5.6 Workspace and environment

Keep the current organization-to-workspace hierarchy. Treat a workspace as an independently governable application/environment boundary and add typed attributes such as `environment=development|staging|production`, owner, cost center, and data classification.

Do not add separate project, application, environment, department, and business-unit hierarchy tables until real policy cannot be expressed through workspaces, teams, and typed attributes. That is where LiteLLM-style entity proliferation becomes expensive.

### 5.7 Persistence and compilation boundary

Keep executable behavior out of versioned database specs:

| Layer | Conceptual records | Lifecycle |
|---|---|---|
| Code registries | Operation definitions, API-wire definitions, wire codecs, translation adapters, provider adapters, processor adapters/implementations and schema validators, SDK compatibility profiles, harness configurator manifests | Released, reviewed, and loaded at process startup |
| Versioned catalog | Immutable canonical model releases/families and provenance | Curated/discovered at platform or organization scope, independently approved, and pinned by runtime resources |
| Versioned organization configuration | Provider connections, immutable credential slots/set versions, stable state-continuity requirements, and approved successor-certification evidence | Authored by API/console or TOML; ordinary and lifecycle-only mappings publish through the provider-credential directory |
| Versioned workspace configuration | Deployments, deployment wire bindings, logical models, logical-model wire promises, routes, resource profiles/cost plans, processor profiles/connectors, access profiles, policies | Authored by API/console or TOML, then published in a workspace revision |
| Versioned control-plane configuration | Onboarding profiles and credential issuance templates | Authored by API/console or TOML, approved independently, and never loaded as inference policy |
| Certification evidence | Native deployment-wire, translation-adapter, upstream-idempotency/recovery, provider-state continuity, and processor-profile/connector certification keyed by exact resource/component/auth-source versions and relevant operation/feature/data profiles | Produced by tests/canaries, approved, expired, or revoked |
| Compiled runtime | Resolved ingress routes, operation dispatch plans, entitlement sets, logical-model candidate matrices, route/resource/operation preflight manifests, native/translation paths, minimum retention-generation compatibility, and non-recursive processor plans | Deterministic artifact of one immutable workspace revision |

The important conceptual records are:

- **Deployment wire binding:** deployment, exact provider-connection/auth-contract version, egress wire/version, endpoint variant, operations, interaction modes, native feature profile, upstream-response safety profile, and native certification reference.
- **Canonical execution target reference:** one discriminated reference to either an exact deployment-wire-binding version or an exact provider-resource-target version. Candidates and immutable selected-execution records carry this target authority; bindings, leases, obligations, processors, and attempts reference the selected record where applicable. Connection, auth, egress wire/codec, provider adapter, region, and native certification facts resolve from the target rather than duplicated fields. Request-specific ingress and translation certifications remain separate references.
- **Logical-model wire promise:** logical-model version, ingress wire/version, operations, interaction modes, and promised feature profile.
- **Translation certification:** translation-adapter/version, source and target wire versions, operation, interaction mode, certified feature profile, fixture/canary evidence, status, and expiry.
- **Provider-credential-set version:** stable connection/auth contract, exact immutable slot versions/auth sources, bounded selection policy, and required adapter version.
- **Provider-credential-directory generation:** exact ordinary connection/auth-to-set mappings; stable-requirement-matched successor-set entries with generation-specific certification or exact-slot retained entries; normal versus incident-reconciliation authorization; previous-generation hash; admitted-request plus provisional-creator/state-lease/reconciliation-lease requirement high-waters; traffic-gate directory-admission-set high-water; and signature. Write-like attempts record a linearizable receipt covering every directory generation still admissible at a traffic gate; one retained common-slot selection owns the physical slot and separate evidence rows prove its membership/equality for every required lease without copying it.
- **Processor-profile version:** purpose, typed schemas, in-process implementation/model terminal plan with exact deployment-wire-binding candidates/processor-connector version, inherited-constraint contract, retry/outcome/cardinality/cost ceiling, transformation effects, component/certification references, and lifecycle.
- **Resource-profile version:** operation/resource purpose, bounded target plan, wire/state mapping, data/retention constraints, later-use compatibility, preflight, and certification references.
- **Execution decision and selected target:** one immutable external-request or model-backed-processor header persisted before dependent work, one fenced decision progress row, one resolution/input-ref-bound candidate-set chain with closed evaluations, chosen-branch plus feasibility-bound `ExecutionSelectionAdmission`, at most one initial plus CAS fallback selected chain, and exactly one idempotency/catalog/logical-route/exact-state/workspace-resource/processor-model terminal outcome. A provider-selected outcome stores only the final selected ID and derives predecessors; every selected transition atomically creates one attempt-progress root, its first provider attempt, and fresh consumptive `ProviderAttemptAdmission`.
- **Provider attempt and dispatch authority:** every routed network attempt, including a same-target retry, consumes its selected target's open attempt-progress epoch and owns fresh health/circuit/capacity/concurrency/quota/narrowing, exact credential eligibility/quota, canonical cost, budget admission, immutable payload intent, and one CAS remote-dispatch authority. Only the executor that commits `claimed_before_send -> send_started` may write; that transition rechecks trusted time against the intent deadline, and after it commits the intent is never reused. Ambiguous request-terminal recovery requires an exact certification, immutable key binding with code-derived `recoveryNotAfter`, and authorization for a separately admitted attempt; state-creating recovery also consumes its exact request-state orphan control and adds a fresh request-state reconciliation lease. Resource creation never redispatches; a separate reconciliation-progress chain gives every read-only lifecycle poll the same fresh admission and one-send authority while consuming one immutable resource-orphan cumulative count/horizon contract across all successor authorizations.
- **Request-state orphan:** one ambiguous request-terminal state create owns the exact binding/idempotency/selection/certification/key/payload, complete provider-outcome and reconciliation-lease sets, provisional creator/credential registrations, and one non-extendable recovery control. It has request-scoped cost only. Same-key recovery can activate the original binding from a shared terminal result; exact absence or provider-enforced expiry can tombstone it. It cannot poll resource lifecycle, accrue continuing liability, receive lifecycle funding, or adjust invoices.
- **Processor invocation:** exact signed input ref, immutable intent and pending projection before any child decision or connector admission, model target or connector pre-dispatch authorization bound to that input, canonical request valuation, exact connector-attempt admission/dispatch intent and immutable claim/send ledger, signed output ref, then one denial/in-process/model/connector terminal outcome; only selected variants reference a model final pointer or final consumed connector admission and output.
- **Budget quote set, envelope, and attempt admission:** every rule/authority/scope/currency cost subject first receives one signed actual-cost-source contract and exact code-owned evidence-mapping version; every applicable finite window or contract attribution then becomes a separate commitment slice with one frozen source-to-budget conversion referencing that shared contract and an owner-discriminated settlement-conversion authority set containing only entries for its selected provider or accounting source. One sealed complete-or-empty quote set per billable work unit proves the full slice set; one root envelope plus closed processor-child envelopes owns pointwise slice holds/allocations/settlements; and one provider/connector/reconciliation admission owns each request-terminal remote execution. Every nonempty envelope member carries a signed compiler-plan-bound funding-expression tree whose leaves bijectively cover exact quote-member/conversion operands and whose `sum`/`maximum` topology is deterministically recomputed from the preflight plan. Child allocations preserve that topology: sums distribute capacity additively, while maximum alternatives share one sequential CAS-governed ledger. Its lease belongs to a logical route branch, remains active across same-target retries, and gives each attempt a fresh subordinate allocation. No-charge retry advances the lease version in place; chargeable retry uses a signed evidence-bound readmission of `sum(retained_charge, max(same_branch_retry, remaining_branches))`; fallback disposes the logical branch lease and either reopens siblings after no-charge or readmits `sum(retained_charge, max(remaining_branches))`. Request-terminal bundles and conversion authority sets name their request; obligation continuations instead reject request ownership and name the exact lifecycle quote/admission/allocation/epoch. Before period attribution, one signed source selection maps one canonical charge or correction under the admitted mapping and is unique independently of reservation; its components exactly partition the selected parent across every eligible reservation and period slice. A nonempty admission reserves all exact slices or none; an empty admission preserves the signed no-applicable-rule/slice proof. No period array, synthetic zero, aggregate conversion, source substitution, per-slice competing actual source, schedule reread, attempt-owned lease, opaque expression rewrite, free-form topology, or concurrent maximum lease collapses enforcement, and no retry reuses a consumed attempt allocation.
- **Canonical request-cost valuation:** every billable request-terminal provider candidate, connector, or lifecycle reconciliation poll has one input/target-bound provider/accounting-currency valuation even with zero budget rules. Budget slices derive independently from it; cost selection and settlement retain its exact ID.
- **Resource-cost-plan version:** one exact operation/canonical-target pair, discriminated firm or operational relative-lifecycle contract, immutable provider/accounting valuation and estimator rules, terminal actions, budget compatibility, and reconciliation semantics. Preflight always emits a request/decision/current-candidate/target/input-bound canonical provider-cost valuation and independently emits closed complete-or-empty sliced budget coverage. Each resource-terminal attempt owns its lifecycle start, quote, initial epoch, and prepared exposure; selection owns only strategic target/plan. Active-binding, orphan, and aborted-before-acceptance ownership inherits one exact attempt exposure.
- **Resource-cost valuation epoch and liability projection:** one immutable interval always carries separate provider-charge/accounting amounts plus its own FX/rounding provenance and independently carries closed budget coverage: a signed empty applicable-rule set or one commitment for every rule/authority/scope/currency, each with frozen source-to-budget conversion referencing its pre-slice shared actual-source contract, owner-correct reservation, source-selection/attribution, and settlement lineage. A provider-expiry epoch covers the canonical horizon and every present rule's windows; a contract-cap epoch records dual-currency provider liability and reserves the cap in every compatible authority. An operational chain has exactly one attempt-owned root followed by obligation-owned compare-and-swap continuations with fresh lifecycle-funding admission and owner-matched source contract; same-period steps preserve slice identity, while certified boundaries replace expired slices under preserved rule identity. Each epoch and invoice adjustment appends one conversion-bearing liability component, and signed per-currency totals derive from that unique chain rather than one aggregate FX record.
- **Access-profile version:** immutable exact typed policy-version references plus ownership and lifecycle provenance; a separately scoped attachment is what gives those references authority.
- **Credential-issuance-template version:** one exact access-profile version, optional exact narrowing-policy versions, principal eligibility, credential type, maximum TTL, auth presentation, and allowed harness configurators; this remains issuance-only control-plane configuration.
- **Onboarding-profile version:** harness-configurator/version references, default logical model, credential-issuance-template reference, and named synthetic preview context; this remains a control-plane resource.

These may be normalized tables or strictly validated fields inside immutable resource versions; that is an implementation choice. The compiled compatibility matrix is never hand-authored and is not an independent source of truth.

## 6. Operations, API Wires, and Interaction Modes

### 6.1 Replace `surface` with two durable axes

The current `surface` combines too many concepts. The target request envelope should identify two independently versioned facts:

1. **Operation definition:** what the caller wants done and the exact semantic lifecycle contract for doing it.
2. **Ingress API wire:** the versioned request, response, error, state, and streaming contract the caller used.

The wire definition owns its network protocol, encoding, and framing. Runtime derives an **interaction mode** of `unary`, `stream`, `session`, or `job` from the resolved wire, operation, and validated request. Interaction mode is a policy and compatibility fact, not a third caller-configurable protocol taxonomy. For example, SSE is framing for a streaming interaction over HTTP; multipart is an HTTP encoding; WebSocket is a wire binding that may carry a session.

Examples:

| Operation kind | Example ingress API wires | Interaction modes and wire-owned binding |
|---|---|---|
| `model.list` | `openai.models`, provider-native catalog wires | `unary`; HTTP JSON |
| `text.generate` | `openai.responses`, `openai.chat_completions`, `anthropic.messages`, `google.generate_content`, `aws.bedrock.converse` | `unary` or `stream`; HTTP with JSON or SSE is defined by the wire |
| `text.compact` | `openai.responses` compact | `unary`; HTTP JSON |
| `text.count_tokens` | `anthropic.count_tokens`, provider-native count | `unary`; HTTP JSON |
| `embedding.create` | `openai.embeddings`, `google.embed_content` | `unary` or `job` |
| `image.generate` | `openai.images`, provider-native image API | `unary`, `stream`, or `job` |
| `image.edit` | `openai.images`, provider-native image API | `unary` or `job`; multipart belongs to the wire |
| `audio.transcribe` | `openai.audio`, provider-native audio API | `unary` or `stream`; multipart belongs to the wire |
| `audio.translate` | `openai.audio`, provider-native audio API | `unary`; multipart belongs to the wire |
| `speech.synthesize` | `openai.audio`, provider-native audio API | `unary` or `stream` |
| `document.rerank` | `cohere.rerank`, `jina.rerank`, or gateway-native | `unary` |
| `content.moderate` | `openai.moderations` or provider-native | `unary` |
| `file.create` / `file.read` / `file.delete` | `openai.files` or a provider-native resource wire | `unary`; multipart and resource IDs belong to the wire; create uses `workspace_resource`, later actions use `state_binding` |
| `realtime.session` | `openai.realtime`, `google.live`, provider-native realtime | `session`; WebSocket or WebRTC belongs to the wire |
| `batch.submit` / `batch.result` | Provider-native batch wires | `job` |
| `video.generate` | Provider-native media wires | `job` |

Operation IDs and wire IDs are extensible code registries, not another fixed product enum. A wire can expose multiple related operations, and an operation can be available through multiple wires. Each method/path binding names an exact operation-definition version, and the workspace revision pins that definition and its dispatch plan. The presence or absence of a `model` field never implicitly decides whether a request uses the catalog, model-routing, or state-binding path.

### 6.2 Wire identity and version resolution

The registry key is `(wireId, contractVersion)`. The stable ID names the API family; the version pins its observable semantics. Examples are:

```text
openai.responses        + v1
openai.chat_completions + v1
anthropic.messages      + 2023-06-01
google.generate_content + v1beta
aws.bedrock.converse    + 2023-09-30
```

Use the upstream contract's actual name. The Anthropic wire is `anthropic.messages`, not `anthropic.responses`; Responses is an OpenAI API family. Do not derive wire IDs mechanically from URL paths or a generic word such as `chat`, because that hides the semantic contract and its version.

These version strings are illustrative and must follow each upstream contract's real versioning model. Some versions come from the path, some from a required header, and some from the supported SDK release plus a compatibility profile. The ingress router resolves an exact wire before parsing the operation:

```text
POST /v1/responses                         -> openai.responses + v1
POST /v1/chat/completions                  -> openai.chat_completions + v1
POST /v1/messages + anthropic-version      -> anthropic.messages + resolved header version
```

The compiled registry rejects ambiguous path/method/header combinations. Before authentication, the listener enforces source/listener connection and request-rate limits, TLS and handshake deadlines, load shedding, a bounded number of credential-verification candidates, and absolute request-line/header/transfer-metadata limits. It resolves only the code-owned route family, wire/version headers, operation, and authentication presentation needed to verify the credential. It does not accept, decompress, parse, or materialize the request body first. Clients using `Expect: 100-continue` receive acceptance only after authentication; an already-sending unauthenticated client is reset or drained only within a small absolute byte/time bound.

After authentication, the wire's incremental decoder enforces both the absolute wire caps and tighter credential/workspace quotas for encoded and decompressed bytes, compression ratio, multipart part count/size/name length, upload deadline, stream frames, and backpressure. JSON and other structured inputs additionally have code-owned maximum nesting depth, node/property/array counts, key/string/number lengths, and schema-work limits. Conflicting or invalid `Content-Length`/transfer encodings fail before body processing. An outer WAF may duplicate these controls but is not their only enforcement point.

Wire version upgrades are explicit compatibility releases with conformance evidence; they are not silently inherited because an SDK dependency changed.

### 6.3 Wire support is a compiled compatibility matrix

Four declarations meet at publication time:

1. An operation definition supplies the exact resolution and lifecycle contract.
2. A logical model promises one or more ingress wire/version and operation-definition combinations when that operation uses a model.
3. Each deployment binds one or more native egress wire/version combinations supplied by its provider adapter.
4. The translation registry supplies zero or more certified directed paths between those wires for named feature profiles.

The compiler expands these into an immutable matrix:

```text
logical model + ingress wire/version + operation-definition version + interaction mode + requested feature profile
  -> eligible deployment + egress wire/version + translation adapter or native path
```

Support is never inferred only from `model.mode`, a provider name, or the existence of an HTTP endpoint. A model may support text generation while a particular deployment lacks Responses tool events, an Anthropic beta header, or a compatible state mechanism. Those are deployment-and-wire facts.

At request admission, the gateway looks up the precompiled matrix and narrows it using the actual requested features and policy. If no certified path remains, it returns an ingress-wire-native error before a provider attempt.

### 6.4 Closed-world extension policy

Compatibility must not become an ungoverned provider tunnel. Every wire release classifies each request and response element into one of four states:

1. **Standard:** parsed, policy-visible, capability-matched, and covered by conformance tests.
2. **Registered extension:** namespaced, schema-validated, assigned data/cost/tool effects, and enabled only for certified deployments and entitled callers.
3. **Opaque response extension:** same-wire response data that a release has explicitly proved safe to forward under the active capture and output-policy mode.
4. **Unknown:** rejected before egress for requests; rejected or safely terminated before forwarding for responses and stream events.

Ingress authentication, provider-selection, beta, endpoint, organization, workspace, and routing headers never pass through. The wire codec consumes its allowlisted feature headers and constructs only certified semantic/billing target-wire headers, the policy engine records their normalized requirements, and the provider adapter independently constructs the physical authentication/routing minimum header set. The transport merges those disjoint typed outputs and rejects duplicate ownership. Native forwarding therefore means no semantic translation, not no inspection.

Forward compatibility is released deliberately: observe a new provider field or event in quarantined certification traffic, classify it, add fixtures and policy vocabulary, then publish a new codec/certification revision. Development workspaces may opt into a named experimental wire release; production never has a general `allow_unknown` switch.

### 6.5 Priority of operation support

Recommended order:

1. **Text generation:** preserve current Responses, Chat Completions, Messages, Bedrock Converse, HTTP/SSE, and Responses WebSocket support on the new model.
2. **Embeddings:** highest-value non-generative addition, operationally simple, important for RAG and search, and a good proof that the new abstraction is not coding-specific.
3. **Provider breadth for text and embeddings:** Azure OpenAI, Google Vertex/Gemini, and a standard OpenAI-compatible self-hosted adapter.
4. **Image generation/editing, audio transcription/speech, reranking, and moderation:** add as separate operation modules after deployments and policy are stable.
5. **Realtime:** treat as a session gateway with handshake-time routing and no transparent mid-session failover.
6. **Batch and asynchronous media:** add a job resource with provider job-ID mapping, polling/webhook state, cancellation, and durable affinity.

Endpoint count is a poor measure of progress. Each operation/wire combination is complete only when authorization, routing, native/translation behavior, errors, usage, pricing, evidence, limits, state, and cancellation are all defined.

### 6.6 Native and compatibility endpoints

Support two kinds of ingress:

- **Industry/provider API-wire endpoints** for application compatibility, such as `/v1/responses`, `/v1/chat/completions`, `/v1/messages`, and `/v1/embeddings`.
- **Gateway control APIs** under a distinct namespace, such as `/gateway/v1/catalog`, `/gateway/v1/routes`, `/gateway/v1/wires`, `/gateway/v1/onboarding-profiles`, and `/gateway/v1/decisions/{id}`.

Do not add gateway policy or routing fields to standard request bodies. Use the logical model ID, credential-bound policy, and a small allowlisted set of gateway headers for caller preferences and attribution. This keeps standard SDKs usable and avoids field collisions.

`/gateway/v1/wires` is read-only runtime metadata from the code registry plus certification state. It can explain supported versions and features but cannot install executable protocol definitions through the database.

### 6.7 A protocol facade is not one schema

OpenAI's own migration guide documents material differences between Chat Completions and Responses: Chat returns `choices` containing messages; Responses returns typed output items, has different tool and structured-output shapes, supports provider-managed state, and removes some Chat concepts such as multiple `n` generations ([OpenAI migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)). Anthropic streams named events with content-block state and can introduce new event types over time ([Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)). Bedrock Converse is a common message interface but still accepts model-specific inference fields ([Bedrock Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)). Google explicitly recommends native APIs for advanced Gemini features because its OpenAI compatibility layer cannot map the architectures one-to-one ([Gemini partner integration](https://ai.google.dev/gemini-api/docs/partner-integration)).

Those are not cosmetic JSON differences. A universal serialized object would either lose behavior or continually absorb provider-specific unions. Proxy should use small operation-specific internal representations only inside a translation adapter, while retaining a raw/native path for same-wire forwarding.

## 7. Translation and API Contract

### 7.1 Translation-adapter graph

For each operation, maintain a directed compatibility graph:

```text
OpenAI Responses ----exact/lossy?----> Anthropic Messages
       |                                  |
       +----> OpenAI Chat                 +----> Bedrock Converse
       |
       +----> Gemini native / Interactions
```

Every directed edge is implemented by one named translation adapter and has:

- source and target API-wire IDs and contract versions;
- operation-definition ID and version;
- supported interaction modes;
- supported request fields;
- supported content and tool block types;
- response and streaming-event mapping;
- finish/stop/error mapping;
- usage mapping;
- known loss conditions;
- certification fixtures and live test results;
- source/target wire-codec versions and translation-adapter version.

The compiler admits a deployment to a route only if a valid native or certified translation path exists for the logical model's promised ingress wires. Initially, require a direct edge rather than composing arbitrary multi-hop translations. Multi-hop conversion compounds loss, complicates state and streaming, and should be introduced only for a demonstrated case with end-to-end certification.

The runtime composition is:

```text
HTTP route -> ingress wire codec -> authenticated request requirements
                                       |
                                  route selection
                                       |
                  +--------------------+--------------------+
                  |                                         |
        same-wire native path                    certified translation path
         preserve raw semantics          source codec -> translation adapter
                  |                            -> target wire codec
                  +--------------------+--------------------+
                                       |
                       provider adapter + connection
                                       |
                                  upstream API
```

This composition keeps four ownership boundaries testable: the ingress codec owns the client contract, the translation adapter owns semantic conversion, the target codec owns the egress contract, and the provider adapter owns physical connectivity.

### 7.2 Fidelity levels

- **Native:** ingress and egress use the same API wire and compatible contract version; supported syntax is preserved, while model and state IDs, policy-controlled parameters, and sanitized headers may change.
- **Exact:** all used request and response semantics have a defined round trip for the certified feature subset.
- **Lossy:** a documented semantic difference exists and the route must opt in to it. Production logical models should not advertise a feature that is lossy across an eligible deployment.
- **Unsupported:** reject before provider selection with an ingress-wire-correct client error.

No wire codec or translation adapter may silently delete an unknown tool, content block, response-format constraint, cache directive, safety field, or provider state reference.

### 7.3 Operation-specific internal representations

Use a small internal representation only inside a translation edge. For text generation it may borrow the typed-item ideas of [OpenResponses](https://www.openresponses.org/), but it must not become the storage or forwarding format for every native request.

Separate representations are warranted for:

- text/items and tool calls;
- embeddings input/output vectors;
- multipart image/audio requests;
- rerank documents and scores;
- realtime events;
- async job submission and status.

Trying to put these into one `CanonicalRequest` would recreate the sprawling union the architecture is trying to avoid.

### 7.4 Stateful identifiers and affinity

Stateful provider resources constrain routing:

- OpenAI `previous_response_id` and conversation IDs;
- provider file IDs and uploaded assets;
- provider prompt-cache keys or cache blocks;
- Anthropic or provider-specific container/context identifiers;
- batch and media job IDs;
- realtime session IDs;
- fine-tune or assistant resources, if ever proxied.

Every externally visible stateful identifier is gateway-owned, even on a native same-wire path. The gateway must store a state binding:

```text
(organization, workspace, owner principal, resource kind, gateway public ID)
  -> allowed actions + optional share ACL + data class
  -> optional origin logical model or resource-profile compatibility + canonical release
  -> canonical exact deployment-wire-binding/provider-resource target or reusable-resource constraint
  -> encrypted upstream resource ID + expiry
```

Every create, read, continue, use, cancel, and delete operation authorizes the caller against the binding before resolving an upstream ID. The wire/operation definition maps each registered reference location to a closed-world reference role and requested action; one request may therefore authorize `continue` on a previous response, `use` on files, and `read` on another resource. The resolver retains a member record for each `(binding, reference role, action, authorization decision)` and never collapses them to one action.

When a request contains multiple state references, the resolver looks up and authorizes every public binding independently, without decrypting any upstream identifier, resolves each binding's canonical target from its selected-execution ID, then computes one aggregate execution-target and lineage intersection across the complete nonempty set. A hard binding contributes that exact deployment-wire-binding or provider-resource-target reference; a certified reusable resource contributes only its immutable compatible deployment-wire-binding set for model use and its selected provider-resource target for resource-only actions. All constraints must intersect on target-derived provider connection, canonical release when model-bound, wire/state-mapping components, retirement eligibility, and joint data policy. Each member's action and owner/share ACL remain independently enforced. Lineage rules must be jointly satisfiable: independently created files may coexist when the certified state mapping permits them, while two incompatible conversation roots cannot. Empty or conflicting target/lineage intersections are denied before provider I/O. After target resolution and still before decrypting an upstream identifier, the credential resolver also intersects the exact physical slots authorized by the admitted directory's retained entry for every member lease. A disjoint credential intersection is a denial, even when the bindings otherwise share a target. A separately code-owned, certified materialization operation may create a new compatible lineage; ordinary resolution never copies or pretends to port state.

A logical-model continuation retains `logical_model` resolution. It reauthorizes the requested logical model and each binding's origin logical model or resource-profile compatibility set, immutable canonical release/target constraints, target-derived provider connection, resource kind, and requested action under current policy. Every binding with an origin logical model requires exact equality; a model-less resource binding instead restricts the candidate universe to its certified compatible deployment-wire-binding references. The resolver returns the aggregate binding set. If it contains a hard execution target, the exact-target executor skips cache and route/classifier selection. Otherwise logical routing may continue only inside the aggregate compatible-target intersection, with stateful exact caching disabled. A resource-only read/cancel/delete operation uses `state_binding` resolution and needs no fabricated model field. Any mismatch is denied; V1 does not migrate or relabel provider-owned state.

Workspace membership alone is insufficient: another human or service principal in the same workspace receives the ingress wire's not-found response unless an explicit, auditable share grants that action. Share policy must also constrain principal type, retention, data classification, and cross-region movement. State routability never confers any of these authorizations.

State creation has a durable egress barrier. All V1 barrier rows live under one physical serializable Postgres authority; the named coordinators are ownership boundaries in code, not separate transactional stores:

1. In one pre-dispatch transaction, durably claim the wire-certified or request-ID-scoped idempotency record; create or lock the authoritative selected-execution record; reserve the internal binding ID and gateway public ID; and create a `pending` binding containing owner, optional origin model/release, exact resource-profile version when applicable, data classification, lifecycle/retention policy references, selected-execution ID, action policy, idempotency-record ID, and binding expiry. A pending row has no upstream ID, state lease, or inherited attempt exposure.
2. Before **each** write-like provider attempt that could create state or leave an ambiguous outcome, the serializable pre-dispatch transaction creates fresh provider-runtime/credential and budget admissions, dispatch intent plus ready claim authority, attempt-specific provider outcome and reconciliation lease, and, when resource-terminal, a new `PreparedResourceCostExposure` with its own lifecycle start/valuation epoch. A request-terminal state create additionally requires the compiled `request_state_orphan_recovery` capability backed by an exact current same-key/same-result certification and provider-enforced terminal-cleanup or expiry contract; without both, that operation is unavailable. Before the initial send, one immutable `UpstreamIdempotencyKeyBinding` binds the exact certification/hash, target or connector, operation, key HMAC, serialized payload, initial dispatch authority, and trusted time. Its `recoveryNotAfter` is code-derived as the earliest of the original total request deadline, `boundAt + certified retentionSeconds`, certification expiry, and the policy recovery cap; no later authorization, orphan, lease, failover, or retry may extend it. The initial attempt registers the selected slot's stable credential-continuity requirement and a target-scoped `StateLifecycleCreatorRegistration` against the retirement coordinator's current epoch. A same-key request-state recovery must reuse that exact key binding plus the orphan-owned provisional registrations and retained credential target; its one-effect certification forbids a second creator identity. Other retries create fresh registrations. Root registration is rejected once `blocking_new_roots` commits, and descendant registration is rejected once `blocking_all_creates` commits, regardless of the request's pinned retention generation. The transaction freezes all-gate directory coverage and links that exact attempt exposure. Dispatch requires the whole transition and an exclusive durable send claim; the `mark_send_started` compare-and-swap rechecks trusted time against the intent's `dispatchNotAfter`, which for a same-key recovery is no later than `recoveryNotAfter`. A delayed or failed-over worker permanently cancels before send after that boundary. No provider call occurs while the database transaction is open.
3. When the provider returns an upstream ID, one activation transaction locks all applicable rows and atomically persists its encrypted reference, exact state-retention lease/class and minimum directory floor, attempt provenance, provider outcome, both creator/credential requirement-owner transfers, final all-gate coverage receipt, idempotency transition, and reconciliation ownership. For resource-terminal work it transfers the prepared exposure, initial valuation/reservation, and lease to a binding-owned resource-cost obligation. For a certified request-state orphan recovery, the same transaction consumes the orphan's active recovery-control epoch, proves the exact same key/payload/target/certification and shared terminal result, terminalizes every owned provider outcome, releases the complete owned reconciliation-lease set, transfers the creator/credential owners, creates the state lease, activates the original binding, and closes the orphan before the serializer can release that ID or dependent bytes.
4. Definitive nonacceptance atomically releases both provisional registrations and the reconciliation lease and aborts that attempt's prepared exposure when applicable. A legal same-target retry creates a new full attempt preparation; a different-target fallback also advances the selected transition. If no retry/fallback remains, the never-exposed public ID becomes an unreusable `tombstoned_terminal` binding whose `aborted_before_acceptance` ownership references the final exposure and definitive evidence; the idempotency record becomes `failed_terminal`. Ambiguous resource-terminal acceptance transfers the exact prepared exposure and lease to the typed resource orphan and its cost obligation. Ambiguous request-terminal state creation instead transfers the provider outcome, reconciliation lease, creator/credential registrations, exact idempotency certification and key-binding hashes, payload, recovery deadline, and binding into one `RequestStateOrphanProviderState`; it has request-scoped cost disposition and explicitly no continuing provider liability or resource lifecycle authority. It may authorize only bounded exact same-key recovery attempts, one at a time through its control epoch and never after `recoveryNotAfter`. An ambiguous recovery adds its outcome/lease to that same orphan and returns the control to available; definitive no-new-effect releases only that recovery attempt's lease; neither retargets. Terminal cleanup consumes the same available control epoch and is legal only with definitive nonacceptance/absence or the exact provider-enforced expiry certification and evidence, then terminalizes every owned outcome, releases the complete lease set and provisional registrations, and tombstones the binding/idempotency record. Recovery/cleanup and recovery/recovery races have one compare-and-swap winner. If no certified recovery or terminal basis is available, the orphan and lease remain durably owned and alerted rather than being garbage-collected. Resource orphans separately retain their attempt admission, selected execution, initial valuation epoch and matching complete-or-empty sliced budget coverage, applicable firm terms or rolling operational authority, and reconciliation lease until cleanup and settlement. The caller decision may close only with the ingress wire's indeterminate outcome while such ownership remains; the idempotency fence and binding stay `indeterminate`/`reconciling` and cannot become succeeded, failed-terminal, active, or tombstoned until every provider outcome, lease, exposure, and orphan has its required terminal owner and evidence.

The database enforces these phase transitions with foreign keys, subtype checks, unique ownership constraints, and fencing epochs across selected execution, provider-attempt/budget admissions, dispatch authority, idempotency, binding, provider outcome, reconciliation lease, credential/creator registrations and coverage, state lease, attempt exposure, obligation, and sliced reservations. A future service split must first introduce a durable `prepared -> committed | aborted` transition with one fencing token, idempotent recovery, and a commit certificate consumed by release; an asynchronous outbox or two independent local commits cannot implement this barrier.

An operation definition that can create state must declare this barrier. Its wire codec buffers the bounded prefix needed to commit the mapping; it cannot expose an early response/job/session ID and repair the binding later.

A pre-commit fallback may change a pending binding's intended target only through one fenced durable transition after the provider's typed observation plus the operation-specific acceptance classifier proves definitive nonacceptance. That transition terminalizes the prior attempt/provider-outcome record, aborts its attempt-scoped exposure when applicable, releases its target-specific reconciliation lease plus credential- and state-creator registrations, appends one same-decision higher-epoch selected transition linked to its predecessor, atomically moves the pending binding pointer to it, and creates the next attempt's fresh runtime/budget/dispatch authority, provider outcome, target-specific lease, registrations, prepared exposure/valuation, and all-admissible-gate coverage receipt before dispatch. A same-target retry performs the same attempt replacement without a new selected transition. The new creator registration consults current retirement state; an older admitted request cannot retry/fall back into a target that began blocking. The operation/profile must permit the target. Ambiguous acceptance transfers the outcome, lease, and registrations to exactly one request-state or resource orphan, moves the idempotency record and binding to `reconciling`, and never retargets. A later request-state send is a separately admitted same-key recovery that consumes the orphan control; it is not fallback or ordinary retry. Once an upstream ID exists, the binding target and plan are immutable.

Subsequent requests are pinned to that provider boundary unless the gateway has enough materialized, authorized context to translate the state. A route must not claim failover for provider-managed state that cannot move. Bindings and encrypted upstream IDs follow the source resource's retention and deletion policy; deleting either side tombstones the public ID so it cannot be rebound to a different principal or provider resource.

Each active binding owns an immutable **state-retention lease** containing its creator-registration ID, class ID, selected-execution ID, exact operation-definition/resource-profile version, state-mapping schema/certification, data classification and lifecycle/retention policy references, discriminated hard-selected or reusable-resource constraint, per-target stable credential-continuity requirements, minimum compatible provider-credential-directory generation, release-time all-gate coverage-receipt IDs, component versions, optional canonical release, lineage root/parent IDs, and expiry. A hard constraint derives one exact deployment-wire-binding or provider-resource-target version from the selected-execution record. A certified reusable provider resource derives its exact resource target from that record and adds only a nonempty compatible deployment-wire-binding set. The durable binding store is the per-resource lease authority; connection, auth contract, ingress/egress wire, codecs, and adapters are derived only from those canonical target definitions and are never copied as parallel authorities. The lease contains no secret material or successor certification. Every later action resolves exact retained-access evidence for every referenced lease, proves their common physical-slot intersection, and records the generation-specific evidence through the admitted `ProviderCredentialDirectoryGeneration`, or fails before upstream-ID decryption and provider I/O.

Every unsettled active/orphan resource-cost obligation, ambiguous provider outcome, and `RequestStateOrphanProviderState` independently owns a durable **reconciliation-retention lease**. The lease is owner-discriminated. Its common immutable content names one exact signed reconciliation-retention class, canonical execution target, stable credential-continuity requirement, pre-dispatch all-admissible-gate coverage receipt, component versions, and retirement epoch; ownership changes only through a fenced atomic transition with no unowned interval. A `request_state` lease names the exact upstream certification and key binding, derived `recoveryNotAfter`, request-state recovery-contract version, and terminal-closure-contract version plus its evidence-only absence/provider-expiry contract. It structurally has an empty lifecycle-operation set and `continuingProviderLiability: false`; it retains only same-key recovery and terminal evidence until certified activation or cleanup. Definitive-absence evidence may be emitted only by the target codec while classifying the already-authorized original or same-key recovery attempt under that pinned evidence contract. It is not authority to dispatch a distinct poll; any separate provider operation is `resource_lifecycle` and remains behind Phase 4. A `resource_lifecycle` lease instead has a nonempty poll/cancel/delete/settle operation set and continuing provider liability, while all request-state key-binding/deadline/recovery/closure fields are null. Cross-variant owner, class, contract, or field substitution is invalid. The lease is independent of caller access, binding expiry, and state-retention-lease lifetime. It reaches `released` only after every provider outcome in its owner's exact set is terminal and no authorized reconciliation remains. An operational resource obligation or unreachable request-state orphan may therefore retain it indefinitely.

A retained continuation may create only an explicitly authorized direct descendant of its source binding. The descendant atomically receives a new gateway ID, upstream ID, and lease; inherits the lineage's origin model/release, owner, share ACL, data class, canonical hard-target or reusable-resource execution constraint, and component versions; and cannot outlive the source lineage's approved retention ceiling. Provider connection and auth requirements are re-derived from that constraint. This is not a new root session or an unconstrained route choice. State-only targets reject unrelated creates, model changes, ordinary routed traffic, and cache fills.

Removing a state-capable or reconciliation-required target uses a durable **StateTargetRetirement** state machine, not a flag inside a rollbackable workspace revision. It is keyed by organization/workspace and the exact canonical target/component set, carries a monotonic retirement epoch plus lifecycle-creator-registration, state-lease, and reconciliation-lease high-water marks, and progresses through `blocking_new_roots`, `retaining_descendants`, `blocking_all_creates`, `creators_drained`, `retention_acked`, and irreversible `released`. It is coordinator state, not a second runtime payload. Every state-producing pre-dispatch transaction registers against the coordinator's current linearizable epoch; a pinned older retention generation cannot authorize a late creator. Binding activation proves that registration, and retained actions/reconciliation also check the epoch projected in their active retention generation. Activating an older workspace revision therefore cannot reopen roots, bypass the final descendant barrier, or lose lifecycle access.

The retirement coordinator is the sole writer of a signed, hash-chained **StateRetentionGeneration**. Each monotonic generation contains its previous hash, creator/lease high-waters and absorption proof, the retirement epoch/state for every target class, and grouped immutable state/reconciliation retention classes. A class names exact target/profile/constraint/component behavior plus fixed-count partition binding-store high-waters, live counts, and lease/credential-requirement set digests or Merkle roots. Reconciliation classes preserve the lease discriminant: a `request_state` class names only its recovery and terminal-closure contract versions with an empty lifecycle-operation set, while a `resource_lifecycle` class names a nonempty lifecycle-operation set. Its index proof repeats the class ID, discriminant, and request-state contract versions or exact resource nulls; every indexed lease must carry equal values, so a lease cannot move across classes or acquire hidden operations. A class never embeds per-request selected-execution IDs, individual bindings, or individual continuity requirements. Exact per-resource authorization remains in the indexed binding/lease store behind those proofs, so artifact size is proportional to target/profile/component classes and the bounded partition count rather than live files, responses, or jobs. The generation is the sole runtime authority for state-target retirement and class/component retention; the provider-credential directory remains the sole authority mapping each indexed lease requirement to a certified successor or exact incident/historical slot. A workspace revision carries only compatible generation/epoch floors; it embeds neither another credential mapping nor a per-resource retention manifest.

The `blocking_new_roots` transition serializes with the target-scoped creator registry. Registrations committed first enter its creator high-water; after the transition commits, every later root registration fails regardless of admission time. The coordinator then freezes current plus historical live execution authorities and creates a target-scoped `StateCreatorAbsorptionProof`. It includes every pre-block active-execution root whose code-owned operation can still register a blocked creator kind and whose immutable target facts do not yet prove it disjoint from the retiring target set; this covers both not-yet-resolved roots and resolved candidate universes that intersect the target. A `StateCreatorRootSeal` for each included hierarchy serializes child registration, dependency-fact append, snapshot continuation, async handoff, and creator registration while leaving terminal closure legal. The completed proof binds the frozen authority set, root-set digest, registration/fact/snapshot vectors, creator-registry high-water, every root seal, and all-hierarchy drain evidence. Only a completed proof may enter a retention generation, and only then does the coordinator snapshot partitioned state/reconciliation lease indexes and issue the class-level generation. The credential coordinator consumes the same creator/state/reconciliation high-waters and requirement-set digests and retains a currently certified successor or exact slot for every indexed stable requirement. The publication coordinator co-stages that generation with compatible workspace, identity, directory, narrowing, and ring membership authority before entering `retaining_descendants`.

To drop the retained class, `blocking_all_creates` repeats the serialized registration barrier with both root and direct-descendant creator kinds blocked, freezes the same complete current/historical authority set, root-seals every still-target-affectable creator hierarchy, drains every included hierarchy and registered creator through the higher vectors, and records a completed higher creator-absorption proof. The coordinator then proves zero live state and reconciliation leases from the partition high-waters/digests and activates a generation without that class/components. Only after ring ACK and credential-directory proof that no indexed requirement still needs its successor/exact slot may the target reach `released`. Binding expiry or tombstoning cannot substitute for lease release, and an open operational obligation prevents retirement for as long as necessary.

A pre-release cancellation is not a reset or record deletion. From any state except `released`, the coordinator publishes a signed `cancelled` transition with a strictly higher epoch, previous-epoch hash, source state, reason, restored component/certification proof, and credential-continuity coverage proof for both lease indexes. Existing barriers remain effective until a retention generation containing that transition is ACKed by every traffic-receiving ring; only then does runtime interpret `cancelled` as active, still subject to ordinary workspace-route eligibility. The record remains in the chain, and a later retirement starts from `cancelled` by publishing a higher-epoch `blocking_new_roots` transition. `released` is irreversible and requires normal restaging of components, credentials, certifications, and route authority.

The pure workspace compiler emits a `StateRetirementImpactSet` containing every canonical target/component whose ordinary-route reference the candidate would remove; connection/auth requirements are derived from those targets. It does not advance retirements, inspect mutable ACK state, or build retention/credential generations. The publication, retirement, and credential coordinators perform the stateful block/register/seal/drain/snapshot/ACK protocol. A production change retains exact target classes and components as state-only or reconciliation-only eligibility until the last applicable lease releases or an approved, caller-visible lineage invalidation and completed provider cleanup make it terminal. A generation drops a class only after the creator registry/absorption proof and partitioned lease indexes prove no pending creator, live state lease, or active reconciliation lease remains and the rings ACK that fact. Components and derived credential requirements are released only in the terminal retirement transition. Workspace revision rollback, process restart, cancellation, or a delayed publisher cannot decrease any directory/retention generation, retirement epoch, creator/lease high-water, or index proof.

### 7.5 Durable idempotency

Idempotency is a wire-certified cross-request contract, not only a retry-loop flag. An API-wire operation declares whether it exposes a caller token, its scope/retention, a code-owned idempotency namespace and caller-intent normalization, pending-collision behavior, replay-artifact contract, and whether successful responses can be replayed. Different wire/version contracts never share a namespace unless a certification proves their caller-visible request, pending, and replay semantics equivalent. The gateway never trusts an arbitrary header merely named `Idempotency-Key` unless that exact wire/version registers it.

For a registered token, the gateway stores no raw token. After authentication, bounded parsing, caller-visible normalization, and common operation/data admission, but before normal operation resolution, it derives a lookup key as an HMAC over organization, workspace, principal/credential scope, operation version, certified idempotency namespace, and token and atomically claims or loads the record. Conflict identity is a separate keyed **caller-intent HMAC** over only the normalized caller-visible request/headers and registered semantics; it excludes workspace revision, policy, defaults, transformations, and other mutable server configuration. A fresh claim proceeds to normal resolution. An existing record instead creates an `ExistingIdempotencyResolution` and request decision header for the collision/release path; it never resolves a current route. The original record separately pins execution provenance: workspace revision, policy and transformation versions, forced/defaulted parameters, final effective-request HMAC, provider-key mappings, response/state reference or replay tombstone, retention, and reconciliation evidence. It transitions only through `pending`, `succeeded`, `indeterminate`, or `failed_terminal`.

A concurrent or later request with the same lookup key must reauthenticate and reauthorize the stored original provenance under current release policy. Its own `idempotency_existing` decision terminalizes every conflict, pending, timeout, fanout, replay, unavailable, or release-denial response without adding candidates or selected targets. If its caller-intent HMAC differs, it receives a conflict without learning the prior body. If it matches, the exact wire operation applies one code-owned pending behavior:

- `return_in_progress` returns the wire-native pending response and never attaches to response bytes; this is the default for streaming, large, or unbuffered operations;
- `wait_then_replay` waits only within a declared deadline and succeeds only when the operation stores a bounded encrypted replay artifact under an approved data-retention policy from the start;
- `fanout_from_start` is available only to a certified streaming operation that registers every subscriber before the first response commitment and applies independent backpressure/cancellation; a request arriving after commitment receives `return_in_progress` or an allowed later replay, never a midstream suffix.

A succeeded record replays only its safe retained artifact. A later publication does not create a conflict or reinterpret the original execution. Reauthorization proves that the original operation/model/target/data/result/state provenance remains permitted now; it may deny release but never redispatch with new policy. A later client collision against an `indeterminate` record never redispatches; it waits for reconciliation or receives the wire-native indeterminate outcome. Internal recovery is separately constrained by the upstream certification contract below. A terminal response whose artifact was never allowed or is no longer retained returns the wire's stable completed-but-result-unavailable outcome rather than executing again.

State creation links the idempotency record and pending public binding in one durable transaction, ensuring duplicates cannot mint different public IDs. The certified target-wire binding maps the gateway record to an upstream idempotency field only through a first-class `UpstreamIdempotencyCertification` pinned to the exact provider target or connector, operation and billing lifecycle, key namespace/derivation/scope, payload-equivalence contract, retention horizon, concurrent-same-key behavior, response semantics, fixtures, and expiry; the provider adapter merely materializes the already registered physical header. The runtime persists only the key HMAC. An opaque provider capability flag or a provider name is never retry authority. Without a caller token, a write-like operation still creates a request-ID-scoped durable record for safe attempts inside that one admitted gateway request, but no later client request is assumed equivalent or joined.

Recovery is a closed `UpstreamRecoveryAuthorization`, not an adapter decision. For `request_terminal` provider work or a processor connector whose certification promises one effect and the same terminal result for concurrent/repeated identical payloads, an ambiguous original send may authorize a **new** same-key attempt only after binding the original intent/authority/payload, ambiguous evidence, exact certification and immutable `UpstreamIdempotencyKeyBinding`, attempt-progress predecessor, fresh runtime and budget admissions, new intent/dispatch authority, and cumulative envelope snapshot. The binding derives `recoveryNotAfter = min(original request deadline, boundAt + certified retentionSeconds, certification expiry, policy recovery cap)` from code-owned inputs. Authorization and admission recheck it against trusted time, copy it without extension into the intent, and the send-start CAS checks it again; a claim acquired before the deadline cannot send at or after it. When the work may create provider state, that authorization must also consume the matching `RequestStateOrphanProviderState`'s available control epoch, stay within its non-extendable attempt ceiling and the same `recoveryNotAfter`, and install the recovery attempt's own request-state reconciliation lease before send. A terminal shared result activates the original binding through one `RequestStateOrphanRecoveryTransfer`; an ambiguous or definitive-no-new-effect result returns the control to available through a typed closure while preserving or releasing only the evidence it actually resolves. Expiry ends recovery authority but does not prove provider absence: the orphan and idempotency fence remain until the certified terminal absence/provider-expiry contract supplies evidence. Terminal cleanup consumes the same available epoch, so two recoveries or recovery versus cleanup cannot both win.

For `resource_terminal` creation, V1 never repeats the create operation after ambiguous send, even when the upstream exposes an idempotency key. Its certification names one read-only reconciliation operation and typed outcome schema. Orphan transfer installs one signed recovery-bound version with an absolute horizon and cumulative invocation ceiling/count. Creating one authorization compare-and-swap installs that authorization and its new `ResourceReconciliationAttemptProgress` root as the orphan's sole active recovery control, binding the original provider outcome, attempt-scoped exposure, reconciliation lease and ownership epoch, lifecycle service principal, exact target, a nonempty interval of remaining cumulative invocations, authorization-local maximum, deadline within the orphan horizon, and successor authorization-chain hash. A second authorization cannot start against the same recovery-control epoch, and a later authorization cannot reset count or time. Every poll is a separate request-terminal lifecycle invocation with fresh exact-target authorization, retained-credential evidence, health/circuit/capacity/concurrency/quota/narrowing and credential admission, canonical request-cost valuation, complete-or-empty request budget admission, immutable `ResourceReconciliationDispatchIntent`, and one-invocation `RemoteDispatchAuthority`. A next poll consumes the current progress and orphan recovery-control epochs plus one local and cumulative count slot; the slot remains consumed even if the admitted dispatch is later cancelled before send, so crash/cancellation cannot recycle bound capacity. Concurrent workers, an ambiguous poll response, or an expired worker claim cannot reuse an intent or bypass request-scoped cost. Every dispatched attempt closes with an exact codec, definitive-not-sent, sent-indeterminate, or signed pre-dispatch-cancellation outcome. Count or time exhaustion is instead a signed progress/control transition over the last completed head; it may occur between polls without a new admission, intent, dispatch, or attempt outcome. If an already admitted ready/claimed poll expires, the same transaction first closes it through the ordinary before-send cancellation evidence, then records control exhaustion. Policy invalidation, credential revocation, admission expiry, and cleanup may cancel only a ready/claimed dispatch and must terminalize execution plus settle or release its budget; cleanup after an already terminal definitive-not-sent outcome uses its separate no-charge supersession proof. Only the target codec's signed `original_resource_identity_proven` observation can terminalize progress with that disposition and authorize binding activation.

Ambiguous create ownership must transfer from prepared exposure to an orphan before this poll chain can start. That transfer installs a signed initial `OrphanRecoveryBoundVersion` and recovery control with one absolute horizon, cumulative invocation ceiling/count, and authorization-chain high-water/hash. A successor authorization can consume only the remaining count and time under the same bound version; exhaustion never resets either value. Increasing a bound requires a separately signed extension version with explicit approval and a fresh `OrphanRecoveryBoundExtensionAdmission`. Its discriminated delta increases the invocation ceiling, absolute horizon, or both, rejects a no-op, and derives exact marginal exposure plus complete-or-empty incremental funding; a horizon-only extension does not fabricate invocation capacity. The control's cumulative count and authorization chain continue monotonically. One fenced `OrphanToActiveResourceRecoveryTransfer` binds the terminal identity-proof outcome, compare-and-swap closes the matching active recovery control, closes the orphan as transferred, installs the active successor over the same exposure, moves the reconciliation lease to that successor, creates the state-retention lease, advances the binding, and preserves every canonical valuation, liability-component, lifecycle-funding, slice-transition, provider-settlement, budget-settlement, invoice-adjustment, recovery-count, and authorization-chain high-water. The orphan row remains immutable history but is no longer a current liability owner. A codec-proven definitive absence, signed progress/control exhaustion over the last completed head, or non-cleanup pre-dispatch cancellation atomically returns the matching recovery control to `available`, records the terminal predecessor, and leaves the original exposure under orphan reconciliation policy; it does not imply nonacceptance or reset capacity. A later authorization may start only by consuming that successor recovery-control epoch and its remaining orphan-level allowance. Cleanup against `available` may close directly. Cleanup against `active` must first win `active -> closing_cleanup`, retain the authorization/progress pointers, and block new poll admissions. Ready/claimed work then records signed cleanup cancellation, terminalizes dispatch/execution, and settles or releases budget. Work already terminal as definitive-not-sent closes through a distinct supersession variant joining the exact attempt outcome, transport proof, separate no-charge proof, active-execution closure, budget disposition, and cleanup evidence. Send-started work becomes outcome-indeterminate and keeps its request-cost allocation held until canonical cost reconciliation completes. Only after the current progress terminalizes as `cleanup_superseded` with matching dispatch, execution, cost, budget, and cleanup evidence may the control become `closed/cleanup_terminal`. A provider that reveals the original resource only by repeating create is operationally unsupported for resource-terminal recovery in V1; a future same-key reconciliation-replay contract would be a distinct typed lifecycle action that reuses the original exposure and cannot create a second create attempt or lifecycle epoch.

Replay retention and deduplication-fence retention are separate clocks. Expiring an encrypted replay artifact changes a later response to completed-but-result-unavailable; it does not delete the lookup tombstone. A `pending` or `indeterminate` record has no automatic GC deadline and remains a dispatch fence until certified provider reconciliation reaches a terminal outcome. Every provider-idempotency mapping whose dispatch may have been accepted links an active reconciliation-retention lease before provider I/O. A terminal record remains while any state binding, request-state orphan, or prepared/active/orphan resource-cost exposure is live, any linked reconciliation lease is active, any provider idempotency mapping may still resolve, or the wire/provider deduplication horizon has not ended. Deletion requires a signed `IdempotencyGcCertificate` proving all of those blockers closed through durable high-water marks and a `notBefore` time; TTL expiry, a worker lease, or missing replay bytes cannot substitute for that proof.

The lookup and caller-intent HMAC key rings retain every referenced key version through the longest unresolved fence. A duplicate token is evaluated against the explicitly capped set of still-eligible namespace key epochs, and caller-intent comparison uses the record's pinned key version. Publishing a key epoch that would exceed the cap while an older epoch still has uncertified records fails closed for new caller-token writes; it never drops the old lookup key and lets a duplicate claim a fresh record. Routine cryptographic maintenance rewraps the stable HMAC material in KMS rather than changing its digest. A true HMAC-key compromise is a security incident that denies affected writes until every unresolved fence has a disposition; availability cannot override deduplication correctness.

Recovery-bound extension funding is compiler-owned, not a policy-service scalar. One signed `OrphanRecoveryBoundExtensionMarginalExposureValuation` binds the exact predecessor bound/control/count, target, reconciliation operation/certification, extension delta/hash, code-owned derivation manifest, price/FX inputs, and expanded budget-slice digest. It derives additional capacity only as the ceiling difference and predecessor remaining capacity only as `max(predecessor ceiling - consumed count, 0)`. A count-only extension values the additional calls through the unchanged horizon. Any horizon extension revalues every still-unused predecessor call across the added time and its intersecting price, FX, and budget periods; a combined extension adds the new calls once and carries the predecessor remainder once. A zero marginal valuation is legal only when both derived operand counts are zero. Existing certified reservation coverage may fund a nonzero valuation but cannot erase its operands or cost vector. The quote set, no-budget or existing-coverage proof or incremental reservation, admission, and successor bound version all reference that exact valuation/hash, manifest, and delta hash.

### 7.6 Streaming, retry, and fallback boundary

Streaming translation adapters are state machines, not line replacements. They must handle:

- event ordering and indexes;
- partial JSON tool arguments;
- content-block start/delta/stop semantics;
- provider error events inside a successful HTTP response;
- usage arriving only at the terminal event;
- unknown forward-compatible event types;
- client cancellation and upstream abort;
- malformed or truncated streams.

A bidirectional `session` interaction is admitted once but authorized continuously. Its operation definition owns a versioned closed-world registry of inbound and outbound event actions, ordering, replay/idempotency, and which events can create state. The handshake creates a principal-owned session binding to one exact deployment, policy/revision baseline, and hard session-wide duration/event/output/spend ceilings; it does not authorize arbitrary later frames.

Before forwarding each inbound WebSocket/WebRTC event, the executor enforces the absolute frame limit, validates ordering/replay, rechecks credential/principal/session/action plus origin-model/release/target authority and the current narrowing epoch, applies parameter/data policy and required input guardrails, charges incremental byte/token/rate limits, and reserves the event's maximum exposure within the session/request budget. Each outbound event passes the upstream response-safety profile, decoder/order checks, output policy, state-ID activation barrier, output limits, narrowing recheck, and usage settlement before release. Sessions have bounded idle/lifetime and policy-reauthorization intervals, propagate backpressure both directions, and close in the wire's valid form on cancellation, revocation, replay, budget exhaustion, or an unknown event. They never reroute mid-session.

Retry or fallback is allowed only before response bytes have been committed to the caller and before an ambiguous non-idempotent upstream acceptance. After that point, a new provider attempt could duplicate tool calls or produce an incoherent stream. Request-terminal write-like work requires the durable gateway idempotency record plus an exact unexpired upstream certification and recovery authorization before an ambiguous same-key retry. Resource-terminal creation never repeats create in V1: an unknown outcome moves the record/binding/exposure to `indeterminate` reconciliation, and only a separately admitted, bounded, read-only lifecycle-principal poll chain may use the certification's registered reconciliation operation. Without that contract, the outcome remains unresolved until another certified ordinary reconciliation source proves it. Record the partial failure and terminate in the ingress wire's valid error/close form where possible.

Each provider attempt is prepared independently from the immutable admitted request: select the attempt's egress wire and certified translation, serialize for that exact deployment, construct only its provider-adapter headers and authentication, and attach its idempotency key. Never reuse a transformed body, endpoint, or authorization header across a fallback target. This matches the per-upstream processing boundary used by [Envoy AI Gateway's data plane](https://aigateway.envoyproxy.io/docs/concepts/architecture/data-plane/) while retaining Proxy's stronger wire certification.

### 7.7 Response and error ownership

The ingress API wire owns the client-visible contract:

- render success bodies and stream events in the ingress wire;
- render gateway authorization, limit, routing, and provider failures in that wire's error envelope;
- preserve status-code expectations where possible;
- attach a stable gateway request ID;
- sanitize provider error bodies so secrets, account IDs, URLs, and prompt fragments are not leaked;
- retain the complete classified upstream evidence in restricted logs.

Recommended response headers are:

- `x-gateway-request-id`;
- `x-gateway-logical-model`;
- `x-gateway-revision`;
- `x-gateway-fallback-count`;
- `x-gateway-cache-status`;
- `x-gateway-deployment` only when the principal is authorized to see physical routing details.

The body-level `model` field should default to the requested logical model so the public contract remains stable. The actual canonical model and deployment belong in headers and evidence. A logical model that promises a pinned physical model can make those IDs identical.

### 7.8 Model discovery endpoints

Model discovery is a separate `model.list` operation with its own API wire, not an inference-wire query. OpenAI-compatible `GET /v1/models` should return the authorized union of logical models usable through at least one supported OpenAI inference wire for that credential. It should include only models that:

- the credential is entitled to use;
- have at least one entitled operation, interaction mode, and certified inference-wire path in that client family;
- have an active published route;
- are baseline-total for every declared route/classifier branch and mandatory processor dependency under the caller's current effective-policy fingerprint/default data classification, with versioned exposure estimates, rather than merely having one eligible deployment.

It cannot predict whether the caller's next request will use Chat Completions, Responses, embeddings, or another operation, nor its exact features/data override, so it must not claim one endpoint-specific compatibility set or guarantee every future request. Request admission repeats totality after parsing the actual requirements. Discovery should not reveal inaccessible providers, credentials, regions, or internal deployments.

`GET /gateway/v1/catalog` can provide richer authorized metadata: operations, modalities, context limit, feature support, lifecycle, cost bands, data-handling class, and whether routing is direct or managed. Physical deployment detail remains an administrator permission.

### 7.9 Text protocol translation risk matrix

The following matrix describes why translation must be feature-aware. Exact provider fields evolve, so adapter certification remains the authority.

| Concern | OpenAI Chat-style contract | OpenAI Responses-style contract | Anthropic Messages-style contract | Gateway rule |
|---|---|---|---|---|
| Basic conversation | Ordered messages | String or typed input items | Alternating messages with content blocks | Exact for the certified basic-text subset |
| Instruction priority | System/developer/user roles | Top-level instructions plus role-bearing items | Separate system input plus user/assistant turns | Preserve priority; reject when target cannot represent it |
| Output container | `choices[].message` | Typed `output[]` items | Top-level message with typed `content[]` | Render ingress-native response; never expose a target container directly |
| Multiple generations | May support `n` choices | One generation in the primary Responses contract | One message | Reject or pin route to a wire that supports the requested multiplicity |
| Text/image/audio/file input | Message content variants | Typed input items and provider resources | Typed content blocks with provider-specific support | Capability-check every used block, not merely the model's modality label |
| Tool definition | Function/tool objects | Typed tools including provider-hosted tools | Tool definitions and optional provider tools | Custom functions may translate; hosted tools usually do not |
| Tool call output | Assistant tool calls plus tool-role messages | Separate function-call and function-call-output items | `tool_use` and `tool_result` blocks | Preserve IDs and ordering with a stateful translation adapter |
| Parallel tool calls | Provider/model parameter and multiple calls | Multiple typed call items | Multiple tool-use blocks where supported | Advertise only when every eligible deployment/edge is certified |
| Tool selection | `tool_choice` variants | Different typed choice shape | Anthropic-specific choice shape | Map only named/auto/required/none modes with equivalent semantics |
| Structured output | `response_format` or JSON schema | `text.format`-style configuration | Provider tool/JSON or native structured-output features | Treat schema guarantees as capabilities, not generic JSON prompting |
| Reasoning/thinking | Model-specific controls and fields | Typed reasoning items and summaries | Thinking configuration and blocks | Opaque/encrypted reasoning is not portable; retain only on certified paths |
| Built-in tools | Provider-specific or absent | Web/file/computer/code/MCP and other hosted tools | Different hosted-tool set | Do not translate by matching names; require an explicit tool adapter or reject |
| Provider-managed state | Client-managed transcript in common Chat use | Response/conversation IDs and stored context | Provider/container features where supported | Pin state to its originating deployment unless context is materialized safely |
| Prompt caching | Often implicit/provider-specific | Cache keys/retention and provider behavior | Explicit cache controls and usage fields | Keep cache directives and economics deployment-specific |
| Log probabilities | Chat/model-specific fields | Typed output details where supported | Different or unavailable support | Route only to a deployment/edge that promises the requested shape |
| Refusal/safety/citation | Message fields and finish reasons | Typed content/annotations/incomplete details | Content blocks, stop reasons, and provider safety errors | Preserve structured meaning; do not flatten into text |
| Streaming | Choice deltas | Named typed item/content events | Message/content-block event state machine | Use an ingress-specific renderer over a target-specific parser |
| Usage | Token totals and detail fields | Input/output detail, cache and reasoning units | Input/output, cache and other provider details | Normalize for ledger while rendering the ingress-supported usage shape |
| Errors | OpenAI-style HTTP envelope and possible stream failure | OpenAI-style response/error events | Anthropic envelope plus possible SSE error events | Classify internally, then render the ingress wire's valid error form |

Gemini native APIs introduce their own content/part, safety, hosted-tool, state, and streaming semantics. Google's own integration guidance warns that the OpenAI compatibility layer is appropriate for a unified basic schema but does not expose all advanced Gemini features. Gemini therefore needs a native adapter and explicit translation edges, not just a different base URL.

### 7.10 IDs, timestamps, and metadata

Translated responses need stable gateway-owned identifiers:

- mint IDs that match the ingress API wire's lexical requirements;
- store the upstream response, message, tool-call, file, session, or job ID in restricted state/evidence mappings;
- use the gateway request clock for client-visible creation timestamps when the target has no equivalent;
- preserve target stop/error metadata in restricted evidence even when the ingress cannot represent every field;
- never leak provider account, secret, internal hostname, or ungranted deployment identifiers through IDs or metadata;
- retain a deterministic mapping for tool-call IDs within one interaction so follow-up results route correctly.

For a native same-wire path, preserve non-state provider fields only when the wire's closed-world policy permits them. The gateway always owns externally reusable state and resource IDs so it can enforce principal ownership, retention, and affinity without exposing physical details.

### 7.11 Provider-managed resources

Files, batches, conversations, and asynchronous media jobs may be necessary to support inference operations, but they are not generic provider administration APIs.

Proxy should expose a provider-managed resource only when:

- a supported inference operation requires it;
- principal ownership, explicit sharing, and workspace scope can be enforced;
- external and upstream IDs can be durably mapped;
- retention, deletion, and data-residency behavior are known;
- subsequent operations can honor provider affinity;
- audit and cost semantics are defined.

Fine-tuning, model training, dataset management, and unrelated provider project administration remain outside the gateway core. They can use separate platform workflows and publish their resulting model as a deployment after approval.

## 8. Routing Architecture

### 8.1 Routing is resolution, not always classification

The default request already names a logical model. The gateway resolves it to an eligible deployment. No LLM classifier is required.

Classifier-based routing is appropriate when the logical model explicitly represents a meta-route such as `opendoor/coding-auto` or `opendoor/support-auto`. It should be a node in that route, with a structured result, bounded retries, cost/latency evidence, and explicit route-owned edges for every certified failure outcome. It is not a mandatory tax or availability dependency for exact-model requests.

This directly supersedes the existing classifier-first product boundary.

### 8.2 Mandatory request pipeline

The runtime is an explicit composition, not one inference-shaped sequence with optional jumps:

```text
CommonAdmission
  -> IdempotencyExistingExecution
   | CatalogExecution
   | LogicalRouteExecution
   | ExactStateTargetExecution
   | ResourceCreateExecution
  -> CommonRelease
```

**CommonAdmission** performs only work shared by all operations:

1. Before body acceptance, enforce operational listener/source connection and request-rate limits with their configured overshoot bounds, TLS/auth deadlines, load shedding, bounded credential candidates, and absolute request-line/header/transfer-metadata limits.
2. Resolve the ingress API wire, contract version, and exact operation-definition version from method, path, and version headers.
3. Authenticate against the current signed identity/credential directory using that wire's supported auth convention.
4. Bind organization, workspace, principal, immutable workspace revision, identity-directory generation, provider-credential-directory generation, narrowing-overlay generation, state-retention generation, and trusted time source; acquire each authenticated request/concurrency/upload admission through its compiled firm or operational authority; and register the fenced ingress-partition active-execution root at dependency stage `ingress` before accepting the body.
5. Only after authentication, incrementally accept/decompress/parse the bounded body with wire, credential, and workspace byte/token/structure quotas and backpressure. Validate the envelope and derive interaction mode, model field when present, every state reference plus its code-owned reference role/requested action, registered resource kind/purpose/discriminator, features, data classification, and estimated input/output size. Atomically append the newly learned dependency facts and compare-and-swap a same-root snapshot continuation through stage `parsed`; reject unregistered extensions before materializing large optional content.
6. Evaluate default-deny organization/workspace and principal/team/credential admission for operation, wire, interaction mode, parameters, data, capture, and requested state actions. Bind immutable request-wide deadline, total-attempt, output, cumulative-request-spend, and the operation's `request_terminal` or `resource_terminal` lifecycle requirements. Common admission does not select a target-specific `ResourceCostPlan`.
7. After caller-visible normalization and common operation/data admission, resolve idempotency before normal operation resolution. When the exact wire operation registers a caller token, atomically claim its namespace-scoped record or load the existing record using the stable caller-intent HMAC. A write-like operation without a caller token claims its request-ID-scoped record here. A fresh claim transaction writes the record in `initializing` with an immutable `claimed_unresolved` provenance epoch and `dispatchAllowed: false`, then continues to step 8. An existing lookup persists one typed `ExistingIdempotencyResolution` naming the exact observed provenance ID, hash, and phase, appends the idempotency facts, advances the root through `resolved`, and persists an immutable external-request decision header whose initial resolution is that idempotency record. It never resolves the request against a current route or mutates the original execution. `claimed_unresolved` proves only that initialization owns the key: a matching duplicate may receive generic initializing/wait behavior, but cannot receive replay, state, target, result, or fanout authorization. Caller-intent conflict, initializing, pending/indeterminate, wait timeout, pre-commit fanout registration, replay, completed-result-unavailable, and current-release denial are closed outcomes of `IdempotencyExistingExecution`.
8. Only for a fresh idempotency claim or an operation with no cross-request record, run the normal operation resolver, which returns exactly one discriminated result: `CatalogResolution`, `LogicalModelResolution`, `StateBindingResolution`, or `ResourceProfileResolution`. Logical resolution positively authorizes the requested model, pins its route/universe, and contains the optional fully authorized member-by-member binding set with either a hard target or a bounded compatible-deployment intersection. State resolution preserves every binding/reference-role/action decision plus exact resource/model target and current retention generation. Resource resolution uses the compiled fingerprint/discriminator mapping to positively authorize exactly one profile and `resource_access` policy. The resolver does no cache, classification, target selection, or provider I/O and never decrypts an upstream state ID before all member authorization, aggregate compatibility, and retained-credential slot intersection succeed. For a claimed request, one transaction persists the initial `OperationResolutionRecord`, immutable decision header, and complete `dispatch_ready` provenance, then compare-and-swap advances the idempotency record from `initializing` to `dispatch_ready`; no quote, remote child, credential materialization, or dispatch is legal while the provenance is unresolved. The same transaction appends resolution facts and advances the active-execution root through `resolved`. For a request without a durable idempotency record, it persists the resolution and header before any quote or remote child. Recovery of a claim that cannot finish initialization writes an immutable `initialization_failed` terminal provenance and terminalizes the record without dispatch. Transformation readmission may append a same-decision resolution successor and a later immutable provenance epoch; it never mutates prior provenance or the header.

Every later policy-admission, cache-check, target-binding, and release preparation appends immutable facts and compare-and-swap advances the same root through the ordered `policy_admitted`, `cache_checked`, `target_bound`, and `release_ready` stages. Each continuation names the same-reference predecessor and cumulative fact high-water; no worker can replace facts, reset the stage, fork the current pointer, or discard an inherited parent snapshot. A stage may be skipped only when its code-owned operation contract declares it inapplicable and appends that fact while advancing. A cache/catalog/idempotency/local result registers a release child or advances the root to `release_ready` with its full provenance before release. Sealing serializes against child registration, fact append, snapshot continuation, and ownership handoff; a restriction whose required stage is not complete treats that hierarchy as affected rather than assuming absent facts are a non-match.

**IdempotencyExistingExecution** accepts only an existing-idempotency decision header. Conflict returns the wire-native conflict without revealing prior provenance. An observed `claimed_unresolved` epoch permits only generic initializing/in-progress or bounded wait; initialization recovery either advances the original record to complete `dispatch_ready` provenance or writes `initialization_failed` terminal provenance, never dispatches from an incomplete claim, and wakes waiters to re-resolve. For later phases, every release decision binds the exact currently observed immutable provenance ID/hash plus current policy and narrowing generations. A waiter must re-read and reauthorize the terminal provenance after wakeup; a fanout subscriber receives no frame without a frame-specific authorization bound to terminal/execution provenance, subscriber, sequence, and digest; success replays only the terminal provenance's bounded encrypted artifact; and an absent/expired artifact returns completed-result-unavailable only through an explicit allowed no-artifact authorization bound to that same terminal provenance and unavailability evidence. Policy revocation or artifact expiry during a wait therefore triggers terminal reauthorization, not reuse of pending authority. A stale authorization, earlier provenance epoch, substituted artifact, or phase transition forces re-resolution rather than release. It appends exactly one `idempotency_existing` terminal outcome with no candidate or selection and passes the bounded result to `CommonRelease`. Every header created for this path therefore terminalizes, while the original idempotency record remains the dispatch fence and no new provider work occurs.

**CatalogExecution** uses the persisted request decision header, filters the workspace catalog through current entitlement, operation/wire compatibility, certification, lifecycle, and compiled execution-preflight availability, then appends its unique catalog local-result or typed-denial terminal outcome with an empty selection. It runs only catalog-applicable local/input policies and constructs a bounded wire-owned result. It has no logical model, route DAG, cache lookup, processor call, or provider attempt.

**LogicalRouteExecution** accepts only a `LogicalModelResolution` whose binding set is absent or has no hard target and performs these stages in order:

1. Apply hard operation, wire/translation, capability, context, data, region, provider/connection, certification, lifecycle, option, and state filters, intersecting any reusable-resource compatible-deployment set before route preflight or classification.
2. Under the persisted request decision header, evaluate the compiled route preflight manifest against actual requirements and current narrowing state. Every reachable branch must retain a statically eligible terminal, and every mandatory classifier/guardrail dependency must have exact processor grants, eligible/certified target components, and inherited data/provider permission. Persist normalized candidate evaluations as a closed eligible-with-no-exclusions or excluded-with-nonempty-exclusions union, then seal one immutable candidate-set epoch bound to the exact effective `OperationResolutionRecord` and transformation epoch. Runtime preflight emits a target/input-bound canonical provider/accounting-currency valuation for every billable request-terminal child/target even when no budget applies; resource-terminal candidates carry the immutable cost-plan reference plus canonical provider-cost valuation. Budget enforcement is independent: for each rule/authority/scope/target-currency cost subject, first seal one actual-cost-source contract and code-owned evidence-mapping version, then expand every applicable rule into one commitment slice per intersecting finite period or one permitted contract/lifetime attribution. Value each slice separately under that shared source contract and seal one closed `BudgetQuoteSet` whose members bijectively equal the complete slice set. Every member pins its slice, rule, authority, scope, currency, single period or contract attribution, valuation basis, and amount; an empty set carries signed rule- and slice-set evidence rather than a fake zero reservation. The compiler also emits one canonical funding plan inside the preflight manifest, with exact operand identities, mutual-exclusion groups, operator topology, and input cardinalities. Build the root `BudgetEnvelope` from the quote sets by deterministically instantiating that plan. For each slice, its immutable signed CAS snapshot stores a root-reachable expression tree whose leaves bijectively cover the plan operands and quote-member conversions, whose nodes exactly match the compiled `sum`/`maximum` topology, and whose evaluated root is the held amount; free-form or unreachable nodes fail admission. Each node and member separately records spendable versus contingent-shared capacity. Snapshots track those values plus allocation/settlement pointwise per slice, never a scalar sum across periods, currencies, or scopes. Before any remote input child, commit the complete pre-cache snapshot. For a cache-ineligible request, or after a cache miss, atomically enlarge it with every remaining mandatory-child vector plus the branch vector before classification. A child envelope carries an operator-preserving allocation tree over the parent derivation: `sum` capacity distributes additively, while every available `maximum` retains all nonzero alternatives under one sequential shared-capacity ledger. Such capacity is held but contingent, not spend authority. Lease acquisition selects exactly one logical route-branch reservation, closes only competing branch reservations in that ledger epoch, and appends a signed snapshot that makes the branch spendable while excluding every sibling. The logical lease stays active across same-target retries; every network attempt receives a new subordinate allocation/reservation under its exact lease version. A definitive-no-charge attempt disposition can advance the same lease to a higher version and create a new subordinate allocation without removing its branch input. A chargeable or indeterminate same-branch retry requires signed readmission under the code-owned transformation contract, with topology `sum(retained_charge, max(same_branch_retry, remaining_branches))`; it atomically supersedes the old ledger/derivation, carries the same logical lease into the successor maximum, and admits incremental headroom before creating the fresh attempt allocation. Fallback, branch completion, or terminal abandonment disposes the logical lease. No-charge fallback closes its branch input and reopens only remaining siblings; retained-charge fallback uses `sum(retained_charge, max(remaining_branches))`. Each attempt admission draws down only exact spendable capacity and names every required lease version plus fresh subordinate allocation. Retry, fallback, and terminal disposition compare-and-swap the same lease/allocation/ledger/snapshot heads, so no consumed attempt authority can be reused. No target/plan pair has been selected yet.
3. Run applicable pre-routing metadata/data checks and blocking input guardrails on minimized content. Remote checks and transformations use admitted child requests and the held budget. Apply an authorized transformation only after the checks it cannot bypass and complete the transformation readmission contract below. No prompt-derived content reaches cache, classifier, or provider before this stage passes.
4. For an eligible state-free direct/same-model exact-cache policy, reauthorize a hit's provenance against current policy and narrowing. A hit holds any mandatory output-processor maximum, releases unused pre-cache exposure, and returns a `CacheResult` to `CommonRelease`; a miss acquires the remaining child-plus-terminal floor before any classifier.
5. Traverse the route DAG. Each processor invocation atomically receives a child `BudgetEnvelope` whose initial signed snapshot allocates the exact required parent expression or carries the inherited empty-set proof. Any shared maximum it could consume must first acquire the parent ledger's branch lease; sibling allocation races produce one active winner and close only competing reservations from that epoch. The processor rechecks narrowing, executes only through its input-bound admission boundary, settles against the child snapshot, and validates typed output before use. Persist the traversal outcome, selected terminal node, classifier outcomes, and code-derived terminal-candidate bitmap; a normalized `RouteTraversalCandidateAdmission` proves that a particular candidate belongs to the chosen branch rather than merely another statically reachable branch.
6. For one statically eligible candidate admitted by that chosen branch, evaluate current health/circuit and capacity/concurrency/quota feasibility, narrowing, optional affinity, and comparable canonical cost. Persist an `ExecutionSelectionAdmission` binding those non-consumptive selection evaluations, route-traversal membership, current candidate-set pointer/context, candidate, exact target, exact canonical valuation, selected candidate's sealed `BudgetQuoteSet`, and current budget-envelope snapshot through a short validity bound. For a processor-model child, the selection context also contains the current exact service-principal/profile/input/target `processor.execute` authorization. One serializable pre-dispatch transaction consumes the selection admission once; writes the unique root `SelectedExecutionTarget`; creates its open `ProviderAttemptProgress`, initial `ProviderAttempt`, and once-consumed `ProviderAttemptAdmission` with fresh health/circuit, consumptive capacity/concurrency/quota, narrowing, exact credential-set/slot eligibility and credential quota; creates the active-execution child, credential/continuity records, one-time `BudgetAttemptAdmission`, fenced `ProviderDispatchIntent`, and `RemoteDispatchAuthority` in `ready`; atomically allocates every quoted slice from the envelope or binds the identical empty-set proof; creates the attempt-scoped prepared exposure and initial valuation epoch when resource-terminal; and advances decision, envelope, and idempotency pointers. No network I/O occurs before commit. An eligible static candidate with no valid attempt admission cannot be selected. An expired quote/evaluation/admission, stale processor target authorization, or superseded candidate/envelope/input/cost context triggers bounded re-preflight and a new same-decision candidate-set epoch, or denial; it never reconstructs current config after dispatch. Retry/fallback only before response commitment and only through another complete pre-dispatch transaction that consumes the current attempt-progress epoch.

A cache hit, explicit route `reject`, or policy/preflight/budget/narrowing/processor/credential/quote/availability denial appends the corresponding unique targetless terminal outcome with an empty selection and its exact typed evidence. Once any target has been selected, the terminal outcome remains provider-selected even when every attempt later fails; attempt outcomes never rewrite it into a targetless denial or fabricate an authorization decision.

**ExactStateTargetExecution** accepts either a logical resolution with a hard target or a resource-only state resolution and never enters cache or the route DAG. Under the persisted request decision header, it derives and seals exactly one candidate whose target equals the aggregate hard constraint; binds the set to the effective resolution/transformation epoch; applies current operation, wire, data, provider, certification, retirement, resource/action, and descendant-creation policy to every binding; proves one nonempty physical credential-slot intersection across every member lease; validates mandatory processor dependencies; resolves that candidate's canonical request valuation or immutable resource-cost plan/valuation plus sealed slice-complete `BudgetQuoteSet`; and builds the root `BudgetEnvelope` with the complete mandatory-child plus first-attempt/lifecycle slice vectors or the signed empty-set proof. It then runs applicable input checks, guardrails, and transformations under the same readmission rule. After any required readmission has sealed its final candidate epoch, replaced invalidated quotes, and advanced the envelope snapshot, it rechecks exact target/binding equality and credential intersection and persists an exact-state `ExecutionSelectionAdmission` containing fresh selection feasibility plus the exact canonical valuation, quote set, and envelope snapshot. One serializable transaction consumes it into the unique initial selected transition; creates open attempt progress plus the initial attempt/active child/credential records, fresh `ProviderAttemptAdmission`, `BudgetAttemptAdmission`, `ProviderDispatchIntent`, and ready dispatch authority; allocates every final quote slice or identical empty-set proof; and creates an attempt-scoped prepared exposure/valuation epoch when applicable. It invokes only that target after the dispatch claim protocol succeeds. Its terminal outcome records the same effective exact-state resolution/binding-set digest. State-only lifecycle eligibility permits authorized continuation/read/cancel/delete and direct descendants, never a new root or model change.

**ResourceCreateExecution** accepts only an authorized `ResourceProfileResolution`. Under the persisted request decision header, it filters the profile's bounded candidates through current data/provider/certification/retirement policy, persists/seals closed normalized evaluations bound to the effective resolution/transformation epoch, proves operation preflight totality with one immutable plan, canonical provider-cost valuation, and complete-or-empty sliced budget coverage per eligible target, then creates the root `BudgetEnvelope` holding mandatory processors plus the pointwise maximum initial funding vector or signed empty-set proof. After checks, guardrails, transformations, and any readmission, it deterministically chooses one eligible profile candidate without a classifier or caller provider preference. It persists a workspace-resource `ExecutionSelectionAdmission` with current selection feasibility and the exact final valuation/quote set/envelope snapshot. One serializable transaction consumes it into the unique initial selection; creates open attempt progress, the initial provider attempt, fresh `ProviderAttemptAdmission`, active child, `BudgetAttemptAdmission`, `ProviderDispatchIntent`, ready dispatch authority, pending binding, provider outcome, reconciliation lease, credential/creator coverage, and attempt-scoped prepared resource-cost exposure plus initial valuation epoch; and advances idempotency and envelope pointers before dispatch. The bounded provider-attempt loop starts from those already committed records. Definitive nonacceptance closes that attempt's exposure; a same-target retry creates a new attempt admission, quote-bound valuation epoch, and prepared exposure rather than inheriting the rejected attempt's cost authority. `CommonRelease` cannot expose the public resource ID until the binding, later-deployment compatibility, exact state-retention lease, attempt-specific reconciliation lease, and binding-owned firm/operational resource-cost obligation are active.

Every request transformation is a processor-profile invocation with one code-owned stage position; transformed output cannot recursively trigger another transformation. The invocation consumes an exact `ProcessorInputRef`, and its terminal outcome owns an exact `ProcessorOutputRef` whose invocation, schema, normalized digest, data class, encrypted artifact, and signature must match the bytes the wire codec validates. Its exact profile version declares worst-case expansion and semantic effects. If certification proves the output only removes data and is byte/token non-expanding, adds no modality/feature/state reference, and cannot increase data sensitivity or cost, prior admission facts may be reused only after recording the terminal outcome/output relation. Otherwise the wire codec revalidates that exact output artifact, re-extracts all state/features/data/size facts, and appends a same-decision `OperationResolutionRecord` successor naming the processor invocation, input ref, terminal outcome, output ref, transformed-envelope digest, codec-validation evidence, and fresh readmission-policy decision bundle. It reruns applicable policy/capability/candidate/preflight and blocking-input-guardrail checks and atomically enlarges every affected budget-envelope member before any cache, classifier, later processor, or provider dispatch. Re-preflight appends and seals one candidate-set epoch whose context names that exact effective resolution/transformation pair, invalidates every prior quote, and compare-and-swap installs it as the decision's current set. A stale worker cannot substitute another processor input/output, validation result, or policy bundle or create a selection admission from an earlier set; selection and terminal CAS both require the progress row's current set, and the terminal effective resolution must equal that set's context. Before any caller target selection, readmission may change the eventual terminal branch from logical route to exact state when newly extracted hard state requires it; it cannot remove/replace an admitted hard binding, switch exact state back to routing, change identity/operation/wire/logical-model/idempotency scope, or rewrite the decision header. Any failed revalidation, repeated guardrail failure, or envelope enlargement appends a typed denial outcome.

The **bounded provider-attempt loop** accepts one authoritative `SelectedExecutionTarget`, its open `ProviderAttemptProgress`, and the progress head's already-created `ProviderAttempt`, `ProviderAttemptAdmission`, active-execution child, `BudgetAttemptAdmission`, `ProviderDispatchIntent`, and ready `RemoteDispatchAuthority`. The serializable selection transaction registered that child against the parent's exact current same-root/authority snapshot, appended its target/connection/credential/wire/model-or-resource/region/certification/processor/data/policy dependency facts, and advanced the child through `target_bound`; a sealed parent authority makes the whole transaction fail closed. Before a send claim, the loop proves the selection consumed a current `ExecutionSelectionAdmission` for the decision's current candidate set; the candidate is statically eligible and admitted by the chosen branch; the attempt, admission, and intent equal the attempt-progress head; the once-consumed provider-attempt admission owns fresh health/circuit/capacity/concurrency/quota/narrowing and exact credential eligibility/quota for this network attempt; the budget admission references the same attempt admission, quote set, envelope and current snapshot; and the dispatch intent references that same authority, canonical cost valuation, and serialized payload. Its closed `BudgetAdmission` either owns one reservation for every quote slice or carries the identical signed empty-set proof. For a processor-model attempt, the attempt admission and provider dispatch intent also match the current exact `ProcessorInputRef` and positive `ProcessorModelTargetAuthorization`. The selected target equals candidate, selection, attempt admission, attempt, progress, and dispatch intent. Exact-state candidates equal the aggregate binding constraint; resource candidates belong to the authorized profile; route and processor candidates belong to their chosen compiled terminal plans.

The loop resolves the target's exact connection/auth-contract pair through the provider-attempt admission's directory generation and applies its current per-slot eligibility and quota decision. An ordinary attempt selects one set/slot. A retained attempt writes exactly one `RetainedCredentialCommonSlotSelection` containing the physical slot chosen from every referenced state/reconciliation lease's authorized intersection. Separate immutable evidence rows reference that common selection and prove, for each required lease, certified successor-set membership, equality to an exact-auth-source slot, or incident-only equality to the namespace requirement's originating slot. Evidence members never copy a selected slot. The signed common selection binds the required-lease digest and evidence high-water, and credential materialization reads only its slot after every evidence relation validates. An initial write-like attempt's pre-dispatch transaction also creates its provider outcome, reconciliation lease, credential-continuity registration, target-scoped state-creator registration, all-gate coverage receipt, and attempt-scoped prepared resource-cost exposure when applicable. An exact same-key request-state orphan recovery creates a fresh outcome and reconciliation lease but must reuse the orphan's provisional creator/credential registrations and retained target; every other legal retry creates new registrations. A missing or ambiguous target, decision header, current candidate/selection feasibility, branch membership, provider-attempt admission, attempt-specific budget admission, dispatch intent/authority, auth contract, canonical request valuation or resource plan/quote/valuation epoch, prepared exposure, common-slot/per-lease evidence, creator/lifecycle coverage, or child registration fails before credential materialization.

Each immutable dispatch intent has one CAS `RemoteDispatchAuthority` and an immutable hash-chained `RemoteDispatchStateTransition` ledger. The authority's current transition pointer, state, epoch, executor, claim, and fence must equal the ledger head. A worker first claims `ready -> claimed_before_send` with its executor identity and fencing token; an expired claim may append a release-to-ready transition only when the complete chain proves no `send_started` transition exists. An authorization that expires before send compare-and-swap appends `cancel_before_send` from `ready` or `claimed_before_send`, permanently fencing that intent. The winning executor durably appends `send_started` immediately before the first possible socket write and later advances to awaiting outcome, definitive-not-sent, indeterminate, or terminal only through the closed transition graph. After `send_started`, no worker may reuse that intent or return it to ready. A crash or lost response becomes indeterminate and reconciles without resending. Only a current exact `UpstreamIdempotencyCertification` plus closed `UpstreamRecoveryAuthorization` may authorize a **new request-terminal provider or connector attempt** carrying the same upstream key and payload. If that provider operation can create state, the authorization also consumes its exact request-state orphan control epoch and installs a fresh reconciliation lease; without the signed capability receipt and this owner transition, no recovery dispatch is reachable. A resource-terminal create instead remains on its original exposure/outcome/lease; each separate read-only reconciliation poll uses its own admitted lifecycle intent and dispatch authority while atomically consuming the orphan's non-resetting cumulative recovery bound. This deliberately permits false-positive indeterminate outcomes if a worker crashes between the durable marker and the actual write, because avoiding duplicate side effects is the stronger invariant.

Provider, processor-connector, and resource-reconciliation intents each own one immutable `dispatchNotAfter`, code-owned deadline-derivation version, and trusted-time source. The derivation takes the earliest applicable request/invocation deadline, runtime/credential/budget admission validity, authorization deadline, and recovery bound: a same-key provider or connector attempt includes its immutable `recoveryNotAfter`; a reconciliation poll includes its `ResourceReconciliationAdmission.validThrough`, authorization `reconciliationDeadline`, request deadline, and orphan absolute horizon. The `RemoteDispatchAuthority` already names the exact intent. Its `mark_send_started` compare-and-swap must load that intent and require exact equality of the deadline, derivation version, and time source, then reject trusted time equal to or later than the deadline. A worker that claimed before expiry but wakes or fails over after it can only append `cancel_before_send`; the transition cannot supply a later independent deadline. That cancellation references one signed `DispatchDeadlineReachedEvidence` which binds the exact intent, authority and pre-cancellation transition head, deadline, derivation version, trusted-time source/evidence, and observation at or after the bound. Provider, connector, and reconciliation paths use this same evidence record; a reconciliation cancellation outcome additionally names it through the `dispatch_deadline_reached` variant.

Every normalized durable dispatch-chain record carries the same `(organizationId, workspaceId, requestId)` scope. Provider and connector admission, attempt progress, intent, authority, state-transition, cancellation-evidence, and terminal-outcome relations, plus the corresponding reconciliation chain, use composite scoped primary and foreign keys; no side-effect boundary resolves one of these IDs globally. Execution-decision progress and terminal outcomes repeat their decision header's scope. Processor invocation intent, state, terminal outcome, and signed output repeat the invocation's parent-request scope, and connector progress-to-outcome plus outcome-to-final-admission/output joins use that tuple. A model-backed processor outcome instead carries a separate scoped child-decision terminal ref whose `requestId` equals the intent's `childRequestId`; its selected target joins under that child tuple, never the parent request. Intent-to-authority, admission-to-intent, progress-to-current-attempt/admission/intent, deadline evidence-to-intent/authority/head, and terminal outcome joins require exact scope equality in the same transaction. Any cross-organization, cross-workspace, parent/child-request, or same-workspace request substitution fails before claim, cancellation, or terminalization.

The reconciliation executor is not a privileged transport bypass. Its initial transaction compare-and-swap consumes the orphan's available recovery-control epoch and remaining immutable recovery bound, advances the authorization-chain high-water/hash, and installs exactly one active authorization/progress root plus the first lifecycle request, admission, budget reservation or identical empty proof, intent, and ready dispatch authority. Every later poll compare-and-swap consumes both the open progress epoch and matching active recovery-control epoch, increments both authorization-local and orphan-cumulative invocation counts, proves that neither the authorization deadline nor absolute orphan horizon has passed, proves the current reconciliation-lease ownership epoch, reauthorizes the lifecycle principal and exact retained target/credential intersection, obtains fresh runtime and request-cost authority, and installs exactly one successor attempt/admission/intent. A successor authorization can allocate only the unused count interval below the orphan ceiling and cannot move the horizon. An approved extension may increase the ceiling, horizon, or both without resetting count or authorization history; its discriminated delta must strictly change at least one bound, and exact marginal exposure determines whether no budget applies, an existing reservation covers it, or an incremental bundle is required. Each dispatched attempt owns one closed outcome bound to the terminal dispatch transition: a target-codec observation, definitive-not-sent transport proof, sent/outcome-indeterminate proof, or signed policy/credential/admission/cleanup cancellation after `cancel_before_send`. Identity and definitive absence dispositions require matching codec observations. Local or orphan count/time exhaustion is a distinct progress/control terminal transition: it binds the active epochs, trusted time, current high-waters, and last completed attempt/outcome/observation, creates no successor attempt, and atomically returns the control to `available`. If a ready/claimed attempt exists when time expires, ordinary pre-send cancellation first closes that attempt and is included in the exhaustion evidence; send-started work must resolve before exhaustion can close. Non-cleanup cancellation requires exact invalidation evidence and closes to `available`. Cleanup first consumes the active control into `closing_cleanup`; no admission can match that state. Its retained progress may only close: pre-send through cancellation, after a recorded definitive-not-sent outcome through the exact transport evidence plus separate no-charge proof, or post-send after the attempt is terminal/indeterminate and canonical request cost plus every budget allocation is reconciled. Matching cleanup-supersession evidence then terminalizes progress and permits `closing_cleanup -> closed`. Not-yet-observable, definitive-not-sent, or indeterminate outcomes may otherwise advance to another bounded poll only while the control remains `active`. Next-poll admission, control exhaustion, identity-proof activation, absence/cancellation release, and cleanup-start compare-and-swap the same active control and progress epochs, so only one wins and no parallel or sequential authorization chain can bypass the orphan-level bound.

A safe same-target credential or provider retry is a new registered attempt beneath the same logical route-branch lease. After definitive non-acceptance, one serializable transaction consumes the open attempt-progress epoch, terminalizes the prior outcome, aborts its attempt-scoped prepared exposure and registrations, and closes only that attempt's subordinate budget allocation. Definitive no-charge advances the lease version without removing the logical branch. A partial/full charge or indeterminate maximum produces signed retained-charge evidence and must win `BudgetFundingPlanReadmission` for `sum(retained_charge, max(same_branch_retry, remaining_branches))`, carrying the lease into the successor ledger before any new allocation. The transaction then re-evaluates health, circuit, narrowing, capacity, concurrency, quota, credential eligibility, and credential quota into a fresh `ProviderAttemptAdmission`; allocates every current quote slice from the exact new envelope snapshot or reuses the exact empty-set proof; creates the new subordinate branch allocation, `ProviderAttempt`, active child, ordinary-slot or retained common-slot selection, creator records, `BudgetAttemptAdmission`, `ProviderDispatchIntent`, ready dispatch authority, and new prepared exposure/valuation epoch when resource-terminal; and advances attempt progress to exactly those rows. Neither the request's compiled total-attempt bound nor any slice's budget headroom may be exceeded. The retry never reuses selection feasibility, the first attempt's runtime/budget authority, attempt allocation, or aborted exposure merely because the target is unchanged. Selecting a different target additionally obtains a fresh `ExecutionSelectionAdmission` and target-bound canonical valuation/quote set, disposes the predecessor logical lease, and either reopens remaining branches after definitive no-charge or installs the retained-charge fallback readmission. One transaction then consumes the predecessor's open attempt-progress epoch into `fallback_handoff`, records its final attempt, appends the higher-epoch selected fallback, creates that selection's new open attempt progress and first full provider-attempt authority, and proves candidate-set, lease, and envelope pointers current. Request terminalization similarly consumes the current open attempt-progress epoch and lease into `decision_terminal`; therefore retry/retry, retry/fallback, and retry/terminal races have one winner. There is exactly one null-root selection per decision; predecessor foreign keys require the same decision and strictly increasing epoch, and each fallback first-attempt admission names the predecessor selection's terminal progress/final attempt. Selecting a later ordinary directory generation or stale processor input/authorization requires full readmission. The raw transport wrapper enforces byte/time/throughput/backpressure limits, then the target codec incrementally parses and limits semantic frames and outcomes before the orchestrator decides retry/fallback. The loop never sends without a valid provider-attempt admission, matching progress head, fresh subordinate budget allocation/admission/dispatch intent, active registration, and exclusive send claim. Only the resource executor may supply a provider-resource target; public model routes and processor model plans remain deployment-wire-binding-only.

`SelectedExecutionTarget` is the sole durable consumption record for a decision's strategic target, applicable resource-cost plan, and selection admission; it does not own attempt runtime, dispatch, spend, or lifecycle start/valuation. Its parent is an already-persisted immutable decision header owned either by the external request or by one model-backed processor child request. A separately fenced `ExecutionDecisionProgress` row holds the current candidate-set pointer, selected-transition pointer, terminal-outcome pointer, and transition epoch; processor progress never enters the caller's route/fallback chain. Candidate sets have exactly one initial epoch per decision; every readmission epoch names a same-decision predecessor, exact external resolution/transformation or `ProcessorInputRef` context, and is installed by compare-and-swap on that progress row. Candidate evaluations are immutable, sequence-addressed closed variants admitted only before that set's sealed high-water. Database constraints require every selection to consume exactly one same-decision `ExecutionSelectionAdmission` for the current eligible candidate/context and canonical valuation, permit each admission to be consumed once, require branch membership plus target/plan equality, and enforce one root with a same-decision compare-and-swap predecessor chain. Exactly one `ProviderAttemptProgress` exists per selected transition; its CAS head serializes every retry, fallback handoff, and decision terminalization. The initial selection transaction requires the admission's initial provider-attempt, provider-attempt-admission, and budget-attempt-admission IDs to equal the rows and progress root it creates, with exact quote-set/envelope/current-snapshot relations; every later attempt has its own fresh runtime admission, budget admission, dispatch intent/authority, and resource exposure when applicable. Terminal CAS stores only the final `terminalSelectedExecutionTargetId`, requires it to equal the decision progress row's current selection and that selection's attempt progress to close as `decision_terminal`, and derives the complete selection/attempt chains through predecessor foreign keys; copied ID arrays are never authority. Cache/reject/denial/idempotency outcomes have no selected pointer.

Every billable request-terminal candidate or connector owns one exact `CanonicalRequestCostValuation` in provider and accounting currencies, independent of budget policy; request-budget quotes reference it rather than defining the comparable provider cost. Each request-budget or resource-budget quote represents exactly one period/contract slice for one rule/authority/scope/currency. Each resource quote additionally binds the current candidate set/evaluation, effective operation-resolution/transformation context, operation/preflight, exact target, and complete applicable rule-and-slice-set digests, and always carries a subtype-matched canonical provider-cost valuation even when no budget rule applies. A sealed `BudgetQuoteSet` is either the complete set of independently valued slices for every intersecting budget window/contract or a signed empty-set proof. A root `BudgetEnvelope` holds those slices pointwise; each member's signed funding-expression tree binds the exact compiler plan, bijectively covers its quote-member/conversion leaves, and preserves explicit `sum`/`maximum` topology, while signed compare-and-swap snapshots record every child/attempt allocation and settlement without changing slice, rule, authority, scope, period, or currency. Each child receives an operator-preserving allocation tree over its parent derivation; additive nodes distribute capacity and maximum nodes serialize spend through logical branch leases with fresh attempt allocations. No-charge retry versions the same lease; retained-charge retry or fallback uses a signed, evidence-bound, code-derived readmission plan and exact incremental headroom. Each provider attempt or connector then consumes one exact quote set and current snapshot into its own `BudgetAdmission`; a nonempty admission owns one slice-complete `BudgetReservationBundle`, while an empty admission owns the identical signed proof. Resource attempt preparation also commits its plan, quote, lifecycle start, and initial valuation epoch; each quote and epoch preserves canonical provider-cost valuation independently from complete-or-empty sliced budget coverage. Mixed sources, periods, and currencies are valued separately and never collapsed into one scalar or one aggregate conversion. Before creating period slices, each rule/authority/scope/currency cost subject pins one signed actual-cost-source contract and exact code-owned mapping version; all eligible slice conversions reference it. At actual-cost time, signed mapping evidence binds source, target, valuation, usage/invoice/correction lineage, selected component, currency, and amount. One reservation-independent `CanonicalBudgetActualCostSourceSelection` then chooses that source for the entire eligible slice set, and one `CanonicalBudgetCostAttribution` partitions it across all eligible reservation components exactly once. Each settlement consumes one unique component rather than copying the full source into every slice. Pending bindings, prepared/active/orphan exposures, processor terminal outcomes, and provider attempts reference exact selected and attempt/admission IDs. Binding/orphan cost ownership must match the attempt-scoped exposure's request/resource lifecycle, idempotency record, reconciliation lease, lifecycle terms, canonical-cost epoch, and complete sliced budget coverage. Active resource ownership requires the obligation/lease pair; a terminal tombstone requires a settled obligation with completeness evidence or definitive-nonacceptance evidence and released reconciliation ownership. These owners never reconstruct selection, admission, or cost authority from parallel fields.

**CommonRelease** accepts a discriminated `IdempotencyResult`, `CatalogResult`, `CacheResult`, or `ProviderResult`:

1. Validate/decode the bounded result and run the operation's blocking or progressive output policy before cache write or response commitment. A blocking guardrail buffers the complete output; a progressive guardrail checks each releasable frame and cannot claim to retract earlier bytes.
2. For root or descendant state creation, cross the durable pending-to-active binding/lease barrier, obtain or revalidate all-gate coverage for every final state/reconciliation requirement, and link the wire-permitted encrypted replay artifact or completed-but-unavailable tombstone to the idempotency record before exposing the corresponding ID, body, event, or job handle. For a `resource_terminal` operation, the same transaction consumes the prepared exposure into the relationally matched binding-owned obligation, transferring bounded post-request exposure for firm work or establishing the rolling operational tracker. A crash after possible provider success but before this transaction leaves an owned prepared exposure that recovery moves to `reconciling`/orphan state, never permission to dispatch again.
3. Write an eligible exact-cache entry only after output and state-free assertions pass.
4. Persist canonical request-cost settlement for every billable request-terminal child/attempt, including lifecycle reconciliation polls, regardless of budget presence. Compare-and-swap settle every present period/contract slice through the owning budget-envelope snapshot and settle the request portion of each resource-terminal slice, preserving the signed empty-set proof when none apply. A non-streaming response cannot become `release_ready`, and a streaming response cannot release its final frame or terminalize, until every possibly billable attempt has canonical settlement or its dispatch authority and provider/connector/reconciliation cost lineage remain durably `indeterminate` with every allocation held. Do not release any reservation transferred to a live resource binding.
5. Register a release child or append the release facts and compare-and-swap the root's snapshot continuation to `release_ready`, then render the ingress-wire response. Recheck narrowing before every streamed frame, enforce response/output ceilings, and use the per-event contract in Section 7.6 for bidirectional interactions. Emit linked request, policy, processor, resolution, route, attempt, state, cache, response, dispatch-authority, envelope high-water, canonical request/provider cost, and per-slice reservation-lifecycle evidence.

Route nodes never receive deployments excluded by mandatory policy. This is how the system guarantees that an attractive route branch cannot bypass a compliance rule.

### 8.3 Internal processors use an admitted invocation boundary

An LLM classifier, remote guardrail, enrichment service, or other processor is not an implementation detail outside policy. The parent first minimizes and, when required, redacts input into a signed immutable `ProcessorInputRef` containing the exact schema, normalized digest, data/residency classes, encrypted artifact, transformation epoch, and minimization/redaction decisions. Before candidate work, target admission, budget allocation, or execution, one fenced transaction registers a same-root/authority active-execution child against the parent's current snapshot and persists an immutable `ProcessorInvocationIntent` containing that exact input ref, child, parent authorization, exact profile, closed child `BudgetEnvelope`, invocation limits, and discriminated in-process/model-plan/connector plan. Its current projection is `pending` and carries no fake selection or reservation fields. Intent, state, terminal outcome, and signed output repeat one canonical organization/workspace/parent-request scope. A model plan also creates the linked child request and immutable `processor_model` decision header; candidate sets, quote sets, selection admissions, selected transitions, attempt admissions, and terminal outcome remain disjoint from the caller decision. A connector plan obtains one canonical request-cost valuation plus a short-lived initial `ProcessorConnectorExecutionAdmission` after preflight and before dispatch, binding the exact input ref/digest, connector, positive service-principal authorization, connection/runtime decisions, narrowing, slice-complete quote set, envelope snapshot, and closed `BudgetAdmission`. One transaction consumes it into a new open `ProcessorConnectorAttemptProgress`, matching `ProcessorConnectorDispatchIntent`, and ready `RemoteDispatchAuthority` whose serialized payload digest, canonical valuation, and budget authority match that admission. The same exclusive claim/send-start protocol used for provider attempts gates network I/O. An ambiguous connector send reconciles without reuse; a matching current `UpstreamIdempotencyCertification` and `UpstreamRecoveryAuthorization` may instead authorize a separately linked retry admission with fresh runtime/budget authority, a new payload intent, and a new dispatch authority. A retry retains the prior allocation until no-charge evidence or canonical settlement proves what can be released, enlarges the child envelope for any incremental maximum, and consumes the current connector-progress epoch when installing the new head. Exactly one same-parent-scope `ProcessorInvocationTerminalOutcome` later consumes that same open progress into terminal state and names its final connector admission; its signed output uses the same composite tuple, so retry/retry and retry/terminal races have one winner without a global ID lookup. Every completed variant owns a signed `ProcessorOutputRef`, while denial contains neither a target admission nor a reservation. Every invocation:

- requires a positive `processor.invoke` grant for the exact processor-profile version, bound to the parent logical model/route, guardrail policy, or operation stage; the profile is not directly caller-invocable or discoverable;
- inherits the parent organization, workspace, caller principal, data classification, residency, allowed provider/network and processor-target model classes, capture mode, complete-plan cost ceiling, cancellation, cumulative budget, and remaining deadline, but not the caller's direct public-logical-model allowlist;
- for a model/connector implementation, intersects those constraints with a gateway-controlled processor service principal; the compiler emits exact grant requirements and bounded evaluation plans, while runtime candidate/connector preflight produces a current positive `processor.execute` decision for the exact profile, input ref, service principal, and deployment-wire-binding or connector version before selection or dispatch;
- for a model/connector implementation, runs the same provider/processor connection grant, lifecycle, certification, secret, network, rate, revocation, and budget admission checks as an external inference request;
- records and settles canonical provider/accounting cost for every billable remote implementation, then allocates and settles its complete period/contract-sliced budget quote set through the child envelope against every applicable scoped authority; an in-process implementation has a certified zero-billable-cost declaration but still consumes bounded CPU/deadline/invocation limits;
- sends only the exact minimized/redacted artifact named by `ProcessorInputRef`; quote, admission, dispatch intent, retry, output, and transformation readmission reject a different ref, digest, schema, artifact, or transformation epoch;
- records its immutable input ref, intent, pending/terminal pointer, terminal outcome/output ref, active-execution child, child request/decision when model-backed, connector admission/dispatch intent when connector-backed, component evidence, complete parent-invocation authorization decision, and complete selected remote target-execution authorization decision when applicable, linked to but never owned by the parent decision;
- has a compiled recursion depth of one and cannot invoke a public logical model, another classifier, or another external processor.

A classifier node references an exact versioned **processor profile**, not a public logical model. A model-backed profile compiles a bounded terminal plan; each invocation intent owns a child request and `processor_model` decision header, whose input-ref-bound candidate sets, runtime selection admissions, and single-root selected chain target exact `ModelDeploymentWireBindingRef` values. Every model selection admission carries a current `ProcessorModelTargetAuthorization`, and its atomic first-attempt transaction binds that authorization and input ref into the provider dispatch intent. A model terminal outcome carries a scoped child-decision terminal ref whose request equals the intent's exact `childRequestId` and, only when provider-selected, its final selected ID under that child scope plus the parent-scoped output ref; denial needs no fake target. The parent request tuple can never resolve the child decision. Multiple processor targets and the caller's eventual terminal target therefore produce independent chains with enforceable foreign keys. A connector intent names only the connector plan. Its initial pre-dispatch admission consumes the exact input-bound service-principal authorization and closed budget admission once and creates one connector-attempt progress root; any certified retry consumes the current progress epoch while appending a same-invocation admission with fresh runtime, budget, intent, and dispatch authority. The selected terminal outcome consumes and references the progress head's final admission and output ref under the invocation's parent scope, while denial has neither. Parent `processor.invoke` and service-principal `processor.execute` are different complete authorization decisions: neither implies the other, both are default-deny and independently revocable, and production grants name exact immutable deployment-wire-binding or connector versions rather than deployment-wide tags or mutable selectors. The profile returns only a certified outcome ref; classifier parse or availability outcomes follow the route node's explicit reject/degradation edges, a guardrail outcome follows its policy stage's fail mode, and an enrichment or transformation outcome follows its operation stage. The runtime does not invent a deterministic routing fallback. In-process profiles execute their pinned implementation under the same typed/evidence boundary but need no network target grant; any call that crosses a network uses the full active-execution child boundary, and a model call additionally uses the full child-request/decision boundary.

### 8.4 Constrained route DAG

Routing config V4 should be a directed acyclic graph with a small set of node kinds:

- `condition`: branch on allowlisted request metadata, operation facts, workspace attributes, or computed policy facts;
- `classifier`: call an approved classifier and branch on its typed output;
- `weighted_split`: deterministic weighted experiment/canary split using a stable key;
- `pool`: select among canonical-model or deployment selectors using a named strategy;
- `fallback`: try ordered child routes under explicit failure conditions;
- `target`: resolve a canonical-model or explicit deployment selector;
- `reject`: return a named gateway error.

The graph should enforce:

- one root;
- no cycles;
- bounded node count and depth;
- all branches terminating;
- no arbitrary JavaScript, templates, network calls, or plugins;
- typed condition operands and metadata keys;
- explicit classifier failure edges;
- publish-time detection of unreachable nodes and impossible capability promises;
- route totality for every concrete active subject/credential policy fingerprint and declared onboarding synthetic-principal context, requested interaction mode, and classifier output, including mandatory processor dependencies and candidate sets after policy narrowing.

Budget, access, data, and firm rate policy remain outside the graph. A route condition may branch on a computed fact such as budget remaining, but cannot redefine the budget.

Public logical models are the only route entry points. Route nodes cannot reference logical models or other published routes. If repeated private graph fragments become necessary, the compiler may support versioned private fragments that are expanded and cycle-checked at publication; the runtime still receives one flat DAG with only terminal deployment selectors.

The compiler emits a versioned **route preflight manifest** per logical-model/wire/operation/mode and policy-fingerprint class. It stores each declared output's terminal candidate bitmap, every mandatory transformation/input/classifier/output processor profile and exact target dependency, both processor-policy requirements, certification/data/provider constraints, invocation mode/hard cardinality, transformation worst-case expansion, total maximum child exposure, the least maximum first-terminal exposure for each branch, and any bounded post-response resource-lifecycle exposure. A non-monotonic transformation's maximum counts the second invocation of every remote input guardrail that readmission may repeat. Its hash and price/FX-schedule references enter the workspace revision and request evidence.

The same compiler emits smaller operation-preflight manifests for `state_binding`, `workspace_resource`, and `workspace_catalog`: state manifests combine exact deployment/resource-target action/retention requirements with mandatory processor and first-attempt exposure; resource manifests combine the bounded profile-owned create-target set, `resource_access`, state-mapping, mandatory processor, and least-first-target exposure; catalog manifests contain only policy/certification dependencies needed to render discovery. These are distinct artifact variants, not empty route DAGs. A logical-model manifest also declares which binding kinds impose a hard target versus a compatible-deployment intersection and the exact-state executor contract used for the hard case.

The identity/credential directory assigns an effective-policy fingerprint and baseline logical-model availability to each concrete principal/credential. Publication evaluates all active fingerprints against the preflight manifests. A new grant activates only after the control plane compiles and proves its new fingerprint; a security narrowing takes effect immediately and recomputes availability rather than being blocked. An issuance template has no fingerprint by itself: approval validates its exact references statically and simulates an explicitly named synthetic principal type/team/attribute context, while issuance proves the real subject's computed fingerprint before activation.

Discovery exposes a routed model only when the caller's baseline manifest is total across terminals and mandatory processor dependencies. Request admission repeats the proof after actual data, feature, state, option, revocation, and budget filters and atomically holds the conservative execution floor before the first remote child. Losing a classifier branch, processor grant/certification, or minimum child-plus-terminal exposure therefore denies the logical model before classification instead of producing a late partial-route failure.

### 8.5 Pool selection strategies

Support strategies only when their required state is trustworthy:

- ordered priority;
- weighted random within the highest available priority;
- round robin;
- least in flight;
- exponentially weighted latency;
- lowest effective cost;
- quota/headroom aware;
- consistent hash for session/cache affinity;
- quality score from offline certification or evals.

Do not begin with every strategy. Ordered priority, weighted choice, consistent hash, least-in-flight, and health exclusion cover most needs. `lowest effective cost` compares the candidate-bound `CanonicalRequestCostValuation` or canonical resource valuation in one approved accounting currency, records that exact valuation on selection evidence, and never compares budget-local currencies or missing-budget state. Cost or quality optimization should come after pricing and eval evidence are reliable.

### 8.6 Session and provider-cache affinity

Treat provider-managed state and provider prompt-cache affinity differently:

- **Hard state affinity:** a gateway binding such as a previous response, conversation, session, or job fixes one canonical deployment-wire-binding or provider-resource-target reference before route traversal. An incompatible route branch is unavailable; the gateway never fabricates failover.
- **Resource compatibility constraint:** a profile-created file or asset may be certified for a bounded set of deployments on its exact provider-resource target/connection. It narrows the route universe before preflight and classification; it never expands eligibility or crosses that set without materialization.
- **Soft cache affinity:** after an observed provider cache write or trusted cache-hit signal, record a principal-scoped affinity containing the gateway session key, canonical model release, deployment, cache-prefix HMAC, observed cache state, confidence, and expiry. It improves selection but does not grant access or override health/data policy.

For a coding auto-route with a certified stable session key, the default should classify at session start and retain the canonical model plus deployment while the cache is credibly hot. Reclassification or target switching requires an explicit route policy and one of: cache expiry, a turn declared independent by a trusted integration contract, a hard capability mismatch, ineligibility, or a route-owned failure edge that names a cold switch. The cost comparison uses marginal cached cost for staying versus full-prefix processing plus new-cache creation for switching. If cache state or provider pricing is not trustworthy, do not claim cost optimization.

Every wire/SDK/harness compatibility profile declares its session-key source: a gateway-owned state ID, an explicitly registered and trusted session header/token, or `none`. Gateway session tokens are opaque, organization/workspace/principal scoped, and HMAC-bound; a caller-supplied label is only attribution and cannot join another principal's affinity. A client with `none` is classified per independent request and receives no cross-request soft-affinity guarantee. A cold switch records the old/new targets, cache evidence, estimated lost reuse, reason, and realized usage. Access policy still filters first, so affinity can never retain a frontier target for an external economy credential.

### 8.7 Distinguish recovery mechanisms

| Mechanism | Same deployment? | Same canonical model? | Typical trigger |
|---|---:|---:|---|
| Connection retry | Yes | Yes | Connection reset or retryable timeout before commitment |
| Credential-slot retry | Yes | Yes | Explicitly classified quota/health failure and an eligible alternate slot in the same pinned set generation |
| Deployment failover | No | Yes | Region/provider endpoint unavailable or at capacity |
| Model fallback | No | No | Model unavailable, policy-approved degradation, explicit route branch |
| API-wire translation fallback | No | Maybe | Native deployment unavailable and a certified translation path exists |
| Classifier branch | No | Often no | Intent/complexity policy for a meta-route |

Each mechanism has different quality, cost, privacy, cache, and state implications. Store it explicitly on the route decision and attempt chain rather than calling everything a retry.

### 8.8 Retry safety

Retry policy is operation- and state-specific:

- safe before any upstream acceptance or response commitment;
- unsafe when the provider may have accepted a tool-producing generation or state-creating write and its idempotency contract cannot prove deduplication;
- unsafe for non-idempotent async job submission unless the provider honors an idempotency key;
- unsafe after any response byte reaches the client;
- limited by a total request deadline, not merely per-attempt timeouts;
- classified by the shared attempt orchestrator from target-codec semantic outcomes and provider-adapter typed transport observations, never by a provider-adapter semantic error category or status code alone.

Maintain separate limits for connection retries, deployment attempts, model fallbacks, and total wall-clock time. Generate one stable gateway idempotency key per logical write and map it through the certified target-wire binding only when that provider contract proves equivalent scope and retention. The provider adapter only materializes that binding's physical header. An ambiguous result without such certification returns an indeterminate-outcome error and is never retried. Honor a target-codec-parsed provider `Retry-After` only when it fits the request deadline.

### 8.9 Route example

This is illustrative, not a final schema:

```json
{
  "schemaVersion": 4,
  "logicalModel": "opendoor/coding-auto",
  "operation": "text.generate",
  "root": "classify",
  "nodes": {
    "classify": {
      "kind": "classifier",
      "processorProfile": "coding-complexity-classifier-v1",
      "outputSchema": "coding-complexity-v1",
      "branches": {
        "fast": "fast-pool",
        "balanced": "balanced-pool",
        "hard": "hard-pool",
        "deep": "deep-pool"
      },
      "onFailure": "classifier-failed"
    },
    "fast-pool": {
      "kind": "pool",
      "strategy": "priority-weighted",
      "selectors": [{ "canonicalModel": "example/fast-model" }]
    },
    "balanced-pool": {
      "kind": "fallback",
      "children": ["balanced-primary", "balanced-secondary"],
      "on": ["rate_limited", "upstream_unavailable"]
    },
    "balanced-primary": {
      "kind": "target",
      "selector": { "canonicalModel": "example/balanced-model", "region": "us-east" }
    },
    "balanced-secondary": {
      "kind": "target",
      "selector": { "canonicalModel": "example/balanced-model", "region": "us-west" }
    },
    "hard-pool": {
      "kind": "target",
      "selector": { "canonicalModel": "example/hard-model" }
    },
    "deep-pool": {
      "kind": "target",
      "selector": { "canonicalModel": "example/deep-model" }
    },
    "classifier-failed": {
      "kind": "reject",
      "code": "routing_classifier_unavailable"
    }
  }
}
```

The four tier names exist only inside this route version. A direct embedding model or pinned text model needs no classifier and may compile to a single target.

## 9. Model and Provider Configuration

### 9.1 Do not reproduce LiteLLM's unbounded configuration surface

"Support all LiteLLM configuration" should mean covering the legitimate use cases, not cloning every YAML key. Proxy should classify configuration by owner and lifecycle so precedence is deterministic.

| Configuration domain | Examples | Resource owner | Validation time |
|---|---|---|---|
| Operation definition | resolution mode, state/idempotency/commitment/billing lifecycle, applicable policy stages | code release | build/startup + operation conformance |
| API wire + wire codec | methods/paths, schemas, headers, streaming, errors, state semantics | code release | build/startup + conformance |
| Translation adapter | directed wire/version pair, operation, feature fidelity, mappings | code release | build/startup + certification |
| Provider adapter | physical connection schemas, endpoint/auth rules, discovery, transport-observation maps | code release | build/startup |
| Processor adapter/implementation | connector schemas or in-process executable behavior | code release | build/startup + processor conformance |
| Provider connection | account/project identity, base URL, API version, network/region | organization admin | save + connection test |
| Provider credential slot/set | secret/workload-identity ref, auth scope, activation/expiry, bounded slot-selection generation | organization security/model admin | save + auth probe + publish |
| Processor connector | approved non-model endpoint, auth/network, schemas, data contract | security/platform admin | save + connector certification |
| Canonical model release/family | immutable identity, maker, facts, provenance, lifecycle | platform/org catalog curator | catalog approval + certification |
| Deployment | upstream model ID, egress wire bindings, capabilities, limits, data properties, price ref | model operator | save + discovery/certification |
| Logical model | public ID, ingress wire promises, operations, promised features, route version | workspace model admin | publish |
| Route | selectors, strategy, conditions, retries/fallbacks | workspace model admin | compile + simulate + publish |
| Resource profile | model-less resource purpose, bounded create target, state mapping, compatibility, data/retention/cost contract | workspace model/security admin | compile + certify + publish |
| SDK compatibility profile | SDK versions, methods, wire, base URL, auth convention, conformance result | code release | build + SDK conformance |
| Harness configurator manifest | harness versions, wire, owned settings, credential integration, serializer | code release | build + harness conformance |
| Credential issuance template | exact access profile, optional narrowing-policy refs, principal eligibility, credential type/TTL, auth presentation, harness scope | workspace security admin | save + control-plane approval |
| Onboarding profile | supported harness configurators, default logical model, credential issuance template, synthetic preview context | workspace admin | save + control-plane approval |
| Processor profile | typed input/output, in-process implementation or terminal model/connector plan, retry/outcome/cardinality/data contract, certification | platform/security admin | compile + certify + publish |
| Access profile | immutable exact typed policy-version references for scoped principal/credential attachment | workspace security admin | compile + publish |
| Access/data policy | models, providers, operations, regions, classifications | security/org admin | publish |
| Parameter policy | defaults, allowed values, caps, forced values | org/workspace admin | publish |
| Limits/budgets | RPM, TPM, concurrency, spend, windows, firm/operational class, fail-closed or bounded-degradation allocation contract | org/workspace/finance admin | compile + publish |
| Cache/session | exact cache, semantic cache, provider cache, affinity | route/workspace admin | publish |
| Capture/observability | metadata, sampling, retention, destinations | security/platform admin | publish |
| Request preference | provider order, timeout, cache intent, metadata | caller | request admission |

### 9.2 Separate wire fields, model semantics, hosting controls, and gateway preferences

One undifferentiated `provider_options` bag confuses the model maker with the company hosting a deployment. Use four explicit layers:

1. **Wire fields:** standard request fields and registered extensions owned by the ingress wire, such as maximum output, stream intent, tools, or structured-output shape.
2. **Model-semantic options:** maker-owned behavior such as Anthropic thinking or OpenAI reasoning. These are namespaced by model maker, become normalized feature requirements, and may be served through another host only when that deployment and translation path certify equivalent semantics.
3. **Target-wire hosting extensions:** semantic or billing-affecting deployment-channel behavior such as Vertex safety settings, Bedrock performance configuration, or OpenAI service tier. These are versioned extension schemas owned, validated, and serialized by the target wire codec; a deployment binding enables exact certified versions. Physical hosting controls such as endpoint, region, project, API version, authentication, network path, and non-semantic transport headers remain provider-adapter configuration.
4. **Gateway preferences:** a small allowlisted contract for provider order/only, latency deadline, cache intent, and attribution. These can only narrow an already authorized route.

These are ownership layers, not four arbitrary objects added to every public request. Caller input still arrives only through standard wire fields, a registered wire extension, or an allowlisted gateway header. Model-semantic and target-wire hosting-extension values may also be administrator-authored route/deployment defaults, but they still pass through the same versioned codec schema and certification. A value that the ingress wire cannot express is not available to a drop-in SDK call unless a reviewed extension contract exists; Proxy does not smuggle a generic `provider_options` bag into OpenAI or Anthropic bodies.

[Vercel's provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options) demonstrate why maker and host cannot be the same axis: Anthropic model options can still apply when Vertex hosts the model, while provider order or `only` changes the eligible hosting path. Proxy should make that distinction explicit and policy-visible rather than embed both meanings under a provider name.

A caller's required option narrows the candidate matrix after policy and certification filters. A candidate remains only when its canonical model, hosting deployment, egress wire, and translation path collectively implement that option. If none remain, admission returns an ingress-wire-native unsupported-option error before egress. The gateway never silently ignores the option and never requires every possible target in a route to support it. Route defaults may vary by target only when they preserve the logical model's public promise and appear in decision evidence.

### 9.3 Parameter policy semantics

For each recognized request parameter, policy may define:

- `allow`: permitted values or ranges;
- `deny`: forbidden values;
- `default`: value applied only when absent;
- `cap`: maximum/minimum or size bound;
- `force`: organization-controlled value that the request cannot override;
- `strip`: remove an optional field only when the API contract explicitly declares stripping safe;
- `reject`: fail if the field appears.

`strip` must be rare. Security-sensitive or behavior-changing incompatibility should reject, not silently mutate.

### 9.4 Precedence and monotonic narrowing

Recommended precedence is:

```text
wire-codec, translation-adapter, provider-adapter, and physical capability
  -> organization security/data policy
  -> workspace policy
  -> team/principal entitlements
  -> credential restrictions
  -> logical model and route version
  -> caller request preferences
```

Lower levels may choose among or further restrict what higher levels allow. They cannot broaden it. Deny wins over allow. A forced organization value wins over a route default. A credential can have a smaller model allowlist than its service account, never a larger one.

Team grants are unioned only within the organization/workspace maximum; explicit denies still win. This supports users in multiple teams without making one permissive team able to override a compliance boundary.

### 9.5 Configuration compiler

Publishing a workspace revision should:

1. resolve all resource-version references;
2. resolve exact operation-definition, API-wire, wire-codec, translation/provider/processor-adapter, provider-connection/auth-contract requirement, resource-profile, processor-profile/connector, access-profile/policy, and canonical-model catalog versions plus an immutable candidate provider-credential-directory generation;
3. verify route DAG structure and termination;
4. compute every logical model's possible deployments;
5. compile operation dispatch, the ingress-wire to egress-wire compatibility matrix, resource-create plans, and non-recursive discriminated processor plans whose remote terminals are exact deployment-wire-binding or processor-connector versions; compile separate parent `processor.invoke` and service-principal `processor.execute` requirements plus bounded evaluation plans for those exact versions, never request-specific authorization decisions; verify operation, interaction-mode, option, feature, translation, capability, state, data, and permission compatibility; prove the candidate provider-credential directory maps every ordinary reachable connection/auth contract to exactly one nonempty set and every stable creator/state/reconciliation continuity requirement through its high-water to either a currently certified successor entry or exact historical slot with the required normal/incident lifecycle authorization;
6. expand and cycle-check any private route fragments, then prove the runtime DAG contains no logical-model or route targets;
7. expand every principal/credential access-profile attachment into exact scoped policy attachments, validate policy precedence, and flag dead or contradictory rules;
8. compile route/resource/operation preflight manifests; prove terminal/mandatory-processor totality and exactly one resource-profile mapping for every concrete active subject/credential fingerprint plus each approved onboarding profile's named synthetic context, interaction mode, classifier output, and registered resource discriminator; validate issuance-template references statically because a template has no effective fingerprint;
9. verify price, data-handling, certification, and immutable model-release evidence for production targets;
10. reject every mutable callable upstream selector in production; aliases may resolve discovery candidates only, and catalog drift never changes an active target in place;
11. deterministically emit a `StateRetirementImpactSet` naming canonical targets/components the candidate would remove, without reading live leases/ACK progress or mutating retirement state; the publication coordinator discovers affected lineages and reconciliation work from its transactionally consistent dual-lease snapshot and requires any invalidation approval;
12. verify every approved onboarding profile and issuance template references an available configurator plus exact policy versions that the candidate revision retains, or explicitly revoke/rebind affected issued credentials;
13. calculate a deterministic revision hash;
14. produce a compact immutable runtime snapshot and a human-readable impact diff.

The compiler is a pure plan operation over immutable inputs: the same inputs produce the same artifact, hash, and impact set. The publication coordinator separately performs retirement block/drain/lease-snapshot work, obtains a signed `StateRetentionGeneration`, stages compatible identity/provider-credential/narrowing generations, and activates the ACKed tuple. The data plane consumes only compiled snapshots plus the separately signed monotonic authorities. It should not interpret arbitrary database JSON or perform relational joins to discover policy during a request.

### 9.6 Custom OpenAI-compatible providers

Custom endpoints are important for self-hosted models and third-party vendors, but "OpenAI compatible" is a claim that needs certification.

Require:

- an approved provider-adapter type and endpoint allowlist;
- DNS/IP pinning and SSRF protection;
- TLS requirements;
- explicit native egress API wires, contract versions, and endpoint variants;
- credential/header schema with secret values stored outside ordinary rows;
- model discovery or manual model IDs;
- conformance tests for request, stream, error, usage, cancellation, and limits;
- `experimental` status until certified.

Do not allow arbitrary per-request base URLs or headers.

### 9.7 One runtime truth, multiple authoring paths

Proxy should support both:

- control-plane API and console authoring backed by the database;
- declarative TOML authoring for local configuration and GitOps.

It should not have two live configuration stores that the data plane merges on every request. That creates unresolved questions about precedence, partial updates, deletion, rollback, and what the console is actually showing.

The recommended model is:

```text
TOML source ----apply/reconcile----+
                                    |
Admin API / console ---------------+-> versioned database resources
                                         -> validate and compile
                                         -> published workspace revision
                                         -> data-plane in-memory snapshot
```

The database is the canonical materialized control-plane state and version history. For a resource declared as file-managed, the TOML source remains its management authority. The data plane consumes only the published compiled revision and never reads or merges TOML directly.

### 9.8 TOML is a declarative resource format

The TOML format should describe the same typed resources exposed through the administrative API:

- provider connections for stable upstream account/project/network identity;
- immutable provider credential slot/set versions using exact secret versions or versioned workload-identity contracts;
- processor connectors and processor profiles;
- model deployments;
- resource profiles for model-less provider-resource creation;
- direct, pooled, and routed logical models;
- routes and fallback behavior;
- onboarding profiles that reference code-owned harness configurator manifests;
- credential issuance templates that reference an exact access profile and optional exact narrowing-policy versions;
- access profiles containing policy-version references, with principal/credential attachments represented as separate scoped resources;
- parameter, limit, budget, capture, and cache policies;
- workspace publication settings.

Illustrative configuration:

```toml
schema_version = 1
source_id = "git:ai-platform/proxy-config"
workspace = "valuation-production"

[[connections]]
id = "openai-production"
provider_adapter = "openai"
account = "opendoor-production"
enabled_auth_contracts = ["openai-bearer-v1"]

[[provider_credential_slots]]
id = "openai-production-primary"
version = 1
connection = "openai-production"
auth_method = "bearer"
secret_ref = "aws-secretsmanager://ai/openai-production?version_id=7f53c2"
expected_account = "opendoor-production"
credential_scope = "responses-and-files"

[[provider_credential_set_versions]]
id = "openai-production-credentials-v1"
connection = "openai-production"
auth_contract = "openai-bearer-v1"
strategy = "ordered"
slots = ["openai-production-primary@1"]

[[deployments]]
id = "openai-gpt-54"
connection = "openai-production"
canonical_model = "openai/gpt-5.4"
upstream_model = "gpt-5.4"

[[deployments.wire_bindings]]
wire = "openai.responses"
contract_version = "v1"
required_auth_contract = "openai-bearer-v1"

[[resource_profiles]]
id = "openai-files-production"
operation = "file.create@v1"
resource_kind = "file"
purposes = ["responses_input"]
compatible_logical_models = ["openai/gpt-5.4"]
maximum_bytes = 10485760
retention_seconds = 86400

[[resource_profiles.targets]]
id = "openai-files-us"
connection = "openai-production"
required_auth_contract = "openai-bearer-v1"
endpoint_variant = "files"
egress_wire = "openai.files@v1"
state_mapping_certification = "openai-files-v1"
compatible_deployments = ["openai-gpt-54"]
response_safety_profile = "bounded-json-resource-v1"

[[access_profiles]]
id = "employee-standard"
policy_version_refs = [
  "production-models-v1",
  "standard-operations-v1",
  "internal-data-v1",
  "employee-budget-v1",
]

[[access_profile_attachments]]
id = "valuation-service-employee-standard"
access_profile = "employee-standard"
scope = { kind = "principal", id = "valuation-service" }

[[logical_models]]
id = "openai/gpt-5.4"
kind = "direct"
deployment = "openai-gpt-54"
ingress_wires = [
  { wire = "openai.responses", contract_version = "v1" },
]

[[logical_models]]
id = "opendoor/text-default"
kind = "route"
route = "text-default"
ingress_wires = [
  { wire = "openai.responses", contract_version = "v1" },
  { wire = "anthropic.messages", contract_version = "2023-06-01" },
]

[routes.text-default]
root = "fallback"

[routes.text-default.nodes.fallback]
kind = "fallback"
children = ["openai", "anthropic"]
on = ["rate_limited", "upstream_unavailable"]

[routes.text-default.nodes.openai]
kind = "target"
selector = { canonical_model = "openai/gpt-5.4" }

[routes.text-default.nodes.anthropic]
kind = "target"
selector = { canonical_model = "anthropic/claude-sonnet" }

[cache_policies.text-default]
mode = "off"

[[onboarding_profiles]]
id = "opendoor-engineering"
harness_configurators = ["codex", "claude-code"]
default_logical_model = "opendoor/coding-auto"
credential_issuance_template = "employee-standard"
synthetic_principal_context = { name = "employee-baseline", principal_type = "human", required_team_ids = ["employees"] }

[[onboarding_profiles]]
id = "external-coding"
harness_configurators = ["codex", "claude-code", "cowork"]
default_logical_model = "opendoor/coding-economy"
credential_issuance_template = "external-coding-economy"
synthetic_principal_context = { name = "sponsored-guest-baseline", principal_type = "sponsored_guest", required_attributes = ["sponsor_id", "access_expires_at"] }
```

This is abbreviated conceptual syntax, not the final schema; the second provider/deployment, referenced coding routes, policy documents, issuance templates, and lifecycle-only credential entries are omitted. The important properties are stable resource IDs, exact access/resource-profile references, explicit versions, a schema version, and no duplicate-name magic. The credential coordinator selects exactly one ordinary set version per reachable connection/auth contract and separately compiles stable-requirement-matched retained access using current successor certification or the required exact slot; every set lists exact slot-version references, and an implicit `current` secret or set is invalid. A real plan would reject the excerpt until all references resolve.

Workspace TOML deployments reference approved immutable canonical catalog IDs; they cannot redefine model-maker facts, lifecycle, capabilities, or provenance. A separately authorized catalog source/import may propose custom internal releases, but catalog approval precedes workspace publication and has its own ownership/history.

Operation, wire, and harness-configurator IDs in TOML must resolve to code-owned registries. SDK compatibility profiles are release evidence, not onboarding clients or configurable resources; application SDK onboarding remains base URL, credential, and logical model. TOML cannot invent an operation lifecycle, public path, schema, codec, translation function, config serializer, processor schema, or executable adapter. Raw gateway or provider keys never belong in TOML. A static provider credential slot uses an exact immutable secret version, while a workload slot uses a versioned trust/permission contract; mutable aliases such as `env://NAME` are development-only and cannot enter a production directory generation. The stable connection contains neither the reference nor slot-selection policy. A target may reference an approved provider-state-continuity certification, but TOML cannot assert successor access or manufacture certification evidence. TOML may declare a credential issuance template with one exact access profile, optional exact narrowing policies, and principal constraints, but generated gateway credentials are created and rotated only through authenticated credential APIs; TOML cannot contain or recover the token value.

### 9.9 Reconciliation and resource ownership

Every managed resource records:

- `managedBy`: `control_plane` or `declarative_source`;
- stable `sourceId` for file-managed resources;
- source generation or Git commit when available;
- normalized specification hash;
- last successful reconciliation and published revision;
- actor or workload that applied it.

The rules are:

1. A TOML apply parses, validates, resolves references, calculates a diff, compiles the candidate workspace revision, and commits all resource versions transactionally. Invalid input changes nothing.
2. A file-managed resource is read-only in the console. The UI may show its effective configuration, source, diff, and history, but ordinary edits are rejected.
3. A database-managed resource may coexist with file-managed resources when IDs do not collide.
4. If a file declares an ID owned by the control plane or another source, reconciliation fails instead of silently overriding it.
5. Moving a resource between ownership modes is an explicit adopt/release operation with an impact diff. It is not automatic.
6. Removing a resource from a file deletes or disables it only when prune semantics are explicitly enabled for that source. Safety checks reject deletion while published logical models or policies still reference it.
7. Concurrent applies use optimistic revision checks so one source cannot unknowingly overwrite a newer workspace draft.
8. Publication may be automatic for approved non-production sources or require review for production. Apply and publish remain separate lifecycle events even when one command requests both.

This is reconciliation, not bidirectional synchronization.

### 9.10 Plan, apply, import, and export semantics

The control plane should offer four operations independent of the eventual CLI spelling:

- **Plan:** validate a TOML source and return the resource, policy, model-visibility, provider-path, and workspace-revision diff without mutation.
- **Apply:** create immutable resource versions and a candidate workspace revision, optionally requesting publication under normal approval policy.
- **Import:** bring a TOML document into database ownership as a one-time operation. Later file changes have no effect.
- **Export:** emit a redacted TOML snapshot of database-managed declarative resources for review or bootstrap.

Export is not a safe automatic reverse sync. Secret values are intentionally unavailable, comments cannot be reconstructed, and another writer may modify the file. Continuous database-to-file writes would create conflict loops and unsafe commits. Teams wanting Git as the authority should edit Git and let a reconciler apply it; teams wanting the console as the authority should use database-managed resources and treat exports as snapshots.

### 9.11 Local development and production GitOps

For local development, a control-plane process may accept a configured TOML path, reconcile it into the local database, compile it, and publish it at startup. This keeps setup simple without adding a second runtime code path.

In production:

- only a designated control-plane reconciler reads Git, a ConfigMap, or an approved configuration artifact;
- data-plane replicas never watch files or write configuration rows;
- a failed reconciliation leaves the last published revision active and reports a visible error;
- the applied source hash and Git commit are attached to the workspace revision;
- emergency narrowing/revocation remains available outside the normal Git publication cycle.

### 9.12 Lesson from LiteLLM configuration

LiteLLM demonstrates the desired application behavior: a simple [`model_list`](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/proxy/example_config_yaml/simple_config.yaml) exposes a direct model, while repeated `model_name` entries create a load-balanced group in its [load-balancer example](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/proxy/example_config_yaml/load_balancer.yaml). It also has a [`store_model_in_db`](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/proxy/_types.py#L2395-L2401) mode and code paths that combine or override file and database objects.

Proxy should retain the direct-versus-routed user experience but make grouping, ownership, precedence, and publication explicit. A duplicate logical model ID is a validation error, not an implicit router declaration.

## 10. Organizations, Teams, Roles, and Model Access

### 10.1 Separate four identity questions

The gateway must answer four different questions that should not share one `role` field:

1. **Who is administering the control plane?** A human authenticated through the company identity provider.
2. **Which workload is making an inference request?** A service account, workload identity, human principal, or API credential.
3. **Which end user or business action should receive attribution?** Trusted request metadata, not an independently authorized gateway principal unless explicitly configured.
4. **What is each identity allowed to do?** Control-plane RBAC plus data-plane entitlements and policy.

Conflating these leads to common failures: application end-user IDs being trusted as authorization, API keys inheriting administrator permissions, and team membership being treated as tenancy.

### 10.2 Tenancy and organizational hierarchy

Recommended hierarchy:

- **Organization:** hard tenant boundary, provider-connection owner, top-level policy and budget boundary.
- **Workspace:** application/environment traffic boundary, logical-model namespace, configuration publication unit, cost-center and operational owner.
- **Team:** IdP/SCIM-backed many-to-many group used for administration and entitlement binding. A team is not a tenant and can span workspaces through explicit grants.
- **Principal:** a human or service/workload identity that can hold roles or entitlements.
- **Credential:** a revocable authentication mechanism bound to exactly one organization, workspace, and principal, with optional narrower restrictions.
- **Attributed end user:** an application-supplied identifier recorded for limits or analytics only when the calling principal is trusted to assert it.

Every data-plane request must derive organization and workspace from authenticated state. A caller-provided organization or workspace header cannot switch tenancy.

### 10.3 Control-plane RBAC

Keep a small role vocabulary and express scope separately. Recommended permissions include:

- organization owner;
- security administrator;
- model/provider administrator;
- workspace administrator;
- finance/usage administrator;
- operator/support investigator;
- auditor/read-only viewer.

Roles grant control-plane actions such as creating a connection, rotating a secret, publishing a route, binding a policy, viewing raw capture, or exporting usage. They do not automatically grant the right to call every logical model.

A single user can have different roles in different workspaces. Sensitive permissions such as provider-secret management, raw-prompt access, policy publication, and audit export should be separately assignable rather than implied by a broad `admin` role.

### 10.4 Data-plane principals and credentials

Support these principal types:

- **Service account:** stable application identity owned by a team, with workspace grants and an optional principal-scoped access-profile attachment.
- **Workload identity:** short-lived OIDC/JWT, cloud IAM, SPIFFE, or Kubernetes identity mapped to a service account. Preferred for production.
- **Human principal:** useful for interactive tools and local development, authenticated through a short-lived token or constrained key.
- **System principal:** tightly scoped gateway jobs such as discovery or health checks.

Credentials include:

- hashed API keys for compatibility;
- short-lived signed access tokens;
- workload identity federation;
- development-only local credentials if explicitly enabled.

An API key record stores only its hash, prefix, principal/workspace binding, expiration, status, last use, issuance-template version, issuing workspace revision, exact access-profile version, the profile's fully expanded credential-scoped policy attachments, effective-policy fingerprint, and immutable restrictions. It never stores provider credentials. Signed-token claims carry an equivalent grant snapshot or reference a directory entry with those facts. A template is consulted only during issuance; editing it or its access profile cannot mutate an existing credential's authority.

### 10.5 Access profiles and typed policies

The existing [model access profile plan](../scopes/model-access-profiles-v1/PLAN.md) is directionally correct but should be generalized beyond model IDs. Use versioned typed policies and bindings instead of duplicating fields on users, teams, workspaces, and keys. An **access profile** is a workspace-owned, immutable, versioned runtime resource containing only exact typed policy-version references for reuse across principals or credentials. It follows draft, approved, published, superseded, and retired lifecycle states, is included by exact version in the workspace revision, and is managed through the same DB/API or TOML ownership model as policies. It is not another policy language, binding container, or mutable list of model strings.

Attaching a profile to a principal or credential supplies one explicit scope for every referenced policy. The compiler expands that attachment into records such as `(policyVersionId, scopeKind, scopeId, sourceAccessProfileVersionId)` before composing mandatory scopes and records the profile ID/version only as provenance. Organization, workspace, team, and logical-model policy bindings are never smuggled through a profile. Issuance persists the expanded credential-scoped attachments, so superseding or retiring a profile affects future issuance and new attachments only; active credentials are explicitly rebound or revoked rather than reinterpreted.

Recommended policy kinds are:

- `model_access`: allowed/denied logical models, model tags, makers, capability classes, and lifecycle states;
- `operation_access`: allowed operations, API wires, interaction modes, and closed-world streaming/session-event/job actions;
- `provider_access`: allowed/denied providers, connections, deployment tags, regions, and self-hosted/external classes;
- `state_access`: allowed resource kinds and actions plus sharing and descendant-creation bounds;
- `resource_access`: allowed workspace resource-profile versions, registered resource kinds/purposes, creation actions, and resulting-state compatibility bounds;
- `processor_access`: parent-principal `processor.invoke` grants for exact processor-profile versions and purposes, bindable to a parent logical model/route/guardrail policy and never directly caller-invocable;
- `processor_target_access`: gateway processor-service-principal `processor.execute` grants for an exact profile version and exact hidden deployment-wire-binding or processor-connector version, constrained by parent policy-fingerprint target class and maximum exposure;
- `data_handling`: permitted data classifications, retention modes, training policy, residency, and network boundary;
- `parameter_policy`: defaults, caps, forced values, and forbidden features;
- `rate_limit`: requests, tokens, bytes, concurrency, and async jobs per window, each with a firm or operational enforcement class; operational rules declare `fail_closed` or a compiler-proven bounded-degradation allocation/overshoot contract;
- `budget`: spend limits, warning thresholds, exhaustion behavior, billing-lifecycle applicability, and firm or operational enforcement class;
- `capture`: body retention, redaction, sampling, destinations, and access;
- `guardrail`: ordered input/output checks and failure behavior.

Bindings attach policy versions to organization, workspace, team, principal, credential, or logical model scopes. The compiler reduces them to one deterministic effective policy for runtime.

Production policy is closed-world and default-deny. A request needs a positive effective grant for its logical model when the operation uses one, operation, ingress wire, interaction mode, terminal provider/deployment class, every state-resource action, and any workspace resource profile used for model-less creation. An internal child additionally needs parent `processor.invoke` for its exact profile and service-principal `processor.execute` for that profile's exact hidden deployment-wire-binding or connector version. Publication, discovery, state retention, or membership in a workspace is not a grant. A new model, wire, operation, deployment, resource profile, processor, or registered extension remains unusable until an approved policy version includes it. Explicit deny wins at every scope.

Development may use a broad grant only as an explicit, versioned policy restricted to a non-production workspace and non-production connections. There is no implicit allow-all fallback when policy is absent, contradictory, stale, or unknown.

### 10.6 Allowed-model semantics

Avoid a lone `allowed_models` string array. Enterprise model access needs selectors and exceptions.

Examples:

- allow logical models tagged `production-approved`;
- deny preview or retired lifecycle states;
- allow embeddings to a broad team but text generation only to a named service account;
- allow external providers only for `internal` data and route `restricted` data to approved Bedrock deployments;
- allow models below a cost band for development workspaces;
- allow a direct pinned model but deny classifier-driven meta-routes;
- deny image or audio operations even if the same provider connection supports them.

Policies should compile selectors to concrete logical-model and deployment IDs in a workspace revision. Runtime evaluation should not search arbitrary tag expressions against live database rows.

### 10.7 Team and principal composition

Recommended rules:

- organization and workspace policies are mandatory intersections;
- grants from multiple teams may union within that boundary;
- explicit deny at any mandatory scope wins;
- principal-specific policy may narrow or add a grant only when the workspace permits delegated grants;
- credential policy can only narrow its principal;
- caller request preferences can only narrow the effective candidate set;
- end-user attribution never expands authorization.

The decision evidence should name each policy version that contributed a grant, restriction, or denial.

### 10.8 Enterprise identity roadmap

Production readiness should include:

- OIDC/SAML SSO for control-plane users;
- SCIM synchronization for users and teams;
- workload identity federation for production services;
- short key expiration and rotation for compatibility credentials;
- immediate revocation propagation;
- break-glass access with reason, expiration, and audit;
- service-account ownership and periodic review;
- automatic deactivation when owners or teams disappear;
- sponsored guest/partner identity, owner, expiry, and periodic access review for external engineers;
- separate raw-data-view and configuration-publish permissions.

Do not build a bespoke identity provider. Integrate the company IdP and cloud identity systems.

### 10.9 Data-plane identity and credential authority

Authentication and authorization-subject state changes more often and has different failure semantics than model routing configuration. Distribute a separately versioned, signed **identity and credential directory** rather than querying Postgres on every request or treating a successful lookup as indefinitely cacheable. The workspace snapshot owns compiled policy rules; this directory supplies the authoritative principal facts those rules evaluate.

The directory contains no raw bearer secrets. It carries:

- API-key ID/prefix and verification digest, organization/workspace/principal binding, compiled monotonic restrictions, status, activation, and expiry;
- the issued credential's template version, issuing workspace revision, exact access-profile version, fully expanded credential-scoped policy attachments, exact narrowing-policy versions, effective-policy fingerprint, and immutable grant restrictions;
- approved JWT/OIDC issuers, audiences, trust-key versions, subject/service-account mappings, maximum token age, and revocation identifiers;
- workload/mTLS trust bundles and identity mappings where enabled;
- principal status, workspace grants, authoritative team memberships, delegated-grant attributes, and their source generation;
- an effective-policy fingerprint plus baseline logical-model totality/availability bitmap compiled against each compatible active workspace revision;
- its generation, signature, issued/expiry timestamps, and the compatible workspace-policy references needed to evaluate restrictions.

Credential create/rotate/disable, principal deactivation, team membership, and workspace-grant transactions emit directory changes through a durable publication path. Issuance resolves the exact template references against the active revision, reauthorizes the actor and subject, computes the grant snapshot, and refuses a TTL or authentication form outside the template. A new credential or broader membership/grant is not reported active until the required data-plane ring has ACKed the granting generation. Workspace activation likewise co-stages compatible fingerprints/availability for active subjects before its activation record; it cannot silently substitute new policy versions for an issued credential's persisted scoped attachments. The raw token exists only in the authenticated issuance process's bounded memory while its verifier is published; ACK returns it once, while timeout/failure revokes the pending record and discards the token. It is never persisted or recoverable. Credential disable, principal deactivation, membership removal, workspace removal, and compromise events enter the high-priority narrowing overlay immediately, then publish recomputed fingerprints; a replica cannot continue honoring an older positive record beyond the production freshness bound. Local expiry is always enforced, unknown credentials always fail, and a replica with no verified directory is not ready for inference.

API-key verification uses the prefix only for bounded lookup and compares the stored verifier in constant time. JWT and workload identities require signature, issuer, audience, time, and subject mapping validation before they become a principal. The data plane never falls back to a caller-supplied organization/workspace or an old successful authentication when directory or revocation state is unavailable.

## 11. Limits, Budgets, Pricing, and Cost Attribution

### 11.1 Current limitation

The existing in-process limit maps are useful for local validation but cannot enforce organization-wide limits across replicas, regions, or restarts. Dividing a configured limit by replica count is not correct under uneven traffic, autoscaling, or failover.

Every limit policy declares one enforcement class:

- **Firm:** admission may not exceed the configured bound under replica loss, failover, or partition. It requires a linearizable authority or fenced, non-overlapping regional allocations whose combined capacity is no greater than the bound.
- **Operational:** the limit protects availability, abuse posture, or upstream capacity with a documented finite maximum overshoot during propagation and dependency failover. It declares `fail_closed` or a concrete `bounded_degrade` allocation contract; the UI and evidence must not describe it as exact.

Security, contractual, and spend rules that depend on a true ceiling use `firm`. Pre-auth source throttles and most adaptive provider-health controls are operational. A policy cannot silently downgrade from firm to operational when its authority is unavailable.

`bounded_degrade` is not arbitrary fail-open behavior. Before an outage, the shared authority issues signed, fenced, non-overlapping per-ring or per-replica capacity allocations with an absolute trusted-time expiry under a frozen membership epoch. Their sum is no greater than the configured limit plus its declared overshoot, and they cannot be renewed or replenished while the authority is unavailable. A compiler/simulator must prove that bound for the maximum fleet membership; otherwise publication rejects `bounded_degrade` and the policy must fail closed.

### 11.2 Limit dimensions

The policy system should support:

- requests per second/minute/day;
- input, output, cached, reasoning, image, audio, or other billable units per window;
- concurrent requests and concurrent streams;
- concurrent realtime sessions;
- queued requests or jobs;
- spend per request/day/month/custom period;
- provider-connection or deployment quota headroom;
- limits scoped to organization, workspace, team, principal, credential, end-user attribution, logical model, provider connection, or deployment.

Not every combination should be enabled by default. The compiler should reject excessive cardinality, an unsupported enforcement class, or cross-region precision the selected authority cannot prove.

### 11.3 Admission reservation and settlement

Usage and budget enforcement should follow a reservation model:

1. Compile firm ceilings for total attempts, total output, wall-clock time, and every applicable cumulative spend rule, including organization/workspace/team/principal/credential/cost-center intersections and classifier or remote-guardrail child calls. Each budget keeps its own authority, scope, currency, periods or attribution contract, and reservation ledger. Bind the operation's `request_terminal` or `resource_terminal` lifecycle requirements and immutable request deadline, but do not choose a target-specific cost plan in common admission.
2. For each billable request-terminal processor or provider candidate, evaluate its certified worst-case estimator against approved price/FX inputs and persist one bounded `CanonicalRequestCostValuation` in provider and accounting currencies, owned by the exact decision or processor intent even when no budget applies. For resource-terminal work, compile one immutable `ResourceCostPlan` per eligible operation/target pair and carry its exact reference on that candidate. A firm plan contains provider/contract-backed relative bounds, a certified maximum-exposure estimator, and a valuation-selection contract; an operational plan contains relative authorized-use/cleanup bounds, initial funded forecast, rolling valuation/reservation policy, and explicit overrun semantics. Resource preflight emits one bounded expiring valuation quote per normalized eligible candidate, scoped to organization/workspace, an existing decision header, exact resolution/transformation-bound candidate set/evaluation, operation/preflight versions, target, and estimator-input digest. Every request/resource valuation persists separate provider-charge and accounting-currency maximum or forecast amounts plus exact same-currency/FX schedule, observation interval, rounding, and price provenance regardless of budget policy.
3. For each canonical cost subject and applicable rule/authority/scope/target-currency tuple, first persist one signed `BudgetActualCostSourceContract` before period partitioning. It selects provider charge or accounting cost, pins one code-owned `CanonicalActualCostEvidenceMappingManifest` version, and carries the digest of all eligible slices. Expand the rule over the work's full trusted time horizon. A finite-window rule produces one `RequestBudgetCommitmentQuote` or resource commitment **per intersecting period**; a lifetime/contract rule produces one permitted attribution slice. Every slice references that shared contract and the canonical cost valuation it converts or constrains, and persists one `BudgetCurrencyConversion` with the selected provider/accounting/contract source component and amount, budget target currency and amount, exact same-currency or FX schedule/observation, rounding policy, and immutable owner-discriminated `BudgetSettlementConversionAuthoritySet`. Provider-charge or accounting-cost admission selects that same component for actuals, while a contractual maximum selects exactly one actual component. Authority entries may cover multiple currencies or governed schedule versions but only for the contract-selected component; entries for its alternative component are invalid. Request work names its exact request; an operational lifecycle quote preallocates its funding-admission ID and names the exact obligation, lifecycle quote set, and admission, with every request-owner field structurally null. Seal one `BudgetQuoteSet` whose nonempty members bijectively equal the resulting rule/authority/scope/currency/period-or-contract slice set; its empty form carries signed rule- and slice-set digests, never a zero-valued synthetic commitment. The compiler emits the exact funding-plan ID/hash, operand set, mutual-exclusion groups, operator topology, and cardinalities inside preflight. Build a root `BudgetEnvelope` by deterministically instantiating that plan. Each nonempty slice member contains a signed root-reachable funding-expression tree: leaf operands bijectively pin exact quote-set members and conversions, `maximum` nodes retain mutually exclusive alternatives, and `sum` nodes combine mandatory work. The root expression derives the held amount, while separate spendable and contingent-shared values ensure an available maximum is held but cannot authorize dispatch; an aggregate never claims one source amount, currency, FX observation, or rounding result. Signed immutable compare-and-swap snapshots track those values plus allocation/settlement pointwise for each slice. The conservative initial vector is all mandatory processor maxima after certified cardinality/transformation expansion plus the maximum reachable initial-attempt commitment for that same slice; it never collapses period boundaries, currencies, or scopes. A direct/state-bound request uses its exact target vector, a resource-create request uses per-slice maxima across candidates, and a no-budget request carries the signed empty proof. Cache-eligible routes initially hold only mandatory pre-cache slices and enlarge after a miss; cache-ineligible/state-bound requests commit full snapshots before their first remote child.
4. Give each processor invocation a closed child `BudgetEnvelope` whose initial snapshot contains an operator-preserving allocation tree over the exact parent expression, pins the parent funding-derivation ID/hash, or inherits the identical empty-set proof. A `sum` allocation combines its child capacity additively. An available `maximum` allocation keeps every alternative under one parent shared-capacity ledger and records its maximum as contingent rather than spendable. Lease acquisition selects a stable logical child/route-branch reservation, closes only competing branch reservations for that epoch, and appends a signed snapshot that moves the selected branch into spendable capacity. The branch lease outlives individual network attempts. Every provider attempt receives one fresh subordinate `BudgetMaximumBranchAttemptAllocation`, reservation commitment, and once-consumed `ProviderAttemptAdmission` binding fresh runtime, credential eligibility/quota, canonical cost, budget admission, and dispatch intent. Its `BudgetAttemptAdmission` is bound to the exact selection, attempt admission, quote set, current envelope snapshot, spendable amount, active logical lease version, and subordinate allocation. A nonempty admission owns a request-envelope-sourced `BudgetReservationBundle` containing every matching slice, exact budget conversion, shared source contract, and branch allocation lineage and atomically draws down the envelope; an empty admission owns the identical signed proof. The initial selection, branch-lease/snapshot transition, subordinate allocation, open provider-attempt progress root, provider-attempt admission, budget admission, and ready dispatch authority commit in one serializable transaction. A connector and each lifecycle reconciliation request create equivalent request-terminal budget ownership. A later resource-lifecycle continuation instead preallocates one funding-admission ID and atomically creates an owner-discriminated conversion-authority set and reservation bundle that name the exact obligation, lifecycle quote set, admission/allocation, and continuation epoch and have `requestId: null`. A child, attempt, reconciliation poll, or lifecycle continuation cannot spend outside any slice or reuse another owner's authority.
5. Before every same-target retry, credential retry, deployment failover, or model fallback, consume the current open attempt-progress epoch and the preceding subordinate allocation disposition; freshly evaluate health, circuit, capacity, concurrency, quota, narrowing, credential eligibility and credential quota; compare-and-swap the lease, ledger, and envelope heads; and atomically create a new provider-attempt admission, subordinate allocation, complete budget admission, dispatch intent, and ready dispatch authority while installing them as the new progress head. Same-target retry keeps the logical branch lease active. Definitive no-charge advances its version in the same funding plan and creates a fresh attempt allocation. A partial, full, or indeterminate retained charge requires one signed slice-complete `BudgetFundingPlanReadmissionBundle`; each member's evidence-bound retained-charge operands, carried preflight quote operands, and freshly admitted retry quote operands deterministically produce `sum(retained_charge, max(same_branch_retry, remaining_branches))`. Bundle slice digest, current policy/preflight authorization, complete admitted quote-set digest, exact remaining inputs, code-owned transformation version, successor topology/hash, snapshot CAS, and incremental headroom must all match before any lease continues into a successor ledger. Fallback instead closes predecessor progress and disposes the logical lease while creating successor selection/progress in the same transaction. No-charge fallback closes the selected input and reopens the remaining siblings. Chargeable fallback uses the same signed readmission bundle for `sum(retained_charge, max(remaining_branches))`, after which a different logical branch may lease the successor choice. In those formulas, a one-input choice compiles directly to that branch with no unary `maximum` or shared ledger; two or more inputs compile to a true `maximum`. Terminalization disposes the current lease without fallback. The compiled total-attempt bound and every slice's remaining headroom apply to the cumulative attempt chain. Retry, fallback, and terminalization race on the same progress, allocation, lease-version, ledger, derivation, and snapshot epochs; exactly one can win. If any authority cannot admit a slice, commit none and stop. A transformation that changes estimator input, processor input, candidate, cost valuation, or quote context invalidates prior authority and must replace/enlarge affected slices before work continues. After routing makes branches impossible, release only unused slice portions; retain each admitted allocation until its outcome is known.
6. Persist canonical request-cost settlement for every billable request-terminal child/attempt/connector regardless of budget presence. A delayed invoice, credit, restatement, tax, or fee for that work appends one signed `CanonicalRequestCostCorrection` rooted at the original request settlement and valuation; its unique predecessor chain binds the request, invoice line/evidence, optional usage item, provider/accounting currencies, conversion, signed positive or negative deltas, price provenance, and sequence without rewriting the original. It never fabricates a resource obligation or reuses the resource-only invoice-adjustment path. Before any period allocation, evaluate the shared source contract through its exact code-owned mapping manifest and persist signed `BudgetActualCostSourceEvidence` for the original settlement or each correction, binding the contract/hash, mapping ID/version/implementation hash, canonical source fingerprint, target and valuation, usage or invoice lineage, selected component/currency/amount, and exact correction predecessor. Then create exactly one signed `CanonicalBudgetActualCostSourceSelection` for `(canonical source, contract, rule, authority, scope, target currency)`, independently of any reservation. Its source-group key and relational uniqueness prevent provider-charge and accounting-cost representations of one canonical charge or correction from both being selected across monthly or other slice boundaries. One `CanonicalBudgetCostAttribution` references that selection and exactly partitions its parent amount across the complete eligible reservation/slice set. Separately settle every child-envelope and provider-attempt slice using its unique attribution component, including failed, cancelled, timed-out, and indeterminate attempts when the provider may charge them. Each signed budget settlement retains the reservation's admitted maximum/forecast conversion separately, binds the exact source selection/evidence plus original request settlement, request-cost correction, provider-cost settlement, or resource invoice-adjustment liability component and one attributed slice component, and stores a recomputable actual conversion whose source matches the contract. The exact authority set may contain entries only for the selected source. Signed settled and overrun deltas sum to each component's target-budget amount; every later positive or negative request/resource correction creates a new evidence/selection/attribution/settlement chain linked to its predecessor without rewriting history. Source-selection uniqueness prevents cross-slice double debit; component-set partition constraints prevent duplicating or omitting a charge across periods; unique component consumption prevents replay. Each settlement compare-and-swap advances the envelope's settlement high-water, and period-boundary settlement/release can never be satisfied by an aggregate across periods.
7. Release unused allocation only after the attempt outcome and chargeability are known, or retain it as pending usage until reconciliation resolves an ambiguous outcome. Definitive nonacceptance of a provider side effect is not by itself no-charge evidence. A parent envelope cannot close while a child envelope or attempt allocation remains live.
8. For `request_terminal` work, settle every canonical request cost and every present period/contract slice through the final envelope snapshot or preserve the empty-set proof. For firm `resource_terminal` work, atomically transfer the attempt exposure's complete remaining lifecycle slices or empty coverage to the durable resource-cost obligation described below; for operational resource work, activate its rolling sliced obligation or empty coverage chain. Canonical provider-cost valuation and settlement continue in both variants. Neither public handle nor parent envelope can close first.
9. Reconcile delayed provider invoices and corrections with append-only liability components, a new signed canonical attribution whose components exactly partition that correction within each budget contract, and one component-unique budget settlement per affected slice rather than rewriting history.

This prevents concurrent requests from collectively overspending any intersecting budget and prevents a cheap first target from opening an unreserved expensive fallback chain. A route cannot override one budget because another has headroom, borrow next month's headroom for the current month, convert all rules into a single convenient currency, or choose one attribution mode for incompatible scopes. Fallback stops with a budget-exhausted error if any mandatory slice fails rather than dispatching a partially reserved attempt.

For limits that cannot be estimated accurately, policy chooses among conservative reservation, queueing, denial, or operational enforcement. The behavior must be visible to the caller and evidence; an operational estimate cannot satisfy a firm budget.

### 11.4 Resource-terminal billing lifecycle

`request_terminal` means all provider-billable exposure created by the operation ends no later than the immutable request deadline. `resource_terminal` means an async job, stored file, batch, session, or other provider resource can keep accruing compute, storage, or service charges after its handle is returned.

Each resource-terminal operation/target pair plus its applicable deployment/state-mapping or resource-profile contract resolves one immutable versioned `ResourceCostPlan` with the canonical execution target, approved provider/accounting valuation policy, size/output bounds, billable unit set, terminal actions, relative expiry behavior, and cost-estimation contract. A firm plan additionally requires a finite provider/contract-backed maximum lifetime or charge plus a certified worst-case estimator. An operational plan instead declares relative authorized-use, cleanup, and initial-funded-interval durations plus rolling valuation/reservation and overrun policies; it contains no request-computed money. Its accounting horizon stays open until provider terminal evidence. A gateway deletion timer, lifecycle worker, or configured retention period alone is operational and cannot establish a firm maximum. Every per-candidate quote and valuation epoch records separate plan-subtype-matched provider-charge and accounting-currency amounts with exact FX/rounding provenance. Separately, its closed budget coverage applies the exact normalized request size/effective transformed-input snapshot and approved valuation policy to every mandatory period/contract slice or carries a signed empty-set proof. Same-currency, converted-currency, and contractual budget valuations may coexist as distinct commitments, but each carries a reproducible source-to-budget conversion through quote, reservation, epoch, and settlement. Selection verifies the live request/decision/current-candidate/effective-resolution/target bindings and atomically creates the initial attempt admission plus canonical valuation epoch; no-budget coverage omits reservations but never either canonical amount, provider liability, usage, or invoice accounting. Any transformation that changes estimator inputs increments the transformation epoch, appends a resolution-bound candidate-set readmission epoch, and invalidates every earlier quote.

For a firm-eligible target, each attempt-scoped prepared exposure records a trusted lifecycle-exposure start no later than that attempt's dispatch. A provider-enforced-expiry plan computes an absolute billing-horizon end, and the attempt's initial epoch contains one budget commitment slice for every intersecting finite period of each rule, using exact price schedules plus FX only when that slice requires conversion. A contract-charge-cap plan pins the approved contractual-maximum version and reserves the full cap independently in every intersecting budget. Each commitment is firm only when that rule uses a lifetime/non-resetting authority or one finite admission-period slice whose approved attribution contract treats the full cap as incurred there and assigns all later actuals/corrections to that period. If one mandatory slice is incompatible, the entire target is operational only when policy permits that classification, otherwise denied. Accounting/reconciliation remains open until terminal evidence even though spend is bounded. A target without complete upstream bound, canonical provider valuation, sliced budget valuation/attribution, reservation, and reconciliation semantics is ineligible for a firm request.

Target selection atomically pins only the canonical target, parent decision, current eligible candidate/set and `ExecutionSelectionAdmission`, and immutable `ResourceCostPlanRef`. Exactly one initial transition exists per decision; every fallback is a same-decision higher-epoch compare-and-swap continuation consuming another fresh selection. Each actual resource-terminal network attempt then owns a fresh `ProviderAttemptAdmission`, `BudgetAttemptAdmission`, and dispatch intent. Its pre-dispatch barrier creates a durable **prepared resource-cost exposure** containing attempt/attempt-admission IDs, trusted lifecycle start, request-bound valuation quote, initial valuation epoch, canonical provider/accounting valuation, binding/idempotency/provider outcome, exact sliced budget coverage, and attempt-specific reconciliation lease. For a firm resource, every present slice covers both pre-response work and that slice's post-response quote maximum; an empty budget set still carries both canonical maximums and their conversion provenance. Definitive nonacceptance aborts only that exposure. A same-target retry creates a new exposure and initial epoch, so it cannot inherit the aborted attempt's quote, reservation, or lifecycle start.

Exactly one fenced transaction consumes the prepared exposure. Provider success plus binding activation transfers it to a binding-owned **resource-cost obligation** and records authoritative activation time. Ambiguous acceptance, missing/invalid provider identity, or any failure after a resource may exist transfers it to a typed **orphan resource-cost obligation** and orphan provider-resource record instead. The orphan variant retains the same attempt exposure, initial epoch/sliced commitment bundle, provider outcome, reconciliation lease, and provider-expiry/contract-cap/operational terms; operational orphans append funded epochs and report provider plus per-slice settlement/overrun until cleanup. When certified reconciliation later proves the original resource identity, a single serializable transfer changes that orphan to `transferred_to_active`, changes the orphan provider resource to `recovered_to_active`, creates exactly one active successor for the same exposure, atomically moves reconciliation-lease ownership, creates the state-retention lease, and advances the binding from `reconciling` to `active`. Unique predecessor, successor, exposure, and lease-owner constraints make that transition one-shot; no active and orphan current owner can coexist. Definitive nonacceptance may abort the resource-lifecycle exposure and release its lease, but each slice first settles any chargeable request portion and releases only the proven-unused remainder. There is no state in which a possibly billable resource is owned only by a selected target, terminal request, or tombstoned binding.

The active or orphan obligation references the immutable attempt-scoped exposure, which in turn owns selected target/plan, attempt runtime, lifecycle start, initial valuation, dispatch, and budget authority. Its current valuation epoch always owns canonical provider-charge and accounting-currency valuation with conversion provenance and independently owns identical complete-or-empty sliced budget coverage. The obligation adds its typed owner, activation/ownership time, append-only liability-projection components, provider settlements, closed per-slice settlement or empty-set projection, and either an absolute provider-expiry horizon, contract-cap terminal-accounting terms, or operational authorized-use/cleanup deadlines. Each valuation epoch or invoice adjustment contributes one immutable provider/accounting-currency component with its own FX observation and rounding provenance; totals are grouped by currency and derived from the signed component chain and set digest, never represented beside one aggregate conversion. An orphan-to-active successor starts from the signed predecessor state hash and exact valuation, liability-component, lifecycle-funding, slice-transition, provider-settlement, budget-settlement, and invoice-adjustment high-waters; later appends belong only to the successor. Relational constraints force exposure, binding/orphan cost ownership, selected billing lifecycle, exact plan subtype, applicable rule/slice digests, every present initial reservation, obligation lifecycle terms, provider outcome, reconciliation-lease ownership, and both canonical valuation lineages to agree. The immutable plan remains derivation authority; computed money exists only in valuations, quotes, bundles, epochs, liability components, obligations, provider-cost settlements, and budget settlements and is never reconstructed after a crash. An obligation can transition from `active` or `indeterminate` to `settled` only with terminal provider/cleanup evidence, an atomically released reconciliation lease, and a signed settlement-completeness certificate proving provider usage/settlement, liability components, lifecycle-funding and slice-transition lineage, the exact expected budget-slice set including zero slices, and invoice-adjustment high-waters are complete. Returning a job or file handle does not release any cost obligation or reconciliation lease.

V1 places quote sets, actual-cost-source contracts, budget envelopes/snapshots, maximum branch ledgers/leases/dispositions/readmissions, selection admission, selected execution, attempt-progress CAS, provider-attempt admission, budget admission, dispatch intent plus immutable claim/send transition ledger, every present budget slice/reservation/attribution, idempotency, pending binding, provider outcome, reconciliation lease, credential requirement/coverage, attempt-scoped prepared exposure, orphan recovery-bound versions and control, lifecycle-funding quote/admission continuations, state lease, active/orphan obligation, and every ownership transfer in one serializable Postgres authority. Each pre-dispatch, branch-lease/disposition/readmission, activation, orphan-transfer, recovery authorization/poll/bound extension, orphan-to-active recovery, retry/fallback, lifecycle-funding, and terminal transition locks and commits its complete applicable row set atomically. A later separate admission service must expose the fenced prepared-transition protocol defined in Section 7.4 with idempotent recovery and keep the public ID and request terminal transition unavailable until every ownership record commits; an asynchronous outbox alone is insufficient for this barrier.

Relational uniqueness is part of that authority, not an analytics check. Partial unique constraints permit one active logical branch lease per maximum ledger, exactly one initial acquisition version per lease, one current lease version, one subordinate allocation per attempt/slice, and one current successor per allocation disposition, lease disposition, or readmission. A canonical request-cost settlement has at most one correction-chain root; every request correction has one successor, and `(provider invoice evidence, invoice line)` plus `(original settlement, correction sequence)` are unique. Exactly one actual-source contract may exist for each cost-subject/rule/authority/scope/target-currency group key before slicing. The runtime source-group key is reservation-independent and unique over that contract group, canonical source fingerprint, rule, authority, normalized scope hash, and target currency without `sourceCostComponent`; one selection therefore governs all eligible period reservations and prevents parallel provider-charge/accounting-cost debit across slice boundaries. Recovery-bound versions have one root and one hash-chained successor; authorizations reserve nonoverlapping cumulative count intervals; extension admissions and versions each consume one predecessor epoch and exact delta hash; next-poll admission, control exhaustion, cancellation, activation, and cleanup contend on the same active control/progress epochs.

Result, poll, cancel, delete, and expiry operations reauthorize the binding and record their own request-scoped cost separately. Provider usage events and reconciler observations incrementally settle a firm resource-cost obligation within its certified maximum. Gateway-mandated expiry and orphan cleanup run through a code-owned lifecycle service principal whose exact provider action is compiled and preauthorized, so losing the creating caller's access cannot prevent attempted cleanup. Final unused firm exposure is released only after a certified terminal action, the provider-enforced charge horizon, or provider reconciliation proves that no further charge is possible. The reconciliation-retention lease releases in the same fenced terminal transition or later, never earlier. An ambiguous cancel/delete or unreachable provider leaves the obligation `indeterminate` and the lease active; neither is discarded because a binding expired or a worker lease ended, but the independent provider/contract cap still bounds total charge.

An operational resource without such an upstream cap is fenced from further gateway use at its persisted absolute authorized-use deadline and cancellation/deletion is attempted no later than its persisted cleanup deadline, but its accounting horizon and reconciliation-retention lease remain open until provider termination and final cost reconciliation. The successful or indeterminate creating attempt's exposure supplies the one null-predecessor initial epoch; only that epoch references the creating attempt, attempt admission, budget admission, and request-bound valuation quote. Before each later funded interval begins, the authority evaluates current lifecycle policy and prices into a `ResourceLifecycleFundingQuoteSet` bound to the active/orphan obligation, exact predecessor epoch/hash, next interval, separate provider/accounting forecasts, and complete current period/contract slices or signed empty proof. One serializable transaction consumes a fresh `ResourceLifecycleFundingAdmission`, creates lifecycle-source reservations that reference that quote set, exact quote, admission/allocation, obligation, and preallocated continuation epoch rather than request-envelope members, appends the continuation epoch and liability component, and compare-and-swap advances the obligation's current valuation/funding pointers.

A continuation begins at the predecessor's funded-through instant but does not pretend concrete period slices are immutable. Its `ResourceLifecycleSliceTransition` records previous and current rule/slice digests. Within one period it proves an identical slice set; at a trusted monthly/custom-period boundary it preserves the applicable budget-rule identity while replacing expired slice IDs/reservations with certified successor slices; an approved policy replacement carries separate lifecycle authorization. Present commitments pin the fresh lifecycle quote, exact price schedules, source and budget amounts, FX observation/rounding only when conversion is needed, one attribution period/contract, forecast, and reservation. A competing writer or crash recovery cannot create a second root, fork a continuation, omit/fold a current slice, fabricate a request-envelope source, reuse the creating attempt's expired quote/admission, or erase provider/accounting cost because the budget set is empty. Missing canonical valuation or fresh funding for any mandatory current slice fences further authorized use but does not erase continuing provider liability; late actuals, invoice corrections, per-component FX changes, and per-slice overruns remain append-only. It never claims that the original bundle is a ceiling. Publication and the console must label this exposure, and a firm-budget credential cannot reach that target.

### 11.5 Shared state

Recommended initial architecture separates bounded-overshoot operational state from firm admission authority:

- Redis or an equivalent shared low-latency store for operational rate windows, operational concurrency leases, circuits, and affinity, plus preallocated expiring degradation capacity for any policy that does not fail closed;
- a linearizable, failover-durable **firm admission authority** backed initially by serializable Postgres transactions or another quorum store for firm rate/quota counters, concurrency ownership, and spend reservations, with fencing epochs, non-overlapping allocation records, append-only transitions, and a durable high-water mark;
- Postgres for durable policy, price/FX schedules, usage ledger, settlements, and adjustments, with the reservation authority's committed log as the source for spend holds rather than an asynchronous telemetry projection;
- idempotent admission, reservation, transfer, and settlement IDs derived from request/child/attempt/binding IDs and checked under the active fencing epoch;
- continuous reconciliation among provider outcomes/invoices, the reservation log, and projected usage.

Firm rate windows are advanced only by the authority's trusted clock, and multi-region capacity uses fenced allocations that cannot overlap. Firm concurrency records a fenced dispatch intent plus CAS dispatch authority before upstream work and treats the slot as occupied from `send_started` until terminal/cancel evidence, or the operation's certified maximum lifetime plus reconciliation, proves the work can no longer run. Losing a worker heartbeat may reassign a claim only before `send_started`; afterward it fences that worker from new actions but never makes possibly active upstream work disappear or authorizes a duplicate send. Redis TTL leases are therefore permitted only for operational concurrency.

For cost and spend, the authority commits canonical request/resource valuation and the root budget-envelope snapshot before the first billable remote child. It atomically creates each child envelope and every complete provider-attempt or connector admission before dispatch. A nonempty admission allocates and commits every period/contract slice or none; an empty admission commits the identical signed evaluation proof. The initial provider admission commits with selection, and every retry receives fresh runtime, credential, budget, and dispatch authority. A retry may reuse unallocated capacity in an envelope but never an earlier attempt's allocation: chargeable or indeterminate prior work remains held/settled, and the authority enlarges each slice for the retry's incremental maximum before dispatch. Failure of one mandatory authority rolls back all newly requested slices and the associated attempt/intent. A worker sends only after exclusively claiming the exact dispatch authority and durably marking `send_started`. Recovery proves the latest envelope snapshot, slice allocation/settlement high-waters, and dispatch state; any allocation or resource-cost obligation whose send might have occurred remains `pending` or `indeterminate` until provider/idempotency reconciliation proves a terminal outcome. An allocation may be released as abandoned only when its dispatch chain proves no send and its cost contract proves no charge; `ready`, expired pre-send claim, or definitive-not-sent evidence alone does not assert provider billing semantics.

On failover, the authority must recover and prove the latest fencing epoch, dual-currency canonical valuation, budget-envelope or lifecycle-funding snapshot, quote/slice transition, allocation records, provider/connector/reconciliation attempt-progress heads, attempt/budget-admission high-waters, each dispatch intent's current claim/send state, upstream recovery authorization, liability-component/settlement high-waters, and reservation high-water before accepting new firm work, polling an ambiguous resource, or continuing an operational interval. If it cannot, firm admission, resource recovery, and lifecycle continuation fail closed; it never reconstructs authority from eventually consistent usage rows or silently falls back to Redis/local TTL counters. Firm guarantees are intentionally more expensive than operational limits.

Failure policy is explicit:

- fail closed when a firm compliance, legal, rate, concurrency, quota, or budget limit cannot be evaluated;
- permit operational degradation only through its precompiled expiring allocation contract, stopping admission when that capacity expires or is exhausted;
- never silently fall back to per-process or TTL enforcement for a declared firm limit.

### 11.6 Price schedules

Pricing cannot remain two floating input/output numbers on a catalog row. A price schedule needs:

- provider connection or contract scope;
- canonical model and deployment applicability;
- currency;
- effective start and end timestamps;
- input, output, cached-read, cached-write, reasoning, audio, image, video, request, storage, and tool-call units as applicable;
- batch, priority, flex, regional, or service-tier variants;
- tiered-volume rules or contract overrides;
- source and provenance;
- operator approval and version.

Every firm budget is denominated in an explicit base currency. A price schedule in another currency references a separately approved, versioned FX schedule with source, currency pair, fixed-point rate, effective interval, and conservative rounding rule. Before period slicing, each cost subject/rule/authority/scope/target-currency tuple freezes one signed actual-cost-source contract with the exact code-owned evidence-mapping ID/version/implementation hash and eligible-slice digest. Every resulting quote references that shared contract and freezes the selected provider/accounting/contract source component and maximum/forecast amount, target amount, exact FX observation interval or same-currency proof, rounding policy, and one immutable settlement-conversion authority set. Provider-charge or accounting-cost admission requires the same component at settlement; contractual-maximum admission pins exactly one component. The authority set covers every source currency and schedule that can produce an actual for that selected component during the commitment horizon and rejects the alternative component. Request authority names the exact request; operational continuation authority instead names the exact obligation, lifecycle quote set, and preallocated funding admission with request ownership null. Quote operands, allocations, reservations, and resource epochs retain the quoted conversion, shared contract ID, and authority-set ID without schedule reread; compiler/readmission-plan-bound funding trees preserve every operand rather than assigning one conversion to an evaluated aggregate. At actual cost, signed mapping evidence binds the contract/hash, mapping ref, canonical source, target/valuation, usage/invoice/correction lineage, component, currency, and amount. One signed reservation-independent source selection is unique for the contract/canonical-source/rule/authority/scope/target-currency group and covers the complete eligible reservation/slice set. One attribution partitions that selected parent exactly among those components. Each component carries selection, evidence, reservation, authority-set, and source-contract IDs. Each settlement consumes one unique component, retains admitted conversion, and computes actual conversion from the component through an exact matching authority entry, certified schedule/observation policy, rounding, and target currency. A firm commitment accepts only same-currency settlement or an FX entry with certified finite-horizon maximum or contractual cap included in the hold; `operational_with_overrun` cannot satisfy it. An open-ended cross-currency contract cap therefore needs provider/treasury-enforced FX ceiling or is rejected. Its reservation retains `contractual_maximum` as admitted source while every partial actual/correction follows the one selected provider/accounting component and exact correction lineage. Admission uses trusted time and proves price, source contract, mapping, authority, exposure bound, and FX coverage valid through request deadline or provider-enforced horizon. If a horizon crosses an effective boundary, the initial epoch pins every applicable version and holds the maximum over all intervals or rejects. A contract-charge-cap target pins and reserves the approved maximum under non-resetting or fully-at-admission attribution. An operational open-ended resource appends funded epochs with exact schedules, obligation-owned shared source contracts/authority, and observations before each interval and cannot participate in a firm budget. Rollback cannot reactivate an expired interval, rewrite evidence/selection/epoch, or move trusted valuation time backward.

Each usage entry references the exact price-schedule version, canonical accounting conversion, valuation interval, and fixed-point provider/accounting amounts. Each signed budget settlement separately references the reservation's frozen source-to-budget conversion, its signed canonical attribution and unique slice component, and the recomputable budget amount; a later FX publication cannot reinterpret any record. Within one rule/authority/scope/target-currency contract, the component source amounts must sum exactly to the canonical parent source, including zero-valued intersecting slices, so neither boundary duplication nor omission is possible. Later invoice reconciliation creates a new liability-projection component, attribution record, and settlement adjustment rather than mutating the original entry.

A provider-expiry target cannot participate in a firm budget or route-preflight exposure envelope without a versioned schedule for every billable unit it may emit, required FX coverage through its billing horizon, and a certified worst-case estimator. A contract-cap target instead requires an approved immutable maximum already denominated in the budget currency, one permitted attribution mode, and proof that no billable dimension can escape that maximum. Missing, expired, time-incomplete, misattributed, or unbounded valuation makes the target ineligible under firm-budget policy. The cutover needs these subtype-specific minima for provider and processor targets; contract discounts, finance reporting, and invoice reconciliation can mature later.

### 11.7 Cost and usage trust

Usage trust levels should be recorded:

- provider reported;
- gateway tokenizer/estimator;
- target-wire-codec-derived from response content;
- missing/unknown;
- corrected by invoice or administrator.

Provider-reported usage is preferred, but the versioned target wire codec is its sole parser and normalizer. Translation adapters map that normalized usage across wire contracts when required; provider adapters emit only bounded transport observations and never parse response-content usage. The gateway must not invent precise chargeback from an estimate without labeling it.

### 11.8 Cache economics

Treat four mechanisms separately:

- provider prompt caching;
- exact gateway response caching;
- semantic response caching;
- session/connection affinity that improves provider-side reuse.

They differ in privacy, correctness, keying, price, and portability. A route cannot assume a cache survives provider failover. The cost selector should compare marginal cost using likely cache state only when that state is known and trustworthy.

Semantic caching changes application behavior and can return a response generated for a different prompt. It should be opt-in by logical model, data class, and evaluation, never a global cost switch.

### 11.9 Cache configuration and precedence

Caching is configured through typed policies attached to a logical model or route and constrained by organization/workspace data policy. It is not one global boolean.

Recommended modes are:

- `provider_prompt`: enable, disable, or automatically apply provider-native prompt-cache controls; define retention and affinity behavior per eligible deployment;
- `exact_response`: reuse a response only for an exact effective request under an explicit scope and TTL;
- `semantic_response`: separately configured approximate matching with an evaluation threshold and restricted data classes;
- `off`: no gateway result caching, while still allowing provider behavior that cannot be disabled and is contractually approved.

Organization data policy can force caching off or cap retention. A route may enable a permitted cache. A credential or request may opt out. A request cannot enable caching when a higher-level policy disabled it or broaden a credential-scoped cache to workspace scope.

Provider prompt caching and gateway response caching must never share a configuration flag. Provider prompt caching still makes an upstream call and may require deployment affinity; exact response caching avoids the provider call entirely.

### 11.10 Conservative exact-cache V1

The first exact response cache should support only explicitly enabled, stateless, non-streaming requests without tool calls, provider-managed resources, or side effects. Limit V1 to direct logical models or same-canonical-model deployment pools; cross-model routed responses have quality and experiment semantics that require a later explicit cache contract. Streaming replay, tool-bearing responses, realtime, and asynchronous jobs remain ineligible until they have operation-specific semantics.

An exact-cache key includes at least:

- organization and workspace;
- cache scope, such as credential, principal, or explicitly approved workspace scope;
- operation and ingress API wire;
- logical model and logical-model/route version;
- immutable canonical model release for the direct or same-model pool;
- the normalized effective request after forced/defaulted parameters and approved transformations;
- tool, structured-output, modality, model-semantic option, target-wire hosting-extension, physical provider-control, and gateway-preference configuration where applicable;
- data classification and relevant guardrail/policy versions;
- an explicit cache namespace version.

Build the physical key as an HMAC over a deterministic encoding of those ingredients using a tenant-scoped cache-key secret. Never place a raw credential, prompt, uploaded content, or caller-provided cache key in storage keys or metrics. A caller-provided namespace may only select an authorized sub-namespace and remains combined with the effective-request HMAC; it cannot replace the canonical key or create collisions across principals. Cloudflare documents both its full-request default key and caller-supplied custom-key option ([Cloudflare cache keys](https://developers.cloudflare.com/ai-gateway/features/caching/)); Proxy should retain deterministic reuse while preventing an arbitrary caller key from becoming a cross-scope cache-poisoning primitive.

Do not include an entire workspace revision if unrelated workspace changes would invalidate every cache entry. Use the versions that can affect the response or release policy. Each entry also stores indexed generation provenance: canonical model release, deployment, provider connection, ingress and egress wire versions, translation certification, codec/adapter versions, state-free assertion, and output-policy/guardrail versions.

Input policy and guardrails run before lookup. Before release, a hit is reauthorized against the current narrowing overlay, credential and organization/workspace policy, deployment and connection grants, model/deployment lifecycle, data/residency policy, certification status, and output release policy. A revoked connection, suspended deployment, retired model release, expired translation certification, or stricter output policy turns the hit into a miss and schedules purge. Revocation events purge by the indexed provenance fields instead of waiting for TTL.

Cached payloads are encrypted, region-bound, retained no longer than both cache TTL and source-data policy, and deleted through workspace/principal/resource erasure workflows. Workspace-scoped sharing requires an explicit policy that proves equivalent authorization and data classification; credential or principal scope is the default.

Every hit records normal request and policy evidence with `providerAttemptCount = 0`, the cache entry/version, original generation provenance, and any gateway cache cost. The ingress response includes `x-gateway-cache-status`. Standard response `usage` behavior must be documented per API wire; internally the ledger distinguishes original generation units from zero new provider usage on the hit.

Semantic caching remains off by default and outside the first gateway-generalization milestone.

## 12. Security and Data Governance

### 12.1 Threat model

The gateway holds or can access high-value provider credentials and sees sensitive model traffic. Major threats include:

- cross-organization or cross-workspace data leakage;
- credential exfiltration through logs, errors, headers, custom URLs, or admin APIs;
- SSRF and DNS rebinding through configurable endpoints;
- a lower-level route or request weakening data policy;
- prompt/output retention beyond approved purpose or duration;
- unauthorized raw-prompt access through the console;
- malicious or compromised provider endpoints;
- budget exhaustion and denial of service from leaked gateway credentials;
- route/config publication that unexpectedly broadens provider or model access;
- high-cardinality metadata abuse;
- replay of stateful or non-idempotent requests;
- inaccurate usage or price data causing financial leakage.

The production threat model should be an explicit Phase 0 deliverable, not deferred until deployment.

### 12.2 Provider and processor secrets

Provider credential slots and processor connectors store immutable secret-version or workload-identity-contract references, never raw tokens; provider connection rows contain neither. Preferred mechanisms are:

- cloud IAM/workload roles with pinned issuer/audience/subject/role and versioned trust/permission-policy contracts where supported;
- exact immutable versions in AWS Secrets Manager, a KMS-backed internal secret service, or equivalent, never mutable aliases in production runtime state;
- in-memory materialization with short TTL and zero logging;
- versioned slot/set creation with overlap and explicit provider-credential-directory activation;
- separate permission to reference a secret versus reveal or rotate it.

Materialization verifies the exact external version and expected provider account/project/scope before use; drift fails closed and opens a credential incident. Secret-manager aliases and workload-identity policy discovery can propose a new slot version, but out-of-band mutation cannot change the meaning of an active signed directory generation.

The data plane should not return provider keys through GraphQL, REST, events, traces, or debug endpoints. Admin write APIs should be write-only for secret values.

### 12.3 Network and endpoint safety

Retain and expand the repository's pinned-address and safe-upstream behavior:

- scheme and hostname allowlists;
- no arbitrary request-supplied URL;
- DNS resolution with rebinding protection;
- private, loopback, link-local, and metadata endpoint denial unless an administrator configures an approved private network target;
- redirect rejection or revalidation;
- certificate verification and optional private CA profiles;
- egress policy by provider connection;
- private connectivity where providers support it;
- explicit proxy behavior and header allowlists.

Custom HTTP headers are configuration values split into public values and exact immutable secret-version references. Hop-by-hop, authentication, tenancy, and internal tracing headers cannot be overridden by callers.

Processor connectors use the same DNS, TLS, redirect, egress, secret, and header protections as provider connections plus their certified input/output schemas. A guardrail or classifier profile cannot introduce a request-supplied endpoint.

Treat every upstream, including an approved provider, as untrusted for resource consumption. Before a provider or processor body reaches a wire codec, the raw transport safety wrapper incrementally enforces header bytes/count, encoded/compressed/decompressed bytes, compression ratio, idle timeout, total duration, minimum throughput, and bounded buffering while propagating downstream backpressure. The target codec then incrementally parses the bounded byte stream and enforces semantic event/frame size/count, modality-specific output units, ordering, and schema limits. Either layer aborts the upstream on violation, settles possible usage conservatively, and emits a scoped incident; neither duplicates the other's parser. Long-lived sessions use bounded renewal intervals rather than an infinite total-duration exemption. Custom endpoints cannot raise a code-owned absolute maximum; production deployment overrides may only narrow it.

### 12.4 Data-handling attributes

Deployments need policy-usable attributes, backed by provenance:

- retention duration or zero-data-retention eligibility;
- provider training use allowed/disabled;
- region and residency;
- public internet, private link, or self-hosted network class;
- encryption requirements;
- supported customer-managed-key mode;
- approved data classifications;
- provider contractual status;
- subprocessor or legal review state.

These are hard candidate filters. A route cannot "fallback for availability" from an approved zero-retention deployment to a less restrictive target unless the request's data policy explicitly allows both.

### 12.5 Prompt and output capture

The current project permits raw prompt storage for testing. That default must change before enterprise use.

Recommended capture modes are:

- `metadata_only`: sizes, token counts, features, HMAC fingerprints, and no body;
- `redacted_sample`: approved fields after a tested redaction pipeline, sampled and encrypted with short retention;
- `full_encrypted`: exceptional, purpose-bound capture with explicit workspace approval, retention, and restricted viewers;
- `none`: no durable body-derived artifact beyond required accounting.

Use a keyed HMAC rather than a raw content hash when fingerprints are needed; raw hashes can reveal membership for guessable prompts. Full prompt text remains confined to `prompt_artifacts`, never event payloads.

Raw capture access is a separately audited action. UI list and search APIs must not accidentally include prompt text.

### 12.6 Guardrails and DLP

Guardrails should be ordered policy stages with explicit outcomes:

- pre-routing metadata/data-class validation;
- input DLP or safety checks;
- request transformation only when explicitly permitted;
- provider call;
- output DLP/safety checks;
- response release or redaction/block.

Each guardrail policy stage, rather than the processor profile, declares whether the certified invocation outcomes are synchronous, fail-open, fail-closed, or observation-only. A guardrail failure cannot silently switch to an unguarded route. Store the guardrail version and result without copying sensitive content into general events.

A blocking output guardrail cannot coexist with incremental release of unverified bytes. It must buffer the complete output, pass the check, and only then render a response; a logical model that accepts a streaming request must declare that buffered-release behavior or reject the request before egress. A progressive guardrail may inspect chunks and stop future output, but it cannot retract bytes and is therefore labeled nonblocking. Observation-only checks never claim prevention. Portkey similarly documents that blocking output guardrails are not supported for streaming ([Portkey guardrails](https://portkey.ai/docs/product/guardrails)); Proxy should make the release guarantee explicit in the wire promise rather than leave it as a runtime surprise.

Every progressive processor profile declares `single_bounded_stream` or `per_frame` invocation mode and a hard maximum invocation count. The ingress response contract also supplies a maximum releasable frame count. In V1, a billable remote progressive guardrail must be one bounded streaming child with one preflight maximum and one held subreservation; billable per-frame remote calls are prohibited. A future per-frame billable profile is eligible only if the compiler multiplies its certified per-call maximum by the wire's hard frame bound and reserves the entire exposure before provider dispatch. In-process per-frame checks remain bounded by CPU/deadline and frame-count limits. Bidirectional sessions apply the same rule per event and against session-wide invocation/spend ceilings; each event consumes an already-held or atomically enlarged subreservation before release.

Remote or model-based guardrails use the admitted child-request boundary in Section 8.3. Their provider, data, cost, capture, and recursion rules cannot be weaker than the protected parent request.

Guardrails are integration points, not a reason to implement a full policy language or safety model inside Proxy.

### 12.7 Isolation testing

Production gates should include tests that attempt to:

- access another organization's logical models, deployments, routes, traces, and spend;
- reuse state IDs across workspaces;
- read, continue, cancel, share, or delete another principal's state ID inside the same workspace;
- assert another end user or workspace;
- bypass an allowlist with model aliases, unknown fields/events, model-semantic options, target-wire hosting extensions, physical hosting controls, gateway preferences, fallback, uncertified duplicate or mismatched authentication, beta headers, or custom headers;
- invoke a processor directly, without the exact profile grant, through an unapproved connector, or with weaker inherited data/budget/capture constraints;
- reach a forbidden frontier/provider class or exceed the complete request-cost ceiling through a hidden classifier or guardrail target;
- narrow a credential/team policy so one classifier branch empties while the routed model remains discoverable or reaches the classifier;
- route restricted data through an ineligible provider;
- expose secret refs or raw bodies in errors and GraphQL;
- exploit custom base URLs and redirects;
- exceed firm budgets concurrently;
- use a stale or revoked credential after revocation propagation;
- replay an older narrowing generation, omit a tombstone, or miss its base-generation handoff and regain authority;
- reactivate a retired state target through workspace rollback or create an unrelated root/overlong descendant through state-only eligibility;
- keep an SSE/WebSocket/realtime session or async action active after an applicable `abort_active` overlay;
- send a post-handshake session event that bypasses action/data/parameter/guardrail/limit/budget checks;
- exhaust the gateway with oversized/compressed/infinite provider headers, bodies, events, or streams;
- release a cache entry after its deployment, connection, model release, certification, or output policy is revoked.

## 13. Control Plane and Data Plane

### 13.1 Logical separation now, deployment separation when needed

Proxy should adopt control-plane/data-plane boundaries in code and data flow now. It does not need separate repositories or an Envoy rewrite in the first phase.

**Control plane responsibilities:**

- identity and administrative authorization;
- provider and processor connections, immutable provider credential slots/set versions, provider-credential-directory lifecycle, and secret references;
- catalog, deployment, route, policy, price, and workspace-revision lifecycle;
- narrowing absorption, state-target retirement/retention, and cutover-manifest lifecycle;
- schema validation, certification, simulation, compilation, publication, rollback;
- audit, reporting, and console APIs;
- onboarding profiles, credential issuance, and harness setup metadata;
- discovery and scheduled health/capability jobs.

**Data plane responsibilities:**

- request authentication and credential binding;
- parsing and admission;
- deterministic execution of a compiled revision;
- enforcement of narrowing/retirement high-water and per-event session policy;
- shared limit/health/affinity state;
- credential materialization;
- bounded provider/processor transport and inference translation;
- response streaming and cancellation;
- traffic evidence emission.

The data plane cannot mutate routes, policies, certifications, or deployment definitions. It may update bounded operational health/quarantine state and emit incidents for control-plane action.

### 13.2 Compiled snapshot distribution

Every compiled workspace artifact contains its schema version, exact operation definitions, route/resource/operation preflight manifests, access/policy versions, resource-cost plans with versioned price/FX-selection policies, resource/processor-profile and connector resources, minimum compatible provider-credential-directory/state-retention generations and retirement epoch, and the wire-codec, translation-adapter, provider-adapter, processor-adapter/implementation, schema-validator, and policy-runtime component IDs plus content/build hashes it requires. It does not contain mutable credential mappings, request valuation quotes/epochs, lease snapshots, or claim to own their progress. Publication uses one staged tuple protocol with two code-owned activation modes: `pinned_rollout` for routine immutable publications and `barrier_cutover` only for a migration whose approved invariant forbids any new admission on the old tuple after the commit point.

1. deploy code additively so a target data-plane ring advertises the new component set before any active revision requires it;
2. pure-compile and commit the immutable candidate workspace revision, artifact hash, required-component manifest, `StateRetirementImpactSet`, and audit event;
3. when the impact set removes a state target/component, have the retirement coordinator complete the required block/drain/lease-snapshot transitions and issue a compatible signed `StateRetentionGeneration`; otherwise select the current generation at or above the candidate's floor;
4. select compatible identity-directory and provider-credential-directory generations plus the required narrowing epoch, then announce the exact candidate activation tuple through pub/sub or a durable change stream;
5. each instance fetches every tuple member, verifies signatures/hashes/schemas, monotonic epoch/hash chains, compatibility floors, and component availability, compiles no executable configuration locally, and returns an ACK or a reasoned NACK with its build/component fingerprint;
6. for each independently routed production, regional, and canary ring, form a ring-keyed monotonic candidate membership epoch from instances that ACKed the exact tuple; drain/exclude every NACKed, timed-out, or unavailable instance before commit, and leave that ring's last known good tuple active unless its candidate set meets the capacity/SLO floor;
7. for `barrier_cutover`, first command every trusted ingress partition for the workspace to enter `quiescing`, stop new admissions with a bounded queue or wire-native retry response, fence the old admission epoch, and ACK a common barrier epoch; routine `pinned_rollout` skips this step;
8. commit the candidate tuple and each ready ring-keyed membership epoch in the linearizable ring-activation authority. These records are the commit points: they never wait for a post-commit ACK from the original candidate sets and are never rolled back by lowering a directory, retention, narrowing, or retirement generation;
9. have trusted ingress stamp the exact ring ID, active tuple, and that ring's membership fencing token on every newly admitted request and route it only to instances advertising `active` for all three. In a routine rollout, gates may observe old and new signed records at different times, so callers can see bounded availability differences, but one request never mixes tuple members or rings. Any removal or security tightening is already enforced by the narrowing/retirement authority before this rollout; a new gateway credential or broader grant is not reported active until every traffic-receiving gate in every affected ring has ACKed the granting tuple or been fenced. A newly introduced provider slot/set may serve pinned stateless traffic sooner, but remains ineligible for lifecycle-creating dispatch until the credential coordinator proves retained coverage across that same complete gate set;
10. if an instance or gate fails after commit, publish a successor membership epoch for the same tuple that fences/removes it and, when needed, adds a replacement that staged the tuple. A membership epoch is `ready` only with a nonempty active set and capacity-floor proof; otherwise it is `unavailable`, may have no active members, and makes affected gates return the wire-native unavailable/retry outcome until a ready successor exists. It never reopens the old tuple. Rollback is a new higher activation record using a retained compatible artifact at or above every monotonic floor;
11. for `barrier_cutover`, publish one fenced reopen authorization only after every member of every final successor traffic-ring epoch advertises the committed tuple. A post-commit failure therefore shrinks or replaces that ring's membership instead of blocking forever. Old in-flight requests may finish on their pinned ring/tuple and live narrowing, but no new request is admitted on the old tuple after the barrier;
12. advance rings under normal SLO and conformance gates.

An instance missing a required component is not ready for that workspace/ring and must never interpret the tuple partially. A new replica cannot join a serving membership epoch until it loads and advertises that epoch's workspace revision, identity/provider-credential generations, narrowing high-water, state-retention generation, and state-target-retirement high-water. Production, regional, and canary rings have independent IDs and membership epoch chains. A ready epoch has a nonempty active set and capacity proof; an unavailable epoch has no active members and an explicit reason. Each ingress gate opens exactly one signed `(ring, tuple, membership)` stamp for a new request; a routine rollout can temporarily have old-stamped and new-stamped requests across gates, but every instance accepts only an exact match and all old-stamped work remains subject to live narrowing. Removing a ring from this serving set does not retire its active-execution authority: that authority remains registered as historical while any pinned request, child, stream, or async owner is nonterminal, and ring retirement must seal/drain or atomically migrate those hierarchies before deregistration. Component versions remain available while referenced by an active, staged, last-known-good, rollback-retention, admitted request, state lease, reconciliation lease, or ACKed retention generation. Credential set/slot versions remain while an active/staged/rollback directory, admitted request, provisional creator requirement, or lease references them. The identity, provider-credential, and retention coordinators may independently advance a compatible generation through this same staged pinned protocol and cannot lower a workspace's declared floor. Retirement occurs only after every still-routable ring/gate/member ACKs a generation that no longer needs the resource or is fenced by a successor epoch. This follows the proven ACK/NACK and version-retention shape of [xDS configuration delivery](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol.html) without pretending xDS alone provides atomic distributed activation.

The ring-activation authority is not a centralized lookup on every inference request. Each trusted ingress gate serves from its verified signed active record and membership fencing token. A partitioned, superseded, or removed gate/instance cannot receive load-balanced traffic or mint a valid current token. The control plane tracks propagation high-water and enforces a bounded rollout deadline; routine widening may be temporarily unavailable at a lagging gate, while narrowing never waits for routine propagation because the independent emergency channel applies first. Full quiescence is reserved for an approved barrier invariant, including the one-time V3-to-V4 cutover.

Instances retain the last known good ordinary configuration snapshot. A configuration-publication outage prevents new configuration but does not itself invalidate that snapshot; the independent narrowing-freshness lease and any other explicit security expiry still fail closed on schedule.

Requests already in flight remain attached to the complete activation tuple with which trusted ingress admitted them. That stability never overrides emergency revocation.

The identity/credential and provider-credential directories have their own generations and use the same ring-membership rule because identity or credential activation must not wait for a workspace model publication. Emergency revocation is a separate, narrowing-only channel. Revoked gateway credentials, disabled principals or memberships, disabled provider connections or credential slot/set versions, compromised deployment-wire-binding/provider-resource/processor targets, organization suspension, certification withdrawal, model-release suspension, and security kill switches propagate through a signed high-priority **narrowing overlay** with a short freshness bound.

That bound is enforced by an independent revocation authority, not by the last overlay's `issuedAt` or a best-effort subscriber heartbeat. One quorum-backed linearizable `NarrowingRevocationAuthorityHead` per workspace owns both the authoritative overlay head and freshness-lease head. A new workspace bootstraps through one unique create-if-absent `workspace_genesis` transition whose expected head is null and whose prepared content is the code-defined empty initial overlay: null predecessor, no active or cleared deltas, and the canonical initial generation, empty-set digest, and fanout high-water. The genesis consensus command installs the first authority term/fencing token and overlay head. Only after its certificate is materialized may the authority issue the first freshness lease, and the workspace cannot serve before that certified lease exists. Concurrent genesis attempts have one winner; an ordinary transition can never fabricate a predecessor for an absent workspace.

Failover compare-and-swaps an existing certified head to a higher authority term and fencing token with a trusted-time expiry. Genesis, failover, overlay publication, and lease issuance use one acyclic publication protocol: prepare canonical signed content when the transition has content; execute one quorum-backed compare-and-swap command that atomically commits the transition, successor semantic head, and a unique signed `NarrowingRevocationConsensusCommitReceipt` keyed by workspace and transition hash; then materialize an external `NarrowingRevocationHeadCommitCertificate` as an idempotent deterministic projection of that durable receipt, transition, successor head, and prepared-content reference. The receipt freezes the projected certificate ID, ID-derivation version, projection-component version, hash-derivation/hash versions, and certificate signing-key version before consensus returns. The projection uses those exact retained inputs; a rollout or signing-key rotation cannot reinterpret them. The projection component and signing key remain available while any head referencing them is certificate-pending. The current head projection is `certificateMaterializationState: pending` after consensus and becomes `ready` only when the unique certificate is atomically attached. No successor transition or serving gate may consume a pending head. A crash after consensus but before caller response or certificate write is recovered by reading the receipt and materializing the same certificate; concurrent materializers converge on the same certificate, and certificate recovery does not change the semantic head hash or committed index.

The code-owned `NarrowingRevocationHeadStateHashInput` contains only the semantic workspace, authority, committed-index, overlay, delta/fanout, lease-pointer, and hash-version fields. It excludes its own `headStateHash` output and every transition, receipt, certificate, signature, and quorum-proof field. The prepared-content hash domain excludes its own hash/signature fields and every transition, receipt, certificate, or quorum-proof field. The versioned transition hash domain excludes its own hash/signature fields and every receipt, certificate, or proof field. The versioned receipt hash domain excludes its own hash/signature fields, and the versioned certificate hash domain excludes its own hash/signature fields. Transitions contain no receipt/certificate/proof backlink; receipts and certificates are not inputs to either prior hash. Authority-term acquisition uses the same compare-and-swap and receipt/certificate projection but has no prepared content. Only prepared content joined to its exact ready committed transition certificate is serving authority. An overlay transition may advance only the overlay generation/hash, complete active-delta digest, and fanout high-water while preserving the current lease pointer; a lease transition must preserve those exact overlay/fanout values and advance only the lease pointer/sequence. A stale or partitioned issuer cannot commit under an old token, and prepared-only, transition-only, receipt-only, certificate-pending, mismatched-hash-version, or uncertified records never serve.

The authority continuously issues one signed hash-chained `NarrowingFreshnessLease` per workspace, even when the ordinary configuration control plane is idle. Its content binds the expected authority term/fencing token/head hash/index, exact authoritative overlay generation/hash, complete active-delta-set digest, revocation-fanout high-water, policy-bounded maximum duration, trusted-time source, and `validFrom`/`validThrough`; its matching commit certificate binds the resulting transition and successor committed index/proof. `validThrough` cannot exceed either the configured maximum or the quorum-backed authority-term expiry. A renewal cannot lower any high-water, change workspace, skip its predecessor content, fork a consumed parent, or attest an overlay that omits an introduced but uncleared delta. Ingress records the accepted lease content ID/hash, commit-certificate ID, term, issuance index, and committed proof as admission evidence. Before new admission, body acceptance, capture, state/cache/processor/provider work, retry, each session event, and every output/result release, the executor must hold an unexpired lease whose content and exact certificate join to the current committed head and whose overlay/fanout high-waters dominate its locally accepted state, then evaluate that overlay. Gates durably reject lower terms or indices, duplicate-parent forks, stale fencing tokens, prepared-but-uncommitted content, wrong certificates, and hash-domain mismatches. Expiry rejects new work and fail-closes active input/output and release in the wire's valid form; already-sent provider work remains owned and reconciled but cannot bypass the fence. A partitioned gate, stale replica, replayed lease, missed renewal, or isolated former issuer therefore loses serving authority no later than `validThrough`. The last known good workspace revision may survive an ordinary control-plane outage, but inference intentionally becomes unavailable if the revocation authority cannot commit a renewal within the approved security bound.

Every workspace has exactly one signed hash-chained narrowing overlay. Its complete active-delta set can contain workspace-wide deltas or deltas with one typed credential/principal/policy-scope filter; a subject filter never creates another generation chain. Every request therefore needs one workspace overlay generation, and replicas cannot prove workspace freshness while omitting a subject revocation. Each delta names that workspace's base revision plus identity/provider-credential/state-retention/policy generations. There is no optional organization-wide delta that one workspace can absorb. A durable signed **RevocationFanout** distributes one atomic shared restriction at explicit organization or platform scope. Its membership snapshot uses an organization-workspace high-water or a platform-organization high-water plus each organization's workspace high-water, and each entry names both organization and workspace. `organization_suspension` installs a durable organization-ingress deny, emits one typed `workspace_kill_switch/deny_all` delta per existing workspace, and blocks every new workspace/grant activation until local absorption and a separately approved resume.

A `shared_resource` fanout installs one closed fence for the exact shared connection, credential slot/set, deployment wire binding, provider resource target, model release, certification, processor profile, connector, or model-backed processor target. Compiler, grant, issuance, directory, and activation paths consult the scope-wide fence registry before accepting references, including organizations/workspaces created after the membership snapshot. A normal fence denies all references. A compromised credential-slot fence may instead allow only a directory entry marked `incident_reconciliation`, bound to the named lifecycle principal/incident authorization and exact live reconciliation lease. For `exact_auth_source` it must be that exact slot; for namespace-bound state it must equal the lease requirement's originating slot. Both reject ordinary sets, retained-successor use, and `state_continuation`. The fence remains active until the owning resource authority is durably suspended and every affected local authority absorbs its delta or receives a proven dormant activation fence. It remains in the registry even then; only a separately signed resume that names a restored resource-authority version may clear it. Local delta distribution alone never clears a global fence, so a late-created workspace cannot reacquire the resource between distribution and absorption.

Each immutable versioned `NarrowingDelta` is introduced by one signed, hash-chained `NarrowingOverlayGeneration` and carries exactly one nonempty, code-owned discriminated restriction with exactly one code-derived absorption authority. A multi-facet incident emits a linked set of atomic deltas rather than one object spanning several authorities: for example, a compromised provider slot emits a `provider_credential_access` delta absorbed only by the provider-credential directory, while a compromised deployment-wire binding emits a `provider_route_access` delta absorbed only by a workspace revision. Slot compromise chooses either complete disablement or `restrict_credential_slot_versions_to_incident_reconciliation`; the latter removes ordinary and caller-continuation eligibility and may preserve only lease-matched reconciliation under the separately authorized incident principal. A set disablement removes both ordinary and retained-successor selection through that set. The directory cannot absorb complete disablement while a live exact-auth-source lease still requires that slot; it keeps the delta and affected work unresolved unless a certified successor or terminal incident disposition closes the requirement. Identity changes are absorbed by the identity directory; retained-target invalidation is absorbed by the state-retention generation; policy restrictions and the typed workspace kill switch are absorbed by the workspace revision. Unknown kinds, empty lists, mixed action variants, author-selected absorption owners, and fields outside the exact schema are rejected. A delta cannot add an identity, target, component, permission, capture mode, capacity, or weaker rule. If another security tightening cannot be represented monotonically or requires an unstaged component, the control plane installs this same typed workspace kill switch until a fully compiled authority can absorb it.

Enforcement points, active-request behavior, absorption authority, and durable authority actions are not authorable fields. The code-owned registry derives them from the exact restriction and activation recomputes the contract version/hash. Identity, provider credential/route, model/certification suspension, and kill switches require `abort_active` plus every applicable admission/dispatch/retry/release point. Rate and budget reductions fence the prior allocation/reservation epoch, preserve already committed dispatch obligations, compute remaining capacity from consumed plus reserved exposure, and issue only bounded replacement capacity. When committed exposure already exceeds the new maximum, the requested exact ceiling is non-realizable: the authority records the preexisting overrun, issues zero new capacity, and keeps the delta or deny-all active without an absorption receipt until window advance/settlement makes the bound realizable or a separately approved policy resolves the incident. It never marks an overrun as completed enforcement. Capture/data-retention reductions enumerate and re-expire or purge indexed prompt artifacts, cache entries, replay artifacts, and affected retained/provider resources through a durable store high-water. An action that cannot safely cancel/delete provider state keeps use/release denied and the delta unabsorbed. Ordinary lifecycle retirement still uses its normal state machine rather than an emergency delta.

Every replica persists or securely bootstraps the accepted revocation-authority term/fencing token, committed issuance index/proof, workspace overlay-content generation/hash, narrowing-freshness-lease content sequence/hash, and matching commit-certificate high-waters. It rejects a lower term or index, stale token, prepared-only content, transition-only publication, wrong or missing certificate, hash-domain mismatch, duplicate-parent fork, replayed, skipped, wrong-parent, not-yet-valid, expired, overlong, wrong-workspace, or overlay/delta/fanout-mismatched record. An overlay generation names its complete active-delta set, including every subject-filtered entry, plus the absorption receipt for each delta cleared by that transition, so omission cannot masquerade as removal without a receipt or a broken committed head/overlay/lease chain.

One fenced, WAL-backed **active-execution authority** owns hierarchical liveness for each ring/ingress partition. Trusted ingress registers a root with its ring, one immutable initial authority binding carrying the complete authority/overlay stamp, append-only `NarrowingDependencyFact` rows for admission facts, and exactly one `root_initial` snapshot before body acceptance. The current-state projection points every hierarchy member at one current authority binding; the binding chain, rather than an in-place stamp rewrite, preserves every prior authority. A snapshot contains only the fact high-water, not a replaceable fact array. Parsing, resolution, policy, transformation readmission, cache provenance, target binding, and release atomically append facts and compare-and-swap one same-reference continuation snapshot through the ordered stages. Database constraints enforce exactly one appropriate `root_initial` or `child_initial` snapshot per reference, same-reference continuation predecessors, strictly increasing mutation sequence, nondecreasing stage rank, unique canonical facts, and one fenced current-snapshot and authority-binding pointer; a worker can neither create a second root/fork nor remove an earlier fact.

Every upload worker, admitted processor child, provider attempt, stream/session event loop, and async action/result owner uses the closed child-reference variant. One authority transaction locks the registered parent's current snapshot and current authority binding, proves identical organization/workspace/root/ring/partition/binding, and writes both the child reference and its `child_initial` snapshot naming that exact parent reference/snapshot; a stale snapshot or binding pointer loses the compare-and-swap. Only the request root may use `root_initial`, whose parent and inherited snapshot are structurally null and whose root ID equals itself. A child cannot omit inheritance, name a cross-root/cross-authority snapshot, or substitute a later snapshot after registration. It then appends its own target/release facts before dispatch or release. Closing a parent with live work requires an atomic ownership handoff to registered descendants. In particular, request-to-provider-job handoff creates the async owner and closes the request in one authority transaction, so there is never a liveness gap. Terminal/abort evidence may always close a sealed leaf without appending a dependency fact; a parent closes only after all descendants close or ownership transfers.

The authority registry retains every ring/partition that has a nonterminal execution record, even after that ring stops receiving traffic. Ring retirement must first seal and drain its hierarchies or atomically migrate them to another registered authority while preserving root IDs, dependency snapshots, sequence ordering, and the old authority's terminal proof. Removing a ring from load balancing or the current membership set never removes its execution authority from narrowing.

A delta remains effective until its single derived authority incorporates the restriction, every derived durable action produces a signed high-water completion receipt, and every member still routable in every traffic-receiving ring ACKs that authority or is fenced. The coordinator freezes, in one monotonic snapshot, the union of the current traffic-receiving ring/partition set and every historical ring/partition with a nonterminal active-execution WAL high-water. For each authority it freezes the exact authority epoch/fencing token, root-binding registration high-water, and binding-registry snapshot digest; enumerates every nonterminal root-scoped current binding in that snapshot; and produces either one `ActiveExecutionEpochSeal` per binding plus a complete seal-set digest or a signed `EmptyActiveExecutionHierarchySetProof`. Every seal and empty proof binds that same authority epoch/fencing token, registration high-water, and registry digest, and the ACK must match them exactly; a record from a predecessor authority term cannot satisfy a successor ACK. A seal names its root and binding, serializes against fact append, snapshot continuation, authority restamp, child registration, and async handoff, rejects mutations still naming the sealed binding, and returns final registration, fact, and snapshot high-waters after each concurrent transaction either committed or failed. New work may register only under the absorbing authority binding after full admission. Terminal/abort closure remains legal under the seal.

The exact matcher drives immediate enforcement and partitions each sealed hierarchy only after those final high-waters are fixed. A hierarchy is provably nonmatching only when the proof includes every nonterminal root and descendant, their current snapshots and complete inherited fact closure, and one valid absent-atom proof for every bounded-DNF clause at or beyond that clause's required completeness stage. A partial-stage, unknown, oversized, whole-workspace, or otherwise unprovable hierarchy is matching or indeterminate. For a provably nonmatching hierarchy, one transaction creates a signed `narrowing_nonmatching_restamp` binding for the absorbing authority, compare-and-swaps every nonterminal member's current binding pointer and ownership epoch from the sealed predecessor, and preserves root IDs, parentage, fact/snapshot chains, dispatch/cost authority, and current snapshots unchanged. The old seal prevents a concurrent append or partial migration; after the transaction, the hierarchy may continue and create children only under the new binding. Matching or indeterminate hierarchies remain sealed and must abort or drain to terminal evidence. Thus a credential- or model-scoped delta cannot terminate an unrelated stream/job, and an unrelated non-cancellable job cannot hold the delta active indefinitely.

The resolution proof partitions every hierarchy at or below all three sealed vectors exactly once into a complete restamp or terminal drain; no hierarchy may be omitted, duplicated, split across outcomes, or descend from a sealed binding afterward. For every frozen live authority, its complete root-binding set equals its seal IDs and seal-set digest, or its empty proof establishes that the binding-registration high-water contained no nonterminal root. The workspace receipt's seal set and coverage digest must equal the disjoint union of those per-authority sets, including zero seals when every serving partition is idle. A dormant-workspace proof is legal only when the same membership/authority snapshot proves both an empty traffic-receiving ring set and zero historical live execution authorities, then installs an activation fence requiring the absorbing generation and cleared overlay high-water before any future ring can serve. The per-ring ACKs, complete live-authority set and per-authority seal sets/empty proofs or dual-empty workspace proof, authority actions, vectors, hierarchy-partition proof, nonmatching restamp set, and matching/indeterminate terminal evidence form one immutable **NarrowingAbsorptionReceipt**; only a later overlay generation referencing that receipt may remove the delta. Old pinned work on serving or retired rings therefore either advances under the absorbing binding or cannot add facts, create a late attempt, hand off an async job, retry, or release after the delta disappears. There is no `workspace revision OR provider directory` shortcut. A linked incident or suspension completes only when every constituent delta has its own receipt. Missing a matching-hierarchy handoff deadline installs or retains the workspace deny-all, and an unrealizable durable action or undrained matching/indeterminate execution never expires its tombstone. Restoring permission requires a separately approved broader authority publication, normal tuple activation, and a later signed overlay transition. Snapshot rollback and a heartbeat that omits an active delta cannot lower the high-water or widen authority.

The executor evaluates applicable deltas at every request point required by the derived enforcement plan, while the named limit, storage, cache, credential, and retention authorities execute their own derived actions. Parameter, data, capture, and input-guardrail deltas therefore affect a request before egress; output/guardrail and entity deltas can also stop active release. Cache hits, catalog/local results, and state retention are always reauthorized through the current overlay and have a registered `release_ready` execution reference. A code-owned compiler maps every closed restriction to the same closed dependency vocabulary and emits bounded disjunctive normal form: `anyOf` conjunction clauses, each with explicit `allOf` atoms and the earliest completeness stage at which an exact negative is valid. This represents predicates such as `subject AND (target A OR target B)` unambiguously. Clauses are canonicalized, deduplicated, size-bounded, and signed in the plan; if exact compilation would exceed the bound, needs negation/unknown joins, or cannot map to registered facts, the plan uses whole-workspace matching. A derived `abort_active` plan stops new input/output, aborts upstream work where possible, emits cancellation evidence, and closes in the ingress wire's valid error/close form within the freshness bound. Submitted provider jobs that cannot be cancelled may continue upstream, but results and further actions remain denied and the attempted cancellation remains an open authority action, so neither the execution reference nor delta clears prematurely.

The overlay can only narrow an identity/credential directory, provider-credential directory, state-retention generation, or published snapshot. Production workspaces fail closed when the current narrowing-freshness lease is absent, expired, invalid, or behind the accepted overlay/fanout high-water; when any required identity/provider-credential view is older than its configured bound; when an epoch/hash chain is discontinuous; when an authority-action receipt is missing; or when a handoff deadline is missed. Ordinary non-security configuration can continue using the last known good workspace revision only while those independent security authorities remain valid.

### 13.3 Postgres on the hot path

The current transactional event/outbox design is appropriate for control-plane changes. It is not the ideal final transport for every chunk, attempt update, or usage event at enterprise volume.

Recommended split:

- **Strongly consistent control-plane events:** continue through `EventService`, current-state mutation, and outbox in one Postgres transaction.
- **High-volume traffic evidence:** emit idempotent request/decision/attempt/usage records to a durable stream or local write-ahead buffer, then project them to Postgres/analytics.
- **Hard admission state:** use the shared limit/budget service before forwarding.
- **Critical audit mode:** selected workspaces may require durable admission evidence before the provider call; define the latency and outage trade-off explicitly.

Do not make production provider availability depend on a synchronous analytics insert. Do not make accounting best-effort either. The durable telemetry path needs backpressure, retry, disk buffering or broker durability, and idempotent projection.

### 13.4 Adapter architecture

Use separate registries for API contracts, translation, and provider connectivity:

```text
wire key -> API-wire manifest + codec factory
  +-- route matcher and envelope validator
  +-- request/response/error codec
  +-- stream state machine

(source wire, target wire, operation-definition version, interaction mode) -> translation-adapter manifest + factory
  +-- feature/fidelity declaration
  +-- request and response mapping
  +-- streaming and state mapping

provider adapter ID -> manifest + factories
  +-- connection/credential-slot/physical-hosting validator
  +-- auth and endpoint materializer
  +-- discovery and health client
  +-- bounded raw transport + typed transport observations
  +-- supported egress-wire bindings

processor adapter ID -> manifest + factories
  +-- connector/profile schema validator
  +-- auth, endpoint, request, and response materializer
  +-- error, rate, cost, and data-handling classifier
```

The route executor works only with compiled wire keys, operation requirements, a selected deployment, and a prepared attempt. It should not know Bedrock request fields, Anthropic cache blocks, Azure API versions, or Gemini safety settings.

The composition order is explicit:

1. the ingress router resolves a wire key and its codec;
2. the codec validates the client envelope and extracts routing requirements;
3. the executor chooses a deployment whose native egress wire or certified translation path satisfies those requirements;
4. a native path preserves registered same-wire syntax where policy permits, while a translated path invokes exactly one named translation adapter; in both cases the target codec validates and serializes every semantic or billing-affecting target-wire extension enabled by the deployment binding;
5. for each attempt independently, resolve the canonical target through the admitted provider-credential-directory generation, select from its ordinary set or one physical slot in the intersection of every state/reconciliation lease's exact retained-access evidence, verify immutable credential identity/scope and every continuity proof, then have the provider adapter materialize only the physical URL, region/project/API-version path, authentication, network controls, and non-semantic minimum header set;
6. the shared transport wrapper bounds the provider adapter's raw byte stream without retrying, the target codec incrementally parses and limits semantic success/error/usage outcomes, the shared orchestrator applies retry/fallback policy, the translation adapter maps a terminal outcome when required, and the ingress codec renders the client-visible result.

For a `workspace_resource` create or resource-only `state_binding` action, the resource executor substitutes the profile/binding's exact provider-resource target for model selection in step 3. That target already pins the provider connection, endpoint variant, egress wire/codec, state mapping, response-safety profile, and certification. It still uses the same provider adapter and attempt boundary, but never creates a fake model deployment.

Processor execution is a separate compiled path: the profile minimizes and validates input; admission resolves its pinned in-process implementation, model terminal plan, or processor connector; the code implementation or corresponding provider/processor adapter performs the bounded invocation; and the profile validates a typed outcome before the parent route, guardrail, or operation stage applies its own terminal action. The inference route executor never constructs an arbitrary processor URL.

An OpenAI provider adapter may expose several OpenAI API wires, and an OpenAI-compatible provider adapter may reuse their codecs. Provider-specific physical behavior extends the provider adapter; semantic differences require a versioned wire release/extension schema and target codec binding. Inheritance is optional; the registry contracts and conformance suites matter more than the class hierarchy.

### 13.5 Runtime state ownership

| State | Authority | Durability |
|---|---|---|
| Published configuration | Control-plane revision store | Durable, immutable |
| Ring activation/admission gate | Linearizable activation authority + trusted ingress | Exact ring/tuple/membership stamp per request; independent ready/unavailable membership chains and laggard fencing per production/regional/canary ring |
| In-memory compiled snapshot | Each data-plane instance | Reconstructable |
| Identity/credential directory + narrowing overlay | Signed control-plane distribution + one epoch/hash high-water per workspace | Complete workspace delta set with typed subject filters, fanout generations, authority-action and absorption receipts |
| Operational rate/concurrency leases | Shared low-latency state + fenced degradation allocations | Atomic normally; finite compiler-proven outage overshoot or fail closed |
| Firm rate/quota/concurrency admission | Linearizable durable firm admission authority | Fenced, non-overlapping allocation/admission high-water proven across failover |
| Operation/idempotency resolutions + decision headers/outcomes + candidates/selection admissions/selected targets | Linearizable durable admission authority | Early existing-idempotency branch, immutable external-request or processor-child ownership before dependent work, resolution-bound candidate epochs, chosen-branch and fenced runtime admission, one terminal pointer, and one selected-target root/CAS chain |
| Processor invocation intents/states/connector admissions/outcomes | Linearizable durable admission authority | Immutable pre-work intent, pending without fake target/reservation, one exact fenced connector admission before connector dispatch when applicable, and one typed denial/in-process/model/connector terminal outcome |
| Firm spend commitment bundles/prepared-active-orphan obligations | Linearizable durable firm admission authority | Atomic rule/authority/scope/currency/period-or-contract slice vectors, pre-slice shared actual-source contracts plus signed mapping evidence/source selections, compiler/readmission-plan funding snapshots, logical maximum-branch leases with fresh attempt allocations, fenced pre-dispatch exposure, owner-correct lifecycle/FX authority, exact cross-reservation period partitions, append-only component settlement, and reservation high-waters |
| Operational prepared/active/orphan cost obligations | Durable usage/obligation ledger | Absolute use/cleanup deadlines, one-root contiguous multi-slice funded epochs, and explicit per-slice overrun until provider terminal |
| Circuit/health signal | Shared operational state plus durable summaries | Ephemeral + projected |
| Session/cache affinity | Shared operational state | TTL, reconstructable when possible |
| Active-execution authority | Fenced per-ring/ingress-partition WAL + shared seal/high-water projection | Closed root/child references, exact parent-current snapshot inheritance, append-only dependency facts plus one CAS snapshot chain per reference, historical live-ring retention, atomic handoff, seal vectors, and terminal descendant proof |
| State-resource bindings | Encrypted durable store | Closed unprepared/prepared-pending/reconciling/active/resource-cleanup-retained/terminal lifecycle with structurally valid mapping, lease, and cost ownership |
| Durable idempotency records | Durable transactional store | Caller-HMAC or request-ID keyed; replay TTL separate from terminal-proof GC fence; later client collisions never redispatch; internal request-terminal recovery requires exact upstream certification/authorization, while resource create only reconciles |
| State-retention leases/generations | Indexed binding store + retirement coordinator/signed distribution | Per-resource exact authorization in leases; class-level target/profile/component projections with partition high-waters, live counts, digests, creator proof, and no per-request selected IDs |
| Reconciliation-retention leases | Provider-outcome/obligation/orphan store + retirement coordinator | Fenced ownership transfer; exact target/components retained through terminal outcome and cost reconciliation |
| State-target retirement | Durable retirement-coordinator state + target-scoped creator registry | Linearizable root/descendant creation barriers, current/historical root seals and creator-absorption proofs, creator/state/reconciliation high-waters, pre-release cancellation, and irreversible release projected only in retention generations |
| Exact-response cache | Regional encrypted cache + provenance indexes | TTL, revocation-purgeable |
| Request/attempt/usage evidence | Durable traffic stream | At least once, idempotently projected |
| Admin audit | Postgres event/outbox | Strongly durable |
| Provider credential slots/set versions | Versioned control-plane store | Immutable external identity/version contract; independently narrowable slot versions |
| Provider credential directory | Credential coordinator + signed distribution | Monotonic sole selector plus request/creator/lease and traffic-gate admission-set high-waters, all-admissible-gate creator receipts, and per-lease retained-slot intersections |
| Shared-resource fence registry | Scope-wide linearizable security authority + signed fanout/resume records | Organization/platform membership high-waters; blocks late references through resource-authority and local absorption until explicit resume |
| Provider secret material | Secret manager/workload identity | Durable, externally controlled; attempt records observed version fingerprint |

### 13.6 Deployment topology

Initial production topology:

- existing company ingress/WAF terminates network and coarse API policy;
- a trusted generation-aware admission gate stamps the exact ring membership/tuple on accepted requests, fences lagging gates/instances during routine rollout, and quiesces only for an approved barrier cutover;
- multiple stateless Proxy data-plane instances per region;
- separate or logically isolated control-plane workers/API;
- Postgres for control-plane and evidence projections;
- Redis-compatible shared operational state for operational rates/concurrency, circuits, and affinity, with fenced expiring degradation allocations where enabled;
- a single-region linearizable durable firm admission service for exact rate/quota/concurrency and spend, with fencing, non-overlapping allocations, and high-water recovery;
- secret manager and cloud IAM;
- OpenTelemetry collector plus metrics/log destinations;
- durable traffic-event transport when volume justifies the split.

Reevaluate Envoy AI Gateway or a two-tier design when one of these becomes true:

- self-hosted GPU endpoints need queue-aware endpoint picking;
- Kubernetes inference routing is a primary workload;
- data-plane QPS or protocol diversity exceeds the Fastify implementation's measured capacity;
- multi-region active-active policy distribution needs a standard xDS-like control path;
- the organization wants one shared network gateway substrate for multiple AI control planes.

Until then, a rewrite would delay the differentiating control-plane work.

### 13.7 Multi-region concerns

Multi-region is not just deploying two replicas. The design must define:

- workspace revision propagation and rollback ordering;
- region-local deployment eligibility and data residency;
- health and circuit state sharing versus regional isolation;
- globally firm versus regionally partitioned rate/budget limits;
- session and state-resource affinity;
- traffic evidence ordering and idempotency;
- provider credential scope;
- behavior during network partition.

Prefer regional routing and regionally allocated firm limits with explicit global reconciliation until a use case truly requires globally synchronous counters. Every regional rate, concurrency, or spend allocation is non-overlapping, fenced, and bounded by a global allocation authority; its regional firm admission authority proves the applicable high-water before admitting work. A "global monthly budget" can reserve and rebalance those allocations through a fenced control-plane transfer rather than add a cross-continent transaction to every request.

## 14. Request Evidence, Observability, and Operations

### 14.1 Evidence model

Preserve and generalize the existing request/decision/attempt hierarchy:

- **Request:** identity, identity-directory/provider-credential-directory/narrowing/state-retention generations, effective-policy fingerprint, workspace revision, ring ID plus ring membership/activation epoch, closed root/child active-execution reference, append-only narrowing-dependency facts, current same-reference snapshot pointer and exact registered parent snapshot for children, operation definition, ingress API wire, interaction mode, optional logical model, feature requirements, immutable deadline/attempt/output limits, root budget-envelope/current-snapshot reference, body-capture reference, and admission result.
- **Policy decision:** effective policy IDs, grants, denies, forced/defaulted parameters, limits, data constraints, and any applied narrowing delta/fanout plus derived owner/action-plan and absorption-receipt evidence.
- **Operation/idempotency resolution:** each fresh request owns one initial `OperationResolutionRecord` and same-decision transformation successors with normalized-request digest/epoch. A transformation successor relationally binds the exact processor invocation, terminal outcome, signed output ref, transformed-envelope digest, codec validation, and readmission-policy bundle. A durable idempotency claim starts with immutable `claimed_unresolved` provenance and cannot dispatch until the operation resolution/header and complete `dispatch_ready` provenance commit atomically. An existing caller token instead owns one pre-route `ExistingIdempotencyResolution` naming the exact observed provenance ID/hash/phase; it never creates a current operation resolution.
- **Execution decision:** one immutable header persisted before candidate evaluation, quotes, processor/provider children, or target selection. The owner is an external request with either its normal operation resolution or existing-idempotency resolution, or one model-backed processor intent. A same-decision single-root/CAS candidate-set chain is bound to the exact effective resolution/transformation or `ProcessorInputRef` and contains closed eligible/excluded evaluations. A selection requires normalized chosen-branch membership plus one `ExecutionSelectionAdmission` covering health/circuit/capacity/concurrency/quota feasibility, narrowing/affinity, canonical cost valuation, exact slice-complete quote set, current envelope snapshot, and, for processor models, current target authorization. Exactly one terminal outcome closes the header; provider-selected outcomes name only the final selected pointer. Exact-state selection equals the resolved hard binding, while every actual network attempt separately consumes fresh runtime/credential authority.
- **Processor invocation when applicable:** signed minimized/redacted input ref, immutable intent, atomically inherited active-execution child and child budget envelope before candidate/admission/reservation/execution work; pending/terminal projection; exact profile/plan, model child request/decision where applicable, component hashes, complete parent `processor.invoke` decision, inherited constraints, and invocation mode/count. A model target authorization or connector admission records the runtime service-principal `processor.execute` decision for the exact input/target. Every remote implementation records canonical request cost. A connector also records one matching dispatch intent, CAS claim/send state, slice-complete quote set, envelope snapshot, and closed budget admission. One closed denial/in-process/model/connector terminal outcome follows; completed variants own an exact signed output ref.
- **Idempotency when applicable:** code-owned namespace and caller-intent-normalization version, lookup HMAC, stable caller-intent HMAC, immutable `claimed_unresolved` -> `dispatch_ready` -> `execution_bound` -> `terminal` provenance chain, exact current-provenance pointer/phase, pending-collision behavior, separate provider-key/exposure links, and reconciliation without recording the caller token or body. Existing records resolve before normal routing and produce a request-scoped terminal conflict/initializing/in-progress/timeout/fanout/replay/unavailable/release-denial outcome. Every replay, waited result, fanout frame, and completed-result-unavailable response is reauthorized against the exact current provenance plus current policy/narrowing; a waiter re-resolves after wake. Pending/indeterminate records structurally own only an open fence; succeeded/failed-terminal records own a retained terminal fence until a signed GC certificate proves deletion eligibility.
- **State transition when applicable:** `pending`, `reconciling`, `active`, resource-lifecycle retained-cleanup tombstone, or terminal tombstone root/descendant transition; internal/idempotency/public IDs; aggregate nonempty binding set/lineage; origin model/release; exact resource-profile version when applicable; data classification and lifecycle/retention policy references; selected-execution ID and attempt-scoped prepared/active/orphan/settled/aborted-before-acceptance cost ownership; canonical execution/credential-continuity requirements plus minimum directory floor/all-gate receipts; target-scoped creator registration; exact state/reconciliation leases and class-level retention generation/index proof; retirement epoch plus creator/lease high-waters and creator-absorption proof; durable cancellation/release transition; and cleanup outcome without exposing an upstream ID.
- **Provider attempt:** hierarchical active-execution child and authoritative selected-execution/parent-decision IDs; once-consumed `ProviderAttemptAdmission` with fresh health/circuit/capacity/concurrency/quota/narrowing and credential-set/slot eligibility/quota; exact `BudgetAttemptAdmission`; canonical cost valuation; immutable `ProviderDispatchIntent` plus current claim/send state; quote-set/envelope/snapshot IDs; append-only narrowing facts and parent snapshot; target-derived connection/auth contract; admitted provider-credential-directory generation; ordinary or retained common-slot evidence; credential/creator coverage for write-like work; egress wire and adapter versions; attempt-scoped exposure/provider-outcome/reconciliation IDs; retry/fallback category; timestamps; upstream request ID; and outcome classification.
- **Usage settlement:** normalized units and trust source; exact attempt/connector admission owner; canonical request-cost valuation/settlement regardless of budget coverage; quote set, rule/slice digests, envelope allocation/settlement high-waters, and reservation bundle or empty-set proof; when resource-terminal, exact attempt exposure, plan/resource quote/valuation epoch, canonical provider-cost valuation/settlements, obligation state, and settlement-completeness certificate; one rule/authority/scope/currency/single-period-or-contract/valuation/reservation/settlement/overrun entry per mandatory slice; persisted provider-expiry horizon, contract-terminal accounting state, or single-root operational use/cleanup/rolling interval; reconciliation-lease reference; fencing epochs/high-waters; and cost center.
- **Response:** terminal status, commitment point, cancellation, fallback count, and response API wire.

Every record is organization/workspace scoped and idempotently keyed.

### 14.2 Explainability

For every candidate deployment, store a bounded reason such as:

- not entitled;
- operation unsupported;
- API-wire translation unavailable;
- required feature unsupported;
- context too small;
- data classification or region ineligible;
- connection not granted to workspace;
- lifecycle/certification inactive;
- firm limit or budget exhausted;
- provider/deployment circuit open;
- at concurrency capacity;
- state binding points elsewhere;
- route did not select branch;
- lower priority than selected candidate.

Do not store only the winning provider. Operators need to distinguish policy exclusion, configuration error, capacity exhaustion, and upstream failure.

### 14.3 OpenTelemetry

Recommended spans:

- `gateway.request`;
- `gateway.policy.evaluate`;
- `gateway.route.resolve`;
- `gateway.classifier.call` when used;
- `gateway.guardrail.input` / `gateway.guardrail.output`;
- `gateway.provider.attempt`;
- `gateway.translate.request` / `gateway.translate.response`;
- `gateway.usage.settle`.

Use bounded attributes for metrics. High-cardinality identifiers such as request ID, end-user ID, and arbitrary model strings belong in traces/evidence, not metric labels.

Traces and ordinary logs never contain raw prompts, outputs, uploaded content, bearer/provider secrets, upstream state IDs, or full custom headers. They carry only approved bounded attributes and opaque references to separately authorized capture artifacts. Processor child spans link by request ID and purpose without copying their input or output.

Core metrics include:

- gateway request and operation rate;
- admission denials by stable reason;
- gateway-added latency before provider connection;
- time to first byte and total latency by deployment/operation;
- provider outcome and classified failure;
- retry/fallback rate and recovery rate;
- candidate-exclusion counts;
- limit/budget reservation failures;
- usage and cost by authorized dimensions;
- cache read/write/hit and state-affinity rate;
- config revision propagation and stale-snapshot count;
- component, identity/credential-directory, and provider-credential-directory ACK/NACK; routine rollout and barrier admission-gate lag; fenced/replacement membership; narrowing fanout distribution, authority-action, absorption-receipt, and stale-overlay lag;
- cache purge lag after deployment, connection, model, certification, or policy revocation;
- telemetry backlog and projection lag.

### 14.4 SLO recommendations

Set final numbers after load testing, but design toward:

- data-plane availability independent of routine control-plane outages;
- 99.95% or better gateway availability for admitted stateless requests, excluding provider failures;
- p95 gateway-added latency below 25 ms for direct non-guardrail, non-classifier text and embedding requests in-region;
- zero cross-tenant evidence or body exposure;
- 100% of successful provider attempts linked to a request, deployment, revision, and usage trust state;
- configuration rollback available within minutes;
- revocation and hard-policy publication propagated within a defined short bound;
- no firm-budget overrun beyond the documented conservative reservation bound.

Classifier, DLP, guardrail, and semantic-cache latency should be measured separately rather than hidden in gateway overhead.

### 14.5 Operational controls

Operators need:

- pause/drain a deployment or connection;
- open/close/reset a circuit with reason and expiry;
- disable a logical model or route revision;
- roll back a workspace revision;
- revoke credentials immediately;
- test provider connection and model capability;
- replay only from an authorized captured artifact, with a new request ID and explicit no-side-effect constraints;
- inspect an end-to-end attempt timeline;
- export audit and usage data;
- configure maintenance windows and provider incidents;
- compare expected versus observed provider usage and invoice cost.

All manual overrides expire by default and produce administrative audit events.

## 15. Operations Console

### 15.1 Information architecture

The console should be organized around operator jobs, not implementation tables:

- **Model Catalog:** canonical models, capabilities, lifecycle, pricing provenance, certification.
- **Connections:** stable provider accounts/projects, regions, endpoints, network, grants, and health.
- **Provider Credentials:** slot versions, auth methods/scopes, write-only secret/workload-identity refs, active set generation, rotation, quota, and compromise state.
- **API Compatibility:** read-only wire registry, contract versions, codec versions, translation graph, feature fidelity, and certification status.
- **Deployments:** concrete upstream model endpoints, egress wire bindings, operations, capabilities, prices, data policy, certification, health/capacity.
- **Logical Models:** public IDs, ingress wire promises, promised features, access visibility, active route.
- **Routes:** graph, versions, simulator, diff, publish, rollback.
- **Onboarding:** SDK compatibility profiles, harness configurators, workspace onboarding profiles, generated-configuration preview, and conformance status.
- **Access:** workspaces, teams, principals, credentials, entitlements, effective-policy inspector.
- **Policies:** data, parameters, limits, budgets, capture, guardrails.
- **Traffic:** requests, decisions, attempts, errors, traces, cancellation.
- **Usage and Spend:** normalized units, costs, budgets, forecast, chargeback, reconciliation.
- **Health:** provider/deployment status, circuits, quota headroom, canaries, incidents.
- **Audit:** configuration and sensitive-data access events.

### 15.2 Configuration UX

Do not reproduce LiteLLM's "large YAML plus a simple UI" experience.

Use:

- structured forms driven by provider-adapter, harness-configurator, onboarding-profile, and policy schemas;
- searchable model/deployment pickers with capability and data-policy filters;
- a restrained route graph editor plus synchronized highlighted JSON for advanced editing;
- effective-policy preview for a selected principal and model;
- impact analysis before publish;
- typed validation at field and whole-revision level;
- draft, review, approval, publish, and rollback states;
- generated diff showing added/removed logical models, deployments, entitlements, and data paths;
- compatibility diff showing changed ingress promises, egress bindings, translation paths, affected SDK/harness compatibility profiles, and certification gaps;
- copyable application environment settings and previewable harness setup commands generated from published onboarding profiles;
- production confirmation that names the affected workspaces and request share.

The route graph is an operational tool, not a decorative diagram. It should show branch conditions, candidate counts, fallbacks, and invalid states compactly.

### 15.3 Simulator

The simulator should accept:

- organization/workspace;
- principal, team, and credential context;
- operation, ingress API-wire version, and interaction mode;
- logical model;
- request feature summary and token estimate;
- data classification and approved metadata;
- optional health, quota, or budget scenario overrides.

It should return:

- effective policies and their sources;
- forced/defaulted/rejected parameters;
- traversed route nodes;
- eligible and excluded deployments with reasons;
- chosen deployment and selection inputs;
- selected egress wire and native or named translation path;
- retry/fallback possibilities;
- expected price range and data path;
- whether the result differs between the current and draft revision.

Simulation cannot call a production provider unless the operator explicitly runs a separately audited live test.

### 15.4 Review workflow

Production publication should support:

1. draft configuration;
2. schema and compiler validation;
3. simulator/regression suite;
4. impact diff;
5. optional reviewer approval based on risk;
6. publish with actor and reason;
7. progressive activation or immediate hard cutover as selected;
8. automatic health monitoring;
9. one-action rollback to the previous revision.

Security/data-policy broadening, new provider connections, raw-capture changes, and production model access should require stronger approval than a display-name edit.

## 16. Build, Buy, and Platform Choices

### 16.1 Options

#### Adopt LiteLLM as the gateway

**Benefits:** fastest provider breadth, extensive configuration inventory, existing management and routing features.

**Costs:** inherits its configuration/domain complexity, Python runtime and upgrade surface, edition boundaries, compatibility semantics, and a second opinionated control plane. Proxy's strongest features become redundant wrappers or split evidence.

**Decision:** do not adopt or fork as the core. It can remain a compatibility oracle in testing or a temporary isolated adapter only for a time-bounded provider experiment, never an unobserved hop in production.

#### Use Cloudflare, Vercel, or Portkey as the shared gateway

**Benefits:** lower initial operational burden, broad provider access, polished routing and observability.

**Costs:** platform dependency, policy-model constraints, another credential/data processor, limited integration with Opendoor identity and audit, and reduced control over translation/state/evidence semantics.

**Decision:** viable as a tactical managed path for low-risk workloads or a benchmark, not the recommended system of record if Opendoor wants the gateway to be a durable internal control plane.

#### Use Kong or existing API management with AI plugins

**Benefits:** mature ingress, authentication, networking, traffic policy, plugin operations.

**Costs:** does not by itself supply the desired model/deployment catalog, protocol certification, state-aware routing, cost ledger, and AI-specific access model.

**Decision:** use as an outer gateway where the company already operates it. Keep Proxy as the AI semantic and governance layer.

#### Rebuild the data plane on Envoy now

**Benefits:** high-performance proxy substrate, standard control-plane patterns, strong Kubernetes/self-hosted inference direction.

**Costs:** major rewrite before requirements and domain model are stable; TypeScript control-plane work remains; translation and provider adapters still need implementation.

**Decision:** defer. Design a clean boundary so Envoy can later serve as transport or Tier 2 without replacing the control plane.

#### Evolve Proxy

**Benefits:** preserves existing evidence, event, tenant, provider, translation, and console work; allows an Opendoor-specific identity and data-policy model; owns API fidelity and audit end to end.

**Costs:** provider breadth, certification, high-availability state, and enterprise identity are significant engineering commitments.

**Decision:** recommended, provided the team commits to the domain cutover before feature expansion and does not attempt every modality/provider at once.

### 16.2 What to buy or reuse

Build the differentiated control plane and AI execution semantics. Reuse infrastructure for:

- identity provider, SSO, and SCIM;
- cloud workload identity;
- secret storage and KMS;
- existing ingress/WAF/DDoS controls;
- Redis-compatible atomic operational state;
- Postgres;
- OpenTelemetry collection and company observability stack;
- durable event transport;
- standard JSON Schema/OpenAPI tooling;
- provider SDKs only inside adapter boundaries where they preserve required behavior;
- catalog feeds as seeded, provenance-marked data;
- company policy/review systems where integration is cheaper than duplication.

### 16.3 Decision scorecard

| Criterion | LiteLLM core | Managed gateway | Kong/Envoy only | Evolve Proxy |
|---|---:|---:|---:|---:|
| Near-term provider breadth | High | High | Medium | Medium |
| Opendoor identity/policy fit | Medium | Low-Medium | Medium | High |
| Protocol/state fidelity control | Medium | Low-Medium | Low without custom layer | High |
| End-to-end evidence ownership | Medium | Low-Medium | Medium | High |
| Operational burden | Medium | Low | High | High |
| Vendor/edition independence | Medium | Low | High | High |
| Ability to preserve current work | Low | Low | Medium | High |
| Long-term differentiation | Low | Low | Medium | High |

The recommendation is not the cheapest initial option. It is the best fit if the premise is that this becomes a company-wide policy and evidence boundary rather than only an API convenience.

## 17. Hard Cutover from the Current Architecture

### 17.1 Cutover rules

Follow one schema/API cutover with no dual-read compatibility layer:

- routing config V4 replaces V3;
- remove the global four-tier route schema;
- remove provider-family deployment blocks from route configuration;
- replace `surface` with exact operation-definition/API-wire semantics and derived interaction mode;
- introduce code-owned operation-definition, API-wire, wire-codec, translation-adapter, provider-adapter, processor-adapter, SDK-compatibility, and harness-configurator registries;
- introduce first-class deployments and logical models;
- generalize agent sessions and traffic evidence names;
- replace hard-coded provider-adapter selection with the separate registries;
- rewrite seeds, fixtures, docs, console forms, and tests in the same program;
- preserve current behavior only as a newly seeded `opendoor/coding-auto` logical model.

Do not keep deprecated aliases or accept both config schemas. The repository's current stage makes a hard cutover safer than ambiguous compatibility.

The target core may exist beside V3 only as inactive development/test code while parity is built. Production does not dual-read, dual-write, translate V3 into V4, or split one workspace between executors. At cutover, each production workspace's configuration is migrated and activated atomically on V4; after the coordinated fleet cutover, the V3 schema, API, seeds, and executor are deleted in the same release program. Rollback means selecting a prior V4 workspace revision or rolling back the release/database as an operational event, not retaining a compatibility path.

Configuration migration is insufficient. Each workspace cutover has an immutable reviewed **cutover manifest** that inventories and assigns `migrate`, `reissue`, `revoke`, `expire`, `checkpoint`, or `drain` to:

- every principal, API-key verifier, credential restriction/grant, membership, connection grant, provider credential slot/set generation, and external secret/workload-identity version;
- every active/pending state or provider resource, session, affinity, public/upstream ID mapping, and retention requirement;
- every in-flight request/stream, async job, idempotency record, request or resource-lifecycle limit/budget reservation, unsettled usage item, and provider-side operation;
- every pending event, outbox row, telemetry record, and projection offset needed for audit continuity.

The runbook first freezes V3 configuration and authority creation, builds dormant V4 credentials with exact grant snapshots, and converts only verifiers/state whose semantics are fully known. A token that cannot preserve its verifier/policy contract is reissued or revoked; a state resource whose owner, upstream target, operation semantics, or encrypted ID cannot be proven is drained/expired with caller-visible notice, never accepted through a V3 lookup shim. It then stops new V3 traffic admission, drains or terminates bounded streams/sessions, settles reservations and usage, checkpoints/cancels async work, flushes event/outbox offsets, and reconciles provider resources.

The V4 workspace revision, identity/provider-credential directories, converted state bindings/leases, and cutover manifest activate only after every required ring stages/ACKs, every ring/ingress partition quiesces, and an invariant check finds no unowned credential, unresolved authority, pending creator, orphaned provider resource, unaccounted reservation, or unprojected audit event. Trusted ingress reopens only when every member of every final successor traffic-ring epoch advertises the V4 tuple; a member that fails after commit is fenced/replaced within that ring on the same tuple rather than reopening V3. V3 is deleted only after that point. A failed pre-activation cutover returns to V3 before commit; after V4 commits, rollback is a newer V4-only tuple and cannot resurrect V3 authority or decrease any narrowing/directory/retirement high-water. This is a hard cutover with a drain window, not a compatibility runtime.

### 17.2 Suggested table-level disposition

This is a target model, not a final migration specification.

| Existing table | Action |
|---|---|
| `organizations`, `workspaces` | Retain; add typed ownership/environment attributes if needed |
| `users`, memberships, invitations, user sessions | Retain for control plane; extend roles/permissions |
| `providers` | Convert built-ins to provider-adapter manifests in code; retain DB records only for enabled/custom definitions and metadata |
| `provider_accounts` | Split into stable `provider_connections` with versioned auth contracts, immutable credential slot/set versions, state-continuity certifications, and signed ordinary/lifecycle directory generations; move raw material to secret manager/workload identity |
| API-key/provider-account join | Replace with explicit connection grants and route/policy selection; credentials do not directly carry provider secrets |
| `model_catalog` | Split into separately governed canonical `model_definitions`, workspace-referenced `model_deployments`, capability evidence, and price schedules |
| `routing_configs`, `routing_config_versions` | Replace with `logical_models`, `routes`, `route_versions`, and workspace revisions |
| `organization_settings`, `user_settings` | Move policy-bearing fields into versioned policies; retain true UI/preferences only |
| `agent_sessions`, `turns` | Generalize to state bindings, retention leases, and optional interaction/session evidence |
| `requests`, `route_decisions`, `provider_attempts` | Retain and hard-cut to immutable decision headers, normalized candidate sets/evaluations, unique terminal outcomes, selected-target transitions, operation resolution, and optional model/deployment fields |
| `usage_ledger` | Retain; add reservation, trust, price version, and adjustment semantics |
| `prompt_artifacts`, prompt-access audit | Retain with enterprise capture defaults |
| event/outbox/projection tables | Retain for control plane; add a separate traffic ingestion path when needed |

### 17.3 Minimum new resources

- `principals` and `service_accounts` or one typed-principal table;
- `teams`, `team_memberships`, and workspace/team grants;
- `provider_connections`, versioned code-owned auth contracts, workspace grants, immutable provider credential slot/set versions, and signed provider-credential-directory generations;
- separately governed canonical `model_definitions` with immutable release versions/provenance;
- `model_deployments`;
- deployment API-wire bindings with one exact required auth-contract version each;
- `deployment_capability_evidence` and translation-certification artifacts, or versioned documents with the same semantics;
- `price_schedules`, FX schedules/observations, rounding policies, price components, dual-currency canonical request/resource cost valuations and settlements, owner-discriminated source-to-budget conversions, pre-slice shared actual-cost-source contracts, code-owned mapping manifests, signed runtime mapping evidence and reservation-independent source selections, selected-source-only settlement authority sets, canonical period-attribution records/components, period/contract-sliced budget quotes, sealed quote sets, compiler/readmission-plan-bound budget envelopes with operator-preserving funding trees, shared-maximum ledgers with logical branch leases/versions, fresh attempt allocations/dispositions and signed retained-charge readmissions, signed snapshots, source-selection/component-unique actual/correction settlements, provider/connector/reconciliation attempt-progress projections and admissions, typed reconciliation cancellation/codec/transport attempt outcomes plus control-exhaustion and disposition-specific cleanup evidence, non-resetting recovery-bound versions with strict deltas, code-owned marginal-exposure derivation manifests, signed operand valuations/cost vectors, quote/coverage/funding extension admissions, and available/active/closing/closed controls, budget-attempt admissions, upstream-idempotency certifications/recovery authorizations, provider/connector/reconciliation dispatch intents plus CAS authorities and immutable claim/send/cancel ledgers, atomic owner-discriminated slice-complete reservation bundles, immutable operation/target `resource_cost_plans`, candidate-snapshot-bound resource valuation quotes, attempt-scoped prepared exposures, obligation-scoped lifecycle-funding quote/admission continuations, single-root append-only bundled resource valuation epochs and liability-projection components, closed resource-cost obligations, and settlement-completeness certificates;
- append-only canonical request-cost correction roots/predecessors with invoice evidence, mapping/source-selection/attribution lineage, and request-terminal budget-settlement consumption;
- `logical_models`;
- `routes` and immutable route versions;
- immutable workspace `resource_profiles` for model-less provider-resource creation;
- immutable `processor_profiles`, `processor_connectors`, signed processor input/output refs, invocation intents/states, model-target authorizations, pre-dispatch connector admissions/intents, terminal outcomes, grants, and certification evidence;
- immutable `access_profiles` containing exact typed policy-version references plus separate scoped profile attachments;
- `policies`, immutable policy versions, and bindings;
- `workspace_revisions`, code-owned operation-capability requirement manifests, signed capability-gate readiness receipts, complete signed supported-operation capability sets, and compiled artifacts;
- versioned credential issuance templates with exact access-profile/narrowing-policy references;
- versioned onboarding profiles that reference code-owned harness configurator manifests;
- generalized discriminated state bindings, exact state-retention and reconciliation-retention leases, target-scoped lifecycle-creator registrations/root seals/absorption proofs, all-gate credential-lifecycle registrations/coverage receipts, class-level monotonic retention generations backed by partitioned lease-index proofs, durable state-target retirements/cancellations, minimal request-state orphan recovery/control/transfer/cleanup records, and separately gated resource-orphan reconciliation state;
- durable HMAC-keyed idempotency records, early existing-idempotency resolutions/results, provider-key mappings, signed idempotency-GC certificates, request-state orphan outcome/lease-set ownership, and prepared/active-binding/orphan firm or operational resource-cost exposures;
- immutable operation-resolution chains, execution-decision headers and unique final-pointer terminal outcomes for external requests and model-backed processor children, normalized effective-resolution/input-bound candidate-set/evaluation chains, route-traversal/candidate admissions, once-consumed runtime selection admissions, and single-root compare-and-swap selected-target predecessor chains;
- a fenced per-ring/ingress-partition hierarchical active-execution authority covering every request, child, attempt, stream, session, and async action/result through closed root/child references, atomically pinned parent-current child-initial snapshots, append-only dependency facts, one CAS snapshot chain per reference, one hierarchy authority-binding chain with atomic all-descendant restamps, historical-ring retention, atomic ownership handoff, registration/fact/snapshot epoch seals, and terminal descendant evidence;
- one retained-credential common-slot selection per attempt plus complete per-lease membership/equality evidence;
- immutable workspace narrowing deltas; one linearizable revocation-authority head with a unique empty-overlay workspace genesis, explicit semantic head-hash input, fenced terms, atomic transition/head-plus-consensus-receipt CAS, and recoverable idempotent commit-certificate projection for overlays and independently renewed hash-chained narrowing-freshness leases; organization/platform shared-resource fence and signed-resume registries; hash-chained fanout generations; authority-action receipts; complete current-ring/historical-live-authority proof sets; per-authority complete root-binding seal sets or signed empty proofs; hierarchy nonmatch proofs/restamps; matching-or-indeterminate drain proofs; exact restamp/drain partition proofs; and signed absorption receipts;
- immutable workspace cutover manifests and disposition evidence;
- operational rate/concurrency leases plus a linearizable durable firm-admission ledger for firm rate/quota/concurrency and request/resource spend, if not externalized to a service with the same contracts.

Avoid creating a table per policy kind initially. A typed `policy.kind` plus strictly validated versioned spec and normalized bindings is the right abstraction because lifecycle and precedence are genuinely shared.

### 17.4 Existing behavior on the new core

The cutover is successful only when current coding workflows still support:

- `/v1/responses` over HTTP, SSE, and supported WebSocket mode;
- `/v1/chat/completions`;
- `/v1/messages` and token counting;
- native OpenAI and Anthropic paths;
- Bedrock Converse translation;
- tool use, structured output, reasoning, and prompt-cache behavior currently certified;
- session affinity;
- provider health, retry, and auditable fallback;
- request/decision/attempt/usage visibility;
- existing harness smoke tests;
- idempotent generated configuration for the initially supported Codex and Claude Code versions.

Those behaviors must run through logical models, deployments, compiled route V4, and effective policy. No special legacy execution path remains.

### 17.5 Documentation superseded

Adopting this strategy supersedes the generic-gateway non-goal and classifier-first invariant in [router research product boundaries](../scopes/router-research-roadmap-v1/product-boundaries.md) and the coding-first conclusion of [aggregate recommendations](router-research-recommendations.md).

Those documents should remain historical research until implementation begins. At Phase 0 approval, add a formal architecture decision record that names this document and updates the repository's durable architecture rules.

## 18. Delivery Roadmap

The phases below are ordered by dependency and gated by evidence. Every published artifact carries one signed supported-operation capability set. The compiler emits a typed unavailable result for an operation/lifecycle whose required capability gate is incomplete; a dormant schema, adapter, or target cannot make it reachable. Phase 2 activates only request-terminal coding operations plus their exact state-binding and minimal request-state-orphan recovery barriers. General `resource_terminal` create/poll/cancel/delete, continuing provider liability, resource-orphan recovery, lifecycle funding, and invoice-adjustment machinery become prerequisites only for the first Phase 4 operation that declares those capabilities. Do not attach engineering-week ranges before Phase 0 produces an owner-backed decomposition, infrastructure inventory, security dependencies, and provider certification matrix; false precision here would hide the work most likely to control the schedule.

### Phase 0: Decide the contract

Deliverables:

- approve the product boundary and working assumptions;
- decide internal-only versus future external multi-tenant posture;
- name organization/workspace/team/principal semantics;
- approve logical model, deployment, versioned operation-definition, and route concepts;
- approve the API-wire identity/versioning model and the separation among wire codecs, translation adapters, and provider adapters;
- approve the drop-in OpenAI/Anthropic SDK compatibility contract and supported SDK versions;
- approve the SDK compatibility profile, harness configurator, secure credential handoff, credential-issuance-template, and workspace onboarding-profile contracts;
- approve direct, pooled, and routed logical-model behavior;
- approve logical-model hard-state binding sets, state-bound actions, and model-less workspace resource-profile behavior;
- approve per-resource TOML versus control-plane ownership and one-way reconciliation semantics;
- choose initial provider and operation priorities;
- define data classifications and provider eligibility owners;
- write the threat model and control/data-plane ADR;
- approve closed-world extension handling, default-deny authorization, identity/credential/provider-credential-directory and narrowing-overlay freshness, principal-owned state semantics, and the state-creation egress barrier;
- set absolute per-wire client-ingress and upstream-response header/body/decompression/multipart/frame/output/deadline limits plus authenticated quota bounds;
- define target SLOs and expected QPS/concurrency;
- inventory production identity, secret, ingress, Redis, firm admission/reservation/idempotency, telemetry, and event infrastructure;
- approve the hard-cutover rule and the production-readiness gates that precede it.

Exit criteria:

- every open "must decide before coding" item in Section 21 has an owner and decision;
- architecture terminology is added to `AGENTS.md` and durable architecture docs;
- no feature work continues against routing config V3 except urgent correctness fixes.

### Phase 1: Build the target core without production activation

Deliverables:

- versioned operation-definition/API-wire registries, interaction-mode derivation, and ingress route resolution;
- separate wire-codec, translation-adapter, provider-adapter, processor-adapter/connector/profile, SDK compatibility, and harness-configurator contracts;
- deployment egress-wire bindings and the compiled ingress-to-egress compatibility matrix;
- stable provider connection plus immutable credential-slot/set versions, stable continuity requirements, generation-specific successor certifications, all-admissible-gate creator-coverage registration, per-binding retained-slot intersection, and the sole signed ordinary/lifecycle credential-directory model;
- separately governed canonical-model catalog and model-deployment schema;
- logical models, routes, route V4, request-state profiles, complete-execution preflight manifests, and a pure compiler that emits retirement impact without mutating retirement state. Resource profiles may exist only as disabled schema fixtures until their lifecycle capability gate is complete;
- durable operation-resolution and existing-idempotency-resolution records; pre-work external/processor decision headers; resolution/input-bound candidate epochs; route-traversal outcomes and chosen-branch candidate admissions; one-time runtime selection admissions; final-pointer terminal outcomes; and single-root selected-target predecessor chains;
- immutable processor invocation intents plus closed pending/terminal state, once-consumed pre-dispatch connector admissions, and denial/in-process/model/connector outcomes, with model-child decisions independent from the caller decision;
- one code-owned dispatch-deadline contract for provider and connector intents, plus the gated resource-reconciliation intent fixture: each intent persists the exact minimum bound, deadline-derivation version, and trusted-time source that its send-start CAS must match; all normalized decision/invocation, admission, progress, intent, authority, transition, cancellation-evidence, terminal-outcome, and signed-output relations use exact organization/workspace/request-scoped composite keys, model-backed processor outcomes carry their separate child-request decision scope, and deadline cancellation uses the shared signed deadline-reached evidence contract;
- request-terminal operation/target cost plans; request/candidate-snapshot-bound period/contract-sliced valuations with owner-discriminated conversions; pre-slice actual-source contracts plus code-owned mapping manifests and signed runtime evidence/source selections; selected-source-only settlement authorities; compiler/readmission-plan-bound sum/max envelope trees; logical maximum-branch leases with fresh attempt allocations and retained-charge operands; canonical cross-reservation attribution partitions, request-cost correction chains, and component-unique settlements; atomic request-envelope reservation bundles; provider/connector attempt-progress, dispatch, immutable upstream key binding and request-terminal recovery authority, plus the minimal lifecycle-free request-state orphan control/transfer/cleanup boundary; versioned price/FX schedules, billable-unit schemas, and usage-trust contracts required for request-terminal firm reservation. Resource-lifecycle ownership, resource-orphan recovery/control/extension, lifecycle funding, liability epochs, and resource invoice adjustment may exist as reviewed schema fixtures but are not Phase 1 runtime or publication dependencies and every operation requiring them compiles `unavailable`;
- closed root/child active-execution references with atomic parent-current snapshot inheritance and one common retained-credential slot authority with per-lease membership/equality evidence;
- immutable workspace revision, signed complete supported-operation capability set, typed unavailable compilation for every incomplete lifecycle gate, and in-memory loader;
- closed-world extension handling and a default-deny typed policy/version/binding core with immutable access profiles plus distinct resource, processor-invocation, and processor-target grants;
- versioned TOML schema with plan/apply/import/export and source ownership;
- a control-plane reconciler that creates the same resource versions as the administrative API;
- rehearsable hard-cutover database migrations, target seeds, and target API contracts that are not yet active in production;
- required-component manifests plus ring-keyed generation-aware tuple-stamped admission, recoverable membership epochs, historical live-execution authority retention, current-plus-historical absorption proofs, and publication coordination for provider-credential/state-retention generations and data-plane stage/ACK/NACK/activation tuples, with quiescence reserved for explicit barrier cutovers;
- minimal admin APIs and console screens for operation/wire compatibility, stable connections, provider credential slot/set versions, state-continuity certification, ordinary/lifecycle directory activation, deployments, logical models, routes, request-state/access profiles, request-terminal cost plans/valuation state, credential issuance templates, onboarding profiles, and publish/rollback. Incomplete resource/lifecycle entries appear only as typed compiler diagnostics, not as configurable grants, routes, or profiles;
- configuration simulator for static requests;
- revocation-certificate materialization whose atomic consensus receipt freezes certificate identity, derivation, projection component, hash and deterministic-signature algorithm versions, and signing key, with component/key retention until the pending head is atomically made ready.

Exit criteria:

- the target core runs only isolated development/conformance traffic; V3 remains the sole production executor until Phase 2 and no compatibility translation exists between them;
- a direct logical model compiles to and invokes one exact deployment-wire-binding target;
- a supported OpenAI SDK reaches a direct model by changing only base URL, credential, and model;
- the same logical model can be published through two ingress wires without duplicating provider, model, or policy resources;
- TOML plan is non-mutating and a failed apply leaves the published revision unchanged;
- identical compiler inputs produce the same artifact/impact hash regardless of mutable retirement ACK progress;
- invalid capability, translation, reference-cycle, and policy configurations fail publication;
- a production-intended scheduled-price provider or processor target without a complete versioned billable-unit schedule and certified worst-case estimator fails publication; a contract-cap target instead fails without an immutable all-unit maximum, approved budget-attribution mode, and same-currency or contractually bounded settlement FX for every firm-budget actual source;
- every `resource_terminal` operation and any request operation needing an incomplete resource-lifecycle capability has a signed `unavailable` entry and cannot appear in discovery, grants, routes, resource profiles, or runtime resolution;
- provider and connector dispatch conformance plus the unavailable resource-reconciliation fixture pass exact deadline/derivation/time-source equality, strictly-before and equal/after boundary behavior, delayed/failover claims, canonical signed deadline-cancellation evidence, and cross-organization/workspace/request substitutions through cancellation evidence and terminal outcomes. Processor model fixtures additionally reject parent-request scope in place of the exact child-decision scope;
- a data-plane ring NACKs an unavailable component and continues serving its last-known-good revision without querying routing/config tables per request.

### Phase 2: Replatform current coding traffic and cut over atomically

Deliverables:

- `opendoor/coding-auto` classifier route and direct coding logical models;
- admitted, non-recursive classifier and remote-guardrail child requests with separate complete parent-invocation and exact service-principal target authorization decisions, budget, and evidence;
- migration of current OpenAI/Anthropic/Bedrock code into the wire-codec, translation-adapter, and provider-adapter boundaries;
- Codex and Claude Code harness configurators plus idempotent setup flows and an Opendoor-engineering onboarding profile;
- principal-owned state bindings for provider state created or returned by the supported request-terminal coding operations, including nonempty multi-reference compatibility/origin/action and common-slot credential authorization, inherited descendant continuation, sharing, affinity, a pre-egress binding barrier, validated response-ID activation, minimal request-state orphan ownership with one immutable upstream key binding, code-derived `recoveryNotAfter`, non-extendable recovery control, owner-discriminated request-state reconciliation lease, exact same-key activation, certified absence/expiry cleanup, and terminal tombstones. The recovery deadline is bounded by the original request deadline, certified provider retention, certification expiry, and policy cap and is rechecked at send-start. Standalone resource creation, indeterminate resource-cost ownership, resource reconciliation, and continuing provider liability remain unavailable rather than borrowing this request-state subset;
- single-region shared durable request-state bindings, exact state-retention leases, target-scoped creator registry/root-seal/absorption proofs, class-level creator/state-high-water retention generations, rollback-independent state-target retirement/cancellation, hard/session affinity, provider health, circuits, and a fenced hierarchical active-execution authority for multi-replica correctness;
- generalized request/decision-header/candidate-set/terminal-outcome/selected-target/attempt/usage evidence for external and processor-child work;
- existing prompt caching and compression behavior expressed as route/policy capabilities;
- ingress-wire-correct gateway errors and response headers;
- signed identity/credential and provider-credential-directory distribution, ring-keyed tuple-stamped routine rollout with fencing plus a recoverable quiesced V3-to-V4 barrier, one complete workspace narrowing chain with unique empty-overlay genesis, explicit semantic head hashing, atomic consensus receipts, recoverable certificate materialization, and subject-filtered deltas, organization/platform shared-resource fences and signed resumes, complete current-ring plus historical-live-authority proof sets, stage-complete code-compiled execution-dependency matching, signed authority-action receipts, hierarchical active-execution seals/drain proofs, absorption receipts, and certified Claude paired-header normalization;
- production provider credential-slot/set lifecycle, stable origin continuity requirements with rotatable successor certification, linearizable all-gate late-creator coverage receipts and directory floors, multi-lease common-slot evidence, exact-auth-source lifecycle-only retention, secret-manager and workload-identity materialization, per-slot health/quota/revocation, endpoint/network policy, and metadata-only capture defaults;
- minimum typed data-handling policy for classification, residency, retention, training use, and network eligibility plus parameter allow/default/cap/force/reject enforcement;
- code-owned pre-auth listener/source/TLS/auth-candidate and structural parsing limits, authenticated body/token/output quotas, incremental/decompression-safe parsing, bidirectional backpressure, per-session-event admission, and input/output guardrail release gates;
- production price and FX schedules/observations plus rounding policies for every reachable request-terminal provider and processor target; provider-charge/accounting amounts independent of budget presence; owner-discriminated conversions; one pre-slice signed actual-source contract and exact code-owned mapping version per request cost subject/rule/authority/scope/currency; signed runtime mapping evidence and reservation-independent source selection; selected-source-only settlement authorities through request quotes, allocations, and reservations; compiler/readmission-plan-bound per-slice sum/max trees with logical maximum-branch leases, fresh attempt allocations, exact partial/full/indeterminate retained-charge evidence, and code-derived retry/fallback readmission; cross-reservation canonical attribution partitions and component/contract/authority-bound original/correction conversion; period/contract-sliced quotes; immutable decision-owned selections; provider/connector attempt-progress CAS; fresh per-network-attempt runtime/credential/budget/dispatch authority; atomic request-envelope reservation bundles; exact request-terminal idempotency recovery authorization; and request-state-orphan control consumption for state-creating recovery. No Phase 2 target may declare `resource_terminal`, lifecycle reservations, resource reconciliation polling, resource recovery-bound extension, prepared/active/orphan resource-cost ownership, liability epochs, or resource invoice adjustment;
- enforcement-classed limits: operational shared rate/concurrency with fail-closed or fenced expiring allocations that prove a finite overshoot, plus a linearizable failover-durable firm admission authority for fenced rate/quota/concurrency and per-child/per-attempt request spend;
- durable cross-request idempotency records for enabled request-terminal write/state operations, including explicit in-progress/wait/fanout/replay behavior, terminal-provenance authorization for artifact replay and completed-result-unavailable, bounded encrypted artifacts, body conflict, request-terminal ambiguous-send fencing, immutable certification-hashed key bindings with a code-derived non-extendable recovery deadline, only certification-authorized same-key recovery with fresh authority and a trusted-time send-start check, request-state-orphan outcome/lease-set ownership and bounded single-control recovery/cleanup races, HMAC-key retention, signed terminal GC certificates, and atomic request-state binding linkage. Request-state leases structurally contain no lifecycle operation or continuing-liability authority. Resource-lifecycle reconciliation-retention leases, lifecycle-principal poll chains, resource-orphan bound extension/exhaustion, and cleanup supersession are Phase 4 gate requirements, not Phase 2 dependencies;
- tenant, same-workspace cross-principal and mixed-origin multi-binding state, origin-model/descendant continuation, impossible-binding-state/state-ID/idempotency/barrier-transaction failure, request-state orphan creation, same-key recovery/activation, repeated ambiguity, certified absence/expiry cleanup, recovery/recovery and recovery/cleanup races, crash before and after each transfer, request-attempt retry/fallback/terminalization races, policy/credential/admission cancellation, narrowing replay/staged-dependency/sealed hierarchical handoff, current-plus-historical-authority absorption, data/parameter/capture/guardrail narrowing, persistent organization/platform shared-resource fencing, unknown-extension/header, pre-auth flood/slow-auth, active revocation, lagging-gate creator rotation/continuity/exact-source compromise, tuple pinning and retired-ring/post-commit recovery, provider-prompt-cache affinity/target revocation, malicious upstream response, oversized/chunked/compressed/slow-upload/backpressure, bidirectional-session events, discriminated hidden processors, canonical request-cost attribution partition, budget conversion, compiler funding-plan/operator/allocation, actual-component substitution, partial contract-cap and request-cost correction settlement, period-boundary request-slice coverage, duplicate dispatch consumers, crash-before/after-send, reservation failover, and concurrent-budget security tests. The suite proves request-state orphan records cannot acquire resource lifecycle/funding/invoice fields and that every resource-terminal or continuing-liability operation remains absent from discovery, grants, routes, profiles, generated harness configuration, and runtime resolution;
- versioned OpenAI and Anthropic SDK conformance suites for direct and routed logical models;
- provider and processor-connector dispatch intents persist the exact code-derived minimum send deadline, deadline-derivation version, and trusted-time source; send-start must match all three values and occur strictly before the deadline, including after claim reassignment or worker failover, while deadline cancellation emits the canonical signed deadline-reached evidence. Their admission/progress/intent/authority/transition chains use exact organization/workspace/request-scoped composite keys. Resource reconciliation remains unavailable in Phase 2, but its gated conformance fixture must prove the identical deadline, evidence, and scoping contracts before Phase 4 can enable it;
- full current harness regression suite through the new core;
- rehearsed cutover manifests covering every live V3 configuration, credential/grant, supported request-state binding, session, request reservation/usage item, event, and outbox offset, plus signed zero-member or drained/expired disposition evidence for every unsupported provider resource and asynchronous job before activation;
- workspace-atomic production activation followed by removal of V3 schema, APIs, seeds, global tier types, and legacy execution code;
- Phase 2 request-state reconciliation leases, retention classes, and class index proofs carry one equal class ID/discriminant plus the exact request recovery/terminal-closure contract versions and no lifecycle-operation authority. Terminal-absence evidence is a target-codec classification of an already-authorized original or same-key attempt, never a hidden poll. A request-state binding remains `reconciling` until atomic activation or direct evidence-complete terminal cleanup; only resource-lifecycle bindings may use cleanup-retained tombstones.

Exit criteria:

- the threat model and production gates are approved; every member of every final traffic-receiving ring epoch ACKs the exact workspace/identity/provider-credential/narrowing/state-retention activation tuple and required components, all ring/ingress partitions complete the V3-to-V4 barrier, and only then does trusted ingress reopen on the new tuple; a member failure after commit is fenced/replaced within that ring without reopening V3;
- raw capture is off by default, secrets and provider credentials cannot enter ordinary telemetry/read APIs, and configured endpoint/network controls pass adversarial tests;
- the signed supported-operation capability set enables only certified request-terminal coding operations and their exact `request_state_binding` plus `request_state_orphan_recovery` requirements where state creation is reachable; default-deny model/operation/wire/interaction/provider/resource/processor-invocation/processor-target/state/data/parameter policy, input guardrails, and multi-replica firm limits are enforced before the first production provider call;
- multi-replica tests prove stateful/descendant continuation, retirement rollback safety, health/circuit exclusion, per-event active-session revocation, and hot-cache affinity do not depend on process-local state;
- current smoke/harness suites pass after the atomic cutover; the signed cutover manifest has no unresolved request authority, request reservation, or audit work, proves every unsupported provider resource or asynchronous job is absent or terminally drained/expired, and leaves no V3 configuration or legacy execution path;
- every request records workspace revision, identity/provider-credential directories, ring ID/activation tuple, append-only active-execution facts plus the CAS snapshot pointer, operation definition, optional logical model, ingress wire, initial/effective resolution, immutable decision header, normalized candidate epochs, canonical candidate cost valuation, root budget envelope/current snapshot, unique terminal outcome, and effective policy versions; each provider-bound attempt additionally records its selected target, current attempt-progress epoch, fresh provider-attempt admission with runtime/credential/quota evidence, one-time budget admission, matching dispatch intent and CAS claim/send state, complete quote-slice set/envelope snapshot, any exact upstream certification/recovery authorization, derived egress wire/connection/auth contract, provider-credential-directory generation, credential/creator coverage, external-identity/version evidence, and adapter versions;
- every processor invocation persists a signed minimized/redacted input ref and immutable intent before work, evaluates runtime target authorization before selection/dispatch, records canonical remote cost, and reaches one typed terminal outcome with an exact output ref when completed; each billable model or connector network attempt consumes one owner-scoped progress epoch and owns a fresh complete-or-empty sliced budget admission, matching dispatch intent, one-invocation immutable claim/send ledger, and cumulative retry headroom before network I/O, and no retry reuses them. Ambiguous request-terminal recovery requires exact upstream certification/authorization and fresh attempt authority; state-creating recovery additionally requires the exact request-state orphan/control/lease transfer, while unsupported certification or cleanup semantics compile unavailable. Before slicing, every budget subject/rule/authority/scope/currency freezes one shared source contract and mapping version; every slice carries its conversion and that contract. Aggregate holds derive from compiler/readmission-plan trees with logical branch leases and fresh attempt allocations. Actual request cost requires signed mapping evidence, one reservation-independent source selection, and one exact cross-reservation partition; settlement or correction consumes one unique component with recomputable conversion. Request terminalization requires complete attempt, dispatch, cost-source, attribution, settlement, reservation, and audit high-waters. The capability compiler rejects any Phase 2 artifact that would require prepared/active/orphan resource-cost ownership, resource reconciliation polling, lifecycle funding, continuing liability, or resource invoice adjustment;
- no fallback occurs after response commitment or across an incompatible state binding;
- coding traffic can use direct caller-selected models without classifier cost;
- editing a generated harness model setting cannot bypass the credential's logical-model entitlements.

### Phase 3: Enterprise access and constrained external onboarding

Deliverables:

- teams, service accounts, workload identity mapping, and SCIM/SSO integration;
- sponsored guest/partner principals with workspace scope, internal owner, expiry, and deprovisioning;
- team-composed expansion of the Phase 2 model/operation/provider/data/parameter/processor policies plus a richer effective-policy inspector;
- credential lifecycle review, automated rotation, ownership attestation, and broader workload-identity adoption;
- richer contract/discount price schedules, finance attribution UX, and provider-invoice reconciliation built on the Phase 2 reservation-grade pricing core;
- typed provider-prompt and exact-response cache policies with the conservative V1 eligibility rules;
- enterprise prompt-capture modes and access audit;
- `opendoor/coding-economy` as a total execution-plan contract whose visible terminals and hidden classifier/guardrail/connector targets all satisfy the external provider/model class and routing-overhead/request-cost ceilings;
- constrained external-engineering onboarding profiles and dedicated credentials that cannot access frontier models;
- a separately versioned Cowork harness configurator, supported-client matrix, secure token handoff, golden generated configuration, and real-client discovery/inference/streaming/cancellation/error conformance before any external onboarding profile enables Cowork;
- cache provenance purge, hidden-frontier-processor denial, complete-plan cost-bound, policy-bypass, and broader tenant-isolation tests.

Exit criteria:

- production services can authenticate without long-lived gateway API keys where infrastructure supports it;
- team/model entitlements and data constraints are enforceable and explainable;
- onboarding generates and supports configurations only for independently certified Codex, Claude Code, and Cowork versions; runtime safety comes from the external credential's economy entitlements, so replaying its bearer outside that client still leaves frontier model IDs undiscoverable and denied;
- publication proves `coding-economy` terminal/processor totality and the complete child-plus-terminal cost envelope for every classifier output after external policy narrowing;
- raw prompt capture is off by default;
- secrets never traverse ordinary read APIs or telemetry.

### Phase 4: General AI breadth

Deliverables, in order:

1. embeddings;
2. Azure OpenAI connection/deployments;
3. Vertex/Gemini native text and embeddings;
4. certified OpenAI-compatible self-hosted deployments;
5. image generation/editing;
6. audio transcription and speech;
7. reranking and moderation;
8. realtime sessions;
9. asynchronous batch/media jobs.

Each addition includes catalog facts, deployment discovery/config, access policy, limits, price units, native/translation contracts, errors, evidence, tests, console support, and operational runbook. Any model-less file or other provider-resource create endpoint also requires a published workspace resource profile, durable idempotency, state-binding barrier, and certified later-use compatibility.

Before the first Phase 4 operation declares `resource_terminal`, continuing provider liability, asynchronous provider work, or resource reconciliation, complete one resource-lifecycle capability gate. The gate includes prepared-to-active/orphan ownership transfer before caller-visible success or indeterminate completion; exact reconciliation-retention and state-retention leases; lifecycle-principal read-only poll chains; cumulative recovery count/horizon bounds, single-control fencing, exhaustion, strict extension deltas, and code-derived marginal-exposure funding; cleanup supersession; lifecycle quote/admission/reservation continuations across price, FX, contract, and budget periods; append-only valuation/liability components and invoice adjustments; terminal settlement-completeness certificates; failure/race/failover tests; live canaries; and a signed readiness receipt. Until that receipt is an input to compilation, every operation requiring any member of the gate has a typed `unavailable` capability entry and is absent from discovery, grants, routes, resource profiles, generated client configuration, and runtime resolution. Enabling one request-terminal Phase 4 operation does not implicitly enable this gate or any resource operation.

Exit criteria are per operation, not "endpoint responds." A provider/operation is production-ready only after certification and live canaries, and its signed capability entry names every satisfied lifecycle-gate receipt required by that exact operation.

### Phase 5: Scale, resilience, and advanced routing

Deliverables:

- durable high-volume traffic stream and projections;
- multi-region revision distribution and regional budget allocation;
- multi-region health/circuit/affinity coordination and advanced cache-affinity optimization;
- load and failure testing against SLOs;
- automated multi-region invoice import, anomaly matching, and adjustment reconciliation at traffic-stream scale;
- eval-backed quality scores and canary routing;
- optional semantic, complexity, or adaptive routing beyond coding;
- semantic caching only for evaluated use cases;
- reevaluation of Envoy/two-tier self-hosted inference routing.

Advanced routing comes last because it is only trustworthy when the candidate catalog, policy, price, health, and outcome evidence are trustworthy.

### 18.1 First three implementation slices

The first implementation program should be cut into reviewable vertical slices:

1. **Native Responses path:** register `openai.responses`, bind one deployment to that egress wire, publish one direct logical model, compile a signed capability set that enables only this certified request-terminal path, and invoke it from the supported OpenAI SDK through that revision.
2. **Second wire and certified translation:** publish that logical model on `anthropic.messages`, add one direct Messages-to-target translation adapter, prove feature-aware rejection and ingress-native streaming/errors, record both wire versions in evidence, and replace the capability set with a signed successor that enables only the two certified paths.
3. **Coding route and onboarding:** publish `opendoor/coding-auto`, execute its classifier through an admitted processor profile, add Codex and Claude Code harness configurators plus the Opendoor onboarding profile, and generate their local configuration from the exact signed capability set. Statically validate the external issuance template and compile/simulate `opendoor/coding-economy` against the onboarding profile's named synthetic principal context, but do not issue live external credentials until Phase 3 gates pass. Prove every incomplete operation remains typed `unavailable` and cannot leak through discovery, grants, routing, profiles, or generated configuration.

This proves the protocol, provider, model, policy, processor, publication, and onboarding boundaries before provider and operation breadth multiply the surface. Deployment pooling follows on the same route/deployment model without changing those contracts.

## 19. Verification and Certification Strategy

### 19.1 Contract test corpus

Maintain fixtures by operation, ingress API wire, egress API wire, contract versions, and feature. Text-generation coverage includes:

- simple system/developer/user/assistant text;
- multimodal inputs;
- single and parallel tool calls;
- streamed partial tool arguments;
- tool results and multi-turn continuation;
- structured output and schema errors;
- reasoning/thinking controls and encrypted/opaque blocks;
- refusals and safety stops;
- stop reasons and incomplete results;
- prompt-cache directives and usage;
- gateway state IDs plus upstream-binding behavior;
- hard-state continuation that skips classifier/soft-route work;
- certified stable session keys versus clients with `none` and per-request classification;
- Claude Code's equal bearer/`x-api-key` presentation plus unequal/duplicate rejection;
- context overflow;
- unknown fields and unknown stream events;
- client cancellation before headers, after headers, and after bytes;
- upstream HTTP errors and in-stream errors;
- missing, malformed, and delayed usage.

Other operations need their own corpora: vector dimensions/encoding for embeddings, multipart boundaries and binary integrity for media, ordering/scores for rerank, and session event state for realtime.

Operation-dispatch fixtures also prove that catalog requests never enter model routing, logical-model requests with hard state resolve every reference and enter exact-target execution before cache/classification, reusable resource bindings narrow the candidate universe before preflight while disabling exact cache, state-only actions cannot choose a new model, model-less creates require an authorized resource profile/target, retained actions continue using the binding's pinned profile/data/lifecycle/retention authority after ordinary publication removes it, retained continuations create only inherited descendants, and every state-creating unary or streamed response withholds its public/upstream ID until the durable binding and idempotency linkage activate.

### 19.2 Test layers

This is a cumulative certification catalog, not one monolithic Phase 2 release gate. A release runs the suites for the capabilities it enables plus negative tests proving every incomplete capability remains unavailable; resource-terminal suites become blocking only when an operation seeks the corresponding signed readiness receipt.

- unit tests for operation/wire registries, schemas, pure compiler/retirement-impact determinism, dispatch modes, selectors, policy composition, processor outcome ownership, and fixed-point price/FX interval arithmetic;
- golden request/response/stream translation tests;
- property/fuzz tests for client and malicious-provider parsers, unknown fields/events, compression expansion, oversized frames, and malformed/infinite streams;
- wire-codec, translation-adapter, provider-adapter/credential-slot, and processor-adapter/profile conformance tests against local fixtures, including boundary tests that provider adapters materialize only physical endpoint/auth/network/non-semantic-header controls, emit only typed transport observations, perform no implicit retry, and cannot interpret or serialize semantic/billing fields, safety policy, service tier, or framing while the target wire codec owns their extension schemas plus success/error/usage and SSE/WebSocket/multipart/event decoding. Feed semantic 429 bodies, success-status error envelopes, in-stream errors, and provider-reported usage through multiple physical adapters: only the target codec may change normalized outcome/usage, the orchestrator alone may combine that outcome with transport observations into retry policy, and adapter substitution cannot change chargeback or retryability;
- golden client-configuration tests for every supported harness configurator;
- supported-operation capability tests that recompute one complete entry per pinned operation-definition version, derive each exact capability/gate-version/evidence-contract requirement from the code-owned requirement manifest, and verify each readiness binding against the signed workspace receipt and certified operation set. Reject missing/duplicate/extra entries or capabilities, requirement-manifest substitution, a missing/extra/duplicate receipt binding, a receipt for another workspace/operation/capability, stale or future gate-version substitution, evidence-contract mismatch, an enabled entry with any unsatisfied requirement, or an unavailable entry exposed through discovery, grants, routing, profiles, generated configuration, or runtime resolution;
- live provider canaries using non-sensitive synthetic inputs;
- real SDK and harness compatibility smoke tests pinned to declared client versions;
- default-deny resource-profile and parent `processor.invoke` tests plus runtime service-principal `processor.execute` tests for exact model/connector targets; compiler output contains requirements/evaluation plans, never reusable authorization decisions. Missing, stale, expired, revoked, cross-profile, cross-input, cross-service-principal, or cross-target authorization substitution fails before selection/dispatch. Also cover processor child-decision ownership with copied candidate/selection aggregate rejection, complete route-preflight dependency/cardinality, hidden-frontier-child, dynamic route-totality, data/parameter bypass, and tenant isolation;
- existing-idempotency ordering tests proving claim occurs after authenticated caller-intent normalization but before normal resolution and first writes `claimed_unresolved`/`initializing` with dispatch disabled. No quote, child, credential, or dispatch is legal until the resolution/header and `dispatch_ready` provenance commit atomically. A duplicate observing initialization receives only generic progress/wait; initialization-crash recovery either completes provenance or writes `initialization_failed` terminal provenance without dispatch. Existing execution never resolves a current route or dispatches. Conflict, initializing, pending, indeterminate, wait timeout, pre-commit fanout, replay, unavailable result, and release denial each close their request decision header. A waiter must re-resolve and reauthorize terminal provenance after wake; every fanout frame needs current provenance/policy authorization; completed-result-unavailable needs a separate allowed no-artifact terminal authorization. Test artifact expiry and policy/narrowing revocation during wait, plus stale provenance, artifact/unavailability evidence, frame sequence/digest, exposure/provider mapping, and release-authorization substitution;
- processor-invocation tests proving the signed minimized/redacted `ProcessorInputRef`, immutable intent, active child, and child envelope exist before any candidate, quote, connector admission, child request, or remote work; pending, denied, in-process, and model-denied states contain no fake selection or reservation. Model quote/candidate/authorization/attempt/dispatch/retry and connector quote/admission/dispatch bind the same input ref, schema, artifact, transformation epoch, canonical request-cost valuation, and complete budget-slice set. A connector cannot dispatch without one consumed admission, matching immutable payload intent, open connector-attempt progress, and exclusive CAS send claim. Race two consumers; expire/reassign only pre-send claims; crash before claim, after claim, between durable `send_started` and socket write, and after possible send. Verify no second send occurs without exact current certification/recovery authorization plus a new same-invocation retry admission, fresh runtime/budget authority, new intent/dispatch chain, retained or settled prior allocation, and incremental slice headroom. Race retry/retry and retry/terminal on the connector progress epoch. Reject a second initial admission, forked/cross-invocation predecessor, reopened intent, wrong/expired certification, key-scope/payload/retention/response mismatch, or terminal outcome naming a nonfinal admission. Completed variants require a terminal-bound signed output ref; denied variants have none;
- execution-decision, attempt, and dispatch tests prove the immutable header commits before any quote/remote child and exactly one terminal outcome closes it; normalized candidates cannot be added after seal, selected while excluded, substituted, or disagree with exact state. Logical-route selection consumes chosen-branch membership, current feasibility, canonical cost, exact `BudgetQuoteSet`, and current envelope snapshot. One serializable transaction creates the initial selected target, open attempt progress, provider attempt, active child, fresh `ProviderAttemptAdmission`, budget admission, dispatch intent/ready authority, and credential records; partial creation or dispatch before commit fails. Between attempts, change circuit, capacity, concurrency, quota, narrowing, directory generation, slot eligibility, and slot quota: every same-target retry/fallback must obtain fresh consumptive evidence or a typed denial, never reuse selection feasibility. Race two dispatch consumers and verify one send-start winner; post-send crash becomes indeterminate. Expiry before send must atomically append `cancel_before_send` from ready/claimed state and permanently prevent later claim/send. Reject two dispatch roots, a projection not equal to the immutable chain head, invalid transition/predecessor, claim release or cancellation after send-start, send after cancellation, executor/fence substitution, or more than one invocation. Race retry/retry, retry/fallback, and retry/decision-terminal on one attempt-progress epoch; require one winner. Reject a fallback first attempt that does not name the predecessor selection's terminal progress/final attempt, plus cross-attempt runtime/budget/credential/intent substitution, quote-slice omission, parent/child slice mismatch, stale snapshot, partial allocation, empty-proof substitution, and concurrent allocation forks. Concurrent fallback permits one selected successor and terminal CAS derives both chains;
- transformation-readmission tests bind the successor `OperationResolutionRecord` to the exact transformation processor invocation, terminal outcome, signed output ref, transformed-envelope digest, codec-validation evidence, and readmission-policy decision bundle. Race a stale worker against a newly installed effective resolution/candidate set, including a transformation that changes logical routing to exact state. Cross-invocation/outcome/output/artifact/digest/schema/codec/policy substitution, missing revalidation, stale quote/envelope context, and terminalization against a superseded set or resolution fail; the terminal effective resolution equals the final set context;
- active-execution hierarchy tests reject a child with missing inheritance, a root carrying inherited state, a cross-root/cross-authority parent, and a stale parent snapshot; the accepted child and `child_initial` snapshot must be created atomically against the registered parent's then-current snapshot under the same root and authority;
- concurrency tests for canonical request valuations, period/contract-sliced quote sets, root/child envelopes, and resource preflight. Every billable request candidate/connector/reconciliation call and resource valuation retains separate provider/accounting amounts, exact FX observation/rounding provenance, and settlement with zero, one, or multiple budgets; lowest-cost selection cannot compare budget currencies or omit an unbudgeted candidate. Exercise a provider-EUR/accounting-USD/budget-GBP request and resource across FX publication, retry, and monthly boundaries. Before slicing, require one shared actual-source contract for each rule/authority/scope/target currency and exact equality to a code-owned mapping manifest ID/version/implementation hash. At runtime, verify signed mapping evidence binds the admitted contract, canonical source fingerprint, exact target/valuation, usage or invoice lineage, correction predecessor/sequence, selected component/currency/amount, and owner. Reject unknown/stale mapping versions, mapping implementation mismatch, source/valuation/target/usage/invoice/correction substitution, schedule reread, uncovered source currency, schedule-series/version escape, or mismatched conversion. When one canonical settlement contains both provider and accounting amounts, one reservation-independent source selection must govern all eligible period reservations: provider-charge admission selects only provider charge, accounting-cost admission only accounting cost, and contractual maximum only its pinned source. Race provider and accounting selections at a monthly boundary; exactly one source-group insert wins before attribution. For one $10 source crossing two monthly slices, event-time and proportional component sets must cover both reservation IDs and total exactly $10, never $10 per reservation. Concurrent duplicate attribution, an alternative-component selection, incomplete eligible reservation digest, copied parent amount, or component replay fails. For request-terminal work, exercise positive late invoice, negative credit, and chained restatement records in same and different currencies/periods; each correction must retain the original request/valuation/owner, use a unique predecessor and invoice line, create its own mapping-evidence/selection/attribution/settlement chain, and reject replay, skipped/forked sequence, resource-liability substitution, FX mismatch, or history rewrite. Resource invoice adjustments remain on their distinct liability-component chain.

  In one slice, combine mandatory children with different source currencies and terminal alternatives A=10 and B=8. Recompute the initial compiler plan, operand bijection, cardinalities, mutual-exclusion group, and exact root-reachable `sum`/`maximum` tree; shared capacity is 10, not 18, and remains contingent before lease. Race stable logical-branch reservations and lease acquisition: exactly one logical lease becomes spendable. Give every attempt a fresh subordinate allocation and reservation. Test no-charge A1 -> A2 under the same active lease with a higher lease version and no removal of A; chargeable A1 -> A2 with partial retained charge; full retained charge; and indeterminate retained maximum. Each chargeable retry must install a signed `BudgetFundingPlanReadmission` for `sum(retained_A, max(A_retry, B))` whose predecessor plan/derivation, allocation disposition, charge evidence, carried and fresh quote operands, current policy/preflight authorization, code-owned transformation version, successor operand/topology hashes, nested ancestor rewrite, snapshot CAS, and incremental headroom are exact. Test no-charge A -> B by disposing A's logical lease and reopening B, chargeable/indeterminate A -> B through `sum(retained_A, B)` with a direct single-choice branch and no unary maximum ledger, and terminal A without successor. Race A retry against A-to-B fallback and terminalization across attempt-progress, allocation, lease-version, ledger, derivation, and snapshot epochs; one wins. Reject attempt-owned leases, allocation reuse, sibling spend while A is leased, stale epochs, unsigned/opaque readmission, retained-charge omission, retained operand without canonical/indeterminate evidence, changed remaining inputs, additive or unary maximum, second active lease, wrong successor topology, or use of a superseded ledger. Cover nested maxima and partial/full/indeterminate retained amounts explicitly.

  Reject singular aggregate conversion, plan/topology/cardinality mismatch, cycle, duplicate input or operand, unreachable node, missing leaf, wrong operator, contingent/spendable mismatch, available-pool spend, sibling double consumption, signature mutation, or child mapping substitution. Exercise partial use of a contract-cap reservation followed by a later invoice correction in a different currency: admitted conversion remains `contractual_maximum`, while actual conversions use the same pinned component and exact mapping/selection lineage. Reject firm admission when any selected cross-currency actual-source entry has only operational overrun authority, and reject an open-ended contract cap without same-currency settlement or contractual FX ceiling included in the hold. Exercise a zero-budget EUR-provider/USD-accounting resource through selection, quote, initial/continuation epochs, liability components, usage/invoice settlement, and terminal reconciliation; missing or inconsistent accounting/FX provenance fails. Exercise an operational resource whose epochs use different FX observations and whose invoice adjustment adds another component; per-currency totals derive from the unique append-only component chain, never one aggregate conversion. Every intersecting period gets a distinct slice/quote/envelope member/allocation/reservation/attribution component/settlement and independent headroom/release. A boundary continuation consumes a fresh obligation-scoped lifecycle-funding admission whose quote, shared source contract, authority set, lifecycle bundle, allocation, and epoch name that obligation/admission with `requestId: null`. Reject cross-owner/obligation/quote/admission/allocation/epoch substitution, creating-attempt reuse, preserved expired slice digest, rule/slice mismatch, stale CAS, invalid signature, and `settled` with incomplete provider usage, source selection/attribution, liability, lifecycle funding, slice transition/settlement, terminal evidence, lease release, or invoice high-waters. Test lifetime USD plus monthly EUR plus cost-center attribution, all-slice rollback, fallback preservation, same/FX valuation, contract attribution, signed empty proof, a complete no-budget request, and a complete no-budget resource;
- identity/provider-credential-directory and state-retirement tests covering target-scoped root/descendant creator registration, a pre-block unresolved root racing `blocking_new_roots`, a resolved matching creator racing the registry high-water, post-block creation from an older retention generation, current plus historical authority root seals, terminal-only closure while sealed, drain through creator/registration/fact/snapshot vectors, and `blocking_all_creates`; class-level state/reconciliation retention generations prove creator plus separate lease high-waters, partition counts/digests, size independent of live-resource count, required-component ACK/NACK, routine pinned rollout, newly introduced slot stateless eligibility versus all-gate lifecycle coverage, lagging-gate fencing/follow-up readmission, ring drain/successor recovery, dual-empty dormant transitions, barrier tuple stamping, cancellation/recancellation, irreversible release, and component release;
- same-workspace cross-principal and nonempty multi-reference state authorization preserving every reference role/action/decision, origin-model equality, mixed-origin retained-entry resolution with a common physical slot, disjoint credential-slot intersection denial before upstream-ID decryption, per-binding lease/entry/certification attempt evidence, uniquely mapped resource-profile creation, binding-pinned profile/data/lifecycle/retention behavior after ordinary publication removal, overlapping-profile publication rejection, database/type rejection of every impossible unprepared/prepared-pending/request-state-reconciling/resource-reconciling/active/cleanup-retained/terminal binding combination including aborted-before-acceptance with an upstream ID or missing outcome, request-state/resource-orphan substitution, orphan cleanup evidence/state contradictions, pending-binding/idempotency failure/orphan cleanup, and cache-revocation tests;
- cross-request idempotency namespace/certified-cross-wire-equivalence, initializing/in-progress/wait-timeout/bounded-replay/fanout-before-first-byte/late-stream-duplicate/body-conflict/replay-artifact-expiry tests with exact-provenance current-policy reauthorization, plus type/database rejection of phase/provenance mismatch, pending/indeterminate records with terminal/GC-certified fences, terminal records with an open fence, or GC against nonterminal provenance. Cover linked binding, request-state orphan, resource obligation, reconciliation-lease retention, provider-outcome horizon, HMAC-key rotation, signed GC certificate, publication/default/transformation stability, and no raw token;
- request-state orphan tests create exactly one owner for an ambiguous request-terminal state-creating outcome before the binding leaves pending. The owner contains the exact binding/idempotency/selection/attempt/outcome/certification hash/key-binding hash/key/payload, code-derived `recoveryNotAfter`, provisional creator and credential registrations, complete outcome/lease-set high-waters and digests, one active owner-discriminated request-state reconciliation lease, request-scoped cost disposition, and `continuingProviderLiability: false`; it contains no resource exposure, liability, lifecycle operation, poll, funding, or invoice authority. Reject capability activation unless the operation has exact current same-key/shared-result certification plus terminal absence or provider-enforced expiry semantics. Derive the recovery deadline with each of the original request deadline, certified retention end, certification expiry, and policy cap as the shortest input in turn; reject an independently authored or extended deadline. Race two recovery authorizations against the available control, and race recovery against terminal cleanup: one epoch consumer wins. Every winning recovery gets fresh runtime, request-budget, attempt-progress, dispatch, outcome, and reconciliation-lease authority and copies the same deadline into authorization, lease, control, and intent. Test authorization/admission/send-start immediately before, exactly at, and after `recoveryNotAfter`, including a delayed claimed worker and failover worker: only the before-boundary transition may send. Expiry alone preserves the orphan/idempotency fence until terminal absence/provider-expiry evidence exists. A second ambiguous send atomically adds its outcome/lease to the same owner and returns the control available; definitive no-new-effect releases only that attempt lease. A shared terminal result atomically closes the control/orphan, terminalizes the complete outcome set, releases the complete lease set, transfers creator/credential ownership, creates the state lease, activates the original binding, and terminalizes idempotency before any ID/result release. Cleanup is legal only from available control with exact definitive nonacceptance/absence or certified provider-enforced expiry, and atomically releases every lease/registration plus terminalizes binding/idempotency. Test attempt-ceiling/recovery-deadline exhaustion, no extension, crash before/after each transition, stale certification, epoch, time source, key binding, or set digest, wrong key/payload/target/certification, incomplete lease release, double activation, cleanup while active, request-state/resource-lifecycle owner or field substitution, and any resource-lifecycle authority on this owner;
- resource-terminal per-attempt tests require reconciliation lease and prepared exposure containing attempt, provider-attempt admission, budget admission, dispatch intent, lifecycle start, quote, and initial epoch before I/O. Definitive first-attempt nonacceptance aborts that exposure, settles any chargeable request portion, and releases only proven-unused slice amounts; same-target retry is legal only after definitive nonacceptance and creates a distinct exposure/epoch. An ambiguous create always transfers the original exposure/outcome/lease to an orphan before polling, installs one signed initial recovery-bound version, and never creates a second create attempt even with an idempotency key. Race two recovery authorizations against one available orphan-control epoch: exactly one may atomically consume a nonempty interval of the remaining cumulative invocation allowance, advance the authorization-chain high-water/hash, and install its authorization/progress pointer; every admission/intent must match that active pointer, epoch, bound version, count interval, and deadline within the absolute horizon. Its exact resource certification and winning authorization create one bounded reconciliation-progress root plus a lifecycle request whose every poll has fresh service-principal target authorization, retained-credential proof, runtime/quota/narrowing, canonical request cost, complete-or-empty budget admission, immutable payload intent, and one-send dispatch authority. Race poll/poll and poll/terminal CAS, two dispatch consumers, local deadline/count exhaustion, orphan horizon/ceiling exhaustion, directory/narrowing changes, and crashes before claim, after claim, after `send_started`, after observation, and around activation. Prove exhaustion after N nonterminal observations, deadline expiry between polls, zero-dispatch expiry with exact pre-send cancellation closure, and exhaustion against next admission or cleanup; no case may create a synthetic attempt/admission/intent/outcome. Repeatedly exhaust and return to `available`, then issue successor authorizations until the orphan-level ceiling is reached; cumulative count never resets, deadlines never move beyond the bound horizon, authorization chain never forks, and the next authorization fails. Exercise an approved extension race with horizon-only, count-only, and combined deltas; exact marginal exposure must select no-budget proof, existing-reservation coverage, or incremental funding as applicable. Reject no-op/decreasing fields, fabricated count in a horizon-only extension, missing marginal funding, stale predecessor, count reset, or ordinary authorization that extends either bound. Exercise pre-claim and claimed-pre-send deadline expiry, policy invalidation, credential revocation, admission expiry, and cleanup through `cancel_before_send`, each with exact signed reason, terminal dispatch/execution, and settled or released budget but no fabricated codec observation. Non-cleanup cancellation terminalizes progress and returns the control to `available` without resetting its orphan bound. Race cleanup against `available`, ready, claimed, a recorded `definitive_not_sent` outcome before successor-poll admission, `send_started`, other outcome recording, activation, absence, exhaustion, and a next poll. Cleanup against active must first install `closing_cleanup` while retaining its pointers; no new admission may enter. Ready/claimed cleanup cancels then terminalizes `cleanup_superseded`. Recorded definitive-not-sent cleanup must use the dedicated supersession variant with the exact terminal attempt/outcome, transport proof, separate no-charge evidence, active-execution closure, complete budget disposition, and cleanup evidence. Post-send cleanup remains indeterminate and held until canonical request-cost attribution/settlement and every budget disposition complete. Reject `cleanup_terminal` while any referenced attempt, execution, cost, or allocation is open, or without the disposition-matching cleanup-supersession evidence; after all closure evidence, require one `closing_cleanup -> closed` winner. Also exercise codec not-yet-observable, codec definitive absence, and codec identity proof. Dispatched-attempt outcomes agree with codec/transport/cancellation evidence; the separate control-exhaustion transition agrees with its last completed head, counts, horizons, trusted time, and optional pending cancellation closure. A retryable outcome advances only through a fresh admitted intent and incremental budget headroom while control remains active. Absence/exhaustion/non-cleanup cancellation atomically returns the control to `available` with a new epoch and terminal predecessor, enabling a successor authorization only within remaining orphan capacity and without discarding the original liability. Only a target-codec-bound identity-proof observation may terminalize progress for activation and atomically move the original orphan binding and exposure to active. Race authorization/authorization, terminal/successor, extension/authorization, cleanup/activation, and two activation workers, and crash before/after every transition: require one signed orphan-to-active transfer or cleanup closure, one current liability owner, and exact equality of valuation, liability-component, funding, settlement, invoice, recovery-bound, cumulative-count, and authorization-chain high-waters. Reject polling before orphan ownership, create redispatch, second exposure, unadmitted or reused poll intent, admission against closing control, stale/mismatched control epoch or pointer, erased active chain, parallel progress roots, resettable or unbounded authorization reuse, cross-operation/target/outcome-schema certification, mismatched principal/predecessor/progress/admission/intent/outcome/observation/exposure/provider-outcome/lease/upstream identity, disposition/evidence mismatch, duplicate recovery, or any later component/settlement append to the transferred orphan. Cover final aborted tombstone, one-transaction provenance/binding/outcome/lease/credential/creator/exposure/envelope preparation, active/orphan transfer, ambiguous provider outcome with no unowned liability, provider-expiry versus contract cap, operational rolling funding, canonical dual-currency plus sliced budget epochs across price/FX/period boundaries, reconciliation request-cost settlement, completeness certification, cancellation/deletion/expiry, worker crash, binding-expiry independence, overrun, and final release;
- workspace-scoped single-chain narrowing epoch/hash replay with complete subject-filtered active sets; organization suspension versus persistent organization/platform shared-resource fencing; membership-high-water coverage of organizations/workspaces created after snapshot; deny-all versus exact-lease incident reconciliation that structurally selects an exact-auth slot or the namespace requirement's originating slot; resource-authority/local absorption followed only by signed resume; structured current-ring plus historical-live-authority ACK/seal sets or proven dual-empty dormant activation fences; canonical bounded-DNF compilation including `subject AND (target A OR target B)`, per-clause completeness stages, canonicalization/size bounds, and whole-workspace fallback; append-only fact and one-initial/same-reference/nondecreasing-stage/CAS-snapshot constraints that reject fact deletion, stage reset, snapshot fork, cross-reference predecessor, and parent-snapshot replacement; atomic one-authority deltas; limit/reservation epoch fencing; capture/cache/replay/state purge high-water receipts; code-derived plan/owner/matcher tamper rejection; missed-handoff deny-all; and pre-absorption seals racing fact append, snapshot CAS, authority restamp, local/cache release, child/attempt registration, retired-ring work, and async handoff across every execution kind. Partition every sealed hierarchy exactly once: matching, incomplete-stage, whole-workspace, and unknown work drains or aborts, while a long-running provably nonmatching hierarchy atomically moves every descendant to one signed absorbing binding and continues with unchanged fact/snapshot/dispatch/cost lineage. Reject partial-descendant restamps, stale binding CAS, false absent-atom proofs, gaps/duplicates across restamp and drain sets, child creation under the sealed binding, or delta removal before the signed partition receipt;
- narrowing-freshness tests partition the ordinary configuration publisher, revocation-authority leader, quorum/linearizable head store, certificate materializer, subscriber, gate, and active executor independently. Bootstrap an absent workspace through the unique null-predecessor `workspace_genesis` CAS and code-defined empty overlay; race two genesis commands, reject a nonempty/incorrect-generation genesis or an ordinary transition against an absent head, recover genesis after leader failover, materialize its certificate, and prove no first lease or serving admission exists before that certificate and the subsequently certified initial lease. For genesis, overlay publication, lease renewal, and authority failover, construct and verify the exact prepared-content -> atomic transition/head-plus-consensus-receipt CAS -> idempotent external-commit-certificate graph. The explicit head-state hash input excludes its own output plus all transition/receipt/certificate/signature/proof fields; canonical content hashes exclude their own hash/signature plus all transition/receipt/certificate/proof fields; versioned transition hashes exclude their own hash/signature plus all receipt/certificate/proof fields; versioned receipt and certificate hashes exclude their own hash/signature. The transition binds only the expected/successor semantic head and prepared content ID/hash; the unique receipt atomically binds that transition hash, successor head/index, prepared ref, and quorum proof; the unique certificate is a deterministic projection of the receipt. Crash after consensus before caller response and before certificate materialization, then recover from the receipt; race materializers and require one byte-identical certificate. A pending-certificate head admits neither serving nor a successor CAS, while recovery does not change its semantic head hash/index. Race overlay, renewal, and failover against one ready head: each committed transition consumes one exact head/index; overlay publication preserves the lease pointer; renewal preserves the exact overlay/delta/fanout values; and failover has null prepared content while installing a higher term/fencing token before issuance. Reject a receipt without its atomically matching head or vice versa, a duplicate receipt for one workspace/transition hash, a certificate for another receipt/content/transition/head/index, prepared-only content, transition-only publication, receipt-only serving, self-hash/signature inclusion, cyclic or unknown hash-domain input, divergent content/transition/receipt/certificate hash version, missed renewal, expired/not-yet-valid/overlong lease, validity beyond the authority term, stale or skipped predecessor, duplicate-parent fork, replay after restart, wrong workspace/time source/policy, lower term/index/overlay/fanout high-water, stale fencing token, omitted delta, and renewal from a partitioned stale authority. Admission and every active release point continue only with a monotonic unexpired lease content record joined to its exact ready certificate for the workspace, authority term/index/proof, authoritative overlay/hash, complete active-delta digest, and revocation-fanout high-water; verify wire-valid fail-closed admission/session/release while already-sent cost obligations remain reconciled;
- live-authority narrowing-coverage tests freeze partitions with zero, one, and many root bindings under one exact authority epoch/fencing token, root-binding registration high-water, and registry snapshot digest. Each nonempty authority ACK must contain one root-scoped seal per complete current binding with those exact values and an exact seal-set/high-water digest; an idle serving partition uses only the signed empty-hierarchy proof bound to the same values. Reject a singular seal for multiple roots, an omitted/duplicated/cross-authority binding, a false empty proof, a root/binding mismatch, registration above the frozen high-water, old-epoch/fencing-token substitution after failover, registry-snapshot substitution, and a workspace receipt whose seal set is not the disjoint union of every authority ACK;
- maximum-branch authority tests requiring every shared-capacity reservation to be a non-mutating candidate with only an observed ledger epoch/hash and the `BudgetMaximumBranchLease` to be the sole initial ledger/snapshot CAS authority. Lease acquisition must revalidate the selected reservation's observation and atomically create one unique sequence-zero `initial_acquisition` audit version plus its first subordinate allocation. The version must carry no CAS fields, reference the exact lease hash, and agree with the lease's ledger, reservation, logical branch, funding derivation, selected inputs, post-CAS snapshot, and initial-version pointer. Reject reservation creation that advances a ledger or snapshot, a reservation with successor-ledger fields, competing/double-applied CAS, a missing/synthetic initial version, non-null predecessor/disposition/readmission evidence on the root, a lease/version/allocation mismatch, two roots, first allocation bound directly to the lease without its version, or a continuation without the exact predecessor allocation disposition;
- retained-charge provenance tests deriving settled partial/full amounts only from exact same-slice/currency `BudgetCommitmentSettlement` rows and their validated actual conversions, attribution components, reservations, settled deltas, and overrun deltas; indeterminate amounts derive only from exact still-held admitted allocations/reservations. Reject missing/extra/replayed settlements or allocations, mismatched FX/authority/source/reservation/slice/currency, under- or overstated derived totals, an operand carrying an independent conversion/amount, evidence-set substitution, or successor headroom not recomputed from the evidence rows;
- recovery-extension derivation tests proving count-only and combined additional capacity equals `newCumulativeInvocationCeiling - predecessorCumulativeInvocationCeiling`, predecessor remaining capacity equals `max(predecessor ceiling - consumed count, 0)`, horizon-only preserves the ceiling exactly and revalues every remaining call across the new time/price/FX/budget periods, and combined extension values remaining plus added calls exactly once. The code-owned manifest, signed operands/cost vectors, quote, no-budget/existing-coverage/incremental-reservation proof, admission, and successor version all bind one valuation/hash and `extensionDeltaHash`. Reject any independently authored count, ceiling/remaining mismatch, horizon-only zero quote with remaining calls, missing/intersecting period slice, stale target/price/FX coverage, operand double count/omission, aggregate cost mismatch, marginal quote for different inputs, or manifest/hash substitution;
- per-event bidirectional-session ordering, replay, state action, input/output guardrail cardinality, incremental budget, cancellation, and backpressure tests;
- source/listener/TLS/auth-candidate flood and slow-auth tests plus oversized, deep/wide structured input, conflicting-length, chunked, compressed, decompression-ratio, multipart, slow-upload, large-frame, infinite-upstream, idle/duration, and bidirectional-backpressure tests before/after authentication and before provider response materialization;
- mutable-alias discovery tests proving production egress always receives the certified immutable release ID;
- provider credential-set publication, deterministic bounded selection, safe same-target slot retry with per-attempt lease/requirement transition, observed external-version evidence, rotation racing an older admitted request before and after slot selection, pre-dispatch all-admissible-gate directory coverage failure, public-handle release racing another rotation, new-slot creator denial while a lagging directory remains admissible, and A-origin state surviving A-to-B-to-C through fresh generation-specific certification without lease mutation. Retained-attempt tests require exactly one common-slot selection and separate per-lease membership/equality evidence whose lease-set digest and high-water are complete; they reject a copied evidence slot, omitted lease, set-nonmember, exact-source mismatch, incident-origin mismatch, common-selection substitution, ordinary/caller-continuation/current-successor escape, and inaccessible-state reconciliation. Cover exact-auth-source lifecycle retention, reconciliation-only mapping, and full slot/set compromise separately;
- load/soak tests measuring gateway overhead and backpressure;
- chaos tests for Redis, Postgres/control plane, telemetry, DNS, provider timeout, and partial streams;
- cutover-manifest tests proving every live authority/state/reservation/job/audit item has a disposition and no V3 or legacy path remains;
- certificate-materialization recovery tests proving the atomic consensus receipt freezes the projected certificate ID, ID/hash derivation versions, projection-component version, hash and deterministic-signature algorithm versions, and signing-key version. Crash with the head pending, deploy a new projection version, and rotate the active signing key: recovery must retain and use the receipt-pinned component/key, produce the byte-identical certificate and ID, and atomically mark the same semantic head ready. Reject a materializer that substitutes any current version/key, a second certificate ID/hash, premature component/key retirement, or a successor/serving gate against the pending head; release retention only after the ready projection is durable;
- reconciliation-retention class tests proving every lease carries one class ID and that lease, class, and class index proof have identical authority discriminants plus request-state recovery/closure contract versions or exact resource nulls. For request state, reject any lifecycle-operation member, executable terminal-observation operation, cross-class lease, hidden poll dispatch, or terminal-absence evidence not emitted by the target codec while classifying the already-authorized original/same-key attempt under the pinned evidence contract. Type/database tests also reject request-state `tombstoned_cleanup_retained`: ambiguity remains `reconciling` until the one atomic activation or terminal-cleanup transition;
- dispatch-deadline ownership tests for provider, processor-connector, and resource-reconciliation intents. Recompute `dispatchNotAfter` from every applicable request/invocation, runtime/credential/budget admission, authorization, same-key recovery, reconciliation, and orphan-horizon bound, then require intent and `mark_send_started` to match the exact derivation version and trusted-time source. Exercise initial and recovered connectors plus first and successor reconciliation polls immediately before, exactly at, and after each possible minimum bound, including a pre-expiry claim whose worker is delayed or replaced after expiry. Only the before-boundary CAS may send; equal/after, missing intent fields, independently widened transition deadlines, stale time-source evidence, and failover substitution must cancel before send. At and after the bound, require one signed `DispatchDeadlineReachedEvidence` whose scope, intent, authority, pre-cancellation head, deadline, derivation version, trusted-time source/evidence, and observed time all match; reconciliation additionally requires the matching `dispatch_deadline_reached` cancellation variant. Reject opaque, missing, early, stale-head, cross-intent, or independently authored deadline evidence;
- dispatch tenant-scope tests for provider, processor-connector, and resource-reconciliation chains. Require exact `(organizationId, workspaceId, requestId)` equality across execution-decision or processor-invocation intent/state, admission, attempt progress, intent, authority, every transition, deadline/cancellation evidence, terminal outcome, and signed output using composite scoped foreign keys. Substitute each otherwise-valid ID from another organization, workspace in the same organization, and request in the same workspace at every join; every case must fail before claim, send, cancellation, or terminalization. For a model-backed processor, require its terminal variant's scoped child-decision outcome and selected target to use the intent's exact `childRequestId`; reject the parent request, a sibling child, or a child decision from another scope.

### 19.3 Certification artifact

For each deployment and ingress promise, store:

- ingress/egress wire-codec, translation-adapter, and provider-adapter versions;
- operation-definition version, interaction mode, billing lifecycle plus firm-horizon or operational-rolling cost-plan contract, and ingress/egress API-wire versions;
- canonical model release, deployment, target-wire hosting-extension schema/codec ownership, physical provider-control schema, upstream-response safety profile, and required component hashes;
- supported feature profile;
- fixture-suite version and result;
- live canary timestamp/result;
- known limitations;
- approver and expiry/retest policy.

Model capability documentation without executable certification will drift.

Each processor-profile certification separately pins the profile/connector version, model plan or processor-adapter/in-process component hashes, typed schemas, minimization/redaction behavior, data/residency/capture contract, retry/error outcome envelope, invocation mode/cardinality, transformation expansion/effects when applicable, maximum cost, fixtures/canary, approval, and expiry. The invoking route, guardrail policy, or operation stage separately pins its terminal action for every allowed outcome.

An upstream-idempotency certification is narrower than provider or wire certification. It pins one exact provider target/operation/billing lifecycle or connector version; key namespace, derivation and account/project/tenant scope; byte/payload-equivalence contract; retention; concurrent-same-key behavior; terminal response semantics; fixtures for timeout/crash/concurrency/replay; and expiry. Resource-terminal certification names only one read-only registered reconciliation operation and typed outcome schema and cannot authorize create redispatch in V1. A separate recovery authorization bounds its lifecycle service principal, current lease owner, poll count/deadline, and progress root; each poll still requires fresh runtime, credential, cost/budget, payload, and dispatch admission.

### 19.4 Release gates

A new production provider or operation must pass:

- schema and threat review;
- secret/network review;
- native or translation conformance;
- ingress-wire-correct error and streaming tests;
- client-ingress and malicious-upstream resource-limit/backpressure tests;
- supported SDK/harness conformance for any affected SDK compatibility profile or harness configurator;
- usage and price validation;
- data-handling approval;
- policy and tenant-isolation tests;
- retry/fallback, attempt-progress race, and upstream-idempotency/recovery certification review;
- console and runbook readiness;
- live canary and rollback drill.

## 20. Risks and Mitigations

### 20.1 Configuration sprawl

**Risk:** Proxy recreates LiteLLM's broad but difficult-to-reason-about configuration through JSON blobs and duplicated entity fields.

**Mitigation:** typed policy kinds, code-owned wire/provider schemas, monotonic precedence, compiled workspace revisions, bounded route nodes, and no arbitrary runtime plugins.

### 20.2 Lowest-common-denominator API

**Risk:** broad translation causes provider capabilities to disappear or behave inconsistently.

**Mitigation:** native paths, explicit API-wire promises, per-edge certification, lossiness states, and early rejection of unsupported features.

### 20.3 Provider and model churn

**Risk:** model names, features, prices, and API versions change faster than the control plane.

**Mitigation:** discovery plus curated facts, immutable callable production release identities, discovery-only alias resolution, provenance, lifecycle dates, versioned prices/capabilities, canaries, operator overrides, and logical model stability.

### 20.4 Policy bypass through routing

**Risk:** fallback, model/hosting options, gateway preferences, request metadata, aliases, or stale config weaken organization policy.

**Mitigation:** closed-world request extensions, default-deny filtering before graph execution, admitted processor child requests, lower-level narrowing only, immutable revisions, revocation bounds, cache reauthorization, and adversarial policy tests.

### 20.5 Cost overrun

**Risk:** concurrent requests, long-lived provider resources, delayed usage, wrong prices, or retries exceed budgets.

**Mitigation:** linearizable failover-durable fenced request/resource reservations, owner-scoped provider/connector/reconciliation progress CAS, total-attempt/poll bounds, provider/contract-backed firm resource maxima, pre-dispatch prepared exposure with active/orphan ownership, persisted instance lifecycle times/deadlines, one-root contiguous operational valuation epochs with fresh obligation-scoped funding and certified period-slice replacement, exact source-to-budget conversion lineage, owner-discriminated reservation sources, per-epoch/invoice liability components, dual-currency price/FX/rounding provenance or approved contract-cap attribution, request-bound initial quotes, usage trust levels, admitted indeterminate reconciliation, and explicit firm/operational budget distinction.

### 20.6 Data-plane dependency failure

**Risk:** Postgres, Redis, telemetry, or control-plane failure interrupts inference or disables governance.

**Mitigation:** compiled last-known-good snapshots, explicit fail-closed or compiler-proven bounded-degradation policy per dependency, durable telemetry buffering, admission/reservation high-water recovery, and firm limits never degrading silently to local or TTL maps.

### 20.7 Scope explosion

**Risk:** "all AI" becomes simultaneous support for every provider, modality, guardrail, cache, agent feature, and billing concern.

**Mitigation:** enforce the product boundary, require complete operation slices, and prioritize text replatforming, embeddings, governance, and provider breadth before media/realtime.

### 20.8 Building a platform without adoption

**Risk:** the team builds an elaborate control plane that applications bypass for direct provider access.

**Mitigation:** provide excellent SDK compatibility and onboarding, centralize credentials and approvals, make logical models stable, publish SLOs, offer migration tooling, and make the gateway the easiest approved path. Track direct-provider exceptions and their owners.

### 20.9 Security concentration

**Risk:** one gateway becomes a high-value credential and data target.

**Mitigation:** workload identity, secret references, least privilege, network isolation, strict raw-data permissions, break-glass controls, security testing, and limited blast radius per connection/workspace.

### 20.10 License contamination

**Risk:** code copied from New API or separately licensed LiteLLM enterprise areas imposes incompatible obligations.

**Mitigation:** treat repositories as behavioral references, implement from official protocols and independent tests, retain a source register, and require legal review before code reuse.

## 21. Decisions Required Before Implementation

### 21.1 Must decide

1. **Customer boundary:** Is this permanently internal to Opendoor, or must the design support external customer organizations and billing?
   - Recommendation: optimize for internal Opendoor now while retaining hard organization isolation; do not build resale billing.
2. **Workspace meaning:** Is a workspace an application, environment, business unit, or arbitrary tenant subdivision?
   - Recommendation: application/environment policy boundary with typed `environment`, owner, and cost-center attributes.
3. **Initial provider set:** Which providers are contractually approved for which data classes?
   - Recommendation: OpenAI, Anthropic, Bedrock first; Azure OpenAI and Vertex/Gemini next; self-hosted OpenAI-compatible after certification tooling.
4. **Initial non-text operation:** Which general workload proves the new core?
   - Recommendation: embeddings.
5. **Identity authority:** Which IdP, SCIM groups, workload identities, and service-account registry are authoritative?
   - Recommendation: integrate existing company systems; do not create independent passwords or directory semantics.
6. **Data classifications and retention:** What classifications exist, who labels traffic, and which provider/deployment attributes are required?
   - Recommendation: credential/workspace default classification with a trusted request override that can only become more restrictive.
7. **Availability versus audit:** Must every production request have durable admission evidence before provider forwarding?
   - Recommendation: make control-plane audit strict; use a durable low-latency traffic stream and allow selected high-risk workspaces to require synchronous admission durability.
8. **Firm admission behavior:** Which rate, quota, concurrency, and budget dimensions are firm versus operational, and should firm exhaustion reject or queue?
   - Recommendation: make contractual/security ceilings and production spend firm; keep pre-auth abuse and adaptive capacity throttles operational only with fail-closed behavior or fenced, expiring, non-overlapping allocations whose fleet-wide overshoot is proven. Reject firm exhaustion by default. A cheaper route may be selected only before dispatch and within the cumulative reserved ceiling, never after a reservation denial. Use one linearizable fenced authority and fail closed when allocation/admission/reservation high-water cannot be proven.
9. **Expected scale:** QPS, concurrent streams, request/body sizes, regions, and target SLOs?
   - Recommendation: benchmark current Fastify before selecting a new data-plane substrate, but set explicit client-ingress and upstream-response encoded/decompressed/body/frame/output/deadline caps before any production traffic.
10. **Provider detail visibility:** May application owners see the actual deployment/provider, or only logical model and cost?
    - Recommendation: logical model for ordinary callers; physical details for authorized operators and request owners.
11. **SDK compatibility baseline:** Which OpenAI and Anthropic SDK versions, endpoints, interaction modes, and network bindings are a production contract?
    - Recommendation: support current organization-standard Python and TypeScript SDK versions first, publish a compatibility matrix, and gate upgrades on conformance tests.
12. **Declarative configuration authority:** Is Git/TOML or the console authoritative for each workspace/resource?
    - Recommendation: allow both per resource with explicit ownership, reconcile TOML one way into the versioned control plane, and never perform automatic bidirectional sync.
13. **Exact cache scope:** Which workloads may reuse responses across credentials or principals?
    - Recommendation: default to off; start with credential-scoped, stateless, non-streaming exact caching and require explicit data-policy approval for broader workspace scope.
14. **API-wire baseline:** Which wire IDs, contract versions, routes, headers, and feature profiles are the initial public compatibility contract?
    - Recommendation: start with `openai.responses`, `openai.chat_completions`, and `anthropic.messages`; pin exact versions through code-owned manifests and add Bedrock Converse as an egress wire before exposing provider-native Bedrock ingress.
15. **Harness compatibility baseline:** Which Codex, Claude Code, and Cowork versions and local configuration locations will Proxy own?
    - Recommendation: support organization-standard Codex and Claude Code versions first, treat Cowork as a separately certified client even when it shares Anthropic Messages, and require a previewed, idempotent setup flow.
16. **Lossy translation policy:** May a production logical model intentionally expose a lossy wire path?
   - Recommendation: not for any promised feature. Permit an explicitly labeled experimental logical model to opt into a named loss profile; never infer or silently apply loss.
17. **Credential freshness:** Which data-plane rings must ACK credential activation, and what maximum directory/narrowing-overlay staleness is allowed?
   - Recommendation: require every traffic-receiving production, regional, and canary ring to ACK activation and fail closed after a short measured narrowing bound; set the number from propagation tests, not preference.
18. **State sharing:** Can a provider-managed resource be shared across principals, and which actions and data classes permit it?
   - Recommendation: principal-owned by default; require an explicit action-scoped, expiring, audited ACL, let retained continuation create only inherited direct descendants, and do not support cross-model state migration in V1.
19. **Streaming output policy:** May a logical model buffer a streaming request for blocking inspection, or must it reject that combination?
   - Recommendation: declare one behavior in each wire promise; never release bytes while claiming a full-output blocking guarantee.
20. **Mutable model selectors:** Are upstream aliases such as `latest` ever permitted in production?
   - Recommendation: no. Resolve aliases only during discovery, publish a callable immutable release ID, and keep provider channels without one experimental/non-production.
21. **Internal processor authority:** Which classifier/guardrail profiles, model plans, non-model connectors, service principals, and failure modes are approved?
   - Recommendation: begin with one model-backed routing classifier and only required security-service connectors; compile exact parent `processor.invoke` and service-principal `processor.execute` requirements/evaluation plans, then produce current runtime decisions bound to the exact minimized/redacted input ref and selected deployment-wire-binding or connector. Require inherited target-class/cost/data constraints, complete route preflight/cardinality, input-bound quote/admission/dispatch/output evidence, and independent certification. Profiles own certified outcomes; route nodes, guardrail policies, and operation stages own their respective terminal actions.
22. **Session identity:** Which SDK/harness versions expose a trustworthy stable session key?
   - Recommendation: certify gateway state IDs or one registered opaque session token per client; declare `none` and classify per request when the client cannot provide one.
23. **Activation membership:** What constitutes a traffic-eligible data-plane ring and how is drain completion proven?
   - Recommendation: key explicit ready/unavailable membership epochs by organization, workspace, and ring, then have trusted generation-aware ingress stamp the exact ring/tuple/membership. Routine publication stages a tuple and routes only to matching active members while laggards are fenced by ring-local successor epochs; retired rings retain their live-execution authorities until sealed/drained or atomically migrated, and security removals prove ACK/drain across current traffic rings plus every historical live authority. Reserve global quiescence for the V3-to-V4 barrier or another approved migration invariant.
24. **Operation baseline:** Which exact operation-definition versions and resolution modes ship in the cutover?
   - Recommendation: enable `model.list` as `workspace_catalog`, current coding text generation as `logical_model`, and only the exact request-state actions required by the certified coding wires as `state_binding`. Keep general resource read/cancel/delete, model-less file/resource creation as `workspace_resource`, reconciliation, and `state_migration` typed `unavailable`; the resource actions and reconciliation require the Phase 4 resource-lifecycle gate, while migration remains a separate future contract.
25. **State durability:** Which durable store and transaction boundary implement request-state activation at coding cutover, and which additional cleanup, reconciliation, and orphan contracts gate later resource operations?
   - Recommendation: for Phase 2, use one serializable Postgres authority whose schema rejects impossible request-state binding states and atomically transitions selected execution, provider/connector attempt-progress CAS, fresh runtime/credential and request-cost/budget admission, idempotency provenance, immutable certification-hashed upstream key binding with code-derived `recoveryNotAfter`, certified request-terminal recovery authorization, binding/provider outcome, the minimal request-state orphan outcome/lease sets plus non-extendable available/active/closed control, exact same-key activation or certified absence/expiry cleanup, creator records, state-retention lease, sliced quote/envelope/funding-plan/logical-maximum-lease/attempt-allocation/readmission, dispatch intent plus immutable claim/send/cancel ledger and trusted-time send-start check, shared actual-source contracts, signed mapping evidence/source selection, and canonical request-cost attribution/settlement. Keep rollback-independent retirement epochs, a target-scoped linearizable creator registry, current/historical root-seal absorption proofs, creator/state/reconciliation-lease high-waters, durable cancellation, and class-level signed retention generations under a separate logical coordinator. The owner-discriminated request-state lease structurally has no lifecycle-operation set, and the orphan explicitly owns no continuing liability, resource-cost exposure, lifecycle poll/funding, or invoice authority. Before enabling the first Phase 4 resource-lifecycle capability, extend the authority with resource reconciliation attempt progress and leases, immutable resource-orphan recovery bounds plus available/active/closing/closed control CAS, attempt-scoped prepared exposure, active/orphan/aborted resource-cost ownership without an unowned interval, obligation-scoped lifecycle funding, one orphan-fenced read-only poll chain with fresh authority per invocation, non-resetting count/horizon, typed attempt outcomes and separate control exhaustion, strict code-derived extension funding, `closing_cleanup`, and the signed orphan-to-active transfer preserving every liability/funding/settlement/recovery high-water. Per-resource selected IDs and credential requirements stay in indexed leases, not distributed generations. Prove the request-state subset before coding cutover; prove the additional resource crash/race, cleanup, reconciliation, and artifact-size requirements only before a capability set enables resource-terminal work.
   - Request-state evidence boundary: bind every lease to one signed class and require the class/index proof to repeat its discriminant and recovery/closure contract versions. A terminal-absence contract classifies an already-authorized original or same-key response; it never authorizes a separate poll, and the binding stays reconciling until atomic activation or terminal cleanup.
26. **Emergency narrowing:** Which policy deltas can the overlay express and what scope receives a deny-all switch when a tightening cannot compile immediately?
   - Recommendation: use one complete hash chain per workspace, created by a unique null-predecessor empty-overlay genesis. Every later head transition requires a ready predecessor, and its quorum CAS atomically persists a unique consensus receipt so certificate materialization is idempotently recoverable after failover. Keep typed subject filters inside the active set and anchor every delta to one nonempty restriction/absorption authority. Keep organization/platform shared-resource fences effective for existing and newly created tenants until resource/local absorption plus signed resume; allow a compromised exact slot only through explicitly fenced lease-matched incident reconciliation, using the exact auth slot or namespace requirement's originating slot. Compile every action to canonical bounded DNF over the closed staged dependency vocabulary or match the whole workspace, treat an incomplete clause stage as affected, and retain each delta until action high-waters plus current/historical authority seals and registration/fact/snapshot vectors partition every hierarchy into an atomic provably-nonmatching restamp or matching/indeterminate terminal drain.
   - Certificate recovery boundary: the consensus receipt freezes certificate identity/derivation, projection component, hash and deterministic-signature algorithm versions, and signing key, and those inputs remain retained until an idempotent materializer makes the exact head ready.
27. **Credential issuance:** Which access profiles, credential forms, TTLs, and harness scopes may issuance templates reference?
   - Recommendation: templates reference one exact active access-profile version, optional exact narrowing policies, and issuance constraints only; issued credentials persist the fully expanded credential-scoped attachments and remain immutable until explicit rebind, rotation, or revocation. Harness scope controls supported setup, not bearer-key runtime attestation.
28. **Reservation-grade pricing and lifecycle:** Which price source, billable-unit schemas, worst-case or rolling estimators, usage trust levels, provider/contract hard cost bounds, terminal actions, firm resource maxima, and operational authorized-use/cleanup deadlines are approved for each enabled operation capability?
   - Recommendation: Phase 2 applies the request/attempt subset only; every resource-terminal clause below is a Phase 4 resource-lifecycle gate requirement, not a coding-cutover dependency. Persist separate provider-charge and accounting-currency amounts with exact FX observation/rounding provenance for every billable request/resource independently of budget presence. Before period slicing, each canonical cost subject and rule/authority/scope/target currency freezes one shared actual-source contract plus exact code-owned evidence-mapping version; every slice conversion and selected-source-only settlement authority references it. Request authority names the request; lifecycle authority names the exact obligation, quote set, and preallocated funding admission with `requestId: null`. Derive aggregate holds from exact compiler plan ID/hash and signed root-reachable `sum`/`maximum` trees. A maximum leases a logical route branch, not an attempt; every attempt owns a fresh subordinate allocation. No-charge same-target retry versions the lease in place. Partial, full, or indeterminate retained charge requires a signed, evidence-bound, code-derived readmission of `sum(retained_charge, max(same_branch_retry, remaining))`; fallback disposes the branch lease and either reopens siblings or readmits `sum(retained_charge, max(remaining))`. Retry/fallback/terminal paths share one CAS head. At actual cost, exact signed mapping evidence binds canonical source, target/valuation, usage/invoice/correction lineage, component, currency, and amount. One reservation-independent source selection per contract/source/rule/authority/scope/currency governs all eligible period reservations, and one attribution partitions it exactly once; this prevents mixed provider/accounting debit across monthly boundaries. Each settlement retains admitted conversion and consumes one unique component through an exact authority entry. Firm budgets reject operational FX bounds; an open-ended cross-currency contract cap requires a contractual FX ceiling. Expand every rule into one slice per intersecting period or permitted contract attribution and hold the complete initial set. Every network attempt owns fresh runtime/credential, slice-complete budget, payload, and exclusive send authority. After the Phase 4 gate, every resource-terminal attempt additionally owns its lifecycle start/quote/initial epoch/prepared exposure, so retry cannot inherit an aborted attempt. Transfer canonical liability and identical sliced coverage to one active/orphan obligation or definitive-nonacceptance tombstone. Append one conversion-bearing liability component per valuation epoch/invoice adjustment, derive totals by currency, and settle only with complete terminal, lease, source-selection, attribution, provider, slice, and invoice high-waters. Operational continuations use fresh obligation-scoped funding admissions and replace expired slices at certified boundaries. Gateway-managed deletion alone remains operational.
29. **Bidirectional safety:** Which session event actions and upstream response limits are certified for the initial Responses WebSocket support?
   - Recommendation: closed-world per-event admission in both directions plus absolute response/frame/output/idle/duration limits; no handshake-only authorization or unlimited stream.
30. **Cutover authority:** Who signs each workspace cutover manifest and which live artifacts may be drained/expired instead of migrated?
   - Recommendation: require owners for identity, state, finance, and audit dispositions; activate V4 only with zero unresolved authority/provider resources/reservations/outbox work.
31. **Cross-request idempotency:** Which wire operations expose caller tokens, how long are results retained, and how are indeterminate provider outcomes resolved?
   - Recommendation: certify namespace, caller-intent normalization, token scope, pending-collision behavior, bounded encrypted replay artifact, and cross-wire equivalence per wire. Claim into `initializing`/`claimed_unresolved` with dispatch disabled, atomically advance to complete `dispatch_ready` provenance with resolution/header, then append execution-bound and terminal provenance rather than nullable snapshots. Reauthorize exact current terminal provenance after waits, for every fanout frame, and before returning completed-result-unavailable with explicit no-artifact evidence. Create an exact reconciliation-retention lease before a write can be accepted; default streaming/unbuffered duplicates to in-progress; and never let a later client collision redispatch or garbage-collect an indeterminate write. Internal request-terminal recovery requires a distinct target/operation/key/payload/retention/concurrency/response certification, one immutable key binding whose recovery deadline is the minimum of the original request deadline, certified retention end, certification expiry, and policy cap, plus one durable recovery authorization and fresh attempt progress/budget authority. Admission and send-start recheck that same bound. For a request-terminal state create, transfer ambiguity into one request-state orphan with complete outcome/lease-set ownership, an owner-discriminated lease with no lifecycle operations, and no continuing liability; recovery consumes its non-extendable single control, and only the exact shared terminal result or certified absence/provider expiry may close it and activate or tombstone the original binding. Deadline exhaustion alone leaves the fence open. Resource-terminal create remains on the original exposure; its authorization may start only by consuming the resource orphan's available recovery-control epoch and remaining cumulative bound, and its exact-target lifecycle-principal poll chain gives every read-only invocation fresh runtime, retained credential, cost/budget, payload, and one-send authority. Successor resource authorizations cannot reset count or horizon; deliberate extension requires signed approval, a strict count/horizon/both delta, and exact marginal funding. Codec identity/absence, definitive-not-sent, sent-indeterminate, and signed pre-send cancellation are resource reconciliation attempt outcomes; count/time exhaustion is a separate signed progress/control transition over the last completed head and creates no synthetic attempt. Resource cleanup cannot erase an active chain: it installs `closing_cleanup`, prevents new polls, closes pre-send cancellation, already-recorded definitive-not-sent/no-charge, or sent-cost reconciliation through separate evidence variants, terminalizes progress as cleanup-superseded, and only then closes. Only a signed identity-proof observation can activate the original resource in V1.
32. **Provider credential lifecycle:** Who owns connection identity, credential slots, ordinary/lifecycle entries, rotation overlap, creator coverage, per-slot quota, compromise response, and provider-state continuity certification?
   - Recommendation: keep connections stable and secret-free; publish immutable slot/set versions and one signed directory; pin stable origin/namespace requirements in leases while each generation supplies current successor certification. Serialize creator registration with directory activation and the complete traffic-gate admission set, denying lifecycle creation until every still-admissible generation covers the requirement or is fenced; record the resulting directory floor on the lease and recheck all-gate coverage before handle release. Multi-binding retained attempts persist one authoritative common physical slot and per-lease membership/equality evidence that cannot copy or substitute it. Scope-wide narrowing blocks compromised ordinary/continuation access while optionally permitting only exact-lease incident reconciliation: the exact auth slot for exact-source state or the immutable originating slot carried by a namespace requirement, never an arbitrary current successor and never a pretense that inaccessible provider state was reconciled.
33. **Execution-decision authority:** What durable record owns pre-outcome work, normalized eligibility, selection, fallback, and final classification for caller requests and model-backed processor children?
   - Recommendation: resolve existing idempotency before normal operation resolution; otherwise persist one immutable owner header immediately after initial resolution and before quotes/children. Give every model-backed processor a separate input-bound child header. Normalize candidates into one initial plus same-decision CAS readmission epochs; require chosen-branch membership, current target feasibility, canonical cost, exact slice-complete quote set/current envelope snapshot, exact-state equality, and current processor target authorization. Permit one selected-target root with fallback CAS, but treat selection as strategic authority only. Atomically create one attempt-progress root plus a fresh consumptive provider-attempt admission, budget admission, dispatch intent/authority, and attempt exposure where applicable for every selected first attempt; same-target retry, fallback handoff, and terminalization consume that progress epoch so their races cannot fork. Close the header with one typed terminal outcome whose final selected ID equals the decision and attempt progress pointers.
34. **External dispatch ownership:** What prevents two workers or crash recovery from sending one admitted payload twice?
   - Recommendation: give every provider/connector/reconciliation intent one linearizable CAS authority whose current projection equals a closed immutable transition ledger and whose maximum invocation count is one. Reassign an expired claim only through a pre-send ledger transition; authorization expiry, policy invalidation, credential revocation, admission expiry, cleanup, or a reached `dispatchNotAfter` permanently cancels a ready/claimed intent through signed `cancel_before_send` evidence and terminalizes its execution/budget owner. The send-start CAS uses trusted time, so a claim obtained before a recovery deadline does not authorize a delayed or failover send at or after it. After durable `send_started`, the intent is permanently single-use and cancellation keeps cost indeterminate until reconciliation. An ambiguous request-terminal provider/connector recovery needs a first-class exact upstream certification, immutable key binding, durable authorization, fresh owner-scoped attempt progress/runtime/budget authority, identical key/payload, and the unextended recovery deadline; state-creating recovery also consumes the exact request-state orphan control and owns a fresh request-state lease until its typed closure. Resource-terminal create is never redispatched in V1; only one per-resource-orphan recovery-control owner may drive separately admitted read-only reconciliation intents over the original exposure/outcome/lease, every successor authorization consumes one non-resetting resource-orphan count/horizon contract, and cleanup retains that owner in `closing_cleanup` until the active chain is closed through disposition-specific evidence. Prefer a false-positive indeterminate outcome over duplicate write, resource, or charge.
   - Deadline and tenant ownership: persist the exact code-derived minimum `dispatchNotAfter`, deadline-derivation version, and trusted-time source on every provider, connector, and reconciliation intent. The send-start transition must copy all three values from the referenced intent and prove trusted time is strictly before that deadline; it cannot author, widen, or substitute them during recovery or failover. At or after the bound, cancellation requires the canonical signed deadline-reached evidence bound to the exact pre-cancellation head. Every normalized dispatch-chain join uses organization/workspace/request-scoped composite keys from decision/invocation state through admission, dispatch, evidence, terminal outcome, and signed output; globally resolving an otherwise valid ID is prohibited. A model-backed processor terminal separately binds the exact child-request decision tuple rather than reusing its parent scope.

### 21.2 Can defer

- semantic caching;
- adaptive quality routing;
- public gateway SDKs beyond compatibility endpoints;
- video generation;
- global active-active firm budgets;
- Envoy data plane;
- external customer billing;
- policy-engine adoption such as Cedar or Rego;
- prompt-management and eval-product integrations;
- arbitrary customer-defined provider adapters.

### 21.3 Architecture decisions to record

If this direction is accepted, create ADRs for:

- product boundary and non-goals;
- logical model versus deployment separation;
- separately governed canonical model catalog and immutable production release IDs;
- drop-in SDK compatibility and model-discovery contract;
- code-owned operation definitions, resolution modes, and their separation from API-wire/interaction-mode lifecycle;
- per-wire client-ingress/upstream-response limits, incremental parsing, decompression safety, and bidirectional backpressure;
- wire-codec, translation-adapter, and provider-adapter ownership boundaries;
- stable provider-connection identity versus immutable credential-slot/set versions, sole signed directory lifecycle, all-gate creator coverage, and per-lease retained-slot intersection;
- native-first certified translation and production loss policy;
- SDK compatibility profiles, harness configurators, credential issuance templates, secure credential handoff, and onboarding profiles;
- closed-world wire extensions, maker-model semantics, target-wire hosting-extension ownership, and physical provider-control boundaries;
- route V4 DAG, complete execution preflight, and policy/budget-before-classifier invariant;
- early existing-idempotency resolution; immutable external/processor execution-decision headers; effective-resolution/input-bound candidate-set/evaluation chains; chosen-branch and fenced runtime selection admissions; single-root selected-target/fallback authority; typed denial evidence; final-pointer terminal outcomes; and immutable processor intent/state/outcome separation;
- admitted classifier/remote-processor child requests and recursion limits;
- versioned processor profiles/connectors, separate parent-invocation/service-principal-target authorization, and inherited-constraint semantics;
- identity, team, principal, and credential semantics;
- identity/credential-directory and provider-credential-directory activation, generation-stamped ingress gating, effective-policy totality, narrowing epoch/hash-chain handoff, and freshness failure behavior;
- principal-owned provider state, nonempty aggregate binding-set/credential authorization, one-store prepared/active/orphan/aborted-before-acceptance activation, origin reauthorization, exact state-retention leases plus class-level monotonic generations, target-scoped creator registration/root-seal absorption, rollback-independent target retirement, and explicit sharing;
- typed policies and monotonic precedence;
- declarative TOML ownership and control-plane reconciliation;
- provider-prompt versus exact/semantic cache separation;
- compiled workspace revisions;
- component availability ACK/NACK, tuple-stamped routine activation, recoverable membership epochs, historical live-execution authority retention, explicit barrier activation, and monotonic rollback;
- enforcement-classed shared admission plus atomic per-authority/scope/currency request-wide, per-child/per-attempt, and resource-lifecycle budget commitment bundles;
- pre-slice actual-cost-source contracts, code-owned evidence mappings, reservation-independent runtime source selection, and exact cross-period attribution;
- logical maximum-branch leases with fresh attempt allocations, evidence-bound retained-charge operands, slice-complete deterministic funding-plan readmission, and retry/fallback/terminal CAS ownership;
- non-resetting orphan recovery bounds, strict count/horizon/both extension deltas with marginal funding, and between-polls control exhaustion distinct from attempt outcomes;
- pre-work execution-decision ownership and unique terminal outcomes; candidate-bound period/contract-sliced valuation quotes; request-terminal versus resource-terminal cost plans; firm expiry/contract attribution versus single-root bundled operational rolling obligations; all-or-none prepared-to-binding/orphan/aborted reservation-bundle transfer; and per-slice terminal reconciliation;
- reservation-grade price schedules, billable units, and usage trust;
- mandatory input/output guardrail ordering and streaming release guarantees;
- per-event bidirectional session admission;
- exact-cache authorization, provenance, revocation, and data lifecycle;
- append-only active-execution facts, same-reference CAS snapshots, hierarchy authority-binding chains, bounded-DNF narrowing matchers, sealed provably-nonmatching restamps versus matching/indeterminate drain, and registration/fact/snapshot absorption vectors;
- traffic telemetry versus control-plane events;
- enterprise prompt-capture defaults;
- live-authority cutover manifests and V4-only rollback boundary;
- Fastify-now/Envoy-later decision.

## 22. Success Measures

The gateway is succeeding when:

- application teams request stable logical models rather than manage provider keys and endpoints;
- supported OpenAI and Anthropic applications onboard by changing only base URL, gateway credential, and model ID;
- supported Codex and Claude Code versions onboard through one idempotent setup command and use the same logical models and policy engine as application code;
- exact-model calls do not pay classifier latency or cost;
- catalog and state-bound operations never enter a fabricated model route;
- coding traffic remains fully compatible on the generalized core;
- adding a provider deployment does not require editing shared policy or route types;
- adding an ingress API wire does not require changing provider connections or canonical model identities;
- adding a provider does not require implementing every ingress wire inside its provider adapter;
- adding an operation does not expand a universal request union;
- every published operation has exactly one signed capability entry, and an incomplete operation is unavailable across discovery, configuration, generated clients, and runtime rather than becoming partially reachable;
- `/v1/models` accurately reflects each credential's entitlements;
- every processor invocation has a pre-work immutable intent; every model-backed child has its own preexisting immutable decision header; every selection consumes a current chosen-branch/runtime admission for a sealed eligible candidate; and every header reaches one typed terminal outcome;
- every selection and exclusion is explainable from immutable versions and exact denial evidence;
- no fallback crosses data, state, feature, or credential constraints silently;
- economy credentials cannot reach frontier models directly or through hidden classifier/guardrail targets, and their complete request-cost ceiling holds;
- provider/model changes can be simulated, published, and rolled back without redeploying clients;
- TOML and console-managed resources produce the same compiled runtime representation with no ownership conflicts;
- firm rate, quota, concurrency, and budget limits hold across replicas and failover;
- cost attribution names the request, principal, workspace, logical model, deployment, usage trust, and price version;
- production prompt bodies are not stored by default;
- provider outages can be mitigated through approved failover without losing response-contract integrity;
- new providers and operations pass a repeatable certification process;
- state-target retirement cannot admit a late creator from an older request, and signed retention artifact size is independent of live-resource count;
- emergency narrowing atomically restamps complete provably nonmatching hierarchies, drains matching or indeterminate hierarchies, and cannot clear until one signed partition covers every hierarchy under each sealed authority binding;
- the data plane continues serving published traffic during routine control-plane outages.

Suggested program metrics:

- percentage of approved AI inference spend routed through Proxy;
- number of direct provider credentials retired;
- onboarding time for a new application and a new deployment;
- gateway-added latency and availability;
- provider failure recovery rate;
- policy denial and false-denial rate;
- unattributed or estimated-only spend percentage;
- stale catalog/price/certification age;
- configuration rollback frequency and time to recovery;
- percent of requests with complete revision/decision/attempt/usage linkage;
- count and age of direct-provider exceptions.

## 23. What Not to Build Yet

This list is deliberately blunt because it protects the core program:

- Do not copy every LiteLLM setting into a `settings JSONB` field.
- Do not build a generic visual programming language for routes.
- Do not force all requests through an LLM classifier.
- Do not use one canonical request object for every modality.
- Do not claim "OpenAI compatible" without versioned conformance tests.
- Do not silently drop provider-specific fields during translation.
- Do not fallback after bytes are sent or across provider-managed state.
- Do not relabel or migrate provider-owned state across logical models in V1.
- Do not let request BYOK fall through to organization credentials implicitly.
- Do not put provider keys in application-visible rows or logs.
- Do not make teams a substitute for organizations/workspaces.
- Do not put admin roles and model entitlements in one field.
- Do not store raw prompts by default.
- Do not enforce firm global limits with per-process maps.
- Do not make analytics Postgres writes a provider-availability dependency.
- Do not rewrite the transport on Envoy before measuring a need.
- Do not add every provider before the deployment/certification model is stable.
- Do not add semantic caching before privacy and correctness evaluation.
- Do not turn the gateway into agent orchestration, MCP execution, prompt management, or a reseller ledger.

## Appendix A: LiteLLM Feature-Coverage Map

The goal is use-case coverage with a clearer ownership model, not key-for-key compatibility.

| LiteLLM-style feature area | Proxy target | Priority |
|---|---|---|
| Model list / aliases | Canonical definitions, deployments, logical models | Core cutover |
| Call types / supported endpoints / model mode | API-wire registry + deployment wire bindings + compiled compatibility matrix | Core cutover |
| File and database configuration | Explicit resource ownership + TOML reconciliation into versioned database state | Core cutover |
| Provider parameters and credentials | Target-wire extension schemas for semantic parameters + stable connections + physical provider adapters + immutable credential slot/set versions + signed directory + exact secret refs | Core cutover |
| Weighted deployments | Pool selection | Core cutover |
| Retry and cooldown | Orchestrator classification over target-codec semantic outcomes and typed transport observations + route attempt policy + shared circuits | Core cutover |
| Fallbacks | Explicit deployment versus canonical-model fallback nodes | Core cutover |
| Context-window fallback | Hard capability/context filter plus explicit model fallback | Core cutover |
| Content-policy fallback | Data/guardrail policy plus explicit allowed branch | Governance phase |
| Latency/cost/usage routing | Pool strategies with trustworthy shared evidence | Later |
| Semantic/complexity/auto routing | Optional classifier nodes | Coding preset, expand later |
| Session affinity | State bindings + consistent hash | Current behavior migration |
| Prompt caching | Provider capability + route policy + usage evidence | Current behavior migration |
| Exact response caching | Conservative typed opt-in cache policy | Governance phase |
| Semantic caching | Separate high-risk opt-in policy | Later |
| RPM/TPM/concurrency | Firm admission or bounded-overshoot operational policies | Production cutover |
| Budgets | Request/attempt reservation and settlement at coding cutover; resource-lifecycle reservation, continuation, and settlement behind its readiness gate | Production coding cutover + Phase 4 resource gate |
| Allowed models | Default-deny typed access policies and filtered discovery | Core + production cutover |
| Teams/projects/users/keys | Org/workspace/team/principal/credential model | Governance phase |
| Guardrails | Ordered admitted processor policies with evidence | Production cutover + governance expansion |
| Spend logs | Request/attempt/usage ledger and analytics | Existing, extend |
| Audit logs | Control-plane events/outbox + sensitive-access audit | Existing, extend |
| Health checks | Adapter discovery/probes + deployment circuits | Existing, extend |
| Custom callbacks | OpenTelemetry and approved event sinks, not arbitrary hot-path code | Operations phase |
| OpenAI/Anthropic compatibility | Versioned native/translation graph | Existing, extend |
| SDK and coding-agent setup | SDK compatibility profiles + harness configurators + workspace onboarding profiles | Current behavior migration |
| Embeddings/images/audio/rerank/moderation | Separate operation modules | General breadth phase |
| Realtime and batch | Session/job execution modules | Later breadth phase |
| MCP and agents | Out of gateway core | Not planned |
| Public billing/top-ups | Out of internal gateway core | Not planned |

## Appendix B: Conceptual Runtime Types

These types illustrate boundaries. They are not an implementation-ready schema.

```ts
type NonEmptyArray<T> = [T, ...T[]];

type ApiWireRef = {
  wireId: string;
  contractVersion: string;
};

type OperationDefinitionRef = {
  operationId: string;
  contractVersion: string;
};

type ProviderCredentialRequirement = {
  providerConnectionVersionId: string;
  authContractVersion: string;
};

type CredentialContinuityRequirement =
  | {
      kind: "provider_state_namespace";
      providerStateNamespaceId: string;
      originatingCredentialSlotVersionId: string;
    }
  | {
      kind: "exact_auth_source";
      credentialSlotVersionId: string;
    };

type RetainedCredentialAuthorization =
  | {
      authorizationMode: "normal_lifecycle";
      usage: NonEmptyArray<"state_continuation" | "reconciliation">;
      incidentAuthorizationId: null;
      lifecycleServicePrincipalId: null;
    }
  | {
      authorizationMode: "incident_reconciliation";
      usage: ["reconciliation"];
      incidentAuthorizationId: string;
      lifecycleServicePrincipalId: string;
    };

type RetainedCredentialAccess = ProviderCredentialRequirement & {
    retainedCredentialAccessId: string;
  } &
  (
    | (Extract<
        RetainedCredentialAuthorization,
        { authorizationMode: "normal_lifecycle" }
      > & {
        continuityRequirement: Extract<
          CredentialContinuityRequirement,
          { kind: "provider_state_namespace" }
        >;
        credentialAccess: {
          kind: "certified_successor_set";
          credentialSetVersionId: string;
          continuityCertificationId: string;
        };
      })
    | (RetainedCredentialAuthorization & {
        continuityRequirement: Extract<
          CredentialContinuityRequirement,
          { kind: "exact_auth_source" }
        >;
        credentialAccess: {
          kind: "exact_credential_slot";
          credentialSlotVersionId: string;
        };
      })
    | (Extract<
        RetainedCredentialAuthorization,
        { authorizationMode: "incident_reconciliation" }
      > & {
        continuityRequirement: Extract<
          CredentialContinuityRequirement,
          { kind: "provider_state_namespace" }
        >;
        credentialAccess: {
          kind: "incident_originating_credential_slot";
          selectedFrom: "continuity_requirement_originating_slot";
        };
      })
  );

type CredentialLifecycleRequirementRegistrationBase = ProviderCredentialRequirement & {
  registrationId: string;
  organizationId: string;
  workspaceId: string;
  activeExecutionReferenceId: string;
  admittedProviderCredentialDirectoryGeneration: string;
  selectedCredentialSlotVersionId: string;
  continuityRequirement: CredentialContinuityRequirement;
};

type CredentialLifecycleRequirementRegistration =
  CredentialLifecycleRequirementRegistrationBase &
    (
      | { state: "provisional"; authorizingLeases: []; terminalEvidenceId: null }
      | {
          state: "transferred_to_lease";
          authorizingLeases: NonEmptyArray<
            | { kind: "state_retention"; leaseId: string }
            | { kind: "reconciliation_retention"; leaseId: string }
          >;
          terminalEvidenceId: null;
        }
      | { state: "released"; authorizingLeases: []; terminalEvidenceId: string }
    );

type CredentialLifecycleCoverageReceipt = {
  receiptId: string;
  organizationId: string;
  workspaceId: string;
  registrationId: string;
  creatorDirectoryGeneration: string;
  requirementRegistryHighWaterMark: string;
  trafficGateDirectoryAdmissionSetHighWaterMark: string;
  frozenAdmissibleDirectorySetHash: string;
  coveredAdmissibleDirectories: NonEmptyArray<{
    ringId: string;
    ingressGateId: string;
    servingMembershipEpoch: string;
    providerCredentialDirectoryGeneration: string;
    retainedCredentialAccessId: string;
  }>;
  minimumCompatibleProviderCredentialDirectoryGeneration: string;
  issuedAt: string;
  signature: string;
};

type StateLifecycleCreatorRegistrationBase = {
  registrationId: string;
  organizationId: string;
  workspaceId: string;
  activeExecutionReferenceId: string;
  executionTarget: ExecutionTargetRef;
  admittedStateRetentionGeneration: string;
  observedRetirementEpoch: string;
  creatorKind: "root" | "direct_descendant";
  parentStateBindingIds: string[];
  registrationSequence: string;
};

type StateLifecycleCreatorRegistration = StateLifecycleCreatorRegistrationBase &
  (
    | { state: "provisional"; stateRetentionLeaseId: null; terminalEvidenceId: null }
    | {
        state: "transferred_to_state_lease";
        stateRetentionLeaseId: string;
        terminalEvidenceId: null;
      }
    | { state: "released"; stateRetentionLeaseId: null; terminalEvidenceId: string }
  );

type ProviderCredentialDirectoryGeneration = {
  organizationId: string;
  generation: string;
  previousGenerationHash: string;
  admittedRequestReferenceHighWaterMark: string;
  lifecycleCreatorRequirementHighWaterMark: string;
  stateLeaseRequirementHighWaterMark: string;
  reconciliationLeaseRequirementHighWaterMark: string;
  trafficGateDirectoryAdmissionSetHighWaterMark: string;
  ordinaryMappings: Array<
    ProviderCredentialRequirement & {
      credentialSetVersionId: string;
    }
  >;
  retainedAccess: RetainedCredentialAccess[];
  signature: string;
};

type GatewayOperationCapability =
  | "request_terminal_execution"
  | "request_terminal_cost_and_budget"
  | "request_state_binding"
  | "request_state_orphan_recovery"
  | "resource_lifecycle_ownership"
  | "resource_orphan_recovery"
  | "resource_lifecycle_funding"
  | "resource_invoice_adjustment";

type GatewayOperationCapabilityRequirementManifestRef = {
  capabilityRequirementManifestId: string;
  capabilityRequirementManifestHash: string;
};

type GatewayOperationCapabilityRequirement = {
  capability: GatewayOperationCapability;
  capabilityGateVersionId: string;
  evidenceContractVersionId: string;
};

type GatewayOperationCapabilityRequirementManifest =
  GatewayOperationCapabilityRequirementManifestRef & {
    registryKind: "code_owned";
    operationDefinitionVersionId: string;
    requirements: NonEmptyArray<GatewayOperationCapabilityRequirement>;
    requirementSetDigest: string;
    conformanceFixtureSetDigest: string;
    publishedArtifactDigest: string;
    signatureKeyVersionId: string;
    signature: string;
  };

type GatewayCapabilityReadinessReceipt = {
  gatewayCapabilityReadinessReceiptId: string;
  organizationId: string;
  workspaceId: string;
  capability: GatewayOperationCapability;
  capabilityGateVersionId: string;
  evidenceContractVersionId: string;
  certifiedOperationDefinitionVersionIds: NonEmptyArray<string>;
  certificationEvidenceSetDigest: string;
  liveCanaryEvidenceIds: string[];
  approvedByPrincipalId: string;
  issuedAt: string;
  receiptHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type GatewayCapabilityReadinessReceiptBinding = {
  capability: GatewayOperationCapability;
  capabilityGateVersionId: string;
  evidenceContractVersionId: string;
  gatewayCapabilityReadinessReceiptId: string;
  gatewayCapabilityReadinessReceiptHash: string;
};

type CompiledOperationCapabilityEntryBase = {
  operationDefinitionVersionId: string;
  billingLifecycle: "request_terminal" | "resource_terminal";
  capabilityRequirementManifest: GatewayOperationCapabilityRequirementManifestRef;
  capabilityRequirements: NonEmptyArray<GatewayOperationCapabilityRequirement>;
  entryHash: string;
};

type CompiledOperationCapabilityEntry =
  CompiledOperationCapabilityEntryBase &
    (
      | {
          capabilityState: "enabled";
          readinessReceiptBindings: NonEmptyArray<GatewayCapabilityReadinessReceiptBinding>;
          readinessReceiptSetDigest: string;
          missingCapabilities: [];
          unavailableReasonCode: null;
        }
      | {
          capabilityState: "unavailable";
          readinessReceiptBindings: GatewayCapabilityReadinessReceiptBinding[];
          readinessReceiptSetDigest: string;
          missingCapabilities: NonEmptyArray<GatewayOperationCapability>;
          unavailableReasonCode: "capability_gate_incomplete";
        }
    );

type WorkspaceSupportedOperationCapabilitySet = {
  workspaceSupportedOperationCapabilitySetId: string;
  organizationId: string;
  workspaceId: string;
  workspaceRevisionId: string;
  operationDefinitionRegistryVersionId: string;
  operationDefinitionRegistryManifestHash: string;
  operationDefinitionSetDigest: string;
  capabilityRequirementManifestSetDigest: string;
  entries: NonEmptyArray<CompiledOperationCapabilityEntry>;
  entrySetDigest: string;
  compiledAt: string;
  setHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type WorkspaceActivationTuple = {
  activationTupleId: string;
  organizationId: string;
  workspaceId: string;
  workspaceRevisionId: string;
  workspaceSupportedOperationCapabilitySetId: string;
  workspaceSupportedOperationCapabilitySetHash: string;
  identityDirectoryGeneration: string;
  providerCredentialDirectoryGeneration: string;
  minimumNarrowingOverlayGeneration: string;
  stateRetentionGeneration: string;
  stateTargetRetirementHighWaterMark: string;
  requiredComponentManifestId: string;
  activationMode: "pinned_rollout" | "barrier_cutover";
  committedAt: string;
  signature: string;
};

type ServingMembershipEpochBase = {
  organizationId: string;
  workspaceId: string;
  ringId: string;
  membershipEpoch: string;
  previousMembershipEpoch: string | null;
  activationTupleId: string;
  fencedMemberIds: string[];
  signature: string;
};

type ServingMembershipEpoch = ServingMembershipEpochBase &
  (
    | {
        capacityState: "ready";
        activeMemberIds: NonEmptyArray<string>;
        capacityFloorProofId: string;
        unavailableReason: null;
      }
    | {
        capacityState: "unavailable";
        activeMemberIds: [];
        capacityFloorProofId: null;
        unavailableReason: string;
      }
  );

type ActiveExecutionAuthorityStamp = {
  ringId: string;
  servingMembershipEpoch: string;
  workspaceRevisionId: string;
  identityDirectoryGeneration: string;
  providerCredentialDirectoryGeneration: string;
  narrowingOverlayGeneration: string;
  admissionNarrowingFreshnessLeaseContentId: string;
  admissionNarrowingFreshnessLeaseContentHash: string;
  admissionNarrowingFreshnessLeaseSequence: string;
  admissionNarrowingFreshnessLeaseCommitCertificateId: string;
  admissionRevocationAuthorityTerm: string;
  admissionRevocationCommittedIssuanceIndex: string;
  admissionRevocationCommittedHeadProofId: string;
  stateRetentionGeneration: string;
  effectivePolicyFingerprint: string;
};

type NarrowingDependencyRef =
  | { kind: "principal"; id: string }
  | { kind: "gateway_credential"; id: string }
  | { kind: "workspace_grant"; id: string }
  | { kind: "policy_scope"; id: string }
  | { kind: "policy_version"; id: string }
  | { kind: "logical_model"; id: string }
  | { kind: "canonical_model_release"; id: string }
  | { kind: "certification"; id: string }
  | { kind: "operation_definition"; id: string }
  | { kind: "api_wire"; id: string }
  | { kind: "interaction_mode"; id: "unary" | "stream" | "session" | "job" }
  | { kind: "provider_connection_version"; id: string }
  | { kind: "model_deployment_wire_binding"; id: string }
  | { kind: "provider_resource_target"; id: string }
  | { kind: "region"; id: string }
  | { kind: "credential_slot_version"; id: string }
  | { kind: "credential_set_version"; id: string }
  | { kind: "state_action"; id: string }
  | { kind: "state_lineage"; id: string }
  | { kind: "resource_profile_version"; id: string }
  | { kind: "resource_kind"; id: string }
  | { kind: "resource_purpose"; id: string }
  | { kind: "resource_action"; id: string }
  | { kind: "processor_profile_version"; id: string }
  | { kind: "processor_connector_version"; id: string }
  | { kind: "data_classification"; id: string }
  | { kind: "network_class"; id: string }
  | { kind: "parameter"; operationId: string; parameterId: string }
  | { kind: "rate_limit_rule"; id: string }
  | { kind: "budget_rule"; id: string }
  | { kind: "capture_policy"; id: string }
  | { kind: "guardrail_stage"; id: string };

type ActiveExecutionDependencyStage =
  | "ingress"
  | "parsed"
  | "resolved"
  | "policy_admitted"
  | "cache_checked"
  | "target_bound"
  | "release_ready";

type ActiveExecutionDependencyFact = {
  dependencyFactId: string;
  activeExecutionReferenceId: string;
  mutationSequence: string;
  dependency: NarrowingDependencyRef;
};

type ActiveExecutionDependencySnapshotBase = {
  dependencySnapshotId: string;
  activeExecutionReferenceId: string;
  completedThroughStage: ActiveExecutionDependencyStage;
  mutationSequence: string;
  dependencyFactHighWaterMark: string;
  snapshotHash: string;
};

type ActiveExecutionDependencySnapshot = ActiveExecutionDependencySnapshotBase &
  (
    | {
        transitionKind: "root_initial";
        completedThroughStage: "ingress";
        previousSnapshotId: null;
        previousSnapshotHash: null;
        inheritedParentReferenceId: null;
        inheritedParentSnapshotId: null;
      }
    | {
        transitionKind: "child_initial";
        completedThroughStage: "ingress";
        previousSnapshotId: null;
        previousSnapshotHash: null;
        inheritedParentReferenceId: string;
        inheritedParentSnapshotId: string;
      }
    | {
        transitionKind: "continuation";
        previousSnapshotId: string;
        previousSnapshotHash: string;
        inheritedParentReferenceId: null;
        inheritedParentSnapshotId: null;
      }
  );

type ActiveExecutionAuthorityBindingBase = {
  activeExecutionAuthorityBindingId: string;
  organizationId: string;
  workspaceId: string;
  ringId: string;
  ingressPartitionId: string;
  rootReferenceId: string;
  bindingSequence: string;
  authorityStamp: ActiveExecutionAuthorityStamp;
  authorityStampHash: string;
  bindingHash: string;
  boundAt: string;
  signatureKeyVersionId: string;
  signature: string;
};

type ActiveExecutionHierarchyNonmatchProof = {
  activeExecutionHierarchyNonmatchProofId: string;
  organizationId: string;
  workspaceId: string;
  narrowingDeltaId: string;
  activeExecutionEpochSealId: string;
  rootReferenceId: string;
  compiledNarrowingMatcherHash: string;
  sealedNonterminalReferenceIds: NonEmptyArray<string>;
  sealedNonterminalReferenceSetDigest: string;
  dependencyFactClosureDigest: string;
  currentDependencySnapshotSetDigest: string;
  closedClauseNonmatchEvidenceIds: NonEmptyArray<string>;
  evaluationResult: "provably_nonmatching";
  evaluatedAt: string;
  proofHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type ActiveExecutionAuthorityBinding = ActiveExecutionAuthorityBindingBase &
  (
    | {
        bindingTransitionKind: "initial_registration";
        predecessorActiveExecutionAuthorityBindingId: null;
        predecessorActiveExecutionAuthorityBindingHash: null;
        narrowingDeltaId: null;
        activeExecutionEpochSealId: null;
        migratedActiveExecutionReferenceIds: [];
        migratedReferenceSetDigest: null;
        expectedCurrentBindingSetDigest: null;
        expectedCurrentDependencySnapshotSetDigest: null;
        hierarchyNonmatchProofId: null;
      }
    | {
        bindingTransitionKind: "narrowing_nonmatching_restamp";
        predecessorActiveExecutionAuthorityBindingId: string;
        predecessorActiveExecutionAuthorityBindingHash: string;
        narrowingDeltaId: string;
        activeExecutionEpochSealId: string;
        migratedActiveExecutionReferenceIds: NonEmptyArray<string>;
        migratedReferenceSetDigest: string;
        expectedCurrentBindingSetDigest: string;
        expectedCurrentDependencySnapshotSetDigest: string;
        hierarchyNonmatchProofId: string;
      }
  );

type ActiveExecutionReferenceBase = {
  activeExecutionReferenceId: string;
  organizationId: string;
  workspaceId: string;
  ringId: string;
  ingressPartitionId: string;
  sequence: string;
  rootReferenceId: string;
  registeredAuthorityBindingId: string;
  currentAuthorityBindingId: string;
  currentAuthorityBindingHash: string;
  authorityBindingEpoch: string;
  currentDependencySnapshotId: string;
  ownershipEpoch: string;
  state: "active" | "transferred" | "terminal" | "aborted";
};

type ActiveExecutionReference = ActiveExecutionReferenceBase &
  (
    | {
        hierarchyKind: "root";
        kind: "request";
        parentReferenceId: null;
        registeredParentSnapshotId: null;
      }
    | {
        hierarchyKind: "child";
        kind:
          | "upload"
          | "processor_child"
          | "provider_attempt"
          | "stream_or_session"
          | "async_action_or_result";
        parentReferenceId: string;
        registeredParentSnapshotId: string;
      }
  );

type ActiveExecutionEpochSeal = {
  sealId: string;
  organizationId: string;
  workspaceId: string;
  ringId: string;
  ingressPartitionId: string;
  rootReferenceId: string;
  sealedActiveExecutionAuthorityBindingId: string;
  sealedActiveExecutionAuthorityBindingHash: string;
  sealedAuthorityStampHash: string;
  issuingAuthorityEpoch: string;
  issuingAuthorityFencingToken: string;
  frozenAuthorityBindingRegistrationHighWaterMark: string;
  frozenAuthorityBindingRegistrySnapshotDigest: string;
  sealSequence: string;
  finalRegistrationSequenceHighWaterMark: string;
  finalDependencyFactHighWaterMark: string;
  finalDependencySnapshotHighWaterMark: string;
  state: "acked";
  signature: string;
};

type LiveExecutionAuthorityRef = {
  ringId: string;
  ingressPartitionId: string;
  authorityEpoch: string;
  authorityFencingToken: string;
  historicalRingState: "traffic_receiving" | "retired_with_live_work";
  nonterminalSequenceHighWaterMark: string;
};

type EmptyActiveExecutionHierarchySetProof = {
  emptyHierarchySetProofId: string;
  organizationId: string;
  workspaceId: string;
  authority: LiveExecutionAuthorityRef;
  frozenAuthorityBindingRegistrationHighWaterMark: string;
  frozenAuthorityBindingRegistrySnapshotDigest: string;
  provenRootBindingCount: 0;
  proofHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type RequestContext = {
  requestId: string;
  organizationId: string;
  workspaceId: string;
  ringId: string;
  principalId: string;
  credentialId: string;
  identityDirectoryGeneration: string;
  providerCredentialDirectoryGeneration: string;
  narrowingOverlayGeneration: string;
  stateRetentionGeneration: string;
  ringMembershipEpoch: string;
  activationTupleId: string;
  activeExecutionReferenceId: string;
  effectivePolicyFingerprint: string;
  workspaceRevisionId: string;
  operation: OperationDefinitionRef;
  ingressWire: ApiWireRef;
  interactionMode: "unary" | "stream" | "session" | "job";
  logicalModelId: string | null;
  featureRequirements: Record<string, boolean | number | string>;
  trustedMetadata: Record<string, string>;
};

type ModelDeploymentWireBindingRef = {
  kind: "model_deployment_wire_binding";
  deploymentWireBindingVersionId: string;
};

type ProviderResourceTargetRef = {
  kind: "provider_resource_target";
  resourceTargetVersionId: string;
};

type ExecutionTargetRef = ModelDeploymentWireBindingRef | ProviderResourceTargetRef;

type StateCreatorRootSeal = {
  stateCreatorRootSealId: string;
  retirementId: string;
  organizationId: string;
  workspaceId: string;
  rootActiveExecutionReferenceId: string;
  authority: LiveExecutionAuthorityRef;
  executionTargetSetHash: string;
  blockedCreatorKinds: NonEmptyArray<"root" | "direct_descendant">;
  inclusionReason:
    | "creation_target_not_yet_conclusively_disjoint"
    | "resolved_creation_target_matches";
  finalChildRegistrationHighWaterMark: string;
  finalDependencyFactHighWaterMark: string;
  finalDependencySnapshotHighWaterMark: string;
  sealedAt: string;
  terminalClosureAllowed: true;
  transition:
    | { state: "sealed"; drainedAt: null; drainEvidenceId: null }
    | { state: "drained"; drainedAt: string; drainEvidenceId: string };
};

type StateCreatorAbsorptionProofBase = {
  stateCreatorAbsorptionProofId: string;
  retirementId: string;
  organizationId: string;
  workspaceId: string;
  retirementEpoch: string;
  executionTargets: NonEmptyArray<ExecutionTargetRef>;
  blockedCreatorKinds: NonEmptyArray<"root" | "direct_descendant">;
  createdAt: string;
};

type StateCreatorAbsorptionProof = StateCreatorAbsorptionProofBase &
  (
    | {
        state: "collecting";
        liveExecutionAuthoritySetHighWaterMark: null;
        frozenLiveExecutionAuthoritySetHash: null;
        rootSealIds: [];
        rootSetDigest: null;
        creatorRegistrationHighWaterMark: null;
        rootRegistrationHighWaterVectorId: null;
        rootDependencyFactHighWaterVectorId: null;
        rootDependencySnapshotHighWaterVectorId: null;
        drainEvidenceId: null;
        completedAt: null;
        signature: null;
      }
    | {
        state: "completed";
        liveExecutionAuthoritySetHighWaterMark: string;
        frozenLiveExecutionAuthoritySetHash: string;
        rootSealIds: string[];
        rootSetDigest: string;
        creatorRegistrationHighWaterMark: string;
        rootRegistrationHighWaterVectorId: string;
        rootDependencyFactHighWaterVectorId: string;
        rootDependencySnapshotHighWaterVectorId: string;
        drainEvidenceId: string;
        completedAt: string;
        signature: string;
      }
  );

type ResourceCostPlanRef =
  | {
      resourceCostPlanVersionId: string;
      enforcementClass: "firm";
      costBoundAuthority: "provider_enforced_expiry";
    }
  | {
      resourceCostPlanVersionId: string;
      enforcementClass: "firm";
      costBoundAuthority: "contract_maximum_charge";
    }
  | { resourceCostPlanVersionId: string; enforcementClass: "operational" };

type CostValuationBasis =
  | {
      kind: "same_currency_price_schedules";
      valuationCurrency: string;
      priceScheduleVersionIds: NonEmptyArray<string>;
    }
  | {
      kind: "converted_price_and_fx_schedules";
      sourceCurrency: string;
      targetCurrency: string;
      priceScheduleVersionIds: NonEmptyArray<string>;
      fxScheduleVersionIds: NonEmptyArray<string>;
    }
  | {
      kind: "contractual_maximum";
      targetCurrency: string;
      contractualMaximumVersionId: string;
    };

type ScheduledCostValuationBasis = Extract<
  CostValuationBasis,
  { kind: "same_currency_price_schedules" | "converted_price_and_fx_schedules" }
>;

type ContractCapCostValuationBasis = Extract<
  CostValuationBasis,
  { kind: "contractual_maximum" }
>;

type CanonicalAccountingConversion =
  | {
      conversionKind: "same_currency";
      fxScheduleVersionIds: [];
      fxObservationIntervalId: null;
      roundingPolicyVersionId: string;
    }
  | {
      conversionKind: "fx";
      sourceCurrency: string;
      targetCurrency: string;
      fxScheduleVersionIds: NonEmptyArray<string>;
      fxObservationIntervalId: string;
      roundingPolicyVersionId: string;
    };

type BudgetCurrencyConversionBase = {
  sourceCostComponent:
    | "provider_charge"
    | "accounting_cost"
    | "contractual_maximum";
  sourceCurrency: string;
  sourceAmountFixedPoint: string;
  targetBudgetCurrency: string;
  targetBudgetAmountFixedPoint: string;
  budgetSettlementConversionAuthoritySetId: string;
  budgetActualCostSourceContractId: string;
  roundingPolicyVersionId: string;
};

type BudgetCurrencyConversion = BudgetCurrencyConversionBase &
  (
    | {
        conversionKind: "same_currency";
        fxScheduleVersionIds: [];
        fxObservationIntervalId: null;
      }
    | {
        conversionKind: "fx";
        fxScheduleVersionIds: NonEmptyArray<string>;
        fxObservationIntervalId: string;
      }
  );

type BudgetSettlementConversionAuthorityEntryBase = {
  budgetSettlementConversionAuthorityEntryId: string;
  sourceCostComponent: "provider_charge" | "accounting_cost";
  sourceCurrency: string;
  targetBudgetCurrency: string;
  roundingPolicyVersionId: string;
};

type BudgetSettlementFxScheduleAuthority =
  | {
      scheduleAuthorityKind: "closed_version_set";
      permittedFxScheduleVersionIds: NonEmptyArray<string>;
      fxScheduleSeriesId: null;
      scheduleGovernanceVersionId: null;
    }
  | {
      scheduleAuthorityKind: "governed_series";
      permittedFxScheduleVersionIds: [];
      fxScheduleSeriesId: string;
      scheduleGovernanceVersionId: string;
    };

type BudgetSettlementFxExposureBound =
  | {
      exposureBoundKind: "certified_finite_horizon_maximum";
      settlementFxExposureBoundVersionId: string;
      boundValidThrough: string;
      operationalOverrunPolicyVersionId: null;
    }
  | {
      exposureBoundKind: "contractual_fx_cap";
      settlementFxExposureBoundVersionId: string;
      boundValidThrough: string | null;
      operationalOverrunPolicyVersionId: null;
    }
  | {
      exposureBoundKind: "operational_with_overrun";
      settlementFxExposureBoundVersionId: null;
      boundValidThrough: null;
      operationalOverrunPolicyVersionId: string;
    };

type BudgetSettlementConversionAuthorityEntry =
  BudgetSettlementConversionAuthorityEntryBase &
    (
      | {
          conversionKind: "same_currency";
          fxScheduleAuthority: null;
          observationSelectionPolicyVersionId: null;
          settlementFxExposureBound: null;
        }
      | {
          conversionKind: "fx";
          fxScheduleAuthority: BudgetSettlementFxScheduleAuthority;
          observationSelectionPolicyVersionId: string;
          settlementFxExposureBound: BudgetSettlementFxExposureBound;
      }
  );

type CanonicalActualCostEvidenceMappingRef = {
  canonicalActualCostEvidenceMappingId: string;
  canonicalActualCostEvidenceMappingVersion: string;
  mappingImplementationHash: string;
};

type CanonicalActualCostEvidenceMappingManifest =
  CanonicalActualCostEvidenceMappingRef & {
    registryKind: "code_owned";
    supportedCanonicalSourceKinds: NonEmptyArray<
      | "canonical_request_cost_settlement"
      | "canonical_request_cost_correction"
      | "provider_cost_settlement"
      | "invoice_adjustment"
    >;
    supportedSourceCostComponents: NonEmptyArray<
      "provider_charge" | "accounting_cost"
    >;
    canonicalSourceSchemaVersionIds: NonEmptyArray<string>;
    targetAndValuationBindingContractVersionId: string;
    usageAndInvoiceLineageContractVersionId: string;
    correctionLineageContractVersionId: string;
    outputEvidenceSchemaVersionId: string;
    conformanceFixtureSetDigest: string;
    publishedArtifactDigest: string;
    signatureKeyVersionId: string;
    signature: string;
  };

type BudgetActualCostSubjectRef =
  | {
      subjectKind: "request_or_initial_resource_work";
      canonicalCostValuationRef: CanonicalCostValuationRef;
      continuationResourceCostValuationEpochId: null;
    }
  | {
      subjectKind: "resource_lifecycle_continuation";
      canonicalCostValuationRef: null;
      continuationResourceCostValuationEpochId: string;
    };

type BudgetActualCostSourceContractGroupKey = {
  actualCostSubjectHash: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScopeHash: string;
  targetBudgetCurrency: string;
  contractGroupKeyHash: string;
};

type BudgetActualCostSourceContractBase = {
  budgetActualCostSourceContractId: string;
  organizationId: string;
  workspaceId: string;
  actualCostSubject: BudgetActualCostSubjectRef;
  contractGroupKey: BudgetActualCostSourceContractGroupKey;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScope: BudgetScopeRef;
  budgetScopeHash: string;
  targetBudgetCurrency: string;
  eligibleBudgetCommitmentSliceSetDigest: string;
  sourceSelectionPolicyVersionId: string;
  canonicalEvidenceMapping: CanonicalActualCostEvidenceMappingRef;
  contractHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetActualCostSourceContract = BudgetActualCostSourceContractBase &
  (
    | {
        sourceSelectionKind: "same_as_admitted_provider_charge";
        admittedSourceCostComponent: "provider_charge";
        selectedActualSourceCostComponent: "provider_charge";
      }
    | {
        sourceSelectionKind: "same_as_admitted_accounting_cost";
        admittedSourceCostComponent: "accounting_cost";
        selectedActualSourceCostComponent: "accounting_cost";
      }
    | {
        sourceSelectionKind: "contractual_maximum_to_pinned_actual_source";
        admittedSourceCostComponent: "contractual_maximum";
        selectedActualSourceCostComponent: "provider_charge" | "accounting_cost";
      }
  ) &
  (
    | {
        sourceContractOwnerKind: "request_work";
        requestId: string;
        resourceCostObligation: null;
        sourceResourceLifecycleFundingQuoteSetId: null;
        resourceLifecycleFundingAdmissionId: null;
      }
    | {
        sourceContractOwnerKind: "resource_lifecycle_funding";
        requestId: null;
        resourceCostObligation: ResourceCostObligationRef;
        sourceResourceLifecycleFundingQuoteSetId: string;
        resourceLifecycleFundingAdmissionId: string;
      }
  );

type BudgetSettlementConversionAuthoritySetBase<
  TActualSource extends "provider_charge" | "accounting_cost",
> = {
  budgetSettlementConversionAuthoritySetId: string;
  organizationId: string;
  workspaceId: string;
  budgetCommitmentSliceId: string;
  targetBudgetCurrency: string;
  budgetActualCostSourceContractId: string;
  budgetActualCostSourceContractHash: string;
  selectedActualSourceCostComponent: TActualSource;
  validFrom: string;
  validThrough: string | null;
  entries: NonEmptyArray<
    BudgetSettlementConversionAuthorityEntry & {
      sourceCostComponent: TActualSource;
    }
  >;
  entrySetHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetSettlementConversionAuthoritySet =
  (
    | BudgetSettlementConversionAuthoritySetBase<"provider_charge">
    | BudgetSettlementConversionAuthoritySetBase<"accounting_cost">
  ) &
    (
      | {
          authorityOwnerKind: "request_work";
          requestId: string;
          resourceCostObligation: null;
          sourceResourceLifecycleFundingQuoteSetId: null;
          resourceLifecycleFundingAdmissionId: null;
        }
      | {
          authorityOwnerKind: "resource_lifecycle_funding";
          requestId: null;
          resourceCostObligation: ResourceCostObligationRef;
          sourceResourceLifecycleFundingQuoteSetId: string;
          resourceLifecycleFundingAdmissionId: string;
        }
    );

type ActualBudgetCurrencyConversion = BudgetCurrencyConversion & {
  sourceCostComponent: "provider_charge" | "accounting_cost";
  budgetSettlementConversionAuthorityEntryId: string;
};

type DeploymentCandidate = {
  target: ModelDeploymentWireBindingRef;
  canonicalModelId: string;
  translationAdapterVersionId: string | null;
  translationCertificationId: string | null;
  capabilityRevision: string;
  dataHandlingClass: string;
  certification: "native_certified" | "translated_certified" | "experimental";
  resourceCostPlanRef: ResourceCostPlanRef | null;
};

type ProviderResourceCandidate = {
  target: ProviderResourceTargetRef;
  resourceCostPlanRef: ResourceCostPlanRef;
};

type ProcessorInputRef = {
  processorInputRefId: string;
  processorInvocationId: string;
  organizationId: string;
  workspaceId: string;
  parentRequestId: string;
  inputEpoch: string;
  normalizedInputDigest: string;
  inputSchemaVersionId: string;
  dataClassification: string;
  residencyClass: string;
  minimizationDecisionId: string;
  redactionDecisionId: string | null;
  encryptedArtifactRef: string;
  sourceTransformationEpoch: string;
  createdAt: string;
  signature: string;
};

type DecisionCandidateSetContext =
  | {
      kind: "external_request";
      effectiveOperationResolutionId: string;
      transformationEpoch: string;
    }
  | {
      kind: "processor_model";
      processorInvocationId: string;
      processorInputRefId: string;
    };

type DecisionCandidateSetBase = {
  decisionCandidateSetId: string;
  executionDecisionId: string;
  context: DecisionCandidateSetContext;
  candidateSetEpoch: string;
  candidateEvaluationHighWaterMark: string;
  candidateSetHash: string;
  sealedAt: string;
};

type DecisionCandidateSet = DecisionCandidateSetBase &
  (
    | {
        transitionKind: "initial";
        previousDecisionCandidateSetId: null;
        previousCandidateSetHash: null;
      }
    | {
        transitionKind: "readmission";
        previousDecisionCandidateSetId: string;
        previousCandidateSetHash: string;
      }
  );

type DecisionCandidateEvaluationBase = {
  decisionCandidateId: string;
  executionDecisionId: string;
  decisionCandidateSetId: string;
  candidateEvaluationSequence: string;
  candidate:
    | { source: "logical_route" | "processor_model"; value: DeploymentCandidate }
    | {
        source: "exact_state";
        value: {
          target: ExecutionTargetRef;
          resolvedBindingSetDigest: string;
          resourceCostPlanRef: ResourceCostPlanRef | null;
        };
      }
    | { source: "workspace_resource"; value: ProviderResourceCandidate };
  evaluationEvidenceHash: string;
};

type DecisionCandidateExclusion = {
  stage: "policy" | "capability" | "route_preflight";
  code: string;
  policyVersionId?: string;
};

type DecisionCandidateEvaluation = DecisionCandidateEvaluationBase &
  (
    | { eligibility: "eligible"; exclusions: [] }
    | {
        eligibility: "excluded";
        exclusions: NonEmptyArray<DecisionCandidateExclusion>;
      }
  );

type FinitePeriodBudgetAttribution = {
  kind: "finite_period";
  budgetBaseCurrency: string;
  budgetPeriodId: string;
};

type ContractBudgetAttribution =
  | {
      kind: "lifetime_non_resetting";
      budgetBaseCurrency: string;
      budgetAuthorityId: string;
    }
  | {
      kind: "fully_attributed_at_admission";
      budgetBaseCurrency: string;
      budgetPeriodId: string;
      attributionContractVersionId: string;
    };

type BudgetCommitmentAttribution =
  | FinitePeriodBudgetAttribution
  | ContractBudgetAttribution;

type BudgetScopeRef = {
  scopeKind:
    | "organization"
    | "workspace"
    | "team"
    | "principal"
    | "credential"
    | "cost_center";
  scopeId: string;
};

type BudgetCommitmentSlice = {
  budgetCommitmentSliceId: string;
  organizationId: string;
  workspaceId: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScope: BudgetScopeRef;
  budgetCurrency: string;
  budgetAttribution: BudgetCommitmentAttribution;
  sliceIdentityHash: string;
  signature: string;
};

type BillableRequestWorkContext =
  | {
      kind: "execution_candidate";
      executionDecisionId: string;
      decisionCandidateSetId: string;
      decisionCandidateSetHash: string;
      decisionCandidateId: string;
      candidateEvaluationEvidenceHash: string;
      candidateSetContext: DecisionCandidateSetContext;
      operation: OperationDefinitionRef;
      preflightManifestId: string;
      executionTarget: ExecutionTargetRef;
    }
  | {
      kind: "processor_connector";
      processorInvocationId: string;
      processorInputRefId: string;
      normalizedInputDigest: string;
      processorConnectorVersionId: string;
    }
  | {
      kind: "resource_reconciliation";
      upstreamRecoveryAuthorizationId: string;
      resourceReconciliationAttemptProgressId: string;
      resourceReconciliationAttemptId: string;
      resourceCostExposureId: string;
      reconciliationRetentionLeaseId: string;
      reconciliationOperationDefinitionVersionId: string;
      executionTarget: ExecutionTargetRef;
    };

type CanonicalRequestCostValuation = {
  canonicalRequestCostValuationId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  workContext: BillableRequestWorkContext;
  providerChargeCurrency: string;
  accountingCurrency: string;
  valuationBasis: ScheduledCostValuationBasis;
  accountingConversion: CanonicalAccountingConversion;
  maximumProviderCostFixedPoint: string;
  maximumAccountingCostFixedPoint: string;
  estimatorInputDigest: string;
  priceProvenanceId: string;
  valuedAt: string;
  validThrough: string;
  signature: string;
};

type RequestBudgetCommitmentQuote = {
  requestBudgetCommitmentQuoteId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  quoteContext: BillableRequestWorkContext;
  canonicalRequestCostValuationId: string;
  budgetCommitmentSliceId: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScope: BudgetScopeRef;
  budgetCurrency: string;
  valuationBasis: ScheduledCostValuationBasis;
  budgetConversion: BudgetCurrencyConversion;
  budgetAttribution: BudgetCommitmentAttribution;
  maximumExposureFixedPoint: string;
  estimatorInputDigest: string;
  valuedAt: string;
  validThrough: string;
  signature: string;
};

type ResourceBudgetCommitmentQuoteBase = {
  budgetCommitmentQuoteId: string;
  budgetCommitmentSliceId: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScope: BudgetScopeRef;
  budgetCurrency: string;
  budgetConversion: BudgetCurrencyConversion;
};

type ResourceBudgetCommitmentQuote = ResourceBudgetCommitmentQuoteBase &
  (
    | {
        commitmentKind: "firm_provider_expiry";
        valuationBasis: ScheduledCostValuationBasis;
        budgetAttribution: BudgetCommitmentAttribution;
        maximumExposureFixedPoint: string;
      }
    | {
        commitmentKind: "firm_contract_charge_cap";
        valuationBasis: ContractCapCostValuationBasis;
        budgetAttribution: ContractBudgetAttribution;
        maximumExposureFixedPoint: string;
      }
    | {
        commitmentKind: "operational_funded_interval";
        valuationBasis: ScheduledCostValuationBasis;
        budgetAttribution: BudgetCommitmentAttribution;
        fundedThrough: string;
        forecastBudgetExposureFixedPoint: string;
        reservationFixedPoint: string;
      }
  );

type CanonicalResourceCostValuationBase = {
  providerCostValuationId: string;
  providerChargeCurrency: string;
  accountingCurrency: string;
  accountingConversion: CanonicalAccountingConversion;
  valuationInputDigest: string;
  priceProvenanceId: string;
  computedAt: string;
};

type CanonicalResourceCostValuation = CanonicalResourceCostValuationBase &
  (
    | {
        valuationKind: "firm_provider_expiry";
        valuationBasis: ScheduledCostValuationBasis;
        absoluteBillingHorizonEndsAt: string;
        maximumProviderCostFixedPoint: string;
        maximumAccountingCostFixedPoint: string;
      }
    | {
        valuationKind: "firm_contract_charge_cap";
        valuationBasis: ContractCapCostValuationBasis;
        maximumProviderCostFixedPoint: string;
        maximumAccountingCostFixedPoint: string;
        accountingHorizon: "until_terminal_reconciliation";
      }
    | {
        valuationKind: "operational_funded_interval";
        valuationBasis: ScheduledCostValuationBasis;
        intervalStartsAt: string;
        intervalEndsAt: string;
        forecastProviderCostFixedPoint: string;
        forecastAccountingCostFixedPoint: string;
      }
  );

type ResourceCostValuationQuoteBase = {
  valuationQuoteId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  executionDecisionId: string;
  decisionCandidateSetId: string;
  decisionCandidateSetHash: string;
  decisionCandidateId: string;
  candidateEvaluationEvidenceHash: string;
  candidateSetContext: DecisionCandidateSetContext;
  operation: OperationDefinitionRef;
  preflightManifestId: string;
  executionTarget: ExecutionTargetRef;
  estimatorInputDigest: string;
  valuedAt: string;
  validThrough: string;
  signature: string;
};

type BudgetCommitmentCoverage<T> =
  | {
      budgetCoverage: "no_applicable_budget_rules";
      applicableBudgetRuleSetDigest: string;
      applicableBudgetCommitmentSliceSetDigest: string;
      evaluationEvidenceId: string;
      budgetCommitments: [];
      budgetCommitmentBundleHash: null;
    }
  | {
      budgetCoverage: "commitments";
      applicableBudgetRuleSetDigest: string;
      applicableBudgetCommitmentSliceSetDigest: string;
      evaluationEvidenceId: null;
      budgetCommitments: NonEmptyArray<T>;
      budgetCommitmentBundleHash: string;
    };

type ResourceCostValuationQuote = ResourceCostValuationQuoteBase &
  (
    | ({
        resourceCostPlanRef: Extract<
          ResourceCostPlanRef,
          { costBoundAuthority: "provider_enforced_expiry" }
        >;
        canonicalProviderCostValuation: Extract<
          CanonicalResourceCostValuation,
          { valuationKind: "firm_provider_expiry" }
        >;
      } & BudgetCommitmentCoverage<
        Extract<ResourceBudgetCommitmentQuote, { commitmentKind: "firm_provider_expiry" }>
      >)
    | ({
        resourceCostPlanRef: Extract<
          ResourceCostPlanRef,
          { costBoundAuthority: "contract_maximum_charge" }
        >;
        canonicalProviderCostValuation: Extract<
          CanonicalResourceCostValuation,
          { valuationKind: "firm_contract_charge_cap" }
        >;
      } & BudgetCommitmentCoverage<
        Extract<
          ResourceBudgetCommitmentQuote,
          { commitmentKind: "firm_contract_charge_cap" }
        >
      >)
    | ({
        resourceCostPlanRef: Extract<
          ResourceCostPlanRef,
          { enforcementClass: "operational" }
        >;
        canonicalProviderCostValuation: Extract<
          CanonicalResourceCostValuation,
          { valuationKind: "operational_funded_interval" }
        >;
      } & BudgetCommitmentCoverage<
        Extract<
          ResourceBudgetCommitmentQuote,
          { commitmentKind: "operational_funded_interval" }
        >
      >)
  );

type BudgetQuoteSetMember = {
  budgetQuoteSetMemberId: string;
  budgetCommitmentSliceId: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScope: BudgetScopeRef;
  budgetCurrency: string;
  budgetConversion: BudgetCurrencyConversion;
  quotedMaximumFixedPoint: string;
  quoteRef:
    | {
        kind: "request_terminal";
        requestBudgetCommitmentQuoteId: string;
      }
    | {
        kind: "resource_terminal";
        resourceCostValuationQuoteId: string;
        resourceBudgetCommitmentQuoteId: string;
      };
};

type CanonicalCostValuationRef =
  | {
      billingLifecycle: "request_terminal";
      canonicalRequestCostValuationId: string;
      resourceCostValuationQuoteId: null;
    }
  | {
      billingLifecycle: "resource_terminal";
      canonicalRequestCostValuationId: null;
      resourceCostValuationQuoteId: string;
    };

type BudgetQuoteSetBase = {
  budgetQuoteSetId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  quoteContext: BillableRequestWorkContext;
  canonicalCostValuationRef: CanonicalCostValuationRef;
  estimatorInputDigest: string;
  applicableBudgetRuleSetDigest: string;
  applicableBudgetCommitmentSliceSetDigest: string;
  sealedAt: string;
  signature: string;
};

type BudgetQuoteSet = BudgetQuoteSetBase &
  (
    | {
        budgetCoverage: "no_applicable_budget_rules";
        evaluationEvidenceId: string;
        members: [];
        memberSetHash: null;
      }
    | {
        budgetCoverage: "quotes";
        evaluationEvidenceId: null;
        members: NonEmptyArray<BudgetQuoteSetMember>;
        memberSetHash: string;
      }
  );

type BudgetQuoteFundingOperandBase = {
  operandKind: "quote_member";
  budgetFundingOperandId: string;
  compiledBudgetFundingPlanOperandId: string;
  budgetQuoteSetId: string;
  budgetQuoteSetMemberId: string;
  operandRole: "mandatory_child" | "reachable_terminal";
  budgetConversion: BudgetCurrencyConversion;
  targetBudgetAmountFixedPoint: string;
  operandHash: string;
};

type BudgetQuoteFundingOperand = BudgetQuoteFundingOperandBase &
  (
    | {
        quoteOperandAuthorityKind: "initial_preflight_quote";
        budgetFundingPlanReadmissionId: null;
        sourcePreflightBudgetFundingPlanOperandId: string;
        sourceLogicalInputExpressionNodeId: string;
        currentQuoteAdmissionDecisionId: null;
      }
    | {
        quoteOperandAuthorityKind: "carried_preflight_quote";
        budgetFundingPlanReadmissionId: string;
        sourcePreflightBudgetFundingPlanOperandId: string;
        sourceLogicalInputExpressionNodeId: string;
        currentQuoteAdmissionDecisionId: null;
      }
    | {
        quoteOperandAuthorityKind: "readmitted_fresh_quote";
        budgetFundingPlanReadmissionId: string;
        sourcePreflightBudgetFundingPlanOperandId: string;
        sourceLogicalInputExpressionNodeId: string;
        currentQuoteAdmissionDecisionId: string;
      }
  );

type BudgetRetainedChargeEvidenceBase = {
  budgetRetainedChargeEvidenceId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  budgetCommitmentSliceId: string;
  predecessorBudgetEnvelopeFundingDerivationId: string;
  predecessorBudgetEnvelopeFundingDerivationHash: string;
  budgetMaximumBranchLeaseId: string;
  budgetMaximumBranchAttemptAllocationDispositionIds: NonEmptyArray<string>;
  retainedBudgetReservationCommitmentIds: NonEmptyArray<string>;
  targetBudgetCurrency: string;
  evidenceHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetRetainedChargeEvidence = BudgetRetainedChargeEvidenceBase &
  (
    | {
        chargeResolutionKind: "settled_partial" | "settled_full";
        budgetCommitmentSettlementIds: NonEmptyArray<string>;
        budgetCommitmentSettlementSetHash: string;
        retainedChargeDerivation: {
          derivationKind: "sum_settled_and_overrun_deltas";
          derivedRetainedChargeFixedPoint: string;
        };
        indeterminateCostExposureEvidenceId: null;
        indeterminateBudgetMaximumBranchAttemptAllocationIds: [];
        indeterminateAllocationAndReservationSetHash: null;
      }
    | {
        chargeResolutionKind: "indeterminate_at_admitted_maximum";
        budgetCommitmentSettlementIds: [];
        budgetCommitmentSettlementSetHash: null;
        retainedChargeDerivation: {
          derivationKind: "sum_still_held_admitted_allocations";
          derivedRetainedChargeFixedPoint: string;
        };
        indeterminateCostExposureEvidenceId: string;
        indeterminateBudgetMaximumBranchAttemptAllocationIds: NonEmptyArray<string>;
        indeterminateAllocationAndReservationSetHash: string;
      }
  );

type BudgetRetainedChargeFundingOperand = {
  operandKind: "retained_charge_evidence";
  budgetFundingOperandId: string;
  compiledBudgetFundingPlanOperandId: string;
  budgetFundingPlanReadmissionId: string;
  budgetRetainedChargeEvidenceId: string;
  predecessorBudgetReservationCommitmentIds: NonEmptyArray<string>;
  operandRole: "retained_charge";
  budgetQuoteSetId: null;
  budgetQuoteSetMemberId: null;
  amountAuthority: "resolve_derived_amount_from_retained_charge_evidence";
  operandHash: string;
};

type BudgetFundingOperand =
  | BudgetQuoteFundingOperand
  | BudgetRetainedChargeFundingOperand;

type CompiledBudgetFundingPlanRef =
  | {
      planAuthorityKind: "preflight_manifest";
      compiledBudgetFundingPlanId: string;
      compiledBudgetFundingPlanHash: string;
      preflightManifestId: string;
      budgetFundingPlanReadmissionId: null;
      predecessorCompiledBudgetFundingPlanId: null;
      budgetFundingPlanTransformationVersionId: null;
      canonicalOperandSetHash: string;
      canonicalExpressionTopologyHash: string;
    }
  | {
      planAuthorityKind: "signed_readmission";
      compiledBudgetFundingPlanId: string;
      compiledBudgetFundingPlanHash: string;
      preflightManifestId: string;
      budgetFundingPlanReadmissionId: string;
      predecessorCompiledBudgetFundingPlanId: string;
      budgetFundingPlanTransformationVersionId: string;
      canonicalOperandSetHash: string;
      canonicalExpressionTopologyHash: string;
    };

type BudgetFundingPlanTransformationManifest = {
  budgetFundingPlanTransformationVersionId: string;
  registryKind: "code_owned";
  supportedTransformationKinds: NonEmptyArray<
    "same_branch_retry_with_retained_charge" | "fallback_with_retained_charge"
  >;
  predecessorTopologySchemaVersionId: string;
  retainedChargeOperandSchemaVersionId: string;
  remainingInputSelectionContractVersionId: string;
  successorTopologySchemaVersionId: string;
  canonicalTransformationImplementationHash: string;
  conformanceFixtureSetDigest: string;
  publishedArtifactDigest: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetReadmissionRemainingChoiceTopology =
  | {
      remainingChoiceKind: "single_branch";
      remainingChoiceInputExpressionNodeIds: [string];
      remainingChoiceRootExpressionNodeId: string;
      topLevelMaximumExpressionNodeId: null;
      topLevelMaximumSharedCapacityLedgerId: null;
    }
  | {
      remainingChoiceKind: "multiple_branches";
      remainingChoiceInputExpressionNodeIds: NonEmptyArray<string>;
      remainingChoiceRootExpressionNodeId: string;
      topLevelMaximumExpressionNodeId: string;
      topLevelMaximumSharedCapacityLedgerId: string;
    };

type BudgetFundingPlanReadmissionBase = {
  budgetFundingPlanReadmissionId: string;
  budgetFundingPlanReadmissionBundleId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  budgetCommitmentSliceId: string;
  predecessorCompiledFundingPlan: CompiledBudgetFundingPlanRef;
  predecessorBudgetEnvelopeFundingDerivationId: string;
  predecessorBudgetEnvelopeFundingDerivationHash: string;
  budgetMaximumBranchLeaseId: string;
  predecessorBudgetMaximumBranchLeaseVersionId: string;
  budgetMaximumBranchAttemptAllocationDispositionId: string;
  budgetFundingPlanTransformationVersionId: string;
  currentPreflightManifestId: string;
  currentPolicyBundleHash: string;
  budgetReadmissionDecisionId: string;
  admittedBudgetQuoteSetIds: NonEmptyArray<string>;
  admittedBudgetQuoteSetDigest: string;
  retainedChargeEvidence: NonEmptyArray<BudgetRetainedChargeEvidence>;
  retainedChargeFundingOperands: NonEmptyArray<BudgetRetainedChargeFundingOperand>;
  retainedChargeEvidenceSetHash: string;
  retainedChargeAggregation: {
    aggregationKind: "sum_evidence_derived_amounts";
    targetBudgetCurrency: string;
  };
  exactRemainingPreflightInputExpressionNodeIds: NonEmptyArray<string>;
  exactRemainingPreflightInputSetHash: string;
  remainingBranchChoiceTopology: BudgetReadmissionRemainingChoiceTopology;
  successorCompiledBudgetFundingPlanId: string;
  successorCompiledBudgetFundingPlanHash: string;
  successorCanonicalOperandSetHash: string;
  successorCanonicalExpressionTopologyHash: string;
  successorRootExpressionNodeId: string;
  successorMaximumSharedCapacityLedgerIds: string[];
  expectedBudgetEnvelopeSnapshotId: string;
  expectedBudgetEnvelopeSnapshotHash: string;
  newBudgetEnvelopeSnapshotId: string;
  newBudgetEnvelopeSnapshotHash: string;
  predecessorHeldFixedPoint: string;
  requiredSuccessorHeldFixedPoint: string;
  incrementalHeadroomFixedPoint: string;
  readmittedAt: string;
  readmissionHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetFundingPlanReadmission = BudgetFundingPlanReadmissionBase &
  (
    | {
        readmissionKind: "same_branch_retry_with_retained_charge";
        budgetMaximumBranchLeaseDispositionId: null;
        retainedLogicalBranchInputExpressionNodeId: string;
        successorSelectedBranchInputExpressionNodeId: string;
        successorBudgetMaximumBranchLeaseVersionId: string;
      }
    | {
        readmissionKind: "fallback_with_retained_charge";
        budgetMaximumBranchLeaseDispositionId: string;
        retainedLogicalBranchInputExpressionNodeId: null;
        successorSelectedBranchInputExpressionNodeId: null;
        successorBudgetMaximumBranchLeaseVersionId: null;
      }
  );

type BudgetFundingPlanReadmissionAttemptTransition =
  | {
      attemptOwnerKind: "provider_attempt";
      providerAttemptProgressId: string;
      processorConnectorAttemptProgressId: null;
      resourceReconciliationAttemptProgressId: null;
      expectedAttemptProgressEpoch: string;
      predecessorAttemptId: string;
      successorAttemptId: string;
    }
  | {
      attemptOwnerKind: "processor_connector";
      providerAttemptProgressId: null;
      processorConnectorAttemptProgressId: string;
      resourceReconciliationAttemptProgressId: null;
      expectedAttemptProgressEpoch: string;
      predecessorAttemptId: string;
      successorAttemptId: string;
    }
  | {
      attemptOwnerKind: "resource_reconciliation";
      providerAttemptProgressId: null;
      processorConnectorAttemptProgressId: null;
      resourceReconciliationAttemptProgressId: string;
      expectedAttemptProgressEpoch: string;
      predecessorAttemptId: string;
      successorAttemptId: string;
    };

type BudgetFundingPlanReadmissionBundle = {
  budgetFundingPlanReadmissionBundleId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  readmissionKind:
    | "same_branch_retry_with_retained_charge"
    | "fallback_with_retained_charge";
  attemptTransition: BudgetFundingPlanReadmissionAttemptTransition;
  applicableBudgetCommitmentSliceSetDigest: string;
  budgetFundingPlanReadmissionIds: NonEmptyArray<string>;
  readmissionSetHash: string;
  expectedBudgetEnvelopeSnapshotId: string;
  expectedBudgetEnvelopeSnapshotHash: string;
  newBudgetEnvelopeSnapshotId: string;
  newBudgetEnvelopeSnapshotHash: string;
  fencingEpoch: string;
  committedAt: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetFundingExpressionNode =
  | {
      budgetFundingExpressionNodeId: string;
      compiledBudgetFundingPlanExpressionNodeId: string;
      expressionSequence: string;
      expressionKind: "operand";
      budgetFundingOperandId: string;
      mutualExclusionGroupId: null;
      inputExpressionNodeIds: [];
    }
  | {
      budgetFundingExpressionNodeId: string;
      compiledBudgetFundingPlanExpressionNodeId: string;
      expressionSequence: string;
      expressionKind: "sum";
      budgetFundingOperandId: null;
      mutualExclusionGroupId: null;
      expectedInputCardinality: number;
      inputExpressionNodeIds: NonEmptyArray<string>;
    }
  | {
      budgetFundingExpressionNodeId: string;
      compiledBudgetFundingPlanExpressionNodeId: string;
      expressionSequence: string;
      expressionKind: "maximum";
      budgetFundingOperandId: null;
      mutualExclusionGroupId: string;
      expectedInputCardinality: number;
      inputExpressionNodeIds: NonEmptyArray<string>;
    };

type BudgetMaximumSharedCapacityLedgerBase = {
  budgetMaximumSharedCapacityLedgerId: string;
  organizationId: string;
  workspaceId: string;
  budgetEnvelopeMemberId: string;
  initialBudgetEnvelopeFundingDerivationId: string;
  initialBudgetEnvelopeFundingDerivationHash: string;
  currentBudgetEnvelopeFundingDerivationId: string;
  currentBudgetEnvelopeFundingDerivationHash: string;
  budgetFundingExpressionNodeId: string;
  mutualExclusionGroupId: string;
  plannedInputExpressionNodeIds: NonEmptyArray<string>;
  remainingInputSetHash: string;
  sharedCapacityFixedPoint: string;
  reservationHighWaterMark: string;
  reservationSetDigest: string;
  branchLeaseHighWaterMark: string;
  branchLeaseChainHash: string;
  branchAttemptAllocationHighWaterMark: string;
  branchAttemptAllocationChainHash: string;
  currentLedgerEpoch: string;
  currentLedgerStateHash: string;
  fencingEpoch: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetMaximumSharedCapacityLedger =
  BudgetMaximumSharedCapacityLedgerBase &
    (
      | {
          ledgerState: "available";
          activeMaximumBranchLeaseId: null;
          activeMaximumBranchLeaseVersionId: null;
          selectedSharedCapacityReservationId: null;
          selectedParentInputExpressionNodeId: null;
          selectedConsumerExpressionNodeId: null;
          terminalMaximumBranchLeaseDispositionId: null;
          terminalReason: null;
          remainingInputExpressionNodeIds: NonEmptyArray<string>;
        }
      | {
          ledgerState: "branch_leased";
          activeMaximumBranchLeaseId: string;
          activeMaximumBranchLeaseVersionId: string;
          selectedSharedCapacityReservationId: string;
          selectedParentInputExpressionNodeId: string;
          selectedConsumerExpressionNodeId: string | null;
          terminalMaximumBranchLeaseDispositionId: null;
          terminalReason: null;
          remainingInputExpressionNodeIds: NonEmptyArray<string>;
        }
      | {
          ledgerState: "terminal";
          activeMaximumBranchLeaseId: null;
          activeMaximumBranchLeaseVersionId: null;
          selectedSharedCapacityReservationId: null;
          selectedParentInputExpressionNodeId: null;
          selectedConsumerExpressionNodeId: null;
          terminalMaximumBranchLeaseDispositionId: string;
          terminalReason:
            | "branch_completed"
            | "charge_retained_for_successor_plan"
            | "alternatives_exhausted";
          successorActiveMaximumBranchLeaseId: null;
          successorActiveMaximumBranchLeaseVersionId: null;
          supersedingBudgetFundingPlanReadmissionId: null;
          remainingInputExpressionNodeIds: [];
        }
      | {
          ledgerState: "terminal";
          activeMaximumBranchLeaseId: null;
          activeMaximumBranchLeaseVersionId: null;
          selectedSharedCapacityReservationId: null;
          selectedParentInputExpressionNodeId: null;
          selectedConsumerExpressionNodeId: null;
          terminalMaximumBranchLeaseDispositionId: null;
          terminalReason: "same_branch_retry_readmission";
          successorActiveMaximumBranchLeaseId: string;
          successorActiveMaximumBranchLeaseVersionId: string;
          supersedingBudgetFundingPlanReadmissionId: string;
          remainingInputExpressionNodeIds: [];
        }
    );

type BudgetMaximumSharedCapacityReservationBase = {
  budgetMaximumSharedCapacityReservationId: string;
  organizationId: string;
  workspaceId: string;
  budgetMaximumSharedCapacityLedgerId: string;
  parentBudgetEnvelopeMemberId: string;
  parentBudgetFundingExpressionNodeId: string;
  reservedParentInputExpressionNodeId: string;
  sharedCapacityFixedPoint: string;
  observedLedgerEpoch: string;
  observedLedgerStateHash: string;
  reservationHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetMaximumSharedCapacityReservation =
  BudgetMaximumSharedCapacityReservationBase &
    (
      | {
          reservationOwnerKind: "child_budget_envelope";
          childBudgetEnvelopeMemberId: string;
          childBudgetFundingExpressionNodeId: string;
          executionDecisionId: null;
          decisionCandidateSetId: null;
          decisionCandidateId: null;
          routeTraversalCandidateAdmissionId: null;
          logicalRouteBranchId: null;
        }
      | {
          reservationOwnerKind: "request_route_branch";
          childBudgetEnvelopeMemberId: null;
          childBudgetFundingExpressionNodeId: null;
          executionDecisionId: string;
          decisionCandidateSetId: string;
          decisionCandidateId: string;
          routeTraversalCandidateAdmissionId: string;
          logicalRouteBranchId: string;
        }
    );

type BudgetMaximumBranchLease = {
  budgetMaximumBranchLeaseId: string;
  initialBudgetMaximumBranchLeaseVersionId: string;
  organizationId: string;
  workspaceId: string;
  budgetMaximumSharedCapacityLedgerId: string;
  branchLeaseSequence: string;
  expectedLedgerEpoch: string;
  expectedLedgerStateHash: string;
  newLedgerEpoch: string;
  newLedgerStateHash: string;
  expectedBudgetEnvelopeSnapshotId: string;
  expectedBudgetEnvelopeSnapshotHash: string;
  newBudgetEnvelopeSnapshotId: string;
  newBudgetEnvelopeSnapshotHash: string;
  currentBudgetEnvelopeFundingDerivationId: string;
  currentBudgetEnvelopeFundingDerivationHash: string;
  selectedSharedCapacityReservationId: string;
  selectedLogicalBranchId: string;
  selectedParentInputExpressionNodeId: string;
  selectedConsumerExpressionNodeId: string | null;
  closedCompetingSharedCapacityReservationIds: string[];
  acquiredAt: string;
  leaseHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetMaximumBranchLeaseVersionBase = {
  budgetMaximumBranchLeaseVersionId: string;
  budgetMaximumBranchLeaseId: string;
  organizationId: string;
  workspaceId: string;
  versionSequence: string;
  currentBudgetMaximumSharedCapacityLedgerId: string;
  currentBudgetEnvelopeFundingDerivationId: string;
  currentBudgetEnvelopeFundingDerivationHash: string;
  selectedLogicalBranchId: string;
  selectedParentInputExpressionNodeId: string;
  selectedConsumerExpressionNodeId: string | null;
  successorBudgetMaximumBranchAttemptAllocationId: string;
  versionedAt: string;
  versionHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetMaximumBranchLeaseVersion = BudgetMaximumBranchLeaseVersionBase &
  (
    | {
        versionKind: "initial_acquisition";
        versionSequence: "0";
        predecessorBudgetMaximumBranchLeaseVersionId: null;
        predecessorBudgetMaximumSharedCapacityLedgerId: null;
        predecessorBudgetMaximumBranchAttemptAllocationDispositionId: null;
        initialSharedCapacityReservationId: string;
        acquisitionBudgetMaximumBranchLeaseHash: string;
        expectedCurrentLedgerEpoch: null;
        expectedCurrentLedgerStateHash: null;
        newCurrentLedgerEpoch: null;
        newCurrentLedgerStateHash: null;
        expectedBudgetEnvelopeSnapshotId: null;
        expectedBudgetEnvelopeSnapshotHash: null;
        newBudgetEnvelopeSnapshotId: null;
        newBudgetEnvelopeSnapshotHash: null;
        continuationKind: null;
        definitiveNoChargeEvidenceId: null;
        budgetFundingPlanReadmissionId: null;
        retainedChargeEvidenceIds: [];
      }
    | ({
        versionKind: "continuation";
        predecessorBudgetMaximumBranchLeaseVersionId: string;
        predecessorBudgetMaximumSharedCapacityLedgerId: string;
        predecessorBudgetMaximumBranchAttemptAllocationDispositionId: string;
        initialSharedCapacityReservationId: null;
        acquisitionBudgetMaximumBranchLeaseHash: null;
        expectedCurrentLedgerEpoch: string;
        expectedCurrentLedgerStateHash: string;
        newCurrentLedgerEpoch: string;
        newCurrentLedgerStateHash: string;
        expectedBudgetEnvelopeSnapshotId: string;
        expectedBudgetEnvelopeSnapshotHash: string;
        newBudgetEnvelopeSnapshotId: string;
        newBudgetEnvelopeSnapshotHash: string;
      } &
        (
          | {
              continuationKind: "same_branch_retry_after_definitive_no_charge";
              definitiveNoChargeEvidenceId: string;
              budgetFundingPlanReadmissionId: null;
              retainedChargeEvidenceIds: [];
            }
          | {
              continuationKind: "same_branch_retry_after_retained_charge_readmission";
              definitiveNoChargeEvidenceId: null;
              budgetFundingPlanReadmissionId: string;
              retainedChargeEvidenceIds: NonEmptyArray<string>;
            }
        ))
  );

type BudgetMaximumBranchAttemptAllocationBase = {
  budgetMaximumBranchAttemptAllocationId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  budgetCommitmentSliceId: string;
  budgetMaximumBranchLeaseId: string;
  budgetMaximumBranchLeaseVersionId: string;
  budgetMaximumSharedCapacityLedgerId: string;
  budgetEnvelopeFundingDerivationId: string;
  budgetEnvelopeFundingDerivationHash: string;
  budgetEnvelopeSnapshotId: string;
  budgetEnvelopeSnapshotHash: string;
  selectedLogicalBranchId: string;
  selectedParentInputExpressionNodeId: string;
  allocationSequence: string;
  allocatedFixedPoint: string;
  spendableFixedPoint: string;
  budgetReservationCommitmentId: string;
  allocatedAt: string;
  allocationHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetMaximumBranchAttemptAllocation =
  BudgetMaximumBranchAttemptAllocationBase &
    (
      | {
          attemptOwnerKind: "provider_attempt";
          providerAttemptId: string;
          providerAttemptAdmissionId: string;
          processorConnectorExecutionAdmissionId: null;
          resourceReconciliationAdmissionId: null;
        }
      | {
          attemptOwnerKind: "processor_connector";
          providerAttemptId: null;
          providerAttemptAdmissionId: null;
          processorConnectorExecutionAdmissionId: string;
          resourceReconciliationAdmissionId: null;
        }
      | {
          attemptOwnerKind: "resource_reconciliation";
          providerAttemptId: null;
          providerAttemptAdmissionId: null;
          processorConnectorExecutionAdmissionId: null;
          resourceReconciliationAdmissionId: string;
        }
    );

type BudgetMaximumBranchAttemptAllocationDisposition = {
  budgetMaximumBranchAttemptAllocationDispositionId: string;
  organizationId: string;
  workspaceId: string;
  budgetMaximumBranchAttemptAllocationId: string;
  budgetMaximumBranchLeaseId: string;
  budgetMaximumBranchLeaseVersionId: string;
  attemptTerminalEvidenceId: string;
  budgetDispositionCertificateId: string;
  disposedAt: string;
  dispositionHash: string;
  signatureKeyVersionId: string;
  signature: string;
} &
  (
    | {
        attemptChargeDisposition: "definitive_no_charge";
        definitiveNoChargeEvidenceId: string;
        budgetRetainedChargeEvidenceId: null;
      }
    | {
        attemptChargeDisposition: "charge_retained";
        definitiveNoChargeEvidenceId: null;
        budgetRetainedChargeEvidenceId: string;
      }
  );

type BudgetMaximumBranchLeaseDispositionBase = {
  budgetMaximumBranchLeaseDispositionId: string;
  organizationId: string;
  workspaceId: string;
  budgetMaximumSharedCapacityLedgerId: string;
  budgetMaximumBranchLeaseId: string;
  expectedLedgerEpoch: string;
  expectedLedgerStateHash: string;
  newLedgerEpoch: string;
  newLedgerStateHash: string;
  expectedBudgetEnvelopeSnapshotId: string;
  expectedBudgetEnvelopeSnapshotHash: string;
  newBudgetEnvelopeSnapshotId: string;
  newBudgetEnvelopeSnapshotHash: string;
  closedInputExpressionNodeIds: NonEmptyArray<string>;
  branchTerminalEvidenceId: string;
  budgetDispositionCertificateId: string;
  disposedAt: string;
  dispositionHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetMaximumBranchLeaseDisposition =
  BudgetMaximumBranchLeaseDispositionBase &
    (
      | {
          dispositionKind: "released_definitive_no_charge";
          newLedgerState: "available";
          newLedgerRemainingInputExpressionNodeIds: NonEmptyArray<string>;
          newLedgerRemainingInputSetHash: string;
          successorPlanRemainingInputExpressionNodeIds: [];
          successorPlanRemainingInputSetHash: null;
          definitiveNoChargeEvidenceId: string;
          retainedChargeEvidenceId: null;
          budgetFundingPlanReadmissionId: null;
          successorCompiledFundingPlan: null;
          successorBudgetEnvelopeFundingDerivationId: null;
          successorMaximumSharedCapacityLedgerIds: [];
          requiredSuccessorHeldFixedPoint: null;
          incrementalHeadroomFixedPoint: null;
        }
      | {
          dispositionKind: "retained_charge_with_fallback_readmission";
          newLedgerState: "terminal";
          newLedgerRemainingInputExpressionNodeIds: [];
          newLedgerRemainingInputSetHash: string;
          successorPlanRemainingInputExpressionNodeIds: NonEmptyArray<string>;
          successorPlanRemainingInputSetHash: string;
          definitiveNoChargeEvidenceId: null;
          retainedChargeEvidenceId: string;
          budgetFundingPlanReadmissionId: string;
          successorCompiledFundingPlan: Extract<
            CompiledBudgetFundingPlanRef,
            { planAuthorityKind: "signed_readmission" }
          >;
          successorBudgetEnvelopeFundingDerivationId: string;
          successorMaximumSharedCapacityLedgerIds: string[];
          requiredSuccessorHeldFixedPoint: string;
          incrementalHeadroomFixedPoint: string;
        }
      | ({
          dispositionKind: "terminal_without_fallback";
          newLedgerState: "terminal";
          newLedgerRemainingInputExpressionNodeIds: [];
          newLedgerRemainingInputSetHash: string;
          successorPlanRemainingInputExpressionNodeIds: [];
          successorPlanRemainingInputSetHash: null;
          budgetFundingPlanReadmissionId: null;
          successorCompiledFundingPlan: null;
          successorBudgetEnvelopeFundingDerivationId: null;
          successorMaximumSharedCapacityLedgerIds: [];
          requiredSuccessorHeldFixedPoint: null;
          incrementalHeadroomFixedPoint: null;
        } &
          (
            | {
                terminalChargeDisposition: "definitive_no_charge";
                definitiveNoChargeEvidenceId: string;
                retainedChargeEvidenceId: null;
              }
            | {
                terminalChargeDisposition: "charge_retained";
                definitiveNoChargeEvidenceId: null;
                retainedChargeEvidenceId: string;
              }
          ))
    );

type BudgetFundingExpressionAllocationNodeBase = {
  budgetFundingExpressionAllocationNodeId: string;
  allocationSequence: string;
  parentBudgetFundingExpressionNodeId: string;
  childBudgetFundingExpressionNodeId: string;
  childAllocationNodeIds: string[];
  allocatedFixedPoint: string;
  spendableFixedPoint: string;
  contingentSharedFixedPoint: string;
};

type BudgetFundingExpressionAllocationNode =
  | (BudgetFundingExpressionAllocationNodeBase & {
      allocationKind: "operand";
      parentBudgetFundingOperandId: string;
      childBudgetFundingOperandId: string;
      childAllocationNodeIds: [];
      budgetMaximumSharedCapacityReservationId: null;
      maximumBranchLeaseId: null;
      selectedParentInputExpressionNodeId: null;
      selectedChildInputExpressionNodeId: null;
    })
  | (BudgetFundingExpressionAllocationNodeBase & {
      allocationKind: "sum";
      parentBudgetFundingOperandId: null;
      childBudgetFundingOperandId: null;
      childAllocationNodeIds: NonEmptyArray<string>;
      budgetMaximumSharedCapacityReservationId: null;
      maximumBranchLeaseId: null;
      selectedParentInputExpressionNodeId: null;
      selectedChildInputExpressionNodeId: null;
    })
  | (BudgetFundingExpressionAllocationNodeBase & {
      allocationKind: "maximum";
      parentBudgetFundingOperandId: null;
      childBudgetFundingOperandId: null;
      childAllocationNodeIds: NonEmptyArray<string>;
      budgetMaximumSharedCapacityReservationId: string;
    } &
      (
        | {
            maximumBranchLeaseId: null;
            selectedParentInputExpressionNodeId: null;
            selectedChildInputExpressionNodeId: null;
          }
        | {
            maximumBranchLeaseId: string;
            selectedParentInputExpressionNodeId: string;
            selectedChildInputExpressionNodeId: string;
          }
      ));

type BudgetEnvelopeFundingDerivationBase = {
  budgetEnvelopeFundingDerivationId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  budgetCommitmentSliceId: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScope: BudgetScopeRef;
  budgetCurrency: string;
  compiledFundingPlan: CompiledBudgetFundingPlanRef;
  operands: NonEmptyArray<BudgetFundingOperand>;
  expressionNodes: NonEmptyArray<BudgetFundingExpressionNode>;
  rootExpressionNodeId: string;
  maximumSharedCapacityLedgerIds: string[];
  derivedHeldFixedPoint: string;
  derivedSpendableFixedPoint: string;
  derivedContingentSharedFixedPoint: string;
  derivationHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetEnvelopeFundingDerivation = BudgetEnvelopeFundingDerivationBase &
  (
    | {
        sourceKind: "root_hold";
        parentBudgetEnvelopeMemberId: null;
        parentBudgetEnvelopeFundingDerivationId: null;
        parentBudgetEnvelopeFundingDerivationHash: null;
        parentExpressionAllocationNodes: [];
        parentRootExpressionAllocationNodeId: null;
        expressionAllocationHash: null;
        allocatedFromParentFixedPoint: null;
      }
    | {
        sourceKind: "parent_allocation";
        parentBudgetEnvelopeMemberId: string;
        parentBudgetEnvelopeFundingDerivationId: string;
        parentBudgetEnvelopeFundingDerivationHash: string;
        parentExpressionAllocationNodes: NonEmptyArray<BudgetFundingExpressionAllocationNode>;
        parentRootExpressionAllocationNodeId: string;
        expressionAllocationHash: string;
        allocatedFromParentFixedPoint: string;
      }
  );

type BudgetEnvelopeMember = {
  budgetEnvelopeMemberId: string;
  envelopeReservationId: string;
  fundingDerivation: BudgetEnvelopeFundingDerivation;
  allocatedFixedPoint: string;
  spendableFixedPoint: string;
  contingentSharedFixedPoint: string;
  settledFixedPoint: string;
};

type BudgetEnvelopeSnapshotBase = {
  budgetEnvelopeSnapshotId: string;
  budgetEnvelopeId: string;
  sourceBudgetQuoteSetIds: NonEmptyArray<string>;
  applicableBudgetRuleSetDigest: string;
  applicableBudgetCommitmentSliceSetDigest: string;
  allocationHighWaterMark: string;
  settlementHighWaterMark: string;
  snapshotEpoch: string;
  snapshotHash: string;
  createdAt: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetEnvelopeSnapshot = BudgetEnvelopeSnapshotBase &
  (
    | {
        transitionKind: "initial";
        previousBudgetEnvelopeSnapshotId: null;
        previousSnapshotHash: null;
      }
    | {
        transitionKind: "continuation";
        previousBudgetEnvelopeSnapshotId: string;
        previousSnapshotHash: string;
      }
  ) &
  (
    | {
        budgetCoverage: "no_applicable_budget_rules";
        evaluationEvidenceId: string;
        members: [];
        memberSetHash: null;
      }
    | {
        budgetCoverage: "commitments";
        evaluationEvidenceId: null;
        members: NonEmptyArray<BudgetEnvelopeMember>;
        memberSetHash: string;
      }
  );

type BudgetEnvelopeBase = {
  budgetEnvelopeId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  currentBudgetEnvelopeSnapshotId: string;
  fencingEpoch: string;
};

type BudgetEnvelope = BudgetEnvelopeBase &
  (
    | {
        ownerKind: "request";
        executionDecisionId: string;
        processorInvocationId: null;
        processorInputRefId: null;
        parentBudgetEnvelopeId: null;
        parentBudgetEnvelopeSnapshotId: null;
        upstreamRecoveryAuthorizationId: null;
        resourceReconciliationAttemptProgressId: null;
      }
    | {
        ownerKind: "processor_invocation";
        executionDecisionId: null;
        processorInvocationId: string;
        processorInputRefId: string;
        parentBudgetEnvelopeId: string;
        parentBudgetEnvelopeSnapshotId: string;
        upstreamRecoveryAuthorizationId: null;
        resourceReconciliationAttemptProgressId: null;
      }
    | {
        ownerKind: "resource_reconciliation";
        executionDecisionId: null;
        processorInvocationId: null;
        processorInputRefId: null;
        parentBudgetEnvelopeId: null;
        parentBudgetEnvelopeSnapshotId: null;
        upstreamRecoveryAuthorizationId: string;
        resourceReconciliationAttemptProgressId: string;
      }
  );

type ReachableBudgetFundingEnvelopeEntry = {
  budgetCommitmentSliceId: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScope: BudgetScopeRef;
  budgetCurrency: string;
  budgetConversion: BudgetCurrencyConversion;
  maximumInitialCommitmentFixedPoint: string;
};

type ReachableBudgetFundingCoverage =
  | {
      budgetCoverage: "no_applicable_budget_rules";
      applicableBudgetRuleSetDigest: string;
      applicableBudgetCommitmentSliceSetDigest: string;
      evaluationEvidenceId: string;
      entries: [];
      entrySetHash: null;
    }
  | {
      budgetCoverage: "commitments";
      applicableBudgetRuleSetDigest: string;
      applicableBudgetCommitmentSliceSetDigest: string;
      evaluationEvidenceId: null;
      entries: NonEmptyArray<ReachableBudgetFundingEnvelopeEntry>;
      entrySetHash: string;
    };

type BudgetReservationCommitmentBase = {
  budgetReservationCommitmentId: string;
  budgetCommitmentSliceId: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScope: BudgetScopeRef;
  budgetCurrency: string;
  budgetConversion: BudgetCurrencyConversion;
  reservationId: string;
  reservedFixedPoint: string;
};

type BudgetMaximumBranchAllocationRef = {
  budgetMaximumBranchLeaseId: string;
  budgetMaximumBranchLeaseVersionId: string;
  budgetMaximumBranchAttemptAllocationId: string;
};

type RequestEnvelopeReservationSource = {
  kind: "request_budget_envelope";
  sourceBudgetQuoteSetMemberId: string;
  sourceBudgetEnvelopeMemberId: string;
  maximumBranchAllocations: BudgetMaximumBranchAllocationRef[];
};

type ResourceLifecycleFundingReservationSource = {
  kind: "resource_lifecycle_funding";
  resourceCostObligation: ResourceCostObligationRef;
  sourceResourceLifecycleFundingQuoteSetId: string;
  sourceResourceBudgetCommitmentQuoteId: string;
  resourceLifecycleFundingAdmissionId: string;
  resourceLifecycleFundingAllocationId: string;
  continuationResourceCostValuationEpochId: string;
};

type BudgetReservationCommitment = BudgetReservationCommitmentBase &
  (
    | {
        commitmentKind: "request_terminal";
        valuationBasis: ScheduledCostValuationBasis;
        budgetAttribution: BudgetCommitmentAttribution;
        sourceRequestBudgetCommitmentQuoteId: string;
        reservationSource: RequestEnvelopeReservationSource;
      }
    | {
        commitmentKind: "firm_provider_expiry";
        valuationBasis: ScheduledCostValuationBasis;
        budgetAttribution: BudgetCommitmentAttribution;
        sourceResourceBudgetCommitmentQuoteId: string;
        reservationSource: RequestEnvelopeReservationSource;
      }
    | {
        commitmentKind: "firm_contract_charge_cap";
        valuationBasis: ContractCapCostValuationBasis;
        budgetAttribution: ContractBudgetAttribution;
        sourceResourceBudgetCommitmentQuoteId: string;
        reservationSource: RequestEnvelopeReservationSource;
      }
    | {
        commitmentKind: "operational_funded_interval";
        valuationBasis: ScheduledCostValuationBasis;
        budgetAttribution: BudgetCommitmentAttribution;
        sourceResourceBudgetCommitmentQuoteId: string;
        reservationSource:
          | RequestEnvelopeReservationSource
          | ResourceLifecycleFundingReservationSource;
      }
  );

type RequestEnvelopeBudgetReservationCommitment =
  BudgetReservationCommitment & {
    reservationSource: RequestEnvelopeReservationSource;
  };

type ResourceLifecycleBudgetReservationCommitment = Extract<
  BudgetReservationCommitment,
  { commitmentKind: "operational_funded_interval" }
> & {
  reservationSource: ResourceLifecycleFundingReservationSource;
};

type BudgetReservationBundleBase<
  TCommitment extends BudgetReservationCommitment,
> = {
  budgetReservationBundleId: string;
  organizationId: string;
  workspaceId: string;
  commitments: NonEmptyArray<TCommitment>;
  commitmentSliceSetDigest: string;
  commitmentBundleHash: string;
  fencingEpoch: string;
  committedAt: string;
  signature: string;
};

type BudgetReservationBundle =
  | (BudgetReservationBundleBase<RequestEnvelopeBudgetReservationCommitment> & {
        ownerKind: "provider_attempt";
        requestId: string;
        executionDecisionId: string;
        providerAttemptId: string;
        providerAttemptAdmissionId: string;
        budgetAttemptAdmissionId: string;
        processorInvocationId: null;
        processorConnectorExecutionAdmissionId: null;
        resourceLifecycleFundingAdmissionId: null;
        resourceReconciliationAdmissionId: null;
        resourceCostObligation: null;
        sourceResourceLifecycleFundingQuoteSetId: null;
        continuationResourceCostValuationEpochId: null;
      })
  | (BudgetReservationBundleBase<
      Extract<
        RequestEnvelopeBudgetReservationCommitment,
        { commitmentKind: "request_terminal" }
      >
    > & {
        ownerKind: "processor_connector";
        requestId: string;
        executionDecisionId: null;
        providerAttemptId: null;
        providerAttemptAdmissionId: null;
        budgetAttemptAdmissionId: null;
        processorInvocationId: string;
        processorConnectorExecutionAdmissionId: string;
        resourceLifecycleFundingAdmissionId: null;
        resourceReconciliationAdmissionId: null;
        resourceCostObligation: null;
        sourceResourceLifecycleFundingQuoteSetId: null;
        continuationResourceCostValuationEpochId: null;
      })
  | (BudgetReservationBundleBase<ResourceLifecycleBudgetReservationCommitment> & {
        ownerKind: "resource_lifecycle_funding";
        requestId: null;
        executionDecisionId: null;
        providerAttemptId: null;
        providerAttemptAdmissionId: null;
        budgetAttemptAdmissionId: null;
        processorInvocationId: null;
        processorConnectorExecutionAdmissionId: null;
        resourceLifecycleFundingAdmissionId: string;
        resourceReconciliationAdmissionId: null;
        resourceCostObligation: ResourceCostObligationRef;
        sourceResourceLifecycleFundingQuoteSetId: string;
        continuationResourceCostValuationEpochId: string;
      })
  | (BudgetReservationBundleBase<
      Extract<
        RequestEnvelopeBudgetReservationCommitment,
        { commitmentKind: "request_terminal" }
      >
    > & {
        ownerKind: "resource_reconciliation";
        requestId: string;
        executionDecisionId: null;
        providerAttemptId: null;
        providerAttemptAdmissionId: null;
        budgetAttemptAdmissionId: null;
        processorInvocationId: null;
        processorConnectorExecutionAdmissionId: null;
        resourceLifecycleFundingAdmissionId: null;
        resourceReconciliationAdmissionId: string;
        resourceCostObligation: null;
        sourceResourceLifecycleFundingQuoteSetId: null;
        continuationResourceCostValuationEpochId: null;
      });

type BudgetAdmission =
  | {
      kind: "no_applicable_budget_rules";
      applicableBudgetRuleSetDigest: string;
      applicableBudgetCommitmentSliceSetDigest: string;
      evaluationEvidenceId: string;
    }
  | {
      kind: "reserved";
      applicableBudgetRuleSetDigest: string;
      applicableBudgetCommitmentSliceSetDigest: string;
      budgetReservationBundleId: string;
    };

type BudgetAttemptAllocation = {
  budgetAttemptAllocationId: string;
  budgetAttemptAdmissionId: string;
  budgetCommitmentSliceId: string;
  budgetQuoteSetMemberId: string;
  sourceBudgetEnvelopeMemberId: string;
  budgetReservationCommitmentId: string;
  maximumBranchAllocations: BudgetMaximumBranchAllocationRef[];
  budgetConversion: BudgetCurrencyConversion;
  allocatedFixedPoint: string;
};

type BudgetAttemptAdmissionBase = {
  budgetAttemptAdmissionId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  executionDecisionId: string;
  selectedExecutionTargetId: string;
  providerAttemptId: string;
  providerAttemptAdmissionId: string;
  budgetEnvelopeId: string;
  budgetEnvelopeSnapshotId: string;
  budgetQuoteSetId: string;
  applicableBudgetRuleSetDigest: string;
  applicableBudgetCommitmentSliceSetDigest: string;
  dispatchIntentId: string;
  fencingEpoch: string;
  consumedAt: string;
  signature: string;
};

type BudgetAttemptAdmission = BudgetAttemptAdmissionBase &
  (
    | {
        budgetAdmission: Extract<BudgetAdmission, { kind: "no_applicable_budget_rules" }>;
        allocations: [];
      }
    | {
        budgetAdmission: Extract<BudgetAdmission, { kind: "reserved" }>;
        allocations: NonEmptyArray<BudgetAttemptAllocation>;
      }
  );

type ResourceCostPreflightEnvelope =
  | {
      billingLifecycle: "request_terminal";
      candidateRequestCostValuations: NonEmptyArray<CanonicalRequestCostValuation>;
      candidateResourceCostValuations: [];
      reachableBudgetFunding: null;
    }
  | {
      billingLifecycle: "resource_terminal";
      candidateRequestCostValuations: [];
      candidateResourceCostValuations: NonEmptyArray<ResourceCostValuationQuote>;
      reachableBudgetFunding: ReachableBudgetFundingCoverage;
    };

type RouteTraversalOutcomeBase = {
  routeTraversalOutcomeId: string;
  executionDecisionId: string;
  decisionCandidateSetId: string;
  routeVersionId: string;
  traversalPathHash: string;
  classifierOutcomeHighWaterMark: string;
  classifierOutcomeSetDigest: string;
  selectedTerminalNodeId: string;
  completedAt: string;
  signature: string;
};

type RouteTraversalOutcome = RouteTraversalOutcomeBase &
  (
    | {
        outcomeKind: "terminal_candidates";
        terminalCandidateBitmapHash: string;
      }
    | {
        outcomeKind: "route_rejected";
        terminalCandidateBitmapHash: string;
        routeRejectCode: string;
      }
  );

type RouteTraversalCandidateAdmission = {
  routeTraversalCandidateAdmissionId: string;
  executionDecisionId: string;
  decisionCandidateSetId: string;
  decisionCandidateId: string;
  routeTraversalOutcomeId: string;
  selectedTerminalNodeId: string;
  terminalCandidateBitmapHash: string;
};

type ProcessorModelTargetAuthorization = {
  processorModelTargetAuthorizationId: string;
  processorInvocationId: string;
  processorInputRefId: string;
  processorProfileVersionId: string;
  processorServicePrincipalId: string;
  executionTarget: ModelDeploymentWireBindingRef;
  targetExecuteAuthorizationDecisionId: string;
  authorizationOutcome: "allowed";
  authorizationPolicyVersionIds: NonEmptyArray<string>;
  authorizationPolicyGeneration: string;
  narrowingGeneration: string;
  validThrough: string;
  authorizedAt: string;
  signature: string;
};

type SelectionAdmissionContext =
  | {
      executionBranch: "logical_route";
      routeTraversalCandidateAdmissionId: string;
    }
  | {
      executionBranch: "exact_state";
      effectiveOperationResolutionId: string;
      resolvedBindingSetDigest: string;
    }
  | {
      executionBranch: "workspace_resource";
      effectiveOperationResolutionId: string;
      resourceProfileVersionId: string;
    }
  | {
      executionBranch: "processor_model";
      processorInvocationId: string;
      processorInputRefId: string;
      processorModelTargetAuthorizationId: string;
    };

type ExecutionSelectionAdmission = {
  selectionAdmissionId: string;
  executionDecisionId: string;
  decisionCandidateSetId: string;
  decisionCandidateSetHash: string;
  decisionCandidateId: string;
  candidateEvaluationEvidenceHash: string;
  executionTarget: ExecutionTargetRef;
  selectionContext: SelectionAdmissionContext;
  healthEvaluationId: string;
  circuitEvaluationId: string;
  capacityFeasibilityEvaluationId: string;
  concurrencyFeasibilityEvaluationId: string;
  quotaFeasibilityEvaluationId: string;
  narrowingDecisionId: string;
  affinityDecisionId: string | null;
  canonicalCostValuationRef: CanonicalCostValuationRef;
  budgetEnvelopeId: string;
  budgetEnvelopeSnapshotId: string;
  budgetQuoteSetId: string;
  initialProviderAttemptProgressId: string;
  initialProviderAttemptId: string;
  initialProviderAttemptAdmissionId: string;
  initialBudgetAttemptAdmissionId: string;
  runtimeAdmissionFencingEpoch: string;
  validThrough: string;
  admittedAt: string;
  signature: string;
};

type SelectedExecutionTargetBase = {
  selectedExecutionTargetId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  executionDecisionId: string;
  decisionCandidateSetId: string;
  decisionCandidateId: string;
  selectionAdmissionId: string;
  selectionEpoch: string;
  executionTarget: ExecutionTargetRef;
} &
  (
    | {
        transitionKind: "initial";
        previousSelectedExecutionTargetId: null;
      }
    | {
        transitionKind: "fallback";
        previousSelectedExecutionTargetId: string;
      }
  );

type SelectedExecutionTarget = SelectedExecutionTargetBase &
  (
    | {
        billingLifecycle: "request_terminal";
        resourceCostPlanRef: null;
      }
    | {
        billingLifecycle: "resource_terminal";
        resourceCostPlanRef: ResourceCostPlanRef;
      }
  );

type ResourceProfileResolutionKey = {
  ingressWire: ApiWireRef;
  operation: OperationDefinitionRef;
  resourceKind: string;
  purpose: string;
  discriminator: string | null;
  effectivePolicyFingerprintClass: string;
};

type OperationResolution =
  | {
      kind: "workspace_catalog";
      catalogGeneration: string;
    }
  | {
      kind: "logical_model";
      logicalModelId: string;
      routeVersionId: string;
      routePreflightManifestId: string;
      stateBindings: ResolvedStateBindingSet | null;
    }
  | {
      kind: "state_binding";
      stateBindings: ResolvedHardStateBindingSet;
      operationPreflightManifestId: string;
    }
  | {
      kind: "workspace_resource";
      resolutionKey: ResourceProfileResolutionKey;
      resourceProfileVersionId: string;
      candidateResourceTargets: ProviderResourceCandidate[];
      operationPreflightManifestId: string;
    };

type OperationResolutionRecord = {
  operationResolutionId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  executionDecisionId: string;
  transformationEpoch: string;
  normalizedRequestDigest: string;
  resolution: OperationResolution;
} &
  (
    | {
        transitionKind: "initial";
        previousOperationResolutionId: null;
        transformationProcessorInvocationId: null;
        transformationProcessorInputRefId: null;
        transformationProcessorTerminalOutcomeId: null;
        transformationProcessorOutputRefId: null;
        transformedEnvelopeDigest: null;
        wireCodecValidationEvidenceId: null;
        readmissionPolicyDecisionBundleId: null;
      }
    | {
        transitionKind: "transformation_readmission";
        previousOperationResolutionId: string;
        transformationProcessorInvocationId: string;
        transformationProcessorInputRefId: string;
        transformationProcessorTerminalOutcomeId: string;
        transformationProcessorOutputRefId: string;
        transformedEnvelopeDigest: string;
        wireCodecValidationEvidenceId: string;
        readmissionPolicyDecisionBundleId: string;
      }
  );

type IdempotencyExecutionProvenanceBase = {
  idempotencyExecutionProvenanceId: string;
  idempotencyRecordId: string;
  originalRequestId: string;
  provenanceEpoch: string;
  provenanceHash: string;
  createdAt: string;
  signature: string;
};

type IdempotencyExecutionProvenance = IdempotencyExecutionProvenanceBase &
  (
    | {
        phase: "claimed_unresolved";
        previousProvenanceId: null;
        executionDecisionId: null;
        operationResolutionId: null;
      }
    | {
        phase: "dispatch_ready";
        previousProvenanceId: string;
        previousProvenancePhase: "claimed_unresolved";
        executionDecisionId: string;
        operationResolutionId: string;
        admittedWorkspaceRevisionId: string;
        policyVersionIds: string[];
        transformationProfileVersionIds: string[];
        forcedAndDefaultedParameterHmac: string;
        effectiveRequestHmac: string;
        logicalModelId: string | null;
        requestDataClassification: string;
        dispatchAuthorityHighWaterMark: string;
      }
    | {
        phase: "execution_bound";
        previousProvenanceId: string;
        previousProvenancePhase: "dispatch_ready" | "execution_bound";
        dispatchReadyProvenanceId: string;
        executionDecisionId: string;
        selectedExecutionTargetId: string;
        executionTarget: ExecutionTargetRef;
        providerAttemptHighWaterMark: string;
      }
    | {
        phase: "terminal";
        previousProvenanceId: string;
        terminalAuthority:
          | {
              terminalKind: "initialization_failed";
              previousProvenancePhase: "claimed_unresolved";
              dispatchReadyProvenanceId: null;
              executionDecisionId: null;
              executionDecisionTerminalOutcomeId: null;
              finalSelection: { kind: "none"; terminalSelectedExecutionTargetId: null };
              resultDataClassification: null;
              resultArtifactDigest: null;
              replayArtifact: { kind: "unavailable" };
              publicStateBindingId: null;
            }
          | {
              terminalKind: "execution_terminal";
              previousProvenancePhase: "dispatch_ready" | "execution_bound";
              dispatchReadyProvenanceId: string;
              executionDecisionId: string;
              executionDecisionTerminalOutcomeId: string;
              finalSelection:
                | { kind: "none"; terminalSelectedExecutionTargetId: null }
                | { kind: "provider_selected"; terminalSelectedExecutionTargetId: string };
              resultDataClassification: string;
              resultArtifactDigest: string;
              replayArtifact:
                | {
                    kind: "available";
                    encryptedArtifactRef: string;
                    maximumBytes: number;
                    expiresAt: string;
                  }
                | { kind: "unavailable" };
              publicStateBindingId: string | null;
            };
        providerMappingHighWaterMark: string;
        resourceCostExposureHighWaterMark: string;
        terminalProvenanceHighWaterMark: string;
        terminalEvidenceId: string;
      }
  );

type ExistingIdempotencyResolutionBase = {
  existingIdempotencyResolutionId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  idempotencyRecordId: string;
  createdAt: string;
};

type ExistingIdempotencyResolution = ExistingIdempotencyResolutionBase &
  (
    | {
        callerIntentComparison: "conflict";
        observedProvenanceId: string;
        observedProvenanceHash: string;
        observedPhase:
          | "claimed_unresolved"
          | "dispatch_ready"
          | "execution_bound"
          | "terminal";
        collisionAuthorizationDecisionId: null;
      }
    | {
        callerIntentComparison: "match";
        releaseCandidate: "initializing";
        observedProvenanceId: string;
        observedProvenanceHash: string;
        observedPhase: "claimed_unresolved";
        collisionAuthorizationDecisionId: null;
      }
    | {
        callerIntentComparison: "match";
        releaseCandidate: "provenance_available";
        observedProvenanceId: string;
        observedProvenanceHash: string;
        observedPhase: "dispatch_ready" | "execution_bound" | "terminal";
        collisionAuthorizationDecisionId: string;
      }
  );

type IdempotencyReleaseAuthorizationBase = {
  idempotencyReleaseAuthorizationId: string;
  existingIdempotencyResolutionId: string;
  idempotencyRecordId: string;
  authorizedProvenanceId: string;
  authorizedProvenanceHash: string;
  recordProvenanceTransitionEpoch: string;
  currentPolicyGeneration: string;
  currentNarrowingGeneration: string;
  authorizationDecisionId: string;
  authorizedAt: string;
  signature: string;
};

type IdempotencyReleaseAuthorization = IdempotencyReleaseAuthorizationBase &
  (
    | {
        authorizationOutcome: "denied";
        releaseKind:
          | "replay"
          | "wait_completion"
          | "fanout_frame"
          | "completed_result_unavailable";
        authorizedProvenancePhase: "dispatch_ready" | "execution_bound" | "terminal";
        encryptedReplayArtifactRef: null;
        fanoutFrame: null;
      }
    | {
        authorizationOutcome: "allowed";
        releaseKind: "replay" | "wait_completion";
        authorizedProvenancePhase: "terminal";
        encryptedReplayArtifactRef: string;
        fanoutFrame: null;
      }
    | {
        authorizationOutcome: "allowed";
        releaseKind: "fanout_frame";
        authorizedProvenancePhase: "execution_bound" | "terminal";
        encryptedReplayArtifactRef: null;
        fanoutFrame: {
          subscriberRegistrationId: string;
          frameSequence: string;
          frameDigest: string;
          finalFrame: boolean;
        };
      }
    | {
        authorizationOutcome: "allowed";
        releaseKind: "completed_result_unavailable";
        authorizedProvenancePhase: "terminal";
        encryptedReplayArtifactRef: null;
        fanoutFrame: null;
        replayArtifactUnavailableEvidenceId: string;
      }
  );

type PersistedStateExecutionConstraint =
  | { kind: "hard_selected_target" }
  | {
    kind: "reusable_provider_resource";
    compatibleModelTargets: NonEmptyArray<ModelDeploymentWireBindingRef>;
  };

type ResolvedStateExecutionConstraint =
  | { kind: "hard_target"; target: ExecutionTargetRef }
  | {
      kind: "compatible_model_targets";
      targets: NonEmptyArray<ModelDeploymentWireBindingRef>;
    };

type ResolvedStateBindingMember = {
  stateBindingId: string;
  referenceRole: string;
  requestedAction: string;
  authorizationDecisionId: string;
  constraint: {
    requiredOriginLogicalModelId: string | null;
    requiredCanonicalModelReleaseId: string | null;
    selectedExecutionTargetId: string;
    executionConstraint: PersistedStateExecutionConstraint;
    lineageConstraintId: string;
    stateRetentionLeaseId: string;
  };
};

type ResolvedStateBindingSetBase = {
  members: NonEmptyArray<ResolvedStateBindingMember>;
  requiredLogicalModelId: string | null;
  compatibleLogicalModelIds: string[];
  requiredCanonicalModelReleaseId: string | null;
  lineageConstraintIds: string[];
  retirementEpochs: Array<{ target: ExecutionTargetRef; epoch: string }>;
  retentionGeneration: string;
};

type ResolvedStateBindingSet = ResolvedStateBindingSetBase & {
  executionConstraint: ResolvedStateExecutionConstraint;
};

type ResolvedHardStateBindingSet = ResolvedStateBindingSetBase & {
  executionConstraint: { kind: "hard_target"; target: ExecutionTargetRef };
};

type ExecutionDecisionHeaderBase = {
  executionDecisionId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  workspaceRevisionId: string;
  policyVersionIds: string[];
  createdAt: string;
};

type ExecutionDecisionHeader = ExecutionDecisionHeaderBase & {
  decisionOwner:
    | {
        kind: "external_request";
        initialResolution:
          | { kind: "operation"; operationResolutionId: string }
          | {
              kind: "existing_idempotency";
              existingIdempotencyResolutionId: string;
            };
      }
    | {
        kind: "processor_model";
        processorInvocationId: string;
        processorProfileVersionId: string;
        parentRequestId: string;
        processorPreflightManifestId: string;
      };
};

type ExecutionDecisionProgress = {
  executionDecisionId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  currentDecisionCandidateSetId: string | null;
  currentSelectedExecutionTargetId: string | null;
  executionDecisionTerminalOutcomeId: string | null;
  transitionEpoch: string;
};

type ExecutionDenialEvidence =
  | { kind: "authorization"; authorizationDecisionId: string }
  | { kind: "preflight"; preflightFailureId: string }
  | { kind: "budget"; budgetDecisionBundleId: string }
  | { kind: "narrowing"; narrowingDecisionId: string; deltaIds: NonEmptyArray<string> }
  | { kind: "processor"; processorInvocationId: string; processorOutcomeId: string }
  | { kind: "credential_intersection"; credentialIntersectionEvidenceId: string }
  | { kind: "valuation_quote"; valuationFailureId: string }
  | { kind: "capability_or_availability"; candidateSetId: string; failureId: string }
  | { kind: "admission_limit"; limitDecisionId: string };

type TargetlessExecutionDenial = {
  kind: "denied";
  denialEvidence: ExecutionDenialEvidence;
  reasonCode: string;
};

type ExistingIdempotencyExecutionResult =
  | { kind: "caller_intent_conflict" }
  | {
      kind: "initializing_in_progress";
      observedProvenanceId: string;
    }
  | {
      kind: "return_in_progress";
      recordState: "pending" | "indeterminate";
      observedProvenanceId: string;
    }
  | {
      kind: "wait_timeout";
      recordState: "initializing" | "pending" | "indeterminate";
      observedProvenanceId: string;
    }
  | {
      kind: "fanout_subscriber";
      subscriberRegistrationId: string;
      observedProvenanceId: string;
    }
  | {
      kind: "replayed" | "waited_result_released";
      idempotencyReleaseAuthorizationId: string;
    }
  | {
      kind: "completed_result_unavailable";
      idempotencyReleaseAuthorizationId: string;
    }
  | { kind: "release_denied"; idempotencyReleaseAuthorizationId: string };

type ExecutionDecisionTerminalOutcomeBase = {
  executionDecisionTerminalOutcomeId: string;
  executionDecisionId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  effectiveOperationResolutionId: string | null;
  completedAt: string;
};

type ScopedExecutionDecisionTerminalOutcomeRef = {
  organizationId: string;
  workspaceId: string;
  requestId: string;
  executionDecisionId: string;
  executionDecisionTerminalOutcomeId: string;
};

type ExecutionDecisionTerminalOutcome =
  | (ExecutionDecisionTerminalOutcomeBase & {
      executionBranch: "workspace_catalog";
      effectiveOperationResolutionId: string;
      budgetEnvelopeId: null;
      catalogGeneration: string;
      result: { kind: "local_result" } | TargetlessExecutionDenial;
    })
  | (ExecutionDecisionTerminalOutcomeBase & {
      executionBranch: "logical_route";
      effectiveOperationResolutionId: string;
      logicalModelId: string;
      routeVersionId: string;
      routePreflightManifestId: string;
      budgetEnvelopeId: string;
      result:
        | {
            kind: "provider_selected";
            selectionReason: string;
            routeTraversalOutcomeId: string;
            terminalSelectedExecutionTargetId: string;
          }
        | { kind: "exact_cache_hit"; cacheEntryId: string }
        | {
            kind: "route_rejected";
            routeRejectCode: string;
            routeTraversalOutcomeId: string;
          }
        | TargetlessExecutionDenial;
    })
  | (ExecutionDecisionTerminalOutcomeBase & {
      executionBranch: "exact_state";
      effectiveOperationResolutionId: string;
      resolvedBindingSetDigest: string;
      operationPreflightManifestId: string;
      budgetEnvelopeId: string;
      result:
        | { kind: "provider_selected"; terminalSelectedExecutionTargetId: string }
        | TargetlessExecutionDenial;
    })
  | (ExecutionDecisionTerminalOutcomeBase & {
      executionBranch: "workspace_resource";
      effectiveOperationResolutionId: string;
      resourceProfileVersionId: string;
      operationPreflightManifestId: string;
      budgetEnvelopeId: string;
      result:
        | { kind: "provider_selected"; terminalSelectedExecutionTargetId: string }
        | TargetlessExecutionDenial;
    })
  | (ExecutionDecisionTerminalOutcomeBase & {
      executionBranch: "processor_model";
      effectiveOperationResolutionId: null;
      budgetEnvelopeId: string;
      result:
        | { kind: "provider_selected"; terminalSelectedExecutionTargetId: string }
        | TargetlessExecutionDenial;
    })
  | (ExecutionDecisionTerminalOutcomeBase & {
      executionBranch: "idempotency_existing";
      effectiveOperationResolutionId: null;
      existingIdempotencyResolutionId: string;
      idempotencyRecordId: string;
      budgetEnvelopeId: null;
      result: ExistingIdempotencyExecutionResult;
    });

type RetainedCredentialLeaseAuthorization =
  | { kind: "state_retention"; leaseId: string; stateBindingId: string }
  | {
      kind: "reconciliation_retention";
      leaseId: string;
      reconciliationOwnerId: string;
    };

type RetainedCredentialCommonSlotSelection = {
  retainedCredentialCommonSlotSelectionId: string;
  attemptId: string;
  providerCredentialDirectoryGeneration: string;
  selectedCredentialSlotVersionId: string;
  requirementEvidenceHighWaterMark: string;
  requiredLeaseSetDigest: string;
  selectedAt: string;
  signature: string;
};

type RetainedCredentialRequirementEvidenceBase = {
  retainedCredentialRequirementEvidenceId: string;
  retainedCredentialCommonSlotSelectionId: string;
  executionTarget: ExecutionTargetRef;
  retainedCredentialAccessId: string;
  authorizingLease: RetainedCredentialLeaseAuthorization;
};

type RetainedCredentialRequirementEvidence =
  | (RetainedCredentialRequirementEvidenceBase & {
      accessKind: "certified_successor_set";
      continuityRequirement: Extract<
        CredentialContinuityRequirement,
        { kind: "provider_state_namespace" }
      >;
      credentialSetVersionId: string;
      continuityCertificationId: string;
      commonSlotMembershipEvidenceId: string;
    })
  | (RetainedCredentialRequirementEvidenceBase & {
      accessKind: "exact_credential_slot";
      continuityRequirement: Extract<
        CredentialContinuityRequirement,
        { kind: "exact_auth_source" }
      >;
      credentialSetVersionId: null;
      continuityCertificationId: null;
      commonSlotConstraint: "equals_exact_auth_source";
    })
  | (RetainedCredentialRequirementEvidenceBase & {
      accessKind: "incident_originating_credential_slot";
      continuityRequirement: Extract<
        CredentialContinuityRequirement,
        { kind: "provider_state_namespace" }
      >;
      credentialSetVersionId: null;
      continuityCertificationId: null;
      commonSlotConstraint: "equals_namespace_originating_slot";
      incidentAuthorizationId: string;
      lifecycleServicePrincipalId: string;
    });

type ProviderAttemptCredentialAccess =
  | {
      kind: "ordinary_set";
      credentialSetVersionId: string;
      credentialSlotVersionId: string;
    }
  | {
      kind: "retained_lease_intersection";
      retainedCredentialCommonSlotSelectionId: string;
    };

type ProviderAttemptAdmissionBase = {
  providerAttemptAdmissionId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  executionDecisionId: string;
  selectedExecutionTargetId: string;
  executionTarget: ExecutionTargetRef;
  attemptId: string;
  selectionAdmissionId: string;
  providerAttemptProgressId: string;
  healthDecisionId: string;
  circuitDecisionId: string;
  capacityAdmissionId: string;
  concurrencyAdmissionId: string;
  quotaAdmissionId: string;
  narrowingDecisionId: string;
  providerCredentialDirectoryGeneration: string;
  credentialAccess: ProviderAttemptCredentialAccess;
  credentialEligibilityDecisionId: string;
  credentialQuotaAdmissionId: string;
  canonicalCostValuationRef: CanonicalCostValuationRef;
  budgetAttemptAdmissionId: string;
  providerDispatchIntentId: string;
  runtimeAdmissionFencingEpoch: string;
  validThrough: string;
  consumedAt: string;
  signature: string;
};

type ProviderAttemptAdmission = ProviderAttemptAdmissionBase &
  (
    | {
        attemptTransition: "selected_transition_first_attempt";
        previousProviderAttemptId: null;
        expectedPreviousAttemptProgressEpoch: null;
        selectionHandoff:
          | {
              kind: "initial_selection";
              previousSelectedExecutionTargetId: null;
              previousFinalProviderAttemptId: null;
            }
          | {
              kind: "fallback_selection";
              previousSelectedExecutionTargetId: string;
              previousProviderAttemptProgressId: string;
              previousProviderAttemptProgressEpoch: string;
              previousFinalProviderAttemptId: string;
            };
      }
    | {
        attemptTransition: "same_target_retry";
        previousProviderAttemptId: string;
        expectedPreviousAttemptProgressEpoch: string;
        selectionHandoff: null;
      }
  ) &
  (
    | {
        attemptOwner: "external_request";
        effectiveOperationResolutionId: string;
        processorInvocationId: null;
        processorInputRefId: null;
        processorModelTargetAuthorizationId: null;
      }
    | {
        attemptOwner: "processor_model";
        effectiveOperationResolutionId: null;
        processorInvocationId: string;
        processorInputRefId: string;
        processorModelTargetAuthorizationId: string;
      }
  );

type ProviderAttemptProgressBase = {
  providerAttemptProgressId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  executionDecisionId: string;
  selectedExecutionTargetId: string;
  currentProviderAttemptId: string;
  currentProviderAttemptAdmissionId: string;
  currentProviderDispatchIntentId: string;
  progressEpoch: string;
  fencingEpoch: string;
  updatedAt: string;
};

type ProviderAttemptProgress = ProviderAttemptProgressBase &
  (
    | {
        state: "open";
        terminalProviderAttemptId: null;
        terminalDisposition: null;
      }
    | {
        state: "terminal";
        terminalProviderAttemptId: string;
        terminalDisposition:
          | {
              kind: "decision_terminal";
              executionDecisionTerminalOutcomeId: string;
            }
          | {
              kind: "fallback_handoff";
              successorSelectedExecutionTargetId: string;
            };
      }
  );

type RemoteDispatchIntentRef =
  | { kind: "provider"; providerDispatchIntentId: string }
  | { kind: "processor_connector"; processorConnectorDispatchIntentId: string }
  | {
      kind: "resource_reconciliation";
      resourceReconciliationDispatchIntentId: string;
    };

type RemoteDispatchIntentBase = {
  organizationId: string;
  workspaceId: string;
  requestId: string;
  remoteDispatchAuthorityId: string;
  serializedPayloadDigest: string;
  dispatchFencingEpoch: string;
  dispatchNotAfter: string;
  dispatchDeadlineDerivationVersionId: string;
  trustedTimeSourceId: string;
  createdAt: string;
  signature: string;
};

type DispatchDeadlineReachedEvidence = {
  dispatchDeadlineReachedEvidenceId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  dispatchIntent: RemoteDispatchIntentRef;
  remoteDispatchAuthorityId: string;
  expectedCurrentStateTransitionId: string;
  expectedCurrentStateTransitionHash: string;
  dispatchNotAfter: string;
  dispatchDeadlineDerivationVersionId: string;
  trustedTimeSourceId: string;
  trustedTimeEvidenceId: string;
  observedAt: string;
  signature: string;
};

type RemoteDispatchPreSendCancellationEvidenceRef =
  | {
      kind: "dispatch_deadline_reached";
      dispatchDeadlineReachedEvidenceId: string;
    }
  | { kind: "authorization_expired"; authorizationExpiryEvidenceId: string }
  | { kind: "policy_invalidated"; policyInvalidationEvidenceId: string }
  | { kind: "credential_revoked"; credentialRevocationEvidenceId: string }
  | { kind: "admission_expired"; admissionExpiryEvidenceId: string }
  | { kind: "cleanup_supersession"; cleanupClosureIntentId: string };

type UpstreamIdempotencyCertificationBase = {
  upstreamIdempotencyCertificationId: string;
  organizationId: string;
  workspaceId: string;
  upstreamContractVersionId: string;
  keyNamespaceId: string;
  keyDerivationProfileVersionId: string;
  keyScope:
    | "provider_account_operation"
    | "provider_project_operation"
    | "connector_tenant_operation";
  payloadEquivalenceContractVersionId: string;
  retentionSeconds: number;
  concurrentSameKeySemantics: "single_effect_shared_outcome";
  certificationFixtureSetId: string;
  certifiedAt: string;
  expiresAt: string;
  certificationHash: string;
  signature: string;
};

type UpstreamIdempotencyCertification = UpstreamIdempotencyCertificationBase &
  (
    | {
        certificationOwner: "provider_request_terminal";
        operation: OperationDefinitionRef;
        executionTarget: ExecutionTargetRef;
        processorConnectorVersionId: null;
        billingLifecycle: "request_terminal";
        recoveryMode: "fresh_attempt_same_key";
        responseSemantics: "replay_same_terminal_result";
      }
    | {
        certificationOwner: "processor_connector";
        operation: null;
        executionTarget: null;
        processorConnectorVersionId: string;
        billingLifecycle: "request_terminal";
        recoveryMode: "fresh_attempt_same_key";
        responseSemantics: "replay_same_terminal_result";
      }
    | {
        certificationOwner: "provider_resource_terminal";
        operation: OperationDefinitionRef;
        executionTarget: ExecutionTargetRef;
        processorConnectorVersionId: null;
        billingLifecycle: "resource_terminal";
        recoveryMode: "registered_reconciliation_operation_only";
        reconciliationOperationDefinitionVersionId: string;
        reconciliationOperationSemantics: "read_only_observation";
        reconciliationOutcomeSchemaVersionId: string;
        responseSemantics: "observe_original_resource";
      }
  );

type UpstreamIdempotencyKeyBindingBase = {
  upstreamIdempotencyKeyBindingId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  upstreamIdempotencyCertificationId: string;
  upstreamIdempotencyCertificationHash: string;
  initialRemoteDispatchAuthorityId: string;
  upstreamIdempotencyKeyHmac: string;
  serializedPayloadDigest: string;
  boundAt: string;
  certifiedRetentionSeconds: number;
  certifiedRetentionEndsAt: string;
  certificationExpiresAt: string;
  requestDeadline: string;
  policyRecoveryCapEndsAt: string;
  recoveryNotAfter: string;
  recoveryDeadlineDerivationVersionId: string;
  trustedTimeSourceId: string;
  bindingHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type UpstreamIdempotencyKeyBinding = UpstreamIdempotencyKeyBindingBase &
  (
    | {
        bindingOwner: "provider";
        operation: OperationDefinitionRef;
        executionTarget: ExecutionTargetRef;
        processorConnectorVersionId: null;
      }
    | {
        bindingOwner: "processor_connector";
        operation: null;
        executionTarget: null;
        processorConnectorVersionId: string;
      }
  );

type UpstreamRecoveryAuthorizationBase = {
  upstreamRecoveryAuthorizationId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  upstreamIdempotencyCertificationId: string;
  upstreamIdempotencyKeyBindingId: string;
  upstreamIdempotencyKeyBindingHash: string;
  originalRemoteDispatchAuthorityId: string;
  originalSerializedPayloadDigest: string;
  upstreamIdempotencyKeyHmac: string;
  ambiguousOutcomeEvidenceId: string;
  authorizedAt: string;
  signature: string;
};

type ResourceRecoveryOwnerRef = {
  kind: "orphan_provider_resource";
  stateBindingId: string;
  orphanProviderResourceId: string;
  orphanResourceCostObligationId: string;
};

type ResourceRecoveryTerminalPredecessor =
  | {
      previousTerminalResourceReconciliationAttemptProgressId: null;
      previousTerminalDisposition: null;
    }
  | {
      previousTerminalResourceReconciliationAttemptProgressId: string;
      previousTerminalDisposition:
        | "original_resource_definitively_absent"
        | "recovery_control_exhausted"
        | "pre_dispatch_cancelled";
    };

type OrphanRecoveryBoundExtensionDelta =
  | {
      extensionDeltaKind: "invocation_ceiling";
      predecessorCumulativeInvocationCeiling: number;
      newCumulativeInvocationCeiling: number;
      predecessorAbsoluteRecoveryHorizonEndsAt: string;
      newAbsoluteRecoveryHorizonEndsAt: string;
    }
  | {
      extensionDeltaKind: "absolute_horizon";
      predecessorCumulativeInvocationCeiling: number;
      newCumulativeInvocationCeiling: number;
      predecessorAbsoluteRecoveryHorizonEndsAt: string;
      newAbsoluteRecoveryHorizonEndsAt: string;
    }
  | {
      extensionDeltaKind: "both";
      predecessorCumulativeInvocationCeiling: number;
      newCumulativeInvocationCeiling: number;
      predecessorAbsoluteRecoveryHorizonEndsAt: string;
      newAbsoluteRecoveryHorizonEndsAt: string;
    };

type OrphanRecoveryBoundExtensionApproval = {
  recoveryBoundExtensionApprovalId: string;
  organizationId: string;
  workspaceId: string;
  orphanProviderResourceId: string;
  orphanResourceCostObligationId: string;
  predecessorOrphanRecoveryBoundVersionId: string;
  predecessorOrphanRecoveryBoundVersionHash: string;
  extensionDelta: OrphanRecoveryBoundExtensionDelta;
  extensionDeltaHash: string;
  approvalPolicyDecisionId: string;
  approvedByPrincipalId: string;
  approvedAt: string;
  validThrough: string;
  approvalHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type OrphanRecoveryMarginalExposureDerivationManifestRef = {
  orphanRecoveryMarginalExposureDerivationVersionId: string;
  derivationImplementationHash: string;
};

type OrphanRecoveryMarginalExposureDerivationManifest =
  OrphanRecoveryMarginalExposureDerivationManifestRef & {
    registryKind: "code_owned";
    extensionDeltaSchemaVersionId: string;
    recoveryTargetAndPriceInputSchemaVersionId: string;
    additionalInvocationDerivationContractVersionId: string;
    remainingInvocationDerivationContractVersionId: string;
    horizonCarryDerivationContractVersionId: string;
    priceAndFxCoverageContractVersionId: string;
    budgetSliceExpansionContractVersionId: string;
    outputCostVectorSchemaVersionId: string;
    conformanceFixtureSetDigest: string;
    publishedArtifactDigest: string;
    signatureKeyVersionId: string;
    signature: string;
  };

type OrphanRecoveryMarginalExposureOperandBase = {
  marginalExposureOperandId: string;
  invocationCount: number;
  exposureStartsAt: string;
  exposureEndsAt: string;
  priceScheduleVersionIds: NonEmptyArray<string>;
  fxSelectionPolicyVersionIds: string[];
  priceAndFxCoverageEndsAt: string;
  applicableBudgetCommitmentSliceSetDigest: string;
  providerChargeMaximumsByCurrency: NonEmptyArray<CurrencyAmount>;
  accountingCostMaximumsByCurrency: NonEmptyArray<CurrencyAmount>;
  operandHash: string;
};

type OrphanRecoveryMarginalExposureOperand =
  OrphanRecoveryMarginalExposureOperandBase &
    (
      | {
          marginalExposureOperandKind: "additional_invocation_capacity";
          sourceInvocationCountDerivation: "new_ceiling_minus_predecessor_ceiling";
          predecessorFundedThrough: null;
        }
      | {
          marginalExposureOperandKind: "horizon_extension_for_remaining_capacity";
          sourceInvocationCountDerivation: "predecessor_ceiling_minus_consumed_count";
          predecessorFundedThrough: string;
        }
    );

type OrphanRecoveryBoundExtensionMarginalExposureValuationBase = {
  orphanRecoveryBoundExtensionMarginalExposureValuationId: string;
  organizationId: string;
  workspaceId: string;
  orphanProviderResourceId: string;
  orphanResourceCostObligationId: string;
  resourceReconciliationTarget: ExecutionTargetRef;
  resourceReconciliationOperationDefinitionVersionId: string;
  resourceReconciliationCertificationId: string;
  predecessorOrphanRecoveryBoundVersionId: string;
  predecessorOrphanRecoveryBoundVersionHash: string;
  expectedOrphanResourceRecoveryControlEpoch: string;
  expectedCumulativeConsumedInvocationCount: number;
  extensionDelta: OrphanRecoveryBoundExtensionDelta;
  extensionDeltaHash: string;
  derivationManifest: OrphanRecoveryMarginalExposureDerivationManifestRef;
  derivedAdditionalInvocationCount: number;
  derivedPredecessorRemainingInvocationCount: number;
  pricingInputDigest: string;
  applicableBudgetRuleSetDigest: string;
  applicableBudgetCommitmentSliceSetDigest: string;
  valuedAt: string;
  valuationHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type OrphanRecoveryBoundExtensionMarginalExposureValuation =
  OrphanRecoveryBoundExtensionMarginalExposureValuationBase &
    (
      | {
          marginalExposureKind: "zero";
          exposureOperands: [];
          exposureOperandSetHash: string;
          marginalProviderChargeMaximumsByCurrency: [];
          marginalAccountingCostMaximumsByCurrency: [];
          zeroMarginalExposureProofId: string;
        }
      | {
          marginalExposureKind: "valued";
          exposureOperands: NonEmptyArray<OrphanRecoveryMarginalExposureOperand>;
          exposureOperandSetHash: string;
          marginalProviderChargeMaximumsByCurrency: NonEmptyArray<CurrencyAmount>;
          marginalAccountingCostMaximumsByCurrency: NonEmptyArray<CurrencyAmount>;
          zeroMarginalExposureProofId: null;
        }
    );

type OrphanRecoveryBoundExtensionMarginalFunding = {
  extensionDeltaHash: string;
  marginalExposureValuationId: string;
  marginalExposureValuationHash: string;
  marginalExposureDerivationManifest:
    OrphanRecoveryMarginalExposureDerivationManifestRef;
  marginalReconciliationCostQuoteSetId: string;
} &
  (
    | {
        marginalFundingKind: "no_applicable_budget_rules";
        marginalBudgetEvaluationEvidenceId: string;
        existingReservationCoverageEvidenceId: null;
        incrementalBudgetReservationBundleId: null;
      }
    | {
        marginalFundingKind: "covered_by_existing_reservation";
        marginalBudgetEvaluationEvidenceId: null;
        existingReservationCoverageEvidenceId: string;
        incrementalBudgetReservationBundleId: null;
      }
    | {
        marginalFundingKind: "incremental_reservation";
        marginalBudgetEvaluationEvidenceId: null;
        existingReservationCoverageEvidenceId: null;
        incrementalBudgetReservationBundleId: string;
      }
  );

type OrphanRecoveryBoundExtensionAdmission = {
  orphanRecoveryBoundExtensionAdmissionId: string;
  organizationId: string;
  workspaceId: string;
  orphanProviderResourceId: string;
  orphanResourceCostObligationId: string;
  requiredRecoveryControlState: "available";
  expectedOrphanResourceRecoveryControlEpoch: string;
  newOrphanResourceRecoveryControlEpoch: string;
  expectedOrphanRecoveryBoundVersionId: string;
  expectedOrphanRecoveryBoundVersionHash: string;
  expectedCumulativeConsumedInvocationCount: number;
  extensionDelta: OrphanRecoveryBoundExtensionDelta;
  extensionDeltaHash: string;
  recoveryBoundExtensionApprovalId: string;
  marginalFunding: OrphanRecoveryBoundExtensionMarginalFunding;
  validThrough: string;
  admissionHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type OrphanRecoveryBoundVersionBase = {
  orphanRecoveryBoundVersionId: string;
  organizationId: string;
  workspaceId: string;
  orphanProviderResourceId: string;
  absoluteRecoveryHorizonEndsAt: string;
  cumulativeInvocationCeiling: number;
  recoveryBoundHash: string;
  createdAt: string;
  signatureKeyVersionId: string;
  signature: string;
};

type OrphanRecoveryBoundVersion = OrphanRecoveryBoundVersionBase &
  (
    | {
        boundVersionKind: "initial";
        predecessorOrphanRecoveryBoundVersionId: null;
        predecessorRecoveryBoundHash: null;
        predecessorAbsoluteRecoveryHorizonEndsAt: null;
        predecessorCumulativeInvocationCeiling: null;
        extensionDelta: null;
        extensionDeltaHash: null;
        recoveryBoundPolicyVersionId: string;
        recoveryBoundExtensionApprovalId: null;
        orphanRecoveryBoundExtensionAdmissionId: null;
        marginalFunding: null;
      }
    | {
        boundVersionKind: "approved_budgeted_extension";
        predecessorOrphanRecoveryBoundVersionId: string;
        predecessorRecoveryBoundHash: string;
        predecessorAbsoluteRecoveryHorizonEndsAt: string;
        predecessorCumulativeInvocationCeiling: number;
        extensionDelta: OrphanRecoveryBoundExtensionDelta;
        extensionDeltaHash: string;
        recoveryBoundPolicyVersionId: null;
        recoveryBoundExtensionApprovalId: string;
        orphanRecoveryBoundExtensionAdmissionId: string;
        marginalFunding: OrphanRecoveryBoundExtensionMarginalFunding;
      }
  );

type OrphanResourceRecoveryControlBase = {
  orphanRecoveryBoundVersionId: string;
  orphanRecoveryBoundVersionHash: string;
  absoluteRecoveryHorizonEndsAt: string;
  cumulativeInvocationCeiling: number;
  cumulativeConsumedInvocationCount: number;
  recoveryAuthorizationHighWaterMark: string;
  recoveryAuthorizationChainHash: string;
};

type OrphanResourceRecoveryControl = OrphanResourceRecoveryControlBase &
  (
    | (ResourceRecoveryTerminalPredecessor & {
      recoveryControlState: "available";
      recoveryControlEpoch: string;
      activeUpstreamRecoveryAuthorizationId: null;
      activeResourceReconciliationAttemptProgressId: null;
      activatedAt: null;
      closedReason: null;
      closedEvidenceId: null;
    })
    | (ResourceRecoveryTerminalPredecessor & {
      recoveryControlState: "active";
      recoveryControlEpoch: string;
      activeUpstreamRecoveryAuthorizationId: string;
      activeResourceReconciliationAttemptProgressId: string;
      activatedAt: string;
      closedReason: null;
      closedEvidenceId: null;
    })
    | (ResourceRecoveryTerminalPredecessor & {
      recoveryControlState: "closing_cleanup";
      predecessorActiveRecoveryControlEpoch: string;
      recoveryControlEpoch: string;
      activeUpstreamRecoveryAuthorizationId: string;
      activeResourceReconciliationAttemptProgressId: string;
      activatedAt: string;
      cleanupClosureIntentId: string;
      cleanupStartedAt: string;
      closedReason: null;
      closedEvidenceId: null;
    })
    | (ResourceRecoveryTerminalPredecessor & {
      recoveryControlState: "closed";
      recoveryControlEpoch: string;
      activeUpstreamRecoveryAuthorizationId: null;
      activeResourceReconciliationAttemptProgressId: null;
      activatedAt: null;
      closedReason: "cleanup_terminal";
      closedEvidenceId: string;
      cleanupClosureKind: "available_without_active_progress";
      cleanupClosureIntentId: string;
      predecessorAvailableRecoveryControlEpoch: string;
    })
    | {
      recoveryControlState: "closed";
      recoveryControlEpoch: string;
      activeUpstreamRecoveryAuthorizationId: null;
      activeResourceReconciliationAttemptProgressId: null;
      activatedAt: null;
      previousTerminalResourceReconciliationAttemptProgressId: string;
      previousTerminalDisposition: "cleanup_superseded";
      closedReason: "cleanup_terminal";
      closedEvidenceId: string;
      cleanupClosureKind: "active_progress_superseded";
      cleanupClosureIntentId: string;
      predecessorClosingRecoveryControlEpoch: string;
    }
    | {
      recoveryControlState: "closed";
      recoveryControlEpoch: string;
      activeUpstreamRecoveryAuthorizationId: null;
      activeResourceReconciliationAttemptProgressId: null;
      activatedAt: null;
      previousTerminalResourceReconciliationAttemptProgressId: string;
      previousTerminalDisposition: "original_resource_identity_proven";
      closedReason: "recovered_to_active";
      closedEvidenceId: string;
      cleanupClosureKind: null;
      cleanupClosureIntentId: null;
    }
  );

type UpstreamRecoveryAuthorization = UpstreamRecoveryAuthorizationBase &
  (
    | {
        recoveryAction: "fresh_provider_request_attempt";
        certificationOwner: "provider_request_terminal";
        originalDispatchIntent: Extract<RemoteDispatchIntentRef, { kind: "provider" }>;
        previousProviderAttemptId: string;
        providerAttemptProgressId: string;
        expectedProviderAttemptProgressEpoch: string;
        newProviderAttemptAdmissionId: string;
        newBudgetAttemptAdmissionId: string;
        newProviderDispatchIntentId: string;
        cumulativeBudgetEnvelopeSnapshotId: string;
        recoveryNotAfter: string;
        trustedTimeEvidenceId: string;
        requestStateOrphanRecovery:
          | {
              kind: "not_applicable";
              requestStateOrphanProviderStateId: null;
              stateBindingId: null;
              reconciliationRetentionLeaseId: null;
              expectedRecoveryControlEpoch: null;
              newRecoveryControlEpoch: null;
              recoveryNotAfter: null;
              cumulativeRecoveryAttemptCeiling: null;
              expectedCumulativeConsumedRecoveryAttemptCount: null;
              newCumulativeConsumedRecoveryAttemptCount: null;
              trustedTimeEvidenceId: null;
            }
          | {
              kind: "request_state_orphan";
              requestStateOrphanProviderStateId: string;
              stateBindingId: string;
              reconciliationRetentionLeaseId: string;
              expectedRecoveryControlEpoch: string;
              newRecoveryControlEpoch: string;
              recoveryNotAfter: string;
              cumulativeRecoveryAttemptCeiling: number;
              expectedCumulativeConsumedRecoveryAttemptCount: number;
              newCumulativeConsumedRecoveryAttemptCount: number;
              trustedTimeEvidenceId: string;
            };
      }
    | {
        recoveryAction: "fresh_processor_connector_attempt";
        certificationOwner: "processor_connector";
        originalDispatchIntent: Extract<
          RemoteDispatchIntentRef,
          { kind: "processor_connector" }
        >;
        previousProcessorConnectorExecutionAdmissionId: string;
        processorConnectorAttemptProgressId: string;
        expectedProcessorConnectorAttemptProgressEpoch: string;
        newProcessorConnectorExecutionAdmissionId: string;
        newProcessorConnectorDispatchIntentId: string;
        cumulativeBudgetEnvelopeSnapshotId: string;
        recoveryNotAfter: string;
        trustedTimeEvidenceId: string;
      }
    | {
        recoveryAction: "reconcile_resource_without_create_redispatch";
        certificationOwner: "provider_resource_terminal";
        originalDispatchIntent: Extract<RemoteDispatchIntentRef, { kind: "provider" }>;
        resourceCostExposureId: string;
        providerOutcomeRecordId: string;
        reconciliationRetentionLeaseId: string;
        expectedReconciliationRetentionLeaseOwnershipEpoch: string;
        resourceRecoveryOwner: ResourceRecoveryOwnerRef;
        expectedOrphanResourceRecoveryControlEpoch: string;
        newOrphanResourceRecoveryControlEpoch: string;
        orphanRecoveryBoundVersionId: string;
        orphanRecoveryBoundVersionHash: string;
        expectedCumulativeConsumedInvocationCount: number;
        authorizationInvocationStartExclusive: number;
        authorizationInvocationEndInclusive: number;
        expectedRecoveryAuthorizationHighWaterMark: string;
        newRecoveryAuthorizationHighWaterMark: string;
        expectedRecoveryAuthorizationChainHash: string;
        newRecoveryAuthorizationChainHash: string;
        reconciliationOperationDefinitionVersionId: string;
        lifecycleServicePrincipalId: string;
        reconciliationRequestId: string;
        reconciliationBudgetEnvelopeId: string;
        resourceReconciliationAttemptProgressId: string;
        initialResourceReconciliationAttemptId: string;
        initialResourceReconciliationAdmissionId: string;
        initialResourceReconciliationDispatchIntentId: string;
        maximumReconciliationInvocations: number;
        reconciliationDeadline: string;
        originalCreateRedispatchAllowed: false;
      }
  );

type UpstreamRetrySafety =
  | { kind: "never_redispatch_after_send_started" }
  | {
      kind: "certified_upstream_idempotency";
      upstreamIdempotencyCertificationId: string;
      upstreamIdempotencyKeyBindingId: string;
      upstreamIdempotencyKeyBindingHash: string;
      upstreamIdempotencyKeyHmac: string;
      recoveryNotAfter: string;
      certificationUse:
        | { kind: "initial_key_binding"; upstreamRecoveryAuthorizationId: null }
        | {
            kind: "authorized_recovery_attempt";
            upstreamRecoveryAuthorizationId: string;
          };
    };

type ResourceTerminalUpstreamRetrySafety =
  | { kind: "never_redispatch_after_send_started" }
  | {
      kind: "certified_upstream_idempotency";
      upstreamIdempotencyCertificationId: string;
      upstreamIdempotencyKeyBindingId: string;
      upstreamIdempotencyKeyBindingHash: string;
      upstreamIdempotencyKeyHmac: string;
      recoveryNotAfter: string;
      certificationUse: {
        kind: "initial_key_binding";
        upstreamRecoveryAuthorizationId: null;
      };
    };

type ResourceReconciliationBudgetAllocation = {
  resourceReconciliationBudgetAllocationId: string;
  resourceReconciliationAdmissionId: string;
  budgetCommitmentSliceId: string;
  budgetQuoteSetMemberId: string;
  sourceBudgetEnvelopeMemberId: string;
  budgetReservationCommitmentId: string;
  maximumBranchAllocations: BudgetMaximumBranchAllocationRef[];
  budgetConversion: BudgetCurrencyConversion;
  allocatedFixedPoint: string;
};

type ResourceReconciliationAdmissionBase = {
  resourceReconciliationAdmissionId: string;
  resourceReconciliationAttemptId: string;
  resourceReconciliationAttemptProgressId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  lifecycleServicePrincipalId: string;
  activeExecutionReferenceId: string;
  upstreamRecoveryAuthorizationId: string;
  upstreamIdempotencyCertificationId: string;
  resourceCostExposureId: string;
  providerOutcomeRecordId: string;
  reconciliationRetentionLeaseId: string;
  expectedReconciliationRetentionLeaseOwnershipEpoch: string;
  resourceRecoveryOwner: ResourceRecoveryOwnerRef;
  expectedOrphanResourceRecoveryControlEpoch: string;
  newOrphanResourceRecoveryControlEpoch: string;
  orphanRecoveryBoundVersionId: string;
  orphanRecoveryBoundVersionHash: string;
  authorizationInvocationOrdinal: number;
  expectedOrphanCumulativeConsumedInvocationCount: number;
  newOrphanCumulativeConsumedInvocationCount: number;
  recoveryAuthorizationHighWaterMark: string;
  recoveryAuthorizationChainHash: string;
  executionTarget: ExecutionTargetRef;
  reconciliationOperationDefinitionVersionId: string;
  targetExecuteAuthorizationDecisionId: string;
  authorizationOutcome: "allowed";
  authorizationPolicyVersionIds: NonEmptyArray<string>;
  authorizationPolicyGeneration: string;
  healthDecisionId: string;
  circuitDecisionId: string;
  capacityAdmissionId: string;
  concurrencyAdmissionId: string;
  quotaAdmissionId: string;
  narrowingDecisionId: string;
  providerCredentialDirectoryGeneration: string;
  credentialAccess: Extract<
    ProviderAttemptCredentialAccess,
    { kind: "retained_lease_intersection" }
  >;
  credentialEligibilityDecisionId: string;
  credentialQuotaAdmissionId: string;
  canonicalRequestCostValuationId: string;
  budgetEnvelopeId: string;
  budgetEnvelopeSnapshotId: string;
  budgetQuoteSetId: string;
  resourceReconciliationDispatchIntentId: string;
  runtimeAdmissionFencingEpoch: string;
  narrowingGeneration: string;
  validThrough: string;
  admittedAt: string;
  consumedAt: string;
  signature: string;
};

type ResourceReconciliationAdmission = ResourceReconciliationAdmissionBase &
  (
    | {
        attemptTransition: "initial";
        previousResourceReconciliationAttemptId: null;
        expectedPreviousAttemptProgressEpoch: null;
      }
    | {
        attemptTransition: "next_poll";
        previousResourceReconciliationAttemptId: string;
        expectedPreviousAttemptProgressEpoch: string;
      }
  ) &
  (
    | {
        budgetAdmission: Extract<BudgetAdmission, { kind: "no_applicable_budget_rules" }>;
        allocations: [];
      }
    | {
        budgetAdmission: Extract<BudgetAdmission, { kind: "reserved" }>;
        allocations: NonEmptyArray<ResourceReconciliationBudgetAllocation>;
      }
  );

type ResourceReconciliationDispatchIntent = RemoteDispatchIntentBase & {
  resourceReconciliationDispatchIntentId: string;
  resourceReconciliationAttemptId: string;
  resourceReconciliationAdmissionId: string;
  resourceReconciliationAttemptProgressId: string;
  lifecycleServicePrincipalId: string;
  upstreamRecoveryAuthorizationId: string;
  upstreamIdempotencyCertificationId: string;
  resourceCostExposureId: string;
  providerOutcomeRecordId: string;
  reconciliationRetentionLeaseId: string;
  expectedReconciliationRetentionLeaseOwnershipEpoch: string;
  resourceRecoveryOwner: ResourceRecoveryOwnerRef;
  admittedOrphanResourceRecoveryControlEpoch: string;
  orphanRecoveryBoundVersionId: string;
  authorizationInvocationOrdinal: number;
  orphanCumulativeConsumedInvocationCount: number;
  recoveryAuthorizationHighWaterMark: string;
  recoveryAuthorizationChainHash: string;
  executionTarget: ExecutionTargetRef;
  reconciliationOperationDefinitionVersionId: string;
  canonicalRequestCostValuationId: string;
  budgetEnvelopeSnapshotId: string;
  budgetQuoteSetId: string;
  dispatchSafety: {
    kind: "certified_read_only_resource_reconciliation";
    originalCreateRedispatchAllowed: false;
  };
};

type ResourceReconciliationObservation = {
  resourceReconciliationObservationId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  resourceReconciliationAttemptId: string;
  resourceReconciliationAdmissionId: string;
  resourceReconciliationDispatchIntentId: string;
  remoteDispatchAuthorityId: string;
  targetCodecEvidenceId: string;
  observedAt: string;
  signature: string;
} &
  (
    | {
        observationKind: "original_resource_identity_proven";
        encryptedUpstreamIdRef: string;
        originalResourceIdentityEvidenceId: string;
      }
    | {
        observationKind: "original_resource_not_yet_observable";
        encryptedUpstreamIdRef: null;
        retryAfter: string | null;
      }
    | {
        observationKind: "original_resource_definitively_absent";
        encryptedUpstreamIdRef: null;
        definitiveAbsenceEvidenceId: string;
      }
    | {
        observationKind: "poll_outcome_indeterminate";
        encryptedUpstreamIdRef: null;
        indeterminateEvidenceId: string;
      }
  );

type ResourceReconciliationCompletedHeadRef =
  | {
      completedHeadKind: "no_completed_dispatch";
      lastCompletedResourceReconciliationAttemptId: null;
      lastCompletedResourceReconciliationAdmissionId: null;
      lastCompletedResourceReconciliationDispatchIntentId: null;
      lastCompletedResourceReconciliationAttemptOutcomeId: null;
      lastCompletedResourceReconciliationObservationId: null;
    }
  | {
      completedHeadKind: "completed_dispatch";
      lastCompletedResourceReconciliationAttemptId: string;
      lastCompletedResourceReconciliationAdmissionId: string;
      lastCompletedResourceReconciliationDispatchIntentId: string;
      lastCompletedResourceReconciliationAttemptOutcomeId: string;
      lastCompletedResourceReconciliationObservationId: string | null;
    };

type ResourceReconciliationPendingExhaustionClosure =
  | {
      pendingClosureKind: "none_between_polls";
      pendingResourceReconciliationAttemptId: null;
      pendingResourceReconciliationAdmissionId: null;
      pendingResourceReconciliationDispatchIntentId: null;
      pendingRemoteDispatchAuthorityId: null;
      preDispatchCancellationEvidenceId: null;
      terminalPendingAttemptOutcomeId: null;
    }
  | {
      pendingClosureKind: "cancelled_before_send";
      pendingResourceReconciliationAttemptId: string;
      pendingResourceReconciliationAdmissionId: string;
      pendingResourceReconciliationDispatchIntentId: string;
      pendingRemoteDispatchAuthorityId: string;
      preDispatchCancellationEvidenceId: string;
      terminalPendingAttemptOutcomeId: string;
    };

type ResourceReconciliationControlExhaustionEvidence = {
  resourceReconciliationControlExhaustionEvidenceId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  upstreamRecoveryAuthorizationId: string;
  resourceReconciliationAttemptProgressId: string;
  expectedResourceReconciliationAttemptProgressEpoch: string;
  expectedResourceReconciliationAttemptProgressHash: string;
  newResourceReconciliationAttemptProgressEpoch: string;
  expectedActiveOrphanResourceRecoveryControlEpoch: string;
  newAvailableOrphanResourceRecoveryControlEpoch: string;
  exhaustionReason:
    | "authorization_invocation_ceiling"
    | "authorization_deadline"
    | "orphan_cumulative_invocation_ceiling"
    | "orphan_absolute_horizon";
  completedHead: ResourceReconciliationCompletedHeadRef;
  pendingClosure: ResourceReconciliationPendingExhaustionClosure;
  consumedInvocationCount: number;
  maximumInvocations: number;
  reconciliationDeadline: string;
  orphanRecoveryBoundVersionId: string;
  orphanCumulativeConsumedInvocationCount: number;
  orphanCumulativeInvocationCeiling: number;
  orphanAbsoluteRecoveryHorizonEndsAt: string;
  recoveryAuthorizationHighWaterMark: string;
  recoveryAuthorizationChainHash: string;
  trustedTimeObservationId: string;
  exhaustedAt: string;
  signature: string;
};

type ResourceReconciliationPreDispatchCancellationEvidenceBase = {
  resourceReconciliationPreDispatchCancellationEvidenceId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  upstreamRecoveryAuthorizationId: string;
  resourceReconciliationAttemptProgressId: string;
  resourceReconciliationAttemptId: string;
  resourceReconciliationAdmissionId: string;
  resourceReconciliationDispatchIntentId: string;
  terminalOrphanResourceRecoveryControlEpoch: string;
  remoteDispatchAuthorityId: string;
  terminalRemoteDispatchStateTransitionId: string;
  activeExecutionTerminalEvidenceId: string;
  definitiveNoChargeEvidenceId: string;
  budgetDispositionCertificateId: string;
  cancelledAt: string;
  signature: string;
};

type ResourceReconciliationPreDispatchCancellationEvidence =
  ResourceReconciliationPreDispatchCancellationEvidenceBase &
    (
      | {
          cancellationReason: "policy_invalidated";
          dispatchDeadlineReachedEvidenceId: null;
          policyInvalidationEvidenceId: string;
          credentialRevocationEvidenceId: null;
          admissionExpiryEvidenceId: null;
          trustedTimeObservationId: null;
          cleanupClosureIntentId: null;
        }
      | {
          cancellationReason: "credential_revoked";
          dispatchDeadlineReachedEvidenceId: null;
          policyInvalidationEvidenceId: null;
          credentialRevocationEvidenceId: string;
          admissionExpiryEvidenceId: null;
          trustedTimeObservationId: null;
          cleanupClosureIntentId: null;
        }
      | {
          cancellationReason: "admission_expired";
          dispatchDeadlineReachedEvidenceId: null;
          policyInvalidationEvidenceId: null;
          credentialRevocationEvidenceId: null;
          admissionExpiryEvidenceId: string;
          trustedTimeObservationId: string;
          cleanupClosureIntentId: null;
        }
      | {
          cancellationReason: "dispatch_deadline_reached";
          dispatchDeadlineReachedEvidenceId: string;
          policyInvalidationEvidenceId: null;
          credentialRevocationEvidenceId: null;
          admissionExpiryEvidenceId: null;
          trustedTimeObservationId: null;
          cleanupClosureIntentId: null;
        }
      | {
          cancellationReason: "cleanup_supersession";
          dispatchDeadlineReachedEvidenceId: null;
          policyInvalidationEvidenceId: null;
          credentialRevocationEvidenceId: null;
          admissionExpiryEvidenceId: null;
          trustedTimeObservationId: null;
          cleanupClosureIntentId: string;
        }
    );

type ResourceReconciliationCleanupSupersessionEvidenceBase = {
  resourceReconciliationCleanupSupersessionEvidenceId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  upstreamRecoveryAuthorizationId: string;
  resourceReconciliationAttemptProgressId: string;
  terminalResourceReconciliationAttemptId: string;
  terminalResourceReconciliationAdmissionId: string;
  terminalResourceReconciliationDispatchIntentId: string;
  terminalResourceReconciliationAttemptOutcomeId: string;
  terminalResourceReconciliationObservationId: string | null;
  remoteDispatchAuthorityId: string;
  terminalRemoteDispatchStateTransitionId: string;
  cleanupClosureIntentId: string;
  closingOrphanResourceRecoveryControlEpoch: string;
  activeExecutionTerminalEvidenceId: string;
  budgetDispositionCertificateId: string;
  cleanupOperationTerminalEvidenceId: string;
  supersededAt: string;
  signature: string;
};

type ResourceReconciliationCleanupSupersessionEvidence =
  ResourceReconciliationCleanupSupersessionEvidenceBase &
    (
      | {
          dispatchDisposition: "cancelled_before_send";
          terminalResourceReconciliationObservationId: null;
          preDispatchCancellationEvidenceId: string;
          definitiveNotSentEvidenceId: null;
          definitiveNoChargeEvidenceId: string;
          requestCostReconciliationCertificateId: null;
          canonicalRequestCostSettlementId: null;
        }
      | {
          dispatchDisposition: "definitive_not_sent_no_charge";
          terminalResourceReconciliationObservationId: null;
          preDispatchCancellationEvidenceId: null;
          definitiveNotSentEvidenceId: string;
          definitiveNoChargeEvidenceId: string;
          requestCostReconciliationCertificateId: null;
          canonicalRequestCostSettlementId: null;
        }
      | {
          dispatchDisposition: "sent_cost_reconciled";
          preDispatchCancellationEvidenceId: null;
          definitiveNotSentEvidenceId: null;
          definitiveNoChargeEvidenceId: null;
          requestCostReconciliationCertificateId: string;
          canonicalRequestCostSettlementId: string;
        }
    );

type ResourceReconciliationAttemptOutcomeBase = {
  resourceReconciliationAttemptOutcomeId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  resourceReconciliationAttemptId: string;
  resourceReconciliationAdmissionId: string;
  resourceReconciliationDispatchIntentId: string;
  remoteDispatchAuthorityId: string;
  terminalRemoteDispatchStateTransitionId: string;
  recordedAt: string;
  signature: string;
};

type ResourceReconciliationAttemptOutcome =
  ResourceReconciliationAttemptOutcomeBase &
    (
      | {
          outcomeKind: "codec_observation";
          resourceReconciliationObservationId: string;
          definitiveNotSentEvidenceId: null;
          indeterminateEvidenceId: null;
          preDispatchCancellationEvidenceId: null;
        }
      | {
          outcomeKind: "definitive_not_sent";
          resourceReconciliationObservationId: null;
          definitiveNotSentEvidenceId: string;
          indeterminateEvidenceId: null;
          preDispatchCancellationEvidenceId: null;
        }
      | {
          outcomeKind: "sent_outcome_indeterminate";
          resourceReconciliationObservationId: null;
          definitiveNotSentEvidenceId: null;
          indeterminateEvidenceId: string;
          preDispatchCancellationEvidenceId: null;
        }
      | {
          outcomeKind: "pre_dispatch_cancelled";
          resourceReconciliationObservationId: null;
          definitiveNotSentEvidenceId: null;
          indeterminateEvidenceId: null;
          preDispatchCancellationEvidenceId: string;
        }
    );

type ResourceReconciliationAttempt = {
  resourceReconciliationAttemptId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  resourceReconciliationAttemptProgressId: string;
  resourceReconciliationAdmissionId: string;
  resourceReconciliationDispatchIntentId: string;
} &
  (
    | {
        state: "pending_outcome";
        resourceReconciliationAttemptOutcomeId: null;
      }
    | {
        state: "terminal";
        resourceReconciliationAttemptOutcomeId: string;
      }
  );

type ResourceReconciliationAttemptProgressBase = {
  resourceReconciliationAttemptProgressId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  upstreamRecoveryAuthorizationId: string;
  resourceCostExposureId: string;
  providerOutcomeRecordId: string;
  reconciliationRetentionLeaseId: string;
  expectedReconciliationRetentionLeaseOwnershipEpoch: string;
  resourceRecoveryOwner: ResourceRecoveryOwnerRef;
  currentOrphanResourceRecoveryControlEpoch: string;
  currentResourceReconciliationAttemptId: string;
  currentResourceReconciliationAdmissionId: string;
  currentResourceReconciliationDispatchIntentId: string;
  consumedInvocationCount: number;
  maximumInvocations: number;
  reconciliationDeadline: string;
  orphanRecoveryBoundVersionId: string;
  orphanRecoveryBoundVersionHash: string;
  authorizationInvocationStartExclusive: number;
  authorizationInvocationEndInclusive: number;
  orphanCumulativeConsumedInvocationCount: number;
  orphanCumulativeInvocationCeiling: number;
  orphanAbsoluteRecoveryHorizonEndsAt: string;
  recoveryAuthorizationHighWaterMark: string;
  recoveryAuthorizationChainHash: string;
  progressEpoch: string;
  progressHash: string;
  fencingEpoch: string;
  updatedAt: string;
};

type ResourceReconciliationAttemptProgress =
  ResourceReconciliationAttemptProgressBase &
    (
      | {
          state: "open";
          openHeadKind: "pending_dispatch_or_outcome";
          currentResourceReconciliationAttemptOutcomeId: null;
          terminalResourceReconciliationAttemptId: null;
          terminalResourceReconciliationAdmissionId: null;
          terminalResourceReconciliationDispatchIntentId: null;
          terminalResourceReconciliationAttemptOutcomeId: null;
          terminalResourceReconciliationObservationId: null;
          lastNonterminalResourceReconciliationObservationId: null;
          controlExhaustionEvidenceId: null;
          preDispatchCancellationEvidenceId: null;
          cleanupSupersessionEvidenceId: null;
          terminalDisposition: null;
        }
      | {
          state: "open";
          openHeadKind: "between_polls_after_nonterminal_outcome";
          currentResourceReconciliationAttemptOutcomeId: string;
          terminalResourceReconciliationAttemptId: null;
          terminalResourceReconciliationAdmissionId: null;
          terminalResourceReconciliationDispatchIntentId: null;
          terminalResourceReconciliationAttemptOutcomeId: null;
          terminalResourceReconciliationObservationId: null;
          lastNonterminalResourceReconciliationObservationId: string | null;
          controlExhaustionEvidenceId: null;
          preDispatchCancellationEvidenceId: null;
          cleanupSupersessionEvidenceId: null;
          terminalDisposition: null;
        }
      | {
          state: "terminal";
          terminalResourceReconciliationAttemptId: string;
          terminalResourceReconciliationAdmissionId: string;
          terminalResourceReconciliationDispatchIntentId: string;
          terminalResourceReconciliationAttemptOutcomeId: string;
          terminalResourceReconciliationObservationId: string;
          lastNonterminalResourceReconciliationObservationId: null;
          controlExhaustionEvidenceId: null;
          preDispatchCancellationEvidenceId: null;
          cleanupSupersessionEvidenceId: null;
          terminalDisposition: "original_resource_identity_proven";
        }
      | {
          state: "terminal";
          terminalResourceReconciliationAttemptId: string;
          terminalResourceReconciliationAdmissionId: string;
          terminalResourceReconciliationDispatchIntentId: string;
          terminalResourceReconciliationAttemptOutcomeId: string;
          terminalResourceReconciliationObservationId: string;
          lastNonterminalResourceReconciliationObservationId: null;
          controlExhaustionEvidenceId: null;
          preDispatchCancellationEvidenceId: null;
          cleanupSupersessionEvidenceId: null;
          terminalDisposition: "original_resource_definitively_absent";
        }
      | {
          state: "terminal";
          terminalResourceReconciliationAttemptId: null;
          terminalResourceReconciliationAdmissionId: null;
          terminalResourceReconciliationDispatchIntentId: null;
          terminalResourceReconciliationAttemptOutcomeId: null;
          terminalResourceReconciliationObservationId: null;
          lastNonterminalResourceReconciliationObservationId: string | null;
          lastCompletedHead: ResourceReconciliationCompletedHeadRef;
          controlExhaustionEvidenceId: string;
          preDispatchCancellationEvidenceId: null;
          cleanupSupersessionEvidenceId: null;
          terminalDisposition: "recovery_control_exhausted";
        }
      | {
          state: "terminal";
          terminalResourceReconciliationAttemptId: string;
          terminalResourceReconciliationAdmissionId: string;
          terminalResourceReconciliationDispatchIntentId: string;
          terminalResourceReconciliationAttemptOutcomeId: string;
          terminalResourceReconciliationObservationId: null;
          lastNonterminalResourceReconciliationObservationId: string | null;
          controlExhaustionEvidenceId: null;
          preDispatchCancellationEvidenceId: string;
          cleanupSupersessionEvidenceId: null;
          terminalDisposition: "pre_dispatch_cancelled";
        }
      | {
          state: "terminal";
          terminalResourceReconciliationAttemptId: string;
          terminalResourceReconciliationAdmissionId: string;
          terminalResourceReconciliationDispatchIntentId: string;
          terminalResourceReconciliationAttemptOutcomeId: string;
          terminalResourceReconciliationObservationId: string | null;
          lastNonterminalResourceReconciliationObservationId: string | null;
          controlExhaustionEvidenceId: null;
          preDispatchCancellationEvidenceId: string | null;
          cleanupSupersessionEvidenceId: string;
          terminalDisposition: "cleanup_superseded";
        }
    );

type RemoteDispatchAuthorityBase = {
  remoteDispatchAuthorityId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  dispatchIntent: RemoteDispatchIntentRef;
  currentStateTransitionId: string;
  currentStateTransitionHash: string;
  transitionEpoch: string;
  fencingEpoch: string;
  maximumInvocations: 1;
  createdAt: string;
};

type RemoteDispatchAuthority = RemoteDispatchAuthorityBase &
  (
    | {
        state: "ready";
        dispatchClaimId: null;
        executorId: null;
        executorFencingToken: null;
      }
    | {
        state: "claimed_before_send";
        dispatchClaimId: string;
        executorId: string;
        executorFencingToken: string;
        claimExpiresAt: string;
      }
    | {
        state: "send_started" | "awaiting_outcome";
        dispatchClaimId: string;
        executorId: string;
        executorFencingToken: string;
        sendStartedAt: string;
        reconciliationOwnerId: string;
      }
    | {
        state: "definitive_not_sent";
        dispatchClaimId: string;
        executorId: string;
        executorFencingToken: string;
        definitiveNotSentEvidenceId: string;
      }
    | ({
        state: "cancelled_before_send";
        cancellationEvidence: RemoteDispatchPreSendCancellationEvidenceRef;
      } &
        (
          | {
              dispatchClaimId: null;
              executorId: null;
              executorFencingToken: null;
            }
          | {
              dispatchClaimId: string;
              executorId: string;
              executorFencingToken: string;
            }
        ))
    | {
        state: "indeterminate";
        dispatchClaimId: string;
        executorId: string;
        executorFencingToken: string;
        sendStartedAt: string;
        reconciliationOwnerId: string;
        indeterminateEvidenceId: string;
      }
    | {
        state: "terminal";
        dispatchClaimId: string;
        executorId: string;
        executorFencingToken: string;
        remoteOutcomeEvidenceId: string;
      }
  );

type RemoteDispatchStateTransitionBase = {
  remoteDispatchStateTransitionId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  remoteDispatchAuthorityId: string;
  transitionEpoch: string;
  previousStateTransitionId: string | null;
  previousStateTransitionHash: string | null;
  stateTransitionHash: string;
  createdAt: string;
  signature: string;
};

type RemoteDispatchStateTransition = RemoteDispatchStateTransitionBase &
  (
    | {
        transitionKind: "initialized_ready";
        previousStateTransitionId: null;
        previousStateTransitionHash: null;
        state: "ready";
        dispatchClaimId: null;
        executorId: null;
        executorFencingToken: null;
      }
    | {
        transitionKind: "claim_before_send";
        previousStateTransitionId: string;
        previousStateTransitionHash: string;
        previousState: "ready";
        state: "claimed_before_send";
        dispatchClaimId: string;
        executorId: string;
        executorFencingToken: string;
        claimExpiresAt: string;
      }
    | {
        transitionKind: "release_expired_pre_send_claim";
        previousStateTransitionId: string;
        previousStateTransitionHash: string;
        previousState: "claimed_before_send";
        state: "ready";
        dispatchClaimId: null;
        executorId: null;
        executorFencingToken: null;
        expiredDispatchClaimId: string;
        claimExpiryEvidenceId: string;
      }
    | {
        transitionKind: "mark_send_started";
        previousStateTransitionId: string;
        previousStateTransitionHash: string;
        previousState: "claimed_before_send";
        state: "send_started";
        dispatchClaimId: string;
        executorId: string;
        executorFencingToken: string;
        dispatchNotAfter: string;
        dispatchDeadlineDerivationVersionId: string;
        trustedTimeSourceId: string;
        trustedTimeEvidenceId: string;
        sendStartedAt: string;
        reconciliationOwnerId: string;
      }
    | {
        transitionKind: "await_outcome";
        previousStateTransitionId: string;
        previousStateTransitionHash: string;
        previousState: "send_started";
        state: "awaiting_outcome";
        dispatchClaimId: string;
        executorId: string;
        executorFencingToken: string;
        sendStartedAt: string;
        reconciliationOwnerId: string;
      }
    | {
        transitionKind: "prove_definitive_not_sent";
        previousStateTransitionId: string;
        previousStateTransitionHash: string;
        previousState: "claimed_before_send";
        state: "definitive_not_sent";
        dispatchClaimId: string;
        executorId: string;
        executorFencingToken: string;
        definitiveNotSentEvidenceId: string;
      }
    | ({
        transitionKind: "cancel_before_send";
        previousStateTransitionId: string;
        previousStateTransitionHash: string;
        state: "cancelled_before_send";
        cancellationEvidence: RemoteDispatchPreSendCancellationEvidenceRef;
      } &
        (
          | {
              previousState: "ready";
              dispatchClaimId: null;
              executorId: null;
              executorFencingToken: null;
            }
          | {
              previousState: "claimed_before_send";
              dispatchClaimId: string;
              executorId: string;
              executorFencingToken: string;
            }
        ))
    | {
        transitionKind: "mark_indeterminate";
        previousStateTransitionId: string;
        previousStateTransitionHash: string;
        previousState: "send_started" | "awaiting_outcome";
        state: "indeterminate";
        dispatchClaimId: string;
        executorId: string;
        executorFencingToken: string;
        sendStartedAt: string;
        reconciliationOwnerId: string;
        indeterminateEvidenceId: string;
      }
    | {
        transitionKind: "record_terminal_outcome";
        previousStateTransitionId: string;
        previousStateTransitionHash: string;
        previousState: "send_started" | "awaiting_outcome" | "indeterminate";
        state: "terminal";
        dispatchClaimId: string;
        executorId: string;
        executorFencingToken: string;
        remoteOutcomeEvidenceId: string;
      }
  );

type ProviderDispatchIntentBase = RemoteDispatchIntentBase & {
  providerDispatchIntentId: string;
  attemptId: string;
  executionDecisionId: string;
  selectedExecutionTargetId: string;
  providerAttemptAdmissionId: string;
  providerAttemptProgressId: string;
  budgetAttemptAdmissionId: string;
};

type ProviderDispatchIntent = ProviderDispatchIntentBase &
  (
    | {
        dispatchOwner: "external_request";
        billingLifecycle: "request_terminal";
        effectiveOperationResolutionId: string;
        processorInvocationId: null;
        processorInputRefId: null;
        processorModelTargetAuthorizationId: null;
        upstreamRetrySafety: UpstreamRetrySafety;
      }
    | {
        dispatchOwner: "external_request";
        billingLifecycle: "resource_terminal";
        effectiveOperationResolutionId: string;
        processorInvocationId: null;
        processorInputRefId: null;
        processorModelTargetAuthorizationId: null;
        upstreamRetrySafety: ResourceTerminalUpstreamRetrySafety;
      }
    | {
        dispatchOwner: "processor_model";
        billingLifecycle: "request_terminal";
        effectiveOperationResolutionId: null;
        processorInvocationId: string;
        processorInputRefId: string;
        processorModelTargetAuthorizationId: string;
        upstreamRetrySafety: UpstreamRetrySafety;
      }
  );

type ProviderAttemptBase = {
  attemptId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  executionDecisionId: string;
  activeExecutionReferenceId: string;
  selectedExecutionTargetId: string;
  providerAttemptAdmissionId: string;
  providerAttemptProgressId: string;
  budgetAttemptAdmissionId: string;
  providerDispatchIntentId: string;
};

type ProviderAttempt = ProviderAttemptBase &
  (
    | {
        outcomeTracking: "definitive_request_terminal";
        providerOutcomeRecordId: null;
        reconciliationRetentionLeaseId: null;
        credentialLifecycleRequirementRegistrationId: null;
        credentialLifecycleCoverageReceiptId: null;
        resourceCostExposure: { kind: "not_applicable" };
      }
    | {
        outcomeTracking: "reconciliation_required";
        providerOutcomeRecordId: string;
        reconciliationRetentionLeaseId: string;
        credentialLifecycleRequirementRegistrationId: string;
        credentialLifecycleCoverageReceiptId: string;
        resourceCostExposure:
          | { kind: "not_applicable" }
          | { kind: "prepared"; resourceCostExposureId: string };
        stateCreationTracking:
          | { kind: "not_state_creating" }
          | {
              kind: "state_creating";
              stateLifecycleCreatorRegistrationId: string;
            };
      }
  );

type StateBindingBase = {
  stateBindingId: string;
  idempotencyRecordId: string;
  organizationId: string;
  workspaceId: string;
  ownerPrincipalId: string;
  publicResourceId: string;
  resourceKind: string;
  allowedActions: string[];
  sharePolicyId: string | null;
  originLogicalModelId: string | null;
  compatibleLogicalModelIds: string[];
  selectedExecutionTargetId: string;
  executionConstraint: PersistedStateExecutionConstraint;
  canonicalModelReleaseId: string | null;
  originWorkspaceRevisionId: string;
  operationDefinitionVersionId: string;
  resourceProfileVersionId: string | null;
  stateMappingCertificationId: string;
  dataClassification: string;
  lifecyclePolicyVersionIds: NonEmptyArray<string>;
  retentionPolicyVersionId: string;
  lineageRootBindingId: string;
  parentBindingId: string | null;
  ingressWire: ApiWireRef;
  expiresAt: string;
};

type ResourceCostPlanBase = {
  resourceCostPlanVersionId: string;
  operation: OperationDefinitionRef;
  executionTarget: ExecutionTargetRef;
  priceFxSelectionPolicyVersionId: string;
  costEstimatorContractVersionId: string;
  billableUnitSchemaVersionId: string;
  terminalOperationDefinitionVersionIds: NonEmptyArray<string>;
};

type ResourceCostPlan =
  | (ResourceCostPlanBase & {
      enforcementClass: "firm";
      costBoundAuthority: "provider_enforced_expiry";
      maximumBillingDuration: string;
    })
  | (ResourceCostPlanBase & {
      enforcementClass: "firm";
      costBoundAuthority: "contract_maximum_charge";
      contractualMaximumVersionId: string;
      budgetCompatibility:
        | { kind: "lifetime_non_resetting_only" }
        | {
            kind: "fully_attributed_at_admission";
            attributionContractVersionId: string;
          };
    })
  | (ResourceCostPlanBase & {
      enforcementClass: "operational";
      costBoundAuthority: "gateway_cleanup_only";
      authorizedUseDuration: string;
      cleanupGracePeriod: string;
      initialFundedIntervalDuration: string;
      rollingValuationPolicyVersionId: string;
      rollingReservationPolicyVersionId: string;
    });

type ResourceBudgetCommitmentEpochBase = {
  budgetCommitmentEpochId: string;
  resourceCostValuationEpochId: string;
  sourceBudgetCommitmentQuoteId: string;
  budgetCommitmentSliceId: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScope: BudgetScopeRef;
  budgetCurrency: string;
  budgetConversion: BudgetCurrencyConversion;
  budgetReservationCommitmentId: string;
  reservationId: string;
};

type ResourceBudgetCommitmentEpoch = ResourceBudgetCommitmentEpochBase &
  (
    | {
        commitmentKind: "firm_provider_expiry";
        fundedThrough: string;
        valuationBasis: ScheduledCostValuationBasis;
        budgetAttribution: BudgetCommitmentAttribution;
        reservedExposureFixedPoint: string;
      }
    | {
        commitmentKind: "firm_contract_charge_cap";
        fundedThrough: null;
        valuationBasis: ContractCapCostValuationBasis;
        budgetAttribution: ContractBudgetAttribution;
        reservedExposureFixedPoint: string;
      }
    | {
        commitmentKind: "operational_funded_interval";
        fundedThrough: string;
        valuationBasis: ScheduledCostValuationBasis;
        budgetAttribution: BudgetCommitmentAttribution;
        forecastFixedPoint: string;
        reservationFixedPoint: string;
      }
  );

type ResourceCostObligationRef =
  | { kind: "active"; resourceCostObligationId: string }
  | { kind: "orphan"; orphanResourceCostObligationId: string };

type ResourceLifecycleSliceTransition =
  | {
      kind: "same_slice_set";
      previousApplicableBudgetRuleSetDigest: string;
      currentApplicableBudgetRuleSetDigest: string;
      previousApplicableBudgetCommitmentSliceSetDigest: string;
      currentApplicableBudgetCommitmentSliceSetDigest: string;
    }
  | {
      kind: "certified_period_boundary";
      previousApplicableBudgetRuleSetDigest: string;
      currentApplicableBudgetRuleSetDigest: string;
      preservedBudgetRuleSetDigest: string;
      previousApplicableBudgetCommitmentSliceSetDigest: string;
      currentApplicableBudgetCommitmentSliceSetDigest: string;
      boundaryAt: string;
      periodSuccessorEvidenceId: string;
    }
  | {
      kind: "authorized_policy_replacement";
      previousApplicableBudgetRuleSetDigest: string;
      currentApplicableBudgetRuleSetDigest: string;
      previousApplicableBudgetCommitmentSliceSetDigest: string;
      currentApplicableBudgetCommitmentSliceSetDigest: string;
      lifecycleBudgetPolicyAuthorizationId: string;
    };

type ResourceLifecycleFundingQuoteSetBase = {
  resourceLifecycleFundingQuoteSetId: string;
  organizationId: string;
  workspaceId: string;
  resourceCostObligation: ResourceCostObligationRef;
  plannedResourceLifecycleFundingAdmissionId: string;
  resourceCostExposureId: string;
  resourceCostPlanRef: Extract<ResourceCostPlanRef, { enforcementClass: "operational" }>;
  previousResourceCostValuationEpochId: string;
  previousResourceCostValuationEpochHash: string;
  intervalStartsAt: string;
  intervalEndsAt: string;
  canonicalProviderCostValuation: Extract<
    CanonicalResourceCostValuation,
    { valuationKind: "operational_funded_interval" }
  >;
  sliceTransition: ResourceLifecycleSliceTransition;
  valuedAt: string;
  validThrough: string;
  signature: string;
};

type ResourceLifecycleFundingQuoteSet = ResourceLifecycleFundingQuoteSetBase &
  BudgetCommitmentCoverage<
    Extract<
      ResourceBudgetCommitmentQuote,
      { commitmentKind: "operational_funded_interval" }
    >
  >;

type ResourceLifecycleFundingAllocation = {
  resourceLifecycleFundingAllocationId: string;
  organizationId: string;
  workspaceId: string;
  resourceLifecycleFundingAdmissionId: string;
  budgetCommitmentSliceId: string;
  sourceBudgetCommitmentQuoteId: string;
  budgetReservationCommitmentId: string;
  budgetConversion: BudgetCurrencyConversion;
  allocatedFixedPoint: string;
};

type ResourceLifecycleFundingAdmissionBase = {
  resourceLifecycleFundingAdmissionId: string;
  organizationId: string;
  workspaceId: string;
  resourceCostObligation: ResourceCostObligationRef;
  resourceCostExposureId: string;
  previousResourceCostValuationEpochId: string;
  previousResourceCostValuationEpochHash: string;
  sourceResourceLifecycleFundingQuoteSetId: string;
  canonicalProviderCostValuationId: string;
  applicableBudgetRuleSetDigest: string;
  applicableBudgetCommitmentSliceSetDigest: string;
  fundingFencingEpoch: string;
  admittedAt: string;
  consumedAt: string;
  signature: string;
};

type ResourceLifecycleFundingAdmission = ResourceLifecycleFundingAdmissionBase &
  (
    | {
        budgetAdmission: Extract<BudgetAdmission, { kind: "no_applicable_budget_rules" }>;
        allocations: [];
      }
    | {
        budgetAdmission: Extract<BudgetAdmission, { kind: "reserved" }>;
        allocations: NonEmptyArray<ResourceLifecycleFundingAllocation>;
      }
  );

type ResourceCostValuationEpochCommonBase = {
  valuationEpochId: string;
  organizationId: string;
  workspaceId: string;
  resourceCostExposureId: string;
  intervalStartsAt: string;
  fencingEpoch: string;
  signature: string;
};

type ResourceCostInitialValuationEpochBase = ResourceCostValuationEpochCommonBase & {
  selectedExecutionTargetId: string;
  providerAttemptId: string;
  providerAttemptAdmissionId: string;
  budgetAttemptAdmissionId: string;
  sourceValuationQuoteId: string;
  previousEpochHash: null;
};

type ResourceCostContinuationValuationEpochBase =
  ResourceCostValuationEpochCommonBase & {
    resourceCostObligation: ResourceCostObligationRef;
    previousValuationEpochId: string;
    previousEpochHash: string;
    resourceLifecycleFundingAdmissionId: string;
    sourceResourceLifecycleFundingQuoteSetId: string;
    sliceTransition: ResourceLifecycleSliceTransition;
  };

type ResourceCostValuationEpoch =
  | (ResourceCostInitialValuationEpochBase & {
      epochKind: "firm_provider_expiry_initial";
      canonicalProviderCostValuation: Extract<
        CanonicalResourceCostValuation,
        { valuationKind: "firm_provider_expiry" }
      >;
    } & BudgetCommitmentCoverage<
        Extract<ResourceBudgetCommitmentEpoch, { commitmentKind: "firm_provider_expiry" }>
      >)
  | (ResourceCostInitialValuationEpochBase & {
      epochKind: "firm_contract_charge_cap_initial";
      canonicalProviderCostValuation: Extract<
        CanonicalResourceCostValuation,
        { valuationKind: "firm_contract_charge_cap" }
      >;
    } & BudgetCommitmentCoverage<
        Extract<
          ResourceBudgetCommitmentEpoch,
          { commitmentKind: "firm_contract_charge_cap" }
        >
      >)
  | (ResourceCostInitialValuationEpochBase & {
      epochKind: "operational_initial_funded_interval";
      canonicalProviderCostValuation: Extract<
        CanonicalResourceCostValuation,
        { valuationKind: "operational_funded_interval" }
      >;
    } & BudgetCommitmentCoverage<
        Extract<
          ResourceBudgetCommitmentEpoch,
          { commitmentKind: "operational_funded_interval" }
        >
      >)
  | (ResourceCostContinuationValuationEpochBase & {
      epochKind: "operational_continuation_funded_interval";
      canonicalProviderCostValuation: Extract<
        CanonicalResourceCostValuation,
        { valuationKind: "operational_funded_interval" }
      >;
    } & BudgetCommitmentCoverage<
        Extract<
          ResourceBudgetCommitmentEpoch,
          { commitmentKind: "operational_funded_interval" }
        >
      >);

type RequestTerminalCostOwnership = { kind: "request_terminal" };

type PreparedResourceCostOwnership = {
  kind: "prepared_resource_cost_exposure";
  resourceCostExposureId: string;
};

type ActiveResourceCostOwnership = {
  kind: "active_resource_cost_obligation";
  resourceCostObligationId: string;
};

type OrphanResourceCostOwnership = {
  kind: "orphan_resource_cost_obligation";
  orphanResourceCostObligationId: string;
};

type SettledResourceCostOwnership = {
  kind: "settled_resource_cost_exposure";
  settledOwner:
    | { kind: "active_resource_cost_obligation"; obligationId: string }
    | { kind: "orphan_resource_cost_obligation"; obligationId: string };
};

type AbortedResourceCostOwnership = {
  kind: "aborted_before_acceptance";
  resourceCostExposureId: string;
  definitiveNonacceptanceEvidenceId: string;
};

type PreparedResourceCostExposure = {
  resourceCostExposureId: string;
  organizationId: string;
  workspaceId: string;
  stateBindingId: string;
  idempotencyRecordId: string;
  selectedExecutionTargetId: string;
  providerAttemptId: string;
  providerAttemptAdmissionId: string;
  budgetAttemptAdmissionId: string;
  providerDispatchIntentId: string;
  resourceCostPlanRef: ResourceCostPlanRef;
  sourceValuationQuoteId: string;
  initialValuationEpochId: string;
  canonicalProviderCostValuationId: string;
  providerOutcomeRecordId: string;
  reconciliationRetentionLeaseId: string;
  lifecycleExposureStartedAt: string;
  fencingEpoch: string;
  transition:
    | { state: "prepared"; terminalEvidenceId: null }
    | {
        state: "transferred_to_active_binding";
        resourceCostObligationId: string;
        terminalEvidenceId: null;
      }
    | {
        state: "transferred_to_orphan";
        orphanProviderResourceId: string;
        orphanResourceCostObligationId: string;
        terminalEvidenceId: null;
      }
    | {
        state: "aborted_definitive_nonacceptance";
        terminalEvidenceId: string;
  };
};

type RequestStateOrphanRecoveryControlBase = {
  recoveryControlEpoch: string;
  trustedTimeSourceId: string;
  recoveryNotAfter: string;
  cumulativeRecoveryAttemptCeiling: number;
  cumulativeConsumedRecoveryAttemptCount: number;
};

type RequestStateOrphanRecoveryControl =
  RequestStateOrphanRecoveryControlBase &
    (
      | {
          recoveryControlState: "available";
          activeUpstreamRecoveryAuthorizationId: null;
          activeProviderAttemptProgressId: null;
          activeRecoveryReconciliationRetentionLeaseId: null;
          activatedAt: null;
          closedReason: null;
          closedEvidenceId: null;
        }
      | {
          recoveryControlState: "active";
          activeUpstreamRecoveryAuthorizationId: string;
          activeProviderAttemptProgressId: string;
          activeRecoveryReconciliationRetentionLeaseId: string;
          activatedAt: string;
          closedReason: null;
          closedEvidenceId: null;
        }
      | {
          recoveryControlState: "closed";
          activeUpstreamRecoveryAuthorizationId: null;
          activeProviderAttemptProgressId: null;
          activeRecoveryReconciliationRetentionLeaseId: null;
          activatedAt: null;
          closedReason: "recovered_to_active";
          closedEvidenceId: string;
        }
      | {
          recoveryControlState: "closed";
          activeUpstreamRecoveryAuthorizationId: null;
          activeProviderAttemptProgressId: null;
          activeRecoveryReconciliationRetentionLeaseId: null;
          activatedAt: null;
          closedReason: "terminal_cleanup";
          closedEvidenceId: string;
        }
    );

type RequestStateOrphanProviderStateBase = {
  requestStateOrphanProviderStateId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  stateBindingId: string;
  idempotencyRecordId: string;
  selectedExecutionTargetId: string;
  originalProviderAttemptId: string;
  originalProviderOutcomeRecordId: string;
  originalReconciliationRetentionLeaseId: string;
  reconciliationRetentionClassId: string;
  requestStateRecoveryContractVersionId: string;
  requestStateTerminalClosureContractVersionId: string;
  upstreamIdempotencyCertificationId: string;
  upstreamIdempotencyKeyBindingId: string;
  upstreamIdempotencyKeyBindingHash: string;
  upstreamIdempotencyKeyHmac: string;
  serializedPayloadDigest: string;
  recoveryNotAfter: string;
  stateLifecycleCreatorRegistrationId: string;
  credentialLifecycleRequirementRegistrationId: string;
  ownedProviderOutcomeHighWaterMark: string;
  ownedProviderOutcomeSetDigest: string;
  ownedReconciliationLeaseHighWaterMark: string;
  ownedReconciliationLeaseSetDigest: string;
  encryptedUpstreamIdRef: string | null;
  requestCostOwnership: RequestTerminalCostOwnership;
  continuingProviderLiability: false;
  resourceCostOwnership: { kind: "not_applicable" };
  recoveryControl: RequestStateOrphanRecoveryControl;
};

type RequestStateOrphanProviderState = RequestStateOrphanProviderStateBase &
  (
    | {
        orphanState: "reconciling";
        recoveryControl: Extract<
          RequestStateOrphanRecoveryControl,
          { recoveryControlState: "available" | "active" }
        >;
        requestStateOrphanRecoveryTransferId: null;
        requestStateOrphanTerminalCleanupId: null;
        releasedReconciliationLeaseSetDigest: null;
      }
    | {
        orphanState: "recovered_to_active";
        recoveryControl: Extract<
          RequestStateOrphanRecoveryControl,
          { recoveryControlState: "closed"; closedReason: "recovered_to_active" }
        >;
        requestStateOrphanRecoveryTransferId: string;
        requestStateOrphanTerminalCleanupId: null;
        releasedReconciliationLeaseSetDigest: string;
      }
    | {
        orphanState: "terminal_cleanup";
        recoveryControl: Extract<
          RequestStateOrphanRecoveryControl,
          { recoveryControlState: "closed"; closedReason: "terminal_cleanup" }
        >;
        requestStateOrphanRecoveryTransferId: null;
        requestStateOrphanTerminalCleanupId: string;
        releasedReconciliationLeaseSetDigest: string;
      }
  );

type RequestStateOrphanRecoveryAttemptClosure = {
  requestStateOrphanRecoveryAttemptClosureId: string;
  requestStateOrphanProviderStateId: string;
  upstreamRecoveryAuthorizationId: string;
  recoveryProviderAttemptId: string;
  recoveryProviderAttemptProgressId: string;
  recoveryProviderOutcomeRecordId: string;
  recoveryReconciliationRetentionLeaseId: string;
  reconciliationRetentionClassId: string;
  requestStateRecoveryContractVersionId: string;
  requestStateTerminalClosureContractVersionId: string;
  predecessorRecoveryControlEpoch: string;
  successorAvailableRecoveryControlEpoch: string;
  recoveryNotAfter: string;
  cumulativeRecoveryAttemptCeiling: number;
  cumulativeConsumedRecoveryAttemptCount: number;
  trustedTimeEvidenceId: string;
  predecessorOwnedProviderOutcomeHighWaterMark: string;
  predecessorOwnedProviderOutcomeSetDigest: string;
  successorOwnedProviderOutcomeHighWaterMark: string;
  successorOwnedProviderOutcomeSetDigest: string;
  predecessorOwnedReconciliationLeaseHighWaterMark: string;
  predecessorOwnedReconciliationLeaseSetDigest: string;
  successorOwnedReconciliationLeaseHighWaterMark: string;
  successorOwnedReconciliationLeaseSetDigest: string;
  disposition:
    | {
        kind: "ambiguous_requeued";
        transferredRecoveryProviderOutcomeRecordId: string;
        transferredRecoveryReconciliationRetentionLeaseId: string;
        releasedRecoveryReconciliationRetentionLeaseId: null;
        ambiguousOutcomeEvidenceId: string;
        definitiveNoNewEffectEvidenceId: null;
      }
    | {
        kind: "definitive_no_new_effect_requeued";
        transferredRecoveryProviderOutcomeRecordId: null;
        transferredRecoveryReconciliationRetentionLeaseId: null;
        releasedRecoveryReconciliationRetentionLeaseId: string;
        ambiguousOutcomeEvidenceId: null;
        definitiveNoNewEffectEvidenceId: string;
      };
  closedAt: string;
  signature: string;
};

type RequestStateOrphanRecoveryTransfer = {
  requestStateOrphanRecoveryTransferId: string;
  organizationId: string;
  workspaceId: string;
  requestStateOrphanProviderStateId: string;
  stateBindingId: string;
  idempotencyRecordId: string;
  selectedExecutionTargetId: string;
  upstreamRecoveryAuthorizationId: string;
  upstreamIdempotencyCertificationId: string;
  upstreamIdempotencyKeyBindingId: string;
  upstreamIdempotencyKeyBindingHash: string;
  recoveryProviderAttemptId: string;
  recoveryProviderAttemptProgressId: string;
  recoveryProviderAttemptAdmissionId: string;
  recoveryBudgetAttemptAdmissionId: string;
  recoveryProviderDispatchIntentId: string;
  recoveryProviderOutcomeRecordId: string;
  recoveryReconciliationRetentionLeaseId: string;
  reconciliationRetentionClassId: string;
  requestStateRecoveryContractVersionId: string;
  requestStateTerminalClosureContractVersionId: string;
  sharedTerminalResultEvidenceId: string;
  predecessorRecoveryControlEpoch: string;
  closedRecoveryControlEpoch: string;
  recoveryNotAfter: string;
  cumulativeRecoveryAttemptCeiling: number;
  cumulativeConsumedRecoveryAttemptCount: number;
  trustedTimeEvidenceId: string;
  predecessorOwnedProviderOutcomeSetDigest: string;
  terminalOwnedProviderOutcomeHighWaterMark: string;
  terminalOwnedProviderOutcomeSetDigest: string;
  predecessorOwnedReconciliationLeaseSetDigest: string;
  terminalOwnedReconciliationLeaseHighWaterMark: string;
  terminalOwnedReconciliationLeaseSetDigest: string;
  releasedReconciliationLeaseSetDigest: string;
  encryptedUpstreamIdRef: string;
  stateRetentionLeaseId: string;
  stateLifecycleCreatorOwnershipTransferId: string;
  credentialLifecycleOwnershipTransferId: string;
  requestCostDispositionEvidenceId: string;
  budgetDispositionEvidenceId: string;
  idempotencyTerminalProvenanceId: string;
  replayArtifactId: string | null;
  predecessorBindingStateHash: string;
  successorBindingStateHash: string;
  transferredAt: string;
  signature: string;
};

type RequestStateOrphanTerminalBasis =
  | {
      kind: "definitive_nonacceptance_or_absence";
      terminalProviderEvidenceId: string;
      terminalAbsenceEvidenceContractVersionId: string;
      providerExpiryCertificationId: null;
      providerExpiryEvidenceId: null;
    }
  | {
      kind: "provider_enforced_expiry";
      terminalProviderEvidenceId: null;
      terminalAbsenceEvidenceContractVersionId: null;
      providerExpiryCertificationId: string;
      providerExpiryEvidenceId: string;
    };

type RequestStateOrphanTerminalCleanup = {
  requestStateOrphanTerminalCleanupId: string;
  organizationId: string;
  workspaceId: string;
  requestStateOrphanProviderStateId: string;
  stateBindingId: string;
  idempotencyRecordId: string;
  upstreamIdempotencyKeyBindingId: string;
  upstreamIdempotencyKeyBindingHash: string;
  reconciliationRetentionClassId: string;
  requestStateRecoveryContractVersionId: string;
  requestStateTerminalClosureContractVersionId: string;
  terminalBasis: RequestStateOrphanTerminalBasis;
  predecessorAvailableRecoveryControlEpoch: string;
  closedRecoveryControlEpoch: string;
  recoveryNotAfter: string;
  cumulativeRecoveryAttemptCeiling: number;
  cumulativeConsumedRecoveryAttemptCount: number;
  trustedTimeEvidenceId: string;
  ownedProviderOutcomeHighWaterMark: string;
  ownedProviderOutcomeSetDigest: string;
  ownedReconciliationLeaseHighWaterMark: string;
  ownedReconciliationLeaseSetDigest: string;
  releasedReconciliationLeaseSetDigest: string;
  releasedStateLifecycleCreatorRegistrationId: string;
  releasedCredentialLifecycleRequirementRegistrationId: string;
  requestCostDispositionEvidenceId: string;
  budgetDispositionEvidenceId: string;
  idempotencyTerminalProvenanceId: string;
  bindingTerminalEvidenceId: string;
  predecessorBindingStateHash: string;
  successorBindingStateHash: string;
  completedAt: string;
  signature: string;
};

type StateBinding = StateBindingBase &
  (
    | {
        status: "pending";
        dispatchPreparation: { kind: "not_prepared" };
        costOwnership: RequestTerminalCostOwnership;
        requestStateOrphanProviderStateId: null;
        orphanProviderResourceId: null;
        encryptedUpstreamIdRef: null;
        stateRetentionLeaseId: null;
        providerOutcomeRecordId: null;
        reconciliationRetentionLeaseId: null;
        terminalEvidenceId: null;
      }
    | {
        status: "pending";
        dispatchPreparation: { kind: "attempt_prepared"; attemptId: string };
        costOwnership: RequestTerminalCostOwnership | PreparedResourceCostOwnership;
        requestStateOrphanProviderStateId: null;
        orphanProviderResourceId: null;
        encryptedUpstreamIdRef: null;
        stateRetentionLeaseId: null;
        providerOutcomeRecordId: string;
        reconciliationRetentionLeaseId: string;
        terminalEvidenceId: null;
      }
    | {
        status: "reconciling";
        costOwnership: RequestTerminalCostOwnership;
        requestStateOrphanProviderStateId: string;
        orphanProviderResourceId: null;
        encryptedUpstreamIdRef: string | null;
        stateRetentionLeaseId: null;
        providerOutcomeRecordId: string;
        reconciliationRetentionLeaseId: string;
        terminalEvidenceId: null;
      }
    | {
        status: "reconciling";
        costOwnership: OrphanResourceCostOwnership;
        requestStateOrphanProviderStateId: null;
        orphanProviderResourceId: string;
        encryptedUpstreamIdRef: string | null;
        stateRetentionLeaseId: null;
        providerOutcomeRecordId: string;
        reconciliationRetentionLeaseId: string;
        terminalEvidenceId: null;
      }
    | {
        status: "active";
        costOwnership: RequestTerminalCostOwnership;
        requestStateOrphanProviderStateId: null;
        orphanProviderResourceId: null;
        activationSource:
          | {
              kind: "direct_provider_result";
              predecessorRequestStateOrphanProviderStateId: null;
              requestStateOrphanRecoveryTransferId: null;
            }
          | {
              kind: "request_state_orphan_same_key_recovery";
              predecessorRequestStateOrphanProviderStateId: string;
              requestStateOrphanRecoveryTransferId: string;
            };
        encryptedUpstreamIdRef: string;
        stateRetentionLeaseId: string;
        providerOutcomeRecordId: string;
        reconciliationOwnership: {
          kind: "provider_outcome_terminal";
          reconciliationRetentionLeaseId: null;
        };
        terminalEvidenceId: null;
      }
    | {
        status: "active";
        costOwnership: ActiveResourceCostOwnership;
        requestStateOrphanProviderStateId: null;
        orphanProviderResourceId: null;
        activationSource: {
          kind: "resource_lifecycle";
          predecessorRequestStateOrphanProviderStateId: null;
          requestStateOrphanRecoveryTransferId: null;
        };
        encryptedUpstreamIdRef: string;
        stateRetentionLeaseId: string;
        providerOutcomeRecordId: string;
        reconciliationOwnership: {
          kind: "active_resource_cost_obligation";
          reconciliationRetentionLeaseId: string;
        };
        terminalEvidenceId: null;
      }
    | {
        status: "tombstoned_cleanup_retained";
        costOwnership: ActiveResourceCostOwnership | OrphanResourceCostOwnership;
        requestStateOrphanProviderStateId: null;
        orphanProviderResourceId: string | null;
        encryptedUpstreamIdRef: string | null;
        stateRetentionLeaseId: string | null;
        providerOutcomeRecordId: string;
        reconciliationRetentionLeaseId: string;
        cleanupState: "pending" | "indeterminate";
        terminalEvidenceId: null;
      }
    | {
        status: "tombstoned_terminal";
        costOwnership: RequestTerminalCostOwnership;
        requestStateOrphanDisposition: {
          kind: "not_applicable";
          requestStateOrphanProviderStateId: null;
          requestStateOrphanTerminalCleanupId: null;
        };
        orphanProviderResourceId: null;
        encryptedUpstreamIdRef: string | null;
        stateRetentionLeaseId: null;
        providerOutcomeRecordId: string | null;
        reconciliationRetentionLeaseId: null;
        cleanupState: "not_required";
        terminalEvidenceId: string;
      }
    | {
        status: "tombstoned_terminal";
        costOwnership: RequestTerminalCostOwnership;
        requestStateOrphanDisposition: {
          kind: "terminal_cleanup";
          requestStateOrphanProviderStateId: string;
          requestStateOrphanTerminalCleanupId: string;
        };
        orphanProviderResourceId: null;
        encryptedUpstreamIdRef: string | null;
        stateRetentionLeaseId: null;
        providerOutcomeRecordId: string;
        reconciliationRetentionLeaseId: null;
        cleanupState: "completed";
        terminalEvidenceId: string;
      }
    | {
        status: "tombstoned_terminal";
        costOwnership: SettledResourceCostOwnership;
        requestStateOrphanDisposition: {
          kind: "not_applicable";
          requestStateOrphanProviderStateId: null;
          requestStateOrphanTerminalCleanupId: null;
        };
        orphanProviderResourceId: string | null;
        encryptedUpstreamIdRef: string | null;
        stateRetentionLeaseId: null;
        providerOutcomeRecordId: string;
        reconciliationRetentionLeaseId: null;
        cleanupState: "completed";
        terminalEvidenceId: string;
      }
    | {
        status: "tombstoned_terminal";
        costOwnership: AbortedResourceCostOwnership;
        requestStateOrphanDisposition: {
          kind: "not_applicable";
          requestStateOrphanProviderStateId: null;
          requestStateOrphanTerminalCleanupId: null;
        };
        orphanProviderResourceId: null;
        encryptedUpstreamIdRef: null;
        stateRetentionLeaseId: null;
        providerOutcomeRecordId: string;
        reconciliationRetentionLeaseId: null;
        cleanupState: "not_required";
        terminalEvidenceId: string;
      }
  );

type ResourceCostObligationLifecycleTerms =
  | {
      lifecycleTerms: "firm_provider_expiry";
      absoluteBillingHorizonEndsAt: string;
      budgetCommitmentCoverageDigest: string;
    }
  | {
      lifecycleTerms: "firm_contract_charge_cap";
      budgetCommitmentCoverageDigest: string;
      accountingHorizon: "until_terminal_reconciliation";
    }
  | {
      lifecycleTerms: "operational";
      absoluteAuthorizedUseEndsAt: string;
      absoluteCleanupDeadline: string;
      currentValuationEpochId: string;
      currentFundingAuthority:
        | {
            kind: "creating_attempt";
            budgetAttemptAdmissionId: string;
            resourceLifecycleFundingAdmissionId: null;
          }
        | {
            kind: "lifecycle_continuation";
            budgetAttemptAdmissionId: null;
            resourceLifecycleFundingAdmissionId: string;
          };
      currentBudgetCommitmentCoverageDigest: string;
    };

type BudgetCommitmentSettlementBase = {
  budgetCommitmentSettlementId: string;
  organizationId: string;
  workspaceId: string;
  budgetCommitmentSliceId: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScope: BudgetScopeRef;
  budgetCurrency: string;
  admittedBudgetConversion: BudgetCurrencyConversion;
  actualBudgetConversion: ActualBudgetCurrencyConversion;
  budgetActualCostSourceContractId: string;
  budgetReservationCommitmentId: string;
  reservationId: string;
  canonicalBudgetActualCostSourceSelectionId: string;
  canonicalBudgetCostAttributionId: string;
  canonicalBudgetCostAttributionComponentId: string;
  settledDeltaFixedPoint: string;
  overrunDeltaFixedPoint: string;
  settledAt: string;
  settlementPayloadHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetCommitmentSettlement = BudgetCommitmentSettlementBase &
  (
    | {
        settlementKind: "request_terminal";
        canonicalSource:
          | {
              kind: "canonical_request_cost_settlement";
              canonicalRequestCostSettlementId: string;
              canonicalRequestCostCorrectionId: null;
            }
          | {
              kind: "canonical_request_cost_correction";
              canonicalRequestCostSettlementId: string;
              canonicalRequestCostCorrectionId: string;
            };
        resourceBudgetCommitmentEpochId: null;
      }
    | {
        settlementKind: "resource_terminal";
        canonicalSource:
          | {
              kind: "provider_cost_settlement";
              providerCostSettlementId: string;
              resourceLiabilityProjectionComponentId: null;
              invoiceAdjustmentId: null;
            }
          | {
              kind: "invoice_adjustment";
              providerCostSettlementId: null;
              resourceLiabilityProjectionComponentId: string;
              invoiceAdjustmentId: string;
            };
        resourceBudgetCommitmentEpochId: string;
      }
  );

type ProviderCostSettlement = {
  providerCostSettlementId: string;
  organizationId: string;
  workspaceId: string;
  resourceCostExposureId: string;
  resourceCostValuationEpochId: string;
  providerCostValuationId: string;
  usageItemId: string;
  providerChargeCurrency: string;
  accountingCurrency: string;
  accountingConversion: CanonicalAccountingConversion;
  providerChargeFixedPoint: string;
  accountingCostFixedPoint: string;
  priceProvenanceId: string;
  settledAt: string;
  settlementPayloadHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type CanonicalRequestCostSettlement = {
  canonicalRequestCostSettlementId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  canonicalRequestCostValuationId: string;
  dispatchIntent: RemoteDispatchIntentRef;
  owner:
    | {
        kind: "provider_attempt";
        providerAttemptId: string;
        providerAttemptAdmissionId: string;
      }
    | {
        kind: "processor_connector";
        processorConnectorExecutionAdmissionId: string;
      }
    | {
        kind: "resource_reconciliation";
        resourceReconciliationAdmissionId: string;
      };
  usageItemId: string;
  providerChargeCurrency: string;
  accountingCurrency: string;
  accountingConversion: CanonicalAccountingConversion;
  providerChargeFixedPoint: string;
  accountingCostFixedPoint: string;
  priceProvenanceId: string;
  settledAt: string;
  settlementPayloadHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type CanonicalRequestCostCorrectionBase = {
  canonicalRequestCostCorrectionId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  canonicalRequestCostSettlementId: string;
  canonicalRequestCostSettlementPayloadHash: string;
  canonicalRequestCostValuationId: string;
  correctionSequence: string;
  correctionReason:
    | "late_invoice"
    | "provider_credit"
    | "usage_restatement"
    | "tax_or_fee_adjustment";
  providerInvoiceEvidenceId: string;
  providerInvoiceLineItemId: string;
  correctedUsageItemId: string | null;
  providerChargeCurrency: string;
  accountingCurrency: string;
  accountingConversion: CanonicalAccountingConversion;
  providerChargeDeltaFixedPoint: string;
  accountingCostDeltaFixedPoint: string;
  priceProvenanceId: string;
  correctedAt: string;
  correctionPayloadHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type CanonicalRequestCostCorrection = CanonicalRequestCostCorrectionBase &
  (
    | {
        correctionTransitionKind: "initial";
        correctionSequence: "1";
        predecessorCanonicalRequestCostCorrectionId: null;
        predecessorCanonicalRequestCostCorrectionHash: null;
      }
    | {
        correctionTransitionKind: "continuation";
        predecessorCanonicalRequestCostCorrectionId: string;
        predecessorCanonicalRequestCostCorrectionHash: string;
      }
  );

type CanonicalBudgetCostAttributionSource =
  | {
      kind: "canonical_request_cost_settlement";
      canonicalRequestCostSettlementId: string;
      canonicalRequestCostCorrectionId: null;
      providerCostSettlementId: null;
      resourceLiabilityProjectionComponentId: null;
      invoiceAdjustmentId: null;
    }
  | {
      kind: "canonical_request_cost_correction";
      canonicalRequestCostSettlementId: string;
      canonicalRequestCostCorrectionId: string;
      providerCostSettlementId: null;
      resourceLiabilityProjectionComponentId: null;
      invoiceAdjustmentId: null;
    }
  | {
      kind: "provider_cost_settlement";
      canonicalRequestCostSettlementId: null;
      canonicalRequestCostCorrectionId: null;
      providerCostSettlementId: string;
      resourceLiabilityProjectionComponentId: null;
      invoiceAdjustmentId: null;
    }
  | {
      kind: "invoice_adjustment";
      canonicalRequestCostSettlementId: null;
      canonicalRequestCostCorrectionId: null;
      providerCostSettlementId: null;
      resourceLiabilityProjectionComponentId: string;
      invoiceAdjustmentId: string;
    };

type BudgetActualCostTargetAndValuationLineage =
  | {
      valuationLineageKind: "request_terminal";
      canonicalRequestCostValuationId: string;
      requestWorkContext: BillableRequestWorkContext;
      canonicalRequestCostSettlementId: string;
      canonicalRequestCostCorrectionId: null;
      resourceCostExposureId: null;
      resourceCostValuationEpochId: null;
      providerCostValuationId: null;
      executionTarget: ExecutionTargetRef | null;
    }
  | {
      valuationLineageKind: "request_terminal_correction";
      canonicalRequestCostValuationId: string;
      requestWorkContext: BillableRequestWorkContext;
      canonicalRequestCostSettlementId: string;
      canonicalRequestCostCorrectionId: string;
      resourceCostExposureId: null;
      resourceCostValuationEpochId: null;
      providerCostValuationId: null;
      executionTarget: ExecutionTargetRef | null;
    }
  | {
      valuationLineageKind: "resource_terminal";
      canonicalRequestCostValuationId: null;
      requestWorkContext: null;
      canonicalRequestCostSettlementId: null;
      canonicalRequestCostCorrectionId: null;
      resourceCostExposureId: string;
      resourceCostValuationEpochId: string;
      providerCostValuationId: string;
      executionTarget: ExecutionTargetRef;
    };

type BudgetActualCostCanonicalLineage =
  | {
      canonicalLineageKind: "request_usage";
      canonicalRequestCostSettlementId: string;
      canonicalRequestCostCorrectionId: null;
      providerCostSettlementId: null;
      resourceLiabilityProjectionComponentId: null;
      invoiceAdjustmentId: null;
      usageItemId: string;
      predecessorActualCostSourceEvidenceId: null;
      correctionSequence: null;
    }
  | {
      canonicalLineageKind: "request_invoice_correction";
      canonicalRequestCostSettlementId: string;
      canonicalRequestCostCorrectionId: string;
      providerCostSettlementId: null;
      resourceLiabilityProjectionComponentId: null;
      invoiceAdjustmentId: null;
      usageItemId: string | null;
      predecessorActualCostSourceEvidenceId: string;
      correctionSequence: string;
    }
  | {
      canonicalLineageKind: "resource_usage";
      canonicalRequestCostSettlementId: null;
      canonicalRequestCostCorrectionId: null;
      providerCostSettlementId: string;
      resourceLiabilityProjectionComponentId: null;
      invoiceAdjustmentId: null;
      usageItemId: string;
      predecessorActualCostSourceEvidenceId: null;
      correctionSequence: null;
    }
  | {
      canonicalLineageKind: "invoice_correction";
      canonicalRequestCostSettlementId: null;
      canonicalRequestCostCorrectionId: null;
      providerCostSettlementId: null;
      resourceLiabilityProjectionComponentId: string;
      invoiceAdjustmentId: string;
      usageItemId: null;
      predecessorActualCostSourceEvidenceId: string;
      correctionSequence: string;
    };

type BudgetActualCostSourceEvidenceBase = {
  budgetActualCostSourceEvidenceId: string;
  organizationId: string;
  workspaceId: string;
  budgetActualCostSourceContractId: string;
  budgetActualCostSourceContractHash: string;
  canonicalEvidenceMapping: CanonicalActualCostEvidenceMappingRef;
  canonicalSourceFingerprint: string;
  actualCostSubject: BudgetActualCostSubjectRef;
  selectedSourceCostComponent: "provider_charge" | "accounting_cost";
  selectedSourceCurrency: string;
  selectedSourceAmountFixedPoint: string;
  mappedAt: string;
  evidencePayloadHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type BudgetActualCostSourceEvidence = BudgetActualCostSourceEvidenceBase &
  (
    | {
        evidenceSourceKind: "canonical_request_cost_settlement";
        canonicalSource: Extract<
          CanonicalBudgetCostAttributionSource,
          { kind: "canonical_request_cost_settlement" }
        >;
        targetAndValuationLineage: Extract<
          BudgetActualCostTargetAndValuationLineage,
          { valuationLineageKind: "request_terminal" }
        >;
        canonicalLineage: Extract<
          BudgetActualCostCanonicalLineage,
          { canonicalLineageKind: "request_usage" }
        >;
      }
    | {
        evidenceSourceKind: "canonical_request_cost_correction";
        canonicalSource: Extract<
          CanonicalBudgetCostAttributionSource,
          { kind: "canonical_request_cost_correction" }
        >;
        targetAndValuationLineage: Extract<
          BudgetActualCostTargetAndValuationLineage,
          { valuationLineageKind: "request_terminal_correction" }
        >;
        canonicalLineage: Extract<
          BudgetActualCostCanonicalLineage,
          { canonicalLineageKind: "request_invoice_correction" }
        >;
      }
    | {
        evidenceSourceKind: "provider_cost_settlement";
        canonicalSource: Extract<
          CanonicalBudgetCostAttributionSource,
          { kind: "provider_cost_settlement" }
        >;
        targetAndValuationLineage: Extract<
          BudgetActualCostTargetAndValuationLineage,
          { valuationLineageKind: "resource_terminal" }
        >;
        canonicalLineage: Extract<
          BudgetActualCostCanonicalLineage,
          { canonicalLineageKind: "resource_usage" }
        >;
      }
    | {
        evidenceSourceKind: "invoice_adjustment";
        canonicalSource: Extract<
          CanonicalBudgetCostAttributionSource,
          { kind: "invoice_adjustment" }
        >;
        targetAndValuationLineage: Extract<
          BudgetActualCostTargetAndValuationLineage,
          { valuationLineageKind: "resource_terminal" }
        >;
        canonicalLineage: Extract<
          BudgetActualCostCanonicalLineage,
          { canonicalLineageKind: "invoice_correction" }
        >;
      }
  );

type CanonicalBudgetCostSourceGroupKey = {
  budgetActualCostSourceContractId: string;
  actualCostSourceContractGroupKeyHash: string;
  canonicalSourceFingerprint: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScopeHash: string;
  targetBudgetCurrency: string;
  sourceGroupKeyHash: string;
};

type CanonicalBudgetActualCostSourceSelection = {
  canonicalBudgetActualCostSourceSelectionId: string;
  organizationId: string;
  workspaceId: string;
  sourceGroupKey: CanonicalBudgetCostSourceGroupKey;
  budgetActualCostSourceContractId: string;
  budgetActualCostSourceContractHash: string;
  budgetActualCostSourceEvidenceId: string;
  canonicalEvidenceMapping: CanonicalActualCostEvidenceMappingRef;
  canonicalSource: CanonicalBudgetCostAttributionSource;
  canonicalSourceFingerprint: string;
  selectedSourceCostComponent: "provider_charge" | "accounting_cost";
  selectedSourceCurrency: string;
  selectedParentSourceAmountFixedPoint: string;
  eligibleBudgetCommitmentSliceSetDigest: string;
  eligibleBudgetReservationCommitmentSetDigest: string;
  selectedAt: string;
  selectionPayloadHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type CanonicalBudgetCostAttributionComponent = {
  canonicalBudgetCostAttributionComponentId: string;
  budgetReservationCommitmentId: string;
  sourceGroupKey: CanonicalBudgetCostSourceGroupKey;
  budgetCommitmentSliceId: string;
  budgetSettlementConversionAuthoritySetId: string;
  budgetActualCostSourceContractId: string;
  canonicalBudgetActualCostSourceSelectionId: string;
  budgetActualCostSourceEvidenceId: string;
  sourceAmountFixedPoint: string;
  componentSequence: string;
  componentHash: string;
};

type CanonicalBudgetCostAttribution = {
  canonicalBudgetCostAttributionId: string;
  organizationId: string;
  workspaceId: string;
  canonicalSource: CanonicalBudgetCostAttributionSource;
  canonicalSourceFingerprint: string;
  canonicalBudgetActualCostSourceSelectionId: string;
  budgetActualCostSourceContractId: string;
  budgetActualCostSourceEvidenceId: string;
  canonicalEvidenceMapping: CanonicalActualCostEvidenceMappingRef;
  sourceCostComponent: "provider_charge" | "accounting_cost";
  sourceCurrency: string;
  parentSourceAmountFixedPoint: string;
  budgetRuleVersionId: string;
  budgetAuthorityId: string;
  budgetScope: BudgetScopeRef;
  budgetScopeHash: string;
  targetBudgetCurrency: string;
  attributionPolicyVersionId: string;
  eligibleBudgetCommitmentSliceSetDigest: string;
  eligibleBudgetReservationCommitmentSetDigest: string;
  attributionMethod:
    | "event_time"
    | "duration_weighted"
    | "fully_at_admission"
    | "lifetime_non_resetting";
  components: NonEmptyArray<CanonicalBudgetCostAttributionComponent>;
  componentSetHash: string;
  attributedAt: string;
  attributionPayloadHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type CurrencyAmount = {
  currency: string;
  amountFixedPoint: string;
};

type ResourceLiabilityProjectionComponentBase = {
  resourceLiabilityProjectionComponentId: string;
  resourceCostExposureId: string;
  resourceCostValuationEpochId: string;
  providerCostValuationId: string;
  componentHash: string;
  providerChargeCurrency: string;
  accountingCurrency: string;
  providerChargeFixedPoint: string;
  accountingCostFixedPoint: string;
  accountingConversion: CanonicalAccountingConversion;
  priceProvenanceId: string;
  recordedAt: string;
  signature: string;
};

type ResourceLiabilityProjectionComponent =
  ResourceLiabilityProjectionComponentBase &
    (
      | {
          transitionKind: "initial";
          componentSequence: "0";
          previousComponentId: null;
          previousComponentHash: null;
        }
      | {
          transitionKind: "continuation";
          componentSequence: string;
          previousComponentId: string;
          previousComponentHash: string;
        }
    ) &
    (
      | {
          componentKind: "valuation_epoch";
          invoiceAdjustmentId: null;
          valuationInterval:
            | {
                kind: "bounded";
                intervalStartsAt: string;
                intervalEndsAt: string;
              }
            | {
                kind: "open_accounting_horizon";
                intervalStartsAt: string;
                intervalEndsAt: null;
              };
        }
      | {
          componentKind: "invoice_adjustment";
          invoiceAdjustmentId: string;
          valuationInterval: null;
        }
    );

type CumulativeResourceLiabilityProjection = {
  componentHighWaterMark: string;
  componentSetDigest: string;
  components: NonEmptyArray<ResourceLiabilityProjectionComponent>;
  providerChargeTotalsByCurrency: NonEmptyArray<CurrencyAmount>;
  accountingCostTotalsByCurrency: NonEmptyArray<CurrencyAmount>;
  aggregateProjectionHash: string;
};

type ResourceCostObligationBase = {
  resourceCostExposureId: string;
  organizationId: string;
  workspaceId: string;
  idempotencyRecordId: string;
  selectedExecutionTargetId: string;
  providerOutcomeRecordId: string;
  currentCanonicalCostValuationEpochId: string;
  cumulativeLiabilityProjection: CumulativeResourceLiabilityProjection;
  providerCostSettlements: ProviderCostSettlement[];
  budgetSettlement:
    | {
        kind: "no_applicable_budget_rules";
        cumulativeBudgetRuleSetDigest: string;
        cumulativeBudgetCommitmentSliceSetDigest: string;
        evaluationEvidenceId: string;
        settledBudgetCommitments: [];
      }
    | {
        kind: "commitments";
        cumulativeBudgetRuleSetDigest: string;
        cumulativeBudgetCommitmentSliceSetDigest: string;
        evaluationEvidenceId: null;
        budgetReservationCommitmentIds: NonEmptyArray<string>;
        settledBudgetCommitments: BudgetCommitmentSettlement[];
      };
  fencingEpoch: string;
};

type ResourceCostObligationState =
  | {
      state: "active";
      reconciliationRetentionLeaseId: string;
      releasedReconciliationRetentionLeaseId: null;
      terminalProviderOrCleanupEvidenceId: null;
      settlementCompletenessCertificateId: null;
    }
  | {
      state: "indeterminate";
      reconciliationRetentionLeaseId: string;
      releasedReconciliationRetentionLeaseId: null;
      terminalProviderOrCleanupEvidenceId: null;
      settlementCompletenessCertificateId: null;
    }
  | {
      state: "settled";
      reconciliationRetentionLeaseId: null;
      releasedReconciliationRetentionLeaseId: string;
      terminalProviderOrCleanupEvidenceId: string;
      settlementCompletenessCertificateId: string;
    };

type ResourceCostObligation = ResourceCostObligationBase &
  ResourceCostObligationLifecycleTerms &
  ResourceCostObligationState & {
    obligationId: string;
    owner:
      | {
          kind: "active_state_binding";
          activationKind: "direct_from_prepared_exposure";
          stateBindingId: string;
          bindingActivatedAt: string;
          orphanToActiveRecoveryTransferId: null;
        }
      | {
          kind: "active_state_binding";
          activationKind: "recovered_from_orphan";
          stateBindingId: string;
          bindingActivatedAt: string;
          orphanToActiveRecoveryTransferId: string;
          predecessorOrphanResourceCostObligationId: string;
        };
  };

type OrphanProviderResourceBase = {
  orphanProviderResourceId: string;
  organizationId: string;
  workspaceId: string;
  stateBindingId: string;
  selectedExecutionTargetId: string;
  providerOutcomeRecordId: string;
  encryptedUpstreamIdRef: string | null;
};

type OrphanProviderResource = OrphanProviderResourceBase &
  (
    | {
        cleanupState: "pending" | "indeterminate";
        cleanupTerminalEvidenceId: null;
        recoveryControl: Extract<
          OrphanResourceRecoveryControl,
          { recoveryControlState: "available" | "active" | "closing_cleanup" }
        >;
      }
    | {
        cleanupState: "terminal";
        cleanupTerminalEvidenceId: string;
        recoveryControl: Extract<
          OrphanResourceRecoveryControl,
          { recoveryControlState: "closed"; closedReason: "cleanup_terminal" }
        >;
      }
    | {
        cleanupState: "recovered_to_active";
        cleanupTerminalEvidenceId: null;
        orphanToActiveRecoveryTransferId: string;
        activeStateBindingId: string;
        recoveryControl: Extract<
          OrphanResourceRecoveryControl,
          { recoveryControlState: "closed"; closedReason: "recovered_to_active" }
        >;
      }
  );

type OrphanResourceCostObligationState =
  | ResourceCostObligationState
  | {
      state: "transferred_to_active";
      reconciliationRetentionLeaseId: null;
      releasedReconciliationRetentionLeaseId: null;
      transferredReconciliationRetentionLeaseId: string;
      terminalProviderOrCleanupEvidenceId: null;
      settlementCompletenessCertificateId: null;
      orphanToActiveRecoveryTransferId: string;
      successorResourceCostObligationId: string;
    };

type OrphanResourceCostObligation = ResourceCostObligationBase &
  ResourceCostObligationLifecycleTerms &
  OrphanResourceCostObligationState & {
    orphanResourceCostObligationId: string;
    owner: {
      kind: "orphan_provider_resource";
      orphanProviderResourceId: string;
      exposureOwnedAt: string;
    };
  };

type OrphanToActiveResourceRecoveryTransfer = {
  orphanToActiveRecoveryTransferId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  upstreamRecoveryAuthorizationId: string;
  resourceReconciliationAttemptProgressId: string;
  terminalResourceReconciliationAttemptId: string;
  terminalResourceReconciliationAdmissionId: string;
  terminalResourceReconciliationDispatchIntentId: string;
  terminalResourceReconciliationAttemptOutcomeId: string;
  terminalResourceReconciliationObservationId: string;
  resourceCostExposureId: string;
  orphanProviderResourceId: string;
  predecessorOrphanResourceCostObligationId: string;
  successorResourceCostObligationId: string;
  stateBindingId: string;
  providerOutcomeRecordId: string;
  reconciliationRetentionLeaseId: string;
  predecessorReconciliationLeaseOwnershipEpoch: string;
  successorReconciliationLeaseOwnershipEpoch: string;
  predecessorOrphanResourceRecoveryControlEpoch: string;
  closedOrphanResourceRecoveryControlEpoch: string;
  encryptedUpstreamIdRef: string;
  stateRetentionLeaseId: string;
  currentCanonicalCostValuationEpochId: string;
  liabilityProjectionComponentHighWaterMark: string;
  liabilityProjectionComponentSetDigest: string;
  aggregateLiabilityProjectionHash: string;
  resourceLifecycleFundingAdmissionHighWaterMark: string;
  resourceLifecycleSliceTransitionHighWaterMark: string;
  providerCostSettlementHighWaterMark: string;
  providerCostSettlementSetDigest: string;
  budgetSettlementHighWaterMark: string;
  budgetSettlementSetDigest: string;
  invoiceAdjustmentHighWaterMark: string;
  cumulativeBudgetCommitmentSliceSetDigest: string;
  predecessorOrphanObligationStateHash: string;
  successorActiveObligationStateHash: string;
  fencingEpoch: string;
  transferredAt: string;
  signature: string;
};

type ProviderCostSettlementCompleteness =
  | {
      providerUsageCoverage: "no_usage_items";
      noProviderUsageEvidenceId: string;
      expectedProviderUsageItemIds: [];
      providerCostSettlementIds: [];
      providerUsageSetDigest: string;
      providerCostSettlementSetDigest: string;
    }
  | {
      providerUsageCoverage: "usage_items";
      noProviderUsageEvidenceId: null;
      expectedProviderUsageItemIds: NonEmptyArray<string>;
      providerCostSettlementIds: NonEmptyArray<string>;
      providerUsageSetDigest: string;
      providerCostSettlementSetDigest: string;
    };

type ResourceBudgetSettlementCompleteness =
  | {
      budgetCoverage: "no_applicable_budget_rules";
      cumulativeBudgetRuleSetDigest: string;
      cumulativeBudgetCommitmentSliceSetDigest: string;
      evaluationEvidenceId: string;
      expectedBudgetReservationCommitmentIds: [];
      budgetCommitmentSettlementIds: [];
      expectedBudgetCommitmentSliceSetDigest: string;
      expectedBudgetCommitmentSetDigest: string;
      budgetSettlementSetDigest: string;
    }
  | {
      budgetCoverage: "commitments";
      cumulativeBudgetRuleSetDigest: string;
      cumulativeBudgetCommitmentSliceSetDigest: string;
      evaluationEvidenceId: null;
      expectedBudgetReservationCommitmentIds: NonEmptyArray<string>;
      budgetCommitmentSettlementIds: NonEmptyArray<string>;
      expectedBudgetCommitmentSliceSetDigest: string;
      expectedBudgetCommitmentSetDigest: string;
      budgetSettlementSetDigest: string;
    };

type ResourceCostSettlementCompletenessCertificateBase = {
  settlementCompletenessCertificateId: string;
  resourceCostExposureId: string;
  terminalProviderOrCleanupEvidenceId: string;
  releasedReconciliationRetentionLeaseId: string;
  canonicalCostValuationEpochHighWaterMark: string;
  liabilityProjectionComponentHighWaterMark: string;
  liabilityProjectionComponentSetDigest: string;
  resourceLifecycleFundingAdmissionHighWaterMark: string;
  resourceLifecycleSliceTransitionHighWaterMark: string;
  expectedProviderUsageHighWaterMark: string;
  providerCostSettlementHighWaterMark: string;
  budgetSettlementHighWaterMark: string;
  invoiceAdjustmentHighWaterMark: string;
  invoiceAdjustmentSetDigest: string;
  completedAt: string;
  signature: string;
};

type ResourceCostSettlementCompletenessCertificate =
  ResourceCostSettlementCompletenessCertificateBase &
    ProviderCostSettlementCompleteness &
    ResourceBudgetSettlementCompleteness;

type StateRetentionLease = {
  leaseId: string;
  organizationId: string;
  workspaceId: string;
  stateBindingId: string;
  operationDefinitionVersionId: string;
  resourceProfileVersionId: string | null;
  stateMappingCertificationId: string;
  dataClassification: string;
  lifecyclePolicyVersionIds: NonEmptyArray<string>;
  retentionPolicyVersionId: string;
  selectedExecutionTargetId: string;
  stateLifecycleCreatorRegistrationId: string;
  stateRetentionClassId: string;
  executionConstraint: PersistedStateExecutionConstraint;
  credentialContinuityRequirements: NonEmptyArray<{
    executionTarget: ExecutionTargetRef;
    continuityRequirement: CredentialContinuityRequirement;
  }>;
  minimumCompatibleProviderCredentialDirectoryGeneration: string;
  activationCredentialCoverageReceiptIds: NonEmptyArray<string>;
  componentVersionIds: string[];
  retirementEpoch: string;
  expiresAt: string;
};

type RequestStateTerminalClosureContract =
  | {
      closureContractKind: "definitive_terminal_absence";
      terminalAbsenceEvidenceContractVersionId: string;
      providerExpiryCertificationId: null;
    }
  | {
      closureContractKind: "provider_enforced_expiry";
      terminalAbsenceEvidenceContractVersionId: null;
      providerExpiryCertificationId: string;
    }
  | {
      closureContractKind: "terminal_absence_or_provider_expiry";
      terminalAbsenceEvidenceContractVersionId: string;
      providerExpiryCertificationId: string;
    };

type ReconciliationRetentionLeaseCommonBase = {
  leaseId: string;
  organizationId: string;
  workspaceId: string;
  reconciliationRetentionClassId: string;
  ownershipEpoch: string;
  executionTarget: ExecutionTargetRef;
  credentialContinuityRequirement: CredentialContinuityRequirement;
  credentialLifecycleCoverageReceiptId: string;
  componentVersionIds: string[];
  retirementEpoch: string;
  createdAt: string;
};

type ReconciliationRetentionLeaseBase =
  ReconciliationRetentionLeaseCommonBase &
    (
      | {
          retentionAuthorityKind: "request_state";
          owner:
            | { kind: "provider_outcome"; ownerId: string }
            | {
                kind: "request_state_orphan_provider_state";
                ownerId: string;
              };
          upstreamIdempotencyCertificationId: string;
          upstreamIdempotencyKeyBindingId: string;
          upstreamIdempotencyKeyBindingHash: string;
          recoveryNotAfter: string;
          requestStateRecoveryContractVersionId: string;
          requestStateTerminalClosureContractVersionId: string;
          requestStateTerminalClosureContract: RequestStateTerminalClosureContract;
          lifecycleOperationDefinitionVersionIds: [];
          continuingProviderLiability: false;
        }
      | {
          retentionAuthorityKind: "resource_lifecycle";
          owner:
            | { kind: "resource_cost_obligation"; ownerId: string }
            | { kind: "orphan_resource_cost_obligation"; ownerId: string }
            | { kind: "provider_outcome"; ownerId: string }
            | { kind: "orphan_provider_resource"; ownerId: string };
          upstreamIdempotencyCertificationId: null;
          upstreamIdempotencyKeyBindingId: null;
          upstreamIdempotencyKeyBindingHash: null;
          recoveryNotAfter: null;
          requestStateRecoveryContractVersionId: null;
          requestStateTerminalClosureContractVersionId: null;
          requestStateTerminalClosureContract: null;
          lifecycleOperationDefinitionVersionIds: NonEmptyArray<string>;
          continuingProviderLiability: true;
        }
    );

type ReconciliationRetentionLease = ReconciliationRetentionLeaseBase &
  (
    | { state: "active"; releasedAt: null }
    | { state: "released"; releasedAt: string }
  );

type RetentionLeaseIndexProof = {
  partitionSchemeVersion: string;
  fixedPartitionCount: number;
  partitionHighWaterMarks: NonEmptyArray<{
    partitionId: string;
    highWaterMark: string;
  }>;
  liveLeaseCount: string;
  leaseSetDigest: string;
  credentialRequirementSetDigest: string;
};

type ReconciliationRetentionLeaseIndexProof = RetentionLeaseIndexProof &
  (
    | {
        retentionAuthorityKind: "request_state";
        reconciliationRetentionClassId: string;
        requestStateRecoveryContractVersionId: string;
        requestStateTerminalClosureContractVersionId: string;
      }
    | {
        retentionAuthorityKind: "resource_lifecycle";
        reconciliationRetentionClassId: string;
        requestStateRecoveryContractVersionId: null;
        requestStateTerminalClosureContractVersionId: null;
      }
  );

type ReconciliationRetentionClassBase = {
  reconciliationRetentionClassId: string;
  executionTarget: ExecutionTargetRef;
  componentVersionIds: string[];
};

type ReconciliationRetentionClass = ReconciliationRetentionClassBase &
  (
    | {
        retentionAuthorityKind: "request_state";
        requestStateRecoveryContractVersionId: string;
        requestStateTerminalClosureContractVersionId: string;
        lifecycleOperationDefinitionVersionIds: [];
        continuingProviderLiability: false;
        leaseIndexProof: Extract<
          ReconciliationRetentionLeaseIndexProof,
          { retentionAuthorityKind: "request_state" }
        >;
      }
    | {
        retentionAuthorityKind: "resource_lifecycle";
        requestStateRecoveryContractVersionId: null;
        requestStateTerminalClosureContractVersionId: null;
        lifecycleOperationDefinitionVersionIds: NonEmptyArray<string>;
        continuingProviderLiability: true;
        leaseIndexProof: Extract<
          ReconciliationRetentionLeaseIndexProof,
          { retentionAuthorityKind: "resource_lifecycle" }
        >;
      }
  );

type StateRetentionGeneration = {
  scope: { organizationId: string; workspaceId: string };
  generation: string;
  previousGenerationHash: string;
  stateLeaseHighWaterMark: string;
  reconciliationLeaseHighWaterMark: string;
  lifecycleCreatorRegistrationHighWaterMark: string;
  retirementEpochHighWater: string;
  targetRetirements: Array<{
    executionTargets: NonEmptyArray<ExecutionTargetRef>;
    componentVersionIds: string[];
    epoch: string;
    lifecycleCreatorRegistrationHighWaterMark: string;
    stateCreatorAbsorptionProofId: string;
    state:
      | "blocking_new_roots"
      | "retaining_descendants"
      | "blocking_all_creates"
      | "creators_drained"
      | "retention_acked"
      | "cancelled"
      | "released";
  }>;
  retainedStateTargetClasses: Array<{
    stateRetentionClassId: string;
    executionTargets: NonEmptyArray<ExecutionTargetRef>;
    executionConstraintClass: PersistedStateExecutionConstraint;
    operationDefinitionVersionId: string;
    resourceProfileVersionId: string | null;
    stateMappingCertificationId: string;
    componentVersionIds: string[];
    allowedStateActions: string[];
    descendantCreationAllowed: boolean;
    leaseIndexProof: RetentionLeaseIndexProof;
  }>;
  retainedReconciliationClasses: ReconciliationRetentionClass[];
  signature: string;
};

type StateTargetRetirementBase = {
  retirementId: string;
  scope: { organizationId: string; workspaceId: string };
  executionTargets: NonEmptyArray<ExecutionTargetRef>;
  componentVersionIds: string[];
  epoch: string;
  previousEpochHash: string;
  lifecycleCreatorRegistrationHighWaterMark: string;
  stateCreatorAbsorptionProofId: string;
  stateLeaseHighWaterMark: string;
  reconciliationLeaseHighWaterMark: string;
  signature: string;
};

type StateTargetRetirementForwardState =
  | "blocking_new_roots"
  | "retaining_descendants"
  | "blocking_all_creates"
  | "creators_drained"
  | "retention_acked"
  | "released";

type StateTargetRetirement =
  | (StateTargetRetirementBase & { state: StateTargetRetirementForwardState })
  | (StateTargetRetirementBase & {
      state: "cancelled";
      cancelledFromState: Exclude<StateTargetRetirementForwardState, "released">;
      cancellationReason: string;
      restoredComponentProofId: string;
      credentialContinuityCoverageProofId: string;
    });

type ProcessorInvocationIntentBase = {
  processorInvocationId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  activeExecutionReferenceId: string;
  processorInputRefId: string;
  processorProfileVersionId: string;
  parentInvokeAuthorizationDecisionId: string;
  invocationMode: "one_shot" | "single_bounded_stream" | "per_frame";
  maximumInvocations: number;
  budgetEnvelopeId: string;
  createdAt: string;
};

type ProcessorInvocationIntent = ProcessorInvocationIntentBase &
  (
    | {
        executionPlan: {
          kind: "in_process";
          implementationComponentVersionId: string;
        };
      }
    | {
        executionPlan: {
          kind: "model_plan";
          childRequestId: string;
          processorServicePrincipalId: string;
        };
      }
    | {
        executionPlan: {
          kind: "connector";
          processorServicePrincipalId: string;
          processorConnectorVersionId: string;
        };
      }
  );

type ProcessorOutputRef = {
  processorOutputRefId: string;
  processorInvocationId: string;
  processorInvocationTerminalOutcomeId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  outputSchemaVersionId: string;
  normalizedOutputDigest: string;
  dataClassification: string;
  encryptedArtifactRef: string;
  producedAt: string;
  signature: string;
};

type ProcessorInvocationState =
  | {
      processorInvocationId: string;
      organizationId: string;
      workspaceId: string;
      requestId: string;
      state: "pending";
      processorInvocationTerminalOutcomeId: null;
    }
  | {
      processorInvocationId: string;
      organizationId: string;
      workspaceId: string;
      requestId: string;
      state: "terminal";
      processorInvocationTerminalOutcomeId: string;
    };

type ProcessorConnectorBudgetAllocation = {
  processorConnectorBudgetAllocationId: string;
  processorConnectorExecutionAdmissionId: string;
  budgetCommitmentSliceId: string;
  budgetQuoteSetMemberId: string;
  sourceBudgetEnvelopeMemberId: string;
  budgetReservationCommitmentId: string;
  maximumBranchAllocations: BudgetMaximumBranchAllocationRef[];
  budgetConversion: BudgetCurrencyConversion;
  allocatedFixedPoint: string;
};

type ProcessorConnectorExecutionAdmissionBase = {
  processorConnectorExecutionAdmissionId: string;
  processorConnectorAttemptId: string;
  processorConnectorAttemptProgressId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  processorInvocationId: string;
  processorInputRefId: string;
  normalizedInputDigest: string;
  activeExecutionReferenceId: string;
  processorProfileVersionId: string;
  processorServicePrincipalId: string;
  processorConnectorVersionId: string;
  targetExecuteAuthorizationDecisionId: string;
  targetExecuteAuthorizationOutcome: "allowed";
  authorizationPolicyVersionIds: NonEmptyArray<string>;
  authorizationPolicyGeneration: string;
  connectionGrantDecisionId: string;
  healthDecisionId: string;
  circuitDecisionId: string;
  capacityAdmissionId: string;
  concurrencyAdmissionId: string;
  quotaAdmissionId: string;
  narrowingDecisionId: string;
  canonicalRequestCostValuationId: string;
  budgetEnvelopeId: string;
  budgetEnvelopeSnapshotId: string;
  budgetQuoteSetId: string;
  runtimeAdmissionFencingEpoch: string;
  narrowingGeneration: string;
  validThrough: string;
  admittedAt: string;
  dispatchIntentId: string;
  consumedAt: string;
  signature: string;
};

type ProcessorConnectorExecutionAdmission = ProcessorConnectorExecutionAdmissionBase &
  (
    | {
        attemptTransition: "initial";
        previousProcessorConnectorExecutionAdmissionId: null;
        expectedPreviousAttemptProgressEpoch: null;
      }
    | {
        attemptTransition: "retry";
        previousProcessorConnectorExecutionAdmissionId: string;
        expectedPreviousAttemptProgressEpoch: string;
      }
  ) &
  (
    | {
        budgetAdmission: Extract<BudgetAdmission, { kind: "no_applicable_budget_rules" }>;
        allocations: [];
      }
    | {
        budgetAdmission: Extract<BudgetAdmission, { kind: "reserved" }>;
        allocations: NonEmptyArray<ProcessorConnectorBudgetAllocation>;
      }
  );

type ProcessorConnectorAttemptProgressBase = {
  processorConnectorAttemptProgressId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  processorInvocationId: string;
  currentProcessorConnectorAttemptId: string;
  currentProcessorConnectorExecutionAdmissionId: string;
  currentProcessorConnectorDispatchIntentId: string;
  progressEpoch: string;
  fencingEpoch: string;
  updatedAt: string;
};

type ProcessorConnectorAttemptProgress = ProcessorConnectorAttemptProgressBase &
  (
    | {
        state: "open";
        processorInvocationTerminalOutcomeId: null;
      }
    | {
        state: "terminal";
        processorInvocationTerminalOutcomeId: string;
      }
  );

type ProcessorConnectorDispatchIntent = RemoteDispatchIntentBase & {
  processorConnectorDispatchIntentId: string;
  processorConnectorExecutionAdmissionId: string;
  processorConnectorAttemptId: string;
  processorConnectorAttemptProgressId: string;
  processorInvocationId: string;
  processorInputRefId: string;
  normalizedInputDigest: string;
  canonicalRequestCostValuationId: string;
  budgetEnvelopeSnapshotId: string;
  budgetQuoteSetId: string;
  processorConnectorExecutionAdmissionHash: string;
  upstreamRetrySafety: UpstreamRetrySafety;
};

type ProcessorInvocationTerminalOutcomeBase = {
  processorInvocationTerminalOutcomeId: string;
  processorInvocationId: string;
  organizationId: string;
  workspaceId: string;
  requestId: string;
  processorOutcomeId: string;
  completedAt: string;
};

type ProcessorInvocationTerminalOutcome =
  | (ProcessorInvocationTerminalOutcomeBase & {
      kind: "denied";
      denialEvidence: ExecutionDenialEvidence;
    })
  | (ProcessorInvocationTerminalOutcomeBase & {
      kind: "in_process_completed";
      implementationComponentVersionId: string;
      processorOutputRefId: string;
    })
  | (ProcessorInvocationTerminalOutcomeBase & {
      kind: "model_denied";
      childDecisionTerminalOutcome: ScopedExecutionDecisionTerminalOutcomeRef;
      denialEvidence: ExecutionDenialEvidence;
    })
  | (ProcessorInvocationTerminalOutcomeBase & {
      kind: "model_provider_selected";
      childDecisionTerminalOutcome: ScopedExecutionDecisionTerminalOutcomeRef;
      terminalSelectedExecutionTargetId: string;
      processorOutputRefId: string;
    })
  | (ProcessorInvocationTerminalOutcomeBase & {
      kind: "connector_selected";
      processorConnectorExecutionAdmissionId: string;
      processorOutputRefId: string;
    });

type AccessProfileVersion = {
  accessProfileVersionId: string;
  workspaceId: string;
  policyVersionRefs: string[];
  lifecycle: "draft" | "approved" | "published" | "superseded" | "retired";
};

type ScopedPolicyAttachment = {
  policyVersionId: string;
  scopeKind: "principal" | "credential";
  scopeId: string;
  sourceAccessProfileVersionId: string;
};

type IssuedCredentialGrant = {
  credentialId: string;
  issuanceTemplateVersionId: string;
  issuingWorkspaceRevisionId: string;
  accessProfileVersionId: string;
  policyAttachments: ScopedPolicyAttachment[];
  narrowingPolicyVersionIds: string[];
  effectivePolicyFingerprint: string;
  expiresAt: string;
};

type DurableIdempotencyRecordBase = {
  idempotencyRecordId: string;
  callerIntentNormalizationVersion: string;
  lookup:
    | {
        kind: "caller_token_hmac";
        idempotencyNamespaceId: string;
        value: string;
        hmacKeyVersion: string;
      }
    | { kind: "request_id"; value: string };
  organizationId: string;
  workspaceId: string;
  principalId: string;
  credentialScopeId: string;
  operation: OperationDefinitionRef;
  callerIntentHmacKeyVersion: string;
  callerIntentHmac: string;
  pendingCollisionBehavior: "return_in_progress" | "wait_then_replay" | "fanout_from_start";
  currentExecutionProvenanceId: string;
  provenanceTransitionEpoch: string;
};

type DurableIdempotencyRecord = DurableIdempotencyRecordBase &
  (
    | {
        recordPhase: "initializing";
        state: "pending";
        responseCommitmentState: "not_started";
        dispatchAllowed: false;
        currentProvenancePhase: "claimed_unresolved";
        deduplicationFence: { state: "open"; gcCertificateId: null };
      }
    | {
        recordPhase: "dispatch_ready";
        state: "pending";
        responseCommitmentState: "not_started";
        dispatchAllowed: true;
        currentProvenancePhase: "dispatch_ready";
        deduplicationFence: { state: "open"; gcCertificateId: null };
      }
    | {
        recordPhase: "executing";
        state: "pending";
        responseCommitmentState: "not_started";
        dispatchAllowed: true;
        currentProvenancePhase: "execution_bound";
        deduplicationFence: { state: "open"; gcCertificateId: null };
      }
    | {
        recordPhase: "executing";
        state: "pending";
        responseCommitmentState: "committed";
        dispatchAllowed: false;
        currentProvenancePhase: "execution_bound";
        deduplicationFence: { state: "open"; gcCertificateId: null };
      }
    | {
        recordPhase: "executing";
        state: "indeterminate";
        responseCommitmentState: "not_started" | "committed";
        dispatchAllowed: false;
        currentProvenancePhase: "execution_bound";
        deduplicationFence: { state: "open"; gcCertificateId: null };
      }
    | {
        recordPhase: "terminal";
        state: "succeeded" | "failed_terminal";
        responseCommitmentState: "terminal";
        dispatchAllowed: false;
        currentProvenancePhase: "terminal";
        deduplicationFence:
          | { state: "terminal_retained"; gcCertificateId: null }
          | { state: "gc_certified"; gcCertificateId: string };
      }
  );

type IdempotencyResourceExposureLink = {
  idempotencyResourceExposureLinkId: string;
  idempotencyRecordId: string;
  provenanceEpoch: string;
  costExposure:
    | { kind: "prepared"; resourceCostExposureId: string }
    | { kind: "active_binding"; resourceCostObligationId: string }
    | { kind: "orphan"; orphanResourceCostObligationId: string }
    | {
        kind: "aborted_before_acceptance";
        resourceCostExposureId: string;
        definitiveNonacceptanceEvidenceId: string;
      };
};

type IdempotencyProviderMapping = {
  idempotencyProviderMappingId: string;
  idempotencyRecordId: string;
  attemptId: string;
  keyHmac: string;
  reconciliationRetentionLeaseId: string;
  outcomeHorizonEndsAt: string | null;
  terminalEvidenceId: string | null;
};

type IdempotencyGcCertificate = {
  certificateId: string;
  idempotencyRecordId: string;
  terminalState: "succeeded" | "failed_terminal";
  terminalProvenanceId: string;
  providerOutcomeHighWaterMark: string;
  releasedStateBindingHighWaterMark: string;
  terminalResourceCostExposureHighWaterMark: string;
  releasedReconciliationLeaseHighWaterMark: string;
  providerMappingOutcomeHorizonEndsAt: string;
  retainLookupHmacKeysThrough: string;
  retainCallerIntentHmacKeysThrough: string;
  notBefore: string;
  signature: string;
};

type NarrowingEnforcementPoint =
  | "admission"
  | "before_capture"
  | "before_state"
  | "before_cache"
  | "before_processor"
  | "before_provider"
  | "before_retry"
  | "before_release";

type NarrowingAbsorptionAuthority =
  | "workspace_revision"
  | "identity_directory"
  | "provider_credential_directory"
  | "state_retention_generation";

type NarrowingAuthorityActionKind =
  | "fence_identity_generation"
  | "fence_provider_credential_generation"
  | "fence_limit_allocation_epoch"
  | "fence_reservation_epoch"
  | "recompute_remaining_capacity"
  | "purge_prompt_artifacts"
  | "purge_cache_entries"
  | "purge_replay_artifacts"
  | "expire_or_delete_state_resources";

type CompiledNarrowingDependencyMatcher =
  | {
      matchMode: "exact_dependencies";
      predicate: {
        normalForm: "disjunctive";
        anyOf: NonEmptyArray<{
          requiredCompletenessStage: ActiveExecutionDependencyStage;
          allOf: NonEmptyArray<NarrowingDependencyRef>;
        }>;
      };
      wholeWorkspaceReason: null;
    }
  | {
      matchMode: "whole_workspace";
      predicate: null;
      wholeWorkspaceReason: string;
    };

type DerivedNarrowingEnforcementPlan = {
  enforcementContractVersion: string;
  absorptionAuthority: NarrowingAbsorptionAuthority;
  activeExecutionMatcher: CompiledNarrowingDependencyMatcher;
  enforcementPoints: NonEmptyArray<NarrowingEnforcementPoint>;
  activeBehavior: "new_dispatch_only" | "abort_active";
  authorityActions: Array<{
    actionId: string;
    kind: NarrowingAuthorityActionKind;
    authorityId: string;
  }>;
  planHash: string;
};

type NarrowingAuthorityActionReceipt = {
  actionId: string;
  authorityId: string;
  authorityEpoch: string;
  completedThroughHighWaterMark: string;
  outcome: "completed";
  evidenceId: string;
};

type ServingRingNarrowingAck = {
  ringId: string;
  servingMembershipEpoch: string;
  authoritativeGeneration: string;
  evidenceId: string;
};

type LiveExecutionAuthorityNarrowingAckBase = {
  authority: LiveExecutionAuthorityRef;
  frozenAuthorityBindingRegistrationHighWaterMark: string;
  frozenAuthorityBindingRegistrySnapshotDigest: string;
  finalRegistrationSequenceHighWaterMark: string;
  finalDependencyFactHighWaterMark: string;
  finalDependencySnapshotHighWaterMark: string;
  evidenceId: string;
};

type LiveExecutionAuthorityNarrowingAck =
  LiveExecutionAuthorityNarrowingAckBase &
    (
      | {
          hierarchyCoverageKind: "sealed_hierarchy_set";
          activeExecutionSealIds: NonEmptyArray<string>;
          activeExecutionSealSetDigest: string;
          sealedHierarchySetDigest: string;
          nonmatchingRestampBindingIds: string[];
          nonmatchingRestampBindingSetDigest: string;
          matchingOrIndeterminateTerminalHierarchySetDigest: string;
          sealedHierarchyPartitionProofId: string;
          emptyHierarchySetProofId: null;
          emptyHierarchySetProofHash: null;
        }
      | {
          hierarchyCoverageKind: "empty_hierarchy_set";
          activeExecutionSealIds: [];
          activeExecutionSealSetDigest: string;
          sealedHierarchySetDigest: string;
          nonmatchingRestampBindingIds: [];
          nonmatchingRestampBindingSetDigest: string;
          matchingOrIndeterminateTerminalHierarchySetDigest: string;
          sealedHierarchyPartitionProofId: null;
          emptyHierarchySetProofId: string;
          emptyHierarchySetProofHash: string;
        }
    );

type WorkspaceNarrowingProof =
  | {
      kind: "serving_and_live_authority_set_ack";
      trafficReceivingRingSetHighWaterMark: string;
      frozenRingSetHash: string;
      ringAcks: ServingRingNarrowingAck[];
      liveExecutionAuthoritySetHighWaterMark: string;
      frozenLiveExecutionAuthoritySetHash: string;
      liveAuthorityAcks: NonEmptyArray<LiveExecutionAuthorityNarrowingAck>;
      completedAt: string;
    }
  | {
      kind: "dormant_workspace_activation_fence";
      authoritativeGeneration: string;
      workspaceActivationHighWaterMark: string;
      trafficReceivingRingSetHighWaterMark: string;
      emptyRingSetProofId: string;
      liveExecutionAuthoritySetHighWaterMark: string;
      emptyLiveExecutionAuthoritySetProofId: string;
      evidenceId: string;
      completedAt: string;
    };

type NarrowingAbsorptionReceiptBase = {
  receiptId: string;
  deltaId: string;
  absorptionAuthority: NarrowingAbsorptionAuthority;
  absorbingGeneration: string;
  authorityActionReceipts: NarrowingAuthorityActionReceipt[];
  completedAt: string;
  signature: string;
};

type NarrowingAbsorptionReceipt = NarrowingAbsorptionReceiptBase &
  (
    | {
        workspaceProof: Extract<
          WorkspaceNarrowingProof,
          { kind: "serving_and_live_authority_set_ack" }
        >;
        activeExecutionSealIds: string[];
        activeExecutionSealSetDigest: string;
        liveAuthoritySealCoverageDigest: string;
        executionResolutionScope: "restamp_nonmatching_and_drain_matching_or_indeterminate";
        activeExecutionAuthorityRestampBindingIds: string[];
        activeExecutionAuthorityRestampBindingSetDigest: string;
        sealedExecutionRegistrationHighWaterVectorId: string;
        sealedExecutionDependencyFactHighWaterVectorId: string;
        sealedExecutionDependencySnapshotHighWaterVectorId: string;
        sealedHierarchyResolutionSetDigest: string;
        sealedHierarchyResolutionPartitionProofId: string;
        matchingOrIndeterminateDrainEvidenceId: string | null;
      }
    | {
        workspaceProof: Extract<
          WorkspaceNarrowingProof,
          { kind: "dormant_workspace_activation_fence" }
        >;
        activeExecutionSealIds: [];
        activeExecutionSealSetDigest: null;
        liveAuthoritySealCoverageDigest: null;
        executionResolutionScope: "no_live_authorities";
        activeExecutionAuthorityRestampBindingIds: [];
        activeExecutionAuthorityRestampBindingSetDigest: null;
        sealedExecutionRegistrationHighWaterVectorId: null;
        sealedExecutionDependencyFactHighWaterVectorId: null;
        sealedExecutionDependencySnapshotHighWaterVectorId: null;
        sealedHierarchyResolutionSetDigest: null;
        sealedHierarchyResolutionPartitionProofId: null;
        matchingOrIndeterminateDrainEvidenceId: null;
      }
  );

type NarrowingWorkspaceScope = {
  organizationId: string;
  workspaceId: string;
};

type NarrowingSubjectFilter = {
  subjectKind: "credential" | "principal" | "policy_scope";
  subjectId: string;
};

type NarrowingDeltaEnvelope = {
  deltaId: string;
  incidentId: string;
  workspaceScope: NarrowingWorkspaceScope;
  subjectFilter: NarrowingSubjectFilter | null;
  introducedInOverlayGeneration: string;
  revocationFanoutId: string | null;
  baseWorkspaceRevisionId: string;
  baseIdentityDirectoryGeneration: string;
  baseProviderCredentialDirectoryGeneration: string;
  baseStateRetentionGeneration: string;
  basePolicyVersionIds: string[];
  enforcementContractVersion: string;
  derivedEnforcementPlanHash: string;
  reasonCode: string;
  reason: string;
  actor: { actorType: "human" | "service" | "system"; actorId: string };
  issuedAt: string;
  handoffDeadline: string;
  signature: string;
};

type NarrowingRevocationHeadStateHashInput = {
  workspaceScope: NarrowingWorkspaceScope;
  revocationAuthorityId: string;
  authorityTerm: string;
  authorityFencingToken: string;
  authorityTermValidThrough: string;
  committedIssuanceIndex: string;
  currentOverlayContentId: string;
  currentOverlayGeneration: string;
  currentOverlayContentHash: string;
  currentActiveDeltaSetDigest: string;
  currentRevocationFanoutHighWaterMark: string;
  currentNarrowingFreshnessLeaseContentId: string | null;
  currentNarrowingFreshnessLeaseContentHash: string | null;
  headStateHashVersionId: string;
};

type NarrowingRevocationAuthorityHeadSnapshot =
  NarrowingRevocationHeadStateHashInput & {
    headStateHash: string;
  };

type NarrowingRevocationAuthorityHeadBase =
  NarrowingRevocationAuthorityHeadSnapshot & {
    currentHeadTransitionId: string;
    currentHeadTransitionHashVersionId: string;
    currentHeadTransitionHash: string;
    currentConsensusCommitReceiptId: string;
    currentConsensusCommitReceiptHashVersionId: string;
    currentConsensusCommitReceiptHash: string;
    updatedAt: string;
  };

type NarrowingRevocationAuthorityHead =
  NarrowingRevocationAuthorityHeadBase &
    (
      | {
          certificateMaterializationState: "pending";
          currentCommitCertificateId: null;
          currentCommitCertificateHashVersionId: null;
          currentCommitCertificateHash: null;
        }
      | {
          certificateMaterializationState: "ready";
          currentCommitCertificateId: string;
          currentCommitCertificateHashVersionId: string;
          currentCommitCertificateHash: string;
        }
    );

type NarrowingRevocationPreparedContentRef =
  | {
      preparedContentKind: "overlay_generation";
      preparedContentId: string;
      preparedContentHash: string;
      canonicalContentHashVersionId: string;
    }
  | {
      preparedContentKind: "freshness_lease";
      preparedContentId: string;
      preparedContentHash: string;
      canonicalContentHashVersionId: string;
    };

type NarrowingRevocationAuthorityHeadTransitionBase = {
  narrowingRevocationAuthorityHeadTransitionId: string;
  successorHead: NarrowingRevocationAuthorityHeadSnapshot;
  proposedAt: string;
  transitionHashVersionId: string;
  transitionHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type NarrowingRevocationAuthorityHeadTransition =
  NarrowingRevocationAuthorityHeadTransitionBase &
    (
      | {
          transitionKind: "workspace_genesis";
          expectedHead: null;
          preparedContent: Extract<
            NarrowingRevocationPreparedContentRef,
            { preparedContentKind: "overlay_generation" }
          >;
        }
      | {
          transitionKind: "authority_term_acquisition";
          expectedHead: NarrowingRevocationAuthorityHeadSnapshot;
          preparedContent: null;
        }
      | {
          transitionKind: "overlay_publication";
          expectedHead: NarrowingRevocationAuthorityHeadSnapshot;
          preparedContent: Extract<
            NarrowingRevocationPreparedContentRef,
            { preparedContentKind: "overlay_generation" }
          >;
        }
      | {
          transitionKind: "freshness_lease_issuance";
          expectedHead: NarrowingRevocationAuthorityHeadSnapshot;
          preparedContent: Extract<
            NarrowingRevocationPreparedContentRef,
            { preparedContentKind: "freshness_lease" }
          >;
        }
    );

type NarrowingRevocationConsensusCommitReceiptBase = {
  narrowingRevocationConsensusCommitReceiptId: string;
  workspaceScope: NarrowingWorkspaceScope;
  narrowingRevocationAuthorityHeadTransitionId: string;
  narrowingRevocationAuthorityHeadTransitionHashVersionId: string;
  narrowingRevocationAuthorityHeadTransitionHash: string;
  successorHeadStateHashVersionId: string;
  successorHeadStateHash: string;
  committedIssuanceIndex: string;
  committedHeadProofId: string;
  committedAt: string;
  projectedCommitCertificateId: string;
  certificateIdDerivationVersionId: string;
  certificateProjectionVersionId: string;
  certificateHashDerivationVersionId: string;
  certificateHashVersionId: string;
  certificateSignatureAlgorithmVersionId: string;
  certificateSigningKeyVersionId: string;
  receiptHashVersionId: string;
  receiptHash: string;
  signatureKeyVersionId: string;
  signature: string;
};

type NarrowingRevocationConsensusCommitReceipt =
  NarrowingRevocationConsensusCommitReceiptBase &
    (
      | {
          transitionKind: "workspace_genesis";
          committedPreparedContent: Extract<
            NarrowingRevocationPreparedContentRef,
            { preparedContentKind: "overlay_generation" }
          >;
        }
      | {
          transitionKind: "authority_term_acquisition";
          committedPreparedContent: null;
        }
      | {
          transitionKind: "overlay_publication";
          committedPreparedContent: Extract<
            NarrowingRevocationPreparedContentRef,
            { preparedContentKind: "overlay_generation" }
          >;
        }
      | {
          transitionKind: "freshness_lease_issuance";
          committedPreparedContent: Extract<
            NarrowingRevocationPreparedContentRef,
            { preparedContentKind: "freshness_lease" }
          >;
        }
    );

type NarrowingRevocationHeadCommitCertificateBase = {
  narrowingRevocationHeadCommitCertificateId: string;
  narrowingRevocationConsensusCommitReceiptId: string;
  narrowingRevocationConsensusCommitReceiptHashVersionId: string;
  narrowingRevocationConsensusCommitReceiptHash: string;
  narrowingRevocationAuthorityHeadTransitionId: string;
  narrowingRevocationAuthorityHeadTransitionHashVersionId: string;
  narrowingRevocationAuthorityHeadTransitionHash: string;
  successorHeadStateHashVersionId: string;
  successorHeadStateHash: string;
  committedIssuanceIndex: string;
  committedHeadProofId: string;
  committedAt: string;
  certificateIdDerivationVersionId: string;
  certificateProjectionVersionId: string;
  certificateHashDerivationVersionId: string;
  certificateHashVersionId: string;
  certificateHash: string;
  signatureAlgorithmVersionId: string;
  signatureKeyVersionId: string;
  signature: string;
};

type NarrowingRevocationHeadCommitCertificate =
  NarrowingRevocationHeadCommitCertificateBase &
    (
      | {
          transitionKind: "workspace_genesis";
          committedPreparedContent: Extract<
            NarrowingRevocationPreparedContentRef,
            { preparedContentKind: "overlay_generation" }
          >;
        }
      | {
          transitionKind: "authority_term_acquisition";
          committedPreparedContent: null;
        }
      | {
          transitionKind: "overlay_publication";
          committedPreparedContent: Extract<
            NarrowingRevocationPreparedContentRef,
            { preparedContentKind: "overlay_generation" }
          >;
        }
      | {
          transitionKind: "freshness_lease_issuance";
          committedPreparedContent: Extract<
            NarrowingRevocationPreparedContentRef,
            { preparedContentKind: "freshness_lease" }
          >;
        }
    );

type NarrowingRevocationPreparedContentBase = {
  workspaceScope: NarrowingWorkspaceScope;
  revocationAuthorityId: string;
  proposedCommittedIssuanceIndex: string;
  canonicalContentHashVersionId: string;
  preparedAt: string;
  signatureKeyVersionId: string;
  signature: string;
};

type NarrowingRevocationExistingHeadPrecondition = {
  expectedRevocationAuthorityTerm: string;
  expectedRevocationAuthorityFencingToken: string;
  expectedHeadStateHashVersionId: string;
  expectedHeadStateHash: string;
  expectedCommittedIssuanceIndex: string;
};

type NarrowingOverlayGenerationContentBase =
  NarrowingRevocationPreparedContentBase & {
    narrowingOverlayGenerationContentId: string;
    generation: string;
    activeDeltaSetDigest: string;
    revocationFanoutHighWaterMark: string;
    narrowingFreshnessLeasePolicyVersionId: string;
    overlayContentHash: string;
  };

type NarrowingOverlayGenerationContent =
  NarrowingOverlayGenerationContentBase &
    (
      | {
          overlayTransitionKind: "workspace_genesis";
          expectedRevocationAuthorityTerm: null;
          expectedRevocationAuthorityFencingToken: null;
          expectedHeadStateHashVersionId: null;
          expectedHeadStateHash: null;
          expectedCommittedIssuanceIndex: null;
          previousOverlayContentHash: null;
          activeDeltaIds: [];
          clearedDeltas: [];
        }
      | (NarrowingRevocationExistingHeadPrecondition & {
          overlayTransitionKind: "successor";
          previousOverlayContentHash: string;
          activeDeltaIds: string[];
          clearedDeltas: Array<{
            deltaId: string;
            absorptionReceiptId: string;
          }>;
        })
    );

type NarrowingFreshnessLeaseContentBase =
  NarrowingRevocationPreparedContentBase &
    NarrowingRevocationExistingHeadPrecondition & {
      narrowingFreshnessLeaseContentId: string;
      revocationAuthorityTermValidThrough: string;
      narrowingFreshnessLeasePolicyVersionId: string;
      leaseSequence: string;
      authoritativeOverlayContentId: string;
      authoritativeOverlayGeneration: string;
      authoritativeOverlayContentHash: string;
      activeDeltaSetDigest: string;
      revocationFanoutHighWaterMark: string;
      trustedTimeSourceId: string;
      issuedAt: string;
      validFrom: string;
      validThrough: string;
      maximumLeaseDurationSeconds: number;
      leaseContentHash: string;
  };

type NarrowingFreshnessLeaseContent = NarrowingFreshnessLeaseContentBase &
  (
    | {
        leaseTransitionKind: "initial";
        predecessorNarrowingFreshnessLeaseContentId: null;
        predecessorNarrowingFreshnessLeaseContentHash: null;
      }
    | {
        leaseTransitionKind: "renewal";
        predecessorNarrowingFreshnessLeaseContentId: string;
        predecessorNarrowingFreshnessLeaseContentHash: string;
      }
  );

type NarrowingOverlayGeneration = {
  content: NarrowingOverlayGenerationContent;
  commitCertificate: Extract<
    NarrowingRevocationHeadCommitCertificate,
    { transitionKind: "workspace_genesis" | "overlay_publication" }
  >;
};

type NarrowingFreshnessLease = {
  content: NarrowingFreshnessLeaseContent;
  commitCertificate: Extract<
    NarrowingRevocationHeadCommitCertificate,
    { transitionKind: "freshness_lease_issuance" }
  >;
};

type RevocationFanoutEntry = {
  organizationId: string;
  workspaceId: string;
  deltaId: string;
  distributionProof: WorkspaceNarrowingProof | null;
  absorptionReceiptId: string | null;
};

type RevocationFanoutScope =
  | {
      scopeKind: "organization";
      organizationId: string;
      organizationWorkspaceHighWaterMark: string;
    }
  | {
      scopeKind: "platform";
      platformOrganizationHighWaterMark: string;
      organizationWorkspaceHighWaterMarks: NonEmptyArray<{
        organizationId: string;
        workspaceHighWaterMark: string;
      }>;
    };

type RevocationFanoutBase = {
  fanoutId: string;
  incidentId: string;
  scope: RevocationFanoutScope;
  generation: string;
  previousGenerationHash: string;
  entries: NonEmptyArray<RevocationFanoutEntry>;
  signature: string;
};

type SharedResourceFenceRestriction =
  | { kind: "deny_all_references" }
  | {
      kind: "incident_reconciliation_only";
      incidentAuthorizationId: string;
      lifecycleServicePrincipalId: string;
      exactLeaseMatchRequired: true;
    };

type SharedResourceFenceBase = {
  resourceVersionIds: NonEmptyArray<string>;
  fenceEpoch: string;
  resourceAuthorityId: string;
} &
  (
    | {
        resourceKind: "credential_slot_version";
        restriction: SharedResourceFenceRestriction;
      }
    | {
        resourceKind:
          | "provider_connection_version"
          | "credential_set_version"
          | "model_deployment_wire_binding"
          | "provider_resource_target"
          | "canonical_model_release"
          | "certification"
          | "processor_profile_version"
          | "processor_connector_version";
        restriction: { kind: "deny_all_references" };
      }
  );

type SharedResourceFence = SharedResourceFenceBase &
  (
    | {
        fenceState: "active";
        resourceAuthoritySuspensionReceiptId: null;
        localAbsorptionHighWaterMark: null;
      }
    | {
        fenceState: "authority_and_local_absorption_complete";
        resourceAuthoritySuspensionReceiptId: string;
        localAbsorptionHighWaterMark: string;
      }
  );

type SharedResourceFenceResume = {
  resumeId: string;
  fanoutId: string;
  fenceEpoch: string;
  resourceAuthoritySuspensionReceiptId: string;
  localAbsorptionHighWaterMark: string;
  resourceAuthorityRestorationReceiptId: string;
  restoredResourceAuthorityVersionId: string;
  approverIds: NonEmptyArray<string>;
  approvedAt: string;
  signature: string;
};

type RevocationFanout =
  | (Omit<RevocationFanoutBase, "scope"> & {
      fanoutKind: "organization_suspension";
      scope: Extract<RevocationFanoutScope, { scopeKind: "organization" }>;
      organizationIngressDenyEpoch: string;
      activationBlock: "all_new_workspaces_and_grants";
    })
  | (RevocationFanoutBase & {
      fanoutKind: "shared_resource";
      resourceFence: SharedResourceFence;
      activationBlock: "references_outside_fence_restriction";
    });

type NarrowingDelta = NarrowingDeltaEnvelope &
  (
    | {
        policyKind: "workspace_kill_switch";
        restriction: { action: "deny_all" };
      }
    | {
        policyKind: "identity_access";
        restriction:
          | { action: "disable_credentials"; ids: NonEmptyArray<string> }
          | { action: "disable_principals"; ids: NonEmptyArray<string> }
          | { action: "remove_workspace_grants"; ids: NonEmptyArray<string> };
      }
    | {
        policyKind: "model_access";
        restriction:
          | { action: "remove_logical_models"; ids: NonEmptyArray<string> }
          | { action: "remove_canonical_releases"; ids: NonEmptyArray<string> };
      }
    | {
        policyKind: "certification_access";
        restriction: { action: "remove_certifications"; ids: NonEmptyArray<string> };
      }
    | {
        policyKind: "operation_access";
        restriction:
          | { action: "remove_operations"; ids: NonEmptyArray<string> }
          | { action: "remove_wires"; ids: NonEmptyArray<string> }
          | {
              action: "remove_interaction_modes";
              modes: NonEmptyArray<"unary" | "stream" | "session" | "job">;
            };
      }
    | {
        policyKind: "provider_route_access";
        restriction:
          | { action: "remove_provider_connections"; ids: NonEmptyArray<string> }
          | { action: "remove_deployment_wire_bindings"; ids: NonEmptyArray<string> }
          | { action: "remove_provider_resource_targets"; ids: NonEmptyArray<string> }
          | { action: "remove_regions"; ids: NonEmptyArray<string> };
      }
    | {
        policyKind: "provider_credential_access";
        restriction:
          | {
              action: "restrict_credential_slot_versions_to_incident_reconciliation";
              ids: NonEmptyArray<string>;
            }
          | { action: "disable_credential_slot_versions"; ids: NonEmptyArray<string> }
          | { action: "disable_credential_set_versions"; ids: NonEmptyArray<string> };
      }
    | {
        policyKind: "state_access";
        restriction:
          | { action: "remove_resource_kinds"; ids: NonEmptyArray<string> }
          | { action: "remove_state_actions"; ids: NonEmptyArray<string> };
      }
    | {
        policyKind: "state_retention";
        restriction:
          | { action: "block_target_versions"; ids: NonEmptyArray<string> }
          | { action: "block_descendant_lineages"; ids: NonEmptyArray<string> };
      }
    | {
        policyKind: "resource_access";
        restriction:
          | { action: "remove_resource_profiles"; ids: NonEmptyArray<string> }
          | { action: "remove_resource_kinds"; ids: NonEmptyArray<string> }
          | { action: "remove_resource_purposes"; ids: NonEmptyArray<string> }
          | { action: "remove_resource_actions"; ids: NonEmptyArray<string> };
      }
    | {
        policyKind: "processor_access";
        restriction: { action: "remove_processor_profiles"; ids: NonEmptyArray<string> };
      }
    | {
        policyKind: "processor_target_access";
        restriction:
          | { action: "remove_processor_model_targets"; ids: NonEmptyArray<string> }
          | { action: "remove_processor_connector_versions"; ids: NonEmptyArray<string> };
      }
    | {
        policyKind: "data_handling";
        restriction:
          | { action: "remove_data_classifications"; ids: NonEmptyArray<string> }
          | { action: "remove_regions"; ids: NonEmptyArray<string> }
          | { action: "remove_network_classes"; ids: NonEmptyArray<string> }
          | { action: "reduce_maximum_retention"; maximumSeconds: number }
          | { action: "require_training_disabled" };
      }
    | {
        policyKind: "parameter_policy";
        restriction:
          | { operationId: string; parameterId: string; action: "reject" }
          | {
              operationId: string;
              parameterId: string;
              action: "force_to" | "cap_maximum_to";
              scalarValue: string | number | boolean;
            };
      }
    | {
        policyKind: "rate_limit";
        restriction: { action: "reduce_maximum"; limitRuleId: string; maximum: string };
      }
    | {
        policyKind: "budget";
        restriction: {
          action: "reduce_maximum";
          budgetRuleId: string;
          maximumFixedPoint: string;
        };
      }
    | {
        policyKind: "capture";
        restriction:
          | {
              action: "reduce_maximum_mode";
              mode: "none" | "metadata_only" | "redacted_sample";
            }
          | { action: "reduce_maximum_retention"; maximumSeconds: number };
      }
    | {
        policyKind: "guardrail";
        restriction: {
          action: "promote_mandatory_fail_closed";
          guardrailStageId: string;
          processorProfileVersionId: string;
        };
      }
  );
```

The closed unions remove nullable impossible states, but identifiers still require relational enforcement. Database constraints and serializable transition services must enforce all of the following:

- Every billable request-terminal work unit and resource valuation has separate provider-charge and accounting-currency maximum/forecast amounts matching owner/target/input/estimator/price provenance even when the budget set is empty. Same-currency accounting conversion requires equal currencies/amounts and no FX schedule; cross-currency accounting conversion requires exact source/target currencies, FX schedule and observation interval, rounding policy, and recomputable accounting amount. Before period slicing, each canonical cost subject plus rule/authority/scope/target-currency resolves to one immutable signed `BudgetActualCostSourceContract`; its eligible-slice digest covers every resulting `BudgetCommitmentSlice`, and every slice conversion references that exact contract. Provider/accounting admission selects the same actual component; contractual-maximum admission pins exactly one provider or accounting actual component. The contract's `CanonicalActualCostEvidenceMappingRef` must exactly equal one code-owned manifest's ID, version, and implementation hash, and publication proves its canonical-source schemas, target/valuation binding, usage/invoice/correction lineage, output schema, and conformance fixtures. Each `budgetCommitmentSliceId` resolves to one immutable signed slice whose rule/authority/scope/currency and single finite-period or contract attribution cannot change. Each quote stores source maximum/forecast currency/amount, target amount, exact same-currency or FX observation/rounding provenance, the shared source contract, and one immutable settlement-conversion authority set. That set is slice/target-currency/horizon bound, references the identical source contract, contains entries only for its selected actual component, has a unique entry per selected-component/currency contract, and pins same-currency proof or a closed FX version set/governed schedule series plus observation-selection, rounding, and finite-horizon/contractual/operational exposure-bound authority. Its owner is closed: request work has the exact `requestId` and null lifecycle fields; lifecycle funding has `requestId: null` and exact obligation, quote-set, and preallocated admission IDs. A firm commitment rejects every operational FX entry and includes each finite/contractual entry's maximum target exposure in its hold; an open-ended cross-currency contract cap requires a contractual FX ceiling. Its quote-set member, funding-expression leaf when aggregated, allocation, reservation, and resource commitment epoch when applicable carry the quoted conversion plus identical source-contract and authority-set IDs. Before attribution, exactly one signed `BudgetActualCostSourceEvidence` maps the canonical source under that admitted manifest and binds exact contract/hash, source fingerprint, target/valuation, usage or invoice lineage, correction predecessor/sequence, component, currency, and amount. Exactly one `CanonicalBudgetActualCostSourceSelection` is permitted for the reservation-independent `(contract, canonical source, rule, authority, scope, target currency)` group; its selected component and amount equal the evidence and contract, and its eligible reservation/slice digests are complete. One signed attribution references that selection and partitions the parent amount across all eligible reservation/slice components exactly. Each component names selection, evidence, reservation, slice, source contract, and authority set. Therefore provider charge and accounting cost cannot both debit different monthly reservations for one canonical charge. Every signed settlement retains the reservation's admitted conversion and binds the same selection, attribution, and one component. Its actual conversion source component/currency/amount equals that component and contract; its authority entry belongs to the admitted set and matches source component/currency and target currency; its same-currency proof or exact FX schedule certification/observation/rounding satisfies that entry; and its recomputed target amount equals the signed settled plus overrun deltas. A contract-cap reservation retains a contractual-maximum admitted source while every partial actual/correction uses its one pinned actual source. Each attribution component is consumed by exactly its named reservation/slice once; mapping version, source/component, contract, authority, scope, or slice substitution fails. A quote-set member resolves to exactly one quote/slice pair with identical identity fields; its nonempty members bijectively equal the applicable rule/slice evaluation, while its empty form has no member or reservation downstream.
- A root envelope's initial snapshot derives only from its sealed source quote sets and exact preflight-compiled funding plan. Every nonempty member has one signed funding derivation and snapshot. For an initial plan, every quote operand maps bijectively to one preflight operand and same-slice quote-set member with identical conversion/target amount; every node maps bijectively to one preflight node; every node is root-reachable; every non-root node has exactly one parent; and ordering, cardinality, `sum`, and `maximum` topology are exact. A readmitted plan names one member of a signed slice-complete `BudgetFundingPlanReadmissionBundle`: a carried quote operand retains its exact preflight operand/member; a fresh retry quote operand binds its current quote-admission decision and the logical/preflight input it replaces; and each retained-charge operand maps bijectively to signed partial, full, or indeterminate charge evidence and carries no independent amount or conversion authority. Settled evidence names the exact `BudgetCommitmentSettlement` rows and derives its slice-currency amount only as the sum of their settled and overrun deltas after validating every actual conversion, source selection, attribution component, reservation, slice, and authority entry. Indeterminate evidence names the exact still-held attempt allocations and reservation commitments and derives only their admitted slice-currency maximum. Evidence/reservation/allocation sets are complete, nonreplayed, and currency-homogeneous; every cached derived amount is recomputed from those rows. The bundle bijectively covers the applicable slice digest and one progress transition/snapshot CAS; each readmission binds predecessor plan/derivation, allocation disposition, logical lease/version, current preflight and policy authorization, complete admitted quote-set digest, exact remaining input set, code-owned transformation version, successor operand/topology hashes, the evidence-set hash and recomputed aggregate retained amount, required successor hold, and incremental headroom. Its remaining-choice topology compiles exactly one input as a direct branch with no top-level maximum ledger and requires at least two distinct inputs for `multiple_branches`; unary or empty maxima are invalid. No other runtime operand or topology rewrite is legal. Nested maxima rewrite the complete affected ancestor path under that successor plan. The root evaluation equals `derivedHeldFixedPoint`; the aggregate claims no conversion of its own. Every node and member satisfies `allocated = spendable + contingentShared`, every settled amount is at most spendable, and only spendable capacity can enter a reservation bundle or dispatch admission. Each maximum node has exactly one signed shared-capacity ledger whose capacity equals the maximum child evaluation, never their sum. The ledger records the complete planned input set, remaining-input projection, stable logical-branch reservation set, lease/version chain, and subordinate attempt-allocation chain. Lease acquisition consumes the current epoch/set, selects one logical child or route branch, closes only competing branch reservations from that epoch, and atomically creates both the logical lease and its unique sequence-zero `initial_acquisition` version; that version names the selected reservation and the first subordinate allocation, has no predecessor/disposition/readmission evidence, and is the lease's exact `initialBudgetMaximumBranchLeaseVersionId`. No sibling may lease while it is active. Every network attempt under that branch owns a fresh subordinate allocation and reservation commitment bound to the active lease version. Only a continuation version has a predecessor version and predecessor attempt-allocation disposition. A definitive-no-charge same-branch retry consumes the attempt allocation but preserves the branch input, versions the lease, and creates a new subordinate allocation. A retained-charge same-branch retry readmits `sum(retained_charge, max(same_branch_retry, remaining_branches))`, terminalizes only the predecessor ledger, and carries the same logical lease into its successor. Fallback or branch completion disposes the lease: no-charge fallback removes that logical input and reopens remaining siblings; chargeable fallback readmits `sum(retained_charge, max(remaining_branches))`; terminal completion admits no successor. Retry, fallback, and terminalization compare-and-swap the same attempt-allocation, lease-version, ledger, derivation, and snapshot heads. A processor child envelope names the exact parent and locked parent snapshot, preserves slice identity and parent derivation ID/hash, and uses one complete root-reachable allocation tree whose parent/child mappings preserve operators and source lineage. Operand nodes allocate exact amounts; sum nodes add values pointwise; available maximum nodes set spendable to zero and contingent to full shared capacity; leased maximum nodes take values only from the selected branch. A request reservation source names every matching logical lease, exact version, and fresh subordinate allocation. The allocation root equals both `allocatedFromParentFixedPoint` and the child root; raw sibling totals are never added. Every continuation has one predecessor and pointer compare-and-swap, nondecreasing allocation/settlement high-waters, `settled <= spendable <= allocated <= derivedHeld` per slice, and no slice insertion/removal except signed readmission. Different periods never share an amount/reservation/settlement. Request-owned bundles require matching quote/envelope members and all branch allocation refs; lifecycle-funding bundles require `requestId: null` and an exact obligation/quote/admission/allocation/epoch owner. Cross-owner substitution is rejected.
- Every selected transition has exactly one `ProviderAttemptProgress`. Its initial attempt commits with the selection; each same-target retry consumes the current open epoch and atomically installs one successor; fallback consumes the predecessor progress into terminal handoff while creating the successor selection/progress; decision terminalization consumes the current progress into terminal state. Unique roots/predecessors plus these compare-and-swap transitions prevent retry/retry, retry/fallback, and retry/terminal forks, and a fallback first attempt names the predecessor selection's final attempt. Every provider attempt has one `ProviderAttemptAdmission` whose target equals selection but whose health/circuit/capacity/concurrency/quota/narrowing and credential eligibility/quota belong to that exact attempt. Its closed owner variant agrees with the external operation resolution or exact processor invocation/input/target authorization carried by selection and dispatch. Its `BudgetAttemptAdmission` uses the current snapshot and complete quote-slice set; allocations bijectively cover nonempty slices and point to matching members/reservations. Empty admission has zero allocations and identical evidence. A prior allocation remains held or settled until no-charge evidence permits release, and any chargeable retry increment is admitted cumulatively against the total-attempt bound and every affected slice.
- Each dispatch intent has exactly one authority with `maximumInvocations: 1` and one immutable hash-chained state-transition root. The current projection must equal the chain head. Only the closed graph permits initialized-ready, exclusive claim, expired pre-send release, authorization-driven pre-send cancellation, send-start, await, definitive-not-sent, indeterminate, and terminal transitions. `ready -> claimed_before_send` is CAS-exclusive; only that executor/fence may commit `send_started`; claim expiry can return authority only before send-start; `cancel_before_send` may consume only ready/claimed state and is permanently terminal; and every crash after send-start becomes outcome-pending/indeterminate rather than reusable. A certified same-key recovery attempt requires one immutable certification-hashed `UpstreamIdempotencyKeyBinding` plus an authorization matching owner/target or connector, operation/lifecycle, exact key scope/HMAC, payload equivalence, retention, response/concurrency semantics, original intent/authority, ambiguity evidence, fresh attempt-progress CAS, runtime/budget admission, and cumulative headroom. Its code-derived `recoveryNotAfter` is the minimum of the original total request deadline, binding time plus certified provider retention, certification expiry, and policy cap. Authorization, admission, orphan control, lease, and intent copy that bound without extension, and the `mark_send_started` CAS rejects trusted time at or after it even when the worker claimed earlier or failed over. Request-terminal provider/connector recovery may create that fresh attempt; a state-creating provider recovery additionally consumes its exact request-state orphan's available control epoch and installs a fresh request-state lease. Resource-terminal create recovery cannot create another create attempt and may dispatch only separately admitted read-only reconciliation intents.
- Every ambiguous request-terminal state-creating outcome transfers before binding/idempotency terminalization to exactly one `RequestStateOrphanProviderState` matching the binding, idempotency record, selection, original attempt/outcome, exact certification/hash, immutable key-binding/hash, key/payload, derived recovery deadline, creator/credential registrations, and complete provider-outcome/reconciliation-lease set high-waters and digests. It has request-scoped cost ownership, `continuingProviderLiability: false`, and no resource exposure, obligation, lifecycle operation/polling, funding, bound extension, liability component, or invoice authority. Its owner-discriminated `request_state` reconciliation lease has an empty lifecycle-operation set and retains only the exact key binding, deadline, same-key recovery, and certified terminal absence/provider-expiry closure contract; a `resource_lifecycle` lease cannot substitute for it. A state-creating operation is enabled only when its exact capability manifest requires and its workspace receipt satisfies `request_state_orphan_recovery`, with current same-key/shared-result and terminal absence/provider-expiry evidence contracts. Recovery consumes one available control epoch, increments the non-extendable cumulative attempt count before `recoveryNotAfter`, and installs exactly one active authorization/progress/lease tuple. Deadline exhaustion adds no recovery or cleanup evidence and leaves the orphan and idempotency fence durably owned when no terminal basis exists. An ambiguous recovery atomically adds its outcome/lease and returns the control available; definitive no-new-effect releases only that recovery lease. Shared terminal success atomically closes the control/orphan, terminalizes the complete outcome set, releases the complete lease set, transfers creator/credential ownership, creates the state lease, activates the original binding, and advances idempotency before ID/result release. Terminal cleanup consumes the same available epoch and requires exact definitive nonacceptance/absence or provider-enforced expiry evidence; it releases every lease/registration and terminalizes binding/idempotency. Unique control epochs and predecessor/successor binding hashes make recovery/recovery, recovery/cleanup, double activation, and double cleanup single-winner races. The caller decision may expose only a wire-valid indeterminate result while the binding/idempotency fence remains open.
- One resource recovery authorization requires the prepared exposure already transferred to exactly one orphan whose control carries a signed bound-version ID/hash, absolute recovery horizon, cumulative invocation ceiling/consumed count, and authorization-chain high-water/hash. It atomically consumes that orphan's available recovery-control epoch and only a nonempty interval of its remaining cumulative allowance into exactly one authorization and `ResourceReconciliationAttemptProgress` root. The installed active pointer, authorization, and progress match orphan/exposure/provider outcome/reconciliation lease and ownership epoch, lifecycle service principal, exact certified target/operation/outcome schema, positive target authorization, bound version, allocated count interval, maximum invocations, deadline no later than the absolute horizon, and successor authorization-chain hash. Its initial and every successor poll match and consume both active control and open progress epochs plus one authorization-local and orphan-cumulative count slot while installing a fresh active-execution reference, retained-credential selection/evidence, health/circuit/capacity/concurrency/quota/narrowing and credential admissions, canonical request-cost valuation, complete-or-empty budget authority, immutable payload intent, and one-send dispatch authority. Admission consumes the count slot permanently even if dispatch is cancelled before send. Returning to `available` never decreases consumed count or extends the horizon, and a successor authorization can consume only remaining capacity. A bound extension consumes one predecessor version/control epoch and has a discriminated `invocation_ceiling`, `absolute_horizon`, or `both` delta. Count-only requires a strictly higher ceiling and identical horizon; horizon-only requires an exactly identical ceiling and strictly later horizon; combined requires both increases; no-op or decreased fields fail. Additional invocation capacity has no independently authored field: it is always `newCumulativeInvocationCeiling - predecessorCumulativeInvocationCeiling`, and the approval, marginal valuation, quote, existing-coverage proof or incremental bundle, admission, and successor bound version all bind the same `extensionDeltaHash` and exact horizon change. Its exact marginal-exposure valuation and quote must prove no applicable budget, sufficient existing reservation, or an exact incremental bundle for those derived inputs. Extension cannot reset count or authorization history. Unique control, root/predecessor, current-head, and authorization-chain constraints prevent authorization/authorization, extension/authorization, poll/poll, poll/terminal, and repeated-reauthorization bypass. Each dispatched attempt has exactly one terminal outcome matching its dispatch transition: codec observation, definitive-not-sent, sent-indeterminate, or pre-dispatch cancellation. Identity and definitive-absence progress dispositions require matching codec observations. Count/deadline exhaustion is not an attempt outcome: signed `ResourceReconciliationControlExhaustionEvidence` binds the active control/progress epochs, last completed head or exact zero-dispatch state, consumed local/orphan counts, ceilings/horizons, high-waters, and trusted time, creates no admission/intent/dispatch, terminalizes progress, and atomically returns control to `available`. A completed head admitted to exhaustion must be retryable/nonterminal; identity or definitive-absence evidence can only take its own terminal transition. If a ready/claimed attempt exists at time expiry, it first closes through ordinary pre-send cancellation and the exhaustion transition binds that exact closure; send-started work cannot be exhaustion-closed. Next-poll admission, exhaustion, policy/credential/admission cancellation, cleanup, absence, and activation consume the same epochs. Cleanup from `active` may only consume the active predecessor epoch into `closing_cleanup`, retaining exact authorization/progress pointers and blocking every new admission. An already-admitted attempt may record only its matching terminal outcome against those retained pointers. A ready/claimed dispatch must cancel before send. An already-terminal `definitive_not_sent` attempt closes through the dedicated `definitive_not_sent_no_charge` supersession variant with exact attempt outcome, transport proof, separate no-charge evidence, active-execution closure, complete budget disposition, and cleanup evidence. A send-started dispatch remains terminal/indeterminate with request-cost allocations held until canonical cost reconciliation. The retained progress becomes `cleanup_superseded` only with signed evidence joining terminal attempt/admission/intent/outcome and optional codec observation, dispatch closure, execution terminal, cost resolution, complete budget disposition, and cleanup terminal evidence. Only then may `closing_cleanup` become `closed/cleanup_terminal`; direct cleanup close is legal only from `available`. Non-identity outcomes leave the orphan as current liability owner, and only `original_resource_identity_proven` that wins before cleanup-start can authorize orphan activation.
- A processor input ref, intent, candidate context, quote set, model-target authorization or connector admission, dispatch intent, and retry all have the same invocation/profile/input digest and transformation epoch. Intent, current state, terminal outcome, and output share one organization/workspace/parent-request tuple. Connector admissions have exactly one initial root per connector invocation and one `ProcessorConnectorAttemptProgress`; every retry consumes its open epoch while installing a same-invocation fresh runtime/budget admission, intent, and dispatch authority, and terminalization consumes the current head and names that final admission through composite scoped foreign keys. Runtime authorization is positive, current, and exact for its service principal and target. Each completed processor terminal owns exactly one same-scope output ref with the same invocation/outcome. A model terminal additionally names a scoped child-decision terminal ref whose request equals the intent's `childRequestId`, and any final selected target resolves only inside that child tuple. A transformation-resolution successor additionally matches that input/output artifact, codec evidence, transformed digest, and readmission-policy bundle.
- Idempotency provenance has exactly one `claimed_unresolved` root. `dispatch_ready` follows only that root; each `execution_bound` follows `dispatch_ready` or another bound epoch while retaining the same dispatch-ready ancestor; initialization-failed terminal follows only the unresolved root; execution-terminal follows only dispatch-ready/bound provenance and agrees with the decision terminal/final selection. The record's current pointer, declared phase, and transition epoch equal the immutable provenance row. Release authorization names that exact current pointer/hash/phase and generation; wait completion re-resolves terminal provenance, each fanout authorization matches one subscriber/frame sequence/digest, and completed-result-unavailable has allowed terminal authorization plus exact no-artifact evidence.
- Every canonical request-cost settlement matches its exact valuation, provider attempt, connector admission, or resource-reconciliation admission, usage item, provider/accounting currencies, schedules/FX provenance, and dispatch outcome. A request-cost correction has one immutable original settlement/valuation/request/owner root and one unique predecessor chain; its invoice line/evidence, optional usage item, positive or negative provider/accounting deltas, conversion, price provenance, and sequence agree, and it cannot name a resource liability component. Every request-terminal budget settlement references either that original canonical settlement or one exact request-cost correction through a signed canonical attribution component; every resource budget settlement references exactly one provider-cost settlement or resource invoice-adjustment liability component plus the applicable resource commitment epoch and its corresponding attribution component. Before attribution, one exact code-owned mapping version produces signed source evidence whose source, target/valuation, usage/invoice lineage, correction lineage, component, currency, and amount match the shared source contract. One signed actual-source selection is unique per reservation-independent contract/canonical-source/rule/authority/scope/target-currency group and carries the complete eligible reservation/slice digests. Exactly one attribution references it, applies the pinned period policy, and partitions the selected parent amount across all eligible reservation-bound components. Thus a provider-charge selection and accounting-cost selection cannot debit separate monthly reservations for one canonical source. A settlement retains its reservation's admitted conversion separately from an actual conversion whose selection, evidence, component, currency, amount, source contract, and authority set match its unique attribution component, and no component can settle twice. When chargeability remains indeterminate, the matching dispatch authority and provider/connector/reconciliation cost lineage remain indeterminate and every allocation stays held even after the caller receives an indeterminate outcome; an empty budget set does not erase that canonical cost lineage. Every resource quote and epoch has dual-currency canonical valuation whose subtype, target, interval/horizon, plan, conversion, source contract, and price provenance agree even when budget coverage is empty. Only an initial epoch may reference the creating attempt/admissions/request quote. Every operational continuation references the current active/orphan obligation, exact predecessor epoch/hash, fresh lifecycle-funding quote/admission and lifecycle-sourced reservation bundle, and a previous/current slice transition; its quote set preallocates the admission ID, and its source contract, authority set, and bundle use the same obligation/quote/admission owner with `requestId: null`. Same-period transitions preserve slice identity, certified boundaries replace expired slices under preserved rule identity, and authorized policy replacement is explicit. Each prepared exposure matches exactly one provider attempt/runtime admission/budget admission/dispatch intent, owns that attempt's lifecycle start/quote/initial epoch, and cannot be inherited after definitive nonacceptance. Active and orphan ownership preserve that exposure lineage and exact sliced budget coverage. Each obligation has one append-only liability-component root and unique predecessor chain; every valuation epoch and invoice adjustment contributes one provider/accounting amount pair with its own conversion, the component set/high-water produces per-currency totals, and no aggregate amount claims one FX conversion. An orphan-to-active transfer has exactly one identity-proof terminal reconciliation progress/admission/intent/outcome/observation, matching active orphan recovery-control epoch, bound version, cumulative count, authorization-chain high-water, predecessor orphan, active successor, exposure, binding, provider outcome, upstream identity, state lease, and reconciliation lease; atomically closes the control, terminalizes current orphan ownership, advances both lease ownership epochs, and starts the successor at matching valuation, liability-component, lifecycle-funding, slice-transition, provider-settlement, budget-settlement, invoice-adjustment, and recovery-bound high-waters. The predecessor is immutable history and no later component or settlement may append to it. Aborting a definitively unaccepted exposure settles any chargeable request component and releases only proven-unused slice amounts. `settled` agrees with terminal provider/cleanup evidence and a released reconciliation lease and names a completeness certificate whose provider-usage set, provider-cost settlements, expected budget-slice/reservation set or signed zero-member proof, source-unique attributed budget settlements, canonical-valuation, liability-component, lifecycle-funding, slice-transition, and invoice-adjustment high-waters exactly equal the obligation.

Every narrowing restriction is validated against the exact pinned base policy version before signing and again before activation. Its code-owned schema rejects unknown fields, an empty `NonEmptyArray`, a mixed action object, an equality/no-op, and any value outside the base rule's allowed set. Numeric maximums must be strictly lower than the base maximum; rate and budget deltas name one existing base rule and cannot change its window or enforcement class. `force_to` must select one base-permitted value while removing at least one previously permitted value, `cap_maximum_to` must lower an existing cap, capture modes follow the strict order `none < metadata_only < redacted_sample`, and `require_training_disabled` is valid only when it changes an allowed state to denied. The validator also recomputes the absorption authority, executor points, and durable action set; a delta that cannot prove the restriction and its realizable enforcement plan is rejected in favor of the affected scope's deny-all kill switch.

- `settled_partial` retained-charge evidence derives a positive amount strictly below the complete admitted allocation set, while `settled_full` derives exactly that set's admitted maximum; indeterminate evidence derives the exact still-held admitted maximum. No evidence amount may be negative or exceed its complete allocation/reservation set, and no settlement or held allocation may fund two evidence records.
- A `BudgetMaximumSharedCapacityReservation` is an immutable non-mutating candidate: it records only the ledger epoch/hash it observed and can never advance the ledger or envelope snapshot. `BudgetMaximumBranchLease` revalidates that observation and is the only initial-acquisition ledger/snapshot transition. Its sequence-zero version has every CAS field null, references the exact immutable lease hash, and agrees with the lease's ledger, reservation, logical branch, derivation, selected inputs, initial-version pointer, post-CAS snapshot, and first subordinate allocation. Continuation versions alone own later CAS transitions.
- A recovery-extension marginal valuation exactly matches one code-owned derivation manifest. Its additional-call count equals the ceiling difference, its predecessor remaining count equals `max(predecessor ceiling - consumed count, 0)`, and its operand set is: additional calls for count-only; all remaining predecessor calls for horizon-only; or the nonzero members of those two disjoint classes for combined. Every operand has target-matching price/FX coverage through its exposure end and a complete intersecting budget-slice digest. Aggregate currency vectors equal the operand sums; zero is legal only with no operands. Quote, coverage/reservation, admission, and successor version all name the same valuation/hash, manifest, and delta hash.
- Every nonterminal active-execution hierarchy has exactly one current authority binding. An initial binding has no predecessor; a narrowing restamp has one sealed predecessor, one all-descendant nonmatch proof, and one atomic pointer/ownership-epoch update covering the proof's exact reference and snapshot sets. A bounded-DNF nonmatch proves at least one absent atom in every clause only after its required stage; whole-workspace and incomplete/unknown matches cannot restamp. Each seal's hierarchy set equals the disjoint union of completed restamps and terminal matching/indeterminate drains before absorption.
- A workspace supported-operation capability set contains exactly one entry for every operation-definition version in its pinned registry manifest and no other entry. Each entry's unique-by-capability requirements are recomputed from its code-owned manifest as exact `(capability, capabilityGateVersionId, evidenceContractVersionId)` triples. A readiness binding satisfies a requirement only when its signed workspace receipt names that exact triple and includes the operation-definition version in its certified set; no stale, future, cross-workspace, cross-operation, or merely same-named capability receipt is substitutable. `missingCapabilities` is the exact set of unsatisfied manifest requirements. An entry is `enabled` if and only if that set is empty. The activation tuple pins the complete signed set, and every `unavailable` entry is absent from discovery, grants, routes, profiles, generated client configuration, and runtime resolution.
- A narrowing overlay and freshness lease share one workspace's linearizable revocation-authority head. An absent workspace accepts exactly one create-if-absent `workspace_genesis` transition with null expected head and the code-defined empty initial overlay; it serves only after genesis certificate materialization and a later certified initial freshness lease. Publication is acyclic and recoverable. The versioned `NarrowingRevocationHeadStateHashInput` contains only semantic head fields and excludes its own output plus every transition, receipt, certificate, signature, and proof. A canonical prepared-content hash excludes its own hash/signature and every transition/receipt/certificate/proof field. A versioned compare-and-swap transition hash excludes its own hash/signature and every receipt/certificate/proof field while binding only that content ID/hash and the exact expected/successor semantic head. The quorum command atomically installs the transition, successor head, and exactly one workspace/transition-keyed consensus receipt; there is neither a head without its receipt nor a receipt without its head. A versioned certificate is one deterministic idempotent projection of that receipt, and neither receipt nor certificate is an input to a prior hash. After consensus, the head is certificate-pending; no successor or serving gate may consume it until any materializer recovers the receipt and attaches the unique certificate. Certificate recovery never changes the semantic head hash/index. Every non-genesis transition preserves workspace/authority identity, consumes one exact ready current state hash/index, and advances the committed issuance index exactly once. Authority-term acquisition has no content, strictly raises the term, replaces the fencing token/expiry, and preserves overlay/delta/fanout/lease heads. Overlay publication preserves the term and lease head while changing only the overlay/delta/fanout members. Lease issuance preserves the term and those exact overlay/delta/fanout members while changing only the lease head. A lease content record belongs to one monotonic predecessor chain, never lowers any high-water, cannot outlive its code-owned policy or authority term, and serves only when joined to its exact ready committed transition certificate. Admission and every active input, side-effect, retry, session-event, and release gate persist and compare the accepted content ID/hash, certificate/receipt, term/index/proof, and overlay to one unexpired committed lease; an absent/duplicate genesis, stale token, fork, prepared-only content, transition/receipt-only publication, pending or wrong certificate, hash-domain mismatch, expiry, or head mismatch fails closed without discarding ownership of already-sent provider work.
- Each live narrowing authority ACK freezes one exact authority epoch/fencing token, root-binding registration high-water, and binding-registry snapshot digest and covers exactly every current root binding in that snapshot with one root-scoped active-execution seal carrying the same values. A nonempty authority carries that complete nonduplicated seal set and digest; an authority with no such roots carries only a signed empty-hierarchy proof over the identical epoch/token/high-water/snapshot. All coverage digests include those authority fields. The workspace absorption receipt's live seal set is the disjoint union of every authority ACK, so neither a predecessor-epoch seal, a second root, nor an idle authority can disappear behind one representative seal.
- Every certificate-pending narrowing head's consensus receipt freezes one projected certificate ID, ID/hash derivation versions, projection-component version, hash and deterministic-signature algorithm versions, and signing-key version. Certificate materialization must use those exact inputs and produce one byte-identical certificate even across component deployment or key rotation. The component and key cannot retire while any referencing head is pending; attaching the certificate and flipping that same head ready is one idempotent atomic projection update.
- Every reconciliation-retention lease carries one signed class ID. A request-state lease, its class, and its class index proof have equal `request_state` discriminants and recovery/closure contract versions, while all lifecycle-operation authority is structurally empty. Its terminal-absence reference is a non-authorizing evidence contract evaluated only on the existing original/same-key target-codec outcome; it cannot dispatch another provider operation. A resource-lifecycle lease/class/proof instead have request-state contract fields null and a nonempty lifecycle-operation set. Cross-class/discriminant/contract substitution is invalid.
- A request-state binding remains `reconciling` for the complete lifetime of its open orphan. It has no cleanup-retained tombstone transition: exactly one atomic recovery transfer moves it to `active`, or one evidence-complete terminal cleanup moves it directly to `tombstoned_terminal`. Cleanup-retained bindings exist only for resource-lifecycle ownership.
- Every provider, processor-connector, and resource-reconciliation intent carries an immutable `dispatchNotAfter`, deadline-derivation version, and trusted-time source derived as the minimum of every applicable request/invocation, admission, authorization, same-key recovery, reconciliation, and orphan-horizon bound. The intent referenced by `RemoteDispatchAuthority` is the sole deadline authority. `mark_send_started` must copy those exact values, join current trusted-time evidence from that source, and succeeds only strictly before the deadline; a claimed or failed-over worker at or after it can only cancel before send.
- Every deadline-driven `cancel_before_send` references one signed `DispatchDeadlineReachedEvidence` with the same organization/workspace/request, intent, authority, current pre-cancellation transition head, deadline, deadline-derivation version, and trusted-time source as the dispatch chain. Its trusted observation is at or after the deadline. Provider, connector, and reconciliation paths share this record; a reconciliation attempt uses only its matching `dispatch_deadline_reached` terminal variant.
- Every normalized execution-decision or processor-invocation intent/state, admission, attempt-progress, dispatch intent, authority, transition, cancellation/deadline evidence, terminal outcome, and signed output relation in a provider, processor-connector, or resource-reconciliation chain uses composite `(organizationId, workspaceId, requestId, recordId)` identity and requires exact scope equality. A model-backed processor's terminal ref uses the separate child decision's tuple, whose request equals the invocation intent's `childRequestId`; it never substitutes the parent tuple. A globally unique-looking record ID is never sufficient to cross one of these joins.

The runtime should use more compact compiled structures than these evidence-oriented examples. The key boundary is that provider request bodies do not appear in shared routing types.

## Appendix C: Example Policy Semantics

Illustrative strictly validated documents keep each policy kind within its owned vocabulary:

```json
[
  {
    "id": "production-models-v1",
    "kind": "model_access",
    "schemaVersion": 1,
    "rules": [
      { "effect": "allow", "logicalModelTags": ["production-approved"] },
      { "effect": "deny", "modelLifecycle": ["preview", "retired"] }
    ]
  },
  {
    "id": "text-and-embedding-operations-v1",
    "kind": "operation_access",
    "schemaVersion": 1,
    "rules": [
      {
        "effect": "allow",
        "operations": ["text.generate", "embedding.create"],
        "interactionModes": ["unary", "stream"]
      }
    ]
  },
  {
    "id": "restricted-data-boundary-v1",
    "kind": "data_handling",
    "schemaVersion": 1,
    "rules": [
      {
        "effect": "deny",
        "dataClassifications": ["restricted"],
        "networkClasses": ["public_external"]
      }
    ]
  }
]
```

An access profile references these exact policy versions. A separately scoped principal or credential attachment gives them authority. The compiler composes their mandatory intersections, applies deny precedence, resolves tags/lifecycle/network selectors against the workspace revision, and emits concrete IDs plus simple predicates. No one document can smuggle operations, providers, or data conditions into `model_access`, and the data plane never evaluates an arbitrary expression language.

## Appendix D: API Wire, Translation, Provider, and Client Checklist

Every new contract or adapter should answer the relevant questions below.

### Operation-definition checks

- What is the stable operation ID/version and is its resolution mode `workspace_catalog`, `logical_model`, `state_binding`, or `workspace_resource`?
- Which code-owned capability-requirement manifest applies; does the workspace capability set contain exactly this operation once; and do signed readiness receipts satisfy every required capability before discovery, grants, routes, profiles, generated clients, or runtime may expose it?
- Which state actions, creation barrier, idempotency, retry, commitment, cancellation, cache, guardrail, and lifecycle semantics apply?
- Is billing `request_terminal` or `resource_terminal`; does every billable request target/connector carry canonical provider/accounting valuation independent of budgets; does preflight expand each applicable rule into one exact slice per intersecting finite period or contract attribution and prove the complete-or-empty slice set? For resource-terminal work, does every target carry one immutable relative plan; does each actual attempt create its own lifecycle start/quote/initial epoch/prepared exposure before I/O; and does exactly one active/orphan obligation inherit that exposure while definitive nonacceptance aborts only it?
- Can a logical-model request carry an authorized aggregate hard-state binding set and switch to exact-target execution before cache/classification while preserving origin-model equality?
- Does every state/resource action resolve and authorize all references before decrypting upstream IDs, reject incompatible targets/lineages, and defer migration/materialization to a separate future resolution contract?
- For a session, which inbound/outbound event actions, ordering, replay, incremental policy, limits, budgets, and state transitions are registered?
- Which API-wire definitions expose this exact version, and which conformance fixtures certify each binding?
- Can every non-model operation complete without fabricating a logical-model route?

### API wire definition and codec

- What is the stable wire ID and how is its contract version resolved?
- Which method/path/header combinations belong to it?
- Which operations and interaction modes are exposed, and which network/framing contract does the wire own?
- What are the request, response, error, streaming, state, and ID semantics?
- Which SDK versions are covered by the contract?
- Which fields, headers, content/tool types, and events are standard, registered extensions, safe opaque responses, or rejected unknowns?
- Which operations expose caller idempotency tokens, which code-owned namespace/normalization/pending-collision/replay-artifact rules apply, and is any cross-wire namespace sharing explicitly certified?
- Which absolute header/body/decompression/multipart/frame/deadline limits apply before buffering, and how are incremental parsing and backpressure tested?
- Which listener/source/TLS/request-rate/auth-candidate limits apply before authentication, and which depth/node/property/string/array limits bound structural validation afterward?
- Does the exact wire/version register a caller idempotency token, and what scope, retention, replay, and completed-result-unavailable behavior does it promise?
- Is model discovery a separate operation/wire, and what authorized union does it return?
- Which gateway-generated errors and discovery responses does the ingress codec render?

### Translation-adapter checks

- What exact source wire, target wire, contract versions, and operation does it implement?
- Which interaction modes are certified?
- Which request fields, content blocks, tools, state references, errors, and usage fields map exactly?
- Which feature combinations are lossy or unsupported?
- How are streaming state, partial tool arguments, cancellation, and commitment handled?
- Does it require an operation-specific intermediate representation?
- Which fixtures, live canaries, and feature profile certify it?
- What breaks certification when either wire codec changes?

### Provider adapter and connection

### Connection

- Which base URLs, regions, projects, subscriptions, and API versions are valid?
- What egress/network constraints apply?
- Which versioned auth contracts are supported, and does each name one code-owned adapter mechanism plus required upstream account/scope verification?
- How is a connection tested without exposing prompt data?
- Does the connection remain a stable account/project/network identity with no inline secret or key-selection behavior?

### Credential slot and set generation

- Which code-owned auth types and upstream scopes are supported for this connection?
- Does each static slot pin an exact immutable secret-manager version plus expected provider account/scope, and each workload slot pin issuer/audience/subject/role plus versioned trust/permission contract?
- Which exact slot versions and bounded ordered/weighted/quota-aware selection policy form the immutable set version?
- Does one signed provider-credential-directory generation map each ordinary connection/auth contract to exactly one active set, retain admitted request generations through terminal cleanup, and cover every stable provisional-creator/state/reconciliation requirement through separate high-waters with a currently certified successor entry or exact historical slot?
- Before a state/outcome-creating dispatch, does linearizable registration serialize with directory activation and the complete traffic-gate directory-admission set, proving every still-admissible generation covers the requirement or its gate is fenced, and does handle release persist/recheck the lease's minimum compatible generation?
- Does every retained attempt persist exactly one authoritative common-slot selection from the intersection authorized by all referenced leases, bind it to the complete lease-set digest/evidence high-water, and persist separate exact entry, requirement, lease, current successor certification, normal/incident mode, observed external identity/version, and membership-or-equality proof for every binding without copying the selected slot into evidence rows?
- Can retry choose another slot only through a newly registered attempt after definitive non-acceptance, atomically aborting/recreating the prepared exposure and target-specific outcome lease, requirement registration, and all-admissible-gate coverage receipt?
- How do A-to-B-to-C rotation without lease mutation, full compromise disablement versus exact-lease incident-reconciliation-only narrowing, exact-auth-source slot selection versus namespace-originating-slot selection, per-slot health/quota, active-call cancellation, and inaccessible retained state behave?

### Discovery and catalog

- Can models/deployments be discovered?
- Which facts are provider-reported versus curated?
- How are lifecycle and regional availability represented?
- How are prices sourced and versioned?

### Deployment wire bindings

- Which operation/API-wire/interaction-mode tuples are native?
- Which exact required auth-contract version does each wire binding carry, and does publication reject a missing, ambiguous, incompatible, or over-privileged contract before routing?
- Which request fields and content blocks are supported?
- Which model-maker semantic options, semantic/billing target-wire hosting extensions, and physical provider controls exist, and which codec or adapter schema/certification owns each without overlap?
- Is production egress guaranteed to use an immutable callable release ID, with mutable aliases confined to discovery?
- What stateful resources create affinity?
- Which absolute upstream header/body/compression/idle/duration/throughput bounds does raw transport enforce before codec parsing, and which semantic frame/event/output-unit/schema bounds does the target codec enforce incrementally afterward?

### Runtime

- How are URLs and headers built safely?
- Does the provider adapter stop at physical endpoint/region/project/API-version paths, connectivity, authentication, network controls, non-semantic headers, raw bounded transport, and typed transport observations with implicit retries disabled, leaving every semantic or billing-affecting field, safety/service-tier schema and serialization, error/usage schema, and framing to the target wire release/codec and retry/fallback decisions to the shared attempt orchestrator?
- Which code-owned auth-presentation profiles are allowed, including constant-time normalization of Claude Code's equal bearer/`x-api-key` pair, and how are every other duplicate/conflict plus all ingress auth/provider-selection headers rejected or stripped?
- How is cancellation propagated?
- Which failures are retryable, fatal, scoped, or quota-related?
- How are `Retry-After` and provider request IDs extracted?
- How are stream events validated and unknown events handled?
- Does an unknown response fail only the request and open at most a bounded exact-binding runtime quarantine, leaving certification mutation to signed control-plane/narrowing authority?
- How is usage parsed and assigned a trust level?
- Which cache signals and costs exist?
- How does each same-target retry or different-target fallback consume the current open attempt-progress epoch; terminalize the prior definitive attempt outcome/lease/exposure/registrations; retain or settle its allocation until chargeability is known; freshly evaluate health/circuit/capacity/concurrency/quota/narrowing and credential eligibility/quota; cumulatively admit the retry's incremental maximum; create a new budget admission, dispatch intent/claim authority, and attempt exposure; then reserialize and reauthenticate? Does only a different target append a selected-execution successor while atomically closing the predecessor progress and linking its final attempt?
- After early existing-idempotency lookup, does a fresh claim first own only `claimed_unresolved` provenance with dispatch disabled; do operation resolution, immutable external-request header, and complete `dispatch_ready` provenance commit atomically before quotes or remote children; does initialization recovery terminalize without dispatch; is a model-backed-processor header created from exact input-bound pre-work intent; does one initial plus same-decision CAS readmission chain own sealed normalized candidate evaluations bound to the exact effective resolution/input ref; and does exactly one idempotency/catalog/logical-route/exact-state/workspace-resource/processor-model terminal outcome close it?
- Does every selection consume one same-decision `ExecutionSelectionAdmission` binding eligible chosen-branch target, current feasibility, canonical cost, sealed slice-complete `BudgetQuoteSet`, current envelope snapshot, and processor authorization when applicable? Does the initial transaction create one open attempt-progress root plus a fresh consumptive `ProviderAttemptAdmission`, active child, budget admission, payload intent, and ready dispatch authority; does every same-target retry consume/install one fresh head without reusing selection feasibility; and do retry/fallback/terminalization serialize on that progress? For provider-selected outcomes, does the final selected ID equal the decision progress pointer while its attempt progress closes as terminal and both chains derive through foreign keys, with local/denial/idempotency outcomes carrying none?

### Provider operations and security

- What health probes are safe and meaningful?
- What metrics have bounded labels?
- Which error fields must be redacted?
- What live canary validates the deployment?
- Which data-handling assertions have contractual provenance?
- What is the adapter's compatibility and deprecation policy?

### Resource-profile checks

- Which exact workspace profile version binds the registered operation/resource kind/purpose to its bounded create target set?
- Does every resource target carry one exact required auth-contract version certified for its endpoint actions/account/scope, with no inference from provider type or endpoint path?
- Which `resource_access`, data, retention, size, billing lifecycle, discriminated firm-horizon or operational-rolling cost plan, price/FX, state-mapping, and certification requirements enter its preflight manifest?
- Can the caller influence only registered wire fields, never a provider endpoint, connection, deployment, or arbitrary profile ID?
- Which later logical-model/deployment uses are compatible, and does every incompatible or cross-target use require a separately certified materialization/migration operation?
- Does creation claim durable idempotency and a structurally valid pending binding with internal/public/idempotency identity, exact resource profile/data/lifecycle/retention authority, selected-execution ID, and cost ownership; move ambiguous work to `reconciling`; and activate non-null upstream/state-lease plus matching obligation ownership before ID release, with resource-lifecycle cleanup-retained and terminal tombstones remaining distinct and request-state ambiguity staying reconciling until atomic activation or terminal cleanup?

### Processor-profile and connector checks

- Is the exact immutable profile version in the workspace revision, and which code-component hashes implement it?
- Does a signed `ProcessorInputRef` prove exact minimized/redacted bytes, schema, digest, data/residency class, artifact, and transformation epoch before immutable invocation intent, candidate, child, quote, connector admission, or remote work; does the intent carry the complete parent `processor.invoke` decision, exact plan, child envelope, and limits; does runtime produce a current input/profile/service-principal/target `processor.execute` decision rather than trusting compiler output; can pending/denied states exist without fake selected or reservation IDs; does every model or connector attempt bind quote, fresh admission, dispatch intent/ledger, and retry to the same input; does the connector chain have one initial admission plus same-invocation successors serialized by one attempt-progress CAS; and does each completed outcome consume the final head and own an exact signed `ProcessorOutputRef`?
- Is the profile a discriminated in-process component, model-backed non-recursive plan whose actual target is an exact deployment-wire binding, or connector-backed exact connector version, with no nullable generic target or arbitrary HTTP path?
- Which parent data, residency, provider class, capture, deadline, cancellation, revocation, and cumulative-budget constraints are inherited?
- Which typed schemas, minimization/redaction behavior, retry/error outcome envelope, invocation mode/cardinality, transformation expansion/effects, rate/cost ceiling, fixtures, and expiry certify it?
- Which invoking route, guardrail policy, or operation stage owns the terminal action for every certified outcome, and does publication reject an incompatible action?
- Does route preflight include this mandatory processor's grants, target certification/provider/data class, hard invocation cardinality, and total maximum exposure before any classifier runs?
- For a request transformation, does certification prove monotonic/non-expanding reuse or force full feature/state/data/size re-extraction, resolver/policy/preflight readmission, and atomic envelope enlargement; and does the successor resolution relationally bind the exact processor invocation, terminal outcome, signed output ref/artifact/digest, codec-validation evidence, and fresh policy bundle?

### SDK compatibility profile

- Which exact SDK versions, methods, base-URL shape, authentication presentation, ingress wire, and session-key source (`state_id`, registered token/header, or `none`) are supported?
- Which discovery, inference, streaming, cancellation, error, state, and unknown-extension fixtures establish compatibility?
- Which wire or SDK release change invalidates the profile?

### Harness configurator and onboarding profile

- Which exact harness versions are supported?
- Which ingress wire, base-URL shape, auth convention, and model setting do they use?
- Can the harness expose a certified stable session token; if not, does the profile correctly promise no cross-request soft affinity?
- Which local files or environment variables may the setup flow own?
- Can setup preview, apply atomically, rerun idempotently, and remove only its own changes?
- How is the gateway credential referenced without writing provider secrets?
- How is a newly issued gateway key handed to the local client exactly once without stdout, logs, command arguments, or server-side plaintext recovery?
- Does the issuance template contain only one exact active access-profile version, optional narrowing-policy references, and issuance constraints, and does the issued credential persist the profile's expanded credential-scoped attachments rather than later rereading profile contents?
- Does the onboarding profile name a synthetic principal context for preview while issuance proves the real subject fingerprint?
- Which real-client probe verifies discovery, inference, streaming, cancellation, and errors?
- How does an onboarding profile select defaults without becoming an authorization mechanism?

### Publication, policy, state, and cache

- Does every production operation, wire, interaction mode, logical model, terminal provider/deployment, extension, state action, and processor invocation require the correct positive grant?
- Are classifier and remote guardrail calls admitted child requests with inherited data, canonical remote cost, period/contract-sliced budget vectors, capture, cancellation, and recursion constraints, and is every applicable authority/scope/currency/period ceiling bound before the first child?
- Before commit, does every candidate member of each independent production/regional/canary ring ACK the exact resource/component manifest with NACKers excluded, and after commit can a ring-keyed successor epoch fence/replace a failed member on the same tuple without lowering authority generations?
- Does trusted ingress stamp exact ring/tuple/membership internally, route only to an exactly matching active member, use narrowing before routine removals, delay broadened grants until all traffic-receiving rings/gates ACK or are fenced, retain historical execution authorities after ring removal, and reserve quiescence for explicit barrier cutovers that prevent new old-tuple admission?
- Does discovery and admission deny a routed model before classification whenever the current effective-policy/request filters empty any reachable branch?
- Does preflight also deny before classification when a mandatory processor grant/target is missing or the child-plus-least-first-terminal exposure floor cannot be held?
- Is every state ID gateway-owned, principal-authorized per action and origin model/release/target, encrypted at rest, affinity-bound, and deleted by policy?
- When several state IDs are present, does resolution require a nonempty set, retain every member's binding ID, reference role, requested action, authorization decision, constraint, and lease evidence before computing separate target/lineage and physical-credential-slot intersections, with mixed nonportable or disjoint-origin bindings rejected before upstream-ID decryption?
- Does every model-less provider-resource create resolve through one code-owned wire/operation/kind/purpose/discriminator/effective-policy-class key to exactly one authorized immutable workspace resource profile, rejecting overlapping mappings rather than applying profile priority?
- Does the binding schema reject impossible field combinations across unprepared/prepared pending, request-state versus resource reconciling, direct versus recovered active, resource-only cleanup-retained tombstone, ordinary terminal tombstone, and definitive-nonacceptance aborted terminal tombstone states; do request-state/resource orphan cleanup and idempotency GC use closed unions; and is active non-null mapping/state-lease plus relationally matched request-state-orphan or prepared-to-active/resource-orphan ownership durable before any corresponding response byte or terminal request outcome becomes visible?
- For every request-terminal operation that can create state, does the exact capability manifest require `request_state_orphan_recovery`, and does its readiness receipt prove current same-key/shared-result plus terminal absence/provider-expiry contracts? Does the initial send bind the exact certification/hash, key/payload/target, trusted time, and original dispatch into one immutable key binding whose `recoveryNotAfter` is the code-derived minimum of the original request deadline, certified retention end, certification expiry, and policy cap? Does ambiguity transfer that binding/deadline, the complete outcome/lease set, binding/idempotency, creator/credential registrations, and one non-extendable control to a request-state orphan with no continuing liability or resource lifecycle authority? Are request-state and resource-lifecycle lease owners/fields structurally disjoint? Do authorization, admission, and send-start each reject the boundary at or after that deadline, including delayed/failover workers? Do recovery and cleanup consume the same epoch; does recovery use fresh attempt/lease authority; and do success or certified cleanup atomically close every owner and activate or tombstone the original binding before release while deadline exhaustion alone leaves the indeterminate fence open?
- Does an ACKed monotonic state-retention generation group exact canonical state/reconciliation target/profile/component classes behind partition high-waters, live counts, and lease/credential digests, keep per-resource selected IDs and authorization in indexed leases, and remain size-independent of live-resource count?
- Does the sole provider-credential directory cover provisional creators plus both lease high-waters, keep immutable origin requirements separate from generation-specific successor evidence, serialize late registration with rotation, and otherwise retain the exact slot outside ordinary selection without embedding a second credential authority in workspace or retention generations?
- Do retained continuations create only direct descendant bindings with inherited origin/owner/share/data/target and bounded leases, never new roots?
- Does a rollback-independent `StateTargetRetirement` state machine serialize root and descendant registration against a target-scoped creator registry, reject late creators from older admitted generations, seal/drain every still-target-affectable root across current and historical authorities through creator/registration/fact/snapshot high-waters, require a completed absorption proof before lease snapshot publication, retain lifecycle access until both lease indexes drain, represent pre-release cancellation as a higher signed epoch, and make `released` irreversible?
- Is hard state resolved before classifiers/cache, and does the live narrowing overlay override pinned revisions before every dispatch/release and abort applicable active work?
- Does every billable request/connector/reconciliation/resource valuation retain separate provider-charge/accounting amounts plus exact FX/rounding provenance independently of budget coverage? Before period slicing, does each cost subject/rule/authority/scope/target currency own one shared signed actual-source contract and exact code-owned mapping ID/version/implementation hash, with every eligible slice conversion and selected-source-only settlement authority referencing it? At runtime, does signed mapping evidence bind that contract, canonical source, exact target/valuation, usage or invoice lineage, correction lineage, component/currency/amount, and owner? Is one source selection unique independently of reservation for the entire eligible slice set, so concurrent provider/accounting selections or different monthly reservations cannot double debit one canonical source; does one attribution partition the selected parent exactly once across all eligible reservations? Are FX exposure bounds explicit and firm-compatible? Does every initial envelope preserve its preflight compiler plan and every runtime successor preserve a signed code-derived readmission plan? Does a maximum lease one logical branch across same-target retries while each attempt owns a fresh subordinate allocation; can no-charge A retry A without removing its input; and do partial/full/indeterminate retained charges require exact evidence-bound `sum(retained_charge, max(A_retry, remaining))` readmission? Does fallback dispose the logical lease and either reopen siblings or readmit retained charge, with retry/fallback/terminal paths racing on the same progress/allocation/lease/ledger/derivation/snapshot epochs? Is every quote set complete per period/contract or signed empty, every attempt admission all-or-none and fresh, and every settlement bound to its unique selection/evidence/attribution component and matching authority entry?
- Does every intent have one linearizable one-invocation dispatch authority whose projection equals one immutable transition-chain head, preventing two sends and permitting claim reuse only before `send_started`? After send-start, does request-terminal retry require exact certification, durable recovery authorization, fresh attempt authority, and cumulative headroom? Does resource create retain its original exposure and permit only one orphan-control-fenced read-only reconciliation chain, with fresh target/credential/runtime/cost/budget/intent/dispatch authority per poll and never another create? Does its bound carry absolute horizon, cumulative ceiling/count, and authorization-chain high-waters across successor authorizations; can only an approved extension with a strict count-only, horizon-only, or combined delta plus exact marginal funding increase it? Do dispatched attempts close only with codec, definitive-not-sent, sent-indeterminate, or cancellation evidence, while count/time exhaustion independently consumes the active progress/control epochs over the last completed head without creating an attempt? Can zero-dispatch expiry close a pending ready/claimed attempt before the control transition; do next admission, exhaustion, cleanup, absence, and activation have one winner? Does cleanup retain the exact chain in `closing_cleanup` and require disposition-specific execution/cost/budget evidence before closure? Does failover prove all progress, valuation/attribution, allocation, recovery-bound, transition, settlement, and reservation high-waters?
- Does every operational limit either fail closed or consume preallocated, fenced, non-renewable capacity whose expiry and frozen membership prove a finite fleet-wide outage overshoot?
- For resource-terminal work, does each provider attempt own a prepared exposure with attempt/runtime admission, budget admission, dispatch intent, lifecycle start, quote, and initial epoch before I/O; does definitive nonacceptance abort only it while settling any chargeable request component and releasing only proven-unused slices; and does success/ambiguity transfer exactly that exposure to one binding-owned/orphan obligation plus initial recovery bound in the V1 transaction? Can only one recovery authorization/progress own the orphan's active recovery-control epoch; do absence, exhaustion, and non-cleanup pre-dispatch cancellation advance it to one available successor without resetting cumulative count/horizon/authorization chain; do successor allocations stay within remaining capacity; and do stale admissions fail? Does cleanup from active retain the chain in `closing_cleanup`, close ready/claimed dispatch, close an already definitive-not-sent attempt with exact no-charge evidence, or reconcile sent cost and budget, terminalize progress as cleanup-superseded, and only then close? When a terminal reconciliation progress head carries a target-codec identity proof for the original upstream resource, does one fenced transfer bind that exact authorization/admission/intent/outcome/observation and active control epoch, freeze exactly that orphan, close its control, install one active successor over the same exposure, atomically move both leases and the binding, preserve recovery-bound high-waters, and preclude concurrent current owners?
- Does each active/orphan obligation inherit one attempt exposure, retain dual-currency canonical liability/settlement with zero budgets, retain cumulative lineage for every historical/current period/contract slice, and persist subtype-correct lifecycle terms? Does one append-only liability-component chain retain each valuation epoch and invoice adjustment's own provider/accounting amounts and conversion while deriving totals by currency rather than assigning one FX conversion to an aggregate? Does an orphan-to-active successor begin at exactly matching valuation, liability-component, lifecycle-funding, slice-transition, provider-settlement, budget-settlement, and invoice-adjustment high-waters while the predecessor accepts no later appends? Can same-target retry never inherit an aborted exposure; does each operational chain have one attempt-owned null-root epoch followed only by obligation-owned continuations with fresh lifecycle quote/admission/lifecycle-sourced reservations and explicit previous/current slice transitions; and can `settled` exist only with terminal evidence, released lease, and complete provider-usage, liability-component, lifecycle-funding, slice-transition, slice-settlement, and invoice high-waters?
- Is an open-ended contract cap admitted to a firm budget only under a lifetime/non-resetting authority or an approved contract that attributes the full cap to the admission period, never by silently omitting future finite windows?
- After authentication and caller-intent normalization but before normal resolution, does the runtime claim/load idempotency; does a new claim remain `claimed_unresolved`/dispatch-disabled until resolution/header/`dispatch_ready` commit; and does crash recovery terminalize without work? Does an existing request bind exact observed provenance, avoid routing/redispatch, and terminalize all closed outcomes? After wait, does it re-resolve/re-authorize terminal provenance; do fanout frames bind exact sequence/digest; and does completed-result-unavailable reference an allowed no-artifact terminal authorization rather than pending authority?
- Are replay expiry and deduplication retention separate, with pending/indeterminate records structurally limited to an open fence and terminal records limited to retained-or-GC-certified fences, while linked binding, request-state orphan, resource obligation, provider mapping, and reconciliation-retention leases plus HMAC keys remain until a signed terminal GC certificate proves every blocker and outcome horizon closed?
- Is a cache hit reauthorized against current credential, policy, deployment/connection/model lifecycle, certification, and output rules, with indexed revocation purge?
- Can the narrowing overlay represent every emergency access/data/parameter/capture/guardrail tightening as atomic deltas, or install a deny-all scope switch when it cannot?
- Does each narrowing delta use one policy-kind-specific schema, one code-derived absorption authority, and one strict nonempty reduction against its exact pinned base, rejecting no-ops, wider values, unknown fields, and mixed authority vocabularies?
- Are all deltas workspace-anchored; does organization suspension retain an organization deny while an organization/platform-scoped exhaustive fence blocks every shareable resource for existing and post-snapshot tenants until resource/local absorption plus signed resume; and can a credential fence permit only named-principal, exact-lease incident reconciliation without ordinary/continuation escape?
- Are enforcement points, active-request behavior, absorption owner, limit/reservation fencing, indexed data/cache/replay/state actions, and the canonical bounded-DNF exact-dependency versus whole-workspace matcher derived from the code-owned contract, with explicit conjunction/disjunction semantics, per-clause completeness stages, size bounds, and signer-authored omissions or plan-hash mismatches rejected?
- Does revocation bootstrap admit exactly one null-predecessor workspace genesis with the code-defined empty overlay, then require its ready certificate and a certified initial freshness lease before serving? Is the semantic head-hash input explicitly versioned and free of its own output and transition/receipt/certificate/signature/proof fields? Does each quorum CAS atomically commit the transition, successor semantic head, and one unique workspace/transition-keyed consensus receipt, with the certificate an idempotent recoverable projection of that receipt? After a crash between consensus and materialization, can another worker produce the identical certificate while every successor and serving gate rejects the pending head? Are absent/duplicate genesis, head/receipt mismatch, prepared-only, transition/receipt-only, wrong/pending-certificate, stale-term, divergent-hash-version, self-hash, and backlink publications rejected at every admission and release gate?
- Is there exactly one complete hash chain per workspace including all subject-filtered deltas; are dependency facts append-only and snapshots one-initial/same-reference/nondecreasing-stage/CAS continuations; is every root structurally parentless with `rootReferenceId` equal to itself; is every child plus its `child_initial` snapshot atomically registered against the parent's then-current same-root/current-authority binding; and does each tombstone remain until its single authority, every durable-action high-water, the frozen union of current traffic rings plus historical live authorities (or proof both sets are empty), and each authority seal's registration/fact/snapshot vectors partition every hierarchy exactly once into an all-descendant provably-nonmatching restamp or matching/indeterminate terminal drain?
- Do input guardrails precede cache/processors/providers and output guardrails precede cache write and response release for every applicable operation?
- Does every bidirectional session event repeat action/data/parameter/guardrail/limit/budget/narrowing checks in both directions?
- Does every pending revocation receipt freeze the projected certificate ID, ID/hash derivation versions, projection component, hash and deterministic-signature algorithm versions, and signing-key version; do component/key retention and crash recovery survive rollout or rotation until one identical certificate atomically makes the head ready?
- Does every reconciliation lease name one signed retention class, with lease/class/index-proof discriminants and request recovery/closure contract versions exactly equal? Is request-state terminal absence an evidence-only target-codec classification of the original/same-key attempt, never hidden provider I/O, and does request-state ambiguity remain reconciling until direct active or terminal transition?
- Do provider, connector, and reconciliation intents each own the exact code-derived minimum `dispatchNotAfter`, deadline-derivation version, and trusted-time source, and must `mark_send_started` match all three rather than author them? Are initial/recovery connector and every reconciliation poll rejected at or after any request, admission, authorization, same-key retention, reconciliation, or orphan-horizon bound even after claim delay or worker failover? Does every deadline cancellation carry the canonical signed deadline-reached evidence bound to the exact scoped intent, authority, pre-cancellation head, deadline/version/time source, and at-or-after observation, with the reconciliation-specific terminal variant? Do composite organization/workspace/request foreign keys reject every cross-scope decision/invocation state, admission, progress, intent, authority, transition, evidence, outcome, and signed-output substitution? For model-backed processors, does the terminal outcome carry the exact child-request decision scope and reject the parent/sibling request tuple?
- Does the hard-cutover manifest account for every credential, state/provider resource, session, reservation, async job, and audit/outbox item before V3 deletion?

## Appendix E: Source Register

### Repository sources

- [Proxy README](../../README.md)
- [Shared schemas](../../packages/schema/src/index.ts)
- [Database schema](../../packages/db/src/schema.ts)
- [Proxy server routes](../../apps/proxy/src/server.ts)
- [Route execution plan](../../apps/proxy/src/routeExecutionPlan.ts)
- [Generic HTTP adapter](../../apps/proxy/src/providerAdapters/genericHttp.ts)
- [Translator registry](../../apps/proxy/src/translators/index.ts)
- [Provider architecture V1](../scopes/provider-architecture-v1/PLAN.md)
- [Harness model translation V1](../scopes/harness-model-translation-v1/PLAN.md)
- [Model access profiles V1](../scopes/model-access-profiles-v1/PLAN.md)
- [Router research recommendations](router-research-recommendations.md)
- [Existing LiteLLM review](litellm-scope.md)
- [Existing 9router review](9router-scope.md)
- [Existing Kong review](kong-scope.md)
- [Existing OmniRoute review](omniroute-scope.md)

### Requested open-source gateways

- [LiteLLM pinned source](https://github.com/BerriAI/litellm/tree/b200d664eec1c8917ebb80539a2666f596b9bfe3)
- [LiteLLM router](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/router.py)
- [LiteLLM proxy schema](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/schema.prisma)
- [LiteLLM call types](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/types/utils.py#L295-L325)
- [LiteLLM route-to-call-type mappings](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/types/utils.py#L833-L878)
- [LiteLLM model mode](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/types/utils.py#L254-L265)
- [LiteLLM Anthropic passthrough endpoint selection](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/llms/anthropic/experimental_pass_through/messages/handler.py#L48-L74)
- [LiteLLM Codex `wire_api` setting](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/proxy/client/cli/commands/agents.py#L76-L100)
- [LiteLLM supported endpoints](https://docs.litellm.ai/docs/supported_endpoints)
- [LiteLLM Anthropic-compatible endpoint](https://docs.litellm.ai/docs/anthropic_unified/)
- [LiteLLM Messages-to-Responses mapping](https://docs.litellm.ai/docs/anthropic_unified/messages_to_responses_mapping)
- [LiteLLM simple model configuration](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/proxy/example_config_yaml/simple_config.yaml)
- [LiteLLM load-balancer configuration](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/proxy/example_config_yaml/load_balancer.yaml)
- [LiteLLM database-backed model setting](https://github.com/BerriAI/litellm/blob/b200d664eec1c8917ebb80539a2666f596b9bfe3/litellm/proxy/_types.py#L2395-L2401)
- [New API pinned source](https://github.com/QuantumNous/new-api/tree/b6b97a66e39cfe45aab8cfb01ed96bba77cb279e)
- [New API channel model](https://github.com/QuantumNous/new-api/blob/b6b97a66e39cfe45aab8cfb01ed96bba77cb279e/model/channel.go)
- [New API relay modes](https://github.com/QuantumNous/new-api/blob/b6b97a66e39cfe45aab8cfb01ed96bba77cb279e/relay/constant/relay_mode.go)
- [9router pinned source](https://github.com/decolua/9router/tree/9845a1702f7766607bd7ac3315d1f87e59e45fb5)
- [OmniRoute pinned source](https://github.com/diegosouzapw/OmniRoute/tree/7ee5bbc64dbb03e967521227f2afffeb7c9dad1e)

### Hosted gateways and infrastructure

- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [Cloudflare dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
- [Cloudflare spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
- [Cloudflare response caching and cache keys](https://developers.cloudflare.com/ai-gateway/features/caching/)
- [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)
- [Vercel models and providers](https://vercel.com/docs/ai-gateway/models-and-providers)
- [Vercel provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)
- [Vercel model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks)
- [Vercel team provider allowlist](https://vercel.com/changelog/team-wide-provider-allowlist-on-ai-gateway)
- [Vercel zero-data-retention controls](https://vercel.com/changelog/zero-data-retention-no-prompt-training-on-ai-gateway)
- [Portkey gateway configs](https://portkey.ai/docs/product/ai-gateway/configs)
- [Portkey fallbacks](https://portkey.ai/docs/product/ai-gateway/fallbacks)
- [Portkey guardrails](https://portkey.ai/docs/product/guardrails)
- [Kong AI Gateway](https://developer.konghq.com/ai-gateway/)
- [Envoy AI Gateway architecture](https://aigateway.envoyproxy.io/docs/concepts/architecture/)
- [Envoy AI Gateway data plane](https://aigateway.envoyproxy.io/docs/concepts/architecture/data-plane/)
- [Envoy AI Gateway repository](https://github.com/envoyproxy/ai-gateway)
- [Envoy xDS protocol](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol.html)
- [Azure API Management GenAI gateway capabilities](https://learn.microsoft.com/en-us/azure/api-management/genai-gateway-capabilities)

### Protocol and catalog references

- [OpenAI Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [OpenAI Responses streaming reference](https://platform.openai.com/docs/api-reference/responses-streaming)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages)
- [Anthropic streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic Claude Code gateway configuration](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)
- [Amazon Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
- [Gemini API](https://ai.google.dev/gemini-api/docs)
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [Gemini integration trade-offs](https://ai.google.dev/gemini-api/docs/partner-integration)
- [OpenResponses](https://www.openresponses.org/)
- [models.dev](https://github.com/anomalyco/models.dev)

All external claims should be revalidated during implementation because provider and hosted-gateway behavior changes frequently.
