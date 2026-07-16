# Gateway Control-Plane Runbook

## Purpose

Use this runbook to inspect and change gateway supply, logical models, access profiles, and API-key assignments. The database is the runtime source of truth. GraphQL and TOML both call the same validation and transactional mutation service.

## Resource Order

Create or diagnose resources in dependency order:

```text
provider connection
  -> canonical model
  -> model deployment
  -> deployment wire binding
  -> logical model
  -> logical model target
  -> access profile
  -> model grant
  -> API-key assignment
```

Every resource is organization- and workspace-scoped. Cross-scope IDs fail validation and database foreign keys.

## Local Baseline

```shell
pnpm dev:local
```

The idempotent seed creates OpenAI, Anthropic, and Bedrock connection placeholders; initial model deployments; `fable`, `coding-auto`, and `economy-auto`; the `opendoor-engineer` and `external-economy` access profiles; and a default key assigned to the engineer profile.

Seed-only classifier settings are:

```shell
GATEWAY_SEED_CLASSIFIER_MODEL=gpt-5-nano-2025-08-07
GATEWAY_SEED_CLASSIFIER_TIMEOUT_MS=30000
GATEWAY_SEED_CLASSIFIER_MAX_ATTEMPTS=2
```

Changing these variables does not alter an existing database. Use GraphQL or TOML to update an existing logical model.

## Inspect The Graph

Log into the admin console, copy the session cookie, and query GraphQL:

```shell
curl -sS http://127.0.0.1:8787/admin/graphql \
  -H 'content-type: application/json' \
  -H 'cookie: proxy_session=<session>' \
  -d '{"query":"{ gatewayProviderConnections { id slug name status credentialConfigured } gatewayModelDeployments { id slug upstreamModelId providerConnectionId pricing status } gatewayWireBindings { id deploymentId apiWireId endpointPath enabled } gatewayLogicalModels { id slug resolutionKind routerKind status } gatewayLogicalModelTargets { id logicalModelId deploymentId priority enabled } gatewayAccessProfiles { id slug name status } gatewayModelGrants { id accessProfileId logicalModelId allowedOperations enabled } }"}'
```

Use list queries for inventory and singular queries such as `gatewayLogicalModel(id: ...)` for detail. Admin responses expose safe credential hints, not secret material.

## Declarative Plan And Apply

Start from the shape in [Gateway Configuration TOML V1](../scopes/ai-gateway-core-model-v1/TOML.md).

```shell
pnpm --filter @proxy/proxy gateway-config plan ./gateway.toml
pnpm --filter @proxy/proxy gateway-config plan ./gateway.toml --json
pnpm --filter @proxy/proxy gateway-config apply ./gateway.toml --actor-user-id user_123
```

Operational rules:

- `plan` never writes.
- `apply` is non-interactive; invoking it is the confirmation boundary.
- Slugs identify resources inside the declared organization and workspace.
- Omitted resources are untouched.
- `enabled` defaults to false.
- Dependencies enable before dependents and disable in reverse order.
- An unchanged second apply produces no commands or audit events.
- Raw provider secrets are invalid TOML. Use `secret_ref`.

For `env:NAME` references other than the built-in OpenAI and Anthropic variables, configure `NAME_ALLOWED_ORIGINS` with exact comma-separated origins. The planner rejects missing secrets and origin mismatches before mutation.

## Create A Direct Logical Model

A direct model must have exactly one enabled eligible target.

1. Create or reuse a provider connection.
2. Create the canonical model and deployment.
3. Add a native wire binding for every caller API family that should reach it, or rely on an installed compatible HTTP translator.
4. Create the logical model with `resolutionKind: "direct"`.
5. Create one enabled logical-model target.
6. Grant the logical model and required operations to an access profile.
7. Confirm the model appears in `/v1/models` for a key assigned to that profile.

Create the logical model and its target atomically through `CreateGatewayLogicalModelInput.initialTargets`.

## Create A Classifier Logical Model

A classifier model has `resolutionKind: "router"` and typed router configuration:

