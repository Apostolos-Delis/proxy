# Model Routing Proxy

## Summary

This project should start as a small, protocol-preserving LLM gateway for coding harnesses. The MVP supports Codex through the OpenAI Responses API and Claude Code through the Anthropic Messages API. The proxy receives the request, chooses the appropriate model and reasoning settings, rewrites only those routing fields, then forwards the request upstream.

The goal is cost reduction without breaking harness behavior. That means the first version should avoid prompt rewriting, cross-provider translation, or stream reconstruction. Those can be added after the proxy proves it can preserve Codex behavior under real agent workloads.

```text
Codex CLI / IDE
  -> POST /v1/responses
  -> prompt-proxy routing service
  -> OpenAI Responses API

Claude Code
  -> POST /v1/messages
  -> prompt-proxy routing service
  -> Anthropic Messages API
```

Internally, the proxy should be event-driven, but not pure event sourced. Current-state tables should exist for fast reads such as route memory, budgets, and usage summaries. The append-only event log should explain what happened, feed projections, support replay/debugging, and power future prompt rewriting, memory, and eval workflows.

## Goals

- Route Codex requests to cheaper or stronger OpenAI models based on request complexity.
- Route Claude Code requests to cheaper or stronger Anthropic models based on request complexity.
- Adjust OpenAI reasoning effort and text verbosity per request.
- Preserve streaming, tool calls, request state, and response shape.
- Centralize cost controls, route decision logs, and API key handling.
- Keep the primitive small enough to extend to other harnesses and providers later.

## Non-Goals For V1

- Prompt rewriting.
- Memory injection.
- OpenAI Chat Completions support.
- Provider-to-provider protocol translation.
- Classifier-driven prompt rewriting.
- Rule-based complexity scoring.
- Rule-based route fallback when classifier calls fail.
- Unbounded multi-step classifier calls.
- Full prompt/body logging.

## Architecture

The service should separate client-facing protocol adapters from upstream provider adapters.

```text
Surface adapters:
  openai-responses     # Codex
  anthropic-messages   # Claude Code
  openai-chat          # older harnesses later

Provider adapters:
  openai
  anthropic
  openrouter           # later
  bedrock / vertex     # later
```

For the MVP, implement direct protocol-preserving paths:

```text
OpenAI Responses surface -> OpenAI provider
Anthropic Messages surface -> Anthropic provider
```

This avoids the hard correctness risks that come from translating tool calls, reasoning state, and streaming events across incompatible APIs.

The request path should stay synchronous where the harness requires a response, while decisions and state transitions are emitted as events:

```text
HTTP surface adapter
  -> auth and request parsing
  -> API key identity and organization scope
  -> API key routing config assignment or organization default
  -> routing service
  -> event store: proxy.request_received
  -> routing config schema parse and compatibility gates
  -> event store: routing.decision_recorded
  -> provider service
  -> event store: provider.request_started
  -> upstream provider stream
  -> response stream passthrough
  -> event store: provider.response_completed / provider.response_failed
  -> async projections and reports
```

Surface adapters are transport boundaries. They should not own business rules or write events directly. The routing/proxy services should own validation, route choice, current-state writes, event emission, and provider calls.

## Repository Findings Incorporated

This design was checked against local clones of Codex, Claude Code, RTK, Fia, and Trace.

Codex findings:

- Codex's TypeScript SDK tests already include a small Responses API test proxy that records requests and emits `text/event-stream` fixtures. The prompt-proxy test harness should follow that pattern.
- Codex builds Responses requests with `stream: true`, `tool_choice: "auto"`, `parallel_tool_calls`, `prompt_cache_key`, `client_metadata`, `reasoning`, `text`, and `include: ["reasoning.encrypted_content"]` when reasoning is active.
- Codex uses a per-turn sticky routing header, `x-codex-turn-state`, received from the server and replayed for subsequent requests in the same turn. The proxy must preserve this header in both directions.
- Codex has explicit stream failure categories for failed SSE connection, mid-turn disconnect, and too many failed attempts. The proxy should not hide or normalize those failures into generic JSON errors.
- Codex already has model metadata concepts for supported reasoning efforts, default reasoning effort, verbosity support, input modalities, service tiers, API support, and nearest-effort migration.
- Codex and Conductor may still send ordinary upstream model names such as `gpt-5.5`. The proxy should record that value as a client hint for observability, then route non-alias requests through auto classification instead of rejecting or honoring the requested upstream model.

Claude Code findings:

- Claude Code treats `ANTHROPIC_BASE_URL` as a provider redirect and filters project-scoped environment sources to avoid malicious traffic redirection. Company rollout should use trusted user, flag, or managed settings.
- Claude Code resolves effort through an explicit precedence chain: environment override, app/session state, then model default. It also clamps unsupported effort values.
- Claude Code's streaming loop validates Anthropic event sequencing, accumulates tool input JSON deltas, updates usage on `message_delta`, and has fallback behavior for empty or incomplete streams.
- Claude Code tracks per-model input, output, cache read, cache write, web search, context window, max output tokens, and cost. The proxy should expose similarly shaped usage summaries.
- Claude Code model discovery includes capability metadata such as `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode`, and `supportsAutoMode`.

RTK findings:

