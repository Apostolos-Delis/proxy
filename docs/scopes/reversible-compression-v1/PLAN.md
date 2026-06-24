# Reversible Compression V1

## Goal

Turn the current deterministic tool-result compression implementation into a cache-safe, reversible product surface.

This scope is inspired by the Headroom analysis in `.context/headroom-analysis.md`, but it is not a Headroom integration. Proxy should keep compression inside its existing TypeScript, multi-tenant, event-backed architecture.

V1 adds three missing properties to the current system:

1. **Recoverability:** compressed-away content can be retrieved through a scoped API/tool when policy allows original artifact storage.
2. **Cache safety:** compression never mutates the provider cache hot zone or previously cached history.
3. **Explainability:** operators can see what was eligible, what was changed, why it was skipped, and whether the provider actually saw compressed content.

## Current State

Proxy already has the right foundation:

- `apps/proxy/src/toolResultCompression.ts` walks Anthropic Messages, OpenAI Chat, and OpenAI Responses tool-result shapes.
- Compression is deterministic and rule-versioned.
- Policies support `disabled`, `measure_only`, `compress_lossless`, and `compress_explicit_lossy`.
- `prompt_artifacts` can store original and compressed tool-result artifacts.
- `compression_receipts` persist block-level evidence with hashes, byte counts, token estimates, status, rule, tool, and artifact ids.
- Request forwarding records original/compressed/forwarded body hashes and whether the provider saw compressed tool output.
- The console already has compression preview and receipt surfaces.

What is missing:

- A retrieval marker format and retrieval API/tool backed by compression receipts and prompt artifacts.
- A formal cache-hot-zone contract and tests.
- A session-level cache window that uses provider cache read/write usage to decide when not to compress.
- Higher-savings deterministic rules beyond JSON whitespace, shell terminal-noise stripping, and duplicate references.
- Richer provider stream observers for faithful replay/audit of non-text deltas.
- Marker-owned harness setup edits for config files written by setup flows.

## Product Shape

V1 keeps compression opt-in through routing config policy.

```json
{
  "toolResultCompression": {
    "mode": "measure_only",
    "minOriginalBytes": 512,
    "minSavingsTokens": 0,
    "enabledRules": ["mcp-json-whitespace", "json-whitespace", "bash-output-noise"],
    "storeOriginalArtifact": false,
    "storeCompressedArtifact": false,
    "retrieval": {
      "enabled": false,
      "markerStyle": "compact"
    },
    "cacheSafety": {
      "mode": "preserve_hot_zone"
    }
  }
}
```

The exact schema can be additive to the existing `compressionPolicySchema`; old policies remain a hard-cutover target once this ships.

Modes:

- `disabled`: no compression or retrieval marker work.
- `measure_only`: record candidates/skips and retrieval availability, forward original body.
- `compress_lossless`: mutate only lossless rules, optionally emit retrieval markers when the original artifact exists.
- `compress_explicit_lossy`: allow lossy rules only when explicitly enabled and reversible retrieval is available for the block.

## Non-Goals

- Do not vendor Headroom or call a Headroom sidecar.
- Do not introduce Python, Rust, PyO3, ML compression, Kompress, or ONNX dependencies.
- Do not mutate user-authored messages, system prompts, tool schemas, assistant reasoning, encrypted/signed thinking, or prior cached history.
- Do not store raw prompt/tool content when org prompt-capture policy forbids it.
- Do not add LLM summarization in the request hot path.
- Do not expand provider route surface as part of this scope.

## Cache-Safety Contract

Compression may only touch recognized tool-result/live-output blocks at the live frontier of the request.

Never mutate:

- System prompts or org-injected system prompt bytes.
- Tool definitions or schema metadata.
- User-authored prompt text.
- Assistant reasoning, thinking, redacted thinking, signatures, or encrypted content.
- Historical messages/items that are inside a provider cache prefix.
- `cache_control`, call ids, tool ids, item ids, provider metadata, or sibling fields around a rewritten block.

Required invariants:

- Same input body, policy, rule versions, and cache window produce the same forwarded body.
- Measure-only mode forwards the original body.
- Mutating mode rewrites only eligible block payload fields.
- A rule that grows tokens or lacks a reliable token estimate is skipped.
- Event or artifact write failure never changes forwarded bytes.
- Token-count and forward paths use identical mutating decisions.

## Retrieval Design

Retrieval uses existing durable state instead of a new store.

### Marker

When a block is compressed and `storeOriginalArtifact` is true, the replacement includes a compact marker:

```text
[prompt:compressed id=cmp_... sha256=...]
```

For structured outputs, the marker should be a sibling text block or a suffix in the rewritten tool-result content, depending on provider shape. It must not add custom fields to provider-owned objects.

Marker requirements:

- Contains an opaque retrieval id, not raw content, event ids, receipt ids, or prompt artifact ids.
- Includes enough metadata for the model/operator to understand that original content exists.
- Is stable for the durable receipt it references.
- Does not reveal cross-org identifiers outside the request context.

### Retrieval Endpoint

Add an API-key authenticated endpoint:

```text
POST /v1/compression/retrieve
```

Request:

```json
{
  "retrievalId": "cmp_...",
  "query": "optional search terms"
}
```

Response:

```json
{
  "retrievalId": "cmp_...",
  "receiptId": "cr_...",
  "toolName": "mcp__linear__list_issues",
  "blockPath": "input.4",
  "originalContent": "...",
  "contentHash": "sha256:...",
  "retrievalMode": "full"
}
```

Access checks:

- API key resolves organization/workspace.
- Retrieval id must resolve to a receipt in the caller's organization/workspace.
- Original artifact id must exist and storage mode must be `raw_text`.
- Artifact must not be expired.
- Optional session/request scoping should prevent unrelated same-workspace sessions from retrieving each other's artifacts unless an admin policy explicitly allows it.
- Retrieval appends `prompt_access_audit` and `compression.retrieved` events.

### Retrieval Tool

When the target surface supports tools and compression markers are present, inject a provider-specific retrieval tool:

- Anthropic: `tools[]` entry with `input_schema`.
- OpenAI Chat/Responses: function tool.

Tool name:

```text
proxy_retrieve_compressed
```

Inputs:

```json
{
  "retrievalId": "string",
  "query": "optional string"
}
```

Tool injection must be sticky within a session once enabled, otherwise tool-list bytes can flip on/off and bust prompt cache. If sticky injection is too risky for V1, only expose the HTTP endpoint and leave automatic tool handling for V1.1.

## Cache-Aware Compression

Add a session-level compression gate that uses provider usage to estimate cache state.

Inputs:

- `usage_ledger` cache read/write tokens.
- Request surface/provider/model/session id.
- Current request message/item shape.
- Existing prompt artifact/session identity.

Output:

```ts
type CompressionCacheWindow = {
  frozenPrefixItems: number;
  cachedInputTokens: number;
  source: "provider_usage" | "none";
};
```

Runtime:

1. Resolve compression policy.
2. Resolve session cache window before running mutating rules.
3. Pass `frozenPrefixItems` to body walkers.
4. Body walkers skip all blocks inside the frozen prefix.
5. Receipts record `skipReason: "cache_hot_zone"` for eligible skipped blocks in measure-only/debug modes.

V1 should start conservative:

- Only freeze whole messages/items, not byte ranges.
- If the cache window cannot be estimated confidently, freeze nothing.
- Do not compress prior messages in `cacheSafety.mode = "preserve_hot_zone"`.
- `token_max` mode can remain a future explicit opt-in.

## Rule Catalog Expansion

Rule additions should be deterministic, rule-versioned, previewable, and covered by golden fixtures.

Priority:

1. JSON array compaction for uniform arrays.
2. Search result grouping by file/path.
3. Log compression preserving errors, warnings, tracebacks, and tail output.
4. Diff compaction preserving file names, hunks, additions/deletions, and conflict/error signals.

Rules must expose:

- Rule id and version.
- Lossless/lossy classification.
- Eligibility predicate.
- Known risks.
- Minimum bytes/tokens.
- Token-estimate source.
- Fallback behavior.

