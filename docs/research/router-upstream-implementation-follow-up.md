# Router Upstream Implementation Follow-Up

This is a second-pass code review of the upstream projects previously compared with Prompt Proxy. It focuses on implementation details that were either not captured in the first research pass or are now more useful because this branch already includes tool-result compression, provider registry work, translation wiring, and token/caching analytics.

Sources reviewed:

- LiteLLM: `.context/upstreams/litellm`, commit `e4a53f50de24701c0d0c9334c2fb0ab5e770e828`
- 9router: `.context/upstreams/9router`, commit `f2a7ae20309b4af55023eb11d1c02f63be1b80d1`
- Kong: `.context/upstreams/kong`, commit `1730282ec2f8ed097cf6ad6a3d69e55b7ba9ebb6`
- OmniRoute: `.context/upstreams/OmniRoute`, commit `dd5a3db55ed9bca1f71398e6e584da2983a70bea`

## Current Prompt Proxy Baseline

Prompt Proxy has already implemented more of the token-compression roadmap than the original upstream research assumed:

- `apps/proxy/src/toolResultCompression.ts` walks Anthropic Messages, OpenAI Responses, and OpenAI Chat tool-result shapes.
- `apps/proxy/src/compressionRules/mcpJson.ts` and `jsonWhitespace.ts` provide deterministic JSON whitespace compaction without parse/stringify reserialization.
- `apps/proxy/src/compressionRules/bashOutput.ts` strips ANSI/control-output noise for known shell tools.
- Duplicate large tool-result references are supported when `duplicateToolResultReferences` is enabled.
- `/v1/messages/count_tokens` applies the same compression path as forwarding so Anthropic token-count decisions match forwarded bytes.
- `compression.recorded` events and `compressionSavings` analytics already exist.
- Fixture and DB-backed tests cover rule behavior, no-content event payloads, duplicate references, and savings aggregation.

That changes the remaining work: the next step is not "add compression". It is to make compression policy explicit, measurable before mutation, auditable at block level, token-aware, and easier to operate.

## LiteLLM Findings

Reviewed areas:

- `litellm/router.py`
- `litellm/router_utils/cooldown_handlers.py`
- `litellm/router_strategy/budget_limiter.py`
- `litellm/router_utils/pre_call_checks/model_rate_limit_check.py`
- `litellm/proxy/health_check.py`
- `litellm/proxy/management_endpoints/fallback_management_endpoints.py`

Implementation lessons:

- LiteLLM treats cooldowns, health checks, budgets, RPM/TPM limits, and fallback chains as first-class routing filters. They are not just provider-attempt side effects.
- Cooldown decisions distinguish single-deployment groups, rate-limit status, auth-style failures, recent failure percentage, and explicit allowed-fails policy.
- Budget limiting is layered: provider budget, deployment budget, and tag budget all filter candidate deployments before spend.
- Model RPM/TPM checks are pre-call gates. RPM is incremented atomically before the call; TPM is updated from actual usage after success.
- Health checks are bounded and mode-aware. Non-chat endpoints do not blindly receive chat-only params like `max_tokens`.
- Fallback management is exposed as an operator API with separate general, context-window, and content-policy fallback types.

What Prompt Proxy should borrow:

- Convert provider health, model health, rate limits, and budget windows into route-plan filters with durable skip evidence.
- Add pre-call limiter interfaces that can reject before classifier/provider spend and true up after usage.
- Add provider probe jobs that are mode-aware and write both current state and events.
- Keep fallback types explicit: ordinary failure fallback, context-window fallback, content-policy fallback, and provider-health fallback are different policy decisions.

What not to borrow:

- Do not make provider count or SDK normalization the product center.
- Do not let cached current-state decisions replace durable route evidence.
- Do not silently fallback without recording selected, skipped, and attempted targets.

## 9router Findings

Reviewed areas:

- `open-sse/rtk/index.js`
- `open-sse/rtk/autodetect.js`
- `open-sse/rtk/filters/*`
- `open-sse/services/accountFallback.js`
- `open-sse/services/combo.js`
- `open-sse/translator/*`
- `open-sse/providers/*`

Implementation lessons:

- The RTK layer is compact and practical: detect a tool-output shape, choose one filter, apply it safely, reject empty or larger output, and return simple saved-byte stats.
- It handles multiple request shapes: OpenAI Chat tool messages, OpenAI Responses `function_call_output`, Anthropic `tool_result`, and Kiro-specific history.
- Error tool results are preserved instead of compressed.
- Filter detection is content-based: git diff, git status, build output, grep, find, tree, ls, numbered reads, duplicate logs, and generic head/tail truncation.
- Account fallback stores cooldowns, backoff levels, last errors, and model-specific lockouts.
- Combo routing reorders candidates by hard capability fit before fallback, which avoids trying a text-only model for a vision/PDF request.
- The translator tree is organized by request/response direction and concern modules, making edge-case translation easier to test.