- RTK keeps tool-specific integrations thin and delegates decisions to one core rewrite command. Prompt-proxy should do the same: one routing engine, thin surface adapters.
- RTK uses an exit-code style decision contract for allow, ask, deny, and passthrough. Prompt-proxy should define explicit route decision outcomes instead of burying behavior in ad hoc booleans.
- RTK trust-gates project-local policy files. Prompt-proxy should not let repository-local routing overrides redirect company model traffic unless the override is explicitly trusted.
- RTK tracks savings and has a discover mode for missed opportunities. Prompt-proxy should measure actual savings and identify calls that could have used a cheaper route.

Fia findings:

- Fia uses typed, scoped event envelopes with sequence numbers, actor, producer, causation/correlation IDs, payload hashes, sensitivity, and redaction state. Prompt-proxy should adopt the same shape so route decisions are replayable without putting raw prompts in events.
- Fia is event-driven without being strict pure event sourcing. It keeps current-state tables for resume/read efficiency and uses events for durable transitions, replay, debugging, and future automation.
- Fia appends events and outbox records in the same transaction, with expected-sequence conflict handling per scope. Prompt-proxy should use the same pattern for request, session, route, and provider scopes.
- Fia treats large or sensitive model inputs, chunks, and outputs as artifact references. Prompt-proxy should not put raw prompts, tool outputs, or SSE chunks in normal event payloads; prompt text belongs in `prompt_artifacts` when capture is enabled.

Trace findings:

- Trace treats HTTP/GraphQL as transport and lets services produce events. Prompt-proxy should keep `/v1/responses` thin and put shared behavior in routing/proxy services.
- Trace uses scoped events instead of one global stream. Prompt-proxy should scope events by request, turn, session, provider request, policy, and budget.
- Trace separates realtime PubSub from durable worker streams, and trims high-volume session output for broad streams. Prompt-proxy should publish small lifecycle events broadly and keep full request/response material out of the default stream.
- Trace clients and workers recover from missed live events by querying/backfilling the event store. Prompt-proxy dashboards and reports should consume projections built from durable events rather than relying on logs.

## Event-Driven Architecture

Prompt-proxy should be event-driven from the first implementation, but the event system should stay small. The routing decision still happens inline because Codex is waiting on the HTTP response. Everything that does not need to block the model stream should consume events asynchronously.

Recommended shape:

```text
Codex / harness
  -> surface adapter
  -> RoutingService
  -> EventService append
  -> ProviderService
  -> upstream provider
  -> EventService append terminal event or mark terminal pending
  -> OutboxWorker
  -> projections, dashboards, savings reports, eval queues
```

### Event Envelope

Use one typed envelope for every event:

```json
{
  "event_id": "event_...",
  "sequence": 12,
  "schema_version": 1,
  "tenant_id": "tenant_...",
  "scope_type": "request",
  "scope_id": "req_...",
  "session_id": "session_...",
  "turn_id": "turn_...",
  "parent_event_id": "event_...",
  "causation_id": "event_...",
  "correlation_id": "corr_...",
  "idempotency_key": "idem_...",
  "actor": { "type": "user", "id": "user_..." },
  "producer": "prompt-proxy.routing",
  "event_type": "routing.decision_recorded",
  "payload_hash": "sha256:...",
  "sensitivity": "internal",
  "redaction_state": "redacted",
  "payload": {},
  "metadata": {},
  "created_at": "2026-06-08T00:00:00.000Z"
}
```

Important fields:

- `scope_type` and `scope_id` define ordering and replay boundaries.
- `sequence` is monotonic within the scope.
- `session_id` and `turn_id` are optional cross-scope indexes for timelines and cost summaries.
- `causation_id` links a provider event back to the routing decision that caused it.
- `correlation_id` follows one incoming harness request across retries, fallbacks, and upstream calls.
- `idempotency_key` protects against duplicate provider calls.
- `payload_hash`, `sensitivity`, and `redaction_state` make privacy decisions inspectable.

### Event Scopes

Use scoped streams instead of one global event blob:

```text
request          one inbound harness request
turn             one Codex turn when a turn identifier is available
session          longer proxy-side grouping for route memory and cost accounting
provider_request one upstream provider attempt
routing_config   routing config version and trust changes
budget           budget ledger and warnings
eval             later route-quality labels and replay results
```

The request scope should be the most important v1 scope. Session scope can start as optional and become more accurate as Codex/Claude metadata improves.

### Core Event Types

Initial lifecycle events:

```text
proxy.request_received
routing.context_built
routing.classification_recorded
routing.classification_failed
routing.decision_recorded
routing.compatibility_escalated
provider.request_started
provider.stream_started
provider.response_completed
provider.response_failed
provider.stream_cancelled
provider.stream_disconnected
provider.terminal_reconcile_scheduled
retry.scheduled
fallback.applied
usage.recorded
cost.estimated
budget.warning_emitted
routing_override.trust_checked
routing_override.rejected
```

High-volume stream chunks should not be persisted by default. For normal operation, record aggregate stream facts such as byte count, first-byte latency, terminal status, usage, and provider request IDs. If a debug mode needs raw chunks, write them to an encrypted artifact with short retention and reference the artifact from the event.

### Event Payload Rules

Default event payloads should be safe for audit and analytics:

- Store request size, feature flags, route reasons, selected model, selected effort, estimated cost, latency, status, and upstream request IDs.
- Store prompt hashes and body hashes in events, not raw prompt text. Captured prompt text belongs in `prompt_artifacts`.
- Store tool count and tool categories, not full tool schemas by default.
- Store response usage and cost estimates when available.
- Store full request/response bodies only as opt-in encrypted artifacts with retention and access controls.
- Keep `metadata` for operational details such as transport headers, deployment version, routing config version, and provider attempt numbers.