Lossy rules require both:

- `mode = "compress_explicit_lossy"`.
- A retrievable original artifact for the block.

The JSON array, search-result, log-output, and diff-compaction M4 rules remain measurement-only for V1 until quality telemetry proves a mutating rollout is safe. `compress_lossless` continues to apply only deterministic lossless rules.

Provider-specific automatic retrieval tool injection is deferred for V1; see [Retrieval Tool Injection Spike](./RETRIEVAL_TOOL_INJECTION_SPIKE.md). Endpoint and console retrieval remain the recovery path.

## Stream Observer Hardening

The compression scope depends on accurate evidence and prompt replay. Upgrade stream observers separately but in the same roadmap.

Anthropic observer should track:

- `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `error`.
- `text_delta`, `thinking_delta`, `input_json_delta`, `signature_delta`, and `citations_delta`.
- Block index, not just array position.

OpenAI Responses observer should track:

- Output item lifecycle.
- Text deltas.
- Tool call deltas.
- Reasoning summaries where exposed.
- Terminal errors and usage.

Unknown event types should be recorded as wire-format drift, not silently ignored.

## Console

Add/extend console surfaces:

- Routing config editor:
  - retrieval enabled flag
  - cache-safety mode
  - lossy rule warning
  - rule catalog and known risks
- Request detail:
  - retrieval marker/receipt id
  - original artifact availability and expiry
  - cache-hot-zone skip reason
  - provider saw compressed output
  - retrieval events
- Analytics:
  - top rules by saved tokens
  - top tools by avoidable tokens
  - retrieval rate by rule/tool
  - cache-preservation skips
  - lossy compression quality watchlist

## Events

Reuse existing events where possible:

- `compression.measurement_recorded`
- `compression.recorded`
- `routing.compression_evidence_recorded`

Add:

```text
compression.retrieval_marker_recorded
compression.retrieved
compression.retrieval_failed
compression.cache_window_resolved
```

Event payloads must not include raw tool output.

## Data Model

No new primary table is required for V1.

Use:

- `compression_receipts` for block metadata and artifact ids.
- `prompt_artifacts` for original/compressed raw text when policy allows.
- `prompt_access_audit` for retrieval reads.
- `events` for retrieval and cache-window events.

Potential additive changes:

- `compression_receipts.retrieval_id text unique`
- `compression_receipts.retrieval_enabled boolean`
- `compression_receipts.retrieval_marker text`
- `compression_receipts.cache_zone text`
- `compression_receipts.cache_skip_reason text`

Prefer event payloads first if the console can query current data efficiently without schema churn.

## Rollout

1. Ship invariants and fixture tests with no runtime behavior change.
2. Add retrieval endpoint for existing receipts/artifacts, hidden behind config.
3. Emit retrieval markers in measure-only preview, not forwarded requests.
4. Enable retrieval markers for internal `compress_lossless` routing configs.
5. Add cache-window measurement and skip receipts.
6. Add new deterministic rules in measure-only.
7. Promote selected rules to `compress_lossless`.
8. Consider `compress_explicit_lossy` only after retrieval success rate and quality telemetry are visible.

## Success Metrics

- Compression saved estimated tokens per request/session/workspace.
- Provider saw compressed output rate.
- Retrieval success/failure rate.
- Retrieval rate by rule/tool.
- Cache-hot-zone skips and estimated cache tokens preserved.
- Provider cache hit rate before/after.
- Request failure/retry/follow-up tool-call rate for compressed sessions.
- Admin/operator adoption by routing config.

## Open Questions

- Should retrieval be available to the model automatically in V1, or only through an authenticated endpoint and console action?
- How strict should session scoping be for retrieval: same request, same session, or same workspace?
- Should the API accept `receiptId` for admin-only console retrieval, or should all retrieval use opaque retrieval ids?
- Should `storeOriginalArtifact` become required for `compress_explicit_lossy` at schema-validation time?
- Should cache-window state live in a projection, an in-memory session tracker, or both?
