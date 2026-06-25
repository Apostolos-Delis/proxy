# Routing Configs Runbook

Routing configs are the persisted control plane for model routing. Runtime requests should not depend on `ROUTE_POLICY_JSON` or other process-global route policy JSON. Environment variables still seed local defaults such as model names, provider base URLs, and classifier model, but each persisted request resolves a routing config version before classifier spend. Schema v3 stores each route/provider as a deployment pool with an explicit retry policy so operators can configure primary and fallback deployments per tier.

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

Use the seeded token through `PROXY_TOKEN`.

## Config Precedence

Each request resolves exactly one active routing config version before classification:

1. authenticated API key `api_keys.routing_config_id`
2. organization default `organization_settings.default_routing_config_id`
3. seeded default `${organizationId}:routing-config:default`
4. active row in `routing_config_versions`

The resolver parses the active version with the shared routing config schema and returns the config id, config name, version id, version number, and config hash. Route decisions and request rows store that snapshot so operators can explain why a model was selected later.

Changing an API key assignment affects the next request from that key. Active version rows are immutable; create a new version and activate it instead of editing a live version in place.

## System Prompt And Route Deployment Pools

The organization system prompt lives on `organization_settings.system_prompt` (Settings → System Prompt in the console), not on routing configs. When set, the proxy prepends it to the outbound provider request before forwarding:

- OpenAI Responses: prepended to `instructions`
- Anthropic Messages: prepended as the first `system` block (or joined when `system` is a string), including `count_tokens` requests

Active harness sessions keep the organization prompt they first used so provider prompt-cache prefixes stay byte-stable. Changes apply to new sessions and to sessionless requests. Harness-provided prompts are preserved after the organization prompt. Leave the setting empty to forward harness prompts unchanged; nothing is seeded by default. Routing config versions that still carry the pre-cutover top-level `systemPrompt` or `classifier.instructions` fields fail strict validation; migration `0005_organization_system_prompt.sql` strips both from stored versions.

The web console edits the routing rules and the primary per-tier deployment (`fast`, `balanced`, `hard`, `deep` for OpenAI and Anthropic):

- Routing configs → New config: clones an active config, then lets you set the routing rules and tier models before creating v1.
- Routing config detail → Prompts & route models: edits create a new draft version; leave "Activate immediately" checked to promote it in the same step.
- Each tier exposes a per-provider effort dropdown for the first deployment in that provider pool with provider-specific levels (OpenAI reasoning: `minimal`–`xhigh`; Anthropic output: `low`–`max`). "Default effort" omits the effort so the model default applies.
- Request budget toggles `limits.maxEstimatedInputTokens`. Leave it off for long-lived coding sessions; turn it on only for keys that should reject oversized full request envelopes before provider spend.
- The UI/JSON toggle on the detail editor switches to the raw config document, VSCode-style. JSON mode edits fields the form does not expose, including additional deployments, weights, order, provider account ids, base URLs, limits, session, and classifier details. Both views feed the same save-new-version flow, and JSON is validated server-side against the routing config schema.

Clearing a tier's model removes that provider pool from the tier; every tier must keep at least one provider pool. One compatible deployment covers translated HTTP callers, but configs that serve Codex stateful continuations or WebSocket traffic also need a native OpenAI Responses deployment in the tier.

Route/provider pools use this shape:

```json
{
  "schemaVersion": 3,
  "routes": {
    "hard": {
      "description": "Debugging, multi-file edits, and migrations",
      "retry": {
        "maxAttempts": 2,
        "retryableStatusCodes": [429, 500, 502, 503, 504]
      },
      "openai": {
        "deployments": [
          {
            "provider": "openai",
            "model": "gpt-5.5",
            "order": 0,
            "weight": 1,
            "timeoutMs": 60000,
            "reasoning": { "effort": "high" },
            "text": { "verbosity": "medium" }
          },
          {
            "provider": "openai-backup",
            "model": "gpt-5.5-backup",
            "baseUrl": "https://api.openai.com/v1",
            "providerAccountId": "provider_account_123",
            "order": 1,
            "weight": 1,
            "timeoutMs": 60000
          }
        ]
      }
    }
  }
}
```

## Target Coverage

Each route deployment is evaluated against the caller surface before provider forwarding:

- `native`: the provider exposes the same dialect as the caller.
- `translated`: the provider exposes a compatible dialect and the proxy translates requests, JSON responses, and SSE streams back to the caller shape.
- `unavailable`: no native or safe translated path exists, credentials are missing, the provider is disabled, or the request state requires native handling.

The shipped translated HTTP matrix is:

- OpenAI Responses ↔ OpenAI Chat
- Anthropic Messages ↔ OpenAI Chat
- Anthropic Messages ↔ OpenAI Responses for stateless HTTP requests

Runtime resolution prefers native endpoints in a route tier before translated endpoints when a tier has multiple targets. This keeps operator-authored mixed configs stable while still allowing a tier with only Anthropic targets to serve Codex HTTP `/v1/responses`, and a tier with only OpenAI targets to serve Claude Code `/v1/messages`.

Codex WebSocket traffic and Responses requests with `previous_response_id` are still native Responses-only. The console target rows use the shared compatibility helper to label Codex, Claude, and Chat coverage instead of assuming a provider is skipped because it lacks one specific endpoint.

