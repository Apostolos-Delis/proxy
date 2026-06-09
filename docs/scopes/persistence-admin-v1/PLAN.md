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
users
organization_members
api_keys
organization_settings
user_settings
provider_accounts
model_catalog
routing_configs
routing_config_versions
route_policies            legacy placeholder, superseded by routing configs
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

## Admin Console

The first web app is an operations console, not a customer-facing product surface.

Routes:

```text
/                    overview
/requests            request table
/requests/:requestId request detail and event timeline
/settings            current routing/runtime settings
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
GET /admin/routing-configs
GET /admin/routing-configs/:configId
POST /admin/routing-configs
POST /admin/routing-configs/:configId/versions
POST /admin/routing-configs/:configId/versions/:versionId/activate
POST /admin/routing-configs/:configId/archive
GET /admin/api-keys
GET /admin/api-keys/:apiKeyId
PATCH /admin/api-keys/:apiKeyId/routing-config
```

## Environment

```bash
DATABASE_URL=postgres://prompt_proxy:prompt_proxy@localhost:5432/prompt_proxy
DEFAULT_ORGANIZATION_ID=local
ADMIN_CORS_ORIGIN=http://127.0.0.1:5173,http://localhost:5173
VITE_PROMPT_PROXY_API_BASE=http://127.0.0.1:8787
ADMIN_DEV_LOGIN_ENABLED=true
ADMIN_DEV_LOGIN_EMAIL=local@example.com
ADMIN_DEV_LOGIN_PASSWORD=dev-password
```

## Follow-Up Tickets

1. Add a Docker Compose Postgres service for local development.
2. Add API-key-backed org/user resolution instead of relying on `DEFAULT_ORGANIZATION_ID`.
3. Move admin endpoints from in-memory projections to direct Postgres queries.
4. Add API key management UI.
5. Add organization settings mutation UI.
6. Add provider/model catalog mutation UI.
7. Add usage analytics by user, provider, model, route, and session.
8. Add prompt artifact retention and redaction policies.
9. Add durable outbox worker processing.
10. Add held-out eval/prompt optimization tables after the prompt artifact model stabilizes.
