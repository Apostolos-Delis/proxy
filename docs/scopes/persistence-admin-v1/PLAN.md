# Persistence And Admin Console V1

## Goal

Add a durable Postgres-backed persistence layer and an internal web console for inspecting model routing behavior, usage, and configuration.

## Architecture

The repo now uses a pnpm workspace:

```text
apps/proxy/        Fastify-compatible OpenAI/Anthropic routing proxy
apps/web/          TanStack operations console
packages/db/       Drizzle schema, SQL migrations, database client
packages/schema/   shared constants and cross-package types
```

Persistence follows the current-state plus event-log pattern:

```text
proxy request
  -> EventService append
  -> Postgres event sink
  -> current-state row mutation
  -> events row
  -> event_outbox row
```

The proxy still keeps in-memory mirrors for existing debug endpoints and tests. When `DATABASE_URL` is set, each appended event also writes to Postgres.

## Durable Tables

Initial Drizzle schema includes:

```text
organizations
workspaces                  one organization -> many workspaces; traffic-scoped resources hang off a workspace
users
organization_members
invitations
api_keys
api_key_provider_accounts   binds an API key to a BYOK provider credential, one row per (key, provider)
organization_settings
user_settings
provider_accounts            company env-backed rows plus customer BYOK credentials (encrypted secret + owner)
model_catalog                seeded route models plus per-organization model pricing overrides (pricing jsonb)
routing_configs
routing_config_versions
agent_sessions
turns
requests
route_decisions
provider_attempts
usage_ledger
prompt_artifacts
prompt_access_audit
user_sessions
events
event_outbox
projection_cursors
```

Every durable operational row is scoped by `organization_id`. Event rows use the existing proxy `tenantId` field as the organization identifier.

### Workspaces

Organizations contain workspaces (modeled on the Anthropic Console / OpenAI Platform hierarchy): identity and membership stay at the organization, traffic and traffic configuration live in a workspace.

- Workspace-scoped (`workspace_id NOT NULL`): `api_keys`, `routing_configs`, `routing_config_versions`, `api_key_provider_accounts`, `agent_sessions`, `turns`, `requests`, `route_decisions`, `provider_attempts`, `usage_ledger`, `prompt_artifacts`, `prompt_access_audit`.
- Org-scoped (unchanged): `users`, `organization_members`, `invitations`, `organization_settings` (prompt capture + retention), `user_settings`, `provider_accounts` (BYOK credentials are shared infrastructure; only the key→credential bindings are workspace rows), `model_catalog`, `projection_cursors`.
- `events.workspace_id` is nullable: traffic and workspace-entity events carry it; org-level events (members, invitations, provider accounts) leave it null.
- Every organization has a default workspace with the deterministic id `${organizationId}:workspace:default` (`defaultWorkspaceId()` in `@prompt-proxy/db`); migration `0006_workspaces.sql` backfills all pre-workspace rows into it.
- The proxy resolves the request workspace from the API key (`api_keys.workspace_id`); the dev proxy token maps to the default workspace. Request idempotency keys are hashed per workspace.
- Each workspace owns its default routing config (`workspaces.default_routing_config_id`, replaces the old `organization_settings.default_routing_config_id`). Composite FKs enforce that routing config versions, key→config assignments, and workspace defaults stay within one workspace.
- Admin sessions track an active workspace (`user_sessions.workspace_id`, null = default). `switchWorkspace` repoints the session; `switchOrganization` still issues a fresh session. All workspace-scoped admin queries read the session's active workspace; members, invitations, settings, and provider credentials remain org-wide.

### Prompt artifact capture

Each request captures every conversation message it carries as a `prompt_artifacts` row with a `kind` describing the source: `system` / `instructions` (system prompts), `user_message` (typed user text), `injected_context` (harness-injected `<system-reminder>` blocks), `tool_use` (assistant tool calls), `tool_result` (tool output returned as user-role messages), `assistant_response` (assistant text, streamed or replayed in history), and `tool_schema_metadata` (hash-only tool schema summary). Because agent harnesses resend the full conversation on every request, capture dedupes by `(kind, content_hash)` across the request's session — each message is stored once, attributed to the request that first carried it, and the session view reconstructs the full conversation from those rows. Session identity comes from harness headers, falling back to the Claude Code `metadata.user_id` session suffix or the Codex `prompt_cache_key`, then to a per-request session.

## Admin Console

The first web app is an operations console, not a customer-facing product surface.

Routes:

```text
/                    overview
/requests            request table
/requests/:requestId request detail and event timeline
/settings            searchable persistent runtime settings
/routing-configs     routing config cards: route matrix, system prompt, key counts
/routing-configs/new create flow: clone source, prompt editors, immediate API key attachment
/routing-configs/:id prompt and tier-model editor, API key assignment, version history
```

The web app currently reads the proxy admin endpoints:

```text
GET /api/auth/me
POST /api/auth/login
POST /api/auth/logout

GET /admin/overview
GET /admin/requests
GET /admin/requests/:requestId
GET /admin/settings
PATCH /admin/settings
GET /admin/routing-configs
GET /admin/routing-configs/:configId
POST /admin/routing-configs
POST /admin/routing-configs/:configId/versions
POST /admin/routing-configs/:configId/versions/:versionId/activate
POST /admin/routing-configs/:configId/archive
GET /admin/api-keys
POST /admin/api-keys
GET /admin/api-keys/:apiKeyId
PATCH /admin/api-keys/:apiKeyId/routing-config
POST /admin/api-keys/:apiKeyId/revoke
GET /admin/invitations
POST /admin/invitations
POST /admin/invitations/:invitationId/resend
POST /admin/invitations/:invitationId/revoke
PATCH /admin/users/:userId/role
POST /admin/users/:userId/deactivate
POST /admin/users/:userId/reactivate
```

