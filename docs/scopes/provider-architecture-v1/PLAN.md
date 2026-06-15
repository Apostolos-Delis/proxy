# Provider Architecture V1 — Decoupling Surfaces from Providers

## Goal

Rearchitect model routing so the proxy can serve **N harnesses** and route to **N providers** without the anthropic/openai dichotomy baked into every layer.

Concretely, after this scope:

1. **New harnesses connect without code forks.** opencode, Cursor (BYOK), and plain SDK callers (`openai` / `anthropic` client libraries pointed at the proxy) work alongside Claude Code and Codex.
2. **Open-source / self-hosted models are routable.** A tier can target `vLLM at http://10.0.0.5:8000`, Ollama, or a hosted OSS endpoint (DeepSeek, Z.AI/GLM, Moonshot/Kimi) the same way it targets Anthropic or OpenAI today.
3. **Providers are rows, not enum members.** Adding a provider means inserting a registry row (endpoints + auth style + base URL), not touching `packages/schema`, `proxy.ts`, `values.ts`, the GraphQL layer, and the web editor.
4. **Cross-dialect routing is possible where a translator exists**, and impossible-by-capability-check (not impossible-by-construction) where one doesn't.

### Non-goals

- **No internal re-serialization on the same-dialect path.** Byte-exact passthrough stays the fast path. It is load-bearing: prompt-cache prefix stability, Anthropic signed thinking blocks, beta features the proxy doesn't model.
- **No embedding of the Vercel AI SDK as the outbound client.** We proxy raw HTTP and observe passively; an SDK-shaped IR would force full parse/re-serialize on every request and put the SDK's opinions between the harness and the provider. We borrow opencode's *data architecture*, not its client library.
- **No signature- or token-exchange auth schemes.** The registry's auth styles are `bearer | x-api-key | none`. AWS SigV4 (Bedrock), Vertex OAuth token injection, and Azure's `api-key`/`api-version` handshake are explicitly out of scope for V1; if they ever land, they arrive as a per-provider auth plugin point, not as more enum values.
- **No change to the tier ladder** (`fast | balanced | hard | deep`), the classifier concept, session pinning semantics, the event pipeline, or the usage ledger schema.

## Design Inputs: How opencode Supports 75+ Providers

Researched June 2026 from `anomalyco/opencode` (`packages/opencode/src/provider/`) and opencode.ai/docs/providers. Four takeaways transfer to the proxy; one crucial difference does not.

**1. Provider = config, not code.** An opencode provider is a record: `{id, npm adapter, baseURL, auth, options, models}`. The overwhelming majority of its 75+ providers are `@ai-sdk/openai-compatible` plus a base URL and headers — Ollama, LM Studio, llama.cpp, vLLM, Groq, Fireworks, Together are all the same code path with different rows. Only ~a dozen providers need custom loader functions (Bedrock region-prefixed model IDs, Vertex auth token injection, Azure resource names), and those are registered escape hatches, not forks of the core path. (Those dozen are exactly the auth schemes we declare out of scope above.)

**2. Capability/pricing catalog is an external dataset.** models.dev supplies per-model capabilities (reasoning, modalities, tool-call support, interleaved-thinking field), cost (`input/output/cache.read/cache.write`, tiered), and limits (`context/output`). User config merges *over* the catalog. Nobody hand-maintains a pricing table in code.

**3. One transform compatibility matrix.** Every per-provider quirk lives in a single module (`transform.ts`) keyed by (adapter package, provider ID, model-ID regex): Anthropic `cache_control` vs Bedrock `cachePoint` vs Copilot `copilot_cache_control`; Mistral's exactly-9-char tool IDs; DeepSeek's mandatory reasoning parts. Most relevantly, an **abstract effort ladder mapped to each provider's control surface at the edge** — OpenAI `reasoningEffort` tiers (gated by model release date), Anthropic adaptive thinking vs `budgetTokens`, Gemini `thinkingBudget` vs `thinkingLevel`.

**4. Unified call interface as the pivot.** Everything bottoms out in one interface (AI SDK `LanguageModelV3`); each provider adapter translates outward from the canonical shape. Provider count scales with adapters, not with app code.

**The difference that bounds how much we copy:** opencode is a request *origin* — it owns the canonical format and never receives someone else's bytes. The proxy is a *middleman* — the inbound shape is dictated by the harness, and our value depends on not perturbing it. So takeaway 4 inverts for us: the pivot concept is the **dialect** (a wire format that both surfaces and providers speak), and translation between dialects is an opt-in component for specific pairs — not the default path every request takes.

## Current State

```text
Claude Code ──→ POST /v1/messages ───┐  surface = "anthropic-messages"
Codex ────────→ POST /v1/responses ──┤  surface = "openai-responses"
Codex ────────→ WS  /v1/responses ───┘  (separate OpenAI-only pipeline)
                          │
                          ▼
              SurfaceAdapter (adapters.ts:33-46)
              carries a hardwired `provider` field
              → surface ≡ provider, 1:1 BY CONSTRUCTION
                          │
                          ▼
              RoutingService.decide (tier) ──→ routingConfig.routes[tier].openai
                          │                    or .anthropic, PICKED BY SURFACE
                          ▼
              rewriteSurfaceRequest — THROWS on surface/provider mismatch
                          │
                          ▼
              ProviderProxy.urlFor/headersFor — ternary on provider,
              ONE global base URL per provider (env)
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
        api.openai.com         api.anthropic.com
        (byte passthrough; SseObserver parses both dialects heuristically)
```

There is **no translation layer**. A request can only ever be served by the provider whose dialect it arrived in. "Routing" today means choosing a model *within* one provider.

### Pain-point inventory

Ranked by blast radius. These are the things a third provider (or third surface) collides with.

