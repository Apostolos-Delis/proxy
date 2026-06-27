# Harness Model Translation V1

## Goal

Let each routing tier choose the best provider/model once, then let the proxy translate between the caller's harness protocol and the selected upstream dialect when that is safe.

The admin experience should not force operators to think in terms of "OpenAI Responses requests skip this target" or "Anthropic Messages requests skip that target." A routing config route should read as:

```text
fast      claude-haiku or gpt-mini
balanced  claude-sonnet or gpt
hard      gpt-codex or claude-opus
deep      best available model
```

The proxy owns the translation, response shape, caching policy, and audit trail.

## Product Direction

The current routing UI exposes provider protocol compatibility as per-row warning text. That makes the operator solve a lower-level implementation detail:

```text
Anthropic target selected
  OpenAI Responses coverage shown as unavailable.

OpenAI target selected
  Anthropic Messages coverage shown as unavailable.
```

The target state is:

```text
Routing config route
  -> ordered targets
  -> each target declares provider/model/settings
  -> proxy labels native vs translated coverage
  -> runtime uses the first target that can serve the caller surface
```

If a target can be translated safely, it should be eligible. If it cannot, the UI should explain the real reason:

```text
Native for Claude Code, translated for opencode/Cursor.
Unavailable for Codex stateful Responses.
```

## Current State

Proxy already has the right seams:

- `packages/schema/src/index.ts` defines three surfaces/dialects: `openai-responses`, `openai-chat`, and `anthropic-messages`.
- `apps/proxy/src/translators/index.ts` has a registry with `request`, `response`, and `sseTransform` hooks.
- `apps/proxy/src/translators/openai.ts` implements OpenAI Responses <-> Chat Completions translation.
- `apps/proxy/src/router.ts` already considers non-native provider endpoints when `translators.canTranslate(context.surface, candidate.dialect)` is true.
- `apps/proxy/src/proxy.ts` already applies response translators for JSON and SSE responses.
- `apps/web/src/routing/configEditorFields.tsx` renders target-row coverage from the shared compatibility helper.

The main architecture and harness docs now describe cross-family Anthropic <-> OpenAI translation and the native-only Codex limitations.

## opencode Findings

There are two relevant opencode paths.

The local opencode client mostly avoids wire-level protocol translation by using Vercel AI SDK `ModelMessage` internally:

```text
session prompt/messages
  -> AI SDK ModelMessage[]
  -> provider-specific AI SDK adapter
  -> streamText()
```

The opencode server-side Zen proxy does use a translation bridge:

```text
incoming format: anthropic | openai | oa-compat
  -> CommonRequest
  -> selected provider format
  -> upstream request
  -> CommonResponse/CommonChunk
  -> incoming response format
```

The concrete files in `~/Documents/repos/opencode` are:

- `packages/console/app/src/routes/zen/util/provider/provider.ts`
- `packages/console/app/src/routes/zen/util/provider/anthropic.ts`
- `packages/console/app/src/routes/zen/util/provider/openai.ts`
- `packages/console/app/src/routes/zen/util/provider/openai-compatible.ts`
- `packages/console/app/src/routes/zen/util/handler.ts`

The important lesson is not to copy their exact data model. It is the shape:

```text
from inbound dialect
  -> small common message/tool/chunk model
  -> to outbound dialect
```

Proxy can do the same behind its existing `DialectTranslator` registry, while preserving richer harness-specific behavior where needed.

## Design

### Translator Registry

Keep the existing registry and add cross-family translators:

```text
anthropic-messages -> openai-chat
openai-chat -> anthropic-messages
openai-responses -> anthropic-messages
anthropic-messages -> openai-responses
```

OpenAI Responses to/from Anthropic Messages is required for Codex HTTP routing to Anthropic models. It remains guarded for WebSocket and `previous_response_id` traffic until there is a provider-state bridge.

Implement these through a small internal canonical shape:

```text
CanonicalRequest
  model
  messages
  tools
  toolChoice
  maxOutputTokens
  temperature
  topP
  stop
  stream
  metadata

CanonicalMessage
  role: system | user | assistant | tool
  content: text and image parts
  toolCalls
  toolCallId

CanonicalChunk
  id
  model
  textDelta
  toolCallStart
  toolCallArgumentsDelta
  finishReason
  usage
```

Do not turn the canonical shape into a new public API. It is an implementation detail for translator tests and route runtime.

### Request Mapping

V1 must preserve:

- system/instructions text
- user/assistant/tool roles
- text content
- image URL and base64 image content when both sides support it
- function tools and JSON schemas
- tool choice: auto, required/any, and named tool
- tool-use IDs and tool-result IDs
- stop sequences
- max output tokens
- streaming flag

V1 should deliberately drop or gate provider-specific fields that cannot be represented safely. Examples:

- Anthropic `thinking` blocks in historical assistant content
- Anthropic `cache_control` blocks that cannot round-trip through OpenAI callers
- OpenAI Responses `previous_response_id`
- OpenAI Responses encrypted reasoning includes
- provider-specific response-format, prediction, audio, and server-tool fields unless explicitly mapped

