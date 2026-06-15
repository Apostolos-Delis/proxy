# Provider Architecture V1 Tickets

These tickets break the provider architecture scope (`PLAN.md`) into PR-sized units.

The intended delivery shape follows the plan's stages: Stage 0 ships silently, Stage 1a is an additive deploy, Stage 1b is the hard cutover (one deploy containing the jsonb migration), Stage 2 adds the openai-chat dialect, and Stage 4 is interleavable consolidation. Stage 3 (anthropic↔openai cross-family translation) is deferred indefinitely by decision and has no tickets.

## Delivery Rules

- Byte-exact passthrough stays the fast path; no internal re-serialization on the same-dialect path.
- Hard cutover on the routing config document: no v1-compatibility shims; stored documents are migrated in place.
- Org-defined providers never fall back to operator env keys (credential invariant). Auth-bearing keys are rejected in `default_headers` at write time.
- Private-range base URLs require the operator-level `ALLOWED_PRIVATE_UPSTREAM_CIDRS` allowlist (network invariant); link-local/metadata ranges are blocked unconditionally.
- Unknown surface/provider values are stored verbatim; absent values use the `"unknown"` sentinel. Never throw inside the event-projection transaction.
- Pure functions with their own unit tests may land before their traffic; anything wired into the request path waits for its traffic.
- Targets are not health failover; selection rules 1–7 in the plan are normative.
- Proxy/db test suites run against `dist`: run `pnpm build:runtime` after any `packages/schema` or `packages/db` change before testing.

## Stage 0: Correctness Groundwork

### PA-001: Store Unknown Surface/Provider Values Verbatim

Goal: Remove the silent-misattribution landmine where a third provider's traffic books as OpenAI.

Scope:

- Storage paths: `surfaceValue`/`providerValue` pass through unknown non-empty strings verbatim. This includes the `route_decisions.selected_provider` writes at `routeDecision.ts:36,56` — they run inside event projection and must take the lenient variant, or custom-provider decisions in 1b store NULL.
- Guard/filter call sites keep strict known-value behavior — split the helpers (lenient storage variant vs strict `knownSurfaceValue`/`knownProviderValue`) and assign each call site explicitly: `requestState.ts:276` (`isRouteContext` type guard), `adminQueries.ts:1557` (prompt filter validation), `adminQueries.ts:2096` (`baselineCostFor`, which must keep returning 0 for unknown surfaces). The lenient contract becomes load-bearing in Stage 1b/2, so each caller's behavior is decided and tested here.
- Replace (not delete) the `?? "openai"` / `?? "openai-responses"` fallbacks at `providerAttempt.ts:44-45`, `classifierUsage.ts:24`, `sessionRoute.ts:24`, `requestState.ts:85,220`.
- Distinguish the two cases: unknown value → stored verbatim; absent value (e.g. missing `routeContext` with NOT NULL `requests.surface`) → sentinel `"unknown"`. Exception: `sessionRoute.ts` skips session creation entirely when surface is absent — a session row keyed on a sentinel surface has no consumer (the pin loader looks up by the live request's surface).
- Never throw in either case: these run inside the event-projection transaction (`eventSink.ts:35`).
- Open persistence column generics `$type<Provider>`/`$type<Surface>` → `$type<string>` on `usage_ledger`, `provider_attempts`, `route_decisions`, `agent_sessions`, and `requests` (surface column — the sentinel write targets it) so verbatim storage typechecks (compile-time only; columns are already plain text).

Acceptance criteria:

- An unknown provider string round-trips into ledger/attempt/decision rows unchanged.
- Absent surface/provider produce `"unknown"` rows, not `"openai"`/`"openai-responses"`.
- Guard/filter call sites (`isRouteContext`, admin filter validation, `baselineCostFor`) retain strict behavior for unknown values.
- No behavior change for current traffic (only the two known values are produced today).
- Event projection never fails due to an unrecognized value.

Validation:

- Add unit tests for `surfaceValue`/`providerValue` and the call-site behaviors.
- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/persistence/values.ts`
- `apps/proxy/src/persistence/providerAttempt.ts`
- `apps/proxy/src/persistence/classifierUsage.ts`
- `apps/proxy/src/persistence/sessionRoute.ts`
- `apps/proxy/src/persistence/requestState.ts`
- `packages/db/src/schema.ts`

### PA-002: Normalize Chat-Completions Usage

Goal: Teach `normalizeUsage` the chat-completions usage shape before Stage 2 traffic exists.

Scope:

- Handle `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`.
- Preserve the normalization convention: `inputTokens` is the total; cache reads/writes are subsets.
- Pure function only; no request-path wiring (per the early-vs-deferred rule).

Acceptance criteria:

- Chat-completions usage payloads normalize to the existing `NormalizedUsage` shape.
- Existing responses/messages normalization is unchanged (regression tests).

Validation:

- Add unit tests covering all three usage shapes.
- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/persistence/values.ts`

### PA-003: Split SseObserver Into Per-Dialect Observers

Goal: Replace heuristic key-sniffing with dialect-selected observers, locked by golden fixtures.

Scope:

- One observer interface (`status`, `usage`, `outputText`, `responseId`); per-dialect implementations for `anthropic-messages` and `openai-responses`, selected by dialect.
- Golden SSE fixtures: recorded streams for both existing dialects, explicitly covering Anthropic's cross-frame usage merge (`message_start` input tokens + `message_delta` output tokens).
- The chat-chunk observer implementation is deferred to PA-023 (it wires into the request path).

Acceptance criteria:

- Both dialect observers reproduce today's extraction results on the golden fixtures.
- The Anthropic cross-frame merge is covered by an explicit fixture.
- No behavior change for live traffic.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/sseObserver.ts`
- `apps/proxy/test/` (new fixture files)

## Stage 1a: Registry Plumbing (Additive)

### PA-004: Add Providers Table With Builtin Seeds

Goal: Make providers rows, not enum members.

Scope:

- `providers` table per the plan DDL: uuid pk, nullable `org_id`, `slug` with `UNIQUE NULLS NOT DISTINCT (org_id, slug)`, `display_name`, `base_url`, `auth_style` (`bearer | x-api-key | none`), `endpoints` jsonb (`[{dialect, path}]`), `default_headers` jsonb, `forward_harness_headers`, `enabled`.
- Seed builtin `anthropic` + `openai` rows from current env base URLs; the openai row carries both `/responses` and `/chat/completions` endpoints from day one.
- Org slug shadows builtin slug at resolution time (documented; resolution implemented in PA-008/PA-012).

Acceptance criteria:

- Two builtin rows cannot coexist with the same slug (NULLS NOT DISTINCT verified by test).
- Seeds are idempotent.
- Migration tests pass.

Validation:

- Run `pnpm --filter @prompt-proxy/db test`.
- Run `pnpm db:migrate && pnpm db:seed` against local Postgres.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `packages/db/src/seed.ts`

### PA-005: Re-Key Provider Accounts To The Registry

Goal: Bind credentials to registry rows instead of a closed text union.

Scope:

- `provider_accounts.provider` (text union) → `provider_id` uuid FK; backfill from the text value against the builtin rows.
- Migrate `api_key_provider_accounts.provider` consistently — it is part of that table's primary key and the BYOK binding lookup joins on it then compares it against the account's provider (`providerCredentials.ts:47,65`); left as a slug it becomes a uuid-vs-slug comparison and the binding path breaks.
- Add nullable `provider_accounts.base_url` override (VPC-endpoint case).
- Update account persistence/serializers to the new key.

Acceptance criteria:

- Existing accounts backfill onto builtin provider rows with no orphans.
- BYOK key→account binding round-trips end to end for builtin and custom provider rows.
- Account CRUD round-trips `provider_id` and optional `base_url`.
- No raw key material in serializer output (unchanged invariant).

Validation:

- Run `pnpm --filter @prompt-proxy/db test`.
- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `apps/proxy/src/persistence/providerCredentials.ts`
- `apps/proxy/src/persistence/providerCredentialAdmin.ts`
- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/proxy/src/persistence/adminSerializers.ts`

### PA-006: Seed Model Catalog From Vendored models.dev Snapshot

Goal: Make `model_catalog` the real capability/pricing catalog with a hermetic seed.

Scope:

- Re-key `model_catalog` to `(provider_id, model)`; add `capabilities` (efforts subset, modalities, context/output limits) and `pricing` jsonb.
- Vendor a models.dev snapshot into the repo (hermetic tests, no runtime dependency); seed builtin-provider rows from it.
- Preserve existing org pricing-override rows (the table is live data).

Acceptance criteria:

- Catalog rows exist for the models named in seeded routing configs.
- Org pricing-override rows survive the re-key.
- Seed is idempotent; tests run without network access.

Validation:

- Run `pnpm --filter @prompt-proxy/db test`.
- Run `pnpm db:migrate && pnpm db:seed`.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `packages/db/src/seed.ts`
- `packages/db/data/models-dev-snapshot.json` (new)
- `apps/proxy/src/persistence/modelPricing.ts`

### PA-007: Open Provider Type, Add Dialect Enum

Goal: Schema-package groundwork for registry-driven routing without touching the v1 config format.

Scope:

- `Provider` opens to `string` (registry slugs); `PROVIDER_NAMES` retires as a closed union.
- `Dialect` becomes the closed enum `"anthropic-messages" | "openai-responses" | "openai-chat"`.
- Add `providerRegistryEntrySchema` (slug, base_url, auth_style, endpoints, default_headers, forward_harness_headers, enabled).
- The v1 routing-config schema is untouched in this ticket.

Acceptance criteria:

- All packages typecheck with the opened `Provider` type.
- Registry entries validate through the new schema with useful error paths.
- v1 configs still parse byte-identically.

Validation:

- Run `pnpm --filter @prompt-proxy/schema test`.
- Run `pnpm typecheck`.

Likely files:

- `packages/schema/src/index.ts`
- `apps/proxy/src/types.ts`

### PA-008: Drive ProviderProxy From Registry Rows

Goal: Replace the urlFor/headersFor ternaries with registry lookups, byte-identical for builtins.

Scope:

- `ProviderProxy.urlFor`/`headersFor` read the resolved registry row: base URL, endpoint path by dialect, auth style, default headers.
- Provider resolution order: org row shadows builtin slug.
- `anthropic-version` synthesis when absent stays at the dialect edge (unchanged behavior).
- BYOK resolution for builtin rows unchanged (account if bound, else operator env key). Org-row credential resolution must not fall back to env keys even in this ticket — full enforcement and tests are PA-009, but do not bake the `byok?.token ?? config.openaiApiKey` pattern into the org-row path here.

Acceptance criteria:

- Upstream requests for builtin providers are byte-identical before/after (verified by diffing recorded upstream requests in tests).
- A custom registry row with its own base URL and auth style produces correctly addressed, correctly authed requests.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.
- Run `pnpm smoke` when local services are available.

Likely files:

- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/persistence/providers.ts` (new)
- `apps/proxy/test/proxy.test.ts`

### PA-009: Enforce Credential And Network Invariants

Goal: Make org-defined providers safe: no key exfiltration, no SSRF.

Scope:

- Credential invariant: org-defined providers require an attached `provider_accounts` credential unless `auth_style = "none"`; no env-key fallback, ever. (The skip-with-evidence selection behavior lands with PA-012; publish-time flagging lands with PA-019 — this ticket owns the resolution function and its guards.)
- `default_headers` write-time denylist: `authorization`, `x-api-key`, `proxy-authorization`, `cookie`, `host` (`anthropic-version` allowed).
- Network invariant: scheme allowlist; link-local/metadata ranges blocked unconditionally; RFC-1918 ranges valid only when covered by operator env `ALLOWED_PRIVATE_UPSTREAM_CIDRS`.
- `redirect: "manual"` on org-row upstream fetches; connect-time IP pinning to the resolved address (DNS rebinding).

Acceptance criteria:

- Credential resolution for an org row with no credential and `auth_style != "none"` returns unresolvable and never emits an operator env key (unit test proves no auth header is produced; the skip-with-evidence assertion lands in PA-012).
- Auth-bearing `default_headers` keys are rejected at write time.
- A base URL resolving to link-local/metadata is rejected; a private-range URL is rejected unless allowlisted by operator config; a 302 redirect from an org upstream is not followed.

Validation:

- Add focused unit tests for credential resolution and URL/redirect guards.
- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/config.ts`
- `apps/proxy/src/persistence/providers.ts`

## Stage 1b: Config V2 Cutover (One Deploy)

### PA-010: Routing Config V2 Schema

Goal: Tier blocks stop naming providers as fields and become ordered target lists.

Scope:

- `routingConfigRouteSchema`: `{openai?, anthropic?}` → `{targets: RouteTarget[]}` with the canonical target shape including `thinking` and `metadata` (v2 is not lossy).
- `sessionPinnedSettingsSchema`: provider discriminated union → `SessionPin` (target superset + resolved `dialect`).
- Single `EFFORTS` ladder (`minimal | low | medium | high | xhigh | max | ultracode`) replaces `OPENAI_REASONING_EFFORTS` + `ANTHROPIC_EFFORTS`.
- `routingConfigClassifierSchema.provider` → `providerId: string` (pure schema change — the publish-time check that it resolves to a responses-dialect provider needs a registry lookup, which a Zod schema cannot do; that check is implemented once, in PA-017).
- `schemaVersion: 2`; reject v1 documents at parse time (hard cutover).

Acceptance criteria:

- A v2 document with anthropic/openai/custom targets parses; a v1 document fails with a clear error.
- `thinking`/`metadata` round-trip through parse/serialize unchanged.
- Invalid classifier or target entries fail with useful validation paths.

Validation:

- Run `pnpm --filter @prompt-proxy/schema test`.
- Run `pnpm typecheck` (downstream breakage is expected and fixed in PA-012/PA-013/PA-019; sequence within the 1b batch).

Likely files:

- `packages/schema/src/index.ts`

### PA-011: V1→V2 JSONB Migration

Goal: Migrate every stored routing config version in place, losslessly and hash-safely.

Scope:

- Rewrite `routing_config_versions.config`: `.openai` block → `{providerId: "openai", ...}`; `.anthropic` block → `{providerId: "anthropic", ...}` carrying `thinking`/`metadata` verbatim; migrated lists ordered `[anthropic, openai]`.
- Recompute `config_hash` (`sha256(JSON.stringify(config))`) for every rewritten row.
- Pre-flight (read-only, aborts with nothing written): assert no `(org, workspace, hash)` collisions among recomputed hashes; dry-run selection diff asserting v1 selection ≡ v2 selection (model, effort, thinking, maxOutputTokens) per org config per dialect.
- The v1 side of the dry-run diff comes from a frozen, standalone copy of the v1 parser + v1 selection logic vendored inside the migration script — PA-010 deletes v1 parsing and PA-012 deletes `settingsForSurface`, so the migration must not import either. The v2 side uses the live PA-012 selector (sequence PA-011 after PA-012 within the 1b batch).
- Clear `agent_sessions.pinnedSettings` (sessions re-pin; one-time cache-bust window).
- Migrate `organization_settings` baseline keys: `costBaselineAnthropicModel`/`costBaselineOpenaiModel` → per-dialect map; `openai-chat` entry defaults to the responses entry.
- Document rollback: restore `routing_config_versions` + `organization_settings` from pre-migration snapshot only; never snapshot-restore `agent_sessions`.

Acceptance criteria:

- Migration of seeded v1 configs produces v2 documents that select identically per dialect.
- Hash uniqueness invariant holds after migration; collision pre-flight aborts without writes when violated (negative test).
- Baseline keys migrate; pins are cleared.

Validation:

- Add migration tests with fixture v1 documents (including `thinking: {type: "adaptive", display: "omitted"}` defaults).
- Run `pnpm --filter @prompt-proxy/db test`.
- Run `pnpm db:migrate` against local Postgres seeded with v1 data.

Likely files:

- `packages/db/migrations/*.sql` or migration script
- `packages/db/src/schema.ts`
- `apps/proxy/src/persistence/routingConfigAdmin.ts`
- `apps/proxy/src/persistence/organizationSettings.ts`

### PA-012: Implement Selection Rules In The Router

Goal: Replace surface≡provider selection with the plan's selection rules 1–7.

Scope:

- `resolveProviderSettings` evaluates targets in list order; skips missing/disabled/credential-unresolvable providers with evidence recorded on the route decision.
- Same-dialect endpoint preferred (passthrough) before translator-reachable endpoints; `compatible()` (static) and `canServe(target, ctx)` (runtime) split. Translator reachability consults the translator registry, which is stubbed empty until PA-026 registers the first pair.
- No target serves → existing `route_not_available_for_surface` error shape, including inside the classifier-failure route scan.
- Pin handling: stateless sessions re-select with a visible `pin_rebound` decision; stateful sessions fail explicitly; stateful harnesses never pin translated targets (rule 7, decided at session start). Statefulness is read from `HarnessProfile.statefulResponses` — PA-014 lands before this ticket within the 1b batch.
- Delete `settingsForSurface`; replace inline `minimal→low` mapping with catalog-driven clamping (`capabilities.efforts`; unknown models omit the knob).

Acceptance criteria:

- Order, skip, passthrough-preference, and no-target cases each covered by tests.
- A pinned stateless session whose provider is disabled re-selects with `pin_rebound` evidence; a pinned stateful session fails explicitly.
- Effort clamping comes from catalog rows only (no second clamp table).

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/router.ts`
- `apps/proxy/src/catalog.ts`
- `apps/proxy/test/proxy.test.ts`

### PA-013: Dialect-Edge Rewriters In Adapters

Goal: Adapters dispatch on dialect instead of fused surface/provider pairs.

Scope:

- `SurfaceAdapter` drops its embedded `provider` field and gains `dialect`.
- `rewriteSurfaceRequest` dispatches a per-dialect rewriter by the selected endpoint's dialect; stops throwing on mismatch (that's `canServe`'s job upstream).
- Anthropic-only cache transforms (`injectAutomaticCacheControl`, `upgradeCacheControlTtl`) move into the anthropic-messages dialect edge.
- Keep guard/upgrade cache walkers symmetric (existing invariant).
- Sweep the binary surface ternaries that silently default any non-`openai-responses` surface into the anthropic branch — they must become explicit dialect dispatch before a third dialect exists: `pricing.ts:70`, `catalog.ts:103,109,131`, `tokenAttribution.ts:28,38`, `toolResultCompression.ts:57`, `persistence/promptArtifacts.ts:230,240`, `router.ts:505,526,548`, and the `as Surface` cast at `projections.ts:47` (found by the PA-001 review).

Acceptance criteria:

- Same-dialect rewrites are byte-identical to today's output for both existing dialects.
- Cache transforms apply only on the anthropic-messages edge.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test` (includes `cacheTtlUpgrade` suite).

Likely files:

- `apps/proxy/src/adapters.ts`
- `apps/proxy/src/proxy.ts`

### PA-014: HarnessProfile Registry

Goal: One place to add a harness; header forwarding split by trust class.

Sequencing: lands before PA-012 within the 1b batch — selection rules 6–7 consume `statefulResponses` from this registry.

Scope:

- `HarnessProfile` registry with `claude-code`, `codex`, `generic` entries: `detect` (registration order, `generic` mandatory last), `sessionId`, `statefulResponses` (codex: true), `identityHeaders`, `dialectHeaders`, `promptBlockTags`, `bashToolNames`.
- `dialectHeaders` always follow the request to any endpoint serving that dialect; `identityHeaders` go to builtin providers only unless the org row sets `forward_harness_headers`.
- Rewire `features.ts` detection/session extraction, tool-result compression, token attribution, prompt artifacts, and cache-bust semantics onto dialect + profile instead of surface literals.

Acceptance criteria:

- Existing Claude Code and Codex detection/session behavior is unchanged (existing tests pass).
- An anthropic-dialect org endpoint receives `anthropic-version`/`anthropic-beta` but not `x-claude-code-*` identity headers by default.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test` (includes `tokenAttribution` suite).

Likely files:

- `apps/proxy/src/harness.ts` (new)
- `apps/proxy/src/features.ts`
- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/tokenAttribution.ts`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/src/persistence/promptArtifacts.ts`
- `apps/proxy/src/persistence/cacheBusts.ts`

### PA-015: Point wsProxy At The Registry

Goal: Prevent the WS path from sending rewritten requests to the wrong host with the wrong credentials.

Scope:

- WS path reads URL/auth from the selected target's registry row instead of hardcoded `${openaiBaseUrl}/responses` + company key.
- WS-transport `canServe` additionally requires a builtin provider with operator credentials (no BYOK on WS until Stage 4).
- Mechanical updates for the new `rewriteSurfaceRequest`/RoutingService signatures.

Acceptance criteria:

- A WS request selecting a custom responses-dialect target is rejected (builtin-only restriction), not missent to api.openai.com.
- Builtin WS behavior is byte-identical to today.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/wsProxy.ts`

### PA-016: Retire The Env Catalog And Port Its Tests

Goal: Hard cut the env-seeded catalog path; keep env vars as seed inputs only.

Scope:

- Delete the env-seeded 8-entry `ModelCatalog` and surface-scoped alias maps in `catalog.ts`; `OPENAI_*_MODEL`/`ANTHROPIC_*_MODEL` survive only as seed inputs for the default routing config.
- One dialect-agnostic `alias → tier` map; all existing spellings (`router-*`, `claude-router-*`, `anthropic-router-*`) valid on every surface.
- Port the five `DATABASE_URL: ""` test files to a seeded in-memory registry/config fixture: `proxy.test.ts`, `cacheTtlUpgrade.test.ts`, `promptTestFixture.ts`, `setupScript.test.ts`, `tokenAttribution.test.ts`.

Acceptance criteria:

- No runtime code path reads `OPENAI_*_MODEL`/`ANTHROPIC_*_MODEL` outside seeding.
- Every alias spelling resolves on every surface.
- All five ported test files pass against the fixture.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/catalog.ts`
- `apps/proxy/src/config.ts`
- `apps/proxy/test/proxy.test.ts`
- `apps/proxy/test/cacheTtlUpgrade.test.ts`
- `apps/proxy/test/promptTestFixture.ts`
- `apps/proxy/test/setupScript.test.ts`
- `apps/proxy/test/tokenAttribution.test.ts`

### PA-017: Classifier Through The Registry

Goal: Classifier targets a registry provider instead of a hardcoded OpenAI literal.

Scope:

- `classifier.ts` takes a provider registry entry; request body built against the provider's responses-dialect endpoint.
- `config.ts` drops `z.literal("openai")`; the guard moves to publish-time validation (classifier `providerId` must resolve to a responses-dialect endpoint until Stage 2). **This ticket is the single owner of that publish-time check** (in `routingConfigAdmin.ts`): PA-010 only carries the schema field; PA-019 only surfaces this check's result in mutation errors.
- Preserve timeout/retry/structured-output semantics and `timeoutMs` behavior.

Acceptance criteria:

- Classifier works against the builtin openai row unchanged.
- A config naming a chat-only-dialect classifier provider fails at publish time, not per-request.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/classifier.ts`
- `apps/proxy/src/config.ts`
- `apps/proxy/src/persistence/routingConfigAdmin.ts`

### PA-018: Catalog-Driven Pricing And Per-Dialect Baseline

Goal: Price off the attempt's identity, never model-name inference.

Scope:

- Retire `defaultModelPricing` and `providerFromModelName`; ledger pricing keys off the attempt's `(providerId, model)` against the catalog (safe: snapshot seeded in PA-006).
- `CostBaseline` becomes the per-dialect map (migrated in PA-011); savings computation reads it.
- `orgPricingOverrideForModel` drops its provider allowlist.
- `repriceZeroCostUsage` remains the backstop.

Acceptance criteria:

- OSS-host traffic with catalog rows prices correctly; absent rows book $0 and are healed by reprice once rows exist (existing behavior).
- Baseline savings work per dialect, including the chat default-to-responses fallback.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test` (includes usage analytics suites).

Likely files:

- `apps/proxy/src/pricing.ts`
- `apps/proxy/src/persistence/modelPricing.ts`
- `apps/proxy/src/persistence/organizationSettings.ts`

### PA-019: Routing Config GraphQL Cutover

Goal: Admin API speaks v2 targets. (Provider CRUD is split out to PA-031.)

Scope:

- `RouteMatrixRow` (`openaiModel/anthropicModel/openaiEffort/anthropicEffort`) → `targets: [RouteTarget]`; serializers follow.
- Publish-time mutation errors surface the `compatible()` results ("this target will translate / cannot serve surface X"), the PA-017 classifier check, and credential-unresolvable targets per the PA-009 resolution function — the rules are implemented in PA-012/PA-017/PA-009; this ticket only exposes them.
- Expose `effectiveEffort(target)` so clamping is visible to the editor.

Acceptance criteria:

- Routing config queries/mutations round-trip v2 documents.
- Publishing a config with an incompatible target or a non-responses-dialect classifier returns field-level errors.
- Schema printed + codegen artifacts regenerated.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.
- Run the repo's schema:print → codegen flow and `pnpm --filter @prompt-proxy/web typecheck`.

Likely files:

- `apps/proxy/src/graphql/types/routing.ts`
- `apps/proxy/src/persistence/adminSerializers.ts`

### PA-020: Routing Editor Cutover

Goal: The routing editor edits ordered target lists with visible clamping. (Provider CRUD UI is split out to PA-032.)

Scope:

- `RouteTierDraft`'s four provider-named string fields → ordered target-list editor (add/remove/reorder targets; provider select from registry; model select from catalog).
- `PROVIDER_MODEL_OPTIONS` hardcoded list → catalog models via GraphQL.
- `EFFORT_SCALE` merge hack → the single ladder, showing `effectiveEffort` ("max → xhigh on this model") instead of clamping silently.
- `compatible()` warnings shown per target.

Acceptance criteria:

- An operator can author, reorder, and publish a v2 config with builtin and custom targets.
- Clamped efforts and will-translate targets are visibly annotated.
- No direct `useEffect`; component files follow repo conventions.

Validation:

- Run `pnpm --filter @prompt-proxy/web typecheck` and `pnpm build`.
- Manual browser check against seeded data.

Likely files:

- `apps/web/src/routingConfigEditor.ts`
- `apps/web/src/routing/modelSelect.tsx`
- `apps/web/src/gql/`

### PA-021: Generate /v1/models From Aliases And Registry

Goal: Stop hand-maintaining the models listing.

Scope:

- `/v1/models` response generated from the alias→tier map plus enabled registry providers/catalog entries.

Acceptance criteria:

- All alias spellings appear; response shape unchanged for existing harnesses.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/server.ts`

### PA-031: Provider CRUD GraphQL API

Split from PA-019 during review. Additive — may land before or alongside the rest of the 1b batch: org rows are inert until a v2 config targets them.

Goal: Orgs can manage custom provider rows over the admin API.

Scope:

- List/create/update/disable org providers (endpoints, base URL, auth style, non-auth headers, `forward_harness_headers`).
- Credential attach to provider rows (PA-005 binding).
- Mutations delegate to the PA-009 guards (`default_headers` denylist, network invariant) — the rules are not reimplemented here.

Acceptance criteria:

- Provider CRUD round-trips; builtin rows are read-only over the API.
- A mutation with an auth-bearing default header or a disallowed base URL fails with a field-level error sourced from the PA-009 guards.
- Schema printed + codegen artifacts regenerated.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.
- Run the repo's schema:print → codegen flow and `pnpm --filter @prompt-proxy/web typecheck`.

Likely files:

- `apps/proxy/src/graphql/types/providers.ts` (new)
- `apps/proxy/src/persistence/providers.ts`
- `apps/proxy/src/persistence/adminSerializers.ts`

### PA-032: Provider CRUD UI

Split from PA-020 during review. Depends on PA-031; may land alongside the rest of the 1b batch.

Goal: Operators manage custom providers from the console.

Scope:

- Extend the existing providers page: list builtin + org rows; create/edit/disable org providers (endpoints, base URL, auth style, non-auth headers, `forward_harness_headers`); credential attach.
- Guard errors from PA-031 shown next to the offending field.

Acceptance criteria:

- An operator can create a custom provider and attach a credential entirely from the console.
- Builtin rows are visibly non-editable.
- No direct `useEffect`; component files follow repo conventions.

Validation:

- Run `pnpm --filter @prompt-proxy/web typecheck` and `pnpm build`.
- Manual browser check against seeded data.

Likely files:

- `apps/web/src/providers/`
- `apps/web/src/gql/`

## Stage 2: The openai-chat Dialect

### PA-022: Inbound Chat-Completions Surface

Goal: Accept `POST /v1/chat/completions` as a first-class surface.

Sequencing: ships in the same deploy as PA-023 — the chat observer must be registered before the surface accepts streaming traffic, or chat usage goes unobserved. Build PA-023 first (fixture-tested, inert until this surface exists — the PA-002 pattern).

Scope:

- New route in `server.ts` with a chat-dialect `SurfaceAdapter`: RouteContext extraction from `messages[]`, `tools[]`, image parts.
- `/v1/messages/count_tokens` stays anthropic-only; the chat surface 404s there.
- Alias + explicit-model routing identical to other surfaces.

Acceptance criteria:

- A plain `openai` SDK pointed at the proxy completes a chat request end-to-end against an openai-chat-capable target.
- RouteContext (tier signals, session id when present) populates from chat bodies.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.
- Run `pnpm smoke:harnesses` when provider keys are configured.

Likely files:

- `apps/proxy/src/server.ts`
- `apps/proxy/src/adapters.ts`
- `apps/proxy/src/features.ts`

### PA-023: Chat-Chunk SSE Observer And Usage Injection

Goal: Observe chat streams with the Stage-0 interface.

Sequencing: built before PA-022 and shipped in the same deploy (see PA-022). The observer is fixture-tested and inert until the surface exists; the `include_usage` injection lives at the chat dialect edge, which only runs once PA-022 lands.

Scope:

- Chat-chunk observer implementation (deltas, `finish_reason`, usage frames) behind the PA-003 interface.
- Inject `stream_options.include_usage` when absent so usage is observable.
- Golden chat-stream fixtures extend the Stage-0 set.

Acceptance criteria:

- Usage/status/text extraction works on recorded chat streams, including providers that omit usage (handled as today's no-usage case).

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/sseObserver.ts` (or per-dialect observer modules)
- `apps/proxy/test/` fixtures

### PA-024: opencode And Cursor Harness Profiles

Goal: First-class profiles for the two new harnesses.

Scope:

- opencode profile: detection, `prompt_cache_key`-based session extraction on the openai path, prompt-block defaults.
- Cursor profile: detection + flat-tool normalization quirks (per BYOK research).
- Both registered ahead of `generic`.

Acceptance criteria:

- opencode and Cursor requests attribute sessions correctly and route like any other harness.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/harness.ts`
- `apps/proxy/src/features.ts`

### PA-025: Third-Surface Persistence And Console Ripple

Goal: `openai-chat` shows up honestly everywhere a surface value is read.

Scope:

- Sweep read paths: `requests.surface`, `provider_attempts.surface`, `route_decisions`, ledger rollup grouping by surface.
- Per-dialect baseline map entry for `openai-chat` becomes settable.
- Web console logs/usage filters gain `openai-chat`.

Acceptance criteria:

- Chat-surface traffic appears in logs/usage with correct filtering and rollups; no bucket silently merges into responses.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.
- Run `pnpm --filter @prompt-proxy/web typecheck`; manual console check.

Likely files:

- `apps/proxy/src/persistence/usageRollups.ts`
- `apps/proxy/src/graphql/`
- `apps/web/src/requestsPage.tsx`
- `apps/web/src/usagePage.tsx`
- `apps/web/src/usageBreakdown.tsx`
- `apps/web/src/usageData.ts`

### PA-026: Responses↔Chat Translators

Goal: The same-family dialect pair, both directions, with regression fixtures.

Scope:

- Translator registry (`translators.register(from, to, {request, response, sseTransform})`); wire translator reachability into `compatible()`/`canServe()` (stubbed empty in PA-012 — this ticket makes the translated path selectable).
- `openai-responses ↔ openai-chat`: `instructions`+`input` ↔ `messages`, tool definitions, `reasoning.effort` ↔ `reasoning_effort`, `max_output_tokens` ↔ `max_completion_tokens`; response mapping; streaming transform (`response.output_text.delta` ↔ chat deltas, tool-call item events ↔ `tool_calls` deltas, usage frames).
- Translated requests tagged in `route_decisions`; golden-transcript fixtures both directions.
- Statefulness handled by selection rule 7 + per-request `canServe` backstop (no silent mid-session fallthrough).

Acceptance criteria:

- Golden transcripts round-trip; tool-call and usage frames map correctly.
- A Codex (stateful) session never pins a translated chat target.
- Translated requests are filterable in route decisions.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/translators/` (new)
- `apps/proxy/src/router.ts`
- `apps/proxy/test/` fixtures

### PA-027: Onboarding Docs

Goal: Make the new connection paths usable by others.

Scope:

- Cursor BYOK and opencode connection guides (base-URL overrides, alias model IDs, key setup).
- Update `README.md` and the architecture doc with the dialect/registry model.
- Link new docs from `docs/index.md`.

Acceptance criteria:

- A developer can connect opencode (all three paths) and Cursor BYOK from docs alone.

Validation:

- Run `rg` link check over `docs/`; `pnpm typecheck` unaffected.

Likely files:

- `README.md`
- `docs/model-routing-proxy.md`
- `docs/harnesses/*.md` (new)
- `docs/index.md`

## Stage 4: Consolidation (Interleavable After 1b)

### PA-028: Unify wsProxy Onto The Shared Pipeline

Goal: One pipeline, two transports.

Scope:

- Transport adapter so the WS path shares capture, compression, BYOK, and observer machinery.
- Lift the builtin-only restriction from WS `canServe`.

Acceptance criteria:

- WS requests support BYOK and custom providers with identical semantics to HTTP.

Validation:

- Run `pnpm build:runtime && pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/wsProxy.ts`
- `apps/proxy/src/proxy.ts`

### PA-029: models.dev Refresh Job

Goal: Keep the catalog current without trusting it blindly.

Scope:

- Daily fetch of `models.dev/api.json`; additive-upsert, accept-latest; org overrides always win; rows never auto-deleted or capability-downgraded; audit row per refresh.
- Vendored snapshot remains the hermetic-test fixture and cold-start seed.

Acceptance criteria:

- Refresh applies new models/prices, never removes rows, writes audit rows; failures are non-fatal.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test` with a fixture payload.

Likely files:

- `apps/proxy/src/jobs/modelCatalogRefresh.ts` (new)
- `apps/proxy/src/persistence/modelPricing.ts`

### PA-030: Cleanup

Goal: Remove superseded artifacts.

Scope:

- Retire `route_policies` (written only by seed, read nowhere).
- Delete the `Proxy/` dead prototype directory.

Acceptance criteria:

- `rg "route_policies"` shows only historical docs and migration files (the foundation migration and the new drop migration necessarily mention it); build/tests pass without the prototype.

Validation:

- Run `pnpm test`.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/src/seed.ts`
- `packages/db/src/seed.test.ts`
- `Proxy/`

## Suggested PR Batches

1. PA-001 to PA-003: Stage 0 correctness groundwork (ships silently).
2. PA-004 to PA-009: Stage 1a registry plumbing (additive deploy).
3. PA-010 to PA-021 plus PA-031/PA-032: Stage 1b cutover (one deploy; PA-010/PA-011 are the spine — land the batch together; PA-031/PA-032 are additive and may land before or alongside the rest).
4. PA-022 to PA-027: Stage 2 chat dialect (PA-023 is built first and ships in the same deploy as PA-022).
5. PA-028 to PA-030: Stage 4 consolidation (interleavable after batch 3).

## Dependency Graph

Children depend on the nearest less-indented ancestor, with extra dependencies in parentheses; nodes sharing a line are independent of each other.

```text
PA-001  PA-002  PA-003          (independent; ship first)

PA-004
  -> PA-005
  -> PA-006
  -> PA-008 (needs PA-007)
      -> PA-009
          -> PA-031 (needs PA-005; additive, may land early)
              -> PA-032

PA-007
  -> PA-010
      -> PA-014
          -> PA-012 (needs PA-009, PA-006 clamps; supplies the v2 selector)
              -> PA-011 (needs PA-004 seeds; vendors a frozen v1 parser/selector)
              -> PA-013
                  -> PA-015
              -> PA-016
                  -> PA-021
              -> PA-017
      -> PA-018 (needs PA-006, PA-011)
      -> PA-019 (surfaces PA-012/PA-017 validation)
          -> PA-020

Stage 2 (after the 1b batch):
PA-023 (needs PA-002, PA-003)
  -> PA-022 (same deploy as PA-023)
      -> PA-024 (needs PA-014)
      -> PA-025
PA-026 (needs PA-012, PA-013, PA-023)
PA-027 (last)

Stage 4: PA-028 (needs PA-015), PA-029 (needs PA-006), PA-030 (anytime after 1b)
```
