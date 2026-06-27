# Open Model And Bedrock Provider Support V1 Tickets

These tickets break the open model and Bedrock provider support scope (`PLAN.md`) into PR-sized units.

The intended delivery shape is incremental: first make OpenAI-compatible OSS providers operable through the existing HTTP/provider-registry direction, then add a provider-adapter boundary, then implement native Bedrock as the first non-generic adapter.

## Delivery Rules

- Same-dialect passthrough remains byte-stable for existing OpenAI and Anthropic builtin providers.
- Do not model Bedrock as a fake bearer-token HTTP provider. Native Bedrock uses an `aws-sdk` auth style and an `aws-bedrock-converse` adapter.
- Org-defined providers never inherit operator environment credentials.
- Bedrock credential events record credential source category only, never secret material.
- Bedrock is an internal provider dialect in V1, not a public caller surface.
- Route compatibility and runtime target skips must produce durable evidence.
- Unsupported stateful/provider-specific request shapes fail closed or skip the target; they are not silently dropped.
- Model discovery can be best-effort for generic OpenAI-compatible providers, but is first-class for Bedrock.
- Every ticket that changes `packages/schema` or `packages/db` should run `pnpm build:runtime` before proxy tests.
- Live Bedrock tests must be gated by environment variables and must not run by default in local or CI test suites.

## Phase 0: Contract And Test Foundation

### OMB-001: Lock Bedrock And OSS Provider Scope Decisions

Goal: Convert the open questions in `PLAN.md` into explicit implementation decisions before runtime work starts.

Scope:

- Record the locked V1 decisions in the scope plan.
- Ensure deferred capabilities are listed as non-goals.
- Update downstream ticket wording to match the decisions.

Acceptance criteria:

- Each former open question has a decision, owner, and reason.
- Any deferred capability has a clear non-goal statement.
- Ticket dependencies below are updated if the decisions change scope.

Validation:

- Documentation-only review.
- Run `rtk git diff --check`.

Likely files:

- `docs/scopes/open-model-bedrock-provider-support-v1/PLAN.md`
- `docs/scopes/open-model-bedrock-provider-support-v1/TICKETS.md`

### OMB-002: Add Provider Adapter And Endpoint Contracts

Goal: Add shared schema/types for provider adapter kinds and discriminated endpoint records without wiring traffic to Bedrock yet.

Scope:

- Add `ProviderAdapterKind` with `generic-http-json` and `aws-bedrock-converse`.
- Extend provider registry validation to include adapter kind and adapter config.
- Replace endpoint assumptions of `{ dialect, path }` everywhere with a discriminated endpoint contract:
  - generic HTTP endpoints use `{ dialect, path }`
  - Bedrock endpoints use `{ dialect, operation }`
- Add `aws-sdk` to provider auth style schemas but do not make current generic HTTP forwarding use it.
- Add unit tests for valid and invalid provider rows.

Acceptance criteria:

- Existing provider rows continue to validate as `generic-http-json`.
- A Bedrock builtin-style provider row validates with `operation: "Converse"` and `operation: "ConverseStream"`.
- Empty path sentinels are rejected.
- Invalid auth style / adapter kind combinations fail with useful validation paths.

Validation:

- Run `pnpm --filter @proxy/schema test`.
- Run `pnpm typecheck`.

Likely files:

- `packages/schema/src/index.ts`
- `apps/proxy/src/persistence/providers.ts`
- `apps/proxy/src/types.ts`
- schema/proxy tests near existing provider validation

### OMB-003: Add Bedrock Translation Fixtures

Goal: Establish fixture coverage before implementing Bedrock translation and streaming logic.

Scope:

- Add JSON fixtures for caller requests:
  - OpenAI Chat text-only request
  - OpenAI Chat tool request and tool-result history
  - Anthropic Messages text-only request
  - Anthropic Messages tool-use/tool-result history
  - OpenAI Responses request without `previous_response_id`
  - unsupported stateful OpenAI Responses request with `previous_response_id`
