# TanStack Admin App V1

## Goal

Build an authenticated operations app where an organization can:

- log in
- see organization-wide usage and routing economics
- inspect users, sessions, requests, prompt artifacts, route decisions, provider attempts, and costs
- replay a user's proxy session as an observable timeline

This should feel like Trace and Atlas: dense, operational, event-aware, and built for investigation. No landing page.

## Current State

Prompt Proxy already has the right backbone:

```text
apps/proxy/        routing proxy and admin API
apps/web/          small TanStack Router + Query console
packages/db/       Drizzle schema and migrations
packages/schema/   shared constants/types
```

Useful existing tables:

```text
organizations
users
organization_members
organization_settings
provider_accounts
model_catalog
routing_configs
routing_config_versions
agent_sessions
turns
requests
route_decisions
provider_attempts
usage_ledger
prompt_artifacts
events
event_outbox
```

The existing app exposes:

```text
/login
/                    overview
/usage               usage analytics
/prompts             prompt table
/prompts/:artifactId prompt detail
/sessions            session table
/sessions/:sessionId session replay
/requests            request table
/requests/:requestId request detail and event timeline
/routing-configs     routing config table
/routing-configs/:configId routing config detail
/api-keys            API key table and routing assignment
/settings            settings
```

Browser auth is now cookie-based through `/api/auth/login`, `/api/auth/logout`, and `/api/auth/me`.

Prompt artifacts can now store raw prompt text in `raw_text` mode for the prototype. PII filtering, redaction jobs, and encrypted raw artifact storage remain hardening work.

## Reference Patterns

Use from `../trace`:

- current-state tables plus durable event log
- scoped event timelines
- session detail views that read historical events and can later subscribe to scoped live events
- session/prompt timeline UX
- dense sidebar-driven investigation flows

Use from `../atlas-parthenon/atlas`:

- TanStack file-style route organization
- route guards with `beforeLoad`
- `/api/auth/me` for browser auth state
- HttpOnly session cookie backed by hashed opaque tokens
- collapsible app shell
- dense data tables, metric strips, and inspector panes
- model-call timeline rows with sanitized request/response and usage panels

Do not copy direct `useEffect` patterns. Use TanStack Router loaders, TanStack Query, event handlers, inline derived state, or local approved escape hatches.

## Product Routes

```text
/login
/                         org overview
/usage                    usage analytics
/users                    users and spend
/users/:userId            user sessions and usage
/sessions                 session table
/sessions/:sessionId      session replay timeline
/requests                 request table
/requests/:requestId      request detail
/routing-configs          routing config table
/routing-configs/:configId routing config detail
/api-keys                 API key table and routing assignment
/prompts                  prompt artifacts
/prompts/:artifactId      prompt detail
/settings                 org settings and policy
```

Sidebar groups:

```text
Prompt Proxy
  Overview
  Usage
  Prompts

Investigate
  Sessions
  Requests
  Users

Configure
  Routing configs
  API keys
  Settings
```

## Core Views

### Overview

Show:

- total requests, sessions, active users
- total tokens, reasoning tokens, cached tokens
- selected cost, baseline cost, estimated savings
- route mix, provider mix, model mix
- recent failed/high-cost requests
- low-confidence route decisions

### Usage

Support:

- time range
- group by user, provider, model, route, surface, session
- token and cost tables
- failure/retry rate
- export-ready data

Start with server-computed aggregates and dense tables. Charts can come after the data contracts are stable.

### Prompts

V1 should store raw prompt text in Postgres. This is intentionally simple for the prototype:

```text
raw_text       store raw prompt text plus hash and metadata
```

Keep the content hash for dedupe, joins, and future retention workflows. PII filtering, redaction, and encrypted raw artifact storage are later hardening scopes.

Prompt list columns:

- created at
- user
- session
- request
- surface
- storage mode
- chars/tokens
- content hash
- prompt preview
- selected model
- route
- cost

Prompt detail shows the raw prompt text plus related request/session/route/provider/usage/event data.

### Session Replay

Session replay is feasible because these rows are linked by organization, session, request, and correlation IDs:

```text
agent_sessions
requests
prompt_artifacts
route_decisions
provider_attempts
usage_ledger
events
```

Replay should reconstruct the observable proxy timeline, not hidden model reasoning:

```text
request received
prompt artifact captured
routing context built
classifier attempted
route decision recorded
provider request started
stream started
response completed / failed / cancelled
usage recorded
```

Layout:

- top summary: user, surface, request count, route changes, model mix, total tokens, total cost
- left timeline: prompt, routing, provider, usage, error events
- right inspector: selected prompt, decision, provider attempt, usage, or raw event

Power this with one session-detail endpoint rather than client-side N+1 joins.

## Backend Scope

Add cookie-authenticated admin APIs backed by Postgres:

```text
GET  /api/auth/me
POST /api/auth/login
POST /api/auth/logout

GET /admin/overview
GET /admin/usage?from=&to=&groupBy=
GET /admin/users
GET /admin/users/:userId
GET /admin/sessions
GET /admin/sessions/:sessionId
GET /admin/prompts
GET /admin/prompts/:artifactId
GET /admin/prompt-access-audit
GET /admin/requests
GET /admin/requests/:requestId
GET /admin/settings
PATCH /admin/settings/prompt-capture
```

Move the browser away from static bearer token auth. The proxy harness endpoints should move from one global proxy token to API-key-backed request identity.

## Auth Model

Add `user_sessions`:

```text
id
user_id
session_token_hash
session_token_prefix
created_at
expires_at
last_seen_at
revoked_at
```

Rules:

- store only hashed session tokens
- set an HttpOnly `prompt_proxy_session` cookie
- resolve current user through `/api/auth/me`
- scope every admin query to organizations where the user has active membership
- reject org IDs that the current user does not belong to
- start with env-gated local/dev login; Google OAuth can follow the Atlas pattern later

Existing `users` and `organization_members` are enough for V1 authorization.

V1 login mechanism:

```text
ADMIN_DEV_LOGIN_ENABLED=true
ADMIN_DEV_LOGIN_EMAIL=local@example.com
ADMIN_DEV_LOGIN_PASSWORD=...
SEED_USER_ID=local-user
```

`POST /api/auth/login` should be enabled only when `ADMIN_DEV_LOGIN_ENABLED=true`. It validates the configured email/password from env, resolves the seeded user, and creates a `user_sessions` row. This avoids adding password identity tables before the product needs real account management.

## Proxy Request Identity

Usage analytics must resolve the organization and user from the proxy request itself, not from browser auth.

Use the existing `api_keys` table as the V1 identity primitive:

```text
api_keys.organization_id -> request organization
api_keys.user_id         -> request user when present
api_keys.last_used_at    -> updated on successful auth
```

Proxy request auth:

- hash incoming bearer token or `x-api-key`
- look up `api_keys.key_hash`
- reject revoked or expired keys
- use the key's `organization_id` and `user_id` for persistence
- update `last_used_at`
- keep `PROMPT_PROXY_TOKEN` only as an explicit local fallback for seeded development

Harness-supplied user/team headers should not authorize organization or user ownership. Store them as request metadata unless a later org setting explicitly allows trusted upstream identity headers.

## Session Identity Contract

Session replay depends on a durable session ID. V1 should normalize known harness headers:

```text
Codex
  x-codex-session-id
  session_id
  x-client-request-id

Claude Code
  x-claude-code-session-id
```

Session resolution order:

1. Use a known external session header when present.
2. If absent, create a request-scoped synthetic session with `externalSessionId = request:{requestId}`.
3. Mark synthetic sessions with metadata `{ sessionIdentity: "request_fallback" }`.

Request-scoped fallback sessions keep every prompt replayable, but they do not imply multi-turn continuity. The UI should label them as unthreaded sessions. Real multi-request replay requires a stable harness session header.

## Prompt Capture

Add prompt extraction at the surface-adapter boundary:

```text
incoming request
  -> surface adapter extracts prompt artifacts
  -> raw prompt text is written to prompt_artifacts
  -> content hash and metadata are written with it
  -> event records artifact IDs, hashes, storage mode, and metadata
```

