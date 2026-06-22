# HCT-008: Add OpenAI Chat Caller Native Golden Tests

Goal: Fixture-back OpenAI Chat native behavior for generic SDK, opencode, and Cursor BYOK callers.

## Scope

- Add fixtures for generic OpenAI Chat SDK, opencode, and Cursor BYOK request shapes.
- Cover system/developer/user/assistant/tool roles, tool calls, tool result messages, max token field variants, stop reasons, stream options, and usage.
- Assert caller-specific session detection for opencode and Cursor.
- Assert generic SDK traffic does not get misattributed to a specific harness.

## Acceptance Criteria

- OpenAI Chat native fixtures pass against the mock OpenAI Chat upstream.
- opencode and Cursor session identities are extracted from their supported fields.
- Generic Chat SDK traffic remains generic unless it carries a known profile signal.
- Streaming Chat fixtures end with the expected terminal frame.

## Validation

- Run `pnpm --filter @prompt-proxy/proxy test -- harness-compatibility`.
- Run `pnpm --filter @prompt-proxy/proxy test -- openAIChatRewrite`.

## Likely Files

- `apps/proxy/test/harness-compatibility.test.ts`
- `apps/proxy/test/openAIChatRewrite.test.ts`
- `apps/proxy/test/fixtures/harnesses/openai-chat-sdk/`
- `apps/proxy/test/fixtures/harnesses/opencode-chat/`
- `apps/proxy/test/fixtures/harnesses/cursor-byok-chat/`
