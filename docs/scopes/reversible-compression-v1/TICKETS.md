# Reversible Compression V1 Tickets

Use these as issue-tracker tickets. They are intentionally ordered so safety and evidence land before new mutating compression behavior.

## Milestones

- **M0: Safety Baseline** - prove compression cannot touch protected prompt/cache zones.
- **M1: Retrieval Foundation** - make stored originals recoverable through scoped server APIs.
- **M2: Marker Rollout** - let compressed blocks advertise recoverability without exposing internal ids.
- **M3: Cache-Aware Gating** - skip compression inside provider cache hot zones.
- **M4: Rule Expansion** - measure higher-savings deterministic rules before enabling them.
- **M5: Product Surfaces** - expose the work in console, model tools, streams, and harness setup.

## Backlog

| ID | Title | Milestone | Size | Depends | Runtime behavior |
| --- | --- | --- | --- | --- | --- |
| RC-001 | Add compression protected-zone fixture helpers | M0 | M | - | None |
| RC-002 | Enforce measure-only and failure forwarding invariants | M0 | S | RC-001 | None |
| RC-003 | Add opaque compression retrieval ids | M1 | M | - | None |
| RC-004 | Implement compression retrieval resolver | M1 | M | RC-003 | Internal only |
| RC-005 | Add API-key authenticated retrieval endpoint | M1 | M | RC-004 | New endpoint |
| RC-006 | Emit retrieval audit and events | M1 | S | RC-005 | New events |
| RC-007 | Record retrieval marker metadata in measure-only | M2 | M | RC-003, RC-004 | Evidence only |
| RC-008 | Emit retrieval markers in mutating compression | M2 | M | RC-005, RC-007 | Opt-in compression only |
| RC-009 | Add console retrieval and marker surfaces | M2 | M | RC-006, RC-007 | Console only |
| RC-010 | Resolve provider cache windows from usage evidence | M3 | M | RC-001 | Evidence only |
| RC-011 | Gate compression walkers with frozen prefixes | M3 | M | RC-010 | Opt-in compression only |
| RC-012 | Surface cache-hot-zone skip evidence | M3 | S | RC-011 | Evidence only |
| RC-013 | Add JSON array compaction in measure-only | M4 | M | RC-001 | Evidence only |
| RC-014 | Add search result grouping in measure-only | M4 | M | RC-001 | Evidence only |
| RC-015 | Add log output compression in measure-only | M4 | M | RC-001 | Evidence only |
| RC-016 | Add diff compaction in measure-only | M4 | M | RC-001 | Evidence only |
| RC-017 | Promote proven lossless rules to mutating mode | M4 | L | RC-013, RC-014, RC-015, RC-016 | Opt-in compression only |
| RC-018 | Spike provider-specific retrieval tool injection | M5 | S | RC-008 | Spike only |
| RC-019 | Harden SSE observers for replay-relevant deltas | M5 | M | - | Evidence quality |
| RC-020 | Use marker-owned blocks in harness setup edits | M5 | M | - | Setup flow only |

## RC-001: Add Compression Protected-Zone Fixture Helpers

Labels: `area:proxy`, `area:compression`, `type:test`

Goal: Make the cache-safe compression contract executable.

Scope:

- Add fixture helpers that compare original and forwarded bodies by protected zones.
- Cover Anthropic Messages, OpenAI Chat, and OpenAI Responses request shapes.
- Protect system/instructions, tools/tool schemas, user-authored text, reasoning/thinking/signatures, encrypted/redacted blocks, ids, metadata, and frozen prefix messages/items.
- Provide a helper future rule tests can call without duplicating assertions.

Acceptance criteria:

- Fixtures fail if a test rule mutates protected zones.
- Fixtures pass for current compression behavior.
- The helper accepts a `frozenPrefixItems` input for cache hot-zone tests.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/toolResultCompression.test.ts`
- `apps/proxy/test/fixtures/compression/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

## RC-002: Enforce Measure-Only And Failure Forwarding Invariants

Labels: `area:proxy`, `area:compression`, `type:test`

Goal: Prove observability failures cannot change forwarded provider bytes.

