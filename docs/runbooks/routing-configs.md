# Routing Configs Runbook

Routing configs are the persisted control plane for model routing. Runtime requests should not depend on `ROUTE_POLICY_JSON` or other process-global route policy JSON. Environment variables still seed local defaults such as model names, provider base URLs, and classifier model, but each persisted request resolves a routing config version before classifier spend.

## Local Setup

```shell
cp .env.example .env
pnpm install
pnpm dev:local
```

`pnpm dev:local` starts Postgres, runs migrations, seeds data, starts the proxy on `http://127.0.0.1:8787`, and starts the web console on `http://127.0.0.1:5173`.

For a manual setup:

```shell
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm dev:proxy
pnpm dev:web
```

`pnpm db:seed` creates:

- organization `DEFAULT_ORGANIZATION_ID`, default `local`
- user `SEED_USER_ID`, default `local-user`
- default routing config `${DEFAULT_ORGANIZATION_ID}:routing-config:default`
- active immutable v1 for that config
- default API key `${DEFAULT_ORGANIZATION_ID}:api-key:default`
- assignment from the default API key to the default routing config

Use the seeded token through `PROMPT_PROXY_TOKEN`.

## Config Precedence

Each request resolves exactly one active routing config version before classification:

1. authenticated API key `api_keys.routing_config_id`
2. organization default `organization_settings.default_routing_config_id`
3. seeded default `${organizationId}:routing-config:default`
4. active row in `routing_config_versions`

The resolver parses the active version with the shared routing config schema and returns the config id, config name, version id, version number, and config hash. Route decisions and request rows store that snapshot so operators can explain why a model was selected later.

Changing an API key assignment affects the next request from that key. Active version rows are immutable; create a new version and activate it instead of editing a live version in place.

## System Prompt And Route Tier Models

The organization system prompt lives on `organization_settings.system_prompt` (Settings → System Prompt in the console), not on routing configs. When set, the proxy prepends it to the outbound provider request before forwarding:

- OpenAI Responses: prepended to `instructions`
- Anthropic Messages: prepended as the first `system` block (or joined when `system` is a string), including `count_tokens` requests

Active harness sessions keep the organization prompt they first used so provider prompt-cache prefixes stay byte-stable. Changes apply to new sessions and to sessionless requests. Harness-provided prompts are preserved after the organization prompt. Leave the setting empty to forward harness prompts unchanged; nothing is seeded by default. Routing config versions that still carry the pre-cutover top-level `systemPrompt` or `classifier.instructions` fields fail strict validation; migration `0005_organization_system_prompt.sql` strips both from stored versions.

The web console edits the routing rules and the per-tier models and efforts (`fast`, `balanced`, `hard`, `deep` for OpenAI and Anthropic):

- Routing configs → New config: clones an active config, then lets you set the routing rules and tier models before creating v1.
- Routing config detail → Prompts & route models: edits create a new draft version; leave "Activate immediately" checked to promote it in the same step.
- Each tier exposes a per-provider effort dropdown with provider-specific levels (OpenAI reasoning: `minimal`–`xhigh`; Anthropic output: `low`–`max`). "Default effort" omits the effort so the model default applies.
- The UI/JSON toggle on the detail editor switches to the raw config document, VSCode-style. JSON mode edits fields the form does not expose (limits, session, classifier details); both views feed the same save-new-version flow, and JSON is validated server-side against the routing config schema.

Clearing a tier's model removes that provider block from the tier; every tier must keep at least one provider model.

## Assign A Config To An API Key

Use the web console when possible:

1. Open `http://127.0.0.1:5173`.
2. Sign in with `ADMIN_DEV_LOGIN_EMAIL` and `ADMIN_DEV_LOGIN_PASSWORD`.
3. Open API keys.
4. Pick the key and assign a routing config.
5. Check request logs after the next request; each row should show the routing config version/hash snapshot.

The same flow is available through the admin GraphQL API at `/admin/graphql`
(logged-in admins can also use GraphiQL there). First create a dev session:

```shell
curl -sS -c /tmp/prompt-proxy.cookies \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/admin/graphql \
  -d "{\"query\":\"mutation { login(email: \\\"${ADMIN_DEV_LOGIN_EMAIL:-local@example.com}\\\", password: \\\"${ADMIN_DEV_LOGIN_PASSWORD:-dev-password}\\\") { organizationId } }\"}"
```

List routing configs and API keys:

```shell
curl -sS -b /tmp/prompt-proxy.cookies \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/admin/graphql \
  -d '{"query":"{ routingConfigs { id name status activeVersion { version } } apiKeys { id name routingConfigId } }"}'
```

Assign a config:

```shell
curl -sS -b /tmp/prompt-proxy.cookies \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/admin/graphql \
  -d '{"query":"mutation { assignApiKeyRoutingConfig(apiKeyId: \"local:api-key:default\", routingConfigId: \"local:routing-config:default\") { id routingConfigId } }"}'
```

Clear a key-level assignment and fall back to the organization default:

```shell
curl -sS -b /tmp/prompt-proxy.cookies \
  -H 'content-type: application/json' \
  -X PATCH http://127.0.0.1:8787/admin/api-keys/local:api-key:default/routing-config \
  -d '{"routingConfigId":null}'
```

## Create Or Promote A Version

Create a new config:

```shell
curl -sS -b /tmp/prompt-proxy.cookies \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/admin/routing-configs \
  -d @routing-config.json
```

`routing-config.json` should use this wrapper shape:

```text
{
  "name": "Cost-aware coding router",
  "slug": "cost-aware-coding-router",
  "description": "Routes Codex and Claude Code traffic by task complexity.",
  "config": <full RoutingConfig object>
}
```

The `config` object must include the full classifier, routes, limits, and session blocks from the routing config schema.

Create a draft version for an existing config:

```shell
curl -sS -b /tmp/prompt-proxy.cookies \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/admin/routing-configs/local:routing-config:default/versions \
  -d @routing-config-version.json
```

`routing-config-version.json` should contain `{ "config": { ... } }` with the full replacement config body. The web console detail page drives this same endpoint when saving routing rule or tier model edits.

Activate a version:

```shell
curl -sS -b /tmp/prompt-proxy.cookies \
  -X POST http://127.0.0.1:8787/admin/routing-configs/local:routing-config:default/versions/local:routing-config:default:v1/activate
```

Activation changes which immutable version new requests resolve. Existing request and route-decision snapshots keep the old version id/hash.

## Verify Routing Locally

```shell
pnpm smoke
pnpm smoke:harnesses
```

`pnpm smoke` uses mock upstream providers. It proves the seeded API key uses the default config, assigns that key to a smoke-only config, and proves the next OpenAI Responses and Anthropic Messages requests use the reassigned config.

`pnpm smoke:harnesses` runs installed `codex` and `claude` CLIs against the same mock-backed proxy and verifies persisted hard-route decisions against the seeded default config.

## Troubleshooting

- `auth failed`: check `PROMPT_PROXY_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, Codex `env_key`, and Claude `ANTHROPIC_API_KEY`.
- `config resolution failed`: check the API key assignment, organization default, active version id, config status, and config schema validity.
- `classifier failed`: check `classifier.provider`, `classifier.model`, upstream OpenAI credentials/base URL, timeout, and max attempts in the active config.
- `provider forwarding failed`: check the selected provider model, provider credentials, base URL, and surface compatibility.
