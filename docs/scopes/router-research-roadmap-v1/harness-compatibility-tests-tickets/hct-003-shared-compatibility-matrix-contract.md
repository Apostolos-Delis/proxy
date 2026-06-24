# HCT-003: Add Shared Compatibility Matrix Contract

Goal: Produce native, translated, blocked, and unsupported statuses from one shared compatibility function.

## Scope

- Extend the existing translation compatibility contract to include harness profile ID, surface, transport, request state, provider endpoint dialects, and translator availability.
- Return status values for native support, translated support, stateful feature blocks, missing translators, unsupported fields, missing provider endpoints, WebSocket native-only, and generic unsupported paths.
- Reuse the router's reason-code vocabulary where possible.
- Add matrix generation for every supported profile against `anthropic-messages`, `openai-responses`, and `openai-chat` provider endpoints.

## Acceptance Criteria

- The matrix is generated from shared code, not hard-coded in docs or UI.
- Native support wins over translated support when both are available.
- Codex WebSocket translated targets return `websocket_native_only`.
- Responses requests with `previous_response_id` return `previous_response_translation_unavailable`.
- Missing translator and unsupported field cases produce distinct reasons.

## Validation

- Add unit tests for the matrix generator.
- Run `pnpm --filter @proxy/schema test` if the contract lives in schema.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

## Likely Files

- `packages/schema/src/translationCompatibility.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/test/openAITranslators.test.ts`
- `apps/proxy/test/translationRuntime.test.ts`