Scope:

- Add tests that `measure_only` always forwards the original body.
- Add tests for artifact/event persistence failures in mutating mode.
- Assert token-count and forward paths make identical mutating decisions.
- Assert token-growing or unmeasurable rules are skipped.

Acceptance criteria:

- Simulated event write failure does not alter forwarded bytes.
- Simulated artifact write failure disables retrieval markers and does not claim recoverability.
- Token counting and forwarding produce matching receipt decisions.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/toolResultCompression.test.ts`
- `apps/proxy/test/proxy.test.ts`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-001.

## RC-003: Add Opaque Compression Retrieval Ids

Labels: `area:db`, `area:compression`, `type:schema`

Goal: Give compressed blocks a model-safe id that can resolve back to a receipt without exposing receipt, event, or prompt artifact ids.

Scope:

- Add a durable `retrieval_id` field to compression receipts.
- Ensure retrieval ids are opaque, stable, unique within the deployment, and safe to show in prompts.
- Index retrieval lookup by organization/workspace and retrieval id.
- Backfill is not required; retrieval ids apply to new receipts only.

Acceptance criteria:

- New compression receipts store a `cmp_...` retrieval id.
- Retrieval ids do not contain receipt ids, event ids, request ids, workspace ids, or artifact ids.
- Duplicate retrieval ids are rejected or impossible by construction.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*`
- `apps/proxy/src/persistence/compressionReceipts.ts`
- `apps/proxy/test/*`

Validation:

- `pnpm --filter @prompt-proxy/db test`
- `pnpm --filter @prompt-proxy/proxy test`

## RC-004: Implement Compression Retrieval Resolver

Labels: `area:proxy`, `area:persistence`, `area:compression`

Goal: Resolve an opaque retrieval id to original content under org/workspace policy.

Scope:

- Resolve retrieval id by organization/workspace/api-key context.
- Validate receipt, original artifact id, artifact storage mode, expiry, and content hash.
- Return structured metadata plus original content.
- Return typed failures for missing, expired, hash-only, or unauthorized artifacts without leaking cross-tenant existence.

Acceptance criteria:

- Same-workspace valid retrieval id returns original content.
- Cross-workspace and cross-org retrieval ids return not found/forbidden without distinguishing existence.
- Expired or hash-only artifacts fail with typed errors and no raw content.

Likely files:

- `apps/proxy/src/persistence/compressionReceipts.ts`
- `apps/proxy/src/persistence/promptArtifacts.ts`
- `apps/proxy/test/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-003.

## RC-005: Add API-Key Authenticated Retrieval Endpoint

Labels: `area:proxy`, `area:api`, `area:compression`

Goal: Expose retrieval through the proxy API.

Scope:

- Add `POST /v1/compression/retrieve`.
- Authenticate like provider requests.
- Resolve organization, workspace, user, and API key.
- Accept `{ "retrievalId": "cmp_...", "query": "optional search terms" }`.
- Support full retrieval first; reject `query` or return a clear `queryApplied: false` field until search exists.

Acceptance criteria:

- Authorized raw-text artifact retrieval returns original content and metadata.
- Missing, expired, unauthorized, or unavailable artifacts return stable errors.
- The endpoint never accepts receipt ids, event ids, or artifact ids from model-facing callers.

Likely files:

- `apps/proxy/src/server.ts`
- `apps/proxy/src/auth.ts`
- `apps/proxy/src/persistence/compressionReceipts.ts`
- `apps/proxy/test/proxy.test.ts`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-004.

## RC-006: Emit Retrieval Audit And Events

Labels: `area:events`, `area:audit`, `area:compression`

Goal: Make retrieval observable without placing raw tool output in event payloads.

Scope:

- Append `prompt_access_audit` records for successful retrievals.
- Emit `compression.retrieved` and `compression.retrieval_failed`.
- Include retrieval id, receipt id, request id, tool name, status, and failure reason.
- Exclude raw content, prompt text, and compressed/original snippets from events.

Acceptance criteria:

- Successful retrieval writes prompt access audit and a retrieved event.
- Failed retrieval writes a failure event when a tenant-safe id can be associated.
- Tests assert event payloads do not contain raw original content.

Likely files:

- `apps/proxy/src/events.ts`
- `apps/proxy/src/persistence/promptAccessAudit.ts`
- `apps/proxy/src/persistence/compressionReceipts.ts`
- `apps/proxy/test/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-005.

