# Harness Model Translation V1 Tickets

These tickets break the harness model translation scope (`PLAN.md`) into PR-sized units.

The intended delivery shape is cross-family translation across the HTTP surfaces used by Codex, Claude Code, opencode, Cursor BYOK, and OpenAI-compatible SDKs: Anthropic Messages <-> OpenAI Chat and OpenAI Responses -> Anthropic Messages for Codex HTTP turns. Existing same-family OpenAI Responses <-> Chat translation remains supported.

## Delivery Rules

- Keep same-dialect passthrough byte-stable; translators only run when the selected provider endpoint dialect differs from the caller surface.
- Enable OpenAI Responses -> Anthropic Messages for Codex HTTP turns without `previous_response_id`.
- Keep Codex WebSocket and `previous_response_id` traffic native-only.
- Preserve tool-use IDs and tool-result IDs across both request and response translation.
- Runtime route eligibility is the source of truth. The UI must consume a backend/shared compatibility contract, not recreate the dialect matrix.
- Unknown or unmappable provider-specific fields must be explicitly mapped, rejected as translation-unavailable, or audited as a known safe drop.
- Cache policy follows the upstream dialect after translation; do not copy cache annotations blindly between provider families.
- Route decisions must record translated-route guardrail actions and unavailable reasons.

## Phase 0: Contract And Test Foundation

### HMT-001: Add Canonical Translation Model

Goal: Add the internal canonical request/response/chunk shape used only by translator implementations and tests.

Scope:

- Add canonical types/helpers under `apps/proxy/src/translators/`.
- Represent messages, content parts, tools, tool choices, finish reasons, usage, and streaming chunk events.
- Keep the canonical shape private to the translator layer; do not expose it through GraphQL or schema package APIs.
- Add focused unit tests for canonical helper behavior that is not dialect-specific.

Acceptance criteria:

- Canonical helpers can represent the shared subset needed by Anthropic Messages and OpenAI Chat.
- Tool-call IDs and tool-result IDs are first-class, not incidental metadata.
- Unsupported fields have an explicit place to become unavailable/audited decisions later.
- Existing OpenAI Responses <-> Chat translator behavior is unchanged.

Validation:

- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/src/translators/canonical.ts` (new)
- `apps/proxy/test/translation*.test.ts`

### HMT-002: Add Translation Compatibility Contract

Goal: Create the single source of truth the router and UI use to answer native/translated/unavailable coverage.

Scope:

- Extract route-target compatibility from router-only private logic or expose an equivalent backend route-preview service.
- Inputs include harness, surface, transport, request state, provider endpoints, and translator availability.
- Outputs include status, provider dialect, translation from/to, and reason codes.
- Cover native, translated, missing endpoint, missing translator, stateful translation unavailable, previous-response translation unavailable, WebSocket native-only, and credential-unresolved cases.

Acceptance criteria:

- Backend tests prove the compatibility contract matches `targetAvailability`/router outcomes for representative targets.
- Reason codes reuse existing router vocabulary: `dialect_unavailable`, `translator_unavailable`, `stateful_translation_unavailable`, `previous_response_translation_unavailable`, and `provider_credential_unresolved`.
- The contract can evaluate a routing config draft without making classifier or provider calls.
- No UI code computes coverage by checking only whether a provider has Responses, Chat, or Messages endpoints.

Validation:

- Add backend unit tests for compatibility outcomes.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/src/router.ts`
- `apps/proxy/src/routingCompatibility.ts` (new)
- `apps/proxy/test/translationRuntime.test.ts`

## Phase 1: Cross-Family Translators

### HMT-003: Translate Anthropic Messages Requests To OpenAI

Goal: Let Claude Code HTTP Messages requests target OpenAI Chat and Responses endpoints.

Scope:

- Map Anthropic `system` text blocks to OpenAI system messages.
- Map Anthropic user/assistant/tool messages to OpenAI Chat messages.
- Map Anthropic user/assistant/tool messages to OpenAI Responses input items.
- Map Anthropic `tool_use` blocks to OpenAI `tool_calls`.
- Map Anthropic `tool_use` blocks to OpenAI Responses `function_call` items.
- Map Anthropic `tool_result` blocks to OpenAI tool messages.
- Map Anthropic `tool_result` blocks to OpenAI Responses `function_call_output` items.
- Map Anthropic tools and `tool_choice` to OpenAI Chat tools/tool choice.
- Map Anthropic tools and `tool_choice` to OpenAI Responses tools/tool choice.
- Map `max_tokens`, `temperature`, `top_p`, `stop_sequences`, and `stream`.
- Reject or audit unsupported Anthropic-only fields instead of silently dropping them.

Acceptance criteria:

- Non-streaming Claude Code-style request bodies produce valid OpenAI Chat request bodies.
- Non-streaming Claude Code-style request bodies produce valid OpenAI Responses request bodies.
- Tool-use and tool-result IDs survive a request translation round trip.
- Provider-specific unsupported fields are handled through explicit unavailable/audit behavior.
- Translated request bodies still pass through provider-dialect rewrite for selected model, effort, and max output settings.

Validation:

- Add translator unit tests.
- Add runtime test routing `/v1/messages` to an OpenAI Chat-only provider.
- Add runtime test routing `/v1/messages` to an OpenAI Responses-only provider.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/translators/anthropicOpenAIChat.ts` (new)
- `apps/proxy/src/translators/index.ts`
- `apps/proxy/test/translationRuntime.test.ts`

### HMT-004: Translate OpenAI Chat Requests To Anthropic Messages

Goal: Let OpenAI Chat callers such as opencode, Cursor BYOK, and SDK clients target Anthropic Messages endpoints.

Scope:

- Map OpenAI system/developer/user/assistant/tool messages to Anthropic `system` and `messages`.
- Map OpenAI `tool_calls` to Anthropic `tool_use` blocks.
- Map OpenAI tool result messages to Anthropic `tool_result` blocks.
- Map OpenAI tools and `tool_choice` to Anthropic tools/tool choice.
- Map `max_completion_tokens`/`max_tokens`, `temperature`, `top_p`, `stop`, and `stream`.
- Reject or audit unsupported OpenAI-only fields instead of silently dropping them.

Acceptance criteria:

- Non-streaming OpenAI Chat request bodies produce valid Anthropic Messages request bodies.
- opencode/Cursor-style tool call histories preserve IDs and ordering.
- Anthropic upstream caching policies run after translation, not before.
- Existing OpenAI Chat -> Responses same-family translation still passes.

Validation:

- Add translator unit tests.
- Add runtime test routing `/v1/chat/completions` to an Anthropic-only provider.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/translators/anthropicOpenAIChat.ts` (new)
- `apps/proxy/src/translators/index.ts`
- `apps/proxy/test/translationRuntime.test.ts`

### HMT-005: Translate Non-Streaming Responses Across Caller Surfaces

Goal: Return the caller's original JSON response shape for cross-family routes.

Scope:

- Map Anthropic Messages responses to OpenAI Chat completion responses.
- Map Anthropic Messages responses to OpenAI Responses responses.
- Map OpenAI Chat completion responses to Anthropic Messages responses.
- Map OpenAI Responses responses to Anthropic Messages responses.
- Map text content, tool calls, finish reasons, model/id fields, and usage.
- Preserve provider usage for accounting while returning caller-dialect usage in the response body.
- Add error-body handling for translated non-SSE provider failures.

Acceptance criteria:

- Claude Code receives Anthropic-shaped JSON when its request routed to OpenAI Chat.
- Claude Code receives Anthropic-shaped JSON when its request routed to OpenAI Responses.
- Codex receives Responses-shaped JSON when its request routed to Anthropic.
- OpenAI Chat callers receive Chat-shaped JSON when their request routed to Anthropic.
- Tool-call responses map to the caller's tool-call representation.
- Usage fields are present in the caller dialect where upstream usage exists.

