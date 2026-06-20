# Harness Compatibility Tests V1 Tickets

These tickets break the harness compatibility tests scope (`harness-compatibility-tests.md`) into PR-sized units.

The intended delivery shape is a fixture-backed compatibility contract for native and translated harness paths. The result should let the proxy say exactly which harness/provider dialect combinations are supported, translated, blocked, or unsupported, and prove those claims with golden request, response, streaming, usage, and rejection fixtures.

Some of this repo already has harness detection, translator tests, runtime translation tests, and SSE fixtures. These tickets should build on those seams instead of replacing working code for layout purity.

## Delivery Rules

- Keep native same-dialect passthrough behavior stable.
- Generate compatibility claims from shared backend/schema logic, not UI-only tables.
- Add fixtures before expanding support claims for a translated path.
- Treat unsupported translated paths as explicit rejection fixtures.
- Keep Codex WebSocket traffic native-only.
- Reject OpenAI Responses `previous_response_id` translation unless a later scope intentionally implements state ownership.
- Keep fixtures small, hand-readable, and committed beside the tests that consume them.
- Preserve route decision evidence: translated routes, skipped targets, blocked stateful features, and unsupported fields must be visible in events or route-plan excerpts.

## Phase 0: Contracts And Fixtures

1. [HCT-001: Normalize Harness Profile Metadata](harness-compatibility-tests-tickets/hct-001-normalize-harness-profile-metadata.md)
2. [HCT-002: Add Fixture-Driven Harness Detection Tests](harness-compatibility-tests-tickets/hct-002-fixture-driven-harness-detection-tests.md)
3. [HCT-003: Add Shared Compatibility Matrix Contract](harness-compatibility-tests-tickets/hct-003-shared-compatibility-matrix-contract.md)
4. [HCT-004: Add Harness Golden Fixture Loader](harness-compatibility-tests-tickets/hct-004-harness-golden-fixture-loader.md)

## Phase 1: Native Path Golden Coverage

5. [HCT-005: Add Codex Responses HTTP Native Golden Tests](harness-compatibility-tests-tickets/hct-005-codex-responses-http-native-golden-tests.md)
6. [HCT-006: Add Codex Responses WebSocket Native-Only Tests](harness-compatibility-tests-tickets/hct-006-codex-responses-websocket-native-only-tests.md)
7. [HCT-007: Add Claude Code Messages Native Golden Tests](harness-compatibility-tests-tickets/hct-007-claude-code-messages-native-golden-tests.md)
8. [HCT-008: Add OpenAI Chat Caller Native Golden Tests](harness-compatibility-tests-tickets/hct-008-openai-chat-caller-native-golden-tests.md)

## Phase 2: Translated And Rejected Path Coverage

9. [HCT-009: Add Same-Family OpenAI Translation Golden Tests](harness-compatibility-tests-tickets/hct-009-same-family-openai-translation-golden-tests.md)
10. [HCT-010: Add Cross-Family Translation Golden Tests](harness-compatibility-tests-tickets/hct-010-cross-family-translation-golden-tests.md)
11. [HCT-011: Add Unsupported And Stateful Rejection Fixtures](harness-compatibility-tests-tickets/hct-011-unsupported-and-stateful-rejection-fixtures.md)
12. [HCT-012: Add Streaming Edge-Case Fixture Pack](harness-compatibility-tests-tickets/hct-012-streaming-edge-case-fixture-pack.md)

## Phase 3: Runtime, Console, And CI

13. [HCT-013: Feed Profiles Into Runtime Compatibility Decisions](harness-compatibility-tests-tickets/hct-013-feed-profiles-into-runtime-compatibility-decisions.md)
14. [HCT-014: Expose Compatibility Matrix In Admin APIs And Console](harness-compatibility-tests-tickets/hct-014-expose-compatibility-matrix-in-admin-apis-and-console.md)
15. [HCT-015: Add Harness Smoke Status And CI Guardrails](harness-compatibility-tests-tickets/hct-015-harness-smoke-status-and-ci-guardrails.md)

## Suggested Sequencing

```text
HCT-001 -> HCT-002 -> HCT-003 -> HCT-004
  -> HCT-005 -> HCT-006 -> HCT-007 -> HCT-008
  -> HCT-009 -> HCT-010 -> HCT-011 -> HCT-012
  -> HCT-013 -> HCT-014 -> HCT-015
```

HCT-001 through HCT-004 establish the contract and fixture machinery. HCT-005 through HCT-008 protect native behavior first. HCT-009 through HCT-012 add translated and failure-path evidence. HCT-013 through HCT-015 wire the evidence into runtime, operator surfaces, and drift prevention.
