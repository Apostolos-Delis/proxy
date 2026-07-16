# AI Gateway Architecture

## Status

This document describes the implemented V1 gateway architecture. The detailed data-model rationale is in [AI Gateway Core Data Model V1](scopes/ai-gateway-core-model-v1/PLAN.md), and the declarative authoring contract is in [Gateway Configuration TOML V1](scopes/ai-gateway-core-model-v1/TOML.md).

Proxy is no longer a coding-tier router. Every supported application and harness uses the same provider-neutral resolution contract.

## Core Contract

```text
API key + ingress wire + operation + requested logical model
  -> authenticate and authorize
  -> find compatible enabled targets
  -> select one deployment
  -> persist resolution evidence
  -> translate when required
  -> invoke through the provider adapter
  -> normalize attempts, usage, cost, and errors
```

The central invariant is that callers request logical models, never provider connections or deployment IDs. Physical supply can change without changing application code or caller entitlements.

## Architecture Invariants

1. The database is the only runtime configuration source.
2. Every gateway resource is scoped by organization and workspace.
3. API keys authorize logical models through one access profile.
4. A grant names logical models and operations, never physical providers.
5. Provider behavior and wire translation are versioned executable code.
6. Configurable endpoints, credentials, models, and entitlements are database rows.
7. Unsupported wire conversions fail before provider I/O.
8. Resolution evidence is persisted before the selected provider is invoked.
9. Events, outbox rows, and matching current-state mutations share one transaction.
10. Raw prompt text appears only in `prompt_artifacts.raw_text`.

## System Boundaries

```text
Client SDK or harness
  -> Fastify transport boundary
  -> API-key identity and admission limits
  -> logical-model resolver
  -> provider-neutral decision
  -> ingress/egress wire adapter
  -> provider adapter
  -> upstream API

Admin GraphQL or gateway TOML
  -> validation and graph planning
  -> transactional gateway mutation service
  -> current-state tables + events + outbox
```

Fastify handlers authenticate, parse an ingress envelope, call services, and render the ingress wire's response or error structure. They do not own access policy, target selection, provider credentials, or persistence rules.

## Code-Owned Contracts

Executable contracts are intentionally closed sets in `@proxy/schema` and the proxy registries.

### API wires

| Wire ID | Traffic surface | Initial operations |
| --- | --- | --- |
| `openai-responses` | `/v1/responses` | `text.generate`, `model.list` |
| `openai-chat` | `/v1/chat/completions` | `text.generate`, `model.list` |
| `anthropic-messages` | `/v1/messages` | `text.generate`, `text.count_tokens`, `model.list` |
| `bedrock-converse` | provider egress only | `text.generate` |

Each ingress wire owns validation, stream framing, error rendering, and response shape. A caller receives errors in the same API family it used to enter the gateway.

### Provider adapters

V1 installs two adapter kinds:

- `generic-http-json` for OpenAI, Anthropic, and compatible HTTP endpoints;
- `aws-bedrock-converse` for AWS signing and Bedrock Converse invocation.

A provider connection chooses an installed adapter kind and contract version. New signing, streaming, or provider error behavior requires code and conformance tests. Operators cannot upload executable adapters through the database.

### Wire adapters

Wire adapters are directed, versioned conversions. The registry reports native, a specific translator contract, or unavailable. HTTP translation is allowed only when the request's features are representable. WebSocket traffic is native-wire only. Stateful Responses references, unsupported reasoning fields, and other lossy combinations fail during target eligibility checks.

### Operations and caps

V1 operations are `text.generate`, `text.count_tokens`, and local `model.list`. Grants can restrict operations and cap `max_tokens`, `max_output_tokens`, or `max_completion_tokens`. Unknown operation or cap IDs are rejected by the shared schema.

## Database Resource Graph

```text
api_keys
  -> access_profiles
       -> access_profile_model_grants
            -> logical_models
                 -> logical_model_targets
                      -> model_deployments
                           -> canonical_models
                           -> provider_connections
                           -> deployment_wire_bindings
```

### Provider connections

`provider_connections` is the endpoint and credential boundary. It contains adapter kind, auth style, base URL, region, safe default headers, adapter configuration, and either a secret reference or encrypted secret. API keys never bind directly to provider credentials.

Network policy is applied before a connection is persisted or invoked. Secrets are not returned by admin reads; only configuration state and safe hints are exposed.

### Canonical models

`canonical_models` describes model identity: vendor, family, release, lifecycle status, and published capabilities. It does not contain endpoint or credential details.

### Model deployments

`model_deployments` makes a canonical model callable through one provider connection. It owns the exact upstream model ID, region/configuration overrides, narrowed capabilities, and V1 pricing. Health is keyed by deployment, not by a caller-facing model string.

### Deployment wire bindings

`deployment_wire_bindings` declares the egress wires a deployment natively accepts. Each row owns endpoint path or provider operation, non-secret request configuration, and adapter contract version. Multiple bindings may point at the same deployment.

### Logical models

`logical_models` is the public model namespace exposed through SDKs and `/v1/models`.

- `direct` requires exactly one eligible enabled target and does not spend classifier tokens.
- `router` delegates selection to an installed router kind after eligibility filtering.

The only V1 router kind is `classifier`. Its typed configuration names a classifier deployment, instructions, timeout, and attempt count. The classifier receives only targets already allowed by the logical model and compatible with the request.

### Access profiles and grants

`access_profiles` is the reusable entitlement boundary. A profile can carry enforceable concurrent-request, requests-per-minute, and tokens-per-minute limits. `access_profile_model_grants` authorizes one logical model, a set of operations, and optional parameter caps.