What Prompt Proxy should borrow:

- Add a measure-only pass for RTK-style filter candidates before applying any lossy or command-aware rule.
- Record the detected output class and skipped reason even when no rule applies.
- Use tool input/command metadata when available; do not rely only on content matching.
- Add capability-fit candidate ordering as route-plan evidence, especially for vision, PDF, tool-call, and stateful-response constraints.
- Continue growing translator golden tests by caller surface and target dialect.

What not to borrow:

- Do not mutate request bodies in place.
- Do not silently compress or silently fallback.
- Do not apply lossy shell filters proxy-side until a policy contract and quality telemetry exist.

## Kong Findings

Reviewed areas:

- `kong/init.lua`
- `kong/pdk/private/phases.lua`
- `kong/pdk/ctx.lua`
- `kong/runloop/*`

Implementation lessons:

- Kong's strongest lesson is phase discipline. Each phase has allowed APIs, request context, timing, and plugin execution boundaries.
- Request context is split between shared request state and per-plugin namespaced state.
- Timing is captured per phase: rewrite, access, balancer, response, header filter, body filter, and log.
- The runloop isolates plugin execution from core lifecycle work while preserving a single request context.

What Prompt Proxy should borrow:

- Add a built-in, typed phase ledger for Prompt Proxy's own request lifecycle: parse, auth, prompt capture, token attribution, routing, target planning, compression, translation, provider send, stream observation, usage, events, and metrics.
- Record phase timings in events or bounded-cardinality metrics.
- Make phase context explicit so route handlers stop owning policy sequencing directly.

What not to borrow:

- Do not add arbitrary third-party plugins in the hot path.
- Do not generalize Prompt Proxy into a full API gateway.

## OmniRoute Findings

Reviewed areas:

- `open-sse/services/compression/*`
- `open-sse/services/compression/engines/rtk/*`
- `open-sse/services/compression/engines/headroom/tabular.ts`
- `src/domain/fallbackPolicy.ts`
- `src/domain/lockoutPolicy.ts`
- `src/domain/costRules.ts`
- `src/domain/quotaCache.ts`
- `src/domain/policyEngine.ts`
- `src/domain/assessment/*`
- `open-sse/services/autoCombo/*`

Implementation lessons:

- OmniRoute's compression system has useful operational pieces: engine registry, config schema, preview endpoint, analytics by engine, validation warnings, raw-output retention pointers, and per-engine breakdowns.
- Its RTK engine uses command detection, filter catalogs, per-rule enable/disable config, raw-output retention modes, and max line/char caps.
- Its tabular JSON encoder is a useful shape to study, but it parses JSON and can normalize numbers. Prompt Proxy's current JSON rule intentionally avoids that class of corruption.
- The validation layer protects fenced code, inline code, URLs, markdown links, frontmatter, headings, tables, math blocks, versions, and constants during prose compression.
- `quotaCache.ts` models quota snapshots separately from request failures and unblocks stale exhausted accounts after reset windows pass.
- `costRules.ts` models budget windows, reset intervals, warning thresholds, and pending spend batches.
- `assessment/assessor.ts` probes provider/model pairs and records status, latency, success rate, and coarse capability support.
- Auto-combo scoring combines health, quota, cost, latency, task fit, exploration, and tier preferences.

What Prompt Proxy should borrow:

- Add compression preview and rule catalog APIs for operators.
- Add block-level compression receipts and per-rule analytics rather than only aggregate `compression.recorded` payloads.
- Add raw-output artifact pointers only under Prompt Proxy prompt-capture policy.
- Add quota snapshots and reset-aware unblocking to provider account health.
- Add model assessment jobs that feed route-plan evidence but do not silently rewrite routing configs.
- Use auto-combo factors as explainable evidence, not as an opaque route selector.

What not to borrow:

- Do not add broad prompt/prose compression to default traffic.
- Do not add custom project compression filters in the proxy hot path.
- Do not use parsed JSON table encoding until number and token-regression risks are proved away with fixtures.

## Consolidated Improvements

The most useful implementation changes are:

1. Add explicit compression modes and a measure-only path.
2. Persist block-level compression receipts with hashes, rule versions, block paths, and artifact links where policy allows.
3. Add token-aware compression measurement and offline benchmark fixtures before any representation-changing rule.
4. Add a compression preview/rule catalog in the console.
5. Add command-aware shell-output filter measurement, but keep lossy filtering disabled by default.
6. Add a provider/account/model health state machine with quota snapshots, lockouts, cooldowns, and health probes.
7. Add route execution plans that record candidate targets, compatibility checks, health/budget skips, translation path, compression action, and final attempt.
8. Add limiter preflight and true-up for API-key/workspace RPM, TPM, parallelism, and budget windows.
9. Add a typed policy pipeline inspired by Kong phases, without adding arbitrary plugins.
10. Expand translator golden tests using 9router/OmniRoute's direction-by-direction discipline.

