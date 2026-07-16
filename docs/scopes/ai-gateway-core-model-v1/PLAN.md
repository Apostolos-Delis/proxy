# AI Gateway Core Data Model V1

- **Status:** Implemented V1 architecture
- **Scope:** Replace the coding-tier product model with the minimum general AI gateway model
- **Research basis:** [Enterprise AI gateway strategy and target architecture](../../research/enterprise-ai-gateway-analysis.md)

## Goal

Make Proxy resolve every supported request through one provider-neutral contract:

```text
gateway credential + ingress wire + operation + requested logical model
  -> authorize the logical model
  -> select an eligible model deployment
  -> choose a compatible egress wire
  -> invoke through the provider adapter
```

The first cut proves this for OpenAI Responses and Anthropic Messages. It supports both direct caller-selected models and the existing classifier behind an optional auto-routing logical model.

This is a hard cutover from the coding-specific `fast | balanced | hard | deep` schema. There is no compatibility layer between the old and new configuration models.

## Non-goals

Do not build these in this scope:

- a general route DAG;
- teams, SCIM, or a complete RBAC system;
- firm budgets, billing, or contract accounting;
- semantic response caching;
- asynchronous resource lifecycle management;
- distributed control-plane snapshot activation;
- arbitrary runtime-loaded adapters;
- bidirectional TOML/database synchronization;
- new modalities beyond the existing text-generation paths.

## Legacy Model Problems Addressed

The replaced schema had useful pieces, but its boundaries reflected a coding router rather than a general gateway:

- `routing_configs` and the shared schema require the global `fast`, `balanced`, `hard`, and `deep` tiers.
- `providers` mixes an executable adapter definition with configurable endpoint data.
- `provider_accounts` represents credentials but overlaps connection configuration.
- `model_catalog` mixes model identity, provider deployment, pricing, capabilities, and route tier.
- API keys select a routing config and provider accounts rather than a reusable model-access policy.
- request and session evidence uses route-tier and agent terminology where gateway concepts are needed.

The event, outbox, organization/workspace, API-key hashing, request, attempt, usage, and prompt-artifact foundations remain useful.

## Core Model

```text
ApiKey -> AccessProfile -> LogicalModel -> LogicalModelTarget -> ModelDeployment
                                                                    |       |
                                                                    |       +-> CanonicalModel
                                                                    +-> ProviderConnection
                                                                    +-> DeploymentWireBinding

Ingress ApiWire -> Operation -> compatible binding -> Egress ApiWire
                                  optional WireAdapter
```

The important separations are:

- **Canonical model:** what model release it is.
- **Model deployment:** where that model can be invoked.
- **Logical model:** the stable name callers request.
- **Provider connection:** endpoint and credential boundary.
- **API wire:** request and response protocol.
- **Adapter:** executable code that handles a provider or translates one wire to another.

## Code-owned Contracts

These are executable behavior and remain versioned in code, not editable database rows:

### Provider adapter kinds

Initial adapter kind IDs:

- `generic-http-json`
- `aws-bedrock-converse`

A connection selects an installed adapter kind. Provider slugs such as `openai`, `anthropic`, and `amazon-bedrock` identify connection data; they are not adapter kinds. Adding a provider that needs new signing, streaming, or error behavior requires code and conformance tests. A custom OpenAI-compatible endpoint reuses `generic-http-json` with different connection data.

### API wires

Initial wire IDs:

- `openai-responses`
- `openai-chat`
- `anthropic-messages`
- `bedrock-converse`

Adapter contract versions are stored separately rather than embedded in a wire ID. HTTP ingress wires own their route, request validation, stream framing, error rendering, and model-discovery behavior. `bedrock-converse` is initially an egress wire.

### Operations

The initial operations are:

- `text.generate`
- `text.count_tokens`

`model.list` remains a local catalog operation. Embeddings and other modalities add new operation definitions only after the core resolution path works.

### Wire adapters

A wire adapter is a code-owned, directed conversion between two wire versions. The registry returns `native`, a specific adapter version, or unsupported. Unsupported translation fails before provider I/O.

## Database-owned Resources

Every row below is organization and workspace scoped unless explicitly identified as a platform catalog row. Foreign keys use the complete scope rather than resolving IDs globally.

### `provider_connections`

