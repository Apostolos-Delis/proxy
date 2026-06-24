# Proxy Metrics V1

## Goal

Add production operational metrics for Proxy so operators can answer health questions without scraping logs:

- Is the proxy accepting and completing harness traffic?
- Are failures coming from auth, routing/classification, providers, clients, or persistence?
- Are streams healthy, and where is latency being introduced?
- Are event/outbox/projection workers falling behind?
- Are token and cost rates moving in expected directions?

Metrics are alerting and diagnosis telemetry. Durable events, current-state tables, and SQL usage rollups remain the source of truth for audit, billing, usage analytics, and replay.

## Non-Goals

- No raw prompt, request, response, tool schema, API key, provider secret, request ID, session ID, user ID, prompt hash, or body hash in metric names or labels.
- No customer billing from Prometheus counters.
- No provider failover behavior.
- No mutation of streamed provider bytes to collect metrics.
- No repository-local metrics configuration that can redirect traffic or expose secrets.

## Collection Model

Use two collection paths:

| Source | Use for | Notes |
| --- | --- | --- |
| Direct runtime instrumentation | HTTP route health, process state, in-flight request gauges, database query timing, metrics endpoint health | These facts either are not durable events or need immediate process visibility. |
| Event/outbox-derived observation | Request lifecycle, routing decisions, classifier outcomes, provider terminal outcomes, usage/cost counters, terminal-pending reconciliation | Prefer this where the event already exists so metrics match durable state. |

Metrics recording must never fail a proxied request. Sink errors should increment `proxy_metrics_sink_errors_total` and be logged with redaction.

## Label Policy

Allowed labels must come from bounded enums or normalized buckets:

| Label | Allowed values |
| --- | --- |
| `route_family` | `health`, `metrics`, `admin`, `graphql`, `openai`, `anthropic`, `websocket`, `unknown` |
| `method` | HTTP method names plus `unknown` |
| `status_class` | `1xx`, `2xx`, `3xx`, `4xx`, `5xx`, `unknown` |
| `error_class` | Bounded application error classes such as `none`, `auth`, `validation`, `routing`, `classifier`, `provider`, `client_cancelled`, `persistence`, `timeout`, `unknown` |
| `surface` | Known surface/dialect values plus `unknown`; do not add raw path values |
| `provider` | Built-in provider slugs or configured safe custom slugs; otherwise `custom` or `unknown` |
| `model` | Catalog/routing-config model IDs when bounded by config; otherwise `custom` or `unknown` |
| `route` | `fast`, `balanced`, `hard`, `deep`, `auto`, `unknown`, or future route-tier constants |
| `requested_route` | Explicit router alias/tier, `auto`, `provider_model`, or `unknown` |
| `final_route` | Resolved route tier or `none` when classification fails before a decision |
| `guardrail_action` | `none`, `escalated`, `rejected`, `budget_rejected`, `translation_unavailable`, `credential_unresolved`, `unknown` |
| `stream` | `true`, `false`, `websocket`, `unknown` |
| `terminal_status` | `succeeded`, `failed`, `cancelled`, `terminal_pending`, `unknown` |
| `outcome` | `queued`, `processing`, `succeeded`, `failed`, `skipped`, `unknown` |
| `usage_kind` | `input`, `cached_input`, `cache_creation_input`, `output`, `reasoning`, `total` |
| `cost_kind` | `provider`, `classifier`, `baseline`, `savings` |
| `workspace_scope` | `default`, `non_default`, `none`, `unknown`; never a workspace ID |
| `projection` | Bounded projection names owned by code, not user-provided names |
| `operation` | Bounded code-owned operation names such as `event_append`, `outbox_poll`, `usage_rollup`, `admin_list_requests` |
| `stage` | Bounded lifecycle stages such as `before_provider`, `after_headers`, `after_bytes`, `unknown` |
| `reason` | Bounded reason codes owned by code, not exception messages or provider text |
| `version`, `commit`, `environment` | Static process metadata for `proxy_build_info`; omit unavailable values |

Forbidden labels:

- Raw prompt or response content.
- Raw request paths beyond `route_family`.
- Headers, cookies, API key prefixes, provider secret hints, or authorization state beyond bounded auth outcomes.
- Organization IDs, workspace IDs, API key IDs, user IDs, request IDs, session IDs, turn IDs, provider request IDs, event IDs, prompt hashes, or body hashes.
- Free-form exception messages.
- Unbounded model strings from caller input.

## Metric Contract

### Runtime And HTTP

| Metric | Type | Unit | Labels | Source | Notes |
| --- | --- | --- | --- | --- | --- |
| `proxy_up` | gauge | boolean | none | direct | `1` after server startup; `0` only when exported by a terminating process or external wrapper. |
| `proxy_build_info` | gauge | count | `version`, `commit`, `environment` | direct | Static labels only; omit unknown values rather than using dynamic build metadata. |
| `proxy_http_requests_total` | counter | requests | `route_family`, `method`, `status_class`, `error_class` | direct | Includes admin, health, GraphQL, metrics, and proxy surfaces. |
| `proxy_http_request_duration_seconds` | histogram | seconds | `route_family`, `method`, `status_class` | direct | End-to-end HTTP handler duration, including non-model routes. |
| `proxy_model_requests_in_flight` | gauge | requests | `surface`, `stream` | direct | Increment before provider/routing work, decrement exactly once. |
| `proxy_model_requests_total` | counter | requests | `surface`, `stream`, `terminal_status`, `error_class` | event-derived | Model traffic only. |
| `proxy_model_request_duration_seconds` | histogram | seconds | `surface`, `stream`, `terminal_status` | event-derived | Request receipt to terminal event when available. |
| `proxy_client_cancellations_total` | counter | requests | `surface`, `stream`, `stage` | direct/event-derived | `stage` is bounded: `before_provider`, `after_headers`, `after_bytes`, `unknown`. |

### Routing And Classifier

| Metric | Type | Unit | Labels | Source | Notes |
| --- | --- | --- | --- | --- | --- |
| `proxy_routing_decisions_total` | counter | decisions | `surface`, `requested_route`, `final_route`, `provider`, `model`, `guardrail_action` | event-derived | Emitted from persisted route decisions. |
| `proxy_routing_rejections_total` | counter | rejections | `surface`, `requested_route`, `error_class`, `guardrail_action` | event-derived | Budget, capability, credential, and translation rejections. |
| `proxy_classifier_attempts_total` | counter | attempts | `provider`, `model`, `outcome`, `error_class` | event-derived | Counts each classifier attempt, not just final requests. |
| `proxy_classifier_duration_seconds` | histogram | seconds | `provider`, `model`, `outcome` | event-derived | Attempt duration. |
| `proxy_classifier_retries_total` | counter | retries | `provider`, `model`, `error_class` | event-derived | Retry count before final classifier outcome. |
| `proxy_classifier_tokens_total` | counter | tokens | `provider`, `model`, `usage_kind` | event-derived | Uses normalized usage conventions. |
| `proxy_classifier_cost_usd_total` | counter | USD | `provider`, `model`, `cost_kind` | event-derived | Cost is useful for rate alerts, not billing truth. |

### Provider And Streams

| Metric | Type | Unit | Labels | Source | Notes |
| --- | --- | --- | --- | --- | --- |
| `proxy_provider_attempts_total` | counter | attempts | `surface`, `provider`, `model`, `stream`, `terminal_status`, `status_class`, `error_class` | event-derived | Counts upstream attempts. |
| `proxy_provider_attempt_duration_seconds` | histogram | seconds | `surface`, `provider`, `model`, `stream`, `terminal_status` | event-derived | Provider request start to terminal state. |
| `proxy_provider_time_to_first_byte_seconds` | histogram | seconds | `surface`, `provider`, `model`, `stream` | direct/event-derived | Only for stream or byte-producing responses. |
| `proxy_provider_stream_bytes_total` | counter | bytes | `surface`, `provider`, `model`, `terminal_status` | direct | Count bytes forwarded, not buffered payloads. |
| `proxy_provider_stream_disconnects_total` | counter | disconnects | `surface`, `provider`, `model`, `error_class` | direct/event-derived | Separate client disconnects from upstream disconnects. |
| `proxy_sse_observer_parse_failures_total` | counter | failures | `surface`, `provider`, `model`, `error_class` | direct | Observer failure must not affect passthrough. |
| `proxy_provider_protocol_mismatches_total` | counter | mismatches | `surface`, `provider`, `model`, `stream` | direct/event-derived | Example: non-SSE body returned for requested SSE stream. |

