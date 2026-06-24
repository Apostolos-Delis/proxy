# Proxy

Proxy is an OpenAI/Anthropic-compatible routing gateway for coding agents. Point Codex, Claude Code, opencode, Cursor BYOK, or SDK callers at one base URL; Proxy classifies each request, routes it to an appropriate model tier, and records the route decision, provider attempts, usage, cost, sessions, and prompt artifacts in an operations console.

It is built for teams that want to run agent traffic through a controllable gateway instead of hard-coding one model/provider into every harness.

## Highlights

- **Drop-in API compatibility** for OpenAI Responses (`/v1/responses`, HTTP and WebSocket), OpenAI Chat Completions (`/v1/chat/completions`), and Anthropic Messages (`/v1/messages`).
- **LLM-routed model selection** across `fast`, `balanced`, `hard`, and `deep` tiers, with explicit tier pinning through model aliases such as `router-hard` and `claude-router-hard`.
- **Versioned routing configs** with immutable versions, API-key/workspace assignment, budget limits, and active-version auditability.
- **Operations console** for usage, savings, sessions, request logs, prompt capture, API keys, provider credentials, routing configs, users, and org settings.
- **BYOK provider credentials** encrypted at rest and bindable per Proxy API key.
- **Multi-tenant data model** scoped by organization and workspace, with events as the audit/projection backbone.

## Screenshots

Demo data shown below was generated locally with the PGlite demo stack; it does not contain real traffic.

![Proxy overview dashboard showing traffic, token volume, spend, and routing savings](docs/assets/proxy-overview.png)

![Proxy logs page showing replayable agent sessions, models, routes, tokens, and cost](docs/assets/proxy-logs.png)

## Quick Start

Prerequisites:

- Node.js and `pnpm` 10.x
- Docker or Colima for the default local Postgres path
- OpenAI and Anthropic keys when you want to route real model traffic

```shell
pnpm install
pnpm dev:local
```

`pnpm dev:local` boots a complete local workspace:

| Component | URL / port |
| --- | --- |
| Proxy API | `http://127.0.0.1:8787` |
| Web console | `http://127.0.0.1:5173` |
| Postgres | `localhost:55432` |

The script creates `.env` from `.env.example` if needed, starts or reuses Postgres, runs migrations, and seeds an organization, default workspace, owner user, provider placeholders, a default routing config, and a local API key.

Log into the console with the development credentials from `.env`:

```text
ADMIN_DEV_LOGIN_EMAIL=local@example.com
ADMIN_DEV_LOGIN_PASSWORD=dev-password
```

To forward real traffic, set provider keys in `.env`:

```shell
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

The proxy and console can also run separately:

```shell
pnpm dev:proxy
pnpm dev:web
```

For production (`NODE_ENV=production`), Proxy rejects the development defaults for `PROXY_TOKEN`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY`.

### Conductor Workspaces

In Conductor workspaces, the checked-in Run script still uses `pnpm dev:local`, but derives isolated ports from `CONDUCTOR_PORT`: web on `CONDUCTOR_PORT`, proxy on `CONDUCTOR_PORT + 1`, and Postgres on `CONDUCTOR_PORT + 2`.

## Connect a Coding Agent

The proxy hosts an idempotent setup script. By default it configures Claude Code, Codex, and opencode, stores the shared key at `~/.proxy/token`, and updates only Proxy-owned marker blocks.

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- <api-key>
```

Use harness-specific installs when you want different Proxy API keys or routing configs per harness:

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness codex <codex-api-key>
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness claude-code <claude-api-key>
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness opencode <opencode-api-key>
```

Pass `--harness` more than once to configure a selected set with one shared key:

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness claude-code --harness codex --harness opencode <api-key>
```

The console's API-key screen lets you choose one or more harnesses during key creation and shows copyable setup snippets after the key is created.

### Claude Code Manual Setup

In `~/.claude/settings.json`:

```json
{
  "model": "claude-router-auto",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  },
  "apiKeyHelper": "cat ~/.proxy/token"
}
```

Claude Code strips `ANTHROPIC_BASE_URL` from project-scoped settings, so this must be user-level or managed settings. For a one-off session:

```shell
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_API_KEY=$PROXY_TOKEN \
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
claude --model claude-router-auto
```

### Codex Manual Setup

In `~/.codex/config.toml`:

```toml
# >>> prompt codex defaults >>>
model = "router-auto"
model_provider = "proxy"
# <<< prompt codex defaults <<<