- Add Bedrock Converse expected payload fixtures for the supported cases.
- Add Bedrock Converse response fixtures:
  - text completion
  - tool use
  - usage and stop reason
  - guardrail intervention metadata
- Add ConverseStream event fixtures:
  - text stream
  - tool-call stream
  - metadata usage at stream end
  - AWS exception event mid-stream

Acceptance criteria:

- Fixtures are committed before translator implementation.
- Fixture names encode caller surface, provider dialect, and behavior.
- Tests can load fixtures without network or AWS credentials.

Validation:

- Add a small fixture-loading test.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/test/fixtures/bedrock/`
- `apps/proxy/test/bedrockFixtures.test.ts`

## Phase 1: Generic OpenAI-Compatible Provider Support

### OMB-004: Harden Generic HTTP Provider Validation

Goal: Make custom OpenAI-compatible provider rows production-safe before routing OSS traffic through them.

Scope:

- Enforce auth-bearing header rejection for `default_headers`.
- Enforce base URL validation for custom providers.
- Keep link-local/metadata ranges blocked unconditionally.
- Keep private-range base URLs behind operator allowlist.
- Validate endpoint dialect/path pairs for `openai-chat`, `openai-responses`, and `anthropic-messages`.
- Ensure org-defined providers with non-`none` auth require an attached credential before they are eligible route targets.

Acceptance criteria:

- Custom provider cannot receive operator OpenAI, Anthropic, or AWS credentials.
- Invalid base URLs and forbidden headers are rejected at write/publish time.
- A local OpenAI-compatible provider with `authStyle: "none"` can validate when network policy allows it.
- Existing builtin providers are unchanged.

Validation:

- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.
- Add provider registry validation tests.

Likely files:

- `apps/proxy/src/persistence/providers.ts`
- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/upstream.ts`
- provider/admin tests

### OMB-005: Add Manual Model Catalog Entries For Custom Providers

Goal: Let operators add or import model catalog rows for private OpenAI-compatible providers.

Scope:

- Add admin persistence methods for manual model catalog rows scoped by organization/provider.
- Support model ID, display name, dialects, context window, max output tokens, streaming/tool/image/reasoning capability flags, and pricing metadata.
- Mark rows with `catalogSource: "manual"` or equivalent.
- Preserve models.dev refresh behavior for known builtin providers.
- Add validation that route targets can reference manual model rows.

Acceptance criteria:

- An org custom provider can have manually configured model rows.
- Manual rows are not overwritten by models.dev refresh.
- Route validation can distinguish known, unknown, and manually approved unlisted models.
- Unknown pricing/capability state is visible to admin callers.

Validation:

- Run `pnpm --filter @proxy/db test` if schema changes.
- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `apps/proxy/src/persistence/modelCatalog*.ts`
- `apps/proxy/src/modelDiscovery.ts`
- admin GraphQL/API serializers

### OMB-006: Route To OpenAI-Compatible Custom Providers

Goal: Prove a route tier can select and forward to a custom OpenAI-compatible provider.

Scope:

- Extend routing config target validation to arbitrary provider slugs where current schema still assumes OpenAI/Anthropic-shaped blocks.
- Ensure target compatibility uses provider endpoint dialects and translator availability.
- Record native-vs-translated status and skip reasons in route decision evidence.
- Add a test custom provider using `openai-chat`.
- Preserve current builtin OpenAI and Anthropic behavior.

Acceptance criteria:

- A route target can select a custom provider slug and model.
- Missing credential, missing endpoint, missing translator, and unsupported model capability produce explicit skip reasons.
- Same-dialect OpenAI Chat traffic forwards to the custom provider without translation.
- Existing OpenAI/Anthropic route tests still pass.

Validation:

- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `packages/schema/src/index.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/src/adapters.ts`
- `apps/proxy/src/persistence/routeDecision.ts`
- routing tests