One physical provider account and endpoint boundary.

Required fields:

- `id`, `organization_id`, `workspace_id`;
- stable provider behavior ID, operator-facing connection slug and name;
- `adapter_kind`, `base_url`, optional `region`;
- `credential_ref` or encrypted credential material, never a raw key;
- adapter configuration, provider capabilities, and non-secret default headers;
- `status`.

This replaces the overlapping runtime responsibilities of `providers`, `provider_accounts`, and `api_key_provider_accounts`. Credentials belong to the connection; API keys receive model access, not direct provider credentials.

### `canonical_models`

Provider-independent model identity.

Required fields:

- stable `id` and caller-independent canonical name;
- vendor and upstream model family;
- immutable release identifier when the provider exposes one;
- capabilities and published lifecycle status.

This may be platform-scoped. Workspace configuration cannot mutate the identity of an existing canonical model.

### `model_deployments`

One callable instance of a canonical model through a provider connection.

Required fields:

- `id`, `organization_id`, `workspace_id`;
- `canonical_model_id`, `provider_connection_id`;
- exact upstream model identifier;
- optional region and deployment configuration;
- capabilities that narrow, but never expand, the canonical model;
- `status`.

Capability metadata is partial: an absent capability is unknown and does not exclude a deployment. An explicit `false`, a required modality missing from an advertised modality list, or a numeric capacity below the request requirement makes the deployment ineligible before either direct selection or classifier routing.

Pricing can remain attached to the deployment for V1. A separate pricing system is deferred until multiple schedules or contracts require it.

### `deployment_wire_bindings`

One deployment endpoint spoken in one native egress wire.

Required fields:

- scoped deployment and connection IDs;
- code-owned `api_wire_id`;
- endpoint path and non-secret request configuration;
- adapter contract version;
- enabled status.

A deployment may have multiple bindings. OpenAI models can therefore expose both Responses and Chat Completions without duplicating the deployment.

### `logical_models`

The stable model names exposed to callers, for example:

- `fable`
- `coding-auto`
- `economy-auto`

Required fields:

- `id`, `organization_id`, `workspace_id`, unique `slug`;
- display name and description;
- `resolution_kind: direct | router`;
- for router models, one installed `router_kind` and bounded router configuration;
- `status`.

The only V1 router kind is `classifier`, reusing the current structured-output classifier. Additional routing strategies remain deferred until a concrete application requires them.

A direct logical model does not invoke a classifier.

### `logical_model_targets`

The deployments a logical model can select.

Required fields:

- scoped logical-model and deployment IDs;
- stable priority for presenting eligible targets to the classifier;
- enabled status.

A direct logical model has exactly one enabled target. A classifier model may have several. Retrying a possibly-sent provider operation against another target is out of scope.

### `access_profiles`

A reusable set of gateway entitlements, for example:

- `opendoor-engineer`;
- `external-economy`;
- `service-default`.

Required fields:

- `id`, `organization_id`, `workspace_id`, unique `slug`;
- description and status;
- optional coarse request and token limits already enforceable by the current proxy.

### `access_profile_model_grants`

The logical models and operations an access profile may request.

Required fields:

- scoped profile and logical-model IDs;
- allowed operation IDs;
- optional parameter caps that the current request path can enforce.

No grant refers directly to a provider connection or deployment. A route may change physical targets without changing caller entitlements.

### `api_keys`

Keep the existing hashed credential record and replace `routing_config_id` with `access_profile_id`.

An API key can request only logical models granted by that profile. Provider credentials never attach to the caller key.

## Request Evidence Cutover

Keep the existing request, route-decision, provider-attempt, usage, event, and outbox machinery, but replace coding-specific fields with gateway resolution evidence.

Each request records:

- ingress wire ID;
- operation ID;
- requested logical-model slug and resolved logical-model ID;
- access-profile and authorization result;
- router kind and decision evidence when routing occurred;
- selected deployment and provider connection;
- egress wire and optional wire-adapter version.

Each provider attempt records the selected deployment, connection, egress wire, provider-adapter version, outcome, usage, and cost already supported by the current ledger.

The existing `agent_sessions` table is not part of this first migration. Rename and generalize it only when a non-agent workflow needs durable affinity.

## Resolution Contract

The first resolver accepts:

```ts
type ResolveModelInput = {
  organizationId: string;
  workspaceId: string;
  apiKeyId: string;
  ingressWireId: string;
  operationId: string;
  requestedModel: string;
};
```

It returns either one execution target or one typed denial:

```ts
type ResolvedModelTarget = {
  logicalModelId: string;
  deploymentId: string;
  providerConnectionId: string;
  egressWireId: string;
  wireAdapterId: string | null;
  routerDecisionId: string | null;
};
```

Resolution order:

1. Authenticate the key and load its organization, workspace, and access profile.
2. Resolve the requested logical model inside that same workspace.
3. Authorize the operation and logical model through the access-profile grant.
4. Load enabled targets and deployments with active provider connections.
5. Retain only targets with a native egress wire or an installed compatible wire adapter.
6. For `direct`, require exactly one eligible target.
7. For `router`, run the configured installed router over only the eligible targets.
8. Persist the resolution before provider I/O.

The resolver does not parse provider response bodies, fetch credentials, send network requests, or perform retries.

## First Vertical Slice

### Slice 1: Schema and resolver

- Add the target tables and scoped foreign keys.
- Register the code-owned adapter, wire, and operation IDs used by tests.
- Implement the pure resolution service.
- Seed `fable`, `coding-auto`, and `economy-auto` fixtures.
- Remove global route-tier types from the shared configuration schema.

### Slice 2: Existing endpoints through the resolver

- Route `POST /v1/responses` and `POST /v1/messages` through the resolver.
- Keep native same-wire forwarding as the normal path.
- Use the existing translation code only where the selected binding requires it.
- Make `GET /v1/models` list only logical models granted to the credential.
- Replace tier fields in request and attempt persistence with gateway resolution evidence.

### Slice 3: Configuration authoring

- Add minimal administrative CRUD for connections, deployments, logical models, targets, profiles, and grants.
- Add a TOML `plan` and `apply` command that produces the same database mutations as the API.
- Keep the database as the only runtime truth; do not implement live two-way sync.

The implemented V1 document shape and operator commands are defined in [TOML.md](TOML.md).

## Implementation Tickets

The dependency-ordered, PR-sized implementation breakdown lives in [TICKETS.md](TICKETS.md).

## Acceptance Criteria

1. An allowed key requesting `fable` resolves directly without classifier cost.
2. An Opendoor engineering key requesting `coding-auto` runs the existing classifier over only its eligible targets.
3. An external key requesting `economy-auto` cannot select a deployment outside that logical model's target set.
4. An external key requesting `fable` receives the ingress wire's model-access-denied error when its profile lacks the grant.
5. `/v1/models` never advertises an ungranted logical model.
6. A disabled connection, deployment, binding, target, logical model, profile, or grant is rejected before provider I/O.
7. A target without a native or adapter-supported wire is rejected before provider I/O.
8. Cross-organization, cross-workspace, and cross-key foreign-key substitution fails in the database and resolver tests.
9. Existing OpenAI Responses and Anthropic Messages harness fixtures pass through the new resolver.
10. No shared runtime type requires `fast`, `balanced`, `hard`, or `deep`.

## Hard-cutover Mapping

| Removed concept | Gateway concept |
| --- | --- |
| `providers` adapter and endpoint row | code-owned adapter kind + `provider_connections` |
| `provider_accounts` | `provider_connections` |
| `api_key_provider_accounts` | removed; access comes from profile grants |
| `model_catalog` model/account/region row | `canonical_models` + `model_deployments` |
| `model_catalog.route` | removed |
| `routing_configs` tier document | `logical_models` + `logical_model_targets` |
| `api_keys.routing_config_id` | `api_keys.access_profile_id` |
| global route names | logical-model slugs |
| requested tier | requested logical model |
| selected provider/model strings | selected deployment and connection IDs |

The migration creates the gateway resources, cuts every supported endpoint to logical-model resolution, and removes the old tables, columns, seeds, shared types, and runtime branches. There is no dual-read period.

## Deferred Decisions

Decide these only when the first vertical slice makes them necessary:

- versioned immutable workspace publication;
- reusable route definitions separate from logical models;
- canonical pricing schedules and firm budgets;
- team and organization policy inheritance;
- resource and state lifecycle routing;
- generalized session affinity;
- additional operations and modalities;
- more router kinds.