| # | Problem | Where |
|---|---------|-------|
| 1 | Two-member closed unions `SURFACE_NAMES` / `PROVIDER_NAMES`; every narrowing downstream flows from them | `packages/schema/src/index.ts:12,19`; re-declared in `apps/proxy/src/types.ts` |
| 2 | `surfaceValue`/`providerValue` return `undefined` for unknown values and call sites default to `"openai-responses"`/`"openai"` — **a third provider's ledger traffic would be silently booked as OpenAI** | `apps/proxy/src/persistence/values.ts:89-97`; `persistence/providerAttempt.ts:44-45`; `persistence/classifierUsage.ts:24`; `persistence/sessionRoute.ts:24`; `persistence/requestState.ts:85,220` |
| 3 | Surface↔provider fusion: static adapter objects with embedded provider; mismatch throw; `settingsForSurface` returns undefined unless surface==provider | `apps/proxy/src/adapters.ts:33-46,53-74`; `router.ts:40-62` |
| 4 | Routing config document has `openai`/`anthropic` as **field names** per tier; session pins are a discriminated union on provider name | `packages/schema/src/index.ts:254-266,317-328`; ripples into `router.ts:498-552`, `persistence/adminSerializers.ts`, `graphql/types/routing.ts`, the entire web editor (`apps/web/src/routingConfigEditor.ts`, `routing/modelSelect.tsx`, `providers/data.ts`) |
| 5 | `ProviderProxy.urlFor`/`headersFor` ternaries; exactly one base URL per provider globally; `provider_accounts` has no `base_url` | `apps/proxy/src/proxy.ts:285-332`; `packages/db/src/schema.ts` (provider_accounts) |
| 6 | Two effort vocabularies (`OPENAI_REASONING_EFFORTS` vs `ANTHROPIC_EFFORTS`) merged ad-hoc; inline `minimal→low` mapping; web editor `EFFORT_SCALE` | `packages/schema/src/index.ts:37-39`; `router.ts:525`; `catalog.ts:136-147`; `apps/web/src/routingConfigEditor.ts` |
| 7 | Classifier hard-locked to OpenAI: `z.literal("openai")` in env config, runtime throw, hardcoded Responses-shaped request body | `apps/proxy/src/config.ts:81`; `classifier.ts:64-66,118-155` |
| 8 | Env fallback catalog is provider-pair-hardcoded end to end (`OPENAI_*_MODEL`/`ANTHROPIC_*_MODEL` → 8-entry `ModelCatalog`, surface-scoped alias maps) | `apps/proxy/src/config.ts:71-80`; `catalog.ts:47-105` |
| 9 | Usage shape detection by provider-specific keys; **chat-completions `prompt_tokens`/`completion_tokens` not handled at all**; SSE dialect heuristics in one observer class | `apps/proxy/src/persistence/values.ts:21-57`; `sseObserver.ts:82-125` |
| 10 | Pricing provider inferred from model-name prefix (`claude*` → anthropic, `gpt*` or `o\d` → openai, else null — OSS names price as nothing); org pricing overrides hard-reject non-{openai,anthropic}; `CostBaseline` has exactly two fields | `apps/proxy/src/pricing.ts:39-67,161-165`; `persistence/modelPricing.ts:65` |
| 11 | Scattered per-surface branches: token attribution, tool-result compression, prompt artifacts, cache-bust semantics, harness header allowlists, session-ID sniffing, `/v1/models` hardcoded list | `tokenAttribution.ts`, `toolResultCompression.ts:57`, `persistence/promptArtifacts.ts`, `persistence/cacheBusts.ts:111`, `proxy.ts:300-331`, `features.ts:46-149`, `server.ts:130-144` |
| 12 | WebSocket path is a separate OpenAI-only pipeline (own header logic, no BYOK, hardcoded `${openaiBaseUrl}/responses` + company key) | `apps/proxy/src/wsProxy.ts:414,421-424` |

### What's already in good shape

- **`usage_ledger` + `NormalizedUsage`** — provider-agnostic row shape; the convention (`inputTokens` = total, cache reads/writes are subsets) extends cleanly.
- **Event-sourced pipeline** (EventService → projector) — the envelope is provider-agnostic.
- **Routing-config versioning/immutability** and per-key/workspace resolution.
- **BYOK credential model** (`provider_accounts` / `api_key_provider_accounts`) — extends naturally once `provider` becomes a registry reference.
- **The tier abstraction** — fully provider-neutral.
- **Classifier feature view** (`features.ts` `classifierView`) — already surface-neutral JSON.

## Target Architecture

```text
Claude Code ─→ /v1/messages          ┐
Codex ───────→ /v1/responses (+WS)   ├─→ Surface: parses ONE dialect, builds RouteContext
opencode ────→ /v1/messages | /v1/responses | /v1/chat/completions   │
Cursor/SDKs ─→ /v1/chat/completions ★new                             │
                                                                     ▼
                                HarnessProfile registry ★new
                                (one registry instead of scattered sniffing:
                                 detection, session-id extraction, header policy,
                                 prompt-block tags, bash tool names)
                                                                     │
                                                                     ▼
                                RoutingService (tiers unchanged)
                                tier target list: [{providerId, model, effort, …}]
                                effort = ONE normalized ladder ★new
                                                                     │
                                                                     ▼
                                Provider registry ★new (DB rows + builtins)
                                {slug, baseUrl, authStyle, endpoints: [{dialect, path}, …]}
                                                                     │
                              ┌── same-dialect endpoint? ────────────┤
                              ▼ yes                                  ▼ no
                    BYTE PASSTHROUGH (fast path,            Translator registry ★new
                    unchanged from today)                   (fromDialect → toDialect),
                              │                             streaming SSE transform
                              ▼                                      │
        anthropic.com / openai.com / vllm:8000 / deepseek / z.ai / ollama / …
                              │
                              ▼
                    Dialect-keyed observers (usage/status/text per dialect) ★new
                              │
                              ▼
                    ModelCatalog ← vendored models.dev snapshot (Stage 1)
                    + refresh job (Stage 4) + org overrides ★new
                    (capabilities, pricing, limits — replaces static tables)
```

