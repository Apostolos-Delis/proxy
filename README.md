# prompt-proxy

- [Model routing proxy design](docs/model-routing-proxy.md)
- [Implementation tickets](docs/implementation-tickets.md)
- [Routing configs runbook](docs/runbooks/routing-configs.md)
- [AWS prod-like deployment scope](docs/scopes/aws-prod-like-deployment-v1/PLAN.md)
- [AWS prod-like deployment tickets](docs/scopes/aws-prod-like-deployment-v1/TICKETS.md)
- [AWS deployment runbook](docs/runbooks/aws-deployment.md)
- [Future: GEPA-inspired prompt optimization](docs/future/gepa-prompt-optimization.md)

## Development

```shell
pnpm install
pnpm dev:local
```

`pnpm dev:local` starts a local Prompt Proxy workspace:

- Creates `.env` from `.env.example` if needed.
- Creates or reuses local Postgres from `DATABASE_URL`; the default Compose port is `55432` to avoid colliding with system Postgres.
- Runs migrations and seeds baseline organization/user/provider data.
- Starts the proxy on `http://127.0.0.1:8787`.
- Starts the web console on `http://127.0.0.1:5173`.
- Enables local admin login with `ADMIN_DEV_LOGIN_EMAIL` and `ADMIN_DEV_LOGIN_PASSWORD`.

The proxy and web console can also run separately:

```shell
pnpm dev:proxy
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

Everything the web console reads or writes goes through the GraphQL API at
`POST /admin/graphql` — including session bootstrap (the `login`, `logout`,
and `switchOrganization` mutations set or clear the session cookie) and the
public invitation accept flow (`publicInvitation` query plus the
`acceptInvitation` mutation, both reachable without a session; everything else
requires an authenticated admin session and anonymous introspection is
rejected). Queries: viewer, overview, requests, request, prompts, prompt,
promptAccessAudit, publicInvitation, usage, usageTimeseries, users, user,
sessions, session, invitations, settings, routingConfigs, routingConfig,
apiKeys, apiKey, providerAccounts, search. Mutations: login, logout, switchOrganization,
acceptInvitation, updateSettings, configurePromptCapture, createRoutingConfig,
createRoutingConfigVersion, activateRoutingConfigVersion, archiveRoutingConfig,
assignApiKeyRoutingConfig, createApiKey, revokeApiKey, createProviderCredential,
revokeProviderCredential, assignApiKeyProviderAccount, createInvitation,
resendInvitation, revokeInvitation, updateUserRole, deactivateUser,
reactivateUser. The SDL lives at `apps/proxy/schema.graphql` (regenerate with
`pnpm --filter @prompt-proxy/proxy schema:print`), and logged-in admins get
GraphiQL by opening `/admin/graphql` in a browser.

## User Management

The `/users` console page manages organization membership:

- **Invite** users by email with a role (`owner`, `admin`, `member`, `viewer`). Roles are stored on `organization_members` and carry no permission checks yet.
- Invitation emails are sent through the [Resend](https://resend.com) API when `RESEND_API_KEY` is set (`EMAIL_FROM` controls the sender). Without a key the proxy logs the message instead, and the console shows a copyable invite link after every create/resend.
- Invite links point at `ADMIN_CONSOLE_URL/invite/<token>`. Tokens are stored as hashes only, rotate on resend, and expire after `INVITATION_TTL_SECONDS` (default 7 days). Pending invites can be resent or revoked from the console.
- Accepting an invite on the public `/invite/$token` page creates the user (or reuses an existing user with that email) and activates the membership with the invited role.
- **Deactivate** members instead of deleting them: deactivation blocks console sessions but keeps the user row, API keys, and usage history. The last active owner cannot be demoted or deactivated, and admins cannot deactivate themselves.
- Every mutation appends a `user.*` audit event (`prompt-proxy.admin.users` producer) to the event log.

## Persistence

The repo includes a Drizzle/Postgres persistence layer in `packages/db`.

```shell
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm dev:local
```

When `DATABASE_URL` is set, appended proxy events also persist durable current-state rows for requests, route decisions, provider attempts, usage, sessions, prompt artifacts, events, and outbox items.

Prompt Proxy stores editable runtime settings as JSON at `.prompt-proxy/settings.json` by default, or at `PROMPT_PROXY_SETTINGS_PATH` when set. The settings UI at `/settings` reads and writes that file through `GET /admin/settings` and `PATCH /admin/settings`; environment variables still take precedence, and classifier, budget, and route-quality changes apply after restart. Prompt capture settings are also applied to database-backed organization settings when persistence is enabled.

`pnpm db:seed` is idempotent. It creates the default organization from `DEFAULT_ORGANIZATION_ID`, a local seed user from `SEED_USER_*`, provider account placeholders that reference env secrets, a legacy route policy placeholder, model catalog rows, a default routing config with immutable v1, and a local API key assigned to that config. Use a distinct `PROMPT_PROXY_TOKEN` when seeding multiple organizations in the same database.

## Routing Configs

Runtime model routing resolves from persisted, API-key-bound routing configs. Environment variables such as `OPENAI_FAST_MODEL`, `ANTHROPIC_HARD_MODEL`, and `CLASSIFIER_MODEL` seed local defaults, but persisted runtime requests do not read `ROUTE_POLICY_JSON`.

Config precedence for each request:

1. authenticated API key assignment
2. organization default routing config
3. seeded default routing config
4. active immutable config version

The selected config id, version id, version number, and config hash are stored on request and route-decision rows. Use the web console API-key screen or `PATCH /admin/api-keys/:apiKeyId/routing-config` to assign a config. See the [routing configs runbook](docs/runbooks/routing-configs.md) for local setup, assignment commands, and troubleshooting.

Routing configs can also carry a top-level `systemPrompt` that the proxy prepends to every routed request (OpenAI Responses `instructions`, Anthropic Messages `system`) ahead of harness prompts. The console's routing config screens edit the system prompt and the per-tier OpenAI/Anthropic models; saving creates a new immutable version that can be activated in the same step.

## Provider Keys (BYOK)

By default the proxy forwards every upstream call with the company-owned provider keys from env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). A customer can instead bring their own key: add it under the console's **Provider keys** screen (the `createProviderCredential` GraphQL mutation), then bind it to one of your prompt-proxy API keys for a given provider (the `assignApiKeyProviderAccount` mutation, surfaced on the API-keys screen). When a request authenticates with that API key, the proxy forwards to the matching provider using the customer's key (Anthropic `x-api-key`, OpenAI `Authorization: Bearer`); unbound keys keep using the company key. A key may bind at most one credential per provider.

Customer secrets are encrypted at rest with AES-256-GCM using `PROVIDER_SECRET_ENCRYPTION_KEY` (base64, 32 bytes — generate with `openssl rand -base64 32`); they are never returned by the admin API, which exposes only a masked hint and the owning user. Only API-key credentials are supported today — Claude subscription/OAuth tokens are a planned follow-up.

BYOK currently applies to the HTTP forward surfaces (`/v1/responses`, `/v1/messages`, `/v1/messages/count_tokens`). The OpenAI realtime WebSocket surface always uses the company key for now.

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

Claude Code, in `~/.claude/settings.json`:

```json
{
  "model": "claude-router-auto",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  },
  "apiKeyHelper": "echo \"$PROMPT_PROXY_TOKEN\""
}
```

Then run `claude` with no extra flags. `env` values are literal strings (no shell expansion), so the token goes through `apiKeyHelper`, a shell command whose output is sent as both `X-Api-Key` and `Authorization: Bearer`. These settings must live in user-level or managed settings: Claude Code filters `ANTHROPIC_BASE_URL` out of project-scoped settings to prevent traffic redirection.

For a one-off session without touching settings:

```shell
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_API_KEY=$PROMPT_PROXY_TOKEN \
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
claude --model claude-router-auto
```

Useful optional controls include `BUDGET_MAX_ROUTE`, `BUDGET_MAX_ESTIMATED_INPUT_TOKENS`, `BUDGET_USER_ESTIMATED_INPUT_LIMITS`, `BUDGET_TEAM_ESTIMATED_INPUT_LIMITS`, and `MODEL_COSTS_JSON`.

## Verification

```shell
pnpm lint
pnpm typecheck
pnpm test
pnpm smoke
pnpm smoke:harnesses
pnpm build
```

`pnpm smoke` starts mock OpenAI and Anthropic upstreams, sends Codex-shaped and Claude Code-shaped requests through the proxy, verifies the seeded API key uses the default routing config, reassigns that API key to a smoke-only routing config, and verifies the next OpenAI Responses and Anthropic Messages requests use the reassigned config. Smoke failures are labeled by phase: auth, config resolution, classifier, or provider forwarding.

`pnpm smoke:harnesses` runs the installed `codex` and `claude` CLIs against the same mock-backed proxy and verifies that each harness persists a hard-route decision against the seeded default routing config.