Example route decision payload:

```json
{
  "routing_decision_id": "route_decision_...",
  "requested_model": "router-auto",
  "classifier_route": "hard",
  "final_route": "hard",
  "selected_model": "gpt-5.5",
  "reasoning_effort": "high",
  "verbosity": "medium",
  "guardrail_actions": [],
  "reason_codes": ["auth_risk", "failing_test", "tools_present"],
  "classifier": {
    "model": "route-classifier-cheap",
    "attempts": 1,
    "confidence": 0.82
  },
  "routing_config_id": "routing_config_default",
  "routing_config_version_id": "routing_config_default:v1",
  "routing_config_version": 1,
  "routing_config_hash": "sha256:..."
}
```

### Current State And Projections

Do not make every read replay the event log. Keep current-state tables for:

- Request status and terminal outcome.
- Route decision by request.
- Provider attempt by request.
- Session route memory.
- Usage ledger.
- Budget ledger.
- Routing override trust state.

Then build projections from events:

- Session timeline.
- Per-user/team/repo usage.
- Savings reports.
- Missed-savings reports.
- Retry/fallback quality reports.
- Route-quality eval queues.

Every projection should have a cursor so it can be replayed from durable events after code changes or worker downtime.

### Outbox And Fan-Out

Use a transactional outbox. When a service appends an event, it should also queue an outbox item in the same transaction. A worker can publish outbox items to optional sinks:

```text
event store
  -> outbox
  -> in-process emitter for local development
  -> Redis Streams or Kafka for production workers
  -> metrics sink
  -> dashboard projection workers
```

For v1, in-process fan-out plus a durable database table is enough. Redis Streams or Kafka can wait until there are multiple workers or dashboard consumers.

### Idempotency And Ordering

The proxy must not double-spend on provider calls after retries or client reconnects.

Recommended behavior:

- Compute or accept an idempotency key before provider work starts.
- Insert request/current-state rows before the upstream call.
- Append `proxy.request_received` and `routing.decision_recorded` before the provider request.
- Insert a `provider_attempt` record with `terminal_status: "pending"` before sending the upstream request.
- Attempt to append one provider terminal event when the stream completes, fails, or is cancelled.
- If terminal event append fails after bytes have reached the client, leave the provider attempt in `terminal_pending` and schedule reconciliation from provider/request metadata.
- On duplicate idempotency keys, return the known terminal result when possible.
- For active streams or terminal-pending attempts, either attach to the live stream if supported, return the known terminal result, or return a clear conflict. Do not launch a second upstream call silently.

Ordering should be per scope. Request events need strict order inside one request. Session events need a separate session sequence for timelines and cost reports.

### Synchronous Path Versus Async Consumers

Inline, blocking:

- Authentication.
- Request parsing.
- Route context construction.
- Route decision.
- Compatibility checks.
- Provider attempt record before upstream spend.
- Provider request and stream passthrough.
- Terminal event append when possible.

Async:

- Terminal reconciliation for pending provider attempts.
- Cost rollups.
- Savings reports.
- Budget notifications after soft thresholds.
- Route-quality evals.
- Missed-savings discovery.
- Future memory extraction.
- Future prompt rewrite analysis.

This keeps the latency-critical path small while making every important decision replayable.

## MVP API

```text
GET  /healthz
GET  /v1/models
POST /v1/responses
POST /v1/messages
POST /v1/messages/count_tokens
```

### `GET /healthz`

Returns service readiness. This should not call upstream providers.

```json
{
  "status": "ok"
}
```

### `GET /v1/models`

Returns router aliases that clients can select for explicit control. Clients may also send ordinary provider model names; the proxy records them as hints and still applies auto routing.

```json
{
  "object": "list",
  "data": [
    { "id": "router-auto", "object": "model", "owned_by": "prompt-proxy" },
    { "id": "router-fast", "object": "model", "owned_by": "prompt-proxy" },
    { "id": "router-balanced", "object": "model", "owned_by": "prompt-proxy" },
    { "id": "router-hard", "object": "model", "owned_by": "prompt-proxy" }
  ]
}
```

### `POST /v1/responses`

Request flow:

1. Parse the JSON body.
2. Build a `RouteContext`.
3. Run compatibility and budget gates.
4. Classify non-explicit requests with the configured cheap classifier model.
5. Choose the final route.
6. Rewrite only routing fields.
7. Forward the request upstream.
8. Pipe upstream response status, headers, and body back to the client.

Fields the router may rewrite:

```json
{
  "model": "gpt-5.4-mini",
  "reasoning": { "effort": "low" },
  "text": { "verbosity": "low" }
}
```

Fields the router should preserve unchanged:

- `input`
- `instructions`
- `tools`
- `tool_choice`
- `parallel_tool_calls`
- `previous_response_id`
- `include`
- `metadata`
- `store`
- `stream`
- `stream_options`
- `max_output_tokens`
- `prompt_cache_key`
- `client_metadata`
- returned tool call IDs and response item IDs

Headers the router should preserve when present:

- `x-codex-turn-state`
- `x-codex-turn-metadata`
- `x-openai-subagent`
- `x-stainless-*`
- request ID and trace headers

## Codex Integration

Codex can point at a proxy with either `openai_base_url` or a custom model provider. For company usage, prefer a custom provider so developers use a proxy token while the service owns the real upstream API key.