### Core concepts

**Dialect** — the pivot of the whole design. A wire format spoken on the wire:

```ts
type Dialect = "anthropic-messages" | "openai-responses" | "openai-chat";
```

A **surface speaks exactly one dialect**. A **provider exposes one or more dialect endpoints** — this asymmetry is deliberate: OpenAI natively serves both `openai-responses` and `openai-chat`; DeepSeek/Z.AI/Moonshot serve both `anthropic-messages` and `openai-chat`. Modeling providers as single-dialect would force either duplicate registry rows (splitting credential bindings and ledger attribution) or needless translation on paths the provider serves natively.

Compatibility is two functions, not one:

```ts
// STATIC — config validation, editor affordances. Pure dialect math.
compatible(surfaceDialect, target) =
  target.provider.endpoints.some(e => e.dialect === surfaceDialect)   // passthrough possible
  || target.provider.endpoints.some(e => translators.has(surfaceDialect, e.dialect))

// RUNTIME — per-request selection. Sees the request.
canServe(target, routeContext) =
  compatible(...) AND no per-request blocker
  // blockers: a previous_response_id minted by a DIFFERENT provider — unresolvable there
  //           regardless of translation or dialect match (selection rules 6-7),
  //           signed thinking blocks / encrypted reasoning items crossing providers (Stage 3),
  //           provider row disabled, credential unresolvable
```

The Stage-1 selection path uses `canServe`; the web editor and config publish-time validation use `compatible`.

**Provider registry** — providers become rows. Builtin rows ship seeded; orgs add custom rows (self-hosted vLLM, a DeepSeek account, a corporate gateway):

```text
providers
  id              uuid pk
  org_id          uuid nullable fk      -- NULL = builtin
  slug            text                  -- "anthropic", "openai", "acme-vllm"
                                        -- UNIQUE NULLS NOT DISTINCT (org_id, slug) — plain
                                        -- UNIQUE treats NULL org_ids as distinct and would let
                                        -- two builtin "openai" rows coexist; org slug SHADOWS
                                        -- builtin slug
  display_name    text
  base_url        text                  -- https://api.anthropic.com/v1, http://10.0.0.5:8000/v1
  auth_style      text                  -- "bearer" | "x-api-key" | "none"
  endpoints       jsonb                 -- [{dialect, path}]; e.g. openai builtin:
                                        --   [{"dialect":"openai-responses","path":"/responses"},
                                        --    {"dialect":"openai-chat","path":"/chat/completions"}]
  default_headers jsonb                 -- NON-AUTH headers only (see credential invariant)
  forward_harness_headers boolean       -- org rows only; default false (see HarnessProfile)
  enabled         boolean
```

Routing-config `providerId` values are slugs, resolved org-row-first then builtin (an org may shadow `openai` to point at a gateway). `provider_accounts.provider` (closed text union today) becomes `provider_id uuid fk`, and accounts gain a nullable `base_url` override for the VPC-endpoint case. Custom providers are **org-scoped only in V1**: builtin rows change via seed migrations, and promoting a popular org provider to a builtin is a manual operation, not a product feature.

**Network invariant.** Private-range base URLs — the self-hosted `vLLM at http://10.0.0.5:8000` case from Goal 2 — are valid only when the **deployment operator** allowlists those CIDRs (`ALLOWED_PRIVATE_UPSTREAM_CIDRS` env). It is operator config, never org config: a self-hosted deployment opens its own VPC ranges; a multi-tenant cloud deployment leaves the list empty, and tenants cannot grant themselves access to the operator's network. Link-local/metadata ranges are blocked unconditionally (see Risks).

**Credential invariant (security-critical).** Today the BYOK branch falls back to the operator's env keys (`byok?.token ?? config.openaiApiKey`, `proxy.ts:301,321`). That fallback MUST NOT extend to registry rows: an org could otherwise create `{slug: "evil", base_url: "https://attacker.example"}`, target it from a tier, and receive the company's OpenAI key in the `Authorization` header. The rule:

- **Builtin providers (`org_id IS NULL`)**: credential resolution unchanged — BYOK account if bound, else operator env key.
- **Org-defined providers**: an attached `provider_accounts` credential is **required** unless `auth_style = "none"`. No credential → the target is skipped by `canServe` (and flagged at config publish time). Never fall back to env keys.
- **`default_headers` rejects auth-bearing keys** (`authorization`, `x-api-key`, `proxy-authorization`, `cookie`, `host`; `anthropic-version` is allowed) at write time — otherwise it's a plaintext credential channel bypassing the encrypted `secretCiphertext` store.

This immediately unlocks a fact worth stating: **several OSS-model hosts already expose anthropic-messages-compatible endpoints** (DeepSeek, Z.AI/GLM, Moonshot/Kimi publish them specifically for Claude Code users), so the registry alone — before any translation work — lets a Claude Code tier target OSS models.

**Routing config v2** — tier blocks stop naming providers as fields and become ordered target lists:

```jsonc
{
  "schemaVersion": 2,
  "displayName": "default",
  "classifier": { "providerId": "openai", "model": "gpt-5-nano", "timeoutMs": 4000 },
  "routes": {
    "fast": {
      "targets": [
        { "providerId": "anthropic", "model": "claude-haiku-4-5", "effort": "low",
          "thinking": { "type": "adaptive", "display": "omitted" } },
        { "providerId": "openai",    "model": "gpt-5.2-mini",     "effort": "low" },
        { "providerId": "acme-vllm", "model": "qwen3-coder-30b" }
      ]
    },
    "balanced": { "...": "..." }, "hard": { "...": "..." }, "deep": { "...": "..." }
  },
  "limits": { "...": "unchanged" },
  "session": { "...": "unchanged" }
}
```

