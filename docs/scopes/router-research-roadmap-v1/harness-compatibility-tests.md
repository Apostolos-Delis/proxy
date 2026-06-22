# Harness Compatibility Tests V1

## Goal

Create a harness compatibility matrix and golden test suite for every supported native and translated request path.

This scope turns the 9router and OmniRoute lesson into Prompt Proxy practice: translation and streaming behavior must be fixture-backed before it becomes product behavior.

## Why This Matters

Coding harnesses are strict about protocol details:

- Codex depends on OpenAI Responses behavior and state.
- Claude Code depends on Anthropic Messages event sequencing and tool-use shape.
- Chat Completions SDKs expect OpenAI response fields.
- Tools and streaming deltas are easy to subtly corrupt.
- Provider usage metadata is inconsistent.

Prompt Proxy should not rely on ad hoc manual testing for these paths.

## Current State

Prompt Proxy has smoke tests for mock OpenAI and Anthropic upstreams and harness smoke commands. It also has translator architecture for supported dialect paths.

Missing:

- explicit harness profile definitions
- golden request/response fixtures per harness
- streaming fixtures per translated path
- unsupported-path fixtures
- compatibility matrix exposed to docs and UI

## Harness Profiles

Create typed profiles:

```ts
type HarnessProfile = {
  id: string;
  displayName: string;
  surface: string;
  dialect: string;
  endpoints: string[];
  sessionKeys: string[];
  requiredRequestFields: string[];
  requiredResponseFields: string[];
  streaming: HarnessStreamingContract;
  toolUse: HarnessToolContract;
  statefulFeatures: string[];
  unsupportedTranslatedFeatures: string[];
};
```

Initial profiles:

- `codex-responses-http`
- `codex-responses-websocket`
- `claude-code-messages`
- `openai-chat-sdk`
- `opencode-chat`
- `cursor-byok-chat`

## Compatibility Matrix

For each profile and provider endpoint dialect:

```text
native: supported
translated: supported
translated: blocked by stateful feature
translated: blocked by missing translator
translated: blocked by unsupported field
unsupported
```

The matrix should be generated from shared compatibility logic, not maintained by hand in the web app.

## Golden Fixtures

Each supported path should have:

- inbound request fixture
- route context fixture
- expected upstream request fixture
- upstream non-streaming response fixture
- expected client response fixture
- upstream streaming response fixture
- expected client streaming events fixture
- usage extraction fixture

Unsupported paths should have:

- inbound request fixture
- expected skip/rejection reason
- expected route execution plan excerpt

## Native Paths To Cover First

```text
Codex Responses HTTP -> OpenAI Responses
Codex Responses WebSocket -> OpenAI Responses
Claude Code Messages -> Anthropic Messages
OpenAI Chat SDK -> OpenAI Chat
```

These tests protect current behavior before expanding translation.

## Translated Paths To Cover Next

```text
OpenAI Responses HTTP without previous_response_id -> OpenAI Chat
OpenAI Chat -> OpenAI Responses
OpenAI Chat -> Anthropic Messages
Anthropic Messages -> OpenAI Chat
```

Cross-family OpenAI Responses to Anthropic should be added only when tool calls, streaming, and stateful rejection behavior are fully covered.

## Edge Cases

Golden tests should include:

- tool call start and argument deltas
- tool result messages
- empty content blocks
- image content
- system/developer role mapping
- max token field differences
- stop reason mapping
- reasoning/thinking fields
- cache control stripping
- provider error frames in SSE
- upstream JSON body on streaming request
- client disconnect handling
- terminal usage missing
- Responses `previous_response_id`
- WebSocket stateful traffic

## Test Organization

Suggested layout:

```text
apps/proxy/src/harnessProfiles/
  profiles.ts
  compatibility.ts

apps/proxy/test/fixtures/harnesses/
  codex-responses-http/
  codex-responses-websocket/
  claude-code-messages/
  openai-chat-sdk/

apps/proxy/test/translator-golden.test.ts
apps/proxy/test/harness-compatibility.test.ts
apps/proxy/test/streaming-golden.test.ts
```

Fixtures should be small and hand-readable.

## Runtime Integration

Harness profile detection should feed:

- session id extraction
- route compatibility
- translated path eligibility
- header allowlist
- prompt artifact metadata
- console labels
- smoke harness selection

Do not let route handlers each re-implement harness sniffing.

## Console And Docs

Expose:

- compatibility matrix by harness
- native vs translated support
- unsupported stateful features
- tested fixture count
- last smoke test status where available

Docs should tell operators which harness/provider combinations are safe. See the operator-facing [harness compatibility matrix](../../harnesses/compatibility-matrix.md) guide for the console and GraphQL fields.

## Validation

Unit tests:

- profile detection
- compatibility matrix generation
- unsupported stateful feature rejection
- fixture schema validation

Golden tests:

- exact upstream request shape
- exact client response shape
- exact SSE event sequence for supported streams

Smoke tests:

- mock provider native paths
- mock provider translated paths
- real installed harness smoke where available

`pnpm smoke:harnesses` reports fixture-backed native and translated path status, writes a JSON artifact when `HARNESS_SMOKE_STATUS_PATH` is set, and skips real Codex or Claude Code smoke cleanly when the corresponding local binary is unavailable.

## Rollout

1. Add profile definitions for existing native paths.
2. Add native golden tests.
3. Add compatibility matrix generator.
4. Add one translated path with full fixtures.
5. Require fixtures before enabling additional translated paths.

## Non-Goals

- No new translator behavior without fixtures.
- No WebSocket translation.
- No emulation of provider-owned Responses state.
- No automatic support claims for untested harnesses.

## Acceptance Criteria

- Each supported harness has a profile.
- Native current behavior is fixture-backed.
- Each translated path has golden request, response, streaming, and rejection tests.
- The compatibility matrix is generated from shared logic.
- Unsupported stateful paths are rejected before provider selection.
