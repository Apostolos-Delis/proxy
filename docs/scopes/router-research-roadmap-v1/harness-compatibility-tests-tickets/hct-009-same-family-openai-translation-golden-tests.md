# HCT-009: Add Same-Family OpenAI Translation Golden Tests

Goal: Fixture-back OpenAI Responses HTTP <-> OpenAI Chat translated paths.

## Scope

- Add fixtures for OpenAI Responses HTTP without `previous_response_id` -> OpenAI Chat.
- Add fixtures for OpenAI Chat -> OpenAI Responses.
- Cover request translation, response translation, SSE translation, usage extraction, tool calls, tool result messages, reasoning fields, max token fields, and stop reasons.
- Assert translated-route guardrail actions in the route decision.

## Acceptance Criteria

- Same-family request translators produce exact expected upstream JSON.
- Same-family response translators produce exact expected client JSON.
- Same-family SSE translators produce exact expected client event sequences.
- Route decisions include `translated_request` evidence.

## Validation

- Run `pnpm --filter @proxy/proxy test -- openAITranslators`.
- Run `pnpm --filter @proxy/proxy test -- translationRuntime`.
- Run `pnpm --filter @proxy/proxy test -- harness-compatibility`.

## Likely Files

- `apps/proxy/src/translators/openai.ts`
- `apps/proxy/test/openAITranslators.test.ts`
- `apps/proxy/test/translationRuntime.test.ts`
- `apps/proxy/test/fixtures/translators/`
- `apps/proxy/test/fixtures/harnesses/`