### OMB-007: Add Local OpenAI-Compatible Smoke Harness

Goal: Make OSS provider support reproducible without external provider accounts.

Scope:

- Add a lightweight local OpenAI-compatible test server or fixture-backed HTTP handler for smoke tests.
- Cover `/v1/chat/completions`.
- Cover streaming if the existing smoke harness can support it without large complexity.
- Add docs for running a local provider smoke, including vLLM/Ollama-style base URLs where applicable.

Acceptance criteria:

- Local smoke can prove Proxy -> custom OpenAI-compatible provider routing.
- The smoke does not require internet, AWS, OpenAI, or Anthropic credentials.
- Failures show whether the issue is provider setup, routing config, or upstream response format.

Validation:

- Run new smoke command or targeted test.
- Run `pnpm smoke` if local services are available.

Likely files:

- `apps/proxy/test/`
- `scripts/` or existing smoke harness files
- `docs/user-guide/provider-auth.md`
- `docs/runbooks/routing-configs.md`

## Phase 2: Provider Adapter Boundary

### OMB-008: Extract Generic HTTP Provider Adapter

Goal: Move current HTTP forwarding behavior behind a `generic-http-json` adapter with no behavior change.

Scope:

- Introduce a provider adapter interface for prepare/send/stream/error classification.
- Move generic URL construction, header construction, network policy, fetch, response translation, and stream transform into the generic adapter.
- Keep `ProviderProxy` as the orchestrator for auth, route selection, events, usage, and health.
- Preserve `fetchWithPinnedAddress` for generic HTTP providers.
- Add tests proving OpenAI and Anthropic builtin upstream requests are unchanged.

Acceptance criteria:

- Existing builtin traffic still uses the same upstream URLs, headers, and request bodies.
- Existing translation behavior is unchanged.
- Adapter kind is selected from the provider registry.
- No Bedrock-specific code is wired into generic HTTP paths.

Validation:

- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/providerAdapters/` (new)
- `apps/proxy/src/upstream.ts`
- `apps/proxy/src/adapters.ts`
- proxy runtime tests

### OMB-009: Add Adapter-Level Error Classification And Health Hooks

Goal: Prepare the runtime for provider-specific errors and health without special casing Bedrock in the orchestrator.

Scope:

- Add provider adapter error classification return shape.
- Map generic HTTP errors into existing provider failure categories.
- Add adapter hook outputs for retryable/fatal, auth denied, rate limited, quota exceeded, context too large, unsupported request shape, and upstream timeout.
- Ensure route decision/provider attempt events include adapter kind and classification.
- Keep current provider health behavior unchanged for builtins except for additional metadata.

Acceptance criteria:

- Generic HTTP adapter failures are classified at least as well as today's behavior.
- Provider attempt records include adapter kind.
- Health/cooldown code can consume adapter classification without provider-specific branching.
- Tests cover 401/403, 429, 5xx, timeout, and malformed upstream response.

Validation:

- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/providerAdapters/`
- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/persistence/providerAttempt.ts`
- `apps/proxy/src/persistence/providers.ts`
- provider health tests

## Phase 3: Native Bedrock Runtime MVP

### OMB-010: Add Bedrock AWS SDK Dependencies And Credential Resolver

Goal: Implement Bedrock credential resolution independently from request forwarding.

Scope:

- Add required AWS SDK packages:
  - `@aws-sdk/client-bedrock-runtime`
  - `@aws-sdk/client-bedrock`
  - `@aws-sdk/credential-providers`
- Implement credential resolver for:
  - encrypted Bedrock bearer token
  - encrypted static access key/secret/session token
  - deployment-bound default chain
  - local development profile when enabled
  - web identity/container/runtime identity via SDK default chain
- Redact all secret values from logs/errors/events.
- Return credential source category for events.

Acceptance criteria:

- Credential precedence is tested.
- Tenant-supplied credential file paths are rejected or unrepresentable.
- Org-defined providers cannot use operator default chain.
- Assume-role is not accepted in V1 account config.
- Local development can use `AWS_BEARER_TOKEN_BEDROCK` or default chain when configured.

Validation:

- Run `pnpm install --lockfile-only` if dependencies change.
- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.
- Run secret-redaction tests.

Likely files:

- `apps/proxy/package.json`
- `pnpm-lock.yaml`
- `apps/proxy/src/providerAdapters/bedrockCredentials.ts` (new)
- `apps/proxy/src/config.ts`
- provider credential tests

### OMB-011: Add Bedrock Provider Account And Builtin Row Support

Goal: Represent `amazon-bedrock` as a builtin provider/account target without sending traffic yet.

Scope:

- Seed or register builtin `amazon-bedrock` provider with `aws-bedrock-converse` adapter kind.
- Add provider account fields/metadata for region, credential mode, optional endpoint override, and optional discovery regions.
- Ensure serializers expose non-secret Bedrock account metadata only.
- Add admin validation for credential mode/region combinations.
- Ensure `authStyle: "aws-sdk"` cannot be used by `generic-http-json` providers.

Acceptance criteria:

- Bedrock provider/account rows can be created and read without secret leakage.
- Invalid account configurations fail validation.
- Existing OpenAI/Anthropic provider account behavior is unchanged.
- Bedrock rows are not route-eligible until runtime adapter tickets land.

Validation:

- Run `pnpm --filter @proxy/db test` if schema changes.
- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `packages/db/src/seed.ts`
- `apps/proxy/src/persistence/providerCredentials.ts`
- `apps/proxy/src/persistence/providerCredentialAdmin.ts`
- admin serializers/tests

### OMB-012: Add Internal Bedrock Dialect Compatibility Gates

Goal: Make route compatibility understand `bedrock-converse` before runtime translation exists.

Scope:

- Add internal `bedrock-converse` dialect.
- Add compatibility outcomes for:
  - native Bedrock target from caller surface through translator
  - missing Bedrock translator
  - stateful OpenAI Responses unavailable
  - signed/encrypted reasoning unavailable
  - tool/image/streaming capability unavailable
  - Bedrock-only settings on non-Bedrock targets
- Ensure UI/backend preview can explain Bedrock target availability.

Acceptance criteria:

- Bedrock target compatibility can be evaluated without making AWS calls.
- Unsupported stateful/provider-specific shapes produce explicit reason codes.
- Existing compatibility outcomes for OpenAI/Anthropic remain unchanged.

Validation:

- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `packages/schema/src/index.ts`
- `apps/proxy/src/routingCompatibility.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/src/adapters.ts`
- compatibility tests

### OMB-013: Translate Caller Requests To Bedrock Converse

Goal: Convert supported caller request shapes into Bedrock Converse payloads.

Scope:

- Translate OpenAI Chat to Bedrock Converse.
- Translate Anthropic Messages to Bedrock Converse.
- Translate OpenAI Responses without stateful fields to Bedrock Converse where feasible.
- Map system prompts, user/assistant turns, text blocks, tool calls, tool results, tools, tool choice, stop sequences, max tokens, temperature, and top_p.
- Map base64 image input where supported.
- Gate remote image URLs and provider-native file references.
- Handle role alternation without silently changing signed/provider-stateful content.
- Add explicit unavailable results for unsupported fields.

Acceptance criteria:

- Fixture tests pass for text-only and tool-call request conversion.
- Tool call IDs and tool result IDs survive conversion.
- Unsupported stateful requests are rejected/skipped with a reason.
- Model capability gates are consulted before adding tools/images.

Validation:

- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/src/translators/bedrockConverse.ts` (new)
- `apps/proxy/src/translators/index.ts`
- `apps/proxy/src/adapters.ts`
- Bedrock translator tests

### OMB-014: Normalize Bedrock Converse Responses

Goal: Return the original caller response shape for non-streaming Bedrock responses.

Scope:

- Map Bedrock Converse text responses to OpenAI Chat, OpenAI Responses, and Anthropic Messages shapes.
- Map Bedrock tool use blocks back to caller tool-call representation.
- Map stop reasons to caller finish/stop reasons.
- Map usage into `NormalizedUsage`.
- Preserve original Bedrock stop reason and metadata in provider metadata, not caller-visible prompt fields.
- Normalize Bedrock provider errors into caller-appropriate error responses.

Acceptance criteria:

- Non-streaming caller responses retain the caller's original API shape.
- Tool-call response fixtures map correctly.
- Usage is captured for ledger projection.
- Guardrail/content-filter outcomes are visible through metadata and finish/error categories.

Validation:

- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/translators/bedrockConverse.ts`
- `apps/proxy/src/persistence/values.ts`
- `apps/proxy/src/providerAdapters/bedrock*.ts`
- Bedrock response tests

### OMB-015: Implement Bedrock ConverseStream Translation

Goal: Stream Bedrock `ConverseStream` events back in the caller's original SSE dialect.

Scope:

- Consume Bedrock stream events:
  - `messageStart`
  - `contentBlockStart`
  - `contentBlockDelta`
  - `contentBlockStop`
  - `messageStop`
  - `metadata`
  - exception events
- Emit OpenAI Chat SSE for OpenAI Chat callers.
- Emit OpenAI Responses SSE for OpenAI Responses callers where supported.
- Emit Anthropic Messages SSE for Anthropic callers.
- Preserve tool-call argument deltas and block ordering.
- Capture terminal usage from metadata.
- Handle caller disconnect cleanup.

Acceptance criteria:

- Text stream fixture converts to each caller SSE dialect.
- Tool stream fixture preserves tool-call IDs and argument deltas.
- Final usage is captured when Bedrock sends it in metadata.
- Mid-stream AWS exception is classified and terminates the caller stream cleanly.

Validation:

- Run `pnpm --filter @proxy/proxy test`.
- Add golden SSE fixtures.

Likely files:

- `apps/proxy/src/translators/bedrockConverse.ts`
- `apps/proxy/src/sseObserver.ts`
- `apps/proxy/src/providerAdapters/bedrockRuntime.ts` (new)
- stream fixture tests

### OMB-016: Implement Bedrock Runtime Adapter

Goal: Wire non-streaming and streaming Bedrock requests into the provider adapter layer.

Scope:

- Create `aws-bedrock-converse` adapter.
- Build Bedrock runtime clients by account/region/credential source.
- Send `Converse` for non-streaming requests.
- Send `ConverseStream` for streaming requests.
- Support custom runtime endpoint only through validated account/provider config.
- Add request metadata, guardrail config, service tier, and additional model request fields from allowlisted config.
- Enforce model capability gates before sending.

Acceptance criteria:

- OpenAI Chat request can route to mocked Bedrock Converse.
- Anthropic Messages request can route to mocked Bedrock Converse.
- Streaming request can route to mocked Bedrock ConverseStream.
- Unsupported fields prevent the attempt before AWS spend.
- Runtime adapter does not affect generic HTTP provider behavior.

Validation:

- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/src/providerAdapters/bedrockRuntime.ts`
- `apps/proxy/src/providerAdapters/index.ts`
- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/router.ts`
- adapter integration tests

### OMB-017: Classify Bedrock Errors And Health Outcomes

Goal: Make Bedrock failures actionable in routing, health, and admin surfaces.

Scope:

- Map AWS SDK and Bedrock errors into provider categories:
  - auth missing
  - auth denied
  - model access denied
  - region unavailable
  - model unavailable
  - rate limited
  - quota exceeded
  - context too large
  - unsupported request shape
  - guardrail intervention
  - upstream timeout
  - transport failure
  - stream permission denied
- Detect `InvokeModelWithResponseStream` permission failures distinctly.
- Update provider attempt and route decision evidence with Bedrock region/model/profile.
- Update provider health/cooldown inputs from Bedrock classifications.

Acceptance criteria:

- Each core AWS error fixture maps to the expected category.
- Missing streaming permission is not collapsed into generic auth failure.
- Route skip/fallback evidence includes enough detail to debug the Bedrock target.
- No secret values are written to events/logs.

Validation:

- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.
- Add secret-redaction assertions.

Likely files:

- `apps/proxy/src/providerAdapters/bedrockErrors.ts` (new)
- `apps/proxy/src/persistence/providerAttempt.ts`
- `apps/proxy/src/persistence/providers.ts`
- `apps/proxy/src/router.ts`
- error classification tests

## Phase 4: Bedrock Discovery, Admin, And Catalog

### OMB-018: Implement Bedrock Model Discovery

Goal: Import region/account-specific Bedrock foundation models and inference profiles into the model catalog.

Scope:

- Add Bedrock control-plane client resolution.
- Call `ListFoundationModels`.
- Call `ListInferenceProfiles`.
- Optionally call `GetInferenceProfile` where profile details are needed.
- Filter for active text/chat-compatible models.
- Store discovery source, region, model ID, display name, modalities, streaming support, and raw provider metadata.
- Emit discovery success/failure events.
- Add manual refresh entrypoint for admin.

Acceptance criteria:

- Mocked discovery imports foundation models and inference profiles.
- Discovery failures do not erase the previous catalog.
- Discovery rows are scoped by provider account/organization as decided in OMB-001.
- Discovery event summarizes created/updated/skipped/error counts.

Validation:

- Run `pnpm --filter @proxy/db test` if schema changes.
- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/jobs/bedrockModelDiscovery.ts` (new)
- `apps/proxy/src/providerAdapters/bedrockDiscovery.ts` (new)
- `apps/proxy/src/modelDiscovery.ts`
- `packages/db/src/schema.ts`
- discovery tests