An API key stores one `access_profile_id`. Changing a key's profile changes its visible models and authorization on the next request. Changing a logical model's physical targets does not require reissuing keys.

## Request Resolution

### Admission

The transport derives an ingress wire and operation, parses the requested `model`, authenticates the API key hash, and loads the key's organization, workspace, user attribution, and access profile. Missing, revoked, disabled, or unassigned keys fail closed.

### Authorization

The resolver loads the requested logical model within the same workspace and requires an enabled grant for that logical model and operation. Parameter caps are checked before classifier or provider work. `/v1/models` uses the same grants and therefore never advertises a model the key cannot request.

### Eligibility

The resolver loads enabled logical targets and retains only graph-complete candidates:

- logical model and target enabled;
- deployment and provider connection enabled;
- canonical model active;
- compatible native binding or installed wire adapter;
- deployment capabilities satisfy the request;
- health state permits selection.

A broken graph is a typed configuration denial. The resolver never falls back to an environment model, another workspace, or an ungranted logical model.

### Selection

A direct model requires one eligible target. A classifier model calls its configured classifier deployment with structured output and retry, validates the selected deployment against the eligible set, and records confidence and decision evidence. There is no deterministic classification fallback.

### Persistence before I/O

The request lifecycle persists:

- ingress wire and operation;
- requested logical-model slug and resolved ID;
- access-profile ID;
- router kind and router decision when present;
- selected deployment and provider connection;
- egress wire and translator or adapter version.

The route-decision row is retained as the generic resolution-decision record because it already anchors event, session, and console projections. It no longer contains a coding-tier result.

### Invocation and terminal state

The provider adapter receives a concrete connection, deployment, credential, egress body, and timeout. Provider attempts record deployment, connection, wire, adapter kind/version, upstream request ID, timings, terminal status, normalized usage, and safe error evidence. Request terminal state is written exactly once.

## Translation And Response Semantics

Ingress and egress protocols are separate dimensions. A request may enter as Anthropic Messages and resolve to an OpenAI Responses deployment only when the compatibility registry and translator implementation support every required request feature.

Native forwarding is preferred. Translation evidence includes source wire, target wire, translator ID/version, and whether the request was translated. Provider errors are classified once and rendered through the ingress wire's error envelope. The gateway does not leak raw provider response structures as its cross-provider contract.

Streaming translations preserve the ingress stream framing where implemented. WebSockets require a native `openai-responses` binding because stateful bidirectional translation is not implemented.

## Sessions, Usage, And Cost

`agent_sessions` remains the current session container for harness affinity and replay, but it stores no model tier. Session projections derive logical-model changes, logical-model mix, deployment mix, model mix, terminal outcomes, cache hit rate, token usage, and cost from request evidence.

Usage is grouped by logical model for caller intent and by deployment for physical supply. Provider usage is normalized into input, cached input, cache creation, output, reasoning, and total tokens. Pricing is read from the selected deployment. Ledger rows retain the cost computed at write time.

Classifier usage is a separate ledger kind and is attributable to the request and configured classifier deployment.

## Provider Health

Connection health answers whether credentials and the provider boundary can be used. Deployment health answers whether a specific upstream model can serve traffic. Cooldowns and lockouts are keyed by these physical IDs, not logical models.

The resolver excludes unavailable physical resources before selection. Success clears ordinary transient health state. Bedrock stream-permission lockout remains until a streaming success proves the permission path is restored.

## Events And Audit

Events are the audit and projection backbone. Current-state tables exist for constraints and efficient reads. Gateway administration uses `EventService` and the transactional mutation service; transport handlers do not append database rows directly.

Event payloads contain IDs, hashes, bounded decisions, timings, and safe metadata. They never contain provider secrets or full prompt text. The outbox supports asynchronous consumers without weakening the request transaction.

## Configuration Authoring

### GraphQL

Admin GraphQL provides scoped list/detail and create/update/enable/disable mutations for every gateway resource plus API-key access-profile assignment. Mutations validate the complete affected graph before committing.

### TOML

Gateway TOML is an authoring input, not a watched runtime file.

- `plan` validates and displays deterministic commands without writing.
- `apply` sends the same commands through the transactional mutation service.
- Resources are referenced by scoped slugs, not database IDs.
- Omitted resources are untouched.
- A repeated unchanged apply emits no commands or events.
- Raw secrets are rejected; provider credentials use origin-bound secret references.

There is intentionally no bidirectional file/database synchronization. Runtime reads the database only, so there is one source of truth and no conflict-resolution protocol.

## Admin And Console Boundaries

The console is an operational view over request evidence, usage, costs, caching, prompts, sessions, keys, users, and settings. API-key creation requires an access profile and derives the recommended harness model from its enabled grants.

V1 gateway resource authoring is exposed through GraphQL and TOML. A future console editor must call the same transactional service rather than introduce a second mutation path.

## Failure Rules

Proxy fails closed when:

- the key has no active access profile;
- the logical model or grant is absent or disabled;
- an operation or parameter exceeds the grant;
- a direct model has zero or multiple eligible targets;
- a classifier returns a deployment outside the eligible set;
- the selected graph crosses organization or workspace scope;
- no compatible wire binding or translator exists;
- the provider credential cannot be resolved safely;
- required resolution evidence cannot be persisted.

There are no compatibility aliases, legacy configuration reads, or silent target substitutions.

## Deferred Work

The V1 model deliberately defers route DAGs, additional router kinds, semantic response caching, embeddings and multimodal operations, generalized non-agent sessions, team policy inheritance, firm budgets, pricing schedules, distributed configuration publication, and arbitrary runtime-loaded adapters. Add these only behind the same logical-model, access-profile, wire, and deployment boundaries.