# >>> prompt codex provider proxy >>>
[model_providers.proxy]
name = "Proxy"
base_url = "http://127.0.0.1:8787/v1"
env_key = "PROXY_TOKEN"
wire_api = "responses"
supports_websockets = true
# <<< prompt codex provider proxy <<<
```

### opencode and Cursor

- [opencode setup](docs/harnesses/opencode.md) covers the OpenAI-compatible Chat path, OpenAI Responses path, and Anthropic Messages path.
- [Cursor BYOK setup](docs/harnesses/cursor-byok.md) covers Cursor's OpenAI-compatible base-URL override and custom `router-*` model aliases.
- [Harness compatibility matrix](docs/harnesses/compatibility-matrix.md) tracks currently supported harness surfaces.

### Model Aliases

`router-auto` works on OpenAI Responses and Chat Completions surfaces. `claude-router-auto` works on Anthropic Messages. Both let the classifier pick the tier per request.

To pin a tier, use `router-fast`, `router-balanced`, `router-hard`, `router-deep`, or the matching `claude-router-*` alias.

## How Routing Works

1. A request arrives at `/v1/responses`, `/v1/chat/completions`, or `/v1/messages` and is authenticated by Proxy API key.
2. The API key resolves organization, workspace, user attribution, and routing config. Precedence is API-key assignment, then workspace default, then seeded default.
3. An LLM classifier returns a structured tier decision unless the caller pinned a tier through the model alias.
4. The active routing config maps the tier to ordered provider targets. Native dialect endpoints are preferred; registered same-family translators can bridge OpenAI Responses and Chat when compatible.
5. The route decision, provider attempts, usage, routing config identity, and prompt artifacts are persisted for audit and console projections.

Provider HTTP forwarding retries upstream `429` responses before sending headers to the client. It honors `Retry-After`, provider reset headers, and then jittered exponential backoff. Tune with `PROVIDER_RATE_LIMIT_MAX_ATTEMPTS`, `PROVIDER_RATE_LIMIT_BASE_DELAY_MS`, and `PROVIDER_RATE_LIMIT_MAX_DELAY_MS`.

Routing configs are edited in the console. Saving creates a new immutable version, which can be activated in the same step. Environment variables such as `OPENAI_FAST_MODEL` and `ANTHROPIC_HARD_MODEL` seed local defaults only; persisted runtime requests resolve from the database.

## Operations Console

The web console at `:5173` is an org- and workspace-scoped operations surface with global search, workspace switching, and organization switching.

| Page | Purpose |
| --- | --- |
| Overview | Savings story, route quality watchlist, traffic at a glance |
| Usage / Cost | Per-dimension usage analytics and cost dashboards |
| Sessions / Logs | Harness sessions, replay timeline, request evidence |
| Prompts | Captured prompt artifacts with syntax-highlighted JSON |
| API keys | Key creation, revocation, routing config assignment, provider credential binding, setup snippets |
| Model providers | Provider registry, BYOK keys, subscription credentials, account health |
| Routing configs | Tier models, effort, limits, version history, activation |
| Users | Invitations, roles, deactivation |
| Settings | Runtime settings, prompt capture, org system prompt |

## Data and Security Model

- Every durable table and event is scoped by `organization_id` or in-memory `tenantId`.
- Traffic-scoped tables are additionally scoped by `workspace_id`.
- API keys are stored as hashes, never raw tokens.
- Provider keys are stored as encrypted secret material or secret references.
- Raw prompt text is supported for this test project, but full prompt content is stored only through `prompt_artifacts.raw_text`; event payloads should not contain full prompts.
- Debug endpoints are development tools and must not be exposed with default development credentials.

Customer BYOK secrets are encrypted at rest with AES-256-GCM using `PROVIDER_SECRET_ENCRYPTION_KEY` (base64, 32 bytes):

```shell
openssl rand -base64 32
```

## API Surface

Proxy routes use API-key auth:

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses` and `WS /v1/responses`
- `POST /v1/chat/completions`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /setup.sh`

Admin routes use session-cookie auth:

- `POST /admin/graphql`
- `GET /admin/graphql` for GraphiQL in development
- `GET /admin/events` for console live updates

The GraphQL SDL lives at [apps/proxy/schema.graphql](apps/proxy/schema.graphql). Regenerate it with:

```shell
pnpm --filter @proxy/proxy schema:print
```

Development debug routes include `/_debug/events`, `/_debug/provider-attempts`, `/_debug/outbox`, `/_debug/sessions`, `/_debug/projections`, and `/_debug/route-quality`. They are enabled automatically only when `DATABASE_URL` is unset; set `DEBUG_ENDPOINTS_ENABLED=true` to enable them with persistence.

Operational metrics are disabled by default. `GET /metrics` emits OpenMetrics/Prometheus text when `METRICS_ENABLED=true`, `METRICS_EXPORTER=prometheus`, and `METRICS_TOKEN` are configured. See the [proxy metrics runbook](docs/runbooks/proxy-metrics.md).

## Persistence

`packages/db` is the Drizzle/Postgres layer. When `DATABASE_URL` is set, proxy events and current-state rows for requests, route decisions, provider attempts, usage, sessions, prompt artifacts, events, and outbox items are written in the same transaction.

```shell
pnpm db:up        # start Postgres via Docker Compose
pnpm db:migrate   # apply migrations
pnpm db:seed      # idempotent baseline seed
pnpm db:console   # interactive Drizzle console with schema tables preloaded
pnpm db:runner -- 'await db.select().from(organizations).limit(5)'
```

Editable runtime settings live as JSON at `.proxy/settings.json` or `PROXY_SETTINGS_PATH`. Environment variables take precedence, and classifier, budget, and route-quality changes apply after restart.

When seeding multiple organizations into one database, use a distinct `PROXY_TOKEN` per org.

## Spend Accounting

Providers return token counts, not dollar amounts, so Proxy computes spend locally. Usage ledger rows price uncached input, cache reads, cache writes, and output at their own per-MTok rates. Routing savings compare the actual selected model cost against replaying the same tokens through the balanced route model.

Pricing resolves in this order:

1. Built-in defaults in [apps/proxy/src/pricing.ts](apps/proxy/src/pricing.ts)
2. `MODEL_COSTS_JSON` at boot
3. Per-organization overrides edited live on the console's Billing page

Ledger rows keep the rates in effect when they were written; dashboards recompute baselines with current pricing.

## Development

```shell
pnpm lint
pnpm typecheck
pnpm test
pnpm smoke
pnpm smoke:harnesses
pnpm build
```

`pnpm smoke` spins up mock OpenAI and Anthropic upstreams, drives Codex-shaped and Claude Code-shaped requests through the proxy, and verifies routing-config resolution end to end. `pnpm smoke:harnesses` runs the real installed `codex` and `claude` CLIs against the same mock-backed proxy.

Architecture rules and conventions live in [AGENTS.md](AGENTS.md). The docs index is [docs/index.md](docs/index.md), starting with the [model routing proxy design](docs/model-routing.md).

## Deployment

A prod-like AWS deployment is defined with CDK in `infra/cdk`:

```shell
pnpm cdk:synth
pnpm cdk:diff
pnpm cdk:deploy
pnpm ops:migrate:aws
pnpm sync:web:aws
```

See the [AWS deployment runbook](docs/runbooks/aws-deployment.md) and [deployment scope plan](docs/scopes/aws-prod-like-deployment-v1/PLAN.md).

## Repository Layout

```text
apps/proxy/      Fastify proxy: routing, classifier, provider adapters, admin GraphQL
apps/web/        TanStack Router/Query/Table operations console
packages/db/     Drizzle schema, migrations, persistence services
packages/schema/ Shared constants and cross-package types
infra/cdk/       AWS CDK stacks
docs/            Architecture, scope plans, runbooks, future work
scripts/         Local bootstrap and operations helpers
```

## License

Proxy is licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (`FSL-1.1-ALv2`). Each release converts to Apache License 2.0 two years after it is made available.

FSL is source-available and allows use, copying, modification, and redistribution for any purpose other than offering the software, or substantially similar functionality, as a competing commercial product or service. If you want an OSI-approved open-source license from day one, replace `LICENSE` and the `license` field in `package.json` before publishing the repository.
