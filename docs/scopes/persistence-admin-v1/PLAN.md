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

The request path keeps correctness-critical work synchronous: authentication, idempotency/request state, routing decision computation, provider credential resolution, provider forwarding, and terminal request state. Observability writes such as prompt artifacts, token attribution, classifier/routing telemetry events, compression measurements, and assistant response capture are scheduled asynchronously. Admin request timelines, prompt search, token-attribution reports, and route-quality projections are therefore eventually consistent; a newly completed request can be visible before those observability rows finish flushing. Async observability failures are logged and must not change the provider status, response body, or forwarded bytes.

Async observability event appends go through a bounded writer that still calls `EventService.append`, preserving the durable event/outbox/current-state transaction when a queued event flushes. Queue capacity is controlled by `EVENT_WRITER_MAX_ENTRIES` and `EVENT_WRITER_MAX_BYTES`; overflow and exhausted retries drop observability events with warning logs and counters, while correctness events stay synchronous and fail closed. `/_debug/event-writer` exposes queue depth, queued bytes, dropped count, flush failures, last flush latency, oldest event age, and flush state. Fastify shutdown drains the queue for `EVENT_WRITER_SHUTDOWN_TIMEOUT_MS` before giving up.

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
providers                    provider registry rows with endpoints, auth style, and capability JSON
provider_accounts            company env-backed rows plus customer BYOK credentials (encrypted secret + owner)
provider_account_health       current health/cooldown state for a provider credential
provider_model_health         current health/lockout state for a provider credential + model
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
compression_receipts
prompt_access_audit
user_sessions
events
event_outbox
projection_cursors
```

Every durable operational row is scoped by `organization_id`. Event rows use the existing proxy `tenantId` field as the organization identifier.

### Workspaces

Organizations contain workspaces (modeled on the Anthropic Console / OpenAI Platform hierarchy): identity and membership stay at the organization, traffic and traffic configuration live in a workspace.

- Workspace-scoped (`workspace_id NOT NULL`): `api_keys`, `routing_configs`, `routing_config_versions`, `api_key_provider_accounts`, `agent_sessions`, `turns`, `requests`, `route_decisions`, `provider_attempts`, `usage_ledger`, `prompt_artifacts`, `compression_receipts`, `prompt_access_audit`.
- Org-scoped (unchanged): `users`, `organization_members`, `invitations`, `organization_settings` (prompt capture + retention), `user_settings`, `provider_accounts` (BYOK credentials are shared infrastructure; only the key→credential bindings are workspace rows), `model_catalog`, `projection_cursors`.
- `events.workspace_id` is nullable: traffic and workspace-entity events carry it; org-level events (members, invitations, provider accounts) leave it null.
- Every organization has a default workspace with the deterministic id `${organizationId}:workspace:default` (`defaultWorkspaceId()` in `@proxy/db`); migration `0006_workspaces.sql` backfills all pre-workspace rows into it.
- The proxy resolves the request workspace from the API key (`api_keys.workspace_id`); the dev proxy token maps to the default workspace. Request idempotency keys are hashed per workspace.
- Each workspace owns its default routing config (`workspaces.default_routing_config_id`, replaces the old `organization_settings.default_routing_config_id`). Composite FKs enforce that routing config versions, key→config assignments, and workspace defaults stay within one workspace.
- Admin sessions track an active workspace (`user_sessions.workspace_id`, null = default). `switchWorkspace` repoints the session; `switchOrganization` still issues a fresh session. All workspace-scoped admin queries read the session's active workspace; members, invitations, settings, and provider credentials remain org-wide.

### Prompt artifact capture

Each request captures every conversation message it carries as a `prompt_artifacts` row with a `kind` describing the source: `system` / `instructions` (system prompts), `user_message` (typed user text), `injected_context` (harness-injected `<system-reminder>` blocks), `tool_use` (assistant tool calls), `tool_result` (tool output returned as user-role messages), `assistant_response` (assistant text, streamed or replayed in history), `tool_schema_metadata` (hash-only tool schema summary), and policy-gated compression artifacts for original/compressed tool-result blocks. Because agent harnesses resend the full conversation on every request, capture dedupes by the unique key `(organization_id, workspace_id, session_id, kind, content_hash)` and uses idempotent inserts instead of loading prior session artifacts. Each message is stored once, attributed to the request that first carried it, and the session view reconstructs the full conversation from those rows. Session identity comes from harness headers, falling back to the Claude Code `metadata.user_id` session suffix or the Codex `prompt_cache_key`, then to a per-request session.

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

Route execution plan evidence is stored on `route_decisions.route_execution_plan`, with `selected_candidate_id`, `translated`, and `translator_id` as queryable summary fields. `provider_attempts` links back to planned candidates through `route_candidate_id`, `attempt_index`, `fallback_index`, and `skip_reason`. Admin GraphQL request and prompt detail responses expose full route decisions plus linked provider attempts; lower-privilege users receive sanitized summaries without route internals. The web console renders the route plan on prompt detail and keeps request lists lightweight by filtering on summary fields instead of fetching the full JSON plan.

Migration `0029_ai_gateway_resolution_evidence.sql` adds the AI gateway cutover evidence to the existing request lifecycle. Requests and route decisions can now record ingress wire, gateway operation, requested and resolved logical models, access profile, router kind, deployment, provider connection, egress wire, and wire-adapter version. Provider attempts record the exact deployment/connection pair, egress wire, and provider-adapter contract version. Composite foreign keys keep every identity in the request's organization and workspace, and completeness checks reject partial evidence groups. These columns remain nullable for historical rows and for the legacy runtime until AGDM-008 switches all text traffic to logical-model resolution.

Gateway evidence is validated as a complete event payload group before projection. The event sink still projects current state and appends the matching event and outbox row in one database transaction; a scope or physical-target violation rolls back all three. Evidence payloads contain resource identities and versions only. Raw prompt text remains confined to `prompt_artifacts.raw_text`.

API key lifecycle is managed from the `/api-keys` console page. `POST /admin/api-keys` generates the secret server-side (`pp_` + 48 hex chars), binds the key to the creating user, stores only `key_hash`, and returns the secret exactly once in the create response; the console pairs it with copyable setup snippets for the selected Claude Code, Codex, and opencode harnesses. Proxy requests always attribute to `api_keys.user_id`; harness user headers remain raw request context only. `POST /admin/api-keys/:apiKeyId/revoke` sets `revoked_at`, which proxy auth already rejects. Mutations append audit events with producer `proxy.admin.api-keys`: `api_key.created`, `api_key.revoked`, plus the existing `routing_config.api_key_assignment_changed`.

Model pricing is managed from the `/billing` console page. Spend is computed locally (providers return token counts only): `usage_ledger` rows price uncached input, cache reads, cache writes (`cache_creation_input_tokens` column), and output at per-MTok rates resolved from built-in defaults, then `MODEL_COSTS_JSON`, then per-organization `model_catalog.pricing` overrides. Anthropic usage is normalized so `input_tokens` always means total input presented to the model (provider responses exclude cache reads/writes from it). The `modelPricing` GraphQL query lists effective rates with their source (`default`/`env`/`custom`/`unpriced`) and flags models seen in traffic; `setModelPricing`/`clearModelPricing` upsert the override and append audit events with producer `proxy.admin.model-pricing`: `model_pricing.updated`, `model_pricing.cleared`. Re-seeding preserves operator-set pricing.

Customer-supplied provider keys (BYOK) are managed from the `/providers` console page. `POST /admin/provider-accounts` encrypts the secret with `PROVIDER_SECRET_ENCRYPTION_KEY` (AES-256-GCM) into `provider_accounts.secret_ciphertext`, records a masked `secret_hint` and the creating user, and never returns the plaintext. `PATCH /admin/api-keys/:apiKeyId/provider-account` writes the `api_key_provider_accounts` binding (one per key+provider); `POST /admin/provider-accounts/:id/revoke` disables the credential and drops its bindings. On each proxied request the proxy resolves the binding for the request's provider and forwards with the customer key, falling back to the company env key when unbound. Mutations append audit events with producer `proxy.admin.provider-accounts`: `provider_account.created`, `provider_account.revoked`, plus `provider_account.api_key_assignment_changed` (producer `proxy.admin.api-keys`). Provider terminal events and manual probes project into `provider_account_health` and `provider_model_health`; active cooldowns, terminal account state, and active model lockouts are skipped before provider spend and exposed in request health-skip evidence. Subscription credentials use the same provider-account storage with `auth_type = 'oauth'`; see the subscription auth runbook for token-specific guardrails.

Provider registry rows carry a `capabilities` JSON object for provider-owned runtime options. The routing editor and router use `capabilities.efforts` to show and resolve provider-specific effort levels for OpenAI-compatible targets. Anthropic Messages targets additionally require adaptive thinking and gate effort by selected model: unsupported models send provider defaults, Opus 4.5 clamps at high, and newer supported models can expose max or xhigh-compatible ultracode resolution.

## User Management

Organization membership is managed from the `/users` console page, which lists organization members only:

- Invitations are durable `invitations` rows. Raw invite tokens are never stored; only `token_hash` plus a display `token_prefix`, matching the API key and admin session hash rule. Tokens rotate on resend.
- Invitation emails are delivered through the Resend API (`RESEND_API_KEY`, `EMAIL_FROM`); without a key the proxy logs the message and admins copy the invite link from the console instead.
- Accepting an invite (`POST /api/invitations/resolve` / `POST /api/invitations/accept`, public token-authenticated endpoints) creates or reuses the `users` row by email and upserts the `organization_members` row with the invited role.
- Members are never deleted. Deactivation sets `organization_members.status = 'deactivated'`, which admin session resolution already rejects; API keys and usage history stay intact.
- Guards: pending duplicate invites and already-active members are rejected, the last active owner cannot be demoted or deactivated, and admins cannot deactivate themselves.
- Mutations append audit events with producer `proxy.admin.users`: `user.invitation_created`, `user.invitation_resent`, `user.invitation_revoked`, `user.invitation_accepted`, `user.role_changed`, `user.deactivated`, `user.reactivated`.

## Environment

```bash
DATABASE_URL=postgres://proxy:proxy@localhost:5432/proxy
DEFAULT_ORGANIZATION_ID=local
ADMIN_CORS_ORIGIN=http://127.0.0.1:5173,http://localhost:5173
VITE_PROXY_API_BASE=http://127.0.0.1:8787
ADMIN_DEV_LOGIN_ENABLED=true
ADMIN_DEV_LOGIN_EMAIL=local@example.com
ADMIN_DEV_LOGIN_PASSWORD=dev-password
PROXY_SETTINGS_PATH=.proxy/settings.json
```

Editable runtime settings are stored as JSON because the repo already uses JSON package/config conventions and does not carry a YAML parser dependency. The file defaults to `.proxy/settings.json`; environment variables continue to override file values. Classifier, budget, and route-quality edits are persisted for the next proxy restart, while prompt-capture edits are also applied to `organization_settings` when database persistence is enabled.

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