```toml
model = "router-auto"
model_provider = "prompt-proxy"
model_context_window = 400000
model_reasoning_effort = "medium"
model_verbosity = "low"

[model_providers.prompt-proxy]
name = "Prompt Proxy"
base_url = "http://127.0.0.1:8787/v1"
env_key = "PROMPT_PROXY_TOKEN"
wire_api = "responses"
supports_websockets = true
```

For a local prototype using the built-in OpenAI provider:

```toml
model = "router-auto"
openai_base_url = "http://127.0.0.1:8787/v1"
```

The proxy should accept Codex's request as-is, authenticate the caller, replace upstream auth with `OPENAI_API_KEY`, and forward to `https://api.openai.com/v1/responses`.
For Codex efficiency, the custom provider should opt into Responses WebSockets. Without that, Codex falls back to HTTP replay and large sessions repeatedly send the full context, which defeats RTK's local token-saving guidance.

Codex-specific compatibility requirements:

- The client base URL already includes `/v1`; the surface adapter should handle `POST /v1/responses` and forward to the upstream `/v1/responses`.
- Support `WS /v1/responses`, preserve `previous_response_id`, and pin continuations to the same proxy route for the connection.
- Preserve `x-codex-turn-state` exactly. It is a sticky per-turn routing token and must not leak across unrelated turns.
- Preserve `x-codex-turn-metadata` as observability metadata, not as prompt-visible input.
- Do not remove `include: ["reasoning.encrypted_content"]` when reasoning is active.
- Do not remove `prompt_cache_key`; it affects prompt-cache reuse and should remain client-controlled in v1.
- Treat Codex's `model_reasoning_effort` and `model_verbosity` as client defaults that the router may override only through the configured route decision.

## Initial Routing Config

Routes are persisted configuration, not process-global code or ad hoc JSON env. A starting seeded config:

```yaml
routes:
  fast:
    model: gpt-5.4-mini
    reasoning_effort: low
    verbosity: low

  balanced:
    model: gpt-5.4
    reasoning_effort: medium
    verbosity: low

  hard:
    model: gpt-5.5
    reasoning_effort: high
    verbosity: medium

  deep:
    model: gpt-5.5
    reasoning_effort: xhigh
    verbosity: medium
```

Codex-specific models such as `gpt-5.1-codex-mini` and `gpt-5.2-codex` should be evaluated, but not assumed. A cheaper model is only cheaper if it avoids extra repair turns.

## Persisted Runtime Resolution

With persistence enabled, every request resolves one routing config version before classifier spend:

```text
authenticated API key
  -> api_keys.routing_config_id
  -> organization_settings.default_routing_config_id
  -> seeded default ${organization_id}:routing-config:default
  -> active routing_config_versions row
  -> shared routing config schema parse
  -> classifier and provider route settings
```

Environment variables still seed local defaults, provider base URLs, and model names. They do not replace the persisted runtime config once a database-backed proxy is running. Do not use `ROUTE_POLICY_JSON` as an operator control for persisted routing.

The resolved snapshot is stored with request and route-decision records:

```text
routing_config_id
routing_config_version_id
routing_config_version
routing_config_hash
```

This snapshot is the audit handle for explaining why Codex, Claude Code, or another harness received a selected model and reasoning setting.

## Model Catalog

The router needs a model catalog separate from the routing config. The routing config answers "which route should this request take and what provider settings should it use?" The catalog answers "is that route compatible with this request?"

Catalog fields:

```yaml
models:
  gpt-5.4-mini:
    provider: openai
    context_window: 400000
    supports_responses: true
    supports_reasoning: true
    supported_reasoning_efforts: [minimal, low, medium, high]
    supports_verbosity: true
    supported_modalities: [text, image]
    supports_parallel_tool_calls: true
    supports_reasoning_encrypted_content: true
    service_tiers: [default, flex]
    input_cost_per_mtok: 0.0
    output_cost_per_mtok: 0.0
```

Compatibility gates should run before cost optimization:

- If a request contains images, only choose image-capable routes.
- If a request asks for reasoning summaries or encrypted reasoning content, only choose compatible routes.
- If the requested effort is unsupported, map to the nearest supported effort instead of failing when that mapping is safe.
- If a model is not available under the caller's auth mode or workspace, skip it.
- If the context estimate is near the route's context window, escalate before the upstream request.

Cost fields can start as `0.0` or omitted for local development, but the structure should exist from day one so usage reports can be wired without changing schemas.

## Routing Decision Flow

Use a cheap LLM classifier for all non-explicit requests. Do not add a separate rule-based complexity scorer. The classifier is the classification layer; router code only enforces compatibility, budget, explicit aliases, retries, and failure behavior.

The route pipeline should be:

```text
extract request features
-> apply hard compatibility and budget gates
-> detect explicit alias overrides
-> run cheap structured classifier when no explicit route was requested
-> retry classifier when structured output fails
-> apply budget/session policy
-> resolve final route from classifier recommendation and guardrails
-> record route decision event
```

Useful signals:

- Approximate input size.
- Whether tools are present.
- Which tool categories are requested.
- Whether `previous_response_id` is present.
- Explicit speed hints such as "quick", "simple", "typo", "format", or "one-line".
- Explicit depth hints such as "think hard", "deep review", "root cause", "prove", or "exhaustive".
- Risk terms such as "security", "auth", "migration", "concurrency", "payment", "data loss", or "production".
- Failure terms such as "failing test", "regression", "flaky", "stack trace", or "root cause".

The classifier model is configured through the model catalog, not hardcoded:

```yaml
classifier:
  provider: openai
  model: route-classifier-cheap
  max_output_tokens: 300
  timeout_ms: 1500
  max_attempts: 2
  cache_ttl_seconds: 300
  content_mode: features_only
  allow_redacted_excerpt: false
  require_same_trust_boundary_for_excerpt: true
```

Classifier requests should use provider-native structured outputs or an equivalent JSON-schema response contract. Free-form classifier text should be treated as invalid output.

### Classifier Data Boundary

The classifier is a model call, so classifier input needs the same privacy treatment as an upstream completion request.

Default policy:

- Send a features-only routing view by default.
- Do not send raw prompts, full tool schemas, tool outputs, terminal output, or file contents to the classifier.
- Allow a short redacted excerpt only when `allow_redacted_excerpt` is enabled by trusted central policy.
- If an excerpt is enabled, require the classifier provider to be inside the same approved trust boundary as the provider that would otherwise receive the request.
- Redact secrets before classifier calls.
- Do not log classifier request bodies.
- Record classifier data mode, provider, model, retention mode, and redaction status as event metadata.

The classifier prompt should be small and structured. It receives a redacted routing view, not the full proxy audit event:

```json
{
  "surface": "openai-responses",
  "requested_model": "gpt-5.5",
  "content_mode": "features_only",
  "redaction_state": "redacted",
  "input_excerpt": null,
  "input_hash": "sha256:...",
  "input_chars": 18420,
  "estimated_input_tokens": 4600,
  "has_tools": true,
  "tool_count": 8,
  "has_previous_response_id": true,
  "extracted_hints": ["auth", "failing_test", "root_cause"],
  "session_route": "balanced",
  "explicit_alias": null
}
```

Classifier output must be schema-validated:

```json
{
  "complexity": "hard",
  "risk": ["auth", "failing_test"],
  "recommended_route": "hard",
  "can_use_fast_model": false,
  "needs_deep_reasoning": false,
  "reason_codes": ["auth_risk", "failing_test", "tools_present"],
  "confidence": 0.82
}
```

Allowed classifier labels:

```text
complexity: trivial | simple | normal | hard | deep
recommended_route: fast | balanced | hard | deep
confidence: 0.0 to 1.0
```

The final route resolver applies non-classification guardrails after classifier output:

- If classifier output fails schema validation, retry the classifier within the configured attempt budget.
- If the classifier times out, retry the classifier within the configured attempt budget.
- If the classifier still fails, return a router error before provider spend. Do not fall back to rule-based route scoring.
- If the classifier selects an incompatible route, escalate to the smallest compatible route.
- If the classifier selects a route over budget, apply budget policy.
- If the user selected `router-fast`, `router-balanced`, `router-hard`, or `router-deep`, treat that alias as an explicit override unless incompatible.
- If the client selected an ordinary upstream model, treat it as auto-routed input. Record the requested model, but do not honor it as the selected upstream model.
- If classifier confidence is low, preserve the classifier recommendation but record the low confidence in the route decision event.

Capability checks should run before cost optimization. If the chosen model does not support a requested feature, escalate to the smallest compatible route.

Route decisions should be explicit objects:

```json
{
  "outcome": "route",
  "classifier_route": "hard",
  "final_route": "hard",
  "model": "gpt-5.5",
  "reasoning_effort": "high",
  "verbosity": "medium",
  "guardrail_actions": [],
  "classifier": {
    "model": "route-classifier-cheap",
    "attempts": 1,
    "confidence": 0.82,
    "recommended_route": "hard"
  },
  "reasons": ["tools_present", "auth_risk", "failing_test"],
  "routing_config_id": "routing_config_default",
  "routing_config_version_id": "routing_config_default:v1",
  "routing_config_version": 1,
  "routing_config_hash": "sha256:..."
}
```

Supported outcomes:

- `route`: use the selected route.
- `passthrough`: forward the request without changing model or reasoning fields.
- `reject`: block the request before provider spend, usually for auth, budget, or policy.
- `escalate`: replace an incompatible low-cost route with the smallest compatible route.

The service should also support explicit aliases:

- `router-auto`: classify normally.
- `router-fast`: force the fast route unless incompatible.
- `router-balanced`: force the balanced route unless incompatible.
- `router-hard`: force the hard route unless incompatible.
- `router-deep`: force the deep route unless incompatible.

Any non-alias model name should behave like `router-auto`. This lets harnesses with fixed model pickers point at the proxy without bypassing routing.

## Session Behavior

The safest first version can route each request independently, but production behavior should pin or bias by session.

Recommended policy:

- Use request-level routing for the first prototype.
- Add session route memory once logging shows repeated route churn.
- Allow upgrades within a session.
- Avoid downgrades within a session unless the user explicitly asks for a cheaper/faster mode.

For Codex, route session identity can come from request metadata when available, client headers if present, or a derived hash of stable non-secret fields. The proxy should not require parsing full prompts for session grouping.

Codex has per-turn state as well as longer-running thread state. Treat these separately:

- Per-request: the raw HTTP request.
- Per-turn: `x-codex-turn-state`, which must stay sticky only within the same turn.
- Per-thread/session: proxy-side route memory and cost accounting.

Do not use `x-codex-turn-state` as a durable session key. It is useful for preserving upstream behavior, not for long-lived accounting.

## Streaming Requirements

Streaming must be pass-through.

For OpenAI Responses, the upstream emits typed server-sent events. The proxy should make the routing decision before the upstream request and then pipe the stream back without reconstructing events.

