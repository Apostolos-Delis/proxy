# AI Gateway Core Data Model V1 Tickets

These tickets break [AI Gateway Core Data Model V1](PLAN.md) into dependency-ordered, PR-sized changes.

The delivery shape is additive groundwork followed by one runtime hard cutover. New tables and services may land before they receive traffic, but a request never reads both the old routing-config model and the new logical-model model.

## Delivery Rules

- Keep all V1 catalog and configuration rows organization and workspace scoped, including canonical models. A platform-wide catalog is deferred.
- Reuse the existing provider-adapter, dialect, and translator registries as the code-owned contracts. Do not create parallel registries.
- Keep provider credentials on provider connections as secret references or encrypted material. Never store raw provider keys.
- Keep the database as runtime truth. TOML is an authoring input with explicit `plan` and `apply`, not a second live configuration source.
- Preserve native same-wire passthrough and use an existing registered translator only when the selected binding requires it.
- Run classifier routing only after authorization and eligibility filtering. Structured-output retries may fail closed; there is no deterministic routing fallback.
- Persist events, outbox rows, and matching current-state mutations through `EventService` in one transaction.
- Keep raw prompts only in `prompt_artifacts.raw_text`.
- Preserve all current text surfaces: OpenAI Responses HTTP/WebSocket, OpenAI Chat Completions, Anthropic Messages, and Anthropic token counting.
- Keep V1 authoring to the admin API and TOML commands. A replacement visual configuration editor is a later scope.
- Do not add teams, budgets, semantic caching, generalized workflow state, or new modalities in these tickets.

## First Milestone

Implement AGDM-001 and AGDM-002, then review the resulting schema and seeded configuration before starting runtime resolution. This keeps the first change limited to the data-model rearchitecture the project needs now.

## Phase 0: Supply And Access Data

### AGDM-001: Add Physical Model Resources

Goal: Separate provider connectivity, model identity, callable deployments, and native API wires.

Scope:

- Add `provider_connections`, merging the configurable endpoint and credential responsibilities currently split across providers and provider accounts.
- Add workspace-scoped `canonical_models`.
- Add `model_deployments` linked to one canonical model and provider connection.
- Add `deployment_wire_bindings` linked to code-owned wire IDs and adapter contract versions.
- Promote the existing dialect, translator, and provider-adapter registries into the code-owned API-wire and adapter contracts instead of adding duplicate registries.
- Add the minimum operation IDs: `text.generate`, `text.count_tokens`, and local `model.list`.
- Land additive Drizzle schema and SQL migration changes with composite organization/workspace foreign keys and list/detail indexes.

Acceptance criteria:

- Connections, deployments, and bindings cannot reference a resource from another organization or workspace.
- A deployment names the exact upstream model and cannot expand its canonical model's capabilities.
- A binding names an installed wire and adapter contract version.
- Connection rows contain no raw provider key.
- Existing traffic remains unchanged.

Validation:

- Add schema and migration tests for scoped foreign keys, uniqueness, cascades, and status fields.
- Run `pnpm --filter @proxy/db test`.
- Run `pnpm typecheck`.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `packages/db/src/schema.test.ts`
- `packages/db/src/migrations.test.ts`
- `packages/schema/src/index.ts`

Dependencies: none.

### AGDM-002: Add Logical Models And Access Profiles

Goal: Represent caller-visible model names and reusable model entitlements without route tiers.

Scope:

- Add `logical_models` with `direct | router` resolution and the single V1 router kind `classifier`.
- Add `logical_model_targets` linking logical models to eligible deployments in stable priority order.
- Add `access_profiles` and `access_profile_model_grants` with allowed operation IDs and currently enforceable parameter caps.
- Add nullable `api_keys.access_profile_id` with a scoped foreign key. Keep `routing_config_id` only until the runtime cutover.
- Seed idempotent `fable`, `coding-auto`, and `economy-auto` configurations with Opendoor-engineer and external-economy profiles.

Acceptance criteria:

- Logical-model slugs and access-profile slugs are unique within one organization and workspace.
- A target or grant cannot cross an organization or workspace boundary.
- Direct fixtures have one enabled target; classifier fixtures have an explicit bounded target set.
- Seeded external-economy keys have no grant for `fable` or frontier deployments.
- Existing traffic remains unchanged.

Validation:

- Add schema, migration, and idempotent seed tests.
- Run `pnpm --filter @proxy/db test`.
- Run `pnpm typecheck`.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `packages/db/src/seed.ts`
- `packages/db/src/seed.test.ts`
- `packages/schema/src/index.ts`

Dependencies: AGDM-001.

## Phase 1: Resolution

### AGDM-003: Resolve Direct Logical Models

Goal: Resolve one authorized direct logical model to one executable deployment before provider I/O.

Scope:

- Add the `ResolveModelInput`, resolved-target, and typed-denial contracts from the plan.
- Load the API key's access profile and logical-model grant inside the authenticated organization and workspace.
- Enforce operation grants and only parameter caps already supported by the request path.
- Filter disabled profiles, grants, logical models, targets, deployments, connections, and bindings.
- Use the existing wire-compatibility and translator registry to choose a native binding or installed directed adapter.
- Require exactly one eligible target for a direct logical model.
- Keep provider credential loading, request translation, network I/O, classifier calls, and retries outside the resolver.

Acceptance criteria:

- An allowed `fable` request resolves without classifier work.
- An ungranted logical model returns a typed model-access denial.
- Disabled or wire-incompatible resources fail before provider I/O.
- Cross-tenant IDs cannot affect resolution even when supplied directly to the repository layer.
- The resolver has no Fastify dependency.

Validation:

- Add focused resolver tests for success, denial, disabled resources, incompatible wires, and cross-scope substitution.
- Run `pnpm build:runtime`.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/persistence/modelResolution.ts`
- `apps/proxy/src/routingCompatibility.ts`
- `apps/proxy/src/translators/index.ts`
- `apps/proxy/test/modelResolution.test.ts`

Dependencies: AGDM-001 and AGDM-002.

### AGDM-004: Route Classifier Logical Models

Goal: Reuse the structured-output classifier to choose only among an authorized logical model's eligible targets.

Scope:

- Define the bounded `classifier` router config: classifier deployment, instructions, timeout, and retry count.
- Reject recursive classifier logical-model references.
- Present only eligible logical-model target IDs and relevant capabilities to the classifier.
- Validate structured output against those target IDs and retry according to the configured limit.
- Return classifier decision evidence with the resolved target.
- Remove the coding-tier prompt and fallback behavior from the new classifier path; keep the legacy path untouched until cutover.

Acceptance criteria:

- `coding-auto` can choose only one of its enabled, compatible targets.
- `economy-auto` cannot select a frontier deployment absent from its target set.
- Invalid structured output retries and then fails closed without provider inference.
- A classifier deployment must be active, same-scope, and wire compatible.
- No deterministic target is chosen after classifier failure.

Validation:

- Add classifier-router tests for bounded selection, invalid output, retry exhaustion, and disabled classifier deployment.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/src/classifier.ts`
- `apps/proxy/src/persistence/modelResolution.ts`
- `apps/proxy/test/modelResolution.test.ts`
- `packages/schema/src/index.ts`

Dependencies: AGDM-003.

## Phase 2: Configuration Authoring

### AGDM-005: Add Gateway Configuration Admin APIs

Goal: Manage the new resources through one validated control-plane API before they receive traffic.

Scope:

- Add list, detail, create, update, enable, and disable operations for connections, canonical models, deployments, bindings, logical models, targets, access profiles, and grants.
- Add API-key access-profile assignment.
- Reuse one persistence mutation path for API and later TOML apply operations.
- Validate installed adapter kinds, wire IDs, operation IDs, scoped references, and direct-model target count.
- Keep provider secret values write-only and expose only safe hints or references.
- Emit administrative events through `EventService`.

