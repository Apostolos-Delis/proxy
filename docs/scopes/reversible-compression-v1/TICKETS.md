# Reversible Compression V1 Tickets

These tickets assume the current compression implementation stays in place and evolves incrementally. They are ordered so the first tickets add safety and observability before any new mutating behavior.

## RC-001: Document And Enforce Compression Hot-Zone Invariants

Goal: Make cache-safe compression rules explicit and executable.

Scope:

- Add fixture helpers that compare original and forwarded bodies by protected zones.
- Cover Anthropic Messages, OpenAI Chat, and OpenAI Responses.
- Protected zones:
  - system/instructions
  - tools/tool schemas
  - user-authored text
  - prior messages/items when a frozen prefix is supplied
  - reasoning/thinking/signature/encrypted/redacted blocks
  - call ids, tool ids, item ids, cache-control metadata
- Assert measure-only mode forwards the original body.

Acceptance criteria:

- Existing compression tests include hot-zone fixtures for every supported surface.
- A deliberately unsafe rule that mutates a protected block fails tests.
- The test helper can be reused by future compression rules.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/toolResultCompression.test.ts`
- `apps/proxy/test/fixtures/compression/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

## RC-002: Add Retrieval Resolver For Existing Compression Receipts

Goal: Retrieve original compressed content from existing `compression_receipts` and `prompt_artifacts`.

Scope:

- Add a persistence method that resolves an opaque retrieval id to a receipt by organization/workspace/api-key context.
- Validate original artifact existence, `raw_text` storage mode, and expiry.
- Append `prompt_access_audit`.
- Return structured metadata plus original content.
- No model tool injection yet.

Acceptance criteria:

- Same-workspace valid receipt returns original content.
- Cross-workspace or cross-org receipt returns not found/forbidden without leaking existence.
- Expired or hash-only artifacts return a typed retrieval failure.
- Retrieval writes prompt access audit.

Likely files:

- `apps/proxy/src/persistence/compressionReceipts.ts`
- `apps/proxy/src/persistence/promptAccessAudit.ts`
- `apps/proxy/src/server.ts`
- `apps/proxy/test/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`
- `pnpm --filter @prompt-proxy/db test`

## RC-003: Add API-Key Authenticated Retrieval Endpoint

Goal: Expose receipt retrieval through the proxy API.

Scope:

- Add `POST /v1/compression/retrieve`.
- Authenticate like provider requests.
- Resolve organization, workspace, user, and API key.
- Support full retrieval by opaque retrieval id first.
- Accept but ignore `query` initially with a clear response field, or reject it until search is implemented.
- Emit `compression.retrieved` and `compression.retrieval_failed`.

Acceptance criteria:

- Endpoint returns original content for an authorized raw-text artifact.
- Endpoint rejects missing, expired, unauthorized, or unavailable artifacts.
- Events contain retrieval id, receipt id, request id, tool name, status, and failure reason, not raw content.

Likely files:

- `apps/proxy/src/server.ts`
- `apps/proxy/src/auth.ts`
- `apps/proxy/src/events.ts`
- `apps/proxy/src/persistence/compressionReceipts.ts`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

## RC-004: Add Retrieval Marker Metadata To Compression Records

Goal: Let compressed blocks advertise retrievable originals when policy allows.

Scope:

- Extend compression records with `retrievalAvailable`, `receiptId`, and marker metadata.
- Generate marker text from an opaque retrieval id and original hash.
- In measure-only, record what marker would be emitted without mutating forwarded bytes.
- In mutating mode, include marker only when original artifact storage succeeds.
- Keep raw tool output, event ids, receipt ids, and prompt artifact ids out of model-facing markers.

Acceptance criteria:

- Mutating compression with stored original artifact emits a marker in the compressed block.
- Mutating compression without stored original artifact does not claim retrieval is available.
- Measure-only records marker availability but forwards original body.
- Receipt preview surfaces marker availability.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/src/compressionPreview.ts`
- `apps/proxy/src/persistence/compressionReceipts.ts`
- `apps/proxy/src/graphql/types/compression.ts`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`
- `pnpm --filter @prompt-proxy/web test` if UI fields change

Dependencies: RC-002, RC-003.

## RC-005: Add Provider-Specific Retrieval Tool Injection Spike

Goal: Decide whether automatic model retrieval should ship in V1 or wait.

Scope:

- Prototype `prompt_proxy_retrieve_compressed` tool shape for Anthropic Messages and OpenAI Responses.
- Verify tool-list stability across a session.
- Verify routing/translators preserve the injected tool.
- Verify common harnesses do not expose the internal tool call awkwardly to users.
- Document failure modes and recommended rollout.

Acceptance criteria:

- Spike doc says ship, defer, or reject for V1.
- If ship: follow-up implementation tickets are specific.
- If defer: retrieval endpoint/console remains the only V1 recovery path.

Likely files:

- `docs/scopes/reversible-compression-v1/PLAN.md`
- spike test fixtures under `apps/proxy/test/fixtures/*`

Validation:

- Harness fixture tests or manual smoke notes.

Dependencies: RC-003, RC-004.

