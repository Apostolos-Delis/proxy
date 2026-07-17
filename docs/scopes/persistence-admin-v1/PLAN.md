# Persistence And Admin Console V1

- **Status:** Current after the AI gateway hard cutover
- **Scope:** Durable gateway configuration, request evidence, usage, events, and the internal operations console
- **Gateway model:** [AI Gateway Core Data Model V1](../ai-gateway-core-model-v1/PLAN.md)
- **Operator workflow:** [Gateway control-plane runbook](../../runbooks/gateway-control-plane.md)

## Goal

Persist the gateway's configuration and request lifecycle in Postgres while keeping provider behavior and API-wire adapters in code. Operators can author the same normalized resources through GraphQL or a declarative TOML import. The database is the only runtime source of truth.

This document describes the post-cutover system. The removed routing-config, provider-account, provider-registry, and model-catalog APIs are not compatibility surfaces.

## Repository Boundaries

```text
apps/proxy/        Fastify gateway, GraphQL control plane, runtime services
apps/web/          TanStack operations console
packages/db/       Drizzle schema, SQL migrations, database helpers and seeds
packages/schema/   code-owned IDs, validation schemas, shared types
docs/              architecture, operator runbooks, and scope history
```

Transport handlers authenticate, parse an ingress envelope, and delegate. Model authorization and selection live in the gateway runtime. Provider-specific request, response, streaming, retry, and signing behavior stays behind provider adapters.

## Ownership And Scope

Organizations own workspaces. Identity and membership are organization-scoped; traffic configuration and request data are workspace-scoped.

- Organization-scoped: users, memberships, invitations, organization settings, user settings, and admin sessions.
- Workspace-scoped: API keys, provider connections, canonical models, deployments, wire bindings, logical models, targets, access profiles, grants, sessions, requests, decisions, attempts, usage, prompts, and compression evidence.
- Events always carry `organization_id`; traffic and workspace-resource events also carry `workspace_id`.
- Every organization has a deterministic default workspace from `defaultWorkspaceId()`.
- Runtime identity comes from the API key's organization, workspace, user, and access profile. Harness identity headers are context only.

Scoped foreign keys include the organization and workspace columns. A globally valid ID cannot be substituted across tenants or workspaces.

## Durable Tables

### Identity And Administration

```text
organizations
workspaces
users
organization_members
invitations
user_sessions
api_keys
organization_settings
user_settings
```

API keys store only `key_hash`; the plaintext secret is returned once at creation. Each active key points to one workspace access profile. Revocation and expiration are enforced during identity resolution.

### Gateway Configuration

```text
provider_connections
canonical_models
model_deployments
deployment_wire_bindings
logical_models
logical_model_targets
access_profiles
access_profile_model_grants
```

The normalized ownership model is:

```text
API key -> access profile -> logical-model grant
logical model -> eligible deployment targets
deployment -> canonical model + provider connection + native wire bindings
```

- `provider_connections` own an operator-facing connection identity, a stable provider behavior ID, endpoint configuration, adapter kind, and credential reference or encrypted credential material.
- `canonical_models` identify model families and releases independently of a provider endpoint.
- `model_deployments` identify one callable upstream model through one connection. Capabilities narrow canonical capabilities; pricing is a complete per-million-token rate object or absent.
- `deployment_wire_bindings` map a deployment to a code-owned API wire, endpoint path or operation, adapter contract version, and non-secret request configuration.
- `logical_models` expose stable caller-facing slugs. V1 supports `direct` and classifier-backed `router` resolution.
- `logical_model_targets` define the only deployments a logical model may select.
- `access_profiles` carry reusable entitlements and coarse traffic limits.
- `access_profile_model_grants` authorize logical-model and operation pairs with optional parameter caps.

Code owns provider adapter kinds, provider behavior semantics, API-wire IDs, operation IDs, and wire-adapter implementations. Database rows select installed behavior; they do not define executable adapters.

### Health And Runtime Evidence

```text
provider_connection_health
deployment_health
agent_sessions
turns
requests
route_decisions
provider_attempts
usage_ledger
```

The retained `agent_sessions` name is historical storage terminology, not a routing requirement. HTTP and WebSocket traffic use the same gateway request lifecycle and terminal projector.

Each request can record:

- ingress wire and operation;
- requested and resolved logical model;
- access profile and authorization outcome;
- router kind and classifier decision evidence;
- selected deployment and provider connection;
- egress wire and wire-adapter version.

Each provider attempt records the exact deployment, connection, egress wire, adapter contract, outcome, usage, and cost. Health projection consumes classified terminal events. Provider connection failures and deployment/model failures remain separate so one bad model does not disable an otherwise healthy connection.

### Prompt And Compression Evidence

```text
prompt_artifacts
compression_receipts
prompt_access_audit
```

Raw prompt or assistant text is stored only in `prompt_artifacts.raw_text`, subject to the configured capture mode and retention policy. Events contain hashes, sizes, resource IDs, bounded classifications, and other non-prompt evidence. They must not contain full prompts, tool arguments, provider response bodies, or secrets.

Prompt artifact access is audited. Compression receipts retain hashes and measurements, with references to separately governed artifacts when original or compressed text is stored.

### Event Backbone