Dropped fields should not silently disappear on eligible routes. The translator should either map them, reject the translated route as unavailable, or record a clear `translation_field_dropped:*` guardrail action when the field is known to be safe to omit.

### Response Mapping

V1 must return the caller's original protocol:

```text
Claude Code request to OpenAI target
  upstream: OpenAI Chat or Responses
  caller receives: Anthropic Messages JSON/SSE

Codex request to Anthropic target
  upstream: Anthropic Messages
  caller receives: OpenAI Responses JSON/SSE

opencode/Cursor request to Anthropic target
  upstream: Anthropic Messages
  caller receives: OpenAI Chat JSON/SSE
```

For streaming:

- OpenAI text deltas become Anthropic `content_block_delta` text events.
- Anthropic text deltas become OpenAI chat `choices[].delta.content`.
- OpenAI function tool starts and argument deltas become Anthropic `tool_use` block starts and `input_json_delta`.
- Anthropic `tool_use` block starts and `input_json_delta` become OpenAI tool call deltas.
- Finish reasons map between `stop`, `tool_calls`, `length`, and `content_filter`.
- Usage maps into the caller dialect's usage shape and the existing provider-attempt accounting still records provider usage.

### Runtime Eligibility

Translated routing should be eligible only when the request is transcript-replay based.

Eligible in V1:

- Claude Code HTTP `/v1/messages` to OpenAI Chat or Responses targets.
- Codex/OpenAI Responses HTTP `/v1/responses` to Anthropic Messages targets when the request does not carry `previous_response_id`.
- OpenAI Chat `/v1/chat/completions` from opencode, Cursor BYOK, or SDK callers to Anthropic targets.
- Existing same-family OpenAI Responses <-> Chat translation when the selected provider exposes only the other OpenAI dialect.

Not eligible in V1:

- Codex WebSocket `/v1/responses`.
- OpenAI Responses requests with `previous_response_id`.
- Requests with response-state requirements that the target dialect cannot preserve.

The current `previous_response_id` guard stays in force. The stateful Codex guard must become transport/state specific so ordinary HTTP turns can route to Anthropic while WebSocket and prior-response continuations remain native-only.

### Caching Policy

Caching should follow the upstream dialect, not the inbound harness:

- Anthropic upstreams may receive automatic cache control and TTL upgrades after translation.
- Public OpenAI API upstreams may receive documented client-sent `prompt_cache_retention`; Proxy does not add the field automatically.
- Cache annotations from one dialect should not be blindly copied into the other dialect.
- Cache changes must be byte-stable across turns for Claude Code history replay.

This means request translation happens before provider-dialect rewrite and caching injection, as it already does in `rewriteSurfaceRequest`.

### Audit

Route decisions should distinguish native and translated traffic:

```text
translated_request:anthropic-messages_to_openai-chat
translated_request:openai-chat_to_anthropic-messages
target_skipped_previous_response_translation_unavailable:<provider>
target_skipped_stateful_translation_unavailable:<provider>
target_skipped_translator_unavailable:<provider>
translation_field_dropped:anthropic_thinking
```

Provider attempt rows should continue to record:

```text
surface: caller surface
provider: selected upstream provider
model: selected upstream model
```

The decision event should carry enough metadata to explain that the response was translated back to the caller surface.

### Compatibility Contract

The routing UI must not maintain its own hard-coded dialect matrix. Runtime compatibility is owned by the same backend/shared logic that owns route eligibility:

```text
surface + harness + transport + request state
  -> provider endpoints
  -> registered translator availability
  -> native | translated | unavailable(reason)
```

Expose this through one contract before replacing the UI warnings. Either option is acceptable:

- a GraphQL route-preview API that evaluates a routing config draft against the backend resolver, or
- a shared compatibility module consumed by both `apps/proxy` and `apps/web`, with backend tests proving it matches router behavior.

The contract should return enough detail for the UI to render coverage without duplicating router rules:

```text
harness: codex | claude-code | opencode | cursor | generic
surface: openai-responses | openai-chat | anthropic-messages
transport: http | websocket
target provider/model
status: native | translated | unavailable
providerDialect
translation: from/to when status is translated
reasonCodes: previous_response_translation_unavailable, stateful_translation_unavailable, translator_unavailable, dialect_unavailable, provider_credential_unresolved
```

The routing config editor, model filters, and harness preview should consume this contract. They should not infer translation coverage by checking only whether a provider has a Responses, Chat, or Messages endpoint.

## UI Scope

The routing config editor should change from protocol warnings to coverage/status.

### Target Row

Each target row should show:

```text
Provider  Model  Effort  Coverage
```

Coverage examples:

```text
Native: Claude Code
Translated: opencode, Cursor
Unavailable: Codex stateful
```

Do not render repeated warning chips under every row when translation is available. Use concise status pills or a compact popover.

### Model Picking

