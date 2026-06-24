# HCT-001: Normalize Harness Profile Metadata

Goal: Make each supported harness/profile an explicit typed contract instead of only detector logic.

## Scope

- Extend the existing `HarnessProfile` model or split it only if the file becomes hard to scan.
- Add stable profile IDs for `codex-responses-http`, `codex-responses-websocket`, `claude-code-messages`, `openai-chat-sdk`, `opencode-chat`, and `cursor-byok-chat`.
- Capture surface, dialect, transport, endpoints, session keys, required request fields, required response fields, dialect headers, identity headers, stateful features, and unsupported translated features.
- Preserve current broad harness names where they are already stored in events or metadata.
- Export JSON-safe profile metadata for tests and future admin surfaces.

## Acceptance Criteria

- Every currently supported harness surface has one explicit profile.
- Existing harness detection behavior is unchanged.
- Profile metadata can describe native HTTP, native WebSocket, OpenAI-compatible chat callers, and generic fallback traffic.
- No route behavior changes in this ticket.

## Validation

- Run harness detection tests.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

## Likely Files

- `apps/proxy/src/harness.ts`
- `apps/proxy/test/features.test.ts`
- `apps/proxy/test/toolResultCompression.test.ts`