Do not put full prompt text in events. Events are the replay spine; `prompt_artifacts` is the content surface.

Schema changes:

```text
PROMPT_CAPTURE_MODES.RAW_TEXT = "raw_text"

prompt_artifacts
  raw_text text
  token_estimate integer
  source_role text
  source_index integer
```

Use `prompt_artifacts.raw_text` for the captured content. Keep `content_hash` for joins, dedupe, and future redaction/retention jobs.

Surface adapter responsibilities:

```text
OpenAI Responses
  latest_user_message
  instructions
  tool schema metadata

Anthropic Messages
  latest_user_message
  system
  tool schema metadata
```

Default seed behavior should use `raw_text` for this test project so local runs immediately populate the prompt views.

## Frontend Architecture

Follow `docs/frontend-guidelines.md` for component size, effect usage, data fetching, rendering, and design rules.

Move `apps/web` toward:

```text
apps/web/src/
  routes/
  components/
    app-shell/
    auth/
    usage/
    users/
    sessions/
    requests/
    prompts/
    settings/
    ui/
  lib/
    api.ts
    auth.ts
    formatting.ts
```

Use:

- TanStack Router route loaders and `beforeLoad`
- TanStack Query for fetch/mutation state
- TanStack Table or an Atlas-style dense table
- local state for table search/filter controls
- no direct `useEffect`
- component files under 300 lines and component functions under 150 lines

Core components:

```text
AppShell
SidebarNav
PageHeader
MetricStrip
StatusPill
DenseTable
SearchToolbar
JsonBlock
PromptTextBlock
Timeline
TimelineRow
InspectorPane
```

Design direction:

- compact dark shell
- collapsible sidebar
- 6px-8px radius
- dense tables and split panes
- restrained route/provider/status colors
- code panels for payloads and raw prompts

## Query Services

Add server-side query builders:

```text
overview(orgId)
usage(orgId, filters)
listUsers(orgId, filters)
getUserDetail(orgId, userId)
listSessions(orgId, filters)
getSessionReplay(orgId, sessionId)
listPromptArtifacts(orgId, filters)
getPromptArtifact(orgId, artifactId)
```

`getSessionReplay` should return:

```text
session
user
requests[]
promptArtifactsByRequestId
routeDecisionsByRequestId
providerAttemptsByRequestId
usageByRequestId
eventsByRequestId
timelineItems[]
```

## Implementation Phases

1. Browser auth and org context
   Add `user_sessions`, auth service, cookie helpers, login/logout/me endpoints, seeded local login, and route guards.

2. Proxy request identity
   Resolve proxy API keys to organization/user identity, persist key usage, and keep global proxy token only as a local development fallback.

3. Session identity
   Normalize Codex and Claude Code session headers, create request-scoped fallback sessions, and expose unthreaded session state in metadata.

4. Admin query API
   Add Postgres-backed query services for overview, usage, users, sessions, prompts, requests, and settings.

5. Prompt capture
   Extract prompt artifacts per surface adapter and persist raw prompt text with hashes and metadata.

6. Frontend shell and pages
   Build authenticated app shell plus overview, usage, requests, sessions, prompts, users, and settings pages.

7. Session replay
   Add session replay endpoint and timeline/inspector UI.

8. Realtime follow-up
   Add scoped event streaming after historical views are working.

## Open Questions

- Is org-admin access enough for prompt visibility, or do we need a separate prompt viewer role?
- Should prompt search include raw text immediately, or start with metadata and previews only?

## Acceptance Criteria

- Seeded local user can log in.
- Unauthenticated users are redirected to `/login`.
- Proxy requests resolve organization and user identity from API keys.
- Harness user/team headers are stored as metadata, not trusted for ownership.
- Overview shows organization usage from Postgres.
- Users can drill into sessions and requests.
- Session replay is chronological and sourced from persisted rows.
- Requests without a stable harness session header appear as unthreaded request-scoped sessions.
- Raw prompt text is stored and visible in prompt/session detail views.
- PII filtering and redaction are explicitly deferred to a later hardening scope.
- All admin data is scoped by authenticated organization membership.
- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
