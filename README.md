# prompt-proxy

- [Model routing proxy design](docs/model-routing-proxy.md)
- [Implementation tickets](docs/implementation-tickets.md)

## Development

```shell
npm install
npm run dev
```

The proxy exposes:

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses` for Codex/OpenAI Responses
- `POST /v1/messages` for Claude Code/Anthropic Messages
- `POST /v1/messages/count_tokens` for Claude Code token counting

Authenticated debug endpoints expose route evidence during local development:

- `GET /_debug/events`
- `GET /_debug/provider-attempts`
- `GET /_debug/outbox`
- `GET /_debug/sessions`
- `GET /_debug/projections`
- `GET /_debug/route-quality`

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
npm run typecheck
npm test
npm run smoke
npm run smoke:harnesses
npm run build
```

`npm run smoke` starts mock OpenAI and Anthropic upstreams, sends Codex-shaped and Claude Code-shaped requests through the proxy, and verifies that both are routed.

`npm run smoke:harnesses` runs the installed `codex` and `claude` CLIs against the same mock-backed proxy and verifies that each harness is routed.
