# Quickstart

This path gets a local Proxy workspace running with a seeded organization, web console, Postgres database, default routing config, and local API key.

## Prerequisites

- Node.js
- `pnpm` 10.x
- Docker or Colima for local Postgres
- OpenAI and Anthropic API keys when you want real upstream traffic

## Start The Local Stack

```shell
pnpm install
pnpm dev:local
```

`pnpm dev:local` starts:

| Component | Local address |
| --- | --- |
| Proxy API | `http://127.0.0.1:8787` |
| Console | `http://127.0.0.1:5173` |
| Postgres | `localhost:55432` |

The script creates `.env` from `.env.example` when needed, starts or reuses Postgres, runs migrations, and seeds a local organization, default workspace, owner user, providers, routing config, and API key.

## Log In

Open `http://127.0.0.1:5173` and use the development credentials from `.env`:

```text
ADMIN_DEV_LOGIN_EMAIL=local@example.com
ADMIN_DEV_LOGIN_PASSWORD=dev-password
```

The console should open on the overview dashboard.

## Add Provider Keys

For real traffic, set provider keys in `.env`, then restart `pnpm dev:local`:

```shell
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

Production rejects placeholder defaults for `PROXY_TOKEN`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY`.

## Send A Health Check

```shell
curl -fsS http://127.0.0.1:8787/healthz
```

## Send A Test Request

Use the seeded Proxy API key from `.env` or the API key created in the console.

OpenAI Responses-compatible request:

```shell
curl -sS http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer ${PROXY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "router-auto",
    "input": "Say hello through Proxy."
  }'
```

Anthropic Messages-compatible request:

```shell
curl -sS http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: ${PROXY_TOKEN}" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-router-auto",
    "max_tokens": 128,
    "messages": [{ "role": "user", "content": "Say hello through Proxy." }]
  }'
```

Then open **Logs** or **Sessions** in the console to inspect the request.

## Next Steps

- Create harness-specific keys in [API Keys And Harness Setup](api-keys.md).
- Connect BYOK or subscription provider credentials in [Provider Auth](provider-auth.md).
- Learn which dashboard to watch in [Monitoring](monitoring.md).
