# HCT-004: Add Harness Golden Fixture Loader

Goal: Create the fixture format and assertions used by all compatibility tests.

## Scope

- Add fixture folders under `apps/proxy/test/fixtures/harnesses/<profile-id>/<case-id>/`.
- Support inbound request, route context, expected upstream request, upstream response, expected client response, upstream SSE, expected client SSE, usage extraction, and route-plan excerpt fixtures.
- Add schema validation for fixture files.
- Add assertion helpers for volatile IDs, timestamps, chunk ordering, and optional provider metadata.
- Keep fixture normalization narrow and explicit.

## Acceptance Criteria

- Invalid fixture files fail with useful error messages.
- Tests can assert exact upstream request JSON.
- Tests can assert exact client response JSON.
- Tests can assert exact SSE event sequences without hiding ordering bugs.
- Tests can assert a route-plan excerpt for unsupported paths.

## Validation

- Add fixture loader tests.
- Run `pnpm --filter @prompt-proxy/proxy test`.
- Run `pnpm typecheck`.

## Likely Files

- `apps/proxy/test/harnessFixtures.ts` (new)
- `apps/proxy/test/harness-compatibility.test.ts` (new)
- `apps/proxy/test/fixtures/harnesses/`
