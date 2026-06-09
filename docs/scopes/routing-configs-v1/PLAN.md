# Routing Configs V1

## Goal

Make model routing configurable per API key.

An organization should be able to define routing behavior once, version it, and attach it to any API key used by Codex, Claude Code, or another harness. That routing config should control:

- classifier model and classifier instructions
- route tiers such as `fast`, `balanced`, `hard`, and `deep`
- provider/model selection for each supported surface
- provider-specific reasoning/thinking settings
- budget and max-route guardrails
- session pinning and upgrade behavior

This is the configuration primitive that should exist before prompt rewriting, memory injection, or organization-level optimization.

## Current State

The repo already has several related pieces:

```text
api_keys              caller identity and owner
provider_accounts     upstream provider secret references
model_catalog         provider/model metadata
routing_configs       durable routing config identities
routing_config_versions immutable config JSON snapshots
route_policies        legacy early policy placeholder, kept only until hard cutover
organization_settings org-level defaults
route_decisions       selected route/model audit rows
requests              request current-state rows
events                durable event log
```

Routing is still mostly driven by environment config and process-global settings:

```text
OPENAI_FAST_MODEL
OPENAI_BALANCED_MODEL
OPENAI_HARD_MODEL
OPENAI_DEEP_MODEL
ANTHROPIC_FAST_MODEL
ANTHROPIC_BALANCED_MODEL
ANTHROPIC_HARD_MODEL
ANTHROPIC_DEEP_MODEL
CLASSIFIER_MODEL
ROUTE_POLICY_JSON          legacy runtime routing input until RC-010 removes it
```

API key resolution currently returns organization, user, and scopes. It does not return a routing config.

## Product Model

The core object is a versioned routing config:

```text
routing_config
  stable named config owned by an organization

routing_config_version
  immutable config snapshot used for routing and audit

api_key.routing_config_id
  key-level binding to a routing config
```

Runtime resolution:

```text
incoming API key
  -> api key identity
  -> key routing config
  -> active config version
  -> classifier prompt/model
  -> route tier config
  -> provider adapter rewrite
```

Fallback resolution:

```text
api_keys.routing_config_id
  else organization_settings.default_routing_config_id
  else seeded default routing config
```

V1 should not add user/repo override precedence. API-key binding is the first durable primitive.

## Hard Cutover

Do not keep legacy `route_policies` and `routing_configs` as two competing configuration concepts.

V1 should replace the existing legacy `route_policies` concept with `routing_configs` and `routing_config_versions`. Existing legacy behavior can be represented as the seeded default routing config. New route decision rows should reference routing config version snapshots, not process-global env settings.

Environment variables can remain as local seed inputs, but runtime routing should resolve from the active routing config once persistence is enabled.

## Data Model

### routing_configs

```text
id text primary key
organization_id text not null references organizations(id)
name text not null
slug text not null
description text
status text not null default 'active'
active_version_id text
created_at timestamptz not null default now()
updated_at timestamptz not null default now()

unique (organization_id, slug)
index (organization_id)
```

### routing_config_versions

```text
id text primary key
organization_id text not null references organizations(id)
routing_config_id text not null references routing_configs(id)
version integer not null
config_hash text not null
config jsonb not null
status text not null default 'draft'
created_by_user_id text references users(id)
created_at timestamptz not null default now()
activated_at timestamptz
archived_at timestamptz

unique (organization_id, routing_config_id, version)
unique (organization_id, config_hash)
index (organization_id, routing_config_id)
```

### api_keys

Add:

```text
routing_config_id text references routing_configs(id)
```

This should be nullable so keys can inherit the organization default.

### organization_settings

Add:

```text
default_routing_config_id text references routing_configs(id)
```

### requests

Add routing config snapshot columns:

```text
routing_config_id text
routing_config_version_id text
routing_config_hash text
```

### route_decisions

Add the same snapshot columns:

```text
routing_config_id text
routing_config_version_id text
routing_config_hash text
```

Route decisions should remain understandable even if the config changes later.

## Config Shape

The config JSON should be validated by a shared Zod schema in `packages/schema`.

Draft shape:

```json
{
  "schemaVersion": 1,
  "displayName": "Codex cost saver",
  "description": "Default coding-agent cost routing config",
  "classifier": {
    "provider": "openai",
    "model": "gpt-5-nano-2025-08-07",
    "instructions": "Classify coding-agent requests...",
    "timeoutMs": 1500,
    "maxAttempts": 2,
    "allowRedactedExcerpt": true
  },
  "routes": {
    "fast": {
      "description": "Simple shell/status/read-only tasks",
      "openai": {
        "model": "gpt-5-nano-2025-08-07",
        "reasoning": { "effort": "low" },
        "text": { "verbosity": "low" }
      },
      "anthropic": {
        "model": "claude-haiku",
        "output_config": { "effort": "low" }
      }
    },
    "balanced": {
      "description": "Default coding tasks"
    },
    "hard": {
      "description": "Debugging, multi-file edits, migrations"
    },
    "deep": {
      "description": "Architecture, system design, security, storage design"
    }
  },
  "limits": {
    "maxRoute": "deep",
    "fallbackRoute": "hard",
    "maxEstimatedInputTokens": 200000
  },
  "session": {
    "pinInitialRoute": true,
    "allowUpgrade": true,
    "allowDowngrade": false
  }
}
```

