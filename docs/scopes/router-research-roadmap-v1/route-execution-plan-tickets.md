# Route Execution Plan V1 Tickets

These tickets break the route execution plan scope into PR-sized units.

The intended delivery shape is evidence first: record a durable plan for the routing behavior Proxy already has, then add richer candidate evaluation, provider-attempt linkage, and console visibility. This scope does not add fallback behavior, adaptive target ordering, new providers, or broad translation expansion.

## Delivery Rules

- Record the route execution plan after classification and before provider spend.
- Fail before provider calls when persistence is enabled and the plan cannot be recorded.
- Keep request handlers thin; route plan construction belongs in service/helper code.
- Do not add deterministic routing fallback when classification fails.
- Do not store raw prompt text in route plans, event payloads, skip reasons, or provider attempts.
- Keep skip reasons typed and enumerable, not free-form prose.
- Treat the route plan as immutable evidence for the request; terminal outcomes live on provider attempts and terminal events.
- Preserve current runtime selection behavior until later provider health and auditable fallback scopes intentionally change it.

## Phase 0: Contract And Data Model

### REP-001: Define Route Execution Plan Contract

Goal: Create the typed plan contract shared by runtime construction, persistence, admin APIs, and the web console.

Scope:

- Define `RouteExecutionPlan`, candidate, selected target, policy result, and skip reason shapes.
- Include `schemaVersion`, request identity, surface, dialect, classifier, routing config snapshot, ordered candidates, selected target, and policy results.
- Add typed skip reasons for translator missing, previous response id, websocket native-only, stateful translation unavailable, model capability unavailable, provider disabled, missing credential, account cooldown, model lockout, budget limit, and rate limit.
- Normalize existing translation compatibility reason strings into route skip reasons.
- Reject unknown schema versions and unknown skip reasons.

Acceptance criteria:

- A minimal native single-candidate plan validates successfully.
- A translated candidate plan validates successfully.
- Unknown skip reasons fail validation.
- Unknown plan schema versions fail validation.
- No field accepts or requires raw prompt text.

Validation:

- Add schema unit tests in `packages/schema` or the nearest existing proxy test package.
- Run `pnpm typecheck`.

Likely files:

- `packages/schema/src/index.ts`
- `packages/schema/src/translationCompatibility.ts`
- `packages/schema/src/translationCompatibility.test.ts`
- `apps/proxy/src/router.ts`

### REP-002: Add Route Plan Persistence Fields

Goal: Store immutable route execution evidence with each route decision and link provider attempts back to candidates.

Scope:

- Add `route_execution_plan jsonb not null default '{}'` to `route_decisions`.
- Add `selected_candidate_id`, `translated`, and `translator_id` to `route_decisions`.
- Add `route_candidate_id`, `attempt_index`, `fallback_index`, and `skip_reason` to `provider_attempts`.
- Keep all new durable rows scoped by organization and workspace through existing parent rows.
- Add indexes only where query paths need them; avoid table sprawl in V1.

Acceptance criteria:

- New columns are represented in Drizzle schema and migrations.
- Existing persisted requests migrate without data loss.
- Provider attempts can be joined to the selected candidate id recorded on the route decision.
- `translated` defaults to `false` for existing rows.

Validation:

- Run `pnpm --filter @proxy/db test`.
- Run `pnpm db:migrate` against local Postgres.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `packages/db/src/schema.test.ts`
- `apps/proxy/src/persistence/adminSerializers.ts`

### REP-003: Add Route Plan Event Projection

Goal: Make route plan writes flow through the event backbone instead of direct table mutation from transport code.

Scope:

- Add event payload support for `routing.plan_recorded`.
- Persist plan payload, selected candidate metadata, translation metadata, and routing config snapshot through the route decision projection.
- Support `routing.target_selected` if a separate selected-target event is cleaner than expanding the plan event payload.
- Keep high-volume skipped-candidate evidence summarized inside `routing.plan_recorded` unless a target is skipped after an attempted selection.
- Reject or sanitize invalid event payloads before projection writes.

Acceptance criteria:

- Event projection writes route plan fields into `route_decisions`.
- Event projection remains idempotent for repeated route decision events.
- Invalid plan payloads do not create partial route decision rows.
- Event payloads contain identifiers and typed reasons, not prompt text.

Validation:

- Add or update event projection tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/events.ts`
- `apps/proxy/src/persistence/eventProjector.ts`
- `apps/proxy/src/persistence/routeDecision.ts`
- `apps/proxy/src/persistence/values.ts`
- `apps/proxy/test/persistence.test.ts`

## Phase 1: Record Current Runtime Behavior

### REP-004: Build Plans For Existing Native Selection

Goal: Generate a route execution plan for the router behavior that exists today without changing provider selection.

Scope:

- Add a route plan builder that accepts request context, classifier result, routing config snapshot, resolved route target, and compatibility result.
- Emit one ordered candidate for current single-target behavior.
- Mark native targets with `translated: false` and no translator id.
- Fill selected target metadata from the same provider/model/dialect that runtime already sends upstream.
- Keep the builder independent of Fastify request objects.

Acceptance criteria:

- Existing native OpenAI Responses requests produce a non-empty plan.
- Existing native Anthropic Messages requests produce a non-empty plan.
- The selected provider/model in the plan matches the upstream provider attempt.
- No request path behavior changes except additional evidence being recorded.

Validation:

- Add route plan builder unit tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/router.ts`
- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/defaultRoutingConfig.ts`
- `apps/proxy/test/proxy.test.ts`

### REP-005: Persist Plans Before Provider Attempts

Goal: Enforce the ordering invariant that route evidence is durable before any upstream model spend.

Scope:

- Thread the route plan from routing into the persistence event flow.
- Ensure the plan event is appended before `provider.request_started`.
- Fail closed before provider calls when persistence is enabled and plan persistence fails.
- Keep in-memory/no-persistence local behavior usable with equivalent in-memory evidence where applicable.
- Preserve current terminal event handling.

Acceptance criteria:

- Tests prove `routing.plan_recorded` is appended before the provider-started event.
- With persistence enabled, a plan write failure prevents upstream fetch.
- Provider attempts still reach terminal status on success, failure, stream completion, and cancellation.
- Existing smoke behavior remains unchanged when persistence is disabled.

Validation:

- Add ordering tests around proxy request execution.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm smoke` when local services are available.

Likely files:

- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/events.ts`
- `apps/proxy/src/persistence/eventSink.ts`
- `apps/proxy/src/persistence/requestState.ts`
- `apps/proxy/test/proxy.test.ts`

### REP-006: Link Provider Attempts To Route Candidates

Goal: Make each provider attempt explain which planned candidate it executed.

Scope:

- Include `routeCandidateId`, `attemptIndex`, and `fallbackIndex` in provider-started event payloads.
- Persist candidate linkage on `provider_attempts`.
- Set `attemptIndex` to `0` and `fallbackIndex` to `0` for current single-attempt behavior.
- Keep `skipReason` null for executed attempts unless a later runtime skip happens after candidate selection.

Acceptance criteria:

- Provider attempt rows include the selected candidate id.
- The selected candidate id matches `route_decisions.selected_candidate_id`.
- Existing provider attempt summaries expose the linkage to admin consumers.
- Usage ledger creation still works for linked attempts.

Validation:

- Add persistence tests for provider attempt linkage.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/persistence/providerAttempt.ts`
- `apps/proxy/src/persistence/adminSerializers.ts`
- `apps/proxy/test/persistence.test.ts`

## Phase 2: Candidate Evaluation And Skip Evidence

### REP-007: Expand Plans Across Configured Route Targets

Goal: Represent all configured targets for the selected route tier, even before fallback behavior executes them.

Scope:

- Build candidates from the resolved routing config target list in order.
- Include provider id, model, endpoint dialect, provider account ids when known, translation status, translator id, eligibility, and factor booleans.
- Keep final selected target equal to the existing runtime-selected target.
- Mark unselected candidates as evaluated evidence, not fallback attempts.
- Preserve routing config version id, version number, and hash in the plan.

Acceptance criteria:

- A multi-target route config produces multiple ordered candidates in the plan.
- The selected candidate is the target current runtime would have selected.
- Candidate order matches the immutable routing config version.
- Updating the routing config after a request does not change the stored plan evidence.

Validation:

- Add route plan builder tests for multi-target configs.
- Add integration coverage that stored config hashes survive later config updates.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/router.ts`
- `apps/proxy/src/persistence/routingConfig.ts`
- `apps/proxy/src/persistence/routeDecision.ts`
- `apps/proxy/test/proxy.test.ts`

### REP-008: Record Translation Compatibility Skip Reasons

Goal: Explain native vs translated eligibility using durable, typed route skip reasons.

Scope:

- Map translation compatibility outcomes to route plan candidate fields.
- Record `target_unavailable_translator_missing` when no translator can serve the source and target dialects.
- Record `target_unavailable_previous_response_id` when stateful OpenAI response continuation blocks translation.
- Record `target_unavailable_stateful_websocket` or websocket-native-only skip reasons for realtime/native-only traffic.
- Record `target_unavailable_model_capability` when a target cannot satisfy known model or dialect capabilities.

Acceptance criteria:

- `previous_response_id` makes translated candidates ineligible with the expected skip reason.
- Websocket traffic marks translated targets ineligible with the expected skip reason.
- Native candidates remain eligible when the incoming dialect is supported directly.
- Existing translation compatibility tests still pass.

Validation:

- Add route plan tests for compatibility skip reasons.
- Run `pnpm --filter @proxy/schema test`.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `packages/schema/src/translationCompatibility.ts`
- `packages/schema/src/translationCompatibility.test.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/test/proxy.test.ts`

### REP-009: Thread Existing Policy Gates Into Candidate Factors

Goal: Reserve a stable plan shape for policy, credential, budget, and rate-limit gates without inventing new policy behavior.

Scope:

- Populate candidate factor fields from checks that already exist in runtime or credential resolution.
- Record missing-credential skips for org-defined providers when existing credential resolution fails.
- Carry current budget check evidence into plan `policyResults` and candidate factors where available.
- Leave account cooldown, model lockout, and rate-limit factors as `null` until their owning scopes add runtime checks.
- Avoid duplicating policy business logic inside route handlers.

Acceptance criteria:

- Plans distinguish `false` checks from unknown/not-yet-evaluated `null` checks.
- Existing missing credential behavior is visible as a typed skip reason when it already blocks routing.
- Existing budget evidence appears in the plan without changing budget enforcement behavior.
- Future provider health and limits scopes can add checks without changing the top-level plan contract.

Validation:

- Add unit tests for candidate factor serialization.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/policy.ts`
- `apps/proxy/src/persistence/providerCredentials.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/src/persistence/routeDecision.ts`

