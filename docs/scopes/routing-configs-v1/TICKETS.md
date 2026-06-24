# Routing Configs V1 Tickets

These tickets break the routing config scope into PR-sized units.

The intended delivery shape is a hard cutover from process-global routing settings to persisted, API-key-bound routing configs. Environment variables may seed local defaults, but runtime routing should resolve from the active routing config once persistence is enabled.

## Delivery Rules

- Keep prompt rewriting, memory injection, and eval-driven promotion out of V1.
- Keep provider-specific request fields inside config provider blocks or provider adapters.
- Store config ids, versions, hashes, and summary metadata in events. Do not store raw prompt text in event payloads.
- Treat active routing config versions as immutable.
- Make each runtime request resolve exactly one routing config version before classifier spend.
- Prefer explicit validation failures over provider fallback behavior.

## Phase 0: Contract And Data Model

### RC-001: Define Routing Config Contract

Goal: Create the shared routing config contract used by seeds, admin APIs, runtime resolution, and web UI.

Scope:

- Add route tier constants and Zod schemas in `packages/schema`.
- Define classifier settings: model, provider, instructions, retry count, timeout, and structured-output mode.
- Define route tiers: route name, provider, model, reasoning/thinking settings, verbosity/output config, limits, and optional provider metadata.
- Define session policy: pinning, allowed upgrades, max route, and downgrade behavior.
- Reject unknown top-level config fields.

Acceptance criteria:

- A valid default OpenAI + Anthropic config parses successfully.
- Invalid classifier settings fail with useful validation paths.
- Invalid provider blocks fail before reaching proxy runtime.
- Shared types are exported from `packages/schema/src/index.ts`.

Validation:

- Add schema unit tests in `packages/schema` or the nearest existing test package.
- Run `pnpm typecheck`.

Likely files:

- `packages/schema/src/index.ts`
- `packages/schema/package.json`
- `packages/schema/tsconfig.json`

### RC-002: Add Routing Config Tables

Goal: Replace the `route_policies` placeholder with normalized routing config tables.

Scope:

- Add `routing_configs`.
- Add `routing_config_versions`.
- Add `api_keys.routing_config_id`.
- Add config snapshot columns to request or route decision tables as described in the plan.
- Add org-scoped indexes for list/detail queries.
- Remove `route_policies` from schema if this can be done cleanly in the same migration.

Acceptance criteria:

- All durable routing config rows are organization scoped.
- Active config pointer is represented on `routing_configs`.
- Versions include immutable JSON, hash, created metadata, and version number.
- API keys can optionally point at a config.
- Existing migration tests pass.

Validation:

- Run `pnpm --filter @proxy/db test`.
- Run `pnpm db:migrate` against local Postgres.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `packages/db/src/schema.test.ts`
- `packages/db/src/migrations.test.ts`

### RC-003: Seed Default Routing Config

Goal: Ensure every local/dev org has a usable routing config without manual setup.

Scope:

- Update seed logic to create a Default routing config.
- Create active version 1 from current env-backed model settings.
- Point org settings at the default config.
- Assign seeded local API key to the default config.
- Preserve existing local harness behavior through seeded data, not runtime env branching.

Acceptance criteria:

- `pnpm db:seed` creates one active default config per seeded organization.
- Seeded config covers OpenAI Responses and Anthropic Messages surfaces.
- Re-running the seed is idempotent.
- Seed tests assert API key assignment.

Validation:

- Run `pnpm --filter @proxy/db test`.
- Run `pnpm db:seed`.

Likely files:

- `packages/db/src/seed.ts`
- `packages/db/src/seed.test.ts`
- `apps/proxy/src/config.ts`

### RC-004: Remove Route Policy Terminology From Persistent Docs

Goal: Make routing configs the single durable policy concept.

Scope:

- Update internal docs that describe durable runtime routing.
- Keep historical docs readable, but clarify that route policies are superseded by routing configs.
- Update settings/admin wording where it would confuse future implementers.

Acceptance criteria:

- New scope docs use `routing config`, not `route policy`, for persisted runtime behavior.
- `route_policies` is only referenced as legacy/current-state context until removed.
- `docs/index.md` links the ticket breakdown.

Validation:

- Run `rg "route policy|route_policies|ROUTE_POLICY_JSON" docs apps packages`.

Likely files:

- `docs/model-routing.md`
- `docs/scopes/persistence-admin-v1/PLAN.md`
- `docs/scopes/tanstack-admin-app-v1/PLAN.md`
- `docs/index.md`

## Phase 1: Runtime Resolution

### RC-005: Extend API Key Identity With Routing Assignment

Goal: Let authenticated requests carry the API key's routing config binding.

Scope:

- Extend API key lookup to include `routing_config_id`.
- Ensure identity DTOs carry organization, user, API key id, and routing config id.
- Keep raw API keys hashed only.
- Update last-used behavior without adding extra queries where possible.

Acceptance criteria:

- Proxy requests know which API key id was used.
- Admin requests can list key assignment metadata without exposing raw key material.
- Missing `routing_config_id` is represented explicitly for fallback resolution.

Validation:

- Add or update proxy auth tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/auth.ts`
- `apps/proxy/src/persistence/identity.ts`
- `apps/proxy/test/persistence.test.ts`

### RC-006: Add Routing Config Resolver

Goal: Resolve and validate the active config version before classifier or provider spend.

Scope:

- Add a resolver service that accepts organization id and optional API key routing config id.
- Resolve precedence: API key config, org default config, seeded default config.
- Load the active version and validate JSON through `packages/schema`.
- Return config id, version id, version number, config hash, and parsed config.
- Fail closed if the active version is missing or invalid.

Acceptance criteria:

- Config resolution happens before classifier calls.
- Invalid active config returns a proxy error without upstream model spend.
- Resolver is unit-testable without Fastify request objects.
- Resolver has no provider-specific request rewriting logic.

Validation:

- Add resolver unit tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/persistence/routingConfig.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/src/server.ts`

### RC-007: Thread Config Into Classification

Goal: Make the LLM classifier use the resolved config instead of process-global classifier settings.

Scope:

- Update classifier input to include parsed routing config.
- Use config classifier provider/model/instructions/timeout/retry settings.
- Preserve structured output and retry semantics.
- Include classifier config version metadata in decision output.

Acceptance criteria:

- Classifier model can differ by API key.
- Classifier instructions can differ by API key.
- There is no deterministic routing fallback.
- Failed classifier retries produce a clear proxy error.

Validation:

- Update classifier tests for config-driven model/instructions.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/classifier.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/test/proxy.test.ts`

### RC-008: Map Route Tiers To Provider Settings

Goal: Use the selected route tier to rewrite upstream model and reasoning settings.

Scope:

- Add route tier lookup from parsed config.
- Map OpenAI tier settings to Responses API request fields.
- Map Anthropic tier settings to Messages API request fields.
- Preserve non-routing request fields, tools, streaming, and session metadata.
- Fail clearly when the selected route is not available for the incoming surface.

Acceptance criteria:

- OpenAI routing uses config model and reasoning effort.
- Anthropic routing uses config model and effort/thinking settings.
- Unsupported surface/provider combinations fail before upstream request.
- Provider adapters remain the boundary for provider-specific request shape.

Validation:

- Add OpenAI and Anthropic adapter tests.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm smoke:harnesses` when provider keys are configured.

Likely files:

- `apps/proxy/src/adapters.ts`
- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/test/proxy.test.ts`

### RC-009: Persist Config Snapshots On Decisions

Goal: Make every request auditable against the exact config version used at route time.

Scope:

- Persist routing config id/version/hash on route decisions.
- Persist summary fields needed by dashboard filters.
- Emit route/config events through `EventService`.
- Keep raw prompt text in `prompt_artifacts.raw_text` only.

Acceptance criteria:

- Route decision rows include config id, config version id, version number, and hash.
- Event payloads contain config metadata but not full prompts.
- Request logs can show which config version produced the selected model.
- Existing usage analytics continue to work.

Validation:

- Update persistence and usage analytics tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/persistence/routeDecision.ts`
- `apps/proxy/src/events.ts`
- `apps/proxy/src/promptCaptureEvents.ts`
- `apps/proxy/test/usageAnalytics.test.ts`

### RC-010: Remove Runtime `ROUTE_POLICY_JSON` Dependency

Goal: Hard cut runtime routing away from legacy environment route policy.

Scope:

- Stop reading `ROUTE_POLICY_JSON` during persisted runtime routing.
- Keep env variables only as seed inputs where useful.
- Remove route policy tests or rewrite them around routing configs.
- Delete unused runtime policy helpers after the resolver is live.

Acceptance criteria:

- Persisted runtime routing succeeds without `ROUTE_POLICY_JSON`.
- There is no fallback route selected from process-global policy JSON.
- Existing local Codex/Claude Code smoke flows still work through seeded config.
- Dead route policy code is removed rather than wrapped.

Validation:

- Run `pnpm test`.
- Run `pnpm smoke`.
- Run `pnpm smoke:harnesses` when provider keys are configured.

Likely files:

- `apps/proxy/src/config.ts`
- `apps/proxy/src/policy.ts`
- `apps/proxy/test/config-events.test.ts`
- `apps/proxy/test/proxy.test.ts`

## Phase 2: Admin API

### RC-011: Add Routing Config List And Detail APIs

Goal: Expose org-scoped read APIs for the web console.

Scope:

- Add `GET /admin/routing-configs`.
- Add `GET /admin/routing-configs/:configId`.
- Include active version summary, status, key count, and updated metadata.
- Include version history on detail.

Acceptance criteria:

- APIs require admin authentication.
- Results are scoped to the caller's organization.
- Archived configs are included or filterable according to the plan.
- Response DTOs do not expose provider secrets.

Validation:

- Add admin API tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/server.ts`
- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/proxy/src/persistence/adminSerializers.ts`
- `apps/proxy/test/adminPromptApis.test.ts`

### RC-012: Add Routing Config Version APIs

Goal: Let admins create and activate immutable config versions.

Scope:

- Add `POST /admin/routing-configs`.
- Add `POST /admin/routing-configs/:configId/versions`.
- Add `POST /admin/routing-configs/:configId/versions/:versionId/activate`.
- Validate config JSON before insert.
- Atomically update the active version pointer.

Acceptance criteria:

- Creating a version increments version number safely.
- Active versions cannot be mutated in place.
- Activating a version writes an audit event.
- Invalid config JSON returns field-level errors.

Validation:

- Add transaction and validation tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/server.ts`
- `apps/proxy/src/persistence/routingConfigAdmin.ts`
- `apps/proxy/src/events.ts`

### RC-013: Add API Key Assignment APIs

Goal: Let admins attach a routing config to an API key.

Scope:

- Add `GET /admin/api-keys` if the current endpoint is insufficient.
- Add `PATCH /admin/api-keys/:apiKeyId/routing-config`.
- Validate target config belongs to the same organization.
- Reject archived configs.
- Emit assignment audit events.

Acceptance criteria:

- API key list never returns raw key material.
- API key detail includes assigned routing config summary.
- Assignment changes are org scoped.
- Removing assignment falls back to org default config.

Validation:

- Add API key admin tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/server.ts`
- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/proxy/src/persistence/adminSerializers.ts`

### RC-014: Add Config Audit Events

Goal: Make routing config changes visible in the event stream.

Scope:

- Emit events for config created, version created, version activated, config archived, and API key assignment changed.
- Include organization id, actor id, config id, version id, and config hash.
- Project current-state rows inside the same transaction where applicable.

Acceptance criteria:

- Admin mutations create durable events.
- Event payloads do not include provider secrets or raw prompts.
- Event tests prove org scoping and transaction behavior.

Validation:

- Add event sink/projector tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/events.ts`
- `apps/proxy/src/persistence/eventSink.ts`
- `apps/proxy/src/persistence/eventProjector.ts`

## Phase 3: Web Console

### RC-015: Add Routing Config Navigation

Goal: Add a clear place in the console for routing configuration.

Scope:

- Add a Routing item under Operations or Manage.
- Add route entries for routing config list/detail.
- Keep route files thin.
- Reuse existing shell and dashboard component patterns.

Acceptance criteria:

- Routing config pages are reachable from the side nav.
- Active nav state works.
- Mobile and collapsed navigation remain usable.

Validation:

- Run `pnpm --filter @proxy/web typecheck`.
- Run the web app and inspect routing manually.

Likely files:

- `apps/web/src/router.tsx`
- `apps/web/src/shell.tsx`
- `apps/web/src/settingsPage.tsx`

### RC-016: Build Routing Config List Page

Goal: Show every org routing config and its operational status.

Scope:

- Fetch `GET /admin/routing-configs` through TanStack Query.
- Render config name, active version, status, assigned key count, updated time, and primary route matrix summary.
- Add empty, loading, and error states.
- Keep component files under project line limits.

Acceptance criteria:

- Operators can identify the default config.
- Operators can see which configs are unused.
- Clicking a config opens detail.
- No direct `useEffect`.

Validation:

- Run `pnpm --filter @proxy/web typecheck`.
- Run `pnpm build`.

Likely files:

- `apps/web/src/routingConfigsPage.tsx`
- `apps/web/src/api.ts`
- `apps/web/src/format.ts`

### RC-017: Build Routing Config Detail Page

Goal: Let operators inspect a config version before assigning or activating it.

Scope:

- Show active version metadata, classifier settings, route tiers, provider/model mapping, and version history.
- Display JSON config in a readable inspector.
- Add activate/archive actions only if backend APIs exist.
- Show validation errors near the action.

Acceptance criteria:

- Detail page clearly shows which model each tier maps to for OpenAI and Anthropic.
- Version history shows active/inactive state.
- Activating a version updates data through query invalidation.
- Component files stay under 300 lines.

Validation:

- Run `pnpm --filter @proxy/web typecheck`.
- Manual browser check against seeded data.

Likely files:

- `apps/web/src/routingConfigDetailPage.tsx`
- `apps/web/src/api.ts`
- `apps/web/src/ui.tsx`