Acceptance criteria:

- Every mutation enforces organization/workspace scope and existing admin authorization.
- Invalid code-owned IDs fail before database mutation.
- Direct logical models cannot be enabled with zero or multiple enabled targets.
- Read responses never expose raw or encrypted secret material.
- Events and current-state rows commit atomically.

Validation:

- Add persistence and GraphQL tests for CRUD, authorization, validation, secret redaction, and event emission.
- Run `pnpm build:runtime`.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm --filter @proxy/web test` if generated GraphQL types change.

Likely files:

- `apps/proxy/src/persistence/gatewayConfigAdmin.ts`
- `apps/proxy/src/graphql/models.ts`
- `apps/proxy/src/graphql/types/*`
- `apps/proxy/test/gatewayConfigAdmin.test.ts`
- `apps/web/src/generated/graphql.ts`

Dependencies: AGDM-001 and AGDM-002.

### AGDM-006: Add TOML Plan And Apply

Goal: Let operators review and apply declarative gateway configuration without creating a second runtime source of truth.

Scope:

- Define one TOML document shape using resource slugs for stable references.
- Add `plan` to parse, validate, resolve references, and print the database diff without writing.
- Add `apply` to execute that plan through the same validated mutation path as the admin API.
- Make repeated apply idempotent.
- Accept secret references only; never accept raw provider credentials in TOML.
- Do not add file watching, export, merge, bidirectional sync, or runtime TOML reads.

Acceptance criteria:

- Invalid references and code-owned IDs fail before any write.
- `plan` performs no database mutations.
- Applying the same file twice produces no second change.
- A successful apply is immediately visible to database-backed resolution.
- API-created and TOML-created resources have the same stored shape and events.

Validation:

- Add command tests for valid plan, invalid plan, apply, rollback on failure, and idempotency.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/scripts/gateway-config.ts`
- `apps/proxy/package.json`
- `apps/proxy/src/persistence/gatewayConfigAdmin.ts`
- `apps/proxy/test/gatewayConfigCli.test.ts`

Dependencies: AGDM-005.

## Phase 3: Evidence And Cutover

### AGDM-007: Persist Gateway Resolution Evidence

Goal: Make every resolved request auditable using the new gateway identities before the traffic switch.

Scope:

- Add nullable cutover columns to requests and route decisions for ingress wire, operation, requested/resolved logical model, access profile, router kind, deployment, connection, egress wire, and wire-adapter version.
- Add deployment, connection, egress-wire, and provider-adapter version columns to provider attempts.
- Update event payload schemas and current-state projections to accept the new evidence.
- Preserve existing usage and cost fields.
- Keep raw prompt text out of event payloads.

Acceptance criteria:

- New evidence is organization/workspace scoped and references the selected resources.
- Event, outbox, and current-state writes remain one transaction.
- Provider attempts identify the exact physical target used.
- Old runtime requests may leave additive cutover columns null until AGDM-008.
- Existing analytics continue to read historical rows.

Validation:

- Add migration and event-projection tests, including rollback behavior.
- Run `pnpm --filter @proxy/db test`.
- Run `pnpm build:runtime`.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `apps/proxy/src/persistence/requestState.ts`
- `apps/proxy/src/persistence/routeDecision.ts`
- `apps/proxy/src/persistence/providerAttempt.ts`
- `apps/proxy/src/events.ts`

Dependencies: AGDM-001 and AGDM-002.

### AGDM-008: Cut All Text Traffic To Logical Models

Goal: Make logical-model resolution the only runtime path for every existing text endpoint.

Scope:

- Materialize every active deployed configuration used by a workspace or API key into the new resources before switching traffic, and fail the migration on an unmappable configuration.
- Extend authenticated API-key identity with `access_profile_id`.
- Resolve models before provider I/O for OpenAI Responses HTTP/WebSocket, OpenAI Chat Completions, Anthropic Messages, and Anthropic token counting.
- Make provider forwarding consume the resolved deployment, connection, and wire binding.
- Preserve native same-wire passthrough and invoke only registered translators for cross-wire traffic.
- Persist AGDM-007 evidence before provider I/O.
- Make `GET /v1/models` require a credential and return only granted logical models.
- Stop all runtime reads of routing configs, route tiers, provider/account bindings, and the mixed model catalog.

Acceptance criteria:

- `fable`, `coding-auto`, and `economy-auto` satisfy the plan's direct, classifier, and access-denial cases.
- Every current text endpoint uses the same resolver and authorization rules.
- Existing Codex, Claude Code, and SDK harness fixtures pass.
- `/v1/models` never advertises an ungranted logical model.
- No request falls back to the legacy runtime path.
- A failed resolution produces the ingress wire's error shape before provider spend.

Validation:

- Add runtime tests for every ingress wire, direct and classifier models, denied models, streaming, translation, and token counting.
- Run `pnpm lint`.
- Run `pnpm typecheck`.
- Run `pnpm test`.
- Run `pnpm smoke:harnesses` when provider credentials are configured.

Likely files:

- `apps/proxy/src/auth.ts`
- `apps/proxy/src/server.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/modelDiscovery.ts`
- `apps/proxy/src/persistence/identity.ts`
- `apps/proxy/test/routingConfigRuntime.test.ts`
- `apps/proxy/test/harness-compatibility.test.ts`

Dependencies: AGDM-003, AGDM-004, AGDM-005, and AGDM-007. This is the one intentionally larger integration PR; splitting it by endpoint would create two runtime configuration models.

## Phase 4: Legacy Removal

### AGDM-009: Remove The Coding-Tier Data Model

Goal: Delete the obsolete schema, APIs, runtime branches, and UI after the traffic cutover.

Scope:

- Drop routing configs and versions, provider/account/key-binding tables, and the mixed model catalog after verifying AGDM-008 no longer reads them.
- Drop `api_keys.routing_config_id`, workspace default-routing-config fields, tier-bound request evidence, and obsolete route settings.
- Re-key provider health and pricing references onto deployments and connections where still required.
- Remove `fast | balanced | hard | deep` constants, schemas, classifier prompts, aliases, seeds, and runtime branches.
- Keep `agent_sessions` but remove or replace only tier-bound fields required by the active session behavior; do not generalize the table in this scope.
- Remove obsolete GraphQL operations and console screens that depend on deleted resources.
- Update durable architecture and operator docs to the logical-model terminology.

Acceptance criteria:

- No shared runtime type or persisted active field requires a coding-tier route name.
- Deleted resources have no callers in proxy, web, jobs, scripts, or tests.
- Provider health, pricing, usage, request history, and session behavior still work through new identifiers.
- There are no compatibility aliases, dual reads, or deprecated configuration paths.
- The full repository builds and tests against the destructive migration.

Validation:

- Run `rg 'ROUTE_NAMES|RouteName|routingConfig|routing_config|providerAccounts|provider_accounts|modelCatalog|model_catalog' apps packages infra` and review every remaining hit.
- Run `rg '\"(fast|balanced|hard|deep)\"' apps packages` and review every remaining tier literal.
- Run `pnpm lint`.
- Run `pnpm typecheck`.
- Run `pnpm test`.
- Run `pnpm build`.

Likely files:

- `packages/schema/src/*`
- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `apps/proxy/src/**/*`
- `apps/web/src/**/*`
- `docs/**/*`

Dependencies: AGDM-008.

## Delivery Order

```text
AGDM-001 -> AGDM-002 -> AGDM-003 -> AGDM-004
                 |          |
                 |          +------------------------+
                 +-> AGDM-005 -> AGDM-006            |
                 +-> AGDM-007 ------------------------+-> AGDM-008 -> AGDM-009
```

AGDM-003, AGDM-005, and AGDM-007 may proceed in parallel after AGDM-002. AGDM-006 is not a runtime-cutover dependency and may land before or after AGDM-008.