## RC-006: Add Cache Window Measurement

Goal: Estimate provider cache hot zones per session from usage and request shape.

Scope:

- Track cache read/write tokens from `usage_ledger` by organization/workspace/session/provider/model/surface.
- Resolve a conservative `CompressionCacheWindow` before compression.
- Emit `compression.cache_window_resolved`.
- Do not change compression decisions yet.

Acceptance criteria:

- Sessions with no cache usage resolve `source: "none"`.
- Sessions with provider cache usage resolve a frozen prefix count conservatively.
- Cache-window events contain token counts and source, not raw content.

Likely files:

- `apps/proxy/src/persistence/usageNormalization.ts`
- `apps/proxy/src/persistence/sessionRoute.ts`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/src/server.ts`
- `apps/proxy/src/wsProxy.ts`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

## RC-007: Gate Compression With Cache Window

Goal: Skip mutating compression inside the estimated provider cache prefix.

Scope:

- Thread `frozenPrefixItems` into compression walkers.
- Skip eligible blocks in the frozen prefix.
- Record skip reason `cache_hot_zone` when `recordSkips` is enabled.
- Preserve existing behavior when no cache window is available.

Acceptance criteria:

- A frozen prior tool result is not rewritten.
- A live frontier tool result remains eligible.
- Measure-only shows cache-zone skips.
- Forwarded body hash/evidence reflects the final decision.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/src/server.ts`
- `apps/proxy/src/wsProxy.ts`
- `apps/proxy/test/toolResultCompression.test.ts`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-006.

## RC-008: Add JSON Array Compaction Rule In Measure-Only

Goal: Evaluate a higher-savings deterministic JSON-array rule without mutating requests.

Scope:

- Detect top-level arrays or object fields with uniform object arrays.
- Preserve raw numeric spelling and string content.
- Reject risky shapes: duplicate keys, nested non-uniform objects, very large cells, mixed primitive/object arrays.
- Record candidates with rule id/version and known risk metadata.
- Keep mutating behavior off.

Acceptance criteria:

- Linear/GitHub/Slack-style fixtures produce candidate receipts.
- Unsafe fixtures fall through to existing JSON whitespace rule.
- No mutating mode uses this rule yet.

Likely files:

- `apps/proxy/src/compressionRules/jsonCompaction.ts`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/fixtures/compression/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

## RC-009: Add Search And Log Compression Rules In Measure-Only

Goal: Evaluate deterministic compression for common coding-agent outputs.

Scope:

- Search result grouping by file/path.
- Log compression that preserves errors, warnings, tracebacks, and tail.
- Measure-only first.
- Add fixtures for `rg`, `pytest`, TypeScript build, package install, and generic shell logs.

Acceptance criteria:

- Rules record candidates and skip reasons.
- Error-bearing lines are preserved in fixtures.
- Token estimates are non-regressive.

Likely files:

- `apps/proxy/src/compressionRules/*`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/fixtures/compression/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

## RC-010: Promote Selected Lossless Rules To Mutating Mode

Goal: Enable proven deterministic lossless rules in `compress_lossless`.

Scope:

- Promote only rules with stable fixture wins and no known semantic loss.
- Ensure token-count and forward paths match.
- Add console warnings for rules still in measure-only/spike state.

Acceptance criteria:

- `compress_lossless` can apply the promoted rules.
- Receipts show applied status and provider saw compressed output.
- No protected-zone fixture changes outside eligible blocks.

Validation:

- `pnpm --filter @prompt-proxy/proxy test`
- `pnpm test` before shipping.

Dependencies: RC-008, RC-009.

## RC-011: Harden SSE Observers For Replay-Relevant Deltas

Goal: Capture enough streaming structure to support accurate audit and prompt replay.

Scope:

- Anthropic: handle thinking, signature, input JSON, citations, and error events.
- OpenAI Responses: track output item lifecycle, tool call deltas, reasoning summaries, terminal errors, and usage.
- Emit observer drift for unknown events.

Acceptance criteria:

- Existing usage parsing remains compatible.
- Fixtures with split UTF-8 and multi-frame deltas pass.
- Output text capture remains capped.
- Non-text delta metadata is available for prompt artifact capture where policy allows.

Likely files:

- `apps/proxy/src/sseObserver.ts`
- `apps/proxy/test/sseObserver.test.ts`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

## RC-012: Use Marker-Owned Harness Config Blocks In Setup Flows

Goal: Make setup edits safer by only replacing config blocks Prompt Proxy owns.

Scope:

- Add marker block conventions for Codex/opencode/Claude setup outputs where files are edited.
- Refuse to overwrite user-managed provider/MCP/auth blocks outside markers.
- Preserve symlink target behavior.
- Add backup/restore tests around setup script generation or local config editing helpers.

Acceptance criteria:

- Re-running setup updates Prompt Proxy-owned blocks idempotently.
- User-managed blocks with the same names are reported, not clobbered.
- Generated snippets document the marker behavior.

Likely files:

- `apps/proxy/src/setupScript.ts`
- `docs/harnesses/*.md`
- `apps/proxy/test/*setup*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`
