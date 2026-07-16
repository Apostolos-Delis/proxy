# Quickstart

## Prerequisites

- Node.js and `pnpm` 10.x
- Docker or Colima
- OpenAI or Anthropic credentials for real upstream traffic

## Start The Stack

```shell
pnpm install
pnpm dev:local
```

| Component | Address |
| --- | --- |
| Proxy API | `http://127.0.0.1:8787` |
| Console | `http://127.0.0.1:5173` |
| Postgres | `localhost:55432` |

The bootstrap script migrates the database and seeds an organization, default workspace, provider connections, model deployments, logical models, access profiles, owner user, and hashed local API key.

## Log In

Open the console and use the development credentials from `.env`:

```text
ADMIN_DEV_LOGIN_EMAIL=local@example.com
ADMIN_DEV_LOGIN_PASSWORD=dev-password
```

## Configure Upstream Credentials

```shell
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

Restart the local stack after changing environment-backed secret values. Production rejects the development token and placeholder provider credentials.

## Check The Caller Catalog

```shell
curl -sS http://127.0.0.1:8787/v1/models \
  -H "authorization: Bearer ${PROXY_TOKEN}"
```

The seeded engineer key should see `fable`, `coding-auto`, and `economy-auto`. The catalog is filtered through the key's access profile.

## Send Requests

OpenAI Responses:

```shell
curl -sS http://127.0.0.1:8787/v1/responses \
  -H "authorization: Bearer ${PROXY_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"model":"coding-auto","input":"Say hello through Proxy."}'
```

Anthropic Messages:

```shell
curl -sS http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: ${PROXY_TOKEN}" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"fable","max_tokens":128,"messages":[{"role":"user","content":"Say hello through Proxy."}]}'
```

Open **Logs** and inspect the requested logical model, deployment, provider connection, ingress/egress wires, terminal status, usage, and cost.

## Next Steps

- [Issue a key and configure an SDK or harness](api-keys.md).
- [Configure provider connections](provider-auth.md).
- [Author gateway resources with GraphQL or TOML](../runbooks/gateway-control-plane.md).
