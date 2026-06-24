# HCT-010: Add Cross-Family Translation Golden Tests

Goal: Fixture-back Anthropic Messages <-> OpenAI Chat and OpenAI Responses -> Anthropic Messages translated paths where translators are enabled.

## Scope

- Add fixtures for Anthropic Messages -> OpenAI Chat.
- Add fixtures for OpenAI Chat -> Anthropic Messages.
- Add fixtures for OpenAI Responses HTTP without `previous_response_id` -> Anthropic Messages.
- Cover system/developer role mapping, text blocks, image content, tool declarations, tool calls, tool results, stop reason mapping, reasoning/thinking fields, cache-control stripping, and usage.
- Assert translated response shapes match the caller dialect.
- Assert SSE event sequences for streaming text and tool-use deltas.

## Acceptance Criteria

- Cross-family translated requests produce exact expected upstream JSON.
- Cross-family translated responses preserve caller dialect shape.
- Tool-use IDs and tool-result IDs survive translation.
- Unsupported provider-specific fields are rejected or audited explicitly.
- No WebSocket translation is introduced.

## Validation

- Run `pnpm --filter @proxy/proxy test -- openAITranslators`.
- Run `pnpm --filter @proxy/proxy test -- translationRuntime`.
- Run `pnpm --filter @proxy/proxy test -- harness-compatibility`.

## Likely Files

- `apps/proxy/src/translators/anthropicOpenAI.ts`
- `apps/proxy/src/translators/index.ts`
- `apps/proxy/test/openAITranslators.test.ts`
- `apps/proxy/test/translationRuntime.test.ts`
- `apps/proxy/test/fixtures/harnesses/`