For accounting, the proxy may attach a non-mutating SSE observer. The observer tees the upstream byte stream, forwards bytes to the client unchanged, and parses only enough event structure to capture terminal usage, response IDs, error events, and completion status. Observer failure must not corrupt the client stream.

Required behavior:

- Preserve SSE event order.
- Preserve response status and content type.
- Forward client cancellation to upstream with `AbortController`.
- Do not buffer the full stream.
- Do not mutate `response.output_text.delta`, tool-call argument deltas, reasoning summary events, or error events.
- Do not retry midway through a streaming response unless the upstream request has not produced any bytes.
- Preserve upstream request IDs and trace headers where safe.
- Count bytes, status, latency, and time to first byte directly from the stream.
- Tee-parse terminal events for usage and cost accounting when the provider stream includes them.
- If upstream returns a non-SSE body to a streaming request, pass it through with the original status and log the protocol mismatch.
- If the observer cannot parse a stream event, continue byte passthrough and record observer failure separately.

Codex already detects dropped or incomplete streams. The proxy should make that diagnosis easier by preserving status codes and request IDs, not harder by wrapping errors.

## Tool Call Requirements

The proxy must not mutate tool schemas or tool-call IDs.

Preserve:

- Function/tool definitions.
- Tool call IDs.
- Tool output item IDs.
- `previous_response_id`.
- Response output items.
- Reasoning items and summaries.
- `phase` or other state fields returned by the Responses API.

Tool-call correctness is more important than per-request cost savings. If routing creates tool failures, the policy should escalate earlier.

## Observability

Log route decisions, not prompt contents.

Example log fields:

```json
{
  "request_id": "req_...",
  "surface": "openai-responses",
  "requested_model": "router-auto",
  "classifier_route": "hard",
  "final_route": "hard",
  "selected_model": "gpt-5.5",
  "reasoning_effort": "high",
  "verbosity": "medium",
  "input_chars": 18342,
  "has_tools": true,
  "has_previous_response_id": true,
  "reason": ["tools_present", "auth_risk", "failing_test"]
}
```

Track usage when returned by upstream:

- Input tokens.
- Cached input tokens.
- Output tokens.
- Reasoning tokens.
- Total cost estimate.
- Latency.
- Time to first byte for streams.
- Retry and fallback counts.

For streaming responses, usage extraction comes from the non-mutating SSE observer. If the observer misses terminal usage, the request should remain usable for Codex and the usage projection should mark usage as `missing` or reconcile it later from provider metadata when available.

Prompt/body logging should be opt-in, redacted, and disabled by default.

Observability should be event-backed, not only log-backed. Logs are useful for live debugging, but route decisions, usage, fallbacks, and budget signals should be durable events so projections can be rebuilt.

Add RTK-style savings analytics:

- Requested model versus selected model.
- Estimated cost if the request had used the requested model.
- Actual cost for the selected route.
- Estimated savings per request, session, user, repo, and team.
- Calls where `router-auto` chose a more expensive model.
- Calls where a cheaper route probably would have worked.
- Calls where a cheap route caused retries or repair turns.

The proxy should have a `discover`-style report later. It should identify routing config gaps from real traffic without storing prompt bodies.

## Auth And Security

The proxy should separate caller auth from provider auth.

- Callers authenticate with `PROMPT_PROXY_TOKEN` or company SSO/JWT later.
- The proxy injects the upstream `OPENAI_API_KEY`.
- Incoming `Authorization` should not be forwarded upstream as-is.
- Logs must redact auth headers and cookies.
- Do not log request bodies by default.
- Add per-user, per-team, and per-route budgets later.

Routing configuration is security-sensitive because it can redirect requests, increase spend, or downgrade model quality. Project-local overrides should be treated like executable configuration:

- Default to centrally managed routing configs only.
- User-local routing overrides can be allowed for local development.
- Repo-local routing overrides must be explicitly trusted before use.
- Changed repo-local overrides invalidate trust and are skipped until re-reviewed.
- Untrusted overrides should fail closed to the central routing config, not fail open to arbitrary routes.

For company rollout, provider base URLs and upstream API keys should come from user, flag, or managed settings. Do not let project-local settings silently set `ANTHROPIC_BASE_URL`, `openai_base_url`, or equivalent provider redirects.

## Failure Handling

Recommended behavior:

- For non-streaming requests, retry transient upstream errors with bounded exponential backoff.
- For streaming requests, retry only before any response bytes have been sent.
- For `router-auto`, retry classifier timeouts, transport failures, and invalid structured outputs within the configured attempt budget.
- If classifier attempts are exhausted, append `routing.classification_failed` and return a router error before sending any upstream provider request.
- If a selected model rejects a supported parameter, remove or adjust only that routing parameter and retry once.
- If a selected model lacks a requested capability, escalate to the smallest compatible route and retry once.
- Return upstream errors with enough metadata for debugging, but do not leak upstream secrets.
- Preserve upstream HTTP status codes for Codex so its client-side error categories still work.
- Keep retry behavior provider-aware. OpenAI Responses, Anthropic Messages, and OpenRouter may need different retry rules.
- Do not convert provider stream disconnects into successful empty responses.

## Implementation Stack

Recommended stack:

```text
Node 22+
TypeScript
Fastify
undici/fetch
zod
pino
vitest
```

Avoid the OpenAI SDK in the hot path. Raw HTTP gives more control over headers, streaming, cancellation, and passthrough behavior.

Suggested layout:

```text
src/server.ts
src/config.ts
src/events/envelope.ts
src/events/payloads.ts
src/events/eventService.ts
src/events/eventStore.ts
src/events/outbox.ts
src/events/projections/usage.ts
src/events/projections/savings.ts
src/surfaces/openaiResponses.ts
src/providers/openai.ts
src/router/policy.ts
src/router/features.ts
src/router/classifier.ts
src/router/catalog.ts
src/router/decision.ts
src/observability/logger.ts
src/observability/usage.ts
src/security/policyTrust.ts
test/
```

Storage recommendation:

- Local development can start with a lightweight SQLite event store or an in-memory event store for tests.
- Production should use Postgres so event append, current-state writes, and outbox enqueue can share a transaction.
- Do not make the database optional in production. If the proxy cannot record a route decision, it should not silently spend provider money with no audit trail.

## Testing Plan

Unit tests:

- Event envelope validation.
- Event payload validation.
- Event scope sequencing.
- Event payloads do not contain prompt text by default.
- Classifier prompt is built from the redacted routing view.
- Classifier defaults to `features_only` content mode.
- Classifier excerpts require trusted central policy and same trust boundary.
- Classifier output schema validation.
- Invalid classifier output retries within the attempt budget.
- Classifier timeout retries within the attempt budget.
- Exhausted classifier attempts return a router error before provider spend.
- Route selection follows valid classifier recommendations.
- Capability escalation.
- Unsupported effort maps to nearest supported effort.
- Request rewrite preserves unrelated fields.
- Auth headers are replaced safely.
- Untrusted repo-local routing override is skipped.

Integration tests with mocked upstream:

- Non-streaming `/v1/responses` passthrough.
- WebSocket `/v1/responses` passthrough.
- WebSocket continuations preserve `previous_response_id` and stay pinned to the established route.
- Streaming SSE passthrough.
- Client cancellation aborts upstream.
- Upstream errors return correctly.
- Tool-call payloads remain unchanged.
- `x-codex-turn-state` is preserved request-to-response and never reused across unrelated requests.
- `include: ["reasoning.encrypted_content"]` is preserved.
- Non-SSE response to a streaming request is passed through without being normalized.
- Upstream stream closes mid-event and the proxy does not emit a fake completion.
- Route decision events are appended before upstream provider calls.
- Classifier events include labels and reason codes, not raw prompt bodies.
- Successful provider terminal events are appended once.
- Provider attempts are recorded as `terminal_pending` before upstream spend.
- Terminal append failure after streamed bytes schedules reconciliation instead of pretending the request was atomic.
- SSE observer captures terminal usage without mutating bytes sent to the client.
- SSE observer parse failure does not corrupt stream passthrough.
- Duplicate idempotency keys do not create duplicate provider calls.
- Outbox items are queued in the same transaction as events.
- Usage and savings projections can replay from event cursors.

The mocked upstream should be modeled after Codex's own Responses test proxy:

- Record raw body, parsed JSON, and headers.
- Return configurable SSE event sequences.
- Include `response.created`, `response.output_item.done`, `error`, and `response.completed` fixtures.
- Include token usage fixtures with cached input and reasoning output tokens.

Manual Codex smoke tests:

```shell
codex exec --profile prompt-proxy "Explain this repo"
codex exec --profile prompt-proxy "Make a one-line README typo fix"
codex exec --profile prompt-proxy "Review this project for security issues"
```

## Claude Code Surface

Claude Code is supported through its documented LLM gateway boundary, not leaked internals.

Expose an Anthropic Messages surface:

```text
POST /v1/messages
POST /v1/messages/count_tokens
GET  /v1/models
```

For Claude Code, preserve:

- `anthropic-beta`
- `anthropic-version`
- `X-Claude-Code-Session-Id`
- `X-Claude-Code-Agent-Id`
- `X-Claude-Code-Parent-Agent-Id`
- Anthropic SSE event order and event payloads

Claude routing adjusts Anthropic model and thinking/effort fields through the same route decision primitive as Codex.

Claude-specific compatibility requirements:

- Preserve `anthropic-beta` and `anthropic-version`; Claude Code feature behavior depends on them.
- Preserve tool-use and tool-result pairing exactly.
- Preserve Anthropic stream event ordering: `message_start`, content block start/delta/stop events, `message_delta`, and `message_stop`.
- Do not reconstruct `input_json_delta`; stream it through.
- Do not normalize empty or incomplete streams into success.
- For `/v1/models`, expose alias metadata, not just IDs: display name, effort support, supported effort levels, adaptive thinking support, fast mode support, and auto mode support.
- Respect provider-managed deployment. In enterprise use, `ANTHROPIC_BASE_URL` should be set through trusted or managed settings, not project-local settings.

Claude effort routing should follow a precedence chain:

```text
explicit router alias
-> trusted environment/session override
-> active routing config
-> model default
```

Unsupported effort values should clamp to the nearest safe supported value instead of causing avoidable 400s.

## RTK Inspiration

RTK is not an HTTP model router, but it has useful product and operational patterns.

Adopt these patterns:

- Thin integrations, central policy. Surface adapters should delegate route decisions to one routing engine.
- Explicit decision outcomes. Use `route`, `passthrough`, `reject`, and `escalate` instead of hidden booleans.
- Fail safe. If a policy cannot be parsed, trusted, or validated, skip it and use central defaults.
- Track value. Record savings, missed savings, and low-quality savings where cheaper routing caused retries.
- Add recovery paths. RTK saves full output when compacting command output; prompt-proxy should keep request IDs, route logs, and upstream IDs so developers can debug without prompt logs.
- Support local development without weakening enterprise defaults.