### Usage And Cost Rates

| Metric | Type | Unit | Labels | Source | Notes |
| --- | --- | --- | --- | --- | --- |
| `proxy_usage_tokens_total` | counter | tokens | `surface`, `provider`, `model`, `usage_kind` | event-derived | Mirrors `usage_ledger` normalization, but is not billing truth. |
| `proxy_cost_usd_total` | counter | USD | `surface`, `provider`, `model`, `cost_kind` | event-derived | Derived from the same pricing path as usage ledger rows. |
| `proxy_missing_usage_total` | counter | requests | `surface`, `provider`, `model`, `reason` | event-derived | `reason` is bounded: `provider_omitted`, `observer_failed`, `terminal_pending`, `unknown`. |

### Persistence, Workers, And Database

| Metric | Type | Unit | Labels | Source | Notes |
| --- | --- | --- | --- | --- | --- |
| `proxy_persistence_enabled` | gauge | boolean | none | direct | `1` when database persistence is active. |
| `proxy_event_appends_total` | counter | events | `outcome`, `error_class` | direct/event-derived | Count event append attempts. |
| `proxy_event_outbox_items_total` | counter | items | `outcome`, `error_class` | direct/event-derived | Count enqueue and processing outcomes. |
| `proxy_outbox_backlog` | gauge | items | none | direct | Current queued item count. |
| `proxy_outbox_oldest_item_age_seconds` | gauge | seconds | none | direct | Age of oldest queued item. |
| `proxy_projection_lag_seconds` | gauge | seconds | `projection` | direct | Cursor lag for projection workers. |
| `proxy_terminal_pending_provider_attempts` | gauge | attempts | `surface`, `provider` | direct | Reconciliation health signal. |
| `proxy_db_query_duration_seconds` | histogram | seconds | `operation`, `outcome` | direct | Operation names are code-owned enums. |
| `proxy_db_errors_total` | counter | errors | `operation`, `error_class` | direct | No raw SQL or exception messages in labels. |
| `proxy_metrics_sink_errors_total` | counter | errors | `error_class` | direct | Metrics failure visibility. |

## Histogram Buckets

Use fixed buckets so dashboards remain stable:

| Metric family | Buckets |
| --- | --- |
| HTTP request duration | `0.005`, `0.01`, `0.025`, `0.05`, `0.1`, `0.25`, `0.5`, `1`, `2.5`, `5`, `10`, `30`, `60` seconds |
| Model request/provider duration | `0.05`, `0.1`, `0.25`, `0.5`, `1`, `2.5`, `5`, `10`, `30`, `60`, `120`, `300`, `600` seconds |
| Time to first byte | `0.025`, `0.05`, `0.1`, `0.25`, `0.5`, `1`, `2.5`, `5`, `10`, `30`, `60` seconds |
| Classifier duration | `0.025`, `0.05`, `0.1`, `0.25`, `0.5`, `1`, `2.5`, `5`, `10`, `30` seconds |
| Database query duration | `0.001`, `0.005`, `0.01`, `0.025`, `0.05`, `0.1`, `0.25`, `0.5`, `1`, `2.5`, `5`, `10` seconds |

Stream bytes should be emitted as counters, not histograms, unless a future dashboard needs per-stream distribution.

## Validation Rules

- Unit tests should assert metric names, label normalization, disabled collector behavior, and sink-failure behavior.
- Integration tests should assert representative emitted metrics through the test sink, not by snapshotting full Prometheus output.
- Endpoint tests should cover disabled, authorized, unauthorized, and content-type behavior.
- Any metric that duplicates durable usage data must be tested against the same normalization helpers used by `usage_ledger`.

## Open Questions

- Which production scrape system will consume `/metrics` first: CloudWatch agent, Prometheus, Grafana Agent, or another collector?
- Should production expose metrics on the main Fastify server with token auth, or on a separate internal bind address?
- Which custom provider/model labels should be allowlisted once provider registry V1 is fully landed?
