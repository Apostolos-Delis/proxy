# Tool Output Compression V1

## Goal

Add explicit, auditable tool-output compression for coding-agent sessions.

V1 starts with measurement. It detects compressible tool results, estimates savings, and records evidence without changing provider requests. Later phases can enable safe compression per routing config.

## Why This Matters

9router and OmniRoute both show that tool-heavy coding sessions waste many tokens on repetitive shell output, logs, diffs, and directory listings. Prompt Proxy sits in the only place that can observe these tokens across harnesses and providers.

The risk is hidden prompt mutation. Compression must be opt-in, explainable, and reversible through artifacts where policy allows.

## Current State

Prompt Proxy has future docs for token cost reduction and tool-result compression ideas. It also has prompt artifact boundaries and usage/cost accounting.

Missing:

- route-config compression mode
- shared tool-result detector across dialects
- compression receipts
- savings projections
- replay/golden tests
- console visibility

## Modes

```text
disabled
measure_only
compress_safe_tool_outputs
```

Default is `disabled`.

`measure_only` records what would have happened without modifying the request.

`compress_safe_tool_outputs` modifies only recognized tool-result content and records a compression receipt.

## Eligible Content

V1 should only consider tool results or equivalent harness output blocks:

- Claude tool result blocks
- OpenAI tool role messages
- OpenAI Responses function call outputs
- coding harness shell output wrappers where profile detection is confident

Do not compress:

- user-authored prompt text
- assistant reasoning
- instructions/system messages
- small outputs
- outputs marked as errors unless a filter explicitly supports them
- binary/base64 content
- content with low confidence detection

## Initial Filters

Start with deterministic filters:

- git diff truncation with file summary
- git status normalization
- grep/rg result compaction
- directory listing compaction
- repeated log line deduplication
- stack trace tail preservation
- generic long-output head/tail truncation

Each filter must guarantee:

- output is not larger than input
- output preserves command identity when known
- output preserves error indicator when present
- output includes truncation marker
- output has deterministic behavior

## Route Config Shape

```json
{
  "compression": {
    "mode": "measure_only",
    "maxOriginalBytes": 200000,
    "minSavingsTokens": 1000,
    "filters": ["git_diff", "grep", "logs", "generic_head_tail"],
    "storeOriginalArtifact": true
  }
}
```

`storeOriginalArtifact` is bounded by prompt capture settings. It cannot override an org policy that disables raw prompt storage.

## Compression Receipt

Record one receipt per compressed block or measured candidate:

```ts
type CompressionReceipt = {
  requestId: string;
  promptArtifactId: string | null;
  mode: "measure_only" | "compressed";
  dialect: string;
  blockPath: string;
  filterId: string;
  originalBytes: number;
  compressedBytes: number;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  savingsTokenEstimate: number;
  originalSha256: string;
  compressedSha256: string;
  originalArtifactId: string | null;
  compressedArtifactId: string | null;
};
```

## Data Model

Add `compression_receipts`:

```text
id text primary key
organization_id text not null
workspace_id text not null
request_id text not null
api_key_id text
mode text not null
dialect text not null
filter_id text not null
block_path text not null
original_bytes integer not null
compressed_bytes integer not null
original_token_estimate integer not null
compressed_token_estimate integer not null
savings_token_estimate integer not null
original_sha256 text not null
compressed_sha256 text not null
original_artifact_id text
compressed_artifact_id text
created_at timestamptz not null

index (organization_id, workspace_id, created_at)
index (request_id)
```

## Runtime Flow

Measure-only:

```text
request parsed
  -> route config compression mode = measure_only
  -> detect tool-result blocks
  -> run candidate filters on copies
  -> record receipts
  -> send original request unchanged
```

Compression:

```text
request parsed
  -> route config compression mode = compress_safe_tool_outputs
  -> detect eligible blocks
  -> compress blocks
  -> write receipts and artifacts
  -> send compressed request
  -> route plan records compression action
```

Compression happens before provider send but after prompt capture policy decides how to store artifacts.

## Events

Add:

```text
compression.measured
compression.applied
compression.skipped
compression.failed
```

Reasons:

```text
compression_skipped_disabled
compression_skipped_no_eligible_blocks
compression_skipped_low_savings
compression_skipped_output_would_grow
compression_skipped_prompt_capture_policy
compression_failed_filter_error
```

## Console

Add compression analytics:

- estimated token savings
- actual cost savings estimate
- filters used
- measure-only candidates
- compression applied rate
- top API keys by avoidable tool-output tokens
- request detail receipts

Request detail should show before/after byte and token estimates, with artifact links when allowed.

## Test Harness

Create a replay harness:

```text
input fixture
  -> detected blocks
  -> filter output
  -> golden compressed output
  -> savings estimate
  -> no-growth assertion
```

Fixtures:

- large git diff
- pytest failure
- TypeScript build output
- rg output
- long JSON log
- directory tree
- mixed normal text and tool result

## Validation

Unit tests:

- dialect block detection
- each filter deterministic output
- no-growth guarantee
- measure-only does not mutate request
- compression updates only eligible block
- receipt hashes match output

Integration tests:

- compressed request reaches provider mock
- measure-only request remains byte-equivalent
- receipts are persisted
- prompt artifact policy is respected

## Rollout

1. Add measure-only detector and receipts.
2. Add dashboard analytics for candidates.
3. Add deterministic filters and golden tests.
4. Enable compression for one internal test routing config.
5. Add per-key or per-workspace opt-in.

## Non-Goals

- No general prompt rewriting.
- No assistant response compression.
- No model-based summarization in V1.
- No compression of uncertain harness blocks.
- No raw original artifact retention when org policy forbids it.

## Acceptance Criteria

- Measure-only mode can estimate savings without mutating requests.
- Compression receipts are durable and request-scoped.
- Safe compression only touches detected tool-result blocks.
- Every applied compression is visible in route plans and console.
