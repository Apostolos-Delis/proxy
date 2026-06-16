# Prompt Proxy

Prompt Proxy is a model-routing gateway that sits between coding agents (Claude Code, Codex, anything OpenAI/Anthropic-compatible) and the model providers. Every request is classified by an LLM router and forwarded to the cheapest model that can handle it, and everything that happens — route decisions, provider attempts, token usage, full prompts — is captured durably and explorable in a web console.

**What you get:**

- **Drop-in API compatibility** — speaks OpenAI Responses (`/v1/responses`, HTTP + WebSocket), OpenAI Chat Completions (`/v1/chat/completions`), and Anthropic Messages (`/v1/messages`), so existing harnesses just point at a new base URL.
- **Smart routing** — an LLM classifier sorts each request into a tier (`fast`, `balanced`, `hard`, `deep`) and the proxy picks the matching target from the active routing config. Users can also pin a tier explicitly (e.g. `router-hard` or `claude-router-hard`).
- **Versioned routing configs** — routing rules and tier→model mappings live in immutable, versioned configs bound to API keys, editable from the console.
- **An operations console** — dashboards for cost savings, usage, sessions, request logs, prompt capture, plus self-serve API keys, user invitations, and org settings.
- **BYOK** — customers can bring their own provider keys, encrypted at rest, bound per API key.
- **Multi-tenant by design** — every row and event is organization-scoped; orgs are switchable in the console.

## Quick start

```shell
pnpm install
pnpm dev:local
```

`pnpm dev:local` boots a complete local workspace:

| What | Where |
| --- | --- |
| Proxy API | `http://127.0.0.1:8787` |
| Web console | `http://127.0.0.1:5173` |
| Postgres (Docker) | port `55432` (avoids system Postgres) |

It creates `.env` from `.env.example` if needed, starts or reuses Postgres, runs migrations, and seeds an organization, a user, provider placeholders, a default routing config, and a local API key (`PROMPT_PROXY_TOKEN`, default `dev-proxy-token`).

In Conductor workspaces, the checked-in Run script still uses `pnpm dev:local`, but it derives isolated ports from `CONDUCTOR_PORT`: web on `CONDUCTOR_PORT`, proxy on `CONDUCTOR_PORT + 1`, and Postgres on `CONDUCTOR_PORT + 2`.

Log into the console with the dev credentials from `.env` — `ADMIN_DEV_LOGIN_EMAIL` / `ADMIN_DEV_LOGIN_PASSWORD` (defaults: `local@example.com` / `dev-password`).

To use real models, set `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in `.env`. The proxy and console can also run separately with `pnpm dev:proxy` and `pnpm dev:web`.

## Connect a coding agent

### One-liner

The proxy hosts its own setup script. By default it configures both Claude Code and Codex, stores the shared key at `~/.prompt-proxy/token`, and is idempotent:

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- <api-key>
```

Use a harness-specific install when you want different API keys and routing configs per harness:

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness codex <codex-api-key>
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness claude-code <claude-api-key>
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness opencode <opencode-api-key>
```

Pass `--harness` more than once to configure a selected set with one shared key:

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness claude-code --harness codex --harness opencode <api-key>
```

Codex-specific installs use `~/.prompt-proxy/codex.token`, `PROMPT_PROXY_CODEX_TOKEN`, and a `prompt_proxy_codex` Codex provider. Claude Code-specific installs use `~/.prompt-proxy/claude-code.token`. opencode installs write the chat-compatible provider to `~/.config/opencode/opencode.json` and store the credential in opencode's normal auth file.

The console's API-keys screen lets you choose one or more harnesses during key creation and shows matching copyable snippets after you create a key.

### Claude Code (manual)

In `~/.claude/settings.json` (must be user-level or managed settings — Claude Code strips `ANTHROPIC_BASE_URL` from project-scoped settings):

```json
{
  "model": "claude-router-auto",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  },
  "apiKeyHelper": "cat ~/.prompt-proxy/token"
}
```

`env` values are literal strings (no shell expansion), so the token goes through `apiKeyHelper`, whose output is sent as both `X-Api-Key` and `Authorization: Bearer`. For a one-off session without touching settings:

```shell
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_API_KEY=$PROMPT_PROXY_TOKEN \
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
claude --model claude-router-auto
```

### Codex (manual)

In `~/.codex/config.toml`:

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

### opencode and Cursor

- [opencode setup](docs/harnesses/opencode.md) covers the OpenAI-compatible Chat path, the OpenAI Responses path, and the Anthropic Messages path.
- [Cursor BYOK setup](docs/harnesses/cursor-byok.md) covers Cursor's OpenAI-compatible base-URL override and custom `router-*` model aliases.

### Model aliases

`router-auto` works on OpenAI Responses and Chat Completions surfaces. `claude-router-auto` works on the Anthropic Messages surface. Both let the classifier pick the tier per request. To pin a tier, use `router-fast`, `router-balanced`, `router-hard`, `router-deep`, or the matching `claude-router-*` alias.

## How routing works

1. A request arrives at `/v1/responses`, `/v1/chat/completions`, or `/v1/messages` and is authenticated by API key, which determines its workspace and user attribution.
2. The proxy resolves a **routing config** for that key. Precedence: API-key assignment → workspace default → seeded default; the config's active immutable version supplies the rules.
3. An LLM classifier (structured output with retry, `CLASSIFIER_*` env vars) assigns a tier, unless the caller pinned one via the model alias.
4. The tier maps to an ordered list of provider targets. The first compatible target wins; native dialect endpoints are preferred, and registered same-family translators can bridge OpenAI Responses ↔ Chat when the route is otherwise compatible.
5. The route decision, provider attempts, usage, and config identity (config id, version, hash) are persisted on the request for auditing.

Provider HTTP forwarding retries upstream `429` rate limits before sending response headers to the client. It honors `Retry-After`, then provider reset headers (`x-ratelimit-*` for OpenAI, `anthropic-ratelimit-*` for Anthropic), then falls back to jittered exponential backoff. Tune with `PROVIDER_RATE_LIMIT_MAX_ATTEMPTS`, `PROVIDER_RATE_LIMIT_BASE_DELAY_MS`, and `PROVIDER_RATE_LIMIT_MAX_DELAY_MS`; waits above the max delay cap are returned to the client with the provider's original 429 and headers.

Routing configs are edited in the console: saving creates a new immutable version, which can be activated in the same step. Environment variables like `OPENAI_FAST_MODEL` and `ANTHROPIC_HARD_MODEL` only seed local defaults — persisted runtime requests resolve from the database. See the [routing configs runbook](docs/runbooks/routing-configs.md) for assignment commands and troubleshooting.

Budget limits live in each routing config's `limits` block (`maxRoute`, `fallbackRoute`, `maxEstimatedInputTokens`, `routeEstimatedInputLimits`), edited on the Routing page; requests over a limit are rejected before provider spend. `MODEL_COSTS_JSON` remains an env-level pricing override.

## Workspaces

Each organization contains one or more workspaces (the Anthropic Console / OpenAI Platform model): membership, invitations, provider keys, and prompt-capture settings stay organization-wide, while API keys, routing configs, sessions, requests, usage, and prompt artifacts belong to a workspace. Every organization gets a seeded `Default` workspace and migrations move pre-workspace rows into it; the proxy derives each request's workspace and user from its API key, so traffic is attributed without any client identity headers. In the console, the switcher at the top of the sidebar changes the session's active workspace (`switchWorkspace`) and can create new workspaces inline (`createWorkspace`); every traffic screen shows only the active workspace.

## The console

The web app at `:5173` is an org-scoped operations console (with a ⌘K global search palette, a workspace switcher, and an organization switcher):

| Page | What it's for |
| --- | --- |
| Overview | Savings story, route quality watchlist, traffic at a glance |
| Usage / Cost | Per-dimension usage analytics and cost dashboards |
| Sessions | Harness sessions with a replay timeline per session |
| Logs | Request log with full route evidence per request |
| Prompts | Captured prompt artifacts with syntax-highlighted JSON |
| API keys | Create (multi-step wizard), revoke, assign routing configs and provider keys, harness setup guide |
| Provider keys | BYOK credential management |
| Routing configs | Edit rules, tier models, and effort; versioned activation |
| Users | Invitations, roles, deactivation |
| Settings | Runtime settings, prompt capture, org system prompt |

