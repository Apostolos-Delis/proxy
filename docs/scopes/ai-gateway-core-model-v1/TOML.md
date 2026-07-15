# Gateway Configuration TOML V1

Gateway TOML is an explicit authoring input. `plan` reads the database and prints a diff without writing. `apply` sends that same validated diff through the transactional admin mutation service. The proxy never reads TOML while serving traffic; the database remains the runtime source of truth.

## Commands

```bash
pnpm --filter @proxy/proxy gateway-config plan ./gateway.toml
pnpm --filter @proxy/proxy gateway-config plan ./gateway.toml --json
pnpm --filter @proxy/proxy gateway-config apply ./gateway.toml --actor-user-id user_123
```

`apply` is non-interactive because invoking it is the confirmation boundary. The actor ID is required for audit events. `DATABASE_URL` and the normal proxy provider/network settings are loaded from the environment.

## Reconciliation Rules

- `version = 1` and `[scope]` are required.
- Gateway resources are identified and referenced by workspace-scoped slugs. Internal database IDs cannot be declared.
- A declared resource is created or updated to match the document. A resource omitted from the document is untouched; V1 does not delete resources.
- `enabled` defaults to `false`. Dependencies are enabled before dependents and disabled in reverse order.
- An unchanged second apply emits no commands or events.
- Provider credentials accept `secret_ref` only. A raw `secret` field is rejected before the database is opened.
- `env:OPENAI_API_KEY` and `env:ANTHROPIC_API_KEY` are bound to the configured provider origins. Any other `env:NAME` requires both `NAME` and a comma-separated `NAME_ALLOWED_ORIGINS` environment variable containing exact URL origins.
- Other secret-reference schemes require a deployment-provided origin-bound resolver; the stock process resolver does not accept them.
- Omitting `secret_ref` preserves an existing credential. Set `clear_secret = true` to remove it.
- `plan` and `apply` validate the complete projected resource graph, code-owned adapter/wire contracts, provider network policy, and secret-reference availability before mutation.
- API-key assignments use the existing key ID because API keys are issued outside this document. The referenced access profile still uses its slug.

## Document Shape

```toml
version = 1

[scope]
organization_id = "org_acme"
workspace_id = "workspace_production"

[[provider_connections]]
slug = "openai-production"
name = "OpenAI Production"
adapter_kind = "generic-http-json"
auth_style = "bearer"
base_url = "https://api.openai.com/v1"
secret_ref = "env:OPENAI_API_KEY"
adapter_config = {}
default_headers = { x-owner = "ai-platform" }
enabled = true

[[canonical_models]]
slug = "gpt-primary"
name = "GPT Primary"
vendor = "openai"
family = "gpt"
release = "production"
capabilities = { tools = true, contextWindow = 200000, modalities = ["text"] }
enabled = true

[[model_deployments]]
slug = "gpt-primary-openai"
name = "GPT Primary on OpenAI"
canonical_model = "gpt-primary"
provider_connection = "openai-production"
upstream_model_id = "gpt-primary"
config = {}
capabilities = { tools = true, contextWindow = 200000, modalities = ["text"] }
pricing = {}
enabled = true

[[wire_bindings]]
deployment = "gpt-primary-openai"
api_wire = "openai-responses"
endpoint_path = "/responses"
request_config = { store = false }
adapter_contract_version = "1"
enabled = true

[[logical_models]]
slug = "fable"
name = "Fable"
description = "Stable direct application model"
resolution_kind = "direct"
enabled = true

[[logical_model_targets]]
logical_model = "fable"
deployment = "gpt-primary-openai"
priority = 0
enabled = true

[[access_profiles]]
slug = "opendoor-engineers"
name = "Opendoor Engineers"
limits = { requests_per_minute = 120, tokens_per_minute = 1000000 }
enabled = true

[[model_grants]]
access_profile = "opendoor-engineers"
logical_model = "fable"
allowed_operations = ["text.generate", "text.count_tokens", "model.list"]
parameter_caps = { max_output_tokens = 8192 }
enabled = true

[[api_key_assignments]]
api_key_id = "api_key_123"
access_profile = "opendoor-engineers"
```

## Router Models

Router settings are typed rather than accepted as arbitrary JSON. The classifier deployment must have an active `openai-responses` binding on a generic HTTP provider connection.

```toml
[[logical_models]]
slug = "coding-auto"
name = "Coding Auto"
resolution_kind = "router"
enabled = true

[logical_models.router]
classifier_deployment = "classifier-primary"
instructions = "Select exactly one eligible coding target."
timeout_ms = 10000
max_attempts = 2
```

Router candidates use the same `[[logical_model_targets]]` records as direct models. Direct models must have exactly one enabled target; router models may have multiple eligible targets.
