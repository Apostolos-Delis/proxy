# HCT-013: Feed Profiles Into Runtime Compatibility Decisions

Goal: Make route eligibility and runtime metadata consume the same harness profile contract tested by fixtures.

## Scope

- Use detected profile ID, surface, transport, stateful features, and request state in route compatibility checks.
- Feed profile metadata into session ID extraction, route compatibility, translated path eligibility, header allowlists, prompt artifact metadata, and smoke harness selection.
- Remove duplicate harness sniffing where it has drifted from the shared detector.
- Preserve current event names and durable metadata where already used by the admin console.

## Acceptance Criteria

- Runtime route outcomes match the generated compatibility matrix for representative targets.
- Session pinning uses the shared profile/session contract.
- Header forwarding is based on profile and target dialect.
- Prompt artifacts include stable profile metadata without storing full prompt text in event payloads.

## Validation

- Run `pnpm --filter @proxy/proxy test -- sessionPinning`.
- Run `pnpm --filter @proxy/proxy test -- promptArtifacts`.
- Run `pnpm --filter @proxy/proxy test -- translationRuntime`.
- Run `pnpm typecheck`.

## Likely Files

- `apps/proxy/src/harness.ts`
- `apps/proxy/src/router.ts`
- `apps/proxy/src/proxy.ts`
- `apps/proxy/src/promptCaptureEvents.ts`
- `apps/proxy/src/persistence/sessionRoute.ts`