### User management

- **Invite** by email with a role (`owner`, `admin`, `member`, `viewer`). Owner/admin sessions can manage users, settings, routing configs, API keys, provider keys, prompt logs, and other sensitive console surfaces; lower roles are limited to non-sensitive read-only dashboards for now. Emails go through [Resend](https://resend.com) when `RESEND_API_KEY` is set; without a key the proxy logs the message and the console shows a copyable invite link.
- Invite links point at `ADMIN_CONSOLE_URL/invite/<token>`. Tokens are stored as hashes only, rotate on resend, and expire after `INVITATION_TTL_SECONDS` (default 7 days).
- **Deactivate** instead of delete: blocks console sessions but keeps the user row, API keys, and usage history. The last active owner can't be demoted or deactivated; admins can't deactivate themselves.
- Every mutation appends a `user.*` audit event to the event log.

### Provider keys (BYOK)

By default the proxy forwards builtin upstream calls with the company keys from env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). A customer can instead add their own key on the **Provider keys** screen and bind it to one of their prompt-proxy API keys (at most one credential per provider per key). Requests authenticated with that key then forward using the customer's credential. Organization-defined provider rows require an attached credential unless they are explicitly configured with `auth_style: "none"`.

Customer secrets are encrypted at rest with AES-256-GCM using `PROVIDER_SECRET_ENCRYPTION_KEY` (base64, 32 bytes — `openssl rand -base64 32`) and are never returned by the admin API, only a masked hint. BYOK applies to the HTTP forward surfaces; the OpenAI realtime WebSocket always uses the company key for now.

**Subscription credentials (internal-only):** an engineer can paste an OpenAI Codex access token + ChatGPT account ID as a provider credential, then bind it to an API key they own. Claude `setup-token` credentials are enabled by default and can be disabled with `SUBSCRIPTION_OAUTH_ENABLED=false`. Anthropic forwards as `Authorization: Bearer` instead of `x-api-key`; OpenAI HTTP Responses traffic forwards to `OPENAI_CHATGPT_BASE_URL` (default `https://chatgpt.com/backend-api/codex`) with `Authorization: Bearer` and `ChatGPT-Account-Id`. OAuth credentials are hard-rejected on keys the engineer doesn't own (no pooling). Disabling the flag disables Claude subscription credentials only; OpenAI Codex subscription credentials remain enabled. This is internal-only and must never be exposed to external customers — read the [subscription auth runbook](docs/runbooks/subscription-auth.md) before using Claude subscription auth (risk rationale: [scope plan](docs/scopes/subscription-auth-v1/PLAN.md)).

## API surface