The compression-specific tickets are in [Tool Output Compression Tickets](../scopes/router-research-roadmap-v1/tool-output-compression-tickets.md).

## Post-TOC-009 Re-Audit Addendum

This addendum revisits the same local clones after Prompt Proxy gained policy-based compression, measure-only receipts, preview, shell classification, and request-level compression evidence.

Additional source areas reviewed:

- 9router: `open-sse/rtk/index.js`, `open-sse/rtk/autodetect.js`, `open-sse/services/accountFallback.js`, `open-sse/providers/shared.js`, translator header snapshots.
- OmniRoute: `open-sse/services/compression/engines/rtk/*`, `open-sse/services/compression/engines/rtk/filters/*.json`, `open-sse/services/compression/engines/rtk/rawOutput.ts`, `src/domain/quotaCache.ts`, `src/domain/costRules.ts`, `open-sse/services/contextHandoff.ts`.
- LiteLLM: `router_strategy/budget_limiter.py`, `router_utils/pre_call_checks/model_rate_limit_check.py`, `router_utils/cooldown_handlers.py`.
- Kong: `kong/pdk/private/phases.lua`, `kong/pdk/ctx.lua`, `kong/init.lua`, `kong/runloop/handler.lua`.

### Compression Quality And Rollback

9router's RTK implementation is still valuable for output-shape coverage. It handles Anthropic `tool_result`, OpenAI Chat tool messages, OpenAI Responses `function_call_output`, and Kiro history. It skips explicit error tool results, rejects empty output, rejects output growth, and records simple hit stats. Prompt Proxy now matches the safe parts of this model, but should keep the difference that matters: no in-place mutation and no unreceipted lossy rewrite.

OmniRoute's RTK engine adds the operator controls Prompt Proxy still needs:

- Per-engine and per-filter enable/disable config.
- `maxLinesPerResult` and `maxCharsPerResult` caps.
- Filter catalog validation diagnostics.
- Command metadata from tool calls before filter selection.
- Raw-output retention modes: `never`, `failures`, and `always`.
- Per-engine stats and preview support.

Prompt Proxy should not copy OmniRoute's broad prose/code compression engines into default traffic. The transferable idea is the rollback surface: every rule needs a durable id/version, caps, kill switch, quality telemetry, and a scoped rollout path.

LiteLLM's limiter and cooldown implementations make the rollback shape clearer. Budget, RPM/TPM, and cooldown checks are pre-call filters with explicit skip reasons, then success paths true up usage. Compression quality controls should follow that pattern: a disabled or risky rule should be filtered before provider send and recorded in the route evidence, not discovered only through dashboard correlation later.

Kong's phase discipline should apply to compression as a named phase. Prompt Proxy now records `routing.compression_evidence_recorded`, but the longer-term policy pipeline should also track phase timing and make compression/translation/provider-send ordering explicit.

Concrete follow-ups:

1. Add policy-level caps for `maxAppliedBlocks` and `maxCompressedBytes` per request.
2. Add rule quality analytics that join compression receipts to provider attempts and request terminal status.
3. Add before/after window comparisons by rule/version, mode, workspace, API key, and command class.
4. Add dashboard warnings when a rule's failure, retry, fallback, or high-follow-up correlation crosses a threshold.
5. Treat per-rule disablement as the rollback path, with no migration required.

### Provider-Delegated Context Editing

9router includes Anthropic's `context-management-2025-06-27` beta in provider headers, but the reviewed code does not model provider-side context edits as first-class receipts. OmniRoute's closest related system is `context-relay`: it generates and stores handoff summaries when account rotation or model switching is likely, then injects those summaries into future requests. That is a local summarization/handoff feature, not provider-delegated context editing.

Prompt Proxy should keep this separate from local tool-result compression:

- Local compression claims byte/token savings because Prompt Proxy changes the forwarded request body.
- Provider-delegated context editing asks the upstream provider to alter retained context, so Prompt Proxy should record provider receipts and cache impact, not local savings.
- Handoff summaries are local prompt rewriting and should remain out of the compression roadmap unless a future product explicitly opts into session handoff.

Concrete follow-ups:

1. Create a research spike for Anthropic-compatible provider context editing with explicit provider/dialect support.
2. Record provider context-edit receipts separately from `compression_receipts`.
3. Measure cache-hit/cache-write impact before enabling it for stateful sessions.
4. Do not add broad handoff summarization to Prompt Proxy's hot path as part of compression.