## OpenRouter Inspiration

OpenRouter is useful inspiration for provider abstraction, model cataloging, and cost-aware routing. This project should not start by copying its full shape. The first primitive is narrower:

```text
one surface
one upstream provider
one structured classifier policy
correct streaming
correct tool calls
auditable decisions
```

Once that works, add providers and surfaces incrementally.

## Milestones

### Milestone 1: Local Codex Proxy

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses`
- Configurable routes.
- Cheap classifier routing for `router-auto`.
- Structured classifier output validation.
- Classifier retries.
- OpenAI upstream forwarding.
- SSE passthrough.
- Route decision events and logs.
- Codex sticky header preservation.
- Model catalog and compatibility gates.
- Routing override trust defaults.
- Request-scoped event envelope.
- Durable event store.
- Transactional outbox.
- Mocked upstream tests.

### Milestone 2: Cost And Usage Reporting

- Token usage extraction.
- Cost estimation from a model catalog.
- Per-route and per-user summaries.
- Request IDs and trace IDs.
- Basic budget warnings.
- RTK-style savings reports.
- Missed-savings reports.
- Usage and savings projections with replay cursors.

### Milestone 3: Session-Aware Routing

- Session route memory.
- Upgrade-only routing within a session.
- Repeated-failure escalation.
- Explicit fast/deep override aliases.
- Session-scoped events and timelines.
- Idempotency across request retries.

### Milestone 4: Claude Code Surface

- Anthropic Messages-compatible endpoints.
- Header preservation.
- Token counting passthrough.
- Claude model discovery aliases.
- Anthropic stream passthrough tests.

### Milestone 5: Prompt Rewriting And Memory

- Explicit rewrite mode.
- Redaction and audit controls.
- Context injection policy.
- Memory retrieval policy.
- Evals proving rewrite quality and cost impact.

## Prompt Rewriting And Memory Spike

Prompt rewriting should remain disabled until model-routing telemetry proves where it is worth the risk. The future rewrite path should be an explicit mode in the route decision, not an implicit mutation inside provider forwarding.

Rewrite mode boundaries:

- `off`: default; preserve prompts exactly.
- `classify_only`: use request features for model routing, with no prompt mutation.
- `augment_context`: add trusted, cited context blocks without changing the user's request text.
- `rewrite_prompt`: rewrite the request only when policy, audit, and eval gates are enabled.

Memory retrieval policy:

- Retrieve only from trusted company or user-approved stores.
- Attach retrieved memory as explicit context artifacts with source IDs.
- Keep raw tool outputs, terminal output, and secrets out of durable route events.
- Require tenant, user, team, and repository scoping before any cross-session memory use.

Controls and evals:

- Require opt-in policy for rewrite or memory injection modes.
- Record rewrite inputs, policy version, redaction state, and output hashes without putting sensitive raw prompts in events.
- Evaluate cost, completion quality, repair-turn rate, and user override rate before rollout.
- Keep a no-rewrite replay path so route-quality reports can compare rewritten and preserved prompts.

## Open Questions

- Which company identity should route decisions and costs attach to: Unix user, SSO user, team, repo, or project?
- Should developers be able to force `router-fast`, `router-balanced`, or `router-hard`, or should all calls go through `router-auto`?
- Which request metadata can Codex reliably send that can identify a session without inspecting full prompts?
- What is the acceptable failure rate increase for cheaper routing?
- What workloads should be used as the first eval set?
- Should routing config ever downgrade within a Codex turn, or only between turns?
- What trust flow should enable repo-local routing overrides?
- What is the minimum savings threshold required before routing to a cheaper model by default?

## References

- OpenAI Codex configuration: https://developers.openai.com/codex/config-reference
- OpenAI models: https://developers.openai.com/api/docs/models
- OpenAI Responses API: https://platform.openai.com/docs/api-reference/responses
- OpenAI streaming responses: https://platform.openai.com/docs/guides/streaming-responses
- Claude Code LLM gateway: https://code.claude.com/docs/en/llm-gateway
- OpenRouter TypeScript SDK: https://github.com/OpenRouterTeam/typescript-sdk
- RTK: https://github.com/rtk-ai/rtk
- Local Codex files inspected: `../codex/sdk/typescript/tests/responsesProxy.ts`, `../codex/codex-rs/core/src/client.rs`, `../codex/codex-rs/protocol/src/openai_models.rs`
- Local Claude Code files inspected: `../claude-code-repo/claude-code/src/services/api/claude.ts`, `../claude-code-repo/claude-code/src/utils/effort.ts`, `../claude-code-repo/claude-code/src/cost-tracker.ts`
- Local RTK files inspected: `../rtk/hooks/claude/rtk-rewrite.sh`, `../rtk/src/hooks/rewrite_cmd.rs`, `../rtk/src/core/tracking.rs`, `../rtk/src/discover/mod.rs`
- Local Fia files inspected: `../fia/README.md`, `../fia/packages/events/src/event-envelope-base.ts`, `../fia/packages/events/src/model-payloads.ts`, `../fia/packages/events/src/router-payloads.ts`, `../fia/packages/db/src/event-service.ts`, `../fia/packages/db/src/schema-event-tables.ts`, `../fia/packages/db/src/drizzle-event-store.ts`
- Local Trace files inspected: `../trace/docs/trace-event-architecture.md`, `../trace/apps/server/src/services/event.ts`, `../trace/apps/server/src/schema/event.ts`, `../trace/packages/client-core/src/events/handlers.ts`