## RC-007: Record Retrieval Marker Metadata In Measure-Only

Labels: `area:proxy`, `area:compression`, `type:observability`

Goal: Preview marker behavior before mutating provider requests.

Scope:

- Extend compression records with `retrievalAvailable`, `retrievalId`, and marker text metadata.
- In `measure_only`, compute the marker that would be emitted when artifact policy allows retrieval.
- Keep forwarded request bytes unchanged.
- Keep model-facing marker text free of raw content and internal ids.

Acceptance criteria:

- Measure-only receipts show marker availability for stored original artifacts.
- Measure-only receipts do not show retrieval availability when original storage is disabled or fails.
- Forwarded body hash equals original body hash.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/src/compressionPreview.ts`
- `apps/proxy/src/persistence/compressionReceipts.ts`
- `apps/proxy/test/toolResultCompression.test.ts`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-003, RC-004.

## RC-008: Emit Retrieval Markers In Mutating Compression

Labels: `area:proxy`, `area:compression`

Goal: Let compressed blocks advertise recoverable originals when policy allows.

Scope:

- Emit `[prompt-proxy:compressed id=cmp_... sha256=...]` in eligible compressed blocks.
- Add the marker only after original artifact storage succeeds.
- Do not add custom provider-owned fields.
- Choose provider-safe placement for Anthropic Messages, OpenAI Chat, and OpenAI Responses.

Acceptance criteria:

- `compress_lossless` with stored originals emits markers.
- Compression without stored originals never claims retrieval availability.
- Marker placement preserves valid provider request shapes for all supported surfaces.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/toolResultCompression.test.ts`
- `apps/proxy/test/fixtures/compression/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-005, RC-007.

## RC-009: Add Console Retrieval And Marker Surfaces

Labels: `area:web`, `area:graphql`, `area:compression`

Goal: Let operators inspect retrieval state, markers, and failures.

Scope:

- Add GraphQL/API fields for retrieval availability, retrieval id, marker text, artifact expiry, and failure reasons.
- Show marker availability in compression preview and request detail.
- Add an authenticated console action to retrieve original content when policy allows.
- Show retrieval events in the prompt event timeline.

Acceptance criteria:

- Request detail shows whether provider saw compressed output and whether original retrieval is available.
- Retrieval failures show typed reasons without leaking raw content.
- JSON/raw content display uses existing syntax-highlighted artifact components.

Likely files:

- `apps/proxy/src/graphql/types/compression.ts`
- `apps/web/src/compressionPreviewPanel.tsx`
- `apps/web/src/promptEventTimeline.tsx`
- `apps/web/src/promptDetailPage.tsx`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`
- `pnpm --filter @prompt-proxy/web test`

Dependencies: RC-006, RC-007.

## RC-010: Resolve Provider Cache Windows From Usage Evidence

Labels: `area:proxy`, `area:caching`, `area:compression`

Goal: Estimate provider cache hot zones before compression decisions.

Scope:

- Read cache read/write token evidence from `usage_ledger`.
- Resolve `CompressionCacheWindow` by organization/workspace/session/provider/model/surface.
- Return `source: "none"` when evidence is insufficient.
- Emit `compression.cache_window_resolved` without changing compression behavior.

Acceptance criteria:

- Sessions with no cache evidence resolve no frozen prefix.
- Sessions with cache evidence resolve a conservative whole-item frozen prefix.
- Events include token counts and source, not raw content.

Likely files:

- `apps/proxy/src/persistence/usageNormalization.ts`
- `apps/proxy/src/persistence/sessionRoute.ts`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/src/server.ts`
- `apps/proxy/src/wsProxy.ts`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-001.

## RC-011: Gate Compression Walkers With Frozen Prefixes

Labels: `area:proxy`, `area:caching`, `area:compression`

Goal: Prevent compression from mutating content likely to be inside provider cache.

Scope:

- Thread `frozenPrefixItems` into Anthropic, OpenAI Chat, and OpenAI Responses walkers.
- Skip eligible blocks inside the frozen prefix.
- Keep live frontier blocks eligible.
- Preserve existing behavior when cache window source is `none`.

Acceptance criteria:

- Frozen prior tool results are not rewritten.
- Live frontier tool results remain eligible.
- Forwarded body evidence reflects the final skip/apply decision.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/src/server.ts`
- `apps/proxy/src/wsProxy.ts`
- `apps/proxy/test/toolResultCompression.test.ts`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-010.

## RC-012: Surface Cache-Hot-Zone Skip Evidence

Labels: `area:proxy`, `area:web`, `area:compression`

Goal: Make cache-preservation skips explainable.

Scope:

- Record skip reason `cache_hot_zone` when `recordSkips` is enabled.
- Surface cache-zone skips in compression preview and request detail.
- Add analytics-ready fields for skipped bytes/tokens.

Acceptance criteria:

- Measure-only shows cache-zone skip receipts.
- Operators can distinguish cache-preservation skips from threshold/rule skips.
- No raw prompt/tool output is added to events.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/src/graphql/types/compression.ts`
- `apps/web/src/compressionPreviewPanel.tsx`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`
- `pnpm --filter @prompt-proxy/web test`

Dependencies: RC-011.

## RC-013: Add JSON Array Compaction In Measure-Only

Labels: `area:proxy`, `area:compression`, `type:rule`

Goal: Evaluate a higher-savings deterministic JSON-array rule without mutating requests.

Scope:

- Detect top-level arrays and object fields with uniform object arrays.
- Preserve raw numeric spelling and string content.
- Reject duplicate keys, nested non-uniform objects, very large cells, and mixed primitive/object arrays.
- Record candidates with rule id, version, savings, and known risk metadata.

Acceptance criteria:

- Linear/GitHub/Slack-style fixtures produce candidate receipts.
- Unsafe fixtures fall through to existing JSON whitespace behavior.
- No mutating mode uses this rule yet.

Likely files:

- `apps/proxy/src/compressionRules/jsonCompaction.ts`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/fixtures/compression/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-001.

## RC-014: Add Search Result Grouping In Measure-Only

Labels: `area:proxy`, `area:compression`, `type:rule`

Goal: Measure deterministic compression for common search outputs.

Scope:

- Group repeated search hits by file/path.
- Preserve line numbers, match text, file paths, and ordering needed for code navigation.
- Add fixtures for `rg`, repository search, GitHub search-like output, and empty/no-match output.
- Keep mutating behavior off.

Acceptance criteria:

- Candidate receipts show estimated savings for repeated file/path groups.
- No-match and malformed outputs are skipped safely.
- Rule preserves error text from failed search commands.

Likely files:

- `apps/proxy/src/compressionRules/searchResults.ts`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/fixtures/compression/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-001.

## RC-015: Add Log Output Compression In Measure-Only

Labels: `area:proxy`, `area:compression`, `type:rule`

Goal: Measure deterministic compression for shell/build/test logs.

Scope:

- Preserve errors, warnings, tracebacks, command exits, and tail output.
- Collapse repeated progress/noise lines.
- Add fixtures for `pytest`, `vitest`, `tsc`, package install logs, and generic shell output.
- Keep mutating behavior off.

Acceptance criteria:

- Error-bearing lines are preserved exactly in fixtures.
- Repeated noise produces candidate savings.
- Token estimates are non-regressive.

Likely files:

- `apps/proxy/src/compressionRules/logOutput.ts`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/fixtures/compression/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-001.

## RC-016: Add Diff Compaction In Measure-Only

Labels: `area:proxy`, `area:compression`, `type:rule`

Goal: Measure deterministic compression for large diffs while preserving review-relevant signals.

Scope:

- Preserve file names, hunk headers, added/deleted counts, conflict markers, and error signals.
- Collapse unchanged or repeated hunk body regions only when safe.
- Add fixtures for git diffs, package lock diffs, generated files, and conflict diffs.
- Keep mutating behavior off.

