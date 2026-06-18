# Provider Registry V2

## Goal

Make provider and model capability data durable, versioned, and operationally governable.

Provider Registry V2 builds on [Provider Architecture V1](../provider-architecture-v1/PLAN.md). The V1 architecture separates surfaces, dialects, providers, and translators. V2 turns that design into the runtime source of truth for routing, capability checks, provider account ownership, and model metadata.

## Why This Matters

LiteLLM, 9router, and OmniRoute show that provider count grows quickly. Static provider code works for a local router, but Prompt Proxy needs organization-scoped governance:

- provider credentials must be encrypted or referenced
- org-defined providers must not receive operator env keys
- model capabilities drift
- costs change
- routing configs need stable provider ids
- operator overrides need audit
- provider rows must be scoped by organization and workspace rules

## Current State

Prompt Proxy has provider/account concepts and existing architecture docs for provider decoupling. Runtime still needs a durable registry that fully owns:

- provider endpoint dialects
- auth style
- model catalog
- model capabilities
- cost data
- credential references
- config validation
- active runtime graph generation

## Target Concepts

### Provider

A provider is an upstream service or gateway with one or more dialect endpoints.

Examples:

- OpenAI public API
- Anthropic public API
- OpenAI Codex subscription backend
- Claude subscription credential path
- OpenAI-compatible self-hosted vLLM
- Anthropic-compatible OSS endpoint
- corporate internal gateway

### Provider Account

A provider account is a credential-bearing identity for a provider.

Examples:

- operator OpenAI env credential
- customer BYOK OpenAI key
- Claude subscription token owned by a user
- Codex refresh token owned by a user
- no-auth local Ollama endpoint

### Model Catalog Entry

A model catalog entry describes a model or deployment exposed by a provider.

Capabilities:

- dialect support
- tools
- vision
- reasoning
- context window
- max output
- cache support
- unsupported params
- pricing
- deprecation status
- quality tier labels

## Data Model

### provider_registry

```text
id text primary key
organization_id text references organizations(id)
slug text not null
display_name text not null
kind text not null
base_url text not null
enabled boolean not null default true
auth_style text not null
endpoints jsonb not null
default_headers jsonb not null default '{}'
timeout_ms integer
retry_policy jsonb not null default '{}'
created_by_user_id text references users(id)
created_at timestamptz not null
updated_at timestamptz not null

unique (organization_id, slug)
index (organization_id)
```

`organization_id = null` means builtin provider. Org rows can shadow builtin slugs only through explicit validation.

### provider_accounts

Extend or normalize existing provider account storage:

```text
provider_registry_id text references provider_registry(id)
workspace_id text references workspaces(id)
owner_user_id text references users(id)
secret_ref text
secret_ciphertext text
base_url_override text
status text not null
last_health_at timestamptz
created_at timestamptz not null
updated_at timestamptz not null
```

Credential invariant:

- builtin providers may fall back to operator credentials when no BYOK account is bound
- org-defined providers require an attached credential unless `auth_style = "none"`
- auth-bearing headers cannot live in `default_headers`

### model_catalog

```text
id text primary key
organization_id text references organizations(id)
provider_registry_id text references provider_registry(id)
model text not null
display_name text
dialects jsonb not null
capabilities jsonb not null
limits jsonb not null default '{}'
pricing jsonb not null default '{}'
status text not null default 'active'
source text not null
source_version text
last_synced_at timestamptz
created_at timestamptz not null
updated_at timestamptz not null

unique (organization_id, provider_registry_id, model)
index (organization_id, provider_registry_id)
```

## Capability Shape

Draft shape:

```json
{
  "tools": true,
  "vision": false,
  "reasoning": true,
  "responses": true,
  "anthropicMessages": false,
  "chatCompletions": true,
  "promptCache": true,
  "streaming": true,
  "jsonSchema": false,
  "unsupportedParams": ["temperature", "top_p"],
  "contextWindow": 200000,
  "maxOutputTokens": 64000
}
```

## Runtime Graph

Build an active routing graph from:

- provider registry rows
- provider accounts
- model catalog
- active routing config
- translator registry

The graph should have:

- version
- hash
- generated timestamp
- validation errors
- last-known-good behavior

Route planning should use the graph, not ad hoc database reads from every helper.

## Validation

On routing config activation:

- every provider slug resolves
- every model exists or is allowed as passthrough
- required credential exists for org-defined providers
- requested dialect path is native or translatable
- unsupported stateful features are rejected
- cost data is present or marked unpriced
- private base URLs are operator-allowlisted

Bad configs should fail activation without affecting the active graph.

## Catalog Sources

V1 sources:

- built-in seed rows for OpenAI and Anthropic
- built-in seed rows for Codex and Claude subscription credentials
- manual org-defined providers
- operator pricing overrides

Later sources:

- models.dev snapshots
- provider list APIs
- assessment probes
- operator curated catalogs

## Console

Provider registry UI should show:

- builtin providers
- org-defined providers
- provider endpoints and dialects
- model capabilities
- credential requirements
- health status
- pricing source
- last synced time
- routing configs using the provider

Editing provider rows is security-sensitive and should be owner/admin only.

## Security

Hard rules:

- API keys are hashes, never raw.
- Provider credentials are encrypted material or secret refs.
- Org-defined provider rows never receive operator env credentials.
- Auth headers are rejected in default headers.
- Private network egress requires operator allowlist.
- Metadata service and link-local ranges are always blocked.
- Provider base URL changes create events.

## Events

Add:

```text
provider_registry.created
provider_registry.updated
provider_registry.disabled
provider_account.bound
provider_account.revoked
model_catalog.synced
model_catalog.override_applied
routing_graph.generated
routing_graph.activation_failed
routing_graph.activated
```

## Validation And Tests

Unit tests:

- org provider requires credential
- auth headers rejected
- provider slug resolution honors org shadowing
- capabilities drive compatibility
- private URL validation blocks metadata ranges

Integration tests:

- activate config with builtin OpenAI target
- activate config with org provider and BYOK credential
- reject config with missing credential
- request route plan uses registry graph

## Rollout

1. Add provider registry and model catalog tables.
2. Seed builtin providers from existing config.
3. Generate active runtime graph.
4. Validate routing config activation against graph.
5. Move provider account binding to registry ids.
6. Add model capability UI.

## Non-Goals

- No Bedrock SigV4 or Vertex OAuth in V2 unless a provider auth plugin point exists.
- No user-supplied executable provider plugins.
- No broad provider import from untrusted sources.
- No dynamic model catalog changes during in-flight request planning.

## Acceptance Criteria

- Runtime routing uses durable provider and model rows.
- Config activation validates provider/model/capability references.
- Org-defined providers cannot leak operator credentials.
- The active routing graph has a version and hash.
- Operators can see capabilities and pricing sources in the console.