Provider-specific keys should remain inside provider blocks. Shared policy code should not need to know OpenAI `reasoning.effort` or Anthropic `output_config.effort` details.

## System Prompt Boundary

For V1, the configurable "system prompt" means the classifier instruction prompt.

Do not rewrite the incoming Codex or Claude Code prompt in this scope. Prompt rewriting, memory insertion, and task-context augmentation should become later versioned config blocks after routing configs are stable.

Future config blocks can look like:

```json
{
  "promptRewrite": {
    "enabled": false,
    "instructions": "..."
  },
  "memory": {
    "enabled": false,
    "sources": []
  }
}
```

## Runtime Flow

### Request Entry

```text
POST /v1/responses or POST /v1/messages
  -> authenticate caller API key
  -> resolve organization/user/key
  -> resolve routing config
  -> build route context
  -> classify using config.classifier
  -> resolve final route using config.routes and config.limits
  -> rewrite provider fields through adapter
  -> forward upstream
  -> persist request/decision/usage/events with config snapshot
```

### Config Resolution

Add a `RoutingConfigResolver`:

```text
resolveForApiKey(identity)
  -> api_keys.routing_config_id
  -> organization_settings.default_routing_config_id
  -> seeded default
  -> active routing_config_version
  -> parse config with shared schema
  -> return config plus id/version/hash
```

Cache resolved configs in-process by:

```text
organization_id + routing_config_id + active_version_id
```

Keep TTL short in V1, such as 30 seconds, or invalidate on admin mutation.

### Classifier

`LlmClassifier` should accept the resolved classifier config:

```text
classifier provider
classifier model
classifier instructions
timeout
max attempts
excerpt policy
```

The current hard-coded classifier instruction becomes the seeded default config.

### Route Resolver

Route resolver input:

```text
classification result
request surface
requested model/alias
resolved routing config
request context
session state
budget context
```

Route resolver output:

```text
classifier_route
final_route
selected_provider
selected_model
provider_settings
reason_codes
guardrail_actions
routing_config_id
routing_config_version_id
routing_config_hash
```

Provider adapters should translate `provider_settings` into OpenAI or Anthropic request mutations.

## Admin API Scope

Add:

```text
GET  /admin/routing-configs
POST /admin/routing-configs
GET  /admin/routing-configs/:configId
POST /admin/routing-configs/:configId/versions
POST /admin/routing-configs/:configId/versions/:versionId/activate
POST /admin/routing-configs/:configId/archive

GET   /admin/api-keys
PATCH /admin/api-keys/:apiKeyId/routing-config
```

V1 does not need a full visual JSON editor. It can start with:

- list configs
- show active version
- show pretty JSON
- create version from JSON body
- activate version
- assign config to an API key

## Web App Scope

Add routes:

```text
/routing-configs
/routing-configs/:configId
/api-keys
```

API keys page should show:

- key name
- owner
- scopes
- status
- last used
- assigned routing config
- recent request count/spend once available

Routing config detail should show:

- active version
- config hash
- classifier model
- route tier model matrix
- limits
- session policy
- version history
- API keys using this config

Request/log detail should show:

- routing config name
- version
- config hash
- route tier selected from that config

## Events And Audit

Emit events:

```text
routing_config.created
routing_config.version_created
routing_config.version_activated
routing_config.archived
api_key.routing_config_assigned
routing.config_resolved
```

`routing.config_resolved` should not include full config JSON. Include:

```text
routing_config_id
routing_config_version_id
routing_config_hash
config_name
classifier_model
route_names
```

Full config JSON lives in `routing_config_versions.config`.

## Security And Privacy

- API keys store hashes only.
- Routing configs may contain prompt text for the classifier, but should not contain upstream provider secrets.
- Provider credentials stay in `provider_accounts.secret_ref` or env-backed secret refs.
- Config JSON should be organization scoped.
- Admin APIs must require an authenticated org member.
- Route events should store IDs/hashes and summary metadata, not full prompt text.

## Seed Behavior

Local seed should create:

```text
Default routing config
  active v1
  fast/balanced/hard/deep route definitions
  classifier model from CLASSIFIER_MODEL
  classifier instructions equivalent to current hard-coded classifier prompt

Default API key
  assigned to Default routing config
```

If no explicit routing config exists for an API key, local/dev should still route through the default config.

## Out Of Scope

- Prompt rewriting
- Memory injection
- Hosted customer-facing settings UI polish
- Multi-org admin switching
- Per-repo policy overrides
- Evals-driven automatic config promotion
- Provider secret management beyond existing secret refs
- Live config reload over websockets

## Implementation Tickets

Detailed implementation tickets live in [TICKETS.md](TICKETS.md).

Recommended delivery order:

1. Schema, migrations, and local seeds.
2. Runtime config resolution and classifier/provider wiring.
3. Hard cutover away from `ROUTE_POLICY_JSON` runtime routing.
4. Admin APIs and audit events.
5. Web console management surfaces.
6. Smoke tests, docs, and cache/invalidation hardening.

## Open Questions

1. Should API keys be allowed to override only the routing config, or also selected provider account?
2. Do we want draft config editing in the UI, or JSON-only V1?
3. Should active config versions be immutable forever, or can an admin archive versions?
4. Should route tier names remain fixed to `fast`, `balanced`, `hard`, `deep`, or should configs support custom tier names later?
5. Should per-user max route live in user settings or inside routing config constraints?