The routing config list summary includes the active version's `systemPrompt` so the console can surface injected prompts without per-config detail fetches.

API key lifecycle is managed from the `/api-keys` console page. `POST /admin/api-keys` generates the secret server-side (`pp_` + 48 hex chars), stores only `key_hash`, and returns the secret exactly once in the create response; the console pairs it with copyable Claude Code/Codex setup snippets. `POST /admin/api-keys/:apiKeyId/revoke` sets `revoked_at`, which proxy auth already rejects. Mutations append audit events with producer `prompt-proxy.admin.api-keys`: `api_key.created`, `api_key.revoked`, plus the existing `routing_config.api_key_assignment_changed`.

Model pricing is managed from the `/billing` console page. Spend is computed locally (providers return token counts only): `usage_ledger` rows price uncached input, cache reads, cache writes (`cache_creation_input_tokens` column), and output at per-MTok rates resolved from built-in defaults, then `MODEL_COSTS_JSON`, then per-organization `model_catalog.pricing` overrides. Anthropic usage is normalized so `input_tokens` always means total input presented to the model (provider responses exclude cache reads/writes from it). The `modelPricing` GraphQL query lists effective rates with their source (`default`/`env`/`custom`/`unpriced`) and flags models seen in traffic; `setModelPricing`/`clearModelPricing` upsert the override and append audit events with producer `prompt-proxy.admin.model-pricing`: `model_pricing.updated`, `model_pricing.cleared`. Re-seeding preserves operator-set pricing.

Customer-supplied provider keys (BYOK) are managed from the `/provider-keys` console page. `POST /admin/provider-accounts` encrypts the secret with `PROVIDER_SECRET_ENCRYPTION_KEY` (AES-256-GCM) into `provider_accounts.secret_ciphertext`, records a masked `secret_hint` and the creating user, and never returns the plaintext. `PATCH /admin/api-keys/:apiKeyId/provider-account` writes the `api_key_provider_accounts` binding (one per key+provider); `POST /admin/provider-accounts/:id/revoke` disables the credential and drops its bindings. On each proxied request the proxy resolves the binding for the request's provider and forwards with the customer key, falling back to the company env key when unbound. Mutations append audit events with producer `prompt-proxy.admin.provider-accounts`: `provider_account.created`, `provider_account.revoked`, plus `provider_account.api_key_assignment_changed` (producer `prompt-proxy.admin.api-keys`). OAuth/subscription tokens are a planned follow-up (`provider_accounts.auth_type` reserves `oauth`).

## User Management

Organization membership is managed from the `/users` console page:

- Invitations are durable `invitations` rows. Raw invite tokens are never stored; only `token_hash` plus a display `token_prefix`, matching the API key and admin session hash rule. Tokens rotate on resend.
- Invitation emails are delivered through the Resend API (`RESEND_API_KEY`, `EMAIL_FROM`); without a key the proxy logs the message and admins copy the invite link from the console instead.
- Accepting an invite (`POST /api/invitations/resolve` / `POST /api/invitations/accept`, public token-authenticated endpoints) creates or reuses the `users` row by email and upserts the `organization_members` row with the invited role.
- Members are never deleted. Deactivation sets `organization_members.status = 'deactivated'`, which admin session resolution already rejects; API keys and usage history stay intact.
- Guards: pending duplicate invites and already-active members are rejected, the last active owner cannot be demoted or deactivated, and admins cannot deactivate themselves.
- Mutations append audit events with producer `prompt-proxy.admin.users`: `user.invitation_created`, `user.invitation_resent`, `user.invitation_revoked`, `user.invitation_accepted`, `user.role_changed`, `user.deactivated`, `user.reactivated`.

## Environment

```bash
DATABASE_URL=postgres://prompt_proxy:prompt_proxy@localhost:5432/prompt_proxy
DEFAULT_ORGANIZATION_ID=local
ADMIN_CORS_ORIGIN=http://127.0.0.1:5173,http://localhost:5173
VITE_PROMPT_PROXY_API_BASE=http://127.0.0.1:8787
ADMIN_DEV_LOGIN_ENABLED=true
ADMIN_DEV_LOGIN_EMAIL=local@example.com
ADMIN_DEV_LOGIN_PASSWORD=dev-password
PROMPT_PROXY_SETTINGS_PATH=.prompt-proxy/settings.json
```

Editable runtime settings are stored as JSON because the repo already uses JSON package/config conventions and does not carry a YAML parser dependency. The file defaults to `.prompt-proxy/settings.json`; environment variables continue to override file values. Classifier, budget, and route-quality edits are persisted for the next proxy restart, while prompt-capture edits are also applied to `organization_settings` when database persistence is enabled.

## Follow-Up Tickets

1. Add a Docker Compose Postgres service for local development.
2. Add API-key-backed org/user resolution instead of relying on `DEFAULT_ORGANIZATION_ID`.
3. Move admin endpoints from in-memory projections to direct Postgres queries.
4. Add API key management UI.
5. Add provider/model catalog mutation UI.
6. Add usage analytics by user, provider, model, route, and session.
7. Add prompt artifact retention and redaction policies.
8. Add durable outbox worker processing.
9. Add held-out eval/prompt optimization tables after the prompt artifact model stabilizes.
