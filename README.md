# prompt-proxy

- [Model routing proxy design](docs/model-routing-proxy.md)
- [Implementation tickets](docs/implementation-tickets.md)
- [Future: GEPA-inspired prompt optimization](docs/future/gepa-prompt-optimization.md)

## Development

```shell
pnpm install
pnpm dev:proxy
```

The web console runs separately:

```shell
pnpm dev:web
```

The proxy exposes:

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses` for Codex/OpenAI Responses
- `WS /v1/responses` for Codex/OpenAI Responses continuations
- `POST /v1/messages` for Claude Code/Anthropic Messages
- `POST /v1/messages/count_tokens` for Claude Code token counting

Authenticated debug endpoints expose route evidence during local development:

- `GET /_debug/events`
- `GET /_debug/provider-attempts`
- `GET /_debug/outbox`
- `GET /_debug/sessions`
- `GET /_debug/projections`
- `GET /_debug/route-quality`

Admin endpoints power the web console:

- `GET /admin/overview`
- `GET /admin/requests`
- `GET /admin/requests/:requestId`
- `GET /admin/settings`

## Persistence

The repo includes a Drizzle/Postgres persistence layer in `packages/db`.

```shell
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm dev:proxy
```

When `DATABASE_URL` is set, appended proxy events also persist durable current-state rows for requests, route decisions, provider attempts, usage, sessions, prompt artifacts, events, and outbox items.

## Local Harnesses

Codex profile:

```toml
model = "router-auto"
model_provider = "prompt_proxy"

[model_providers.prompt_proxy]
name = "Prompt Proxy"
base_url = "http://127.0.0.1:8787/v1"
env_key = "PROMPT_PROXY_TOKEN"
wire_api = "responses"
supports_websockets = true
```

Claude Code:

```shell
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_API_KEY=$PROMPT_PROXY_TOKEN \
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
claude --model claude-router-auto
```

Useful optional controls include `BUDGET_MAX_ROUTE`, `BUDGET_MAX_ESTIMATED_INPUT_TOKENS`, `BUDGET_USER_ESTIMATED_INPUT_LIMITS`, `BUDGET_TEAM_ESTIMATED_INPUT_LIMITS`, `MODEL_COSTS_JSON`, `ROUTE_POLICY_SOURCE`, and `TRUSTED_REPO_POLICY_HASH`.

## Verification

```shell
pnpm typecheck
pnpm test
pnpm smoke
pnpm smoke:harnesses
pnpm build
```

`npm run smoke` starts mock OpenAI and Anthropic upstreams, sends Codex-shaped and Claude Code-shaped requests through the proxy, and verifies that both are routed.

`npm run smoke:harnesses` runs the installed `codex` and `claude` CLIs against the same mock-backed proxy and verifies that each harness is routed.
