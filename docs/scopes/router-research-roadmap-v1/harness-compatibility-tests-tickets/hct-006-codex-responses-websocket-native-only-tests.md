# HCT-006: Add Codex Responses WebSocket Native-Only Tests

Goal: Lock Codex WebSocket traffic to native OpenAI Responses behavior.

## Scope

- Add WebSocket profile fixtures for session creation, request routing, stateful continuation, and provider preconnect behavior where testable.
- Assert WebSocket traffic only targets OpenAI Responses endpoints.
- Assert translated targets are skipped before provider selection.
- Cover `previous_response_id` and active connection route behavior.
- Add rejection fixtures for binary client frames and non-Responses endpoint targets.

## Acceptance Criteria

- Codex WebSocket can use native OpenAI Responses targets.
- Codex WebSocket cannot translate to OpenAI Chat or Anthropic Messages.
- Stateful continuation uses the existing connection route where required.
- Rejection reasons are stable and visible.

## Validation

- Run `pnpm --filter @proxy/proxy test -- websocket`.
- Run `pnpm --filter @proxy/proxy test -- routingConfigRuntime`.

## Likely Files

- `apps/proxy/src/wsProxy.ts`
- `apps/proxy/test/routingConfigRuntime.test.ts`
- `apps/proxy/test/fixtures/harnesses/codex-responses-websocket/`