```json
{
  "classifierDeploymentId": "workspace:deployment:openai:classifier-model",
  "instructions": "Select exactly one eligible target.",
  "timeoutMs": 10000,
  "maxAttempts": 2
}
```

Create the router and all of its initial targets atomically through `CreateGatewayLogicalModelInput.initialTargets`. Access profiles can likewise include `initialGrants` so a selected model set never becomes partially visible.

The console's pick-models key flow uses `createGatewayApiKeyWithModels` to create the dedicated profile, grants, hashed API key, audit events, and outbox records in one database transaction. Existing reusable profiles continue to use `createApiKey` directly.

The classifier deployment must have an active `openai-responses` binding through a `generic-http-json` connection. Add target rows in stable priority order. The runtime filters disabled, unhealthy, unauthorized, and wire-incompatible targets before the classifier call. A returned deployment outside that eligible set is rejected.

## Assign Access To An API Key

Keys are issued with an access profile:

```graphql
mutation {
  createApiKey(input: {
    name: "payments-production"
    accessProfileId: "workspace_default:access-profile:service-default"
  }) {
    apiKey { id name accessProfileId }
    secret
  }
}
```

The secret is returned once. Store it immediately. To change an existing key:

```graphql
mutation {
  assignGatewayApiKeyAccessProfile(
    apiKeyId: "api_key_123"
    accessProfileId: "workspace_default:access-profile:external-economy"
  ) {
    apiKeyId
    accessProfileId
  }
}
```

The key's `/v1/models` response and authorization change on the next request. Provider credentials are not assigned to caller keys.

## Safe Change Procedures

### Add physical capacity without changing callers

Create the connection, deployment, and binding first. Add an enabled target to an existing classifier logical model only after the physical graph validates. Existing keys and application model names remain unchanged.

### Move a direct model

Use one transactional GraphQL mutation flow or one TOML apply that leaves exactly one enabled target in the projected graph. A direct model with zero or multiple enabled eligible targets is invalid.

### Remove a deployment

Disable or repoint logical targets before disabling the deployment, binding, or connection. The mutation service validates dependent resources and prevents an invalid active graph.

### Restrict expensive models

Create a limited access profile whose grants include only the approved logical models. Assign that profile to external or lower-trust keys. Do not encode caller identity in the classifier prompt and do not grant physical deployments directly.

## Verify Traffic

List the caller-visible catalog:

```shell
curl -sS http://127.0.0.1:8787/v1/models \
  -H 'authorization: Bearer <proxy-key>'
```

Send an OpenAI Responses request:

```shell
curl -sS http://127.0.0.1:8787/v1/responses \
  -H 'authorization: Bearer <proxy-key>' \
  -H 'content-type: application/json' \
  -d '{"model":"coding-auto","input":"Return ok."}'
```

Inspect the request evidence in GraphQL:

```graphql
query {
  requests {
    requestId
    ingressWireId
    operationId
    requestedLogicalModel
    resolvedLogicalModelId
    accessProfileId
    routerKind
    routerDecision
    deploymentId
    providerConnectionId
    egressWireId
    wireAdapterVersion
    terminalStatus
  }
}
```

Run `pnpm smoke` for mock-backed endpoint coverage and `pnpm smoke:harnesses` for installed Codex and Claude Code coverage.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Model absent from `/v1/models` | Key profile, enabled grant, `model.list`, logical-model status |
| Access denied | Workspace scope, profile assignment, operation grant, parameter caps |
| No eligible target | Target, deployment, connection, canonical model, health, and wire binding status |
| Direct model invalid | Exactly one enabled eligible target must remain |
| Classifier rejected | Classifier deployment/binding, typed config, returned deployment membership |
| Wire unavailable | Native binding, installed translator, websocket/stateful restrictions |
| Provider auth failure | Connection auth style, secret reference resolution, origin policy |
| Request missing from logs | Database transaction, event writer, organization/workspace selection |

Never work around a denial by adding an alias or environment fallback. Repair the scoped resource graph or entitlement that produced it.