### RC-018: Add API Key Assignment UI

Goal: Attach configs to API keys from the console.

Scope:

- Extend API keys page with assigned config column.
- Add a routing config selector for each key or a detail-side action.
- Show fallback/default behavior when no key-specific config is assigned.
- Invalidate key and config queries after assignment.

Acceptance criteria:

- Operators can assign an active config to an API key.
- Operators can clear assignment to use org default.
- Raw keys are never displayed.
- Assignment errors show next to the control.

Validation:

- Run `pnpm --filter @proxy/web typecheck`.
- Manual assignment flow against local API.

Likely files:

- `apps/web/src/keysPage.tsx`
- `apps/web/src/api.ts`
- `apps/web/src/ui.tsx`

### RC-019: Show Config Snapshot In Request Detail

Goal: Let operators explain why a request used a given model.

Scope:

- Add config id/name/version/hash to request or prompt detail views.
- Show selected route, selected model, classifier model, and config version.
- Link to the routing config detail page when available.

Acceptance criteria:

- A request log can be traced back to the exact config version used.
- Hash/version data is visible enough for debugging without overwhelming the table.
- Existing prompt/session views remain scan-friendly.

Validation:

- Run `pnpm --filter @proxy/web typecheck`.
- Manual browser check on request logs with seeded data.

Likely files:

- `apps/web/src/requestsPage.tsx`
- `apps/web/src/promptsPage.tsx`
- `apps/web/src/sessionsPage.tsx`
- `apps/web/src/api.ts`

## Phase 4: Hardening And Release

### RC-020: Add Cache And Invalidation Guardrails

Goal: Keep config lookup fast without routing against stale assignments indefinitely.

Scope:

- Add a small in-process cache only if profiling shows resolver overhead is material.
- Invalidate on config activation and API key assignment changes.
- Make cache keys include organization id, API key id, config id, version id, and hash.

Acceptance criteria:

- Cache is optional and contained behind the resolver.
- Admin mutations invalidate affected keys/configs.
- Tests prove activation changes take effect on next request.

Validation:

- Add resolver cache tests if cache is implemented.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/persistence/routingConfig.ts`
- `apps/proxy/src/server.ts`

### RC-021: Add End-To-End Local Smoke Flow

Goal: Prove Codex and Claude Code can route through API-key-bound configs locally.

Scope:

- Extend smoke scripts to create or use seeded routing configs.
- Exercise OpenAI Responses and Anthropic Messages request paths.
- Assert selected model/reasoning headers or persisted decision rows.
- Document local test steps.

Acceptance criteria:

- Smoke flow proves default config assignment works.
- Smoke flow proves a changed API key assignment affects routing.
- Failure output identifies whether auth, config resolution, classifier, or provider forwarding failed.

Validation:

- Run `pnpm smoke`.
- Run `pnpm smoke:harnesses` when provider keys are configured.

Likely files:

- `apps/proxy/scripts/smoke.ts`
- `apps/proxy/scripts/smoke-harnesses.ts`
- `README.md`

### RC-022: Update Docs And Operator Runbook

Goal: Leave the system understandable after the hard cutover.

Scope:

- Update `README.md` with routing config local setup.
- Update the main architecture doc with the new config resolution path.
- Update frontend and persistence scope docs if behavior changed.
- Add a short operator runbook for assigning configs to API keys.

Acceptance criteria:

- A developer can seed, run, and test routing configs locally.
- A developer can explain config precedence from docs alone.
- Docs no longer tell users to edit `ROUTE_POLICY_JSON` for persisted runtime routing.

Validation:

- Run `pnpm typecheck`.
- Run `rtk git diff --check`.

Likely files:

- `README.md`
- `docs/model-routing.md`
- `docs/scopes/routing-configs-v1/PLAN.md`
- `docs/index.md`

## Suggested PR Batches

1. RC-001 to RC-003: schema, migrations, seeds.
2. RC-005 to RC-009: runtime resolver, classifier wiring, route decisions.
3. RC-010: hard runtime cutover from `ROUTE_POLICY_JSON`.
4. RC-011 to RC-014: admin APIs and audit events.
5. RC-015 to RC-019: web console.
6. RC-020 to RC-022: hardening, smoke tests, docs.

## Dependency Graph

```text
RC-001
  -> RC-002
      -> RC-003
      -> RC-005
          -> RC-006
              -> RC-007
              -> RC-008
                  -> RC-009
                      -> RC-010

RC-002
  -> RC-011
      -> RC-012
      -> RC-013
      -> RC-014

RC-011 + RC-013
  -> RC-015
      -> RC-016
      -> RC-017
      -> RC-018
      -> RC-019

RC-006 + RC-012 + RC-013
  -> RC-020
  -> RC-021
  -> RC-022
```