### OMB-019: Add Bedrock Catalog Metadata Overlay

Goal: Fill Bedrock capability gaps that AWS discovery APIs do not provide.

Scope:

- Add curated metadata for known Bedrock model families:
  - context window
  - max output tokens
  - tool support
  - image support
  - reasoning support
  - prompt caching support
  - pricing
- Merge discovered control-plane data, curated metadata, operator overrides, and org overrides in a deterministic order.
- Mark unknown critical capability as unsupported unless manually approved.
- Expose unknown pricing/capability warnings to admin/API.

Acceptance criteria:

- Known Bedrock Claude model rows have context, output, tool, streaming, and pricing metadata.
- Unknown model rows are visible but conservative.
- Operator override can correct a catalog value without editing static metadata.
- Model route validation consumes merged capability metadata.

Validation:

- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.
- Add merge-order tests.

Likely files:

- `packages/db/data/bedrock-model-metadata.json` (new)
- `apps/proxy/src/jobs/bedrockModelDiscovery.ts`
- `apps/proxy/src/modelDiscovery.ts`
- `apps/proxy/src/router.ts`
- catalog tests

### OMB-020: Support Bedrock Inference Profiles

Goal: Treat inference profiles as first-class route targets rather than string hacks.

Scope:

- Preserve model IDs that already start with `global.`, `us.`, `eu.`, `jp.`, `apac.`, or `au.`.
- Prevent double-prefixing.
- Allow explicit profile ARNs where account policy permits them.
- Store system cross-region inference profiles distinctly from foundation models.
- Expose profile region/geography and source in model catalog/admin.
- Ensure pricing/cost attribution uses the selected profile/model metadata.

Acceptance criteria:

- Prefix handling tests cover already-prefixed and unprefixed IDs.
- System cross-region profiles and foundation models do not collide in catalog keys.
- Route target can explicitly select a profile.
- Provider attempt metadata records selected profile/model ID.

Validation:

- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/providerAdapters/bedrockModelIds.ts` (new)
- `apps/proxy/src/jobs/bedrockModelDiscovery.ts`
- `apps/proxy/src/modelDiscovery.ts`
- `apps/proxy/src/router.ts`
- model ID tests

### OMB-021: Add Bedrock Admin Provider Setup

Goal: Let operators configure Bedrock accounts safely from the operations console/API.

Scope:

- Add admin fields for credential mode, region, optional bearer token, optional custom runtime endpoint, and discovery regions.
- Add model access test action.
- Add streaming permission test action.
- Add discovery refresh action.
- Show credential source category and health without exposing secrets.
- Prevent Bedrock-only settings on non-Bedrock providers.

Acceptance criteria:

- Admin can create/read/update Bedrock provider account metadata.
- Secret fields are write-only.
- Test actions produce clear success/failure categories.
- UI does not render Bedrock controls for generic HTTP providers.

Validation:

- Run `pnpm --filter @proxy/web test` if present.
- Run `pnpm build`.
- Run focused admin/API tests.

Likely files:

- `apps/proxy/src/persistence/providerCredentialAdmin.ts`
- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/proxy/src/graphql/`
- `apps/web/src/`
- `docs/frontend-guidelines.md` only if new UI rule is introduced

### OMB-022: Add Route Editor Compatibility For Bedrock And OSS Providers

Goal: Make route config editing explain native, translated, unsupported, unhealthy, and uncredentialed provider targets.

Scope:

- Consume backend/shared compatibility output in the web UI.
- Show provider, model, dialect, region, context window, tool support, streaming support, pricing status, credential status, and health status.
- Show Bedrock controls only for Bedrock targets:
  - region
  - inference profile
  - service tier
  - guardrail identifier/version
  - request metadata template
- Show generic HTTP controls only for custom HTTP providers where applicable.
- Keep route files thin and use existing TanStack patterns.

Acceptance criteria:

- UI cannot publish a route target that backend compatibility rejects.
- Unsupported route targets show the same reason code as backend validation.
- Bedrock-only controls do not appear on non-Bedrock targets.
- Existing routing editor workflows remain intact.

Validation:

- Run `pnpm --filter @proxy/web test` if present.
- Run `pnpm lint`.
- Run `pnpm typecheck`.

Likely files:

- `apps/web/src/routingConfigEditor.ts`
- `apps/web/src/routing/`
- `apps/web/src/providers/`
- `apps/proxy/src/graphql/`
- shared compatibility types

### OMB-023: Add Provider Health Views For Bedrock

Goal: Surface Bedrock region/model/profile failures clearly in admin and routing evidence.

Scope:

- Store or project provider health by provider account, region, model, inference profile, and streaming permission.
- Show last error category, last error time, consecutive failures, retry-after/cooldown, and last successful probe.
- Add filters for Bedrock-specific categories:
  - model access denied
  - stream permission denied
  - region unavailable
  - quota exceeded
  - throttling
- Link health state to route skip evidence where possible.

Acceptance criteria:

- Admin can distinguish provider-account auth failure from model access failure.
- Streaming permission failures are visible separately.
- Health state can cause a route target skip with durable evidence.
- Existing provider health views remain usable for generic HTTP providers.

Validation:

- Run `pnpm build:runtime && pnpm --filter @proxy/proxy test`.
- Run `pnpm build`.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `apps/proxy/src/persistence/providers.ts`
- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/web/src/`

## Phase 5: Hardening, Docs, And Live Validation

### OMB-024: Add Live Bedrock Integration Tests

Goal: Prove native Bedrock works against a real AWS account without making live tests mandatory.

Scope:

- Add live integration tests gated by:
  - `AWS_REGION`
  - `AWS_BEDROCK_TEST_MODEL`
  - credentials in default chain or explicit test env
- Cover non-streaming Converse.
- Cover streaming ConverseStream.
- Cover tool use if the selected model supports it.
- Skip with a clear message when env is absent.
- Ensure tests do not log prompts or secrets.

Acceptance criteria:

- Live tests are skipped by default.
- When env is present, tests verify real Bedrock response, usage, and stream termination.
- Failures identify auth, model access, region, or stream permission issues.

Validation:

- Run default test suite and confirm live tests skip.
- Run live test manually in a configured AWS account.

Likely files:

- `apps/proxy/test/bedrockLive.test.ts`
- `apps/proxy/src/providerAdapters/bedrockRuntime.ts`
- test docs

### OMB-025: Add Harness Smoke Tests For Bedrock And OSS Providers

Goal: Verify real caller surfaces can use the new provider paths.

Scope:

- Add smoke coverage for:
  - OpenAI Chat caller -> OpenAI-compatible custom provider
  - OpenAI Chat caller -> Bedrock
  - Anthropic Messages caller -> Bedrock
  - OpenAI Responses caller -> Bedrock only for supported stateless requests
- Include opencode, Claude Code, Codex, or SDK harness instructions where automation is impractical.
- Record unsupported cases explicitly, especially `previous_response_id`.

Acceptance criteria:

- Each supported caller/provider path has either automated smoke coverage or a documented manual smoke.
- Unsupported paths produce clear errors/skips.
- Smoke docs include required env/config and expected results.

Validation:

- Run automated smoke where local services and credentials are available.
- Run `pnpm smoke` if applicable.

Likely files:

- `apps/proxy/test/`
- `docs/harnesses/`
- `docs/runbooks/`
- smoke scripts

### OMB-026: Document Bedrock Setup, IAM, And Operations

Goal: Make Bedrock setup and failure handling usable by operators.

Scope:

- Add provider auth guide for Bedrock credential modes.
- Add least-privilege IAM examples for runtime and discovery.
- Add local development setup using default chain and `AWS_BEARER_TOKEN_BEDROCK`.
- Add runbook entries for:
  - model access denied
  - stream permission denied
  - throttling/rate limits
  - region unavailable
  - unknown model metadata
  - guardrail intervention
- Add bridge-mode notes for LiteLLM/Kong if OMB-001 decides bridge mode is documented.

Acceptance criteria:

- A developer can configure Bedrock locally from docs.
- An operator can identify required IAM permissions.
- Common Bedrock failures map to admin health categories and runbook steps.
- Docs are linked from `docs/index.md`.

Validation:

- Run `rtk rg "Bedrock|amazon-bedrock|AWS_BEARER_TOKEN_BEDROCK" docs`.
- Run `rtk git diff --check`.

Likely files:

- `docs/user-guide/provider-auth.md`
- `docs/runbooks/provider-account-health.md`
- `docs/runbooks/routing-configs.md`
- `docs/index.md`

### OMB-027: Production Readiness Review

Goal: Gate production rollout on auditability, security, and operational evidence.

Scope:

- Review provider credential boundaries.
- Review event payloads for prompt/secret leakage.
- Review route decision evidence for native/translated/skipped Bedrock targets.
- Review cost and usage ledger projections for Bedrock traffic.
- Review admin health views and runbooks.
- Review fallback behavior across stateful request boundaries.
- Run the narrowest meaningful test matrix for changed packages.

Acceptance criteria:

- No prompt text appears in events outside `prompt_artifacts.raw_text`.
- No AWS secrets appear in logs/events/admin reads.
- Bedrock usage is attributed by organization, workspace, provider account, model/profile, route tier, and routing config.
- Stateful OpenAI Responses and signed/encrypted reasoning cases fail closed.
- Production rollout checklist is complete.

Validation:

- Run `pnpm lint`.
- Run `pnpm typecheck`.
- Run `pnpm test`.
- Run live Bedrock integration tests in a configured environment.
- Run smoke tests for at least one OSS provider and one Bedrock model.

Likely files:

- implementation files from previous tickets
- `docs/runbooks/production-rollout-gates.md`
- `docs/scopes/open-model-bedrock-provider-support-v1/PLAN.md`