The canonical target shape — stated once, used for targets AND session pins:

```ts
type RouteTarget = {
  providerId: string;            // registry slug
  model: string;
  effort?: Effort;               // normalized ladder, below
  thinking?: AnthropicThinking;  // carried over from v1 verbatim — see migration note
  maxOutputTokens?: number;
  verbosity?: Verbosity;
  metadata?: Record<string, unknown>;   // v1 per-block metadata, preserved
};
type SessionPin = RouteTarget & { dialect: Dialect };  // resolved endpoint dialect
```

A pin is a **superset of every input the dialect-edge rewrite consumes** — that is the property that keeps pinned upstream requests byte-stable across config publishes (today's guarantee, `router.ts:422-424`). `thinking` survives into v2 rather than being folded into `effort` because v1 configs (including the seeded defaults) actively use `thinking: {type: "adaptive", display: "omitted"}`, and dropping it would silently change upstream request bytes at cutover.

**Selection rules** — stated explicitly because "ordered list" invites failover assumptions:

1. Targets are evaluated **in list order** (the org's preference order). For each target: resolve the provider slug (org shadows builtin); skip if missing, disabled, or credential-unresolvable (each skip recorded in the route decision's evidence); pick the provider's **same-dialect endpoint if one exists (byte passthrough)**, else the best translator-reachable endpoint, subject to `canServe`.
2. **Passthrough beats translation within a target; list order beats everything across targets.** An org that wants "never translate" simply orders/limits targets accordingly; `compatible` lets the editor show which targets would translate.
3. **Target lists are NOT health failover.** A 5xx from the selected upstream does not advance to the next target in V1. (Failover is a separate future scope with its own retry/idempotency semantics.)
4. **No target `canServe`** → the request is rejected with the existing `route_not_available_for_surface` error shape, and the same rule applies inside the classifier-failure route scan (`router.ts:172-182`).
5. **Dangling `providerId`** (provider row deleted after publish — jsonb has no FK): publish-time validation prevents creating it; runtime treats it as a skip with evidence, same as disabled.
6. **Pinned sessions never re-select silently, and stateful sessions never re-select at all.** If the pinned target's provider is disabled or deleted mid-session: **stateless sessions** (no provider-side conversation state — anthropic-messages harnesses replay the full conversation every turn) re-select from the current target list and record a visible `pin_rebound` decision (operationally a cache bust, counted as one); **stateful sessions** (`statefulResponses` harnesses — their `previous_response_id` was minted by the old provider, and no other provider can resolve it, same dialect or not) **fail with an explicit error, full stop**. Rebinding is not available to stateful sessions; without this, a disabled provider would route a Codex session through the rebind branch into exactly the silent cross-provider switch rule 7 exists to prevent.
7. **Stateful-Responses guard (decided at session start).** Harness profiles declare `statefulResponses` (Codex: true — it sends `previous_response_id` from turn 2). For such harnesses, **translated targets are ineligible for pinning**: the first-request selection skips targets that would require translation. This closes the loop the naive design leaves open — without it, a session pinned to a translated chat target would carry a translator-fabricated response ID on turn 2, fail `canServe`, and silently switch providers mid-conversation.

**One effort ladder** — replace the two enums with a single normalized scale:

```ts
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultracode"] as const;
```

Clamping to what a provider/model accepts is **capability-driven, one mechanism**: provider registry rows carry default `capabilities.efforts`, and catalog rows can carry model-specific `capabilities.efforts` when discovery has that data. The dialect edge maps the clamped value onto the wire field (`reasoning.effort` / `output_config.effort` + `thinking` / `reasoning_effort`) but holds **no clamp tables of its own** — there is no second mechanism to disagree with the first. The effective clamp is exposed over GraphQL (`effectiveEffort(target)`) so the web editor can show "max → xhigh on this provider" instead of clamping silently.

**Model catalog from models.dev** — the `model_catalog` table (today populated but read only as the org pricing-override store, `persistence/modelPricing.ts`) becomes the real catalog: rows keyed `(provider_id, model)` with `capabilities` (efforts, modalities, context/output limits) and `pricing` jsonb. **Stage 1 seeds it from a vendored models.dev snapshot checked into the repo** (hermetic tests, no runtime dependency); Stage 4 adds the periodic refresh job. Org rows override (custom pricing, self-hosted models the dataset doesn't know). `defaultModelPricing`, `providerFromModelName`, and the hardcoded `contextWindow: 400000` all retire — **but only once the snapshot seed is in place**; ledger pricing keys off the *attempt's* `(providerId, model)`, never name-prefix inference (pain point 10).

**HarnessProfile registry** — the scattered harness knowledge becomes one registry (the entries still *contain* sniffing functions; the point is that there is exactly one place to add a harness):

```ts
type HarnessProfile = {
  id: "claude-code" | "codex" | "opencode" | "cursor" | "generic";
  detect(headers, body): boolean;        // checked in registration order; "generic" is the
                                         // mandatory last entry and matches everything
  sessionId(headers, body): string | undefined;
  statefulResponses: boolean;            // drives selection rule 7
  identityHeaders: string[];             // x-claude-code-*, x-codex-turn-state, …
  dialectHeaders: string[];              // anthropic-beta, anthropic-version, …
  promptBlockTags: string[];             // for classifier-input stripping
  bashToolNames: string[];               // for tool-result compression rules
};
```

**Header forwarding is a (harness × provider-class) decision, not a harness decision.** `dialectHeaders` are protocol plumbing and **always** follow the request to any endpoint serving that dialect — an anthropic-messages endpoint needs `anthropic-version` (the dialect edge synthesizes it when absent, exactly as `headersFor` does today) and honors `anthropic-beta`, whether the row is builtin or org-defined. `identityHeaders` are forwarded only to **builtin** providers; org-defined providers don't receive them unless the row opts in (`forward_harness_headers = true`) — a Claude Code session ID should not leak to `acme-vllm` or DeepSeek by default. This replaces the provider-keyed allowlists in `proxy.ts:300-331` and consolidates `features.ts:46-149` and `compressionRules/bashOutput.ts` (pain point 11).

**Translator registry** — per-dialect-pair modules, each owning request-body translation, non-streaming response translation, and a streaming SSE transform:

```ts
translators.register("openai-responses", "openai-chat", { request, response, sseTransform });
```

The translated path necessarily abandons byte passthrough for that request — the translator re-emits the response in the inbound dialect, and translated requests are tagged in `route_decisions` so fidelity regressions are filterable in the console. Same-family pairs (responses↔chat) are small and well-understood: tool calls, usage fields, and event names map ~1:1. The cross-family pair (anthropic↔openai) is deferred to Stage 3 and may never be needed (see below).

## Refactor Inventory

All work, organized into four stages. Each stage is shippable and independently valuable. Per user/global convention this is a **hard cutover** — no v1-config compatibility shims; stored documents are migrated in place. A `TICKETS.md` will follow this plan (repo convention) breaking the stages into PR-sized tickets before implementation starts.

### Stage 0 — Correctness groundwork (small, do first)

| Change | Files |
|--------|-------|
| **Store verbatim, never fall back, never throw**: `surfaceValue`/`providerValue` pass through unknown non-empty strings; the `?? "openai"` / `?? "openai-responses"` fallbacks at `providerAttempt.ts:44-45`, `classifierUsage.ts:24`, `sessionRoute.ts:24`, `requestState.ts:85,220` are *replaced*, not merely deleted, distinguishing two cases: an **unknown value** is stored verbatim; an **absent value** (e.g. `requestState.ts:85` fires when `routeContext` is missing entirely, and `requests.surface` is NOT NULL) becomes the sentinel `"unknown"` — which satisfies the insert without misattributing, and surfaces as its own bucket in rollups. Throwing is NOT an option in either case: these run inside the event-projection transaction (`eventSink.ts:35`), where a throw converts a mislabeled ledger row into failed event persistence on the request hot path. | `apps/proxy/src/persistence/values.ts:89-97` + the five call sites |
| Open the **persistence column generics** so verbatim storage typechecks: `$type<Provider>`/`$type<Surface>` → `$type<string>` on `usage_ledger`, `provider_attempts`, `route_decisions`, `agent_sessions`, and `requests` (surface) columns — the `"unknown"` sentinel writes into `requests.surface`. (Compile-time only — the columns are already plain text. The *schema-package unions* open in Stage 1; this narrow slice is pulled forward so Stage 0 compiles standalone.) | `packages/db/src/schema.ts` |
| Teach `normalizeUsage` the chat-completions shape (`prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`). Inert until Stage 2 traffic exists. The Stage-0 rule for early-vs-deferred code: **pure functions with their own unit tests may land before their traffic; anything that wires into the request path waits for it** — which is why this lands here and the chat-chunk observer (below) does not. | `apps/proxy/src/persistence/values.ts:21-57` |
| Split `SseObserver` into per-dialect observer implementations behind one interface (`status`, `usage`, `outputText`, `responseId`), selected by dialect instead of heuristic key-sniffing. **Golden SSE fixtures land here, not Stage 2**: recorded streams for both existing dialects, explicitly covering Anthropic's cross-frame usage merge (`message_start` input tokens + `message_delta` output tokens, today `findUsage`+`mergeUsage` at `sseObserver.ts:89-134`) — that merge is the easiest thing to break in the split. The chat-chunk observer implementation is **Stage 2**, per the early-vs-deferred rule above: it wires into the request path, so it waits for its traffic. | `apps/proxy/src/sseObserver.ts` |

Stage 0 has no behavior change for current traffic (current traffic only ever produces the two known values) and removes the silent-misattribution landmine before anything else lands.

### Stage 1 — Provider registry + routing config v2 (the core)

Stage 1 splits into two deploys: **1a is additive** (no config-format or behavior change), **1b is the hard cutover**.

#### Stage 1a — registry plumbing (additive deploy)

- **packages/db**: `providers` table (DDL above) with builtin `anthropic` + `openai` rows seeded from current env base URLs — note the openai row carries **both** the responses and chat endpoints from day one; `provider_accounts.provider` → `provider_id` FK (backfill from the text value); nullable `provider_accounts.base_url` override; `model_catalog` re-keyed `(provider_id, model)` and **seeded from the vendored models.dev snapshot** (org pricing-override rows preserved — the table is live data, not vestigial).
- **packages/schema**: `Provider` opens to `string` (slugs); `Dialect` becomes the closed enum; `providerRegistryEntrySchema`. The v1 config schema is untouched in 1a.
- **apps/proxy**: `ProviderProxy.urlFor`/`headersFor` read the registry row (base URL, endpoint path by dialect, auth style, default headers) instead of the ternaries — for builtin rows this is byte-identical behavior; the **credential invariant** lands here (org rows: no env-key fallback, ever).

#### Stage 1b — config v2 cutover (single deploy, with migration)

**packages/schema:**

- `routingConfigRouteSchema`: `{openai?, anthropic?}` → `{targets: RouteTarget[]}` (canonical shape above, **including `thinking` and `metadata`** — v2 is not lossy).
- `sessionPinnedSettingsSchema`: discriminated-union-on-provider → `SessionPin` (target superset + resolved `dialect`).
- Single `EFFORTS` ladder replaces `OPENAI_REASONING_EFFORTS` + `ANTHROPIC_EFFORTS`; clamps come from provider/model capability data (one mechanism — see Core concepts).
- `routingConfigClassifierSchema.provider` → `providerId: string`, **validated at publish time to resolve to a provider with a responses-dialect endpoint** until Stage 2 ships the chat classifier client (today's `z.literal("openai")` guard moves from code to validation, it does not silently disappear).
- `schemaVersion: 2`.

**packages/db — the migration** (see Migration & Rollout for the full procedure):

- Rewrite every `routing_config_versions.config` jsonb v1→v2: `.openai` block → target `{providerId: "openai", ...}`; `.anthropic` block → `{providerId: "anthropic", ...}` carrying `thinking`/`metadata` verbatim; migrated lists are ordered `[anthropic, openai]` (order is inert until translators exist in Stage 2, since each request matches exactly one target by dialect).
- **Recompute `config_hash`** for every rewritten row (`configHash = sha256(JSON.stringify(config))`, `persistence/routingConfigAdmin.ts:53`) — the hash-of-content invariant backs version dedupe and the unique `(org, workspace, hash)` index (`packages/db/src/schema.ts`, `routing_config_versions` hash index). Because v2 is lossless, two distinct v1 documents cannot collapse to one v2 document; a **pre-flight collision check** asserts this before writing and aborts the migration (nothing written) if it ever fails.
- Clear `agent_sessions.pinnedSettings` (sessions re-pin on next request; operationally a one-time cache-bust window, called out in the rollout).
- Migrate `organization_settings` baseline keys: `costBaselineAnthropicModel`/`costBaselineOpenaiModel` (`persistence/organizationSettings.ts:21-22`) → a per-dialect map `{"anthropic-messages": …, "openai-responses": …}`; the `openai-chat` entry defaults to the responses entry until an org sets it. (This resolves what was previously an open question: **per-dialect**, not per-surface.)

**apps/proxy:**

- `adapters.ts`: `SurfaceAdapter` drops its embedded `provider` field and gains `dialect`; `rewriteSurfaceRequest` dispatches a per-dialect rewriter by the *selected endpoint's* dialect and stops throwing on mismatch (that's `canServe`'s job upstream). The anthropic-only cache transforms (`injectAutomaticCacheControl`, `upgradeCacheControlTtl`) become part of the anthropic-messages dialect edge.
- `router.ts`: `resolveProviderSettings` implements Selection rules 1–7; `settingsForSurface` deleted; the inline `minimal→low` mapping replaced by catalog-driven clamping; session pin handling implements rule 6 (`pin_rebound` decisions + explicit stateful failure).
- `wsProxy.ts` — **mechanically updated in this deploy, not Stage 4**: it imports `rewriteSurfaceRequest` and drives `RoutingService` directly, so it cannot compile against the new signatures untouched, and left as-is it would rewrite a request for a custom target but still send it to `${openaiBaseUrl}/responses` with the company key (`wsProxy.ts:414,421-424`) — wrong host, wrong credentials. In 1b the WS path reads URL/auth from the selected target's registry row, and `canServe` on the WS transport additionally requires a builtin provider with operator credentials (the WS path has no BYOK today; that gap closes with Stage 4 unification).
- `catalog.ts`: delete the env-seeded 8-entry `ModelCatalog` and surface-scoped alias maps. Env vars `OPENAI_*_MODEL`/`ANTHROPIC_*_MODEL` survive only as **seed inputs** for the default routing config. **Test budget**: five proxy test files run with `DATABASE_URL: ""` against the env-catalog path (`apps/proxy/test/proxy.test.ts:13`, `cacheTtlUpgrade.test.ts:192`, `promptTestFixture.ts:35`, `setupScript.test.ts:12`, `tokenAttribution.test.ts:153,199`); retiring the path means porting them to a seeded in-memory registry/config fixture — this is a real ticket, not a footnote.
- Aliases: one dialect-agnostic map `alias → tier`; all existing spellings (`router-*`, `claude-router-*`, `anthropic-router-*`) remain valid on every surface (decided here, not left open).
- `classifier.ts`: takes a provider registry entry; request body built by the provider's responses-dialect endpoint; `config.ts` drops the `z.literal("openai")` in favor of the publish-time validation above.
- `pricing.ts`: `defaultModelPricing` and `providerFromModelName` retire in favor of catalog lookups keyed by the attempt's `(providerId, model)` — safe because the vendored snapshot landed in 1a; `CostBaseline` becomes the per-dialect map; `orgPricingOverrideForModel` drops its provider allowlist.
- `features.ts` / compression / attribution: branch on dialect + harness profile instead of surface literals (`tokenAttribution.ts`, `toolResultCompression.ts`, `persistence/promptArtifacts.ts`, `persistence/cacheBusts.ts`).
- `server.ts`: `/v1/models` generated from aliases + registry.

**GraphQL + web (apps/web)** (same deploy as 1b — the editor writes configs, so it cannot lag the format):

- `RouteMatrixRow` (`openaiModel/anthropicModel/openaiEffort/anthropicEffort`) → `targets: [RouteTarget]`; serializers in `persistence/adminSerializers.ts` follow.
- Provider CRUD: list/create/update org providers (endpoints, base URL, auth style, non-auth headers, `forward_harness_headers`) + credential attach — extends the existing providers page (`apps/web/src/providers/`). Publish-time `compatible` validation surfaces "this target will translate / cannot serve surface X" in the editor.
- Routing editor: `RouteTierDraft`'s four provider-named string fields → an ordered target-list editor; `PROVIDER_MODEL_OPTIONS` hardcoded list → models from the catalog via GraphQL; `EFFORT_SCALE` merge hack → the single ladder, with `effectiveEffort` shown so clamping is visible, never silent.

**Shippable outcome of Stage 1:** Claude Code tiers can target DeepSeek/GLM/Kimi (anthropic-dialect hosts); Codex tiers can target any responses-compatible endpoint; opencode connects via baseURL override on its anthropic or openai provider; ledger attribution **and pricing** are honest for all of it (snapshot-seeded catalog — no $0-forever rows, the failure mode `repriceZeroCostUsage` exists to heal).

### Stage 2 — The openai-chat dialect (inbound + outbound)

**Inbound surface:**

- `POST /v1/chat/completions` route in `server.ts` with a chat-dialect `SurfaceAdapter` (RouteContext extraction from `messages[]`, `tools[]`, image parts).
- Chat-chunk SSE observer (interface from Stage 0; implementation lands with its traffic); `stream_options.include_usage` injected when absent so usage is observable.
- Harness profiles for **opencode** (`@ai-sdk/openai-compatible` path; it already sends `prompt_cache_key` = session ID on the openai path, which the Codex profile logic already reads) and **Cursor** (flat-tool normalization quirks per the BYOK research).
- `/v1/messages/count_tokens` stays anthropic-only; the chat surface 404s there (callers don't expect it).
- **Persistence/console ripple of the third surface value** (this is the part that's easy to forget): `requests.surface`, `provider_attempts.surface`, `route_decisions`, ledger rollup grouping (`usageRollups` splits by surface), the per-dialect baseline map (entry added in 1b), and the web console's logs/usage filters all gain `openai-chat`. Stage 0/1 opened the column types; this stage sweeps the read paths and filter UIs.

**Outbound:**

- Registry rows whose endpoint list includes `{dialect: "openai-chat", path: "/chat/completions"}` — the row shape for vLLM, Ollama, llama.cpp, Groq, Fireworks, Together, OpenRouter. (No new mechanism: the builtin openai row has carried its chat endpoint since 1a.)

**Translators (same-family pair):**

- `openai-responses ↔ openai-chat`, both directions: request mapping (`instructions`+`input` ↔ `messages`, tool definitions, `reasoning.effort` ↔ `reasoning_effort`, `max_output_tokens` ↔ `max_completion_tokens`), response mapping, and streaming transform (`response.output_text.delta` ↔ chat chunk deltas, tool-call item events ↔ `tool_calls` deltas, usage frames). Golden-transcript fixtures (pattern established in Stage 0) are the regression harness.
- Statefulness is handled by **Selection rule 7 at session start** (stateful harnesses never pin translated targets) plus the per-request `canServe` blocker as the backstop — there is no silent mid-session fallthrough by construction.

**Shippable outcome of Stage 2:** Codex traffic routable to every OSS/chat-compatible host; Cursor BYOK and plain `openai`-SDK callers can hit the proxy; opencode connects via its default `openai-compatible` path. (Chat-surface → Anthropic still requires Stage 3.)

### Stage 3 — Cross-family translation (deferred, possibly forever)

The driver: routing **Claude Code traffic to chat-only OSS hosts** (vLLM et al. don't speak anthropic-messages). Counter-pressure: hosted anthropic-dialect OSS endpoints (Stage 1) and anthropic-compatible shims in front of vLLM may cover real demand first. **Decision: deferred indefinitely — not scheduled.** The trigger to revisit is a named customer needing Claude Code traffic on a chat-only host after Stage 2 ships; absent that, this stage is not built.

Scope if built:

- `anthropic-messages ↔ openai-chat` translators (request, response, SSE). The event models differ structurally (content blocks vs deltas; `message_stop` vs `finish_reason`), tool-call shapes differ, and system prompts move between a top-level field and a message role.
- **Non-translatables, enforced by the per-request `canServe` blocker**: signed/redacted thinking blocks (Anthropic) cannot be replayed to another provider; OpenAI encrypted reasoning items likewise; `cache_control` markers are dropped with a translation note. The per-request check is the real rule — it also covers resumed or compacted sessions whose history carries signed blocks from a pre-pin provider. Selection rule 7 keeps the common case (an active pinned session) from ever reaching the blocker.
- Explicitly out: translating `count_tokens`, and any attempt at cross-provider cache-equivalence.

### Stage 4 — Consolidation (cleanup, can interleave)

- Unify `wsProxy.ts` onto the shared pipeline (capture, compression, BYOK — the URL/auth/registry mechanics already moved in 1b) with a transport adapter; lift the builtin-only restriction from the WS transport's `canServe`.
- models.dev **refresh job**: fetch `models.dev/api.json` daily; **additive-upsert, accept-latest** — new models and price changes apply, org overrides always win, rows are never auto-deleted or capability-downgraded by a refresh, and each refresh writes an audit row; the vendored snapshot (1a) remains the hermetic-test fixture and the cold-start seed.
- Retire `route_policies` (written only by seed, read nowhere).
- Delete the `Proxy/` dead prototype directory.

## Migration & Rollout

1. **Stage 0 ships silently** (no config or API change). Verify ledger rows unchanged for live traffic.
2. **Stage 1a ships additively**: registry tables + seeds + catalog snapshot + `ProviderProxy` reading builtin rows. Byte-identical upstream behavior; verifiable by diffing recorded upstream requests before/after.
3. **Stage 1b is the hard cutover**, one deploy containing the jsonb migration:
   - Pre-flight (read-only): for every `routing_config_versions` row, compute the v2 document, **assert no `(org, workspace, hash)` collisions** among recomputed hashes, and run the **dry-run selection diff** — for each org config and each dialect, assert v1 selection ≡ v2 selection (model, effort, thinking, maxOutputTokens). Any mismatch aborts before anything is written.
   - Write: rewrite `config` jsonb + recomputed `config_hash`; clear `agent_sessions.pinnedSettings`; migrate `organization_settings` baseline keys.
   - Rollback: restore **the `routing_config_versions` and `organization_settings` tables** from the pre-migration snapshot (these are the only tables the migration writes that hold durable state; `agent_sessions` is live-written and must NOT be snapshot-restored — pins regenerate).
   - Expected operational blip: one cache-bust window as sessions re-pin; announce it.
4. **Stage 2** adds surface + translators; new endpoints are additive. Cursor/opencode onboarding docs follow.
5. Tests: proxy/db suites run against `dist` — every schema-package change requires `build:runtime` rebuild before test runs. The five `DATABASE_URL: ""` test files are ported in 1b (budgeted ticket). Golden SSE fixtures start in Stage 0; translator golden transcripts extend them in Stage 2.
6. **A TICKETS.md follows this plan** (repo convention, as in `routing-configs-v1`) breaking 0/1a/1b/2 into PR-sized tickets before implementation starts.

## Risks

| Risk | Mitigation |
|------|------------|
| Org-defined provider used to exfiltrate operator API keys | **Credential invariant** (Core concepts): org rows never fall back to env keys; credential required unless `auth_style: "none"`; auth-bearing keys rejected in `default_headers` |
| jsonb migration corrupts a config or trips the hash unique index | v2 schema is lossless (carries `thinking`/`metadata`); pre-flight recomputes hashes and asserts no collisions; dry-run diffs v1-vs-v2 *selections* per dialect; any failure aborts with nothing written |
| Mid-session provider switches via translated targets | Selection rule 7 (stateful harnesses never pin translated targets) + rule 6 (pins never silently re-select; `pin_rebound` is visible, stateful mismatch fails explicitly) |
| WS path sends rewritten requests to the wrong host/credentials after Stage 1 | wsProxy registry/auth mechanics move in **1b** (not Stage 4); WS `canServe` restricted to builtin providers until Stage 4 unification |
| Translated-path fidelity (tool-call edge cases, usage frames) | Golden-transcript fixtures per translator (pattern from Stage 0); translated requests tagged in `route_decisions` so regressions are filterable in the console |
| OSS hosts report usage inconsistently (or not at all on stream) | Stage 0 chat usage normalization + `stream_options.include_usage` injection; ledger rows with no usage already exist as a handled case |
| OSS traffic books $0 cost | Vendored models.dev snapshot seeds the catalog in **1a**, before the static pricing table retires in 1b; `repriceZeroCostUsage` remains the backstop |
| Effort clamping surprises (fable-5 rejects `thinking: disabled`, haiku rejects `effort`, dotted gpt-5.x rejects `minimal`) | Single mechanism: provider/model `capabilities.efforts` drives the clamp; unknown models get the conservative mapping (omit the knob); `effectiveEffort` exposed to the editor so clamping is visible |
| SSRF via org-defined base URLs | Scheme allowlist; link-local/metadata ranges blocked unconditionally; private (RFC-1918) ranges blocked **unless covered by the operator-level `ALLOWED_PRIVATE_UPSTREAM_CIDRS`** (the self-hosted-vLLM escape hatch — see Network invariant; operator config, never org config, so the control doesn't contradict Goal 2); **`redirect: "manual"`** on org-row upstream fetches (today's `fetch` at `proxy.ts:68` follows redirects — a 302 to `169.254.169.254` would bypass a resolve-time check); connect-time IP pinning to the resolved address to defeat DNS rebinding |
| Classifier pointed at a provider that can't serve it | Publish-time validation: classifier `providerId` must resolve to a responses-dialect endpoint until Stage 2; existing `timeoutMs` + fallback-route behavior unchanged (gpt-5-nano ~4s floor documented) |

## Decided Questions

Questions raised by earlier drafts, each now resolved in the body:

1. **Custom provider scope** — org-scoped only in V1; builtins change via seed migrations; promotion to builtin is a manual operation, not a product feature (Provider registry).
2. **models.dev refresh trust** — additive-upsert, accept-latest, with audit rows; never auto-deletes or downgrades; org overrides always win; the vendored snapshot stays the cold-start seed and hermetic-test fixture (Stages 1a/4).
3. **Stage 3 cross-family translation** — deferred indefinitely; revisit only on a named customer need for Claude Code traffic to a chat-only host after Stage 2 (Stage 3).
4. **Cost baseline shape** — per-dialect map, not per-surface (Stage 1b migration).
5. **Alias namespace** — one dialect-agnostic `alias → tier` map; all existing spellings valid on every surface (Stage 1b).

## Appendix: How opencode connects (today vs after)

| Path | Today | After Stage 2 |
|------|-------|---------------|
| opencode custom provider, `npm: "@ai-sdk/anthropic"`, baseURL → proxy `/v1/messages` | ⚠️ routes correctly (anthropic-dialect targets only); no opencode harness profile yet, so session pinning/continuity falls back to generic extraction and harness prompt-block stripping uses defaults | ✅ profile + OSS targets via registry |
| opencode custom provider, `npm: "@ai-sdk/openai"` (forces Responses API), baseURL → `/v1/responses` | ⚠️ routes correctly (openai-dialect targets only); generic session handling, same caveat | ✅ + chat-dialect targets via translator |
| opencode default `@ai-sdk/openai-compatible`, baseURL → `/v1/chat/completions` | ❌ surface doesn't exist | ✅ |
| Cursor BYOK (OpenAI base-URL override, chat completions) | ❌ | ✅ (with Cursor harness profile) |
| Plain `anthropic` / `openai` SDKs pointed at the proxy | ⚠️ / partial (messages works; responses only, no chat) | ✅ / ✅ |

Router aliases (`router-fast`, `claude-router-balanced`, …) are the model IDs harnesses configure; explicit-alias routing and the classifier path are identical across all surfaces. The "today" rows are design inference from opencode's source — not yet validated against a live opencode install.
