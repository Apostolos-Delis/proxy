# Open Model And Bedrock Provider Support V1

## Goal

Support routing to open-source, self-hosted, hosted OpenAI-compatible, hosted Anthropic-compatible, and AWS Bedrock models without weakening the proxy's core guarantees:

1. Native harness fidelity remains the default path.
2. Provider-specific behavior stays behind provider adapters or translators.
3. Provider credentials never leak across organization or operator boundaries.
4. Every route decision, provider attempt, usage record, and health decision remains durable and auditable.
5. Raw prompt text still only lands in `prompt_artifacts.raw_text`.

This scope answers the immediate product question: adding OpenAI-compatible OSS providers is modest work; adding native AWS Bedrock is a real adapter project.

## Executive Answer

### How hard is it?

| Target | Difficulty | Why |
| --- | --- | --- |
| Self-hosted or hosted OpenAI-compatible models, such as vLLM, Ollama, LM Studio, llama.cpp, Together, Fireworks, Groq, DeepInfra, OpenRouter, and many custom gateways | Low to medium | The repo already has provider registry rows, provider endpoints by dialect, base URL validation, custom-provider auth rules, request translators, response translators, and model catalog infrastructure. The work is mostly config, admin, health, catalog, routing target polish, and compatibility tests. |
| Anthropic-compatible OSS endpoints, such as hosted Claude-Code-compatible providers | Medium | Same registry path works when the provider really speaks `anthropic-messages`, but Anthropic cache-control, tool use, signed thinking, and beta headers need explicit compatibility gating. |
| Bedrock through an OpenAI-compatible bridge, such as LiteLLM or Kong AI Proxy in front of Bedrock | Low to medium | Proxy can treat the bridge as an OpenAI-compatible provider. This is a good spike or customer-specific bridge, but it moves Bedrock auth, model discovery, guardrails, and observability outside Proxy. |
| Native AWS Bedrock Converse/ConverseStream | Medium-high | Bedrock needs AWS credential resolution, SigV4 or SDK auth, region and inference-profile handling, Converse request translation, ConverseStream event normalization, Bedrock model discovery, guardrail/service-tier controls, and Bedrock-specific health/error mapping. It should not be squeezed into the current `bearer | x-api-key | none` HTTP provider path. |

### Rough implementation size

These are engineering-order estimates, not commitments.

| Slice | Estimate | Notes |
| --- | --- | --- |
| OpenAI-compatible OSS MVP | 1-2 weeks | Provider setup, model catalog entries, route validation, admin affordances, smoke tests with a local OpenAI-compatible server. |
| Provider adapter split | 1-2 weeks | Keep current OpenAI/Anthropic behavior stable while separating generic HTTP forwarding from provider-specific transports. |
| Native Bedrock Claude-only MVP | 2-3 weeks after adapter split | AWS SDK auth, region config, Converse/ConverseStream translation, Claude tool/usage/stream handling, gated live test. |
| Production-grade Bedrock support | 4-6 additional weeks | Model discovery, inference profiles, guardrails, service tier, admin UI, credential policy, health/cooldowns, cost/catalog coverage, broader model-family tests. |

The elegant path is to ship OpenAI-compatible OSS support first, then introduce a provider-adapter boundary, then implement Bedrock as the first non-generic adapter.

## References Reviewed

### Local reference implementations

- `~/Documents/repos/opencode/packages/opencode/src/provider/provider.ts`
- `~/Documents/repos/opencode/packages/opencode/test/provider/amazon-bedrock.test.ts`
- `~/Documents/repos/hermes-agent/agent/bedrock_adapter.py`
- `~/Documents/repos/hermes-agent/agent/transports/bedrock.py`
- `~/Documents/repos/hermes-agent/tests/agent/test_bedrock_adapter.py`
- `~/Documents/repos/hermes-agent/tests/agent/transports/test_bedrock_transport.py`
- `~/Documents/repos/openclaw-upstream/extensions/amazon-bedrock/`
- `~/Documents/repos/openclaw-upstream/packages/llm-runtime/src/api-registry.ts`
- `~/Documents/repos/openclaw-upstream/packages/llm-core/src/types.ts`
- `~/Documents/repos/openclaw-upstream/src/llm/env-api-keys.ts`
- `~/Documents/repos/openclaw-upstream/src/agents/model-auth.ts`

### Existing Proxy research docs

- `docs/research/litellm-scope.md`
- `docs/research/kong-scope.md`
- `docs/scopes/provider-architecture-v1/PLAN.md`
- `docs/scopes/harness-model-translation-v1/PLAN.md`
- `docs/scopes/routing-configs-v1/PLAN.md`

### Public docs and source references

