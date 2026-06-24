# Tool Output Compression Tickets

These tickets start from the current implementation, not a greenfield plan. Proxy already compresses large tool-result blocks with deterministic JSON whitespace compaction, shell terminal-noise stripping, duplicate references, `compression.recorded` events, analytics, and tests.

The remaining work is to turn that implementation into an explicit, auditable product surface and to safely evaluate higher-savings rules from 9router and OmniRoute.

## Delivery Rules

- Default behavior stays no hidden mutation.
- Same input, static config, and rule version must produce identical forwarded bytes.
- `measure_only` must never change the provider request.
- Compression must only touch recognized tool-result blocks or equivalent harness output blocks.
- No raw tool output goes into event payloads.
- Original/compressed artifacts are stored only when prompt-capture policy allows it.
- Compression must preserve `cache_control`, tool IDs, call IDs, and other harness state fields.
- Token-count endpoints and forward paths must use identical compression decisions for mutating modes.
- Representation-changing rules must be gated by token savings, not character savings alone.
- Lossy filters require explicit opt-in and quality telemetry.

## TOC-001: Replace Boolean Compression Settings With A Policy Contract

Goal: Replace the current org-level boolean with a typed compression policy that can express disabled, measure-only, and mutating modes.

Scope:

- Add a shared schema for:

```json
{
  "mode": "disabled",
  "minOriginalBytes": 2048,
  "minSavingsTokens": 128,
  "enabledRules": ["mcp-json-whitespace", "json-whitespace", "bash-output-noise"],
  "storeOriginalArtifact": false,
  "storeCompressedArtifact": false
}
```

- Supported modes:
  - `disabled`
  - `measure_only`
  - `compress_lossless`
  - `compress_explicit_lossy`
- Resolve policy from workspace/org settings or routing config in one place before request handling.
- Hard cutover the runtime and admin UI to the policy shape.

Acceptance criteria:

- A request can resolve one compression policy before provider send.
- Invalid rule IDs or invalid mode values fail config validation.
- `disabled` produces the current no-compression behavior.
- `compress_lossless` can express the currently shipped rules.
- The resolved policy is included in route decision metadata without raw content.

Validation:

- Add schema tests.
- Add resolver tests.
- Run `pnpm typecheck` and `pnpm --filter @proxy/proxy test`.

Likely files:

- `packages/schema/src/index.ts`
- `apps/proxy/src/persistence/routingConfig.ts`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/src/graphql/types/settings.ts`
- `apps/web/src/settingsPageData.ts`

Dependencies: none.

## TOC-002: Add Measure-Only Compression Candidate Events

Goal: Detect and record compressible tool-result candidates without mutating forwarded bytes.

Scope:

- Run the existing block walkers in `measure_only` mode.
- Record one event for measured candidates and one aggregate event per request.
- Include skipped reasons:
  - `below_min_original_bytes`
  - `no_matching_rule`
  - `below_min_savings`
  - `would_grow`
  - `tool_result_error`
  - `content_shape_unsupported`
  - `policy_disabled`
- Keep provider request byte-equivalent to the input.

Acceptance criteria:

- `measure_only` produces candidate records and forwards the original body.
- Existing mutating mode behavior is unchanged.
- Events include rule id, rule version, block path, byte counts, estimated token counts, and skip reason.
- Events do not include tool-result text.

Validation:

- Add unit tests proving body identity or byte-equivalent JSON for measure-only.
- Add integration test with provider mock proving original body reaches provider.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/toolResultCompression.test.ts`
- `apps/proxy/test/compressionFixtures.test.ts`

Dependencies: TOC-001.

## TOC-003: Add Durable Compression Receipts

Goal: Persist block-level compression receipts so request details and analytics do not depend on parsing aggregate event payloads.

Scope:

- Add `compression_receipts` scoped by organization, workspace, request, and API key.
- Store:
  - mode
  - surface/dialect
  - block path
  - tool name
  - rule id and version
  - status: measured, applied, skipped, failed
  - original/compressed byte counts
  - original/compressed token estimates
  - original/compressed SHA-256 hashes
  - original/compressed artifact ids where policy allows
  - skip/failure reason
- Write receipts from the same event/projection path used for other request-scoped state.

Acceptance criteria:

- Request detail can query receipts without scanning event JSON.
- Receipts are org/workspace scoped.
- Receipt hashes match the actual original and compressed block content in tests.
- Prompt-capture mode `none` or `hash_only` prevents raw artifact writes.

Validation:

- Add migration and schema tests.
- Add projection tests.
- Run `pnpm --filter @proxy/db test`.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `apps/proxy/src/persistence/*`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/compressionSavings.test.ts`

Dependencies: TOC-002.

## TOC-004: Add Token-Aware Savings Measurement

Goal: Prevent character-shrinking rules from causing token regressions and make savings analytics model-aware enough for operator decisions.

Scope:

- Add a tokenizer abstraction for offline/golden measurement.
- Use exact token counts where a supported tokenizer is available.
- Keep rough estimates as a fallback with an explicit `estimate_source`.
- Update receipts/events with `originalTokenEstimate`, `compressedTokenEstimate`, and `estimateSource`.
- Add benchmark fixtures from realistic MCP, GitHub, Linear, Slack, shell, grep, test, and build outputs.

Acceptance criteria:

- Existing JSON whitespace and shell-noise rules continue to report non-negative token savings.
- A rule that shrinks characters but grows tokens is recorded as skipped.
- Benchmark output can rank candidate rules by median and p95 savings.
- Token-count and forward paths remain byte-identical for mutating modes.

Validation:

- Add fixture tests.
- Add benchmark script or test helper.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/compressionFixtures.test.ts`
- `apps/proxy/test/fixtures/compression/*`

Dependencies: TOC-002.

## TOC-005: Add Compression Rule Catalog And Per-Rule Controls

Goal: Make rules discoverable, configurable, and observable.

Scope:

- Add rule metadata:
  - id
  - display name
  - version
  - lossless/lossy classification
  - supported surfaces
  - eligible tool names
  - minimum bytes/tokens
  - known risks
- Add admin query for available rules.
- Add per-rule enable/disable policy.
- Add per-rule analytics by receipts.

Acceptance criteria:

- Operators can see which rules are available before enabling them.
- Policy validation rejects unknown rule ids.
- A disabled rule is not evaluated.
- Compression analytics can group by rule id/version.

Validation:

- Add rule catalog unit tests.
- Add GraphQL/admin query tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/src/graphql/queries.ts`
- `apps/proxy/schema.graphql`
- `apps/web/src/*`

Dependencies: TOC-001, TOC-003.

## TOC-006: Spike Lossless Tabular JSON Encoding For Uniform Arrays

Goal: Evaluate RTK/TOON-style table rendering for uniform object arrays without risking numeric corruption or token regressions.

Scope:

- Build a spike rule that only runs in benchmark/measure-only paths at first.
- Detect arrays of objects with stable key sets.
- Preserve:
  - object key order
  - duplicate keys if the input contains them
  - large integer spelling
  - decimal spelling such as `1.0`
  - explicit `null`
  - strings with newlines, commas, quotes, tabs, and Unicode
- Compare compact JSON, tabular encoding, and original pretty JSON with exact token counts where possible.

Acceptance criteria:

- The spike has fixtures for Linear issues, GitHub PRs, Slack messages, analytics rows, and nested non-uniform objects.
- Unsafe JSON shapes fall back to the current whitespace rule.
- No runtime mutating rule ships unless token savings and reversibility are proved.
- The recommendation is documented: ship, keep measure-only, or reject.

Validation:

- Add benchmark fixtures.
- Add round-trip or semantic-preservation tests where safe.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/compressionRules/*`
- `apps/proxy/test/compressionFixtures.test.ts`
- `docs/future/tool-result-compression-walkthrough.md`

Dependencies: TOC-004.

## TOC-007: Add Command-Aware Shell Filter Measurement

Goal: Borrow 9router/OmniRoute RTK filter ideas as measurement first, not silent lossy mutation.

Scope:

- Extract command metadata from tool input where available.
- Classify shell outputs into:
  - git diff
  - git status
  - grep/rg
  - find/fd
  - ls/tree
  - test output
  - build output
  - generic log
  - unknown
- Add measure-only filters for top categories.
- Do not apply lossy filtering in default mutating mode.

Acceptance criteria:

- Shell output classification is recorded in receipts.
- Error outputs preserve error indicators, stack tails, file paths, and line numbers.
- Lossy filters are disabled unless policy mode is `compress_explicit_lossy`.
- Operators can see estimated savings per command class before enabling lossy rules.

Validation:

- Add fixtures from pytest, vitest, tsc, eslint, git diff, git status, rg, and package install logs.
- Add no-growth and error-preservation tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/compressionRules/*`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/test/bashOutput.test.ts`
- `apps/proxy/test/compressionFixtures.test.ts`

Dependencies: TOC-002, TOC-004, TOC-005.

## TOC-008: Add Compression Preview In The Console

Goal: Let operators inspect rule effects before enabling mutating compression.

Scope:

- Add an admin preview endpoint that accepts a sample request body or request id.
- Return before/after sizes, token estimates, rule ids, skipped reasons, and safe diff segments.
- Hide raw content unless prompt-capture policy and viewer permissions allow it.
- Show receipt history on request detail pages.

Acceptance criteria:

- Preview works for Anthropic Messages, OpenAI Responses, and OpenAI Chat request shapes.
- Viewers without prompt-content permission see hashes and sizes only.
- Request detail shows applied/measured/skipped compression blocks.
- No native `<select>` is introduced in the web UI.

Validation:

- Add GraphQL/admin tests.
- Add frontend component tests where existing patterns allow.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm --filter @proxy/web test` if available.

Likely files:

- `apps/proxy/src/graphql/*`
- `apps/web/src/*`
- `apps/proxy/schema.graphql`

Dependencies: TOC-003, TOC-005.

## TOC-009: Add Compression Evidence To Route Execution Plans

Goal: Make compression visible in the same audit surface as routing, translation, fallback, and provider selection.

Scope:

- Extend route decisions or the future route execution plan with compression policy and result summary.
- Include:
  - mode
  - evaluated blocks
  - applied blocks
  - skipped blocks
  - saved token estimate
  - rule ids
  - receipt ids
- Ensure provider attempts can be correlated to the compressed request hash.

Acceptance criteria:

- Request detail can answer whether the provider saw original or compressed tool output.
- Route decision evidence includes compression without raw text.
- Compression failures are visible and do not change forwarded bytes.

Validation:

- Add route decision tests.
- Add admin query tests.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/router.ts`
- `apps/proxy/src/toolResultCompression.ts`
- `apps/proxy/src/persistence/adminQueries.ts`

Dependencies: TOC-003.

## TOC-010: Add Quality Monitoring And Rollback Controls

Goal: Detect when compression causes worse agent behavior and provide fast rollback.

Scope:

- Add policy-level runtime caps:
  - `maxAppliedBlocks` per request
  - `maxCompressedBytes` per request
  - `maxCompressionRatio` or equivalent guard against unexpectedly aggressive rewrites
- Treat cap hits as skipped compression records with explicit skip reasons, not provider errors.
- Track quality metrics by rule/version, mode, workspace, API key, and command class:
  - request failure rate
  - provider retry/fallback rate
  - user/tool follow-up rate if measurable
  - saved tokens
  - cost savings estimate
- Join `compression_receipts`, provider attempts, and request terminal status so analytics can compare compressed vs uncompressed windows without raw prompt text.
- Add dashboard warnings for high failure, retry, fallback, or follow-up correlation.
- Keep per-rule rollback as config: disabling a rule or changing mode must not require code deploy or migration.
- Borrow only the operator controls from OmniRoute RTK (`enabledFilters`, `disabledFilters`, max line/char caps, validation diagnostics), not broad prose/code compression.
- Borrow LiteLLM's pre-call filter pattern: failed quality/cap checks should skip candidate rules before provider send and appear in route evidence.

Acceptance criteria:

- A rule can be disabled without code deploy.
- Compression analytics can compare before/after windows.
- High-risk lossy rules can be enabled for one workspace/API key only.
- Rollback does not require data migration.
- Requests that exceed compression caps forward with original or partially compressed safe bytes according to deterministic policy.
- Request detail explains rule disablement, cap hits, and rollback state without raw tool output.

Validation:

- Add settings/admin tests.
- Add analytics tests.
- Add cap-hit tests proving forwarded bytes stay deterministic.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/persistence/organizationSettings.ts`
- `apps/proxy/src/graphql/*`
- `apps/web/src/*`

Dependencies: TOC-003, TOC-005.

## TOC-011: Evaluate Provider-Delegated Context Editing Separately

Goal: Evaluate Anthropic-style provider-side context editing as a separate experiment, not as local prompt rewriting.

Scope:

- Add a research spike for provider-delegated stale tool-result clearing.
- Restrict to providers/dialects with an explicit supported feature.
- Record provider receipts as compression-like telemetry without claiming local byte savings.
- Do not enable automatically for stateful sessions until cache behavior is measured.
- Treat 9router's `context-management-2025-06-27` beta forwarding as prior art for capability detection only; do not blindly add beta headers to every Anthropic request.
- Treat OmniRoute's `context-relay` handoff summaries as a different product surface: local summarization and prompt injection, not provider-delegated context editing.
- Document how provider-delegated edits interact with prompt cache reads/writes, stateful sessions, and local compression receipts.

Acceptance criteria:

- The spike documents cache impact, request/response receipts, and safety constraints.
- Delegated context editing is not mixed with local tool-result compression receipts.
- Unsupported providers are unaffected.
- The recommendation explicitly says whether to ship, keep as a provider-specific experiment, or reject.

Validation:

- Add a research doc or experiment report.
- Add no runtime code unless the spike recommends a follow-up ticket.

Likely files:

- `docs/future/*`
- `docs/scopes/router-research-roadmap-v1/*`

Dependencies: TOC-004.

## Recommended Sequence

1. TOC-001
2. TOC-002
3. TOC-003
4. TOC-004
5. TOC-005
6. TOC-008
7. TOC-009
8. TOC-007
9. TOC-006
10. TOC-010
11. TOC-011
