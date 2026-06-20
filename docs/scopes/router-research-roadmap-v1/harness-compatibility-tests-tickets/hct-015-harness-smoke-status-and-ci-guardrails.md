# HCT-015: Add Harness Smoke Status And CI Guardrails

Goal: Keep compatibility claims from drifting after the golden suite lands.

## Scope

- Add a smoke status artifact for native and translated harness paths.
- Wire mock-provider harness smoke coverage into the existing smoke command where appropriate.
- Add a CI/test guard that fails when a new translated dialect pair or profile support claim has no fixture coverage.
- Document how to add a new harness profile or translated path.
- Keep real installed harness smoke optional unless the local environment has the harness installed.

## Acceptance Criteria

- `pnpm smoke:harnesses` or the nearest existing smoke command reports native and translated path status.
- Adding a compatibility claim without fixtures fails a test.
- Optional real-harness smoke skips cleanly when the harness binary is unavailable.
- Docs describe the required fixture files for new support claims.

## Validation

- Run `pnpm smoke:harnesses`.
- Run `pnpm --filter @prompt-proxy/proxy test -- harness-compatibility`.
- Run `pnpm lint`.

## Likely Files

- `package.json`
- `apps/proxy/test/harness-compatibility.test.ts`
- `apps/proxy/test/fixtures/harnesses/`
- `docs/harnesses/`
- `docs/scopes/router-research-roadmap-v1/harness-compatibility-tests.md`
