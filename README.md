<img src="docs/assets/proxy-logo.svg" alt="Proxy logo" width="72" height="72" />

# Proxy

Proxy is an OpenAI- and Anthropic-compatible AI gateway. Applications and coding harnesses point their existing SDKs at one base URL and request a stable logical model. Proxy authorizes the caller, resolves that logical model to an eligible deployment, translates between supported API wires when necessary, invokes the provider, and records durable request, resolution, usage, cost, and prompt evidence.

## Highlights

- Drop-in OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages endpoints.
- Stable logical models decoupled from provider model IDs and deployments.
- Reusable access profiles that control which logical models and operations an API key may use.
- Direct models for deterministic selection and classifier-backed models for automatic selection.
- Explicit provider connections, canonical models, deployments, and wire bindings.
- Transactional GraphQL administration plus declarative TOML `plan` and `apply`.
- Organization- and workspace-scoped persistence with hashed API keys and protected provider secrets.
- An operations console for usage, cost, caching, sessions, request evidence, prompts, keys, users, and settings.

## Screenshots

Demo data shown below was generated locally with the PGlite demo stack and does not contain real traffic.

![Proxy overview dashboard showing traffic, token volume, spend, and routing savings](docs/assets/proxy-overview.png)

![Proxy logs page showing replayable sessions, models, tokens, and cost](docs/assets/proxy-logs.png)

## Quick Start

Prerequisites:

- Node.js and `pnpm` 10.x
- Docker or Colima for the default local Postgres path
- OpenAI or Anthropic credentials when forwarding real traffic

```shell
pnpm install
pnpm dev:local
```

`pnpm dev:local` starts the proxy at `http://127.0.0.1:8787`, the console at `http://127.0.0.1:5173`, and Postgres on port `55432`. It creates `.env` when needed, migrates the database, and seeds:

- provider connections and deployments for the configured upstreams;
- `fable`, `coding-auto`, and `economy-auto` logical models;
- `opendoor-engineer` and `external-economy` access profiles;
- an owner user, default workspace, and hashed local API key.

Set real upstream credentials in `.env`:

```shell
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

The development console login defaults to `local@example.com` and `dev-password`. Run the services separately with `pnpm dev:proxy` and `pnpm dev:web`.

In Conductor workspaces, the Run script derives isolated ports from `CONDUCTOR_PORT`: web uses `CONDUCTOR_PORT`, proxy uses `CONDUCTOR_PORT + 1`, and Postgres uses `CONDUCTOR_PORT + 2`.

## Connect Applications

Existing OpenAI and Anthropic SDKs need only a base URL, a Proxy API key, and an allowed logical model.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.PROXY_TOKEN,
  baseURL: "http://127.0.0.1:8787/v1"
});

const response = await client.responses.create({
  model: "coding-auto",
  input: "Summarize this incident."
});
```

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.PROXY_TOKEN,
  baseURL: "http://127.0.0.1:8787"
});

const response = await client.messages.create({
  model: "fable",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Review this proposal." }]
});
```

`GET /v1/models` returns only the logical models granted to that key. A denied or disabled model fails before classifier or provider I/O.

## Connect Harnesses

The hosted setup script configures Claude Code, Codex, and opencode without changing unrelated user settings:

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- <api-key>
```

Use separate keys when harnesses need different access profiles:

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness codex <engineer-key>
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness claude-code <economy-key>
```

Manual Claude Code settings:

```json
{
  "model": "coding-auto",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  },
  "apiKeyHelper": "cat ~/.proxy/token"
}
```

Manual Codex provider settings:

```toml
model = "coding-auto"
model_provider = "proxy"

