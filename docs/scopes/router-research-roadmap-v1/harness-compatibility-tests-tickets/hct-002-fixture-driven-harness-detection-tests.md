# HCT-002: Add Fixture-Driven Harness Detection Tests

Goal: Lock harness detection, session extraction, and header selection to real caller shapes.

## Scope

- Add fixtures for Codex HTTP, Codex WebSocket, Claude Code Messages, generic OpenAI Chat SDK, opencode, and Cursor BYOK.
- Cover positive detection, generic fallback, invalid or missing session IDs, body-derived session IDs, metadata-derived session IDs, and user-agent/header signals.
- Assert identity header allowlists and dialect header allowlists per profile.
- Assert prompt block tag selection per surface and profile.

## Acceptance Criteria

- Detection tests cover each supported profile ID.
- Session IDs are extracted from the same fields used by runtime session pinning.
- Invalid session-like values do not become durable harness sessions.
- Header forwarding allowlists are tested per profile and dialect.

## Validation

- Run `pnpm --filter @prompt-proxy/proxy test -- features`.
- Run `pnpm --filter @prompt-proxy/proxy test -- session`.

## Likely Files

- `apps/proxy/test/features.test.ts`
- `apps/proxy/test/sessionPinning.test.ts`
- `apps/proxy/test/promptArtifacts.test.ts`
- `apps/proxy/test/fixtures/harnesses/`
