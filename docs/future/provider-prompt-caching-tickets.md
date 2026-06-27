# Provider Prompt Caching Expansion Tickets

Use these as issue-tracker tickets for [Provider Prompt Caching Expansion](provider-prompt-caching.md). They are ordered so current behavior is aligned first, observe-only planning lands before new request mutation, and provider-specific controls remain opt-in until cache-hit and spend data prove value.

## Milestones

- **M0: Alignment** - fix product/runtime drift and document current provider support.
- **M1: Observe-Only Plan** - add provider capability data, canonical cache plans, events, metrics, and console visibility without changing forwarded bytes.
- **M2: Anthropic Plan Cutover** - move existing Anthropic cache transforms behind the canonical plan with no behavior change.
- **M3: OpenAI Implicit Cache Analytics** - make OpenAI cache-key and hit-rate behavior visible without adding undocumented request fields.
- **M4: Provider Expansion** - prove the adapter pattern with one additional provider family in observe-only mode.
- **M5: Prewarm Experiment** - add capped, opt-in prewarm support only for providers with a documented prewarm primitive.
- **M6: Cache Hygiene Hardening** - expand bust attribution and rollout guidance for operators.

## Backlog

| ID | Title | Milestone | Size | Depends | Runtime behavior |
| --- | --- | --- | --- | --- | --- |
| PPC-001 | Resolve OpenAI retention copy/runtime drift | M0 | S | - | Docs/UI or runtime alignment |
| PPC-002 | Document current prompt-cache support for operators | M0 | S | PPC-001 | Docs only |
| PPC-003 | Define provider caching capability contract | M1 | M | PPC-001 | None |
| PPC-004 | Add observe-only PromptCachePlan computation | M1 | M | PPC-003 | Evidence only |
| PPC-005 | Emit prompt-cache plan events and metrics | M1 | M | PPC-004 | Evidence only |
| PPC-006 | Surface prompt-cache plans in the Caching page | M1 | M | PPC-005 | Console only |
| PPC-007 | Move Anthropic cache transforms behind PromptCachePlan | M2 | M | PPC-004 | Existing Anthropic behavior only |
| PPC-008 | Add Anthropic plan golden tests and count-token parity | M2 | M | PPC-007 | Tests only |
| PPC-009 | Spike static-prefix Anthropic breakpoints | M2 | S | PPC-007, PPC-008 | Spike or observe-only |
| PPC-010 | Add OpenAI cache-key and hit-rate analytics | M3 | M | PPC-005 | Evidence only |
| PPC-011 | Add OpenAI cache-field skip reasons across translations | M3 | S | PPC-004 | Evidence only |
| PPC-012 | Add provider-specific usage normalization fixtures | M4 | M | PPC-003 | Tests only |
| PPC-013 | Add one third-provider observe-only cache adapter | M4 | M | PPC-003, PPC-012 | Evidence only |
| PPC-014 | Define prewarm job model, caps, and accounting | M5 | M | PPC-005 | Internal only |
| PPC-015 | Implement provider-supported prewarm experiment | M5 | L | PPC-014 | Opt-in prewarm only |
| PPC-016 | Expand cache-bust attribution causes | M6 | M | PPC-005, PPC-010 | Evidence only |
| PPC-017 | Add rollout runbook and operator guidance | M6 | S | PPC-006, PPC-016 | Docs only |

## PPC-001: Resolve OpenAI Retention Copy/Runtime Drift

Labels: `area:docs`, `area:web`, `area:proxy`, `type:cleanup`

Goal: Remove the current contradiction where settings copy says OpenAI requests always get 24-hour prompt-cache retention while runtime rewrites strip `prompt_cache_retention`.

Scope:

- Decide whether Proxy should support OpenAI `prompt_cache_retention` now.
- If not supported, update settings copy and docs to say OpenAI retention fields are stripped and OpenAI caching is currently implicit-prefix only.
- If supported, verify current OpenAI API behavior, stop stripping the field where appropriate, and add OpenAI Responses and Chat tests.
- Keep this ticket focused on alignment. Do not introduce the broader policy model here.

Acceptance criteria:

- Product copy, docs, runtime behavior, and tests agree.
- OpenAI request rewrite tests cover the chosen behavior.
- No provider field is forwarded based on stale or unverified assumptions.

Likely files:

- `apps/web/src/settingsPageData.ts`
- `apps/web/src/settingsPageData.test.ts`
- `apps/proxy/src/adapters.ts`
- `apps/proxy/src/translators/openai.ts`
- `apps/proxy/test/automaticCaching.test.ts`
- `docs/future/provider-prompt-caching.md`

Validation:

- `pnpm --filter @proxy/web test`
- `pnpm --filter @proxy/proxy test -- automaticCaching`
- `pnpm typecheck`

## PPC-002: Document Current Prompt-Cache Support For Operators

Labels: `area:docs`, `area:caching`

Goal: Give operators a clear current-state guide before new cache controls land.

Scope:

- Add a user-guide section for prompt-cache support by provider and surface.
- Explain Anthropic `automaticCaching` and `cacheTtlUpgrade`.
- Explain OpenAI implicit-prefix behavior, preserved native `prompt_cache_key`, and translation skip/drop behavior.
- Link to the Caching page, token attribution, cache-bust reporting, and spend accounting.
- Keep future roadmap content in the future docs; keep the user guide operational.

Acceptance criteria:

- Operators can tell which controls are Anthropic-only today.
- Operators can tell what Proxy measures for OpenAI even without explicit controls.
- The docs index links the new guide section if a new page is added.

Likely files:

- `docs/user-guide/analytics.md`
- `docs/user-guide/monitoring.md`
- `docs/user-guide/README.md`
- `docs/index.md`

Validation:

- `git diff --check`

Dependencies: PPC-001.

## PPC-003: Define Provider Caching Capability Contract

Labels: `area:proxy`, `area:providers`, `area:caching`, `type:design`

Goal: Add a typed capability model that describes what prompt-cache controls each selected provider target supports.

Scope:

- Define `ProviderCachingCapabilities` in the provider registry/catalog layer.
- Include implicit prefix caching, explicit breakpoints, supported TTLs, cache key field, retention field, prewarm support, and usage shape.
- Seed built-in OpenAI and Anthropic capability values from current verified behavior.
- Expose capability data to route planning and request rewrite code without changing forwarded request bodies.
- Add tests for default/built-in capabilities and provider registry serialization.

Acceptance criteria:

- Capability data is available for selected provider deployments.
- OpenAI and Anthropic have explicit capability records.
- No request mutation changes in this ticket.
- Unknown/custom providers default to conservative capabilities.

Likely files:

- `packages/schema/src/index.ts`
- `packages/db/src/schema.ts` if capabilities are persisted
- `packages/db/migrations/*` if capabilities are persisted
- `apps/proxy/src/persistence/providerRegistryAdmin.ts`
- `apps/proxy/src/persistence/providers.ts`
- `apps/proxy/src/catalog.ts`
- `apps/proxy/test/providerRegistry*.test.ts`

Validation:

- `pnpm --filter @proxy/schema test`
- `pnpm --filter @proxy/db test` if persistence changes
- `pnpm --filter @proxy/proxy test -- providerRegistry`
- `pnpm typecheck`

Dependencies: PPC-001.

## PPC-004: Add Observe-Only PromptCachePlan Computation

Labels: `area:proxy`, `area:routing`, `area:caching`

Goal: Compute a canonical prompt-cache plan for each provider attempt without changing forwarded bytes.

Scope:

- Add `PromptCachePlan` with mode, provider, dialect, cache key, retention, breakpoint strategy, applied controls, and skipped controls.
- Compute the plan after route selection and before provider rewrite.
- Include selected provider capabilities, org settings, route decision, session pin, harness profile, request surface/transport, token estimates, and recent cache evidence as inputs.
- Return a stable "not planned" reason when a request is outside scope.
- Add unit tests for OpenAI Responses, OpenAI Chat, Anthropic Messages, translated requests, disabled settings, unknown providers, and one-shot requests.

Acceptance criteria:

- Existing request bodies remain byte-identical.
- Every in-scope provider attempt can produce a plan or explicit skip reason.
- Plan computation is deterministic for the same input and pinned session state.
- Plans do not contain raw prompt text or provider secrets.

Likely files:

- `apps/proxy/src/promptCachePlan.ts` (new)
- `apps/proxy/src/server.ts`
- `apps/proxy/src/wsProxy.ts`
- `apps/proxy/src/routeExecutionPlan.ts`
- `apps/proxy/test/*cache*.test.ts`

Validation:

- `pnpm --filter @proxy/proxy test -- cache`
- `pnpm typecheck`

Dependencies: PPC-003.

## PPC-005: Emit Prompt-Cache Plan Events And Metrics

Labels: `area:events`, `area:metrics`, `area:caching`

Goal: Make prompt-cache policy decisions observable before enabling new controls.

Scope:

- Emit `prompt_cache.plan_applied` for completed plan computation.
- Emit or encode skipped-control reasons without raw prompt content.
- Add bounded metrics for controls by provider, model, control, status, and reason.
- Ensure event/metrics failures do not affect provider forwarding.
- Add persistence and metrics tests.

Acceptance criteria:

- Plan events are tenant/workspace scoped.
- Event payloads exclude raw prompt text, request bodies, API keys, provider secrets, and unbounded identifiers.
- Metrics labels are bounded and do not include request/session/cache-key ids.
- Observability failures are logged but do not alter forwarded bytes.

Likely files:

- `apps/proxy/src/events.ts`
- `apps/proxy/src/metrics.ts`
- `apps/proxy/src/providerMetrics.ts`
- `apps/proxy/src/persistence/eventSink.ts`
- `apps/proxy/test/observability.test.ts`
- `apps/proxy/test/metrics.test.ts`

Validation:

- `pnpm --filter @proxy/proxy test -- observability`
- `pnpm --filter @proxy/proxy test -- metrics`
- `pnpm typecheck`

Dependencies: PPC-004.

## PPC-006: Surface Prompt-Cache Plans In The Caching Page

Labels: `area:web`, `area:graphql`, `area:caching`

Goal: Let operators see which cache controls would apply, which were skipped, and why.

Scope:

- Add GraphQL query fields or admin aggregation for prompt-cache plan counts.
- Show counts by provider, model, mode, control, and skipped reason.
- Integrate with the existing Caching page without adding provider-specific UI branches.
- Add empty/loading/error states.
- Add focused data and component tests.

Acceptance criteria:

- Operators can see observe-only plan volume before runtime mutation is enabled.
- Skipped reasons are grouped and bounded.
- The Caching page remains useful when no plan events exist.

Likely files:

- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/proxy/src/graphql/types/analytics.ts`
- `apps/proxy/src/graphql/queries.ts`
- `apps/web/src/cachingData.ts`
- `apps/web/src/cachingPage.tsx`
- `apps/web/src/caching*.test.ts`

Validation:

- `pnpm --filter @proxy/proxy test -- graphql`
- `pnpm --filter @proxy/web test`
- `pnpm typecheck`

Dependencies: PPC-005.

## PPC-007: Move Anthropic Cache Transforms Behind PromptCachePlan

Labels: `area:proxy`, `area:anthropic`, `area:caching`

Goal: Route existing Anthropic automatic caching and TTL upgrade behavior through the canonical plan with no behavior change.

Scope:

- Move `automaticCaching` and `cacheTtlUpgrade` decisions behind `PromptCachePlan`.
- Keep existing org settings behavior unchanged.
- Preserve existing top-level automatic caching and TTL upgrade semantics.
- Preserve nested `cache_control` detection and longer-TTL ordering.
- Keep count-token behavior consistent with current behavior.

Acceptance criteria:

- Existing Anthropic cache tests still pass.
- Forwarded Anthropic bodies are unchanged for equivalent settings and request bodies.
- Plan events explain whether automatic caching or TTL upgrade applied or skipped.

Likely files:

- `apps/proxy/src/adapters.ts`
- `apps/proxy/src/promptCachePlan.ts`
- `apps/proxy/src/server.ts`
- `apps/proxy/src/wsProxy.ts`
- `apps/proxy/test/automaticCaching.test.ts`
- `apps/proxy/test/cacheTtlUpgrade.test.ts`

Validation:

- `pnpm --filter @proxy/proxy test -- automaticCaching`
- `pnpm --filter @proxy/proxy test -- cacheTtlUpgrade`
- `pnpm typecheck`

Dependencies: PPC-004.

## PPC-008: Add Anthropic Plan Golden Tests And Count-Token Parity

Labels: `area:test`, `area:anthropic`, `area:caching`

Goal: Lock down Anthropic plan behavior before adding any new breakpoint strategy.

Scope:

- Add golden tests for client-sent breakpoints, nested tool-result breakpoints, tool-definition breakpoints, translated Anthropic targets, disabled org settings, small requests, one-shot requests, and large multi-turn requests.
- Assert count-token rewrite and forward rewrite apply compatible TTL decisions where required.
- Add tests that existing unsupported translated fields produce skipped-control reasons rather than silent mutation.

Acceptance criteria:

- Golden fixtures clearly show plan input, plan output, and forwarded body.
- Count-token parity is explicit for TTL upgrades.
- Tests fail if a future change drops or duplicates cache markers.

Likely files:

- `apps/proxy/test/automaticCaching.test.ts`
- `apps/proxy/test/cacheTtlUpgrade.test.ts`
- `apps/proxy/test/translationRuntime.test.ts`
- `apps/proxy/test/fixtures/*`

Validation:

- `pnpm --filter @proxy/proxy test -- automaticCaching`
- `pnpm --filter @proxy/proxy test -- cacheTtlUpgrade`
- `pnpm --filter @proxy/proxy test -- translationRuntime`

Dependencies: PPC-007.

## PPC-009: Spike Static-Prefix Anthropic Breakpoints

Labels: `area:proxy`, `area:anthropic`, `area:caching`, `type:spike`

Goal: Determine whether Proxy should add explicit breakpoints around stable tool schema and system-prefix zones instead of only using top-level automatic caching.

Scope:

- Build an observe-only or fixture-only prototype for `static_prefix` breakpoint strategy.
- Evaluate provider limits, TTL ordering, nested marker behavior, translated request behavior, and count-token compatibility.
- Compare expected savings against existing top-level automatic caching.
- Document whether to proceed, defer, or reject.

Acceptance criteria:

- No production request mutation ships unless explicitly approved in a follow-up ticket.
- Spike output includes example request shapes, expected cacheable prefix, risks, and recommended next step.
- If rejected, the reason is documented in the provider prompt-caching plan.

Likely files:

- `docs/future/provider-prompt-caching.md`
- `docs/future/provider-prompt-caching-tickets.md`
- optional test fixtures under `apps/proxy/test/fixtures/*`

Validation:

- `git diff --check`
- Any prototype tests added for the spike.

Dependencies: PPC-007, PPC-008.

## PPC-010: Add OpenAI Cache-Key And Hit-Rate Analytics

Labels: `area:analytics`, `area:openai`, `area:caching`

Goal: Make OpenAI implicit-prefix cache behavior visible without adding undocumented request fields.

Scope:

- Group OpenAI cache-read usage by native `prompt_cache_key` when present and by existing session identity otherwise.
- Add hit-rate and cache-read trend aggregations for OpenAI Responses and Chat.
- Avoid exposing raw cache keys in metrics labels or broad UI tables unless privacy rules allow it.
- Add Caching page panels or drilldowns for OpenAI cache effectiveness.

Acceptance criteria:

- OpenAI hit rate can be compared by provider, model, route, and session/key grouping.
- Raw cache keys are not emitted as high-cardinality metric labels.
- Translated requests that drop `prompt_cache_key` are visible as skipped/unsupported in plan data.

Likely files:

- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/proxy/src/persistence/usageRollups.ts`
- `apps/web/src/cachingData.ts`
- `apps/web/src/cachingPage.tsx`
- `apps/web/src/caching*.test.ts`

Validation:

- `pnpm --filter @proxy/proxy test -- usage`
- `pnpm --filter @proxy/web test`
- `pnpm typecheck`

Dependencies: PPC-005.

## PPC-011: Add OpenAI Cache-Field Skip Reasons Across Translations

Labels: `area:translation`, `area:openai`, `area:caching`

Goal: Make field preservation and dropping explicit when a request crosses dialects.

Scope:

- Add plan skipped-control reasons for OpenAI cache fields that cannot round-trip through selected target dialects.
- Cover OpenAI Responses to Anthropic Messages, OpenAI Responses to Chat, Chat to Responses, and Anthropic to OpenAI translations.
- Ensure skip reasons do not change existing translated request bodies.
- Add tests for `prompt_cache_key`, `prompt_cache_retention`, and Anthropic `cache_control` translation boundaries.

Acceptance criteria:

- Unsupported cache fields are recorded as skipped controls.
- Existing translator tests still assert intentional field drops.
- Native OpenAI requests still preserve supported client fields.

Likely files:

- `apps/proxy/src/translators/openai.ts`
- `apps/proxy/src/translators/anthropicOpenAI.ts`
- `apps/proxy/src/promptCachePlan.ts`
- `apps/proxy/test/openAITranslators.test.ts`
- `apps/proxy/test/translationRuntime.test.ts`

Validation:

- `pnpm --filter @proxy/proxy test -- openAITranslators`
- `pnpm --filter @proxy/proxy test -- translationRuntime`
- `pnpm typecheck`

Dependencies: PPC-004.

## PPC-012: Add Provider-Specific Usage Normalization Fixtures

Labels: `area:proxy`, `area:providers`, `area:caching`, `type:test`

Goal: Make it safe to add more providers by proving cache-read/cache-write normalization before request mutation.

Scope:

- Add fixture tests for provider usage shapes that include cache reads, cache writes, uncached input, output, reasoning, and total tokens.
- Keep the normalized convention: `inputTokens` is total input, with cached and cache-creation tokens as billed-differently subsets.
- Cover missing usage, partial usage, and unknown provider-specific shapes.
- Document what a new provider must supply before enabling cache analytics.

Acceptance criteria:

- Fixture tests fail if cache reads are double-counted or excluded from total input incorrectly.
- Unknown usage shapes degrade to safe zero/default handling.
- No billing or rollup code needs provider-specific branches outside the normalizer contract.

Likely files:

- `apps/proxy/src/persistence/values.ts`
- `apps/proxy/test/usageNormalization.test.ts`
- `apps/proxy/test/usageAnalytics.test.ts`
- `docs/future/provider-prompt-caching.md`

Validation:

- `pnpm --filter @proxy/proxy test -- usageNormalization`
- `pnpm --filter @proxy/proxy test -- usageAnalytics`

Dependencies: PPC-003.

## PPC-013: Add One Third-Provider Observe-Only Cache Adapter

Labels: `area:providers`, `area:caching`, `type:spike`

Goal: Prove the capability and plan architecture can represent a non-OpenAI/non-Anthropic provider without shared routing churn.

Scope:

- Choose one provider family after verifying current docs and model support.
- Add provider capabilities and usage normalization fixtures.
- Add observe-only plan tests for supported and unsupported cache controls.
- Do not add mutating request fields in this ticket.
- Document any provider-specific gaps in the plan.

Acceptance criteria:

- New provider support is represented through capability data and provider-edge mapping, not scattered router branches.
- Cache plan events and Caching page aggregation work for the provider.
- Unsupported controls produce skipped reasons.

Likely files:

- `packages/schema/src/index.ts`
- `apps/proxy/src/persistence/providerRegistryAdmin.ts`
- `apps/proxy/src/persistence/providers.ts`
- `apps/proxy/src/promptCachePlan.ts`
- `apps/proxy/test/providerRegistry*.test.ts`
- `apps/proxy/test/*cache*.test.ts`

Validation:

- `pnpm --filter @proxy/schema test`
- `pnpm --filter @proxy/proxy test -- providerRegistry`
- `pnpm --filter @proxy/proxy test -- cache`
- `pnpm typecheck`

Dependencies: PPC-003, PPC-012.

## PPC-014: Define Prewarm Job Model, Caps, And Accounting

Labels: `area:proxy`, `area:caching`, `area:billing`, `type:design`

Goal: Design prewarm so it cannot create hidden spend or user-visible provider side effects.

Scope:

- Define prewarm job schema, idempotency, TTL-aware scheduling, spend caps, provider/model targeting, and org opt-in settings.
- Define accounting fields for prewarm cost, expired unused prewarms, and resulting hit-rate lift.
- Define cancellation/disable semantics.
- Do not perform provider calls in this ticket.

Acceptance criteria:

- Prewarm jobs are scoped by org/workspace/provider/model and have explicit spend caps.
- Disabling the feature prevents new jobs and leaves existing accounting auditable.
- Prewarm cost is separated from user request cost.

Likely files:

- `docs/future/provider-prompt-caching.md`
- `packages/db/src/schema.ts` if a schema is needed
- `packages/db/migrations/*` if a schema is needed
- `apps/proxy/src/persistence/*`
- `apps/proxy/test/*`

Validation:

- `git diff --check`
- If schema/code changes: `pnpm --filter @proxy/db test`, `pnpm --filter @proxy/proxy test`, `pnpm typecheck`

Dependencies: PPC-005.

## PPC-015: Implement Provider-Supported Prewarm Experiment

Labels: `area:proxy`, `area:providers`, `area:caching`

Goal: Add capped, opt-in prewarm only for providers with a documented prewarm primitive.

Scope:

- Implement provider prewarm calls through the provider-edge adapter.
- Trigger prewarm only from approved candidates such as route config publish, known long-running session resume, or workspace bootstrap with stable tool schemas.
- Enforce idempotency keys, spend caps, provider timeouts, and org opt-in.
- Emit prewarm started/completed/expired-unused events and metrics.
- Add operator-visible reporting for cost and hit-rate lift.

Acceptance criteria:

- Prewarm cannot recursively trigger user-visible provider work.
- Spend cap tests prevent runaway provider calls.
- Operators can see prewarm cost and unused expiry.
- Disabling the setting stops future prewarm jobs.

Likely files:

- `apps/proxy/src/provider*`
- `apps/proxy/src/promptCachePlan.ts`
- `apps/proxy/src/persistence/*`
- `apps/proxy/src/graphql/*`
- `apps/web/src/caching*`
- `apps/proxy/test/*`

Validation:

- `pnpm --filter @proxy/proxy test`
- `pnpm --filter @proxy/web test`
- `pnpm typecheck`

Dependencies: PPC-014.

## PPC-016: Expand Cache-Bust Attribution Causes

Labels: `area:analytics`, `area:caching`, `area:events`

Goal: Move cache-bust reporting beyond TTL/model/provider causes when event evidence can prove operator-controlled churn.

Scope:

- Add attribution for org prompt edit, tool schema churn, translator change, compression policy change, and route config change when supported by event data.
- Keep unknown classification for cases that cannot be proven.
- Add tests for each new cause.
- Surface new causes in the Caching page.

Acceptance criteria:

- New causes are only reported when evidence is present.
- Existing TTL/model/provider classification still works.
- Operators can distinguish controllable prompt-layout churn from provider TTL expiry.

Likely files:

- `apps/proxy/src/persistence/cacheBusts.ts`
- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/proxy/test/cacheBusts.test.ts`
- `apps/web/src/cachingMissPanels.tsx`
- `apps/web/src/cachingData.test.ts`

Validation:

- `pnpm --filter @proxy/proxy test -- cacheBusts`
- `pnpm --filter @proxy/web test -- cachingData`
- `pnpm typecheck`

Dependencies: PPC-005, PPC-010.

## PPC-017: Add Rollout Runbook And Operator Guidance

Labels: `area:docs`, `area:runbook`, `area:caching`

Goal: Give operators a safe sequence for enabling prompt-cache controls.

Scope:

- Document observe-only rollout, dashboard checks, cache-hit baselines, spend monitoring, and rollback.
- Include provider-specific caveats for Anthropic explicit controls and OpenAI implicit-prefix analytics.
- Include prewarm risk controls once prewarm exists.
- Link from docs index and relevant user-guide pages.

Acceptance criteria:

- Operators can enable observe-only measurement before mutating traffic.
- Operators have clear rollback steps for each mutating control.
- The runbook states which validation signals should block rollout.

Likely files:

- `docs/runbooks/prompt-caching.md` (new)
- `docs/index.md`
- `docs/user-guide/analytics.md`
- `docs/future/provider-prompt-caching.md`

Validation:

- `git diff --check`

Dependencies: PPC-006, PPC-016.