Acceptance criteria:

- Generated/huge diff fixtures produce candidate savings.
- Conflict and error signals are preserved.
- Unsafe or ambiguous diffs are skipped.

Likely files:

- `apps/proxy/src/compressionRules/diffCompaction.ts`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/fixtures/compression/*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

Dependencies: RC-001.

## RC-017: Promote Proven Lossless Rules To Mutating Mode

Labels: `area:proxy`, `area:compression`, `type:rollout`

Goal: Enable only proven deterministic lossless rules in `compress_lossless`.

Scope:

- Review measure-only evidence for JSON array, search, log, and diff rules.
- Promote only rules with stable fixture wins and no semantic-loss risk.
- Keep lossy rules behind `compress_explicit_lossy` and retrieval availability.
- Add console warnings for rules still in measure-only/spike state.

Acceptance criteria:

- Promoted rules apply in `compress_lossless`.
- Receipts show applied status, saved tokens, and provider-saw-compressed evidence.
- Protected-zone fixtures confirm no mutations outside eligible blocks.
- Full test suite passes before shipping.

Likely files:

- `apps/proxy/src/compressionRules/*`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/web/src/compressionPreviewPanel.tsx`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`
- `pnpm test`

Dependencies: RC-013, RC-014, RC-015, RC-016.

## RC-018: Spike Provider-Specific Retrieval Tool Injection

Labels: `area:proxy`, `area:providers`, `type:spike`

Goal: Decide whether automatic model retrieval should ship in V1 or wait.

Scope:

- Prototype `prompt_proxy_retrieve_compressed` for Anthropic Messages and OpenAI Responses.
- Verify tool-list stability across a session.
- Verify translators and harnesses preserve the injected tool.
- Document UX failure modes when the model calls the internal tool.
- Decide ship, defer, or reject for V1.

Acceptance criteria:

- Spike doc names the decision and reason.
- If shipping, follow-up implementation tickets define exact provider behavior.
- If deferring, endpoint and console retrieval remain the V1 recovery path.

Likely files:

- `docs/scopes/reversible-compression-v1/PLAN.md`
- `docs/scopes/reversible-compression-v1/TICKETS.md`
- `apps/proxy/test/fixtures/*`

Validation:

- Harness fixture tests or manual smoke notes.

Dependencies: RC-008.

## RC-019: Harden SSE Observers For Replay-Relevant Deltas

Labels: `area:proxy`, `area:streams`, `area:observability`

Goal: Capture enough streaming structure for accurate audit and prompt replay.

Scope:

- Anthropic: track thinking, signature, input JSON, citations, block index, and error events.
- OpenAI Responses: track output item lifecycle, tool call deltas, reasoning summaries, terminal errors, and usage.
- Emit observer drift for unknown event types.
- Keep text capture caps intact.

Acceptance criteria:

- Existing usage parsing remains compatible.
- Fixtures with split UTF-8 and multi-frame deltas pass.
- Non-text delta metadata is available for artifact capture when policy allows.
- Unknown event types are recorded as drift, not silently ignored.

Likely files:

- `apps/proxy/src/sseObserver.ts`
- `apps/proxy/test/sseObserver.test.ts`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`

## RC-020: Use Marker-Owned Blocks In Harness Setup Edits

Labels: `area:harnesses`, `area:setup`, `type:safety`

Goal: Make setup edits safe by only replacing config blocks Prompt Proxy owns.

Scope:

- Add marker block conventions for Codex, opencode, and Claude setup output where files are edited.
- Refuse to overwrite user-managed provider/MCP/auth blocks outside markers.
- Preserve symlink target behavior.
- Add backup/restore or idempotency tests around local config editing helpers.

Acceptance criteria:

- Re-running setup updates Prompt Proxy-owned blocks idempotently.
- User-managed blocks with the same names are reported, not clobbered.
- Generated snippets document marker behavior.

Likely files:

- `apps/proxy/src/setupScript.ts`
- `docs/harnesses/*.md`
- `apps/proxy/test/*setup*`

Validation:

- `pnpm --filter @prompt-proxy/proxy test`