**Proxy (API-key auth):**

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses` and `WS /v1/responses` — OpenAI Responses (Codex)
- `POST /v1/chat/completions` — OpenAI-compatible Chat Completions (opencode, Cursor BYOK, SDK callers)
- `POST /v1/messages` and `POST /v1/messages/count_tokens` — Anthropic Messages (Claude Code)
- `GET /setup.sh` — hosted harness setup script

**Admin (session-cookie auth):** everything the console reads or writes goes through the GraphQL API at `POST /admin/graphql`, including login/logout/org switching and the public invitation-accept flow (the only operations reachable without a session; anonymous introspection is rejected). The SDL lives at [`apps/proxy/schema.graphql`](apps/proxy/schema.graphql) (regenerate with `pnpm --filter @prompt-proxy/proxy schema:print`), and logged-in admins get GraphiQL by opening `/admin/graphql` in a browser.

**Debug (local development, authenticated):** `GET /_debug/events`, `/_debug/provider-attempts`, `/_debug/outbox`, `/_debug/sessions`, `/_debug/projections`, `/_debug/route-quality`. These endpoints are enabled automatically only when `DATABASE_URL` is unset; set `DEBUG_ENDPOINTS_ENABLED=true` to enable them with persistence, and never expose them with the default development proxy token.

## Persistence

`packages/db` is a Drizzle/Postgres layer. When `DATABASE_URL` is set, every proxy event also persists durable current-state rows for requests, route decisions, provider attempts, usage, sessions, prompt artifacts, events, and outbox items — written in the same transaction.

```shell
pnpm db:up        # start Postgres via Docker Compose
pnpm db:migrate   # apply migrations
pnpm db:seed      # idempotent baseline seed
pnpm db:console   # interactive Drizzle console with schema tables preloaded
pnpm db:runner -- 'await db.select().from(organizations).limit(5)'
```

Editable runtime settings live as JSON at `.prompt-proxy/settings.json` (or `PROMPT_PROXY_SETTINGS_PATH`); the `/settings` console page reads and writes that file. Environment variables take precedence, and classifier, budget, and route-quality changes apply after restart.

When seeding multiple organizations into one database, use a distinct `PROMPT_PROXY_TOKEN` per org.

## Spend and routing savings

Providers return token counts, not dollar amounts, so the proxy computes spend locally: every usage ledger row is priced as `uncached input + cache reads + cache writes + output`, each at its own per-MTok rate. Anthropic usage reports cache reads and writes outside `input_tokens`; the proxy folds them back in, so dashboard token totals always mean total input presented to the model. Routing savings compare each request's actual cost against replaying the same tokens through the balanced route model (the cost of not routing).

Pricing resolves in three layers, most specific wins per model:

1. Built-in defaults for the models the proxy ships configured with (`apps/proxy/src/pricing.ts`).
2. `MODEL_COSTS_JSON` at boot, e.g. `{"claude-haiku-4-5": {"inputCostPerMtok": 1, "outputCostPerMtok": 5, "cacheReadCostPerMtok": 0.1, "cacheWriteCostPerMtok": 1.25}}`. Cache rates default to 10% and 125% of the input rate when omitted.
3. Per-organization overrides edited live on the console's Billing page (stored in `model_catalog.pricing`), which also lists unpriced models seen in traffic.

Dated identifiers such as `claude-sonnet-4-5-20250929` fall back to their undated pricing entry. Ledger rows keep the rates in effect when they were written; dashboards recompute baselines with current pricing.

## Verification

```shell
pnpm lint
pnpm typecheck
pnpm test
pnpm smoke
pnpm smoke:harnesses
pnpm build
```

`pnpm smoke` spins up mock OpenAI and Anthropic upstreams, drives Codex-shaped and Claude Code-shaped requests through the proxy, and verifies routing-config resolution end to end — failures are labeled by phase (auth, config resolution, classifier, provider forwarding). `pnpm smoke:harnesses` runs the real installed `codex` and `claude` CLIs against the same mock-backed proxy. `pnpm smoke:deployed` targets a deployed environment via the `PROMPT_PROXY_DEPLOYED_*` env vars.

## Deployment

A prod-like AWS deployment is defined with CDK in `infra/cdk`:

```shell
pnpm cdk:synth
pnpm cdk:diff
pnpm cdk:deploy
pnpm ops:migrate:aws   # run migrations as an operations task
pnpm sync:web:aws      # publish console assets
```

See the [AWS deployment runbook](docs/runbooks/aws-deployment.md) and the [deployment scope plan](docs/scopes/aws-prod-like-deployment-v1/PLAN.md).

## Repository layout

```
apps/proxy/      Fastify proxy: routing, classifier, provider adapters, admin GraphQL
apps/web/        TanStack (Router/Query/Table) operations console
packages/db/     Drizzle schema, migrations, persistence services
packages/schema/ Shared constants and cross-package types
infra/cdk/       AWS CDK stacks
docs/            Architecture, scope plans, runbooks, future work
scripts/         dev-local bootstrap, AWS operations helpers
```

Architecture rules and conventions live in [AGENTS.md](AGENTS.md); the full docs index is at [docs/index.md](docs/index.md), starting with the [model routing proxy design](docs/model-routing-proxy.md).

## License

Licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2). You may use, copy, modify, and redistribute the software for any purpose other than offering it (or a substantially similar product or service) commercially. Each release converts to the Apache License 2.0 two years after it is made available. See [fsl.software](https://fsl.software) for details.