Validation:

- Add translator unit tests for text, tool-call, usage, and error cases.
- Add runtime non-streaming tests for both directions.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/translators/anthropicOpenAIChat.ts`
- `apps/proxy/src/proxy.ts`
- `apps/proxy/test/translationRuntime.test.ts`

### HMT-006: Translate SSE Streams Across Caller Surfaces

Goal: Preserve streaming behavior across Anthropic Messages <-> OpenAI Chat and OpenAI Responses -> Anthropic Messages translated routes.

Scope:

- Map OpenAI Chat text deltas to Anthropic `content_block_delta` events.
- Map OpenAI Responses text deltas to Anthropic `content_block_delta` events.
- Map Anthropic text deltas to OpenAI Chat `choices[].delta.content` chunks.
- Map Anthropic text deltas to OpenAI Responses `response.output_text.delta` events.
- Map OpenAI tool-call starts and argument deltas to Anthropic `tool_use` block events.
- Map Anthropic `tool_use` starts and `input_json_delta` events to OpenAI Chat tool-call deltas.
- Map terminal events, finish reasons, usage frames, and `[DONE]` where applicable.
- Cover chunk boundaries where JSON arguments arrive across multiple frames.

Acceptance criteria:

- Streaming Claude Code requests receive valid Anthropic Messages SSE from OpenAI Chat upstreams.
- Streaming Claude Code requests receive valid Anthropic Messages SSE from OpenAI Responses upstreams.
- Streaming Codex HTTP requests receive valid OpenAI Responses SSE from Anthropic upstreams.
- Streaming OpenAI Chat requests receive valid Chat Completions SSE from Anthropic upstreams.
- Tool-call argument deltas are not reordered or concatenated incorrectly.
- Existing SSE observer behavior still captures output text, usage, status, and response id.

Validation:

- Add golden SSE fixtures for both directions.
- Add runtime streaming tests for both directions.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/translators/anthropicOpenAIChat.ts`
- `apps/proxy/src/sseObserver.ts`
- `apps/proxy/test/fixtures/*.sse`
- `apps/proxy/test/translationRuntime.test.ts`

## Phase 2: Runtime Wiring And Observability

### HMT-007: Register Cross-Family Translators

Goal: Make the router select cross-family translated targets through the existing provider endpoint resolver.

Scope:

- Register `anthropic-messages -> openai-chat`.
- Register `openai-chat -> anthropic-messages`.
- Register `openai-responses -> anthropic-messages`.
- Register `anthropic-messages -> openai-responses`.
- Keep current `previous_response_id` and WebSocket guards in force.
- Add translated-route guardrail actions and unavailable reason coverage.

Acceptance criteria:

- Claude Code HTTP `/v1/messages` can route to a Chat-only OpenAI-compatible provider.
- Claude Code HTTP `/v1/messages` can route to a Responses-only OpenAI-compatible provider.
- Codex HTTP `/v1/responses` can route to an Anthropic-only provider.
- OpenAI Chat `/v1/chat/completions` can route to an Anthropic-only provider.
- Codex prior-response continuations and WebSocket traffic skip translated targets with clear reason codes.

Validation:

- Extend `translationRuntime.test.ts`.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/src/translators/index.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/test/translationRuntime.test.ts`

### HMT-008: Verify Usage, Cache, And Prompt Capture On Translated Routes

Goal: Prove translated routes still feed accounting, cache optimization, and prompt capture correctly.

Scope:

- Add usage normalization expectations for Anthropic upstreams serving Chat callers.
- Add usage normalization expectations for OpenAI Chat upstreams serving Claude Code callers.
- Verify Anthropic cache-control injection/TTL upgrade happens after Chat -> Messages translation.
- Verify OpenAI prompt cache retention happens after Messages -> Chat translation only where the upstream dialect supports it.
- Verify prompt artifact extraction uses the caller surface after response translation.

Acceptance criteria:

- Provider attempts record selected upstream provider/model and caller surface.
- Usage ledger rows do not double-count translated responses.
- Cache read/write fields survive when the upstream reports them.
- Prompt capture stores raw text through `prompt_artifacts.raw_text`, not event payloads.

Validation:

- Add focused tests for usage/caching/prompt capture paths.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/adapters.ts`
- `apps/proxy/src/persistence/usageNormalization.ts`
- `apps/proxy/src/persistence/promptArtifacts.ts`
- `apps/proxy/test/automaticCaching.test.ts`
- `apps/proxy/test/adminPromptApis.test.ts`