The operator should choose a provider/model once per target. The UI should not force separate OpenAI and Anthropic targets unless the operator wants explicit fallback ordering.

Useful filters:

- All models
- Native for selected harness
- Translatable for selected harness
- Unavailable for selected harness

### Harness Preview

Add a per-config preview mode:

```text
Preview as: Codex | Claude Code | opencode | Cursor | Generic OpenAI
```

For each tier, show the effective target order for that harness:

```text
balanced
  1. claude-sonnet via Anthropic Messages
  2. gpt-5.5 via OpenAI Chat -> Anthropic Messages translation
```

This makes the actual routing behavior inspectable without duplicating route configs per harness.

## Implementation Plan

### 1. Translator Foundation

- Add a canonical translator module under `apps/proxy/src/translators/`.
- Move the existing OpenAI Responses <-> Chat logic onto the canonical helpers only where it reduces risk; avoid a broad rewrite if direct translators stay simpler.
- Add unit tests for canonical request, response, and SSE chunk mapping.
- Register Anthropic <-> OpenAI Chat translators first.

### 2. Runtime Integration

- Let the existing `targetEndpoint` and `targetAvailability` path discover cross-family translators.
- Keep the current stateful and `previous_response_id` translation guards.
- Add guardrail actions for translated routes and known unavailable reasons.
- Ensure provider request headers use the upstream dialect, while identity headers still follow the detected harness policy.
- Verify usage observation is performed on the caller surface after response translation, and provider usage is still captured accurately.
- Extract or expose the compatibility contract that route preview and UI coverage will use, and test it against the router's native/translated/unavailable decisions.

### 3. Response Streaming

- Add Anthropic SSE -> OpenAI Chat SSE mapping tests.
- Add OpenAI Chat SSE -> Anthropic SSE mapping tests.
- Add Anthropic SSE -> OpenAI Responses SSE mapping tests.
- Add OpenAI Responses SSE -> Anthropic SSE mapping tests.
- Cover tool-call argument deltas split across multiple events.
- Cover usage frames arriving before/after terminal events.

### 4. Admin UI

- Replace skip-note logic in `configEditorFields.tsx` with coverage from the backend/shared compatibility contract.
- Add harness preview to the routing config editor or detail page.
- Update model/provider options to surface translatable targets as normal choices.
- Add a regression test that a provider endpoint newly supported by the backend translator registry appears as translated, not skipped, in the editor coverage.
- Keep the dark, dense console style; this is a routing workbench, not an educational page.

### 5. Docs

- Update `docs/model-routing-proxy.md` after implementation lands.
- Update `docs/runbooks/routing-configs.md` with the new operator flow.
- Add harness-specific caveats to `docs/harnesses/opencode.md` and future Claude Code setup docs.

## MVP Acceptance Criteria

- Claude Code `/v1/messages` can route to an OpenAI Chat target and receive Anthropic Messages JSON/SSE.
- Claude Code `/v1/messages` can route to an OpenAI Responses target and receive Anthropic Messages JSON/SSE.
- Codex HTTP `/v1/responses` can route to an Anthropic target and receive OpenAI Responses JSON/SSE.
- OpenAI Chat `/v1/chat/completions` can route to an Anthropic target and receive OpenAI Chat JSON/SSE.
- Tool calls work both directions across non-streaming and streaming requests.
- Tool results in the next turn map back to the selected provider dialect.
- Usage is captured and displayed without double-counting or losing cache-read/cache-write fields that exist in the upstream response.
- Route decisions include translated-route guardrail actions.
- The routing config UI no longer says compatible translated targets will be skipped, and its coverage comes from the backend/shared compatibility contract rather than a frontend-only dialect check.
- Codex `previous_response_id` continuations and WebSocket traffic remain native-only with clear UI/runtime reasons.
- Existing OpenAI Responses <-> Chat translation tests still pass.

## Non-Goals

- Provider-side response state emulation for Codex `previous_response_id`.
- Codex WebSocket translation.
- Perfect preservation of opaque reasoning blocks across provider families.
- Full provider-specific feature parity across audio, prediction, response-format, web-search, computer-use, and server tools.
- A public canonical protocol API.
- Deterministic routing fallback logic.

## Risks

- Tool-call ID drift can break the next turn. Tests need to prove assistant tool-use IDs and user tool-result IDs survive round trips.
- Anthropic thinking/redacted-thinking blocks are byte-sensitive in replayed history. If the proxy mutates or drops them in a translated loop, later Anthropic-native calls may fail.
- OpenAI Responses state cannot be reconstructed from Chat or Anthropic without storing and replaying a provider-state transcript. Do not fake prior-response continuations in V1.
- Usage fields differ enough that cost attribution needs explicit tests for cache reads, cache writes, and reasoning tokens.
- Provider-specific request options can be silently lost. Unknown fields should be audited or translation should be declared unavailable.

## Open Decisions

- Should operators be able to disable cross-family translation per routing config?
- Should a provider registry endpoint declare translation quality/capability metadata, or should it be fully derived from registered translators and model capabilities?