- [LiteLLM](https://github.com/BerriAI/litellm)
- [LiteLLM Bedrock provider docs](https://docs.litellm.ai/docs/providers/bedrock)
- [Kong](https://github.com/Kong/kong)
- [Kong AI Proxy plugin docs](https://developer.konghq.com/plugins/ai-proxy/)
- [Kong Amazon Bedrock provider docs](https://developer.konghq.com/ai-gateway/ai-providers/bedrock/)
- [AWS Bedrock Converse API user guide](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
- [AWS Bedrock inference profiles user guide](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html)

## Current Proxy State

The repository is already partway to this architecture.

### What already helps

- `apps/proxy/src/persistence/providers.ts` models providers as registry entries with:
  - `slug`
  - `baseUrl`
  - `authStyle`
  - `endpoints`
  - endpoint `dialect`
  - `forwardHarnessHeaders`
  - custom-provider network validation
- `apps/proxy/src/adapters.ts` already separates caller surface from provider dialect enough to find translators.
- `apps/proxy/src/translators/` already contains request, response, and SSE transforms across current dialects.
- `apps/proxy/src/proxy.ts` already resolves the selected provider row, provider endpoint, request translator, response translator, and provider-account credential before sending upstream.
- `apps/proxy/src/modelDiscovery.ts` exposes OpenAI-shaped model discovery backed by the model catalog.
- `apps/proxy/src/jobs/modelCatalogRefresh.ts` already imports provider/model capability data from `models.dev`.
- `docs/scopes/provider-architecture-v1/PLAN.md` already defines provider rows as the desired direction for OSS/self-hosted models.

### What blocks Bedrock today

- `packages/schema/src/index.ts` limits provider auth styles to `bearer`, `x-api-key`, and `none`.
- `apps/proxy/src/proxy.ts` sends generic JSON over `fetchWithPinnedAddress`; AWS SDK/SigV4 is not represented.
- `providerRequestHeaders` can create bearer and x-api-key headers, but cannot sign AWS requests, assume roles, use web identity, use container credentials, or use Bedrock bearer-token auth safely.
- Provider endpoints are HTTP path records. Bedrock Converse is better modeled as an adapter operation than as a static path.
- Current dialects are `openai-responses`, `openai-chat`, and `anthropic-messages`; there is no internal `bedrock-converse` dialect.
- Model catalog refresh maps known HTTP providers; it does not call `ListFoundationModels` or `ListInferenceProfiles`.
- Routing config still has OpenAI/Anthropic-shaped deployment blocks in places, even though provider rows exist.
- Admin/provider auth docs do not describe AWS credential modes or Bedrock region/model access testing.

## Findings From Reference Implementations

### opencode

opencode gets broad provider coverage by leaning on Vercel AI SDK provider adapters. Most providers are configuration around an adapter; Bedrock is one of the custom loaders.

Useful Bedrock details to copy conceptually:

- Region precedence: configured region, `AWS_REGION`, then fallback.
- Profile precedence: configured profile, then `AWS_PROFILE`.
- Credential discovery recognizes access keys, web identity, container credentials, Bedrock bearer token, and SDK default chain.
- Custom endpoint support accepts configured endpoint/base URL.
- Bedrock inference-profile IDs must not be double-prefixed.
- Cross-region prefixing is model-family and geography aware.
- Tests cover region/profile precedence, bearer-token auth, custom endpoints, web identity, and double-prefix prevention.

What not to copy directly:

- opencode is a request origin. It owns a canonical request shape and can route everything through SDK adapters.
- Proxy is a middleman. It must preserve incoming harness wire behavior unless translation is explicitly required.

### Hermes Agent

Hermes implements native Bedrock Converse through boto3. It is the best local reference for the amount of protocol work required.

Useful details:

- Lazy boto3 import and minimum-version checks.
- Runtime and control-plane client caching by region.
- Stale connection detection and client eviction.
- Fallback from streaming to non-streaming when `InvokeModelWithResponseStream` is denied.
- Credential detection for Bedrock bearer token, static keys, profile, container credentials, web identity, and default chain.
- Region resolution from environment and boto3 profile before fallback.
- Model discovery through foundation models and inference profiles.
- Filtering active text-output and streaming-capable models.
- Tool support denylist for models that look chat-like but do not support tools.
- OpenAI tool conversion to Bedrock `toolConfig`.
- Message conversion into Converse `messages` plus separate `system`.
- Tool-call and tool-result conversion.
- Consecutive-role merging and role alternation handling.
- Image byte conversion.
- Response normalization into OpenAI-compatible shape.
- Streaming event handling for content blocks, tool blocks, stop reasons, metadata, usage, and reasoning deltas.

This confirms Bedrock is not just "another base URL"; it is request/response semantics plus AWS auth.

### OpenClaw

OpenClaw is the closest architectural match because it treats Bedrock as a plugin/API family.

Useful details:

- `bedrock-converse-stream` is a distinct API family.
- Provider registration is explicit and pluggable.
- AWS SDK auth is represented as a different auth mode, not an API key.
- The Bedrock extension owns runtime streaming, model discovery, embeddings, guardrails, thinking configuration, and service-tier behavior.
- Discovery merges foundation models and inference profiles.
- Static context-window fallback data is necessary because Bedrock APIs do not expose every routing/cost attribute Proxy needs.
- Runtime sends `ConverseStreamCommand`, handles AWS SDK events, maps exceptions, and exposes payload/response hooks.
- Guardrails, inference profiles, request metadata, and service tier are model/provider options rather than generic prompt fields.

OpenClaw's plugin boundary is the strongest signal for Proxy's design: add a provider adapter seam before adding native Bedrock.

### LiteLLM

LiteLLM supports many providers and exposes Bedrock behind a common OpenAI-compatible gateway. Its Bedrock docs state that LiteLLM uses boto3 for traditional AWS auth and supports Bedrock API-key style auth as well. Its proxy config supports AWS access keys, session tokens, profile names, role names, web identity tokens, region names, runtime endpoints, and `api_key`.

What to borrow:

- Model groups/deployments.
- Per-deployment credentials.
- Health checks and cooldowns.
- Fallback and retry evidence.
- Budget and spend attribution.
- Provider-specific extra parameters at the edge.
- Broad admin workflows for keys, teams, providers, budgets, and spend.

What not to borrow as the core:

- SDK-normalized request handling as the mandatory hot path.
- Silent normalization that could perturb Codex or Claude Code traffic.
- Eventual-consistency spend writes in place of Proxy's event/outbox/current-state transaction rule.

LiteLLM is a good bridge option if we want Bedrock quickly without owning native integration yet.

### Kong

Kong's AI Proxy supports a broad provider set, including Bedrock, and its Bedrock provider docs map chat/completions/function-calling to Converse and ConverseStream. Kong also supports native Bedrock formats, guardrail configuration, AWS region settings, explicit auth configuration, and cross-region inference-profile prefixes.

What to borrow:

- Phase-based request handling.
- Explicit provider/capability validation.
- Safe config activation.
- Separation of configured model, auth, upstream, request transform, response transform, streaming, and logging.
- Native-vs-normalized format selection.
- Provider capability tables surfaced in docs/admin.

What not to borrow:

- General API gateway scope.
- Arbitrary plugin execution before Proxy's internal policy phases are stable.
- Treating Proxy as a generic HTTP gateway rather than an LLM routing service.

## Product Requirements

### V1 requirements

1. Operators can register OpenAI-compatible providers with a base URL, auth style, endpoint dialects, model list, and network policy.
2. Operators can target those providers from routing configs.
3. Proxy records native-vs-translated compatibility and skip reasons in route decision evidence.
4. Proxy rejects provider targets that require unsupported translation.
5. Proxy preserves same-dialect passthrough for OpenAI and Anthropic builtins.
6. Proxy supports at least one local OpenAI-compatible smoke target.
7. Proxy can model Bedrock provider accounts without leaking operator credentials to custom providers.
8. Native Bedrock work introduces an adapter boundary before AWS-specific code enters the hot path.
9. Bedrock requests support both non-streaming and streaming Converse.
10. Bedrock usage, finish reason, model ID, region, and provider account are captured in events and ledger projections.
11. Bedrock model discovery imports foundation models and inference profiles into the model catalog.
12. Admin UI shows whether a route target is native, translated, unsupported, unhealthy, uncredentialed, or unavailable in the selected region.

### Non-goals for this scope

- Embeddings, images, video, rerank, batches, or Bedrock agents.
- Full LiteLLM/Kong-compatible feature parity.
- Arbitrary provider plugin execution by tenants.
- Routing classifier migration to Bedrock.
- A deterministic routing fallback that bypasses the LLM classifier.
- Silent migration of existing OpenAI/Anthropic route config semantics.
- Support for tenant-supplied filesystem paths to AWS credential files.
- Native Bedrock runtime support for non-Claude model families.
- Bedrock assume-role provider accounts.
- Bedrock application inference profile discovery.
- Claude-on-Bedrock prompt caching and thinking parity beyond explicit safe rejection of non-portable provider state.

## Target Architecture

```text
caller surface
  OpenAI Responses | OpenAI Chat | Anthropic Messages
        |
        v
surface parser and route context
        |
        v
routing config tier -> ordered target list
        |
        v
provider registry row + provider account + model catalog capability
        |
        v
provider adapter
  - generic-http-json
  - aws-bedrock-converse
        |
        v
request translator if dialect differs
        |
        v
upstream call
        |
        v
response or stream translator
        |
        v
SSE/usage observer + event/current-state writes
```

### Provider adapter contract

`ProviderProxy` should stop being responsible for every provider transport. It should orchestrate a provider adapter selected from the provider registry.

Conceptual shape:

```ts
type ProviderAdapterKind = "generic-http-json" | "aws-bedrock-converse";

type ProviderAdapter = {
  prepare(input: ProviderPreparedRequestInput): Promise<ProviderPreparedRequest>;
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
  stream(input: ProviderStreamInput): Promise<ProviderStreamResult>;
  classifyError(error: unknown): ProviderErrorClassification;
  discoverModels?(input: ProviderDiscoveryInput): Promise<ModelCatalogCandidate[]>;
};
```

The existing behavior becomes `generic-http-json`. Bedrock becomes `aws-bedrock-converse`.

Adapter responsibilities:

- Resolve transport-specific credentials.
- Build upstream request parameters.
- Enforce provider-specific capability gates.
- Send non-streaming and streaming requests.
- Normalize provider errors into Proxy categories.
- Expose usage and response metadata.
- Provide model discovery when the provider has a control plane.

The orchestrator remains responsible for:

- Authentication of the caller.
- Workspace/organization scoping.
- Prompt capture decisions.
- Classification and route selection.
- Event sequencing.
- Usage ledger writes.
- Provider-account health updates.
- Budget/rate-limit decisions.

### Dialects

Current external dialects:

- `openai-responses`
- `openai-chat`
- `anthropic-messages`

Add one internal provider dialect:

- `bedrock-converse`

`bedrock-converse` should be a provider-side dialect, not a public caller surface in V1. This keeps the public API stable while giving translators and capability checks a concrete target.

Compatibility check:

```text
native if provider endpoint dialect == caller surface dialect
translated if translator exists from caller dialect to provider dialect
unsupported otherwise
```

Runtime blockers are separate from static compatibility:

- Stateful OpenAI Responses requests with `previous_response_id` that cannot be served by the selected provider.
- Anthropic signed thinking blocks crossing providers.
- Encrypted reasoning items crossing providers.
- Tools requested for a model that does not support tool use.
- Images requested for a model that does not support images.
- Bedrock guardrail or service-tier config applied to non-Bedrock targets.
- Missing provider credential.
- Region/model access denied.

## Data Model Changes

### Provider registry

Add a provider adapter kind:

```ts
type ProviderAdapterKind = "generic-http-json" | "aws-bedrock-converse";
```

Add to provider rows:

- `adapterKind`
- `adapterConfig`
- optional `regions`
- optional `defaultRegion`
- optional `modelDiscovery`

For generic HTTP providers:

```json
{
  "adapterKind": "generic-http-json",
  "baseUrl": "http://localhost:8000/v1",
  "authStyle": "bearer",
  "endpoints": [
    { "dialect": "openai-chat", "path": "/chat/completions" }
  ]
}
```

For Bedrock:

```json
{
  "slug": "amazon-bedrock",
  "adapterKind": "aws-bedrock-converse",
  "authStyle": "aws-sdk",
  "adapterConfig": {
    "service": "bedrock-runtime",
    "controlPlaneService": "bedrock",
    "defaultRegion": "us-east-1",
    "supportsBearerToken": true,
    "supportsInferenceProfiles": true
  },
  "endpoints": [
    { "dialect": "bedrock-converse", "operation": "Converse" },
    { "dialect": "bedrock-converse", "operation": "ConverseStream" }
  ]
}
```

This requires endpoint records to become a discriminated shape: generic HTTP endpoints keep `path`, while non-HTTP adapters use an operation identifier. Do not use an empty `path` sentinel for Bedrock; it conflicts with the current HTTP endpoint validation and hides the adapter boundary.

### Auth style

Current auth styles:

- `bearer`
- `x-api-key`
- `none`

Add:

- `aws-sdk`

Do not model AWS as `bearer` even though Bedrock now supports bearer-token API keys. The credential resolver needs to support multiple AWS modes and choose the correct one safely.

Provider account credential modes:

| Mode | V1 support | Notes |
| --- | --- | --- |
| `aws_default_chain` | Yes for operator-managed builtin Bedrock | Uses the process environment/runtime identity. Never for org-defined arbitrary providers. |
| `aws_bedrock_bearer_token` | Yes | Store encrypted or secret-reference value. Also maps to `AWS_BEARER_TOKEN_BEDROCK` in local dev. |
| `aws_static_keys` | Yes | Access key, secret key, optional session token. Store encrypted or through secret refs. |
| `aws_profile` | Local/dev only unless explicitly allowed | Do not accept tenant-supplied credential file paths. |
| `aws_web_identity` | Yes for deployment-bound identities | Prefer environment/default chain in production. |
| `aws_assume_role` | Post-V1 | Role ARN plus external ID/tenant-bound trust policy. Keep it out of V1 so AWS auth can ship with default-chain, bearer-token, and encrypted static credentials first. |

Credential invariant:

- Builtin `amazon-bedrock` may use operator-managed default chain if configured.
- Org-defined providers cannot receive operator AWS credentials.
- Tenant input cannot select `AWS_SHARED_CREDENTIALS_FILE`, arbitrary profile file paths, or link-local metadata endpoints.
- Secret-bearing headers remain disallowed in `default_headers`.

### Model catalog

Bedrock catalog rows need:

- `providerSlug = "amazon-bedrock"`
- `modelId`
- `displayName`
- `region`
- `source`: `foundation_model`, `inference_profile`, or `application_inference_profile`
- `inferenceProfileArn` when applicable
- `dialects = ["bedrock-converse"]`
- `inputModalities`
- `outputModalities`
- `supportsStreaming`
- `supportsTools`
- `supportsImages`
- `supportsReasoning`
- `supportsPromptCaching`
- `supportsGuardrails`
- `contextWindow`
- `maxOutputTokens`
- `pricing`
- `catalogSource`
- `catalogUpdatedAt`

Bedrock control-plane APIs do not expose every context-window, tool, pricing, and model-family quirk needed for routing. Use a layered source:

1. `ListFoundationModels`
2. `ListInferenceProfiles`
3. curated static metadata for context windows, max output, reasoning, tool support, and pricing
4. operator overrides
5. org overrides where allowed

### Provider health

Provider health should include region and model scope:

- provider account health
- provider region health
- provider model health
- inference profile health
- streaming permission health

Error categories:

- auth missing
- auth denied
- model access denied
- region unavailable
- model unavailable
- rate limited
- quota exceeded
- context too large
- unsupported request shape
- guardrail intervention
- upstream timeout
- upstream transport failure
- stream permission denied

These become route skip reasons and admin UI evidence.

## Routing Config

The current config still has OpenAI/Anthropic-shaped route blocks in places. Bedrock and OSS providers are easier to support if route targets become provider-agnostic.

Proposed target shape:

```json
{
  "provider": "amazon-bedrock",
  "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "providerAccountId": "uuid",
  "dialect": "bedrock-converse",
  "region": "us-east-1",
  "effort": "medium",
  "streaming": "auto",
  "bedrock": {
    "guardrailIdentifier": "optional",
    "guardrailVersion": "optional",
    "serviceTier": "default",
    "requestMetadata": {
      "workspace": "optional"
    }
  }
}
```

For OpenAI-compatible OSS:

```json
{
  "provider": "local-vllm",
  "model": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
  "dialect": "openai-chat",
  "effort": "low"
}
```

Activation-time validation:

- Provider slug resolves in organization scope.
- Provider endpoint or translator supports the caller surface.
- Provider account can be resolved.
- Builtin env fallback is not used for org-defined providers.
- Model exists in catalog or is explicitly marked as unlisted/manual.
- Model capability supports requested tools, images, streaming, thinking, guardrails, and context window.
- Bedrock target has a region or profile that can resolve one.
- Bedrock-only fields are rejected for non-Bedrock providers.

Runtime selection:

- Compute ordered targets from the tier.
- Filter targets by health, credential, model access, request compatibility, and budget.
- Record skip evidence for each filtered target.
- Attempt selected target.
- Record provider attempt, upstream metadata, usage, and terminal outcome.
- Apply fallback only when routing config explicitly allows it and the failure is categorized as retryable.

## Bedrock Request Translation

### Inputs

Supported caller inputs in V1:

- OpenAI Chat Completions
- OpenAI Responses where stateful fields are absent or safely translatable
- Anthropic Messages where signed-thinking/provider-specific state is absent or safe

Unsupported or gated:

- `previous_response_id` routed to Bedrock.
- Encrypted reasoning items.
- Anthropic signed thinking blocks crossing providers.
- Provider-native file references.
- Remote image URLs unless converted or represented safely.
- Tools on Bedrock models without tool support.
- Prompt-management prompt ARNs mixed with unsupported Converse fields.

### Message conversion

Convert to Bedrock Converse:

- `system` prompt becomes top-level `system`.
- User/assistant turns become `messages`.
- Text blocks become `{ text }`.
- Base64 image input becomes `{ image: { format, source: { bytes } } }`.
- OpenAI function tools become `toolConfig.tools[].toolSpec`.
- Tool calls become `toolUse` content blocks.
- Tool results become `toolResult` content blocks.
- `max_tokens`/`max_output_tokens` maps to `inferenceConfig.maxTokens`.
- `temperature`, `top_p`, and stop sequences map to `inferenceConfig` when supported.
- Provider-specific model parameters map to `additionalModelRequestFields` only from explicit allowlists.
- Guardrails map to `guardrailConfig`.
- Service tier maps to `serviceTier`.
- Request metadata maps to `requestMetadata`.

Role constraints:

- Bedrock Converse messages only use `user` and `assistant`.
- Some models require strict user/assistant alternation.
- Consecutive same-role messages should be merged only when semantic loss is avoided.
- Synthetic placeholder user messages should be a last resort, recorded in route evidence, and avoided for signed/provider-stateful content.

### Tool conversion

OpenAI tool:

```json
{
  "type": "function",
  "function": {
    "name": "lookup",
    "description": "Lookup a record",
    "parameters": { "type": "object", "properties": {} }
  }
}
```

Bedrock tool:

```json
{
  "toolSpec": {
    "name": "lookup",
    "description": "Lookup a record",
    "inputSchema": {
      "json": { "type": "object", "properties": {} }
    }
  }
}
```

Tool IDs must round-trip to the caller dialect. If Bedrock omits or changes IDs, Proxy needs a per-request mapping stored only in request memory and attempt metadata, not raw prompts.

### Stop reason mapping

| Bedrock stop reason | OpenAI finish reason | Anthropic stop reason |
| --- | --- | --- |
| `end_turn` | `stop` | `end_turn` |
| `stop_sequence` | `stop` | `stop_sequence` |
| `max_tokens` | `length` | `max_tokens` |
| `tool_use` | `tool_calls` | `tool_use` |
| `guardrail_intervened` or content-filter category | `content_filter` | `stop_sequence` with provider metadata |

Keep the original Bedrock stop reason in provider metadata.

### Usage mapping

Map Bedrock usage into `NormalizedUsage`:

- `inputTokens` -> prompt/input tokens
- `outputTokens` -> completion/output tokens
- cache read/write fields when AWS/model metadata exposes them
- reasoning tokens when model metadata exposes them

If Bedrock returns only partial usage in stream metadata, final usage should be taken from the terminal stream metadata event.

## Bedrock Streaming

Use `ConverseStream` for streaming targets.

Expected event handling:

- `messageStart`: initialize assistant response.
- `contentBlockStart`: create text/tool/reasoning block state.
- `contentBlockDelta`: emit caller-dialect delta.
- `contentBlockStop`: close block and finalize accumulated tool args if needed.
- `messageStop`: emit finish reason.
- `metadata`: capture usage, metrics, guardrail traces, and provider metadata.
- exception events: classify, close stream, and record terminal failure.

For OpenAI SSE output:

- emit chat-completions or responses deltas according to original caller surface
- preserve tool-call delta structure
- emit final usage when available
- emit `[DONE]`

For Anthropic SSE output:

- emit message/content-block start and delta events
- map tool use and text blocks correctly
- emit usage deltas/final message delta where applicable
- emit `message_stop`

The existing `sseObserverForDialect` pattern should gain Bedrock-aware observation internally, but callers should never see Bedrock event names unless they asked for a native Bedrock surface in a future version.

## Bedrock Auth And Security

### Supported credential sources

Recommended precedence:

1. Encrypted provider-account Bedrock bearer token.
2. Encrypted provider-account static access key/secret/session token.
3. Deployment-bound web identity/container/runtime identity.
4. Local development profile.
5. Local development environment variables.

`AWS_BEARER_TOKEN_BEDROCK` should be supported for local development and operator-managed deployments, but production provider accounts should use encrypted values or secret references.

### Required IAM permissions

Minimum for runtime:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`

Minimum for discovery:

- `bedrock:ListFoundationModels`
- `bedrock:ListInferenceProfiles`
- `bedrock:GetInferenceProfile`

Optional:

- guardrail permissions when using guardrails
- CloudWatch/S3 permissions only if Proxy owns log export setup, which is out of V1

### Security rules

- Never pass caller-supplied AWS credentials from request headers unless an explicit admin setting allows it for a dedicated gateway mode. Default is no override.
- Never let an org-defined provider inherit operator AWS credentials.
- Redact access keys, secret keys, session tokens, bearer tokens, role session names, and authorization headers from logs and events.
- Reject link-local metadata endpoints and private ranges unless operator allowlists them for self-hosted providers.
- Do not store full prompt text in Bedrock request metadata.
- Do not store tool result content in route evidence.
- Record the credential source category, not secret values.

## Model Discovery

### OpenAI-compatible OSS providers

MVP options:

1. Manual model rows in admin.
2. `GET /models` on the provider when available.
3. `models.dev` refresh for known hosted providers.
4. Operator-imported JSON catalog for private gateways.

For OpenAI-compatible providers, model discovery can be best-effort. The provider route can still work with manually configured model IDs.

### Bedrock

Discovery should be first-class because model access is region/account dependent.

Flow:

1. Resolve Bedrock control-plane client for the provider account and region.
2. Call `ListFoundationModels`.
3. Filter for active text/chat-compatible models.
4. Call `ListInferenceProfiles`.
5. Include system cross-region inference profiles.
6. Fetch additional details for profiles when needed.
7. Merge curated context/pricing/tool/reasoning metadata.
8. Upsert catalog rows with discovery source and timestamp.
9. Emit provider discovery event with success/failure counts.

Inference-profile handling:

- Preserve model IDs that already begin with `global.`, `us.`, `eu.`, `jp.`, `apac.`, or `au.`.
- Do not double-prefix model IDs.
- Allow explicit profile ARNs.
- Keep application inference profile discovery out of V1.
- Track region and geography because costs and availability can differ.

## Admin UI Requirements

### Provider setup

For generic HTTP providers:

- display name
- slug
- base URL
- auth style
- encrypted credential or none
- endpoint dialects
- model list/import
- private-network policy status
- test connection button

For Bedrock:

- provider account name
- credential mode
- region
- optional bearer token
- optional custom runtime endpoint
- optional discovery region set
- model access test
- streaming permission test
- discovery refresh button

### Routing editor

Target rows should show:

- provider
- model
- dialect
- native/translated/unsupported
- credential status
- health status
- region
- context window
- tool support
- streaming support
- estimated cost
- skip reason when invalid

Bedrock target controls:

- region
- inference profile
- service tier
- guardrail identifier/version
- request metadata template

Do not render Bedrock-only controls for generic HTTP providers.

### Operations views

Add panels for:

- provider-account health
- Bedrock discovery runs
- model access denied
- streaming permission denied
- inference-profile usage
- fallback/skip reasons
- unknown pricing
- unlisted models

## Rollout Plan

### Phase 0 - finalize boundary

- Decide provider adapter contract.
- Decide routing config target shape.
- Decide Bedrock credential modes for V1.
- Create fixtures from Hermes/OpenClaw-style request/stream cases.

Exit criteria:

- Design review signs off on adapter boundary and credential invariant.

### Phase 1 - OpenAI-compatible OSS providers

- Tighten provider registry validation for custom OpenAI-compatible providers.
- Add manual model catalog rows or import flow.
- Add route target validation for arbitrary provider slugs.
- Add admin affordances for generic HTTP provider setup.
- Add local smoke harness with OpenAI-compatible server.
- Verify same-dialect passthrough remains stable for OpenAI builtins.

Exit criteria:

- A route tier can target a local OpenAI-compatible model.
- Existing OpenAI and Anthropic tests still pass.
- Custom provider cannot receive operator env credentials.

### Phase 2 - provider adapter split

- Extract existing generic forwarding into `generic-http-json` adapter.
- Move header construction, URL construction, response translation, and stream transform to adapter-aware orchestration.
- Keep `fetchWithPinnedAddress` and network policy for generic HTTP providers.
- Add adapter-kind validation to provider rows.
- Add adapter-level error classification.

Exit criteria:

- No behavior change for OpenAI and Anthropic builtins.
- Unit tests prove request headers and URLs are unchanged for current providers.

### Phase 3 - Bedrock Converse adapter MVP

- Add AWS SDK dependencies:
  - `@aws-sdk/client-bedrock-runtime`
  - `@aws-sdk/client-bedrock`
  - `@aws-sdk/credential-providers`
- Add `aws-sdk` auth style and credential resolver.
- Add `bedrock-converse` dialect.
- Implement request conversion for text, system, tools, tool results, and basic image bytes.
- Implement non-streaming `Converse`.
- Implement streaming `ConverseStream`.
- Map usage and stop reasons.
- Classify core AWS errors.
- Gate unsupported stateful/provider-specific request shapes.

Exit criteria:

- OpenAI Chat request can route to a Bedrock Claude model.
- Anthropic Messages request can route to a Bedrock Claude model.
- Streaming tool call can round-trip through one caller surface.
- Missing streaming IAM permission produces a clear health/error state.

### Phase 4 - Bedrock discovery and admin

- Add `ListFoundationModels` and `ListInferenceProfiles` refresh job.
- Add curated metadata overlay.
- Add Bedrock provider account setup UI.
- Add model access test and streaming test.
- Add guardrail and service-tier config fields.
- Add health/cooldown display by region/model/profile.

Exit criteria:

- Admin can discover available Bedrock models for a region/account.
- Routing editor warns on unsupported tools/images/streaming.
- Provider health view distinguishes auth, region, model access, and streaming permission failures.

### Phase 5 - hardening

- Add live Bedrock integration tests gated by env.
- Add cost/pricing validation for known Bedrock models.
- Add canary route config in a non-production workspace.
- Test Codex, Claude Code, opencode, and plain SDK callers.
- Document IAM policies and local development setup.
- Add runbook entries for model access denied, stream denied, throttling, and unknown model metadata.

Exit criteria:

- Bedrock can serve a real workspace route with durable events, usage ledger, replayable route evidence, and admin-visible health.

## Test Plan

### Unit tests

- Provider registry validation accepts generic HTTP providers and Bedrock builtin rows.
- Org-defined providers never inherit builtin/operator credentials.
- Bedrock credential resolver precedence.
- AWS profile is local/dev only unless explicitly enabled.
- Bedrock model ID prefix handling.
- OpenAI tool to Bedrock toolConfig conversion.
- Anthropic tool use/tool result to Bedrock conversion.
- Consecutive role merge behavior.
- System prompt conversion.
- Base64 image conversion.
- Unsupported remote image handling.
- Stop reason mapping.
- Usage mapping.
- Guardrail config validation.
- Service tier validation.
- Error classification.

### Stream fixture tests

- Text-only stream.
- Tool-call stream.
- Multi-tool stream.
- Reasoning delta where supported.
- Metadata usage only at end.
- Guardrail intervention.
- AWS exception event mid-stream.
- Caller disconnect cleanup.

### Integration tests

- Local OpenAI-compatible HTTP server.
- Mocked AWS SDK Bedrock runtime client.
- Mocked Bedrock control-plane discovery client.
- Live Bedrock test gated by:
  - `AWS_REGION`
  - `AWS_BEDROCK_TEST_MODEL`
  - credentials in default chain or explicit env
- Harness smoke tests:
  - Codex OpenAI Responses -> OpenAI-compatible provider where possible
  - Codex/OpenAI Chat -> Bedrock
  - Claude Code Anthropic Messages -> Bedrock
  - opencode against proxy OpenAI Chat

### Regression tests

- Existing OpenAI passthrough headers unchanged.
- Existing Anthropic passthrough headers unchanged.
- Existing response translators unchanged.
- Existing prompt artifact storage rule unchanged.
- Existing usage ledger writes unchanged for builtins.
- Existing routing config activation still rejects invalid provider/model references.

## Observability

Events should capture:

- selected provider adapter
- selected provider account
- selected dialect
- native vs translated path
- Bedrock region
- Bedrock model ID or inference profile
- credential source category
- provider attempt latency
- time to first token
- usage
- stop reason
- provider error category
- skip reasons for unattempted targets

Metrics should include:

- requests by provider/model/region/dialect
- streaming requests by provider/model/region
- token counts by provider/model/region
- provider latency and time to first token
- retry/fallback counts
- model access denied counts
- throttling counts
- stream permission denied counts
- discovery run success/failure counts

Logs must redact:

- AWS access key ID
- AWS secret access key
- AWS session token
- Bedrock bearer token
- Authorization headers
- x-api-key headers
- tool result content
- raw prompt content outside prompt artifacts

## Risks

### Bedrock model semantics vary

Converse is consistent but not identical across models. Tool support, image support, thinking, sampling fields, stop reasons, and prompt templates vary by model family.

Mitigation:

- Capability-driven request validation.
- Model-family fixtures.
- Curated metadata overlay.
- Route skip evidence for unsupported features.

### Prompt/state portability is limited

OpenAI Responses state, encrypted reasoning, and Anthropic signed thinking cannot be freely moved to Bedrock.

Mitigation:

- Explicit runtime blockers.
- Native same-provider/session pinning where required.
- No silent fallback across stateful boundaries.

### AWS auth can become a security footgun

Default-chain credentials are convenient locally but dangerous if tenant-defined config can access operator identity.

Mitigation:

- Builtin-only default-chain use.
- Org-defined provider credential requirement.
- No tenant-selected credential files.
- Secret redaction tests.
- Post-V1 assume-role support with external ID for tenant AWS accounts.

### Model discovery is incomplete without curated data

AWS APIs do not provide all context, cost, and capability details needed for routing.

Mitigation:

- Merge control-plane discovery with curated metadata and operator overrides.
- Surface unknown pricing/capabilities in admin.
- Treat unknown critical capability as unsupported unless manually approved.

### Generic bridges hide useful Bedrock details

Routing Bedrock through LiteLLM or Kong is fast, but it hides Bedrock-specific auth, guardrail, region, inference-profile, and health semantics from Proxy.

Mitigation:

- Permit bridge mode for spikes.
- Do not make bridge mode the native architecture.
- Record bridge provider as a generic provider, not as real Bedrock.

## Scope Decisions

These decisions lock V1 implementation scope.

| Question | Decision | Owner | Reason |
| --- | --- | --- | --- |
| First native Bedrock model family | Claude-on-Bedrock only for native runtime V1. Discovery can see other text models, but route eligibility stays conservative unless curated metadata explicitly marks a model supported. | Proxy maintainers | Claude is the highest-value harness target and the local references have the strongest tool/message parity for Claude-style Converse use. |
| Assume-role provider accounts | Defer to post-V1. V1 supports operator-managed default chain, Bedrock bearer token, encrypted static keys, and local development profile/default-chain usage. | Proxy maintainers | Assume-role adds trust-policy, external-id, tenant-boundary, and admin UX complexity that is not required to prove the adapter. |
| Discovery scope | Run discovery per Bedrock provider account and region. Catalog rows are scoped to the owning organization/provider account according to the existing provider-account model. | Proxy maintainers | Bedrock access is account- and region-dependent; org-wide global discovery would misrepresent model availability. |
| Application inference profiles | Defer application inference profile discovery to post-V1. V1 supports foundation models and system cross-region inference profiles; manually supplied profile ARNs can be considered only after the runtime path is stable. | Proxy maintainers | Application profiles add ownership, tagging, cost-attribution, and lifecycle concerns beyond the native runtime MVP. |
| Public Bedrock caller surface | Keep `bedrock-converse` internal in V1. | Proxy maintainers | The user-facing API remains OpenAI/Anthropic compatible; Bedrock is a provider dialect behind translators. |
| Claude-on-Bedrock prompt caching/thinking parity | Not required for V1. V1 must safely reject or route-skip signed thinking, encrypted reasoning, and other non-portable provider state; parity work lands after basic runtime, discovery, and health. | Proxy maintainers | Shipping unsafe partial parity would risk state corruption and cache-signature breakage. |
| LiteLLM/Kong bridge support | Documentation-only bridge/spike path, not an official runtime dependency or support tier. | Proxy maintainers | Bridge mode is useful for evaluation but hides Bedrock auth, discovery, guardrail, and health details from Proxy. |
| Live Bedrock test account/model | No fixed CI account. Live tests are gated by `AWS_REGION`, `AWS_BEDROCK_TEST_MODEL`, and explicit credentials/default chain, and skip by default. | Proxy maintainers | CI should not depend on external AWS credentials or mutable model access. |

## Recommended Path

1. Ship generic OpenAI-compatible provider support first. It is close to the current architecture and unlocks many OSS/self-hosted models quickly.
2. Refactor provider forwarding behind a provider adapter boundary before adding AWS code.
3. Implement Bedrock as `aws-bedrock-converse`, with `aws-sdk` auth and an internal `bedrock-converse` dialect.
4. Keep LiteLLM and Kong as bridge options, not core dependencies.
5. Make capability validation and route skip evidence first-class before enabling fallbacks.
6. Treat Bedrock discovery and provider-account health as required for production, not polish.

Bottom line: open-source/OpenAI-compatible providers are an incremental extension of the existing provider-registry work. Native Bedrock is worth doing, but only if we treat it as a first-class provider adapter with its own auth, discovery, translation, streaming, and operations model.

Production rollout evidence for this scope lives in [PRODUCTION_READINESS_REVIEW.md](PRODUCTION_READINESS_REVIEW.md).