```text
events
event_outbox
projection_cursors
```

Events are the audit and projection backbone; current-state tables exist for constraints and efficient reads. A persisted mutation writes its event, outbox row, and matching current-state change in one database transaction.

`EventService` is the only application append path. Transport handlers and control-plane resolvers do not insert event rows directly.

## Request Lifecycle

```text
authenticate key
  -> claim idempotency key
  -> enforce request traffic limits
  -> append request admission evidence
  -> resolve request policy
  -> authorize and resolve logical model
  -> persist routing decision
  -> materialize provider connection and credential
  -> start provider attempt transactionally
  -> enforce provider/model traffic limit
  -> forward through provider adapter
  -> append terminal, health, usage, and cost evidence
```

Correctness-critical writes are synchronous. If admission, resolution, provider-attempt start, or terminal persistence fails, the request fails closed or is reconciled through its explicit terminal path.

Prompt capture, classifier telemetry, compression measurements, and other non-critical observability can use the bounded event writer. Queue overflow or exhausted retries are logged and counted without changing bytes already returned by the provider. `/_debug/event-writer` exposes queue depth, bytes, drops, failures, latency, age, and drain state when debug endpoints are enabled.

HTTP and WebSocket transports share `GatewayRequestLifecycle` for preparation, attempt start, and terminal persistence. Ingress wires own validation and error rendering, so an OpenAI caller receives OpenAI-shaped errors and an Anthropic caller receives Anthropic-shaped errors even when the selected provider speaks another wire.

## Control Plane

### GraphQL

`POST /admin/graphql` exposes organization/workspace-scoped queries and mutations for:

- provider connections;
- canonical models;
- model deployments and deployment pricing;
- deployment wire bindings;
- logical models and targets;
- access profiles and model grants;
- API-key access-profile assignment;
- connection and deployment health reset;
- API keys, members, invitations, settings, requests, prompts, usage, and analytics.

Gateway resource mutations use the shared transactional admin service. Secret input is write-only. Query payloads expose a reference or configured state, never plaintext credential material.

### Declarative TOML

The TOML shape is defined in [TOML.md](../ai-gateway-core-model-v1/TOML.md). Operators use:

```bash
pnpm --filter @proxy/proxy gateway-config plan ./gateway.toml
pnpm --filter @proxy/proxy gateway-config apply ./gateway.toml --actor-user-id user_123
```

`plan` validates the complete document, scoped references, provider semantics, endpoints, capabilities, pricing, direct-model cardinality, and secret-reference support without mutation. `apply` executes the same transactional mutation plan as GraphQL. Database constraints and the transaction prevent partial or internally inconsistent state; versioned optimistic publication is deferred beyond V1.

TOML is an import format, not a second runtime store. There is no bidirectional file/database synchronization, filesystem watcher, or precedence merge. After apply succeeds, runtime reads only Postgres.

## Operations Console

The web app is a dense internal operations console. Current routes cover:

```text
/                         overview
/usage                    token and model usage
/cost                     spend and attribution
/caching                  prompt-cache analytics by model, API key, and miss cause
/logs                     request/session stream
/logs/:artifactId         request detail
/prompts                   governed prompt artifacts
/prompts/:artifactId       prompt detail and evidence
/sessions/:sessionId       session detail
/api-keys                  API keys and access profiles
/api-keys/new              key creation and harness setup
/users                     members and invitations
/billing                   deployment pricing
/settings                  runtime and capture settings
```

The normalized gateway CRUD API exists in GraphQL and TOML. A complete browser editor for every gateway resource is intentionally separate UI work; the console must not recreate the removed routing-config or provider-account model.

The Logs session list keeps caller intent and physical supply distinct: the logical-model column shows the requested public slug, while the model column shows the selected upstream model. Internal logical-model IDs remain resolution evidence rather than list-view labels.

## Security Rules

- API keys are hashed and never recoverable.
- Provider credentials are secret references or encrypted material, never plaintext rows or event payloads.
- Non-secret headers are validated separately from authorization material.
- Raw prompts are confined to `prompt_artifacts.raw_text`.
- Provider error persistence is bounded and structured; arbitrary upstream bodies and WebSocket events are not durable metadata.
- Tenant and workspace scope are enforced in SQL constraints and service queries.
- Admin authorization is checked before query or mutation execution.

## Migrations And Cutover

Migrations `0027` through `0031` establish the physical resources, logical/access resources, resolution evidence, runtime materialization, and final removal of the coding-tier schema.

The cutover is complete:

- there is no `routing_configs` runtime;
- there are no provider-account or API-key/provider-account bindings;
- there is no mixed `model_catalog` identity/deployment row;
- API keys select access profiles, not routing configs;
- all supported text traffic resolves a logical model before provider I/O.

Historical nullable evidence remains valid for rows created before the migrations. New gateway requests write the complete gateway evidence group.

## Current Limits

- Postgres is required for the normalized gateway runtime and control plane.
- Configuration publication is immediate after a successful transaction; immutable snapshot activation is deferred.
- V1 routing supports direct selection and the structured-output classifier only.
- Pricing is deployment-local and does not yet model contracts or effective-date schedules.
- Generalized non-agent session affinity and modalities beyond the existing text paths are deferred.
