# HCT-011: Add Unsupported And Stateful Rejection Fixtures

Goal: Prove unsupported paths are blocked before provider selection and explain why.

## Scope

- Add rejection fixtures for Responses `previous_response_id` translation.
- Add rejection fixtures for WebSocket translation.
- Add rejection fixtures for missing provider endpoint dialects.
- Add rejection fixtures for missing translator pairs.
- Add rejection fixtures for unsupported fields that cannot be safely mapped.
- Assert skipped target reasons and route-plan excerpts.
- Assert no upstream provider request is made for blocked paths.

## Acceptance Criteria

- Unsupported stateful paths reject before provider selection.
- Missing translator and missing endpoint cases are distinguishable.
- Unsupported fields are never silently dropped in translated routes.
- Route decisions expose the blocking reason.

## Validation

- Run `pnpm --filter @prompt-proxy/proxy test -- translationRuntime`.
- Run `pnpm --filter @prompt-proxy/proxy test -- routingConfigRuntime`.
- Run `pnpm --filter @prompt-proxy/proxy test -- harness-compatibility`.

## Likely Files

- `packages/schema/src/translationCompatibility.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/test/translationRuntime.test.ts`
- `apps/proxy/test/fixtures/harnesses/unsupported/`