## Phase 3: Admin APIs And Console

### REP-010: Expose Route Plans Through Admin Request Detail

Goal: Make persisted route execution plans available through the existing request detail API.

Scope:

- Add route plan, selected candidate id, translated flag, translator id, and provider attempt candidate linkage to admin serializers.
- Extend GraphQL request detail types to expose the new fields.
- Keep list views lightweight; route plan JSON should be returned only where request detail needs it.
- Preserve existing request and prompt detail payloads for fields outside this scope.

Acceptance criteria:

- Request detail returns the full route execution plan.
- Provider attempt summaries include route candidate linkage.
- Request list queries do not fetch or serialize large route plan payloads unnecessarily.
- GraphQL tests cover the new fields.

Validation:

- Add or update GraphQL/admin serializer tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/proxy/src/persistence/adminSerializers.ts`
- `apps/proxy/src/graphql/models.ts`
- `apps/proxy/src/graphql/types/requests.ts`
- `apps/proxy/src/graphql/queries.ts`

### REP-011: Render Route Plan Evidence In Request Detail

Goal: Let operators explain why a request used its final provider/model from the console.

Scope:

- Add a route plan panel to the request detail view.
- Show classifier route and confidence, routing config version/hash, selected target, native vs translated status, and ordered candidates.
- Show skip reasons as compact labels and provider attempt terminal status beside the matching candidate.
- Use shared JSON rendering only for raw expanded payload inspection; the primary view should be a scan-friendly table or facts layout.
- Do not use `useEffect` directly.

Acceptance criteria:

- Request detail visually identifies the selected candidate.
- Candidate rows show provider, model, dialect, native/translated status, eligibility, and skip reasons.
- Provider attempts are matched to candidates when linkage exists.
- Empty or legacy plans degrade cleanly without crashing the page.

Validation:

- Add or update web data/component tests.
- Run `pnpm --filter @proxy/web test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/web/src/requestsPage.tsx`
- `apps/web/src/requestsPageData.ts`
- `apps/web/src/requestsPageData.test.ts`
- `apps/web/src/jsonView.tsx`
- `apps/web/src/styles/proxy/pages.css`

### REP-012: Add Route Plan Filters And Summary Fields

Goal: Make route plan evidence useful for operational triage, not just one-off request inspection.

Scope:

- Add request filters for translated traffic, fallback applied, all candidates skipped, missing credential, account cooldown, budget limit, and rate-limit skips.
- Implement filters only against fields that are persisted and indexed or acceptably queryable for expected admin volume.
- Add compact list summary fields for translated traffic and selected provider/model when they do not create heavy JSON reads.
- Defer expensive JSONB filters unless the query plan is acceptable.

Acceptance criteria:

- Operators can filter to translated requests.
- Operators can filter to missing-credential, budget, and rate-limit skips once those skip reasons exist in stored plans.
- Request list performance does not regress meaningfully for normal unfiltered views.
- Filters behave clearly when older rows have empty route plans.

Validation:

- Add admin query tests for each supported filter.
- Add web data tests for filter serialization.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm --filter @proxy/web test`.

Likely files:

- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/proxy/src/graphql/types/search.ts`
- `apps/web/src/requestsPage.tsx`
- `apps/web/src/requestsPageData.ts`
- `apps/web/src/styles/proxy/table.css`

## Phase 4: Documentation And Rollout

### REP-013: Document Route Plan Contract And Rollout

Goal: Give future router scopes a stable contract to depend on.

Scope:

- Update route execution plan docs with the final schema, event names, persistence columns, and console behavior.
- Document which skip reasons are populated in V1 and which are reserved for provider health, fallback, policy pipeline, and limits scopes.
- Add rollout notes for persistence-enabled environments.
- Link the ticket breakdown from the roadmap index and docs index.

Acceptance criteria:

- Docs reflect the implemented plan shape, not the initial draft if implementation changed.
- Later scopes can cite this contract for provider health, fallback, limits, and policy work.
- `docs/index.md` links the ticket breakdown.

Validation:

- Run `rg "Route execution plan|route execution plan|routing.plan_recorded" docs`.
- Run `pnpm lint`.

Likely files:

- `docs/scopes/router-research-roadmap-v1/route-execution-plan.md`
- `docs/scopes/router-research-roadmap-v1/README.md`
- `docs/index.md`