## Phase 3: Admin UI

### HMT-009: Expose Route Compatibility Preview To The Console

Goal: Give the web app route-target coverage from the backend/shared compatibility contract.

Scope:

- Add a GraphQL route-preview query/mutation or expose shared compatibility data through the existing routing model catalog flow.
- Accept a routing config draft and preview harness/surface/transport.
- Return per-route, per-target native/translated/unavailable status and reason codes.
- Keep route preview read-only; it must not publish configs or make provider calls.

Acceptance criteria:

- The console can request coverage for Codex, Claude Code, opencode, Cursor, and generic OpenAI preview modes.
- Preview results match backend compatibility tests for native, translated, and unavailable targets.
- GraphQL types are regenerated and consumed by the web app.

Validation:

- Add GraphQL resolver tests.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm --dir apps/web typecheck`.

Likely files:

- `apps/proxy/src/graphql/queries.ts`
- `apps/proxy/src/graphql/types/routing.ts`
- `apps/web/src/routing/data.ts`
- `apps/web/src/gql/graphql.ts`

### HMT-010: Replace Target Skip Warnings With Coverage UI

Goal: Make routing config target rows show native/translated/unavailable coverage instead of protocol skip warnings.

Scope:

- Remove frontend-only `hasResponses`/`hasMessages` skip-note logic.
- Render compact coverage status from the route-preview/compatibility contract.
- Add preview mode control: Codex, Claude Code, opencode, Cursor, Generic OpenAI.
- Show effective target order per tier for the selected preview mode.
- Keep the editor dense and operational; no landing-page or tutorial treatment.

Acceptance criteria:

- A target newly supported by a backend translator appears as translated, not skipped.
- Codex stateful/WebSocket preview still explains native-only/unavailable behavior.
- Disabled providers, missing models, and missing credentials still show actionable warnings.
- Text fits in target rows across desktop and mobile editor widths.

Validation:

- Add React/data tests for coverage rendering and preview mode behavior.
- Run `pnpm --dir apps/web typecheck`.
- Run `pnpm --filter @proxy/web test`.

Likely files:

- `apps/web/src/routing/configEditorFields.tsx`
- `apps/web/src/routingConfigEditor.ts`
- `apps/web/src/routing/data.ts`
- `apps/web/src/styles/proxy/pages.css`

## Phase 4: Docs And Runbooks

### HMT-011: Update Architecture And Harness Docs

Goal: Document the shipped HTTP translation behavior and operator workflow.

Scope:

- Update `docs/model-routing.md` after implementation lands.
- Update `docs/runbooks/routing-configs.md` with target coverage and harness preview behavior.
- Update opencode setup docs with Anthropic target support through translation.
- Add Claude Code setup docs if none exist by then.
- Keep Codex WebSocket and `previous_response_id` translation documented as deferred, not silently missing.

Acceptance criteria:

- Docs no longer say Anthropic <-> OpenAI translation is out of scope without qualification.
- Operator docs explain native, translated, and unavailable coverage states.
- Harness docs call out Codex prior-response/WebSocket limitations.
- `docs/index.md` links this ticket breakdown.

Validation:

- Run a stale-wording search across `docs/`.
- Run `git diff --check`.

Likely files:

- `docs/model-routing.md`
- `docs/runbooks/routing-configs.md`
- `docs/harnesses/opencode.md`
- `docs/harnesses/claude-code.md` (new, if needed)
- `docs/index.md`
