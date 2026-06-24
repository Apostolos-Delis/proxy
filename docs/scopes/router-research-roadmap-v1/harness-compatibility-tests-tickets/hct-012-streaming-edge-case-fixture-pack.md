# HCT-012: Add Streaming Edge-Case Fixture Pack

Goal: Cover the streaming cases most likely to corrupt harness behavior.

## Scope

- Add fixtures for tool call starts and argument deltas split across frames.
- Add fixtures for empty content blocks and empty deltas.
- Add fixtures for provider error frames in SSE.
- Add fixtures for upstream JSON bodies on streaming requests.
- Add fixtures for terminal usage missing from the stream.
- Add client-disconnect coverage where the current test harness can assert cleanup.
- Assert output capture, usage extraction, provider attempt status, and request status.

## Acceptance Criteria

- SSE translation preserves tool argument chunk order.
- Provider error frames produce stable client-visible and durable statuses.
- Missing terminal usage does not break request completion.
- Client disconnect handling records cancellation without corrupting captured output.

## Validation

- Run `pnpm --filter @proxy/proxy test -- sseObserver`.
- Run `pnpm --filter @proxy/proxy test -- bufferedStreamResponse`.
- Run `pnpm --filter @proxy/proxy test -- translationRuntime`.

## Likely Files

- `apps/proxy/src/sseObserver.ts`
- `apps/proxy/src/bufferedStreamResponse.ts`
- `apps/proxy/test/sseObserver.test.ts`
- `apps/proxy/test/bufferedStreamResponse.test.ts`
- `apps/proxy/test/fixtures/sse/`
- `apps/proxy/test/fixtures/harnesses/`