Selection uses the lowest available `order` group first. Within the selected order group, deployments with positive `weight` are chosen by deterministic weighted selection. Deployments that receive provider 429s, configured provider 5xxs, connection errors, or configured timeouts enter an in-memory cooldown window and are skipped by later selections until the cooldown expires. Session route pinning stores the single selected deployment so kept sessions preserve provider cache stability across routing-config publishes.

Retry uses the selected route's `retry.maxAttempts` as a per-request budget. Provider 429s, configured retryable status codes, connection errors, and timeouts can retry only before response bytes are sent. The proxy tries remaining deployments by ascending `order`; if the route is exhausted, it appends `limits.fallbackRoute` deployments when that route is allowed by budget policy. Once streaming bytes are written to the client, the proxy records the provider attempt failure but does not retry invisibly. Final responses include `x-prompt-proxy-route`, `x-prompt-proxy-model`, and `x-prompt-proxy-deployment` for the deployment that actually served the client response.

## Gateway Traffic Limits

The proxy can reject traffic before it spends classifier or provider capacity. Leave a limit empty to disable that check. `GATEWAY_LIMIT_WINDOW_MS` controls the fixed window for request-per-minute and token-per-minute checks.

Request-stage limits run immediately after authentication and idempotency:

- `GATEWAY_GLOBAL_CONCURRENCY_LIMIT`, `GATEWAY_ORGANIZATION_CONCURRENCY_LIMIT`, `GATEWAY_WORKSPACE_CONCURRENCY_LIMIT`, `GATEWAY_API_KEY_CONCURRENCY_LIMIT`, `GATEWAY_USER_CONCURRENCY_LIMIT`
- `GATEWAY_GLOBAL_RPM_LIMIT`, `GATEWAY_ORGANIZATION_RPM_LIMIT`, `GATEWAY_WORKSPACE_RPM_LIMIT`, `GATEWAY_API_KEY_RPM_LIMIT`, `GATEWAY_USER_RPM_LIMIT`
- `GATEWAY_GLOBAL_TPM_LIMIT`, `GATEWAY_ORGANIZATION_TPM_LIMIT`, `GATEWAY_WORKSPACE_TPM_LIMIT`, `GATEWAY_API_KEY_TPM_LIMIT`, `GATEWAY_USER_TPM_LIMIT`

Provider/model limits run after routing selects the final provider and model, but before the provider request is sent:

- `GATEWAY_PROVIDER_MODEL_CONCURRENCY_LIMIT`
- `GATEWAY_PROVIDER_MODEL_RPM_LIMIT`
- `GATEWAY_PROVIDER_MODEL_TPM_LIMIT`

Rejected requests return 429 with `{ error, scope, limit, current }`. RPM and TPM rejections include `retry-after`; concurrency rejections do not, because release timing depends on active request completion. Concurrency leases are released on success, provider failure, client cancellation, and timeout terminal paths.

These counters are local to each proxy process. In a multi-task deployment, the effective fleet cap is approximately `limit * task_count`; set per-task values accordingly until a Redis/Postgres-backed shared limiter exists.

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
curl -sS -c /tmp/prompt.cookies \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/admin/graphql \
  -d "{\"query\":\"mutation { login(email: \\\"${ADMIN_DEV_LOGIN_EMAIL:-local@example.com}\\\", password: \\\"${ADMIN_DEV_LOGIN_PASSWORD:-dev-password}\\\") { organizationId } }\"}"
```

List routing configs and API keys:

```shell
curl -sS -b /tmp/prompt.cookies \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/admin/graphql \
  -d '{"query":"{ routingConfigs { id name status activeVersion { version } } apiKeys { id name routingConfigId } }"}'
```

Assign a config:

```shell
curl -sS -b /tmp/prompt.cookies \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/admin/graphql \
  -d '{"query":"mutation { assignApiKeyRoutingConfig(apiKeyId: \"local:api-key:default\", routingConfigId: \"local:routing-config:default\") { id routingConfigId } }"}'
```

Clear a key-level assignment and fall back to the organization default:

```shell
curl -sS -b /tmp/prompt.cookies \
  -H 'content-type: application/json' \
  -X PATCH http://127.0.0.1:8787/admin/api-keys/local:api-key:default/routing-config \
  -d '{"routingConfigId":null}'
```

## Create Or Promote A Version

Create a new config:

```shell
curl -sS -b /tmp/prompt.cookies \
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
curl -sS -b /tmp/prompt.cookies \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/admin/routing-configs/local:routing-config:default/versions \
  -d @routing-config-version.json
```

`routing-config-version.json` should contain `{ "config": { ... } }` with the full replacement config body. The web console detail page drives this same endpoint when saving routing rule or tier model edits.

Activate a version:

```shell
curl -sS -b /tmp/prompt.cookies \
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

- `auth failed`: check `PROXY_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, Codex `env_key`, and Claude `ANTHROPIC_API_KEY`.
- `config resolution failed`: check the API key assignment, organization default, active version id, config status, and config schema validity.
- `classifier failed`: check `classifier.provider`, `classifier.model`, upstream OpenAI credentials/base URL, timeout, and max attempts in the active config.
- `provider forwarding failed`: check the selected provider model, provider credentials, deployment `baseUrl`, deployment `timeoutMs`, and surface compatibility.
- a secondary deployment is selected unexpectedly: check whether the primary deployment is in cooldown due to a recent 429, 5xx, timeout, or connection error.
