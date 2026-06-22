# HCT-007: Add Claude Code Messages Native Golden Tests

Goal: Fixture-back the Claude Code -> Anthropic Messages native path.

## Scope

- Add non-streaming and streaming Claude Code Messages fixtures.
- Cover `system`, `messages`, `tool_use`, `tool_result`, image blocks, empty content blocks, stop reasons, Anthropic version headers, Anthropic beta headers, and metadata session IDs.
- Assert upstream Anthropic Messages request shape.
- Assert client Anthropic Messages response shape and SSE event sequence.
- Assert usage extraction from Anthropic `message_start` and `message_delta` events.

## Acceptance Criteria

- Claude Code native fixtures pass against the mock Anthropic Messages upstream.
- Anthropic dialect headers are forwarded only when allowed.
- Tool-use and tool-result IDs are preserved exactly.
- Streaming usage is merged from split Anthropic usage frames.

## Validation

- Run `pnpm --filter @prompt-proxy/proxy test -- harness-compatibility`.
- Run `pnpm --filter @prompt-proxy/proxy test -- sseObserver`.

## Likely Files

- `apps/proxy/test/harness-compatibility.test.ts`
- `apps/proxy/test/sseObserver.test.ts`
- `apps/proxy/test/fixtures/harnesses/claude-code-messages/`