[model_providers.proxy]
name = "Proxy"
base_url = "http://127.0.0.1:8787/v1"
env_key = "PROXY_TOKEN"
wire_api = "responses"
supports_websockets = false
```

See the [harness compatibility matrix](docs/harnesses/compatibility-matrix.md), [Claude Code guide](docs/harnesses/claude-code.md), [opencode guide](docs/harnesses/opencode.md), and [Cursor guide](docs/harnesses/cursor-byok.md).

## Resolution Model

Every text request follows one control path:

1. Identify the ingress API wire and operation.
2. Authenticate the API key and load its access profile.
3. Resolve the requested logical model inside the key's workspace.
4. Authorize the logical model and operation through a model grant.
5. Filter targets to enabled deployments, connections, and compatible wire bindings.
6. Select the single direct target or run the configured classifier over eligible targets only.
7. Persist admission and resolution evidence before provider I/O.
8. Translate when required, invoke the provider adapter, and persist attempts and usage.

The database is the only runtime configuration source. There are no model aliases, process-global route policy documents, or fallback reads from declarative files.

## Configure The Gateway

The admin GraphQL API manages provider connections, canonical models, deployments, wire bindings, logical models, targets, access profiles, grants, and API-key assignments. Logical models can be created with their initial targets, and access profiles with their initial grants, as one transaction. Mutations write the audit event, outbox row, and current-state mutation in the same transaction.

For declarative configuration:

```shell
pnpm --filter @proxy/proxy gateway-config plan ./gateway.toml
pnpm --filter @proxy/proxy gateway-config apply ./gateway.toml --actor-user-id user_123
```

`plan` is read-only. `apply` uses the same validation and transactional mutation service as GraphQL. Omitted resources are untouched, and a repeated unchanged apply is a no-op. The full document shape is in [Gateway Configuration TOML V1](docs/scopes/ai-gateway-core-model-v1/TOML.md); operational procedures are in the [gateway control-plane runbook](docs/runbooks/gateway-control-plane.md).

## Operations Console

The console is a dense, workspace-scoped operational surface:

| Page | Purpose |
| --- | --- |
| Overview | Traffic, tokens, cost, and low-confidence watchlist |
| Usage / Cost | Usage and spend grouped by logical model, deployment, provider, key, user, or surface |
| Caching | Prompt-cache behavior, cache busts, and compression savings |
| Logs / Sessions | Request resolution evidence, attempts, usage, and replay timelines |
| Prompts | Captured prompt artifacts and access audit |
| Models | Model-facing API endpoints, logical-model definitions, targets, wires, grants, and direct/router creation |
| API keys | Atomic key/profile/grant issuance for per-key model selection, reusable profile assignment, revocation, and post-creation harness setup |
| Users | Invitations, roles, activation, and deactivation |
| Settings / Billing | Runtime optimization settings and deployment pricing |

## Data And Security

- Durable rows and events are scoped by organization; traffic and gateway resources are also scoped by workspace.
- API keys are stored only as hashes.
- Provider credentials are stored as secret references or AES-256-GCM encrypted material, never plaintext rows.
- Full prompt text is stored only in `prompt_artifacts.raw_text`, never in event payloads.
- Resolution evidence records logical model, access profile, deployment, connection, ingress and egress wires, and adapter versions.
- Development debug endpoints must not be exposed with development credentials.

Generate the optional encryption key with `openssl rand -base64 32` and set `PROVIDER_SECRET_ENCRYPTION_KEY`.

## API Surface

Traffic routes use Proxy API-key authentication:

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses` and `WS /v1/responses`
- `POST /v1/chat/completions`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /setup.sh`

Admin routes use session-cookie authentication:

- `POST /admin/graphql`
- `GET /admin/graphql` for GraphiQL in development
- `GET /admin/events` for console live updates

The generated SDL is [apps/proxy/schema.graphql](apps/proxy/schema.graphql). Refresh it with `pnpm --filter @proxy/proxy schema:print`.

Operational metrics are exposed at `GET /metrics` when `METRICS_ENABLED=true`, `METRICS_EXPORTER=prometheus`, and `METRICS_TOKEN` are configured. See the [metrics runbook](docs/runbooks/proxy-metrics.md).

## Persistence And Cost

`packages/db` owns the Drizzle/Postgres schema. When persistence is enabled, request evidence, events, outbox rows, attempts, usage, sessions, and prompt artifacts are written transactionally.

```shell
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm db:console
```

Pricing belongs to model deployments. Usage ledger rows keep the cost calculated from the selected deployment's pricing at request time. Dashboards group physical spend by deployment and caller-facing usage by logical model.

## Development

```shell
pnpm lint
pnpm typecheck
pnpm test
pnpm smoke
pnpm smoke:harnesses
pnpm build
```

`pnpm smoke` drives OpenAI- and Anthropic-shaped traffic through mock upstreams and verifies logical-model authorization and resolution. `pnpm smoke:harnesses` runs installed Codex and Claude CLIs against the mock-backed gateway.

The [docs index](docs/index.md), [gateway architecture](docs/model-routing-proxy.md), and [core data model](docs/scopes/ai-gateway-core-model-v1/PLAN.md) contain the durable design.

## Deployment

A prod-like AWS deployment is defined in `infra/cdk`:

```shell
pnpm cdk:synth
pnpm cdk:diff
pnpm cdk:deploy
pnpm ops:migrate:aws
pnpm sync:web:aws
```

See the [AWS deployment runbook](docs/runbooks/aws-deployment.md).

## Repository Layout

```text
apps/proxy/      Fastify gateway, wire handling, resolution, adapters, GraphQL
apps/web/        TanStack operations console
packages/db/     Drizzle schema, migrations, seeds, and persistence helpers
packages/schema/ Shared code-owned contracts and cross-package types
infra/cdk/       AWS CDK stacks
docs/            Architecture, scopes, runbooks, and future work
scripts/         Local bootstrap and operations helpers
```

## License

Proxy is licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE). Each release converts to Apache License 2.0 two years after it is made available.
