# HCT-005: Add Codex Responses HTTP Native Golden Tests

Goal: Fixture-back the Codex HTTP -> OpenAI Responses native path.

## Scope

- Add non-streaming and streaming Codex Responses HTTP fixtures.
- Cover instructions, input items, tool declarations, tool calls, tool results, model rewrite, max output tokens, reasoning effort, headers, and usage.
- Assert upstream OpenAI Responses request shape.
- Assert client OpenAI Responses response shape and SSE event sequence.
- Assert route decision evidence for native provider selection.

## Acceptance Criteria

- Codex HTTP native fixtures pass against the mock OpenAI Responses upstream.
- Tool call IDs and tool result IDs survive unchanged.
- Streaming fixtures include text deltas, terminal events, and usage where available.
- Route metadata identifies the Codex profile and native Responses dialect.

## Validation

- Run `pnpm --filter @proxy/proxy test -- harness-compatibility`.
- Run `pnpm --filter @proxy/proxy test -- translationRuntime`.

## Likely Files

- `apps/proxy/test/harness-compatibility.test.ts`
- `apps/proxy/test/translationRuntime.test.ts`
- `apps/proxy/test/fixtures/harnesses/codex-responses-http/`
