# Proxy Metrics V1 Tickets

These tickets break operational proxy metrics into PR-sized units.

The intended delivery shape is an internal metrics surface for production operations: request health, routing/classifier behavior, provider attempt behavior, stream health, cost/usage counters, and worker/database health. These metrics complement the durable event log and usage analytics; they do not replace event-backed audit, billing, or dashboard projections.

## Delivery Rules

- Keep metrics out of prompt visibility and provider request bodies.
- Do not emit raw prompt text, request bodies, response bodies, tool schemas, API keys, provider secrets, request IDs, session IDs, user IDs, or prompt hashes as metric labels.
- Keep label cardinality bounded. Prefer `surface`, `provider`, `model`, `route`, `status`, `error_class`, `stream`, and `workspace_scope` over identifiers.
- Metrics must not make the hot path fail. A metrics sink failure is logged and counted, not returned to the client.
- Usage, billing, and audit truth remain the durable tables/events. Metrics are for alerting, dashboards, and production diagnosis.
- Prefer event/outbox-derived metrics for lifecycle facts already emitted as events. Use direct instrumentation only for process, HTTP, and in-flight measurements that are not event facts.
- Preserve byte-exact stream passthrough. Stream metrics may observe bytes and timing, but must not buffer or rewrite SSE/WebSocket payloads.

## Phase 0: Contract And Guardrails

### PM-001: Define Metrics Taxonomy And Label Policy

Goal: Create the canonical metrics contract before instrumentation lands.

Scope:

- Define metric names, types, descriptions, units, and allowed labels.
- Cover HTTP request counts/durations, proxy request lifecycle, routing decisions, classifier attempts, provider attempts, stream outcomes, usage/cost counters, event outbox health, database query health, and process health.
- Define bounded label rules for provider/model/route/surface/status/error classes.
- Define histogram buckets for request duration, classifier duration, provider duration, time to first byte, and database query duration; treat stream bytes as counters unless a future dashboard needs per-stream distribution.
- Document which metrics are direct runtime observations versus event/outbox-derived lifecycle facts.

Acceptance criteria:

- Metrics contract is documented in the scope file or a linked runbook.
- Every metric has a type, unit, label list, and cardinality rationale.
- The contract explicitly forbids identifiers and sensitive values as labels.
- Existing usage analytics and billing remain event/database-backed in the docs.

Validation:

- Run `pnpm typecheck` if code is touched.
- Review the metric label list for high-cardinality fields before implementation.

Likely files:

- `docs/scopes/proxy-metrics-v1/PLAN.md` or `docs/runbooks/proxy-metrics.md`
- `docs/index.md`

### PM-002: Add Metrics Collector Interface And Test Sink

Goal: Add a small internal API for recording metrics without tying proxy code to one exporter.

Scope:

- Add a metrics module with counter, gauge, and histogram recording helpers.
- Provide no-op and in-memory test implementations.
- Add a production registry implementation suitable for Prometheus/OpenMetrics export.
- Add configuration for enabling metrics, selecting the exporter, and setting route/auth behavior for the metrics endpoint.
- Ensure collector calls are safe when metrics are disabled.

Acceptance criteria:

- Runtime code can record metrics through a narrow local interface.
- Tests can assert emitted metrics without scraping text output.
- Disabled metrics have near-zero behavior change and do not require optional runtime dependencies to be initialized.
- Metrics recording failures do not fail proxied requests.

Validation:

- Add unit tests for enabled, disabled, and sink-failure behavior.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/src/metrics.ts` (new)
- `apps/proxy/src/config.ts`
- `apps/proxy/test/metrics.test.ts` (new)

## Phase 1: Runtime Instrumentation

### PM-003: Instrument HTTP And Proxy Request Lifecycle

Goal: Record coarse proxy health without relying on logs.

Scope:

- Count incoming HTTP requests by route family, method, status class, and error class.
- Track request duration histograms for admin, health, OpenAI-compatible, Anthropic-compatible, GraphQL, and metrics routes.
- Track in-flight proxied requests.
- Count authenticated, unauthenticated, forbidden, malformed, cancelled, and rate/budget-rejected requests.
- Record request lifecycle outcomes from persisted request/current-state transitions where available.

Acceptance criteria:

- `/healthz` and admin routes are included in HTTP metrics without provider labels.
- Proxied model traffic is grouped by surface and terminal status.
- Client cancellation is distinguishable from provider failure.
- Metrics do not include API key IDs, request IDs, user IDs, or session IDs.

Validation:

- Add integration tests that exercise success, auth failure, malformed body, and cancellation/error paths.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/server.ts`
- `apps/proxy/src/auth.ts`
- `apps/proxy/src/metrics.ts`
- `apps/proxy/test/*.test.ts`

### PM-004: Instrument Routing, Classifier, Provider, And Stream Outcomes

Goal: Make route quality and upstream health visible from metrics.

Scope:

- Count routing decisions by surface, requested route/model class, final route, provider, model, and guardrail outcome.
- Track classifier attempts, retries, failures, structured-output validation failures, duration, and token/cost counters.
- Track provider attempts by provider, model, surface, stream mode, terminal status, HTTP status class, and retry count.
- Track provider duration, time to first byte, streamed bytes, non-SSE protocol mismatches, observer parse failures, and stream disconnect/cancel outcomes.
- Count usage tokens and estimated cost by provider/model/surface using the same normalized usage conventions as `usage_ledger`.

Acceptance criteria:

- Classifier failure before provider spend is visible as a classifier metric and not miscounted as provider failure.
- Provider failures after bytes are sent are distinguishable from pre-byte failures.
- Stream observer failures increment a metric without corrupting passthrough.
- Usage/cost metrics match existing normalization for Responses, Messages, and Chat where supported.

Validation:

- Add tests for explicit route, auto-classified route, classifier failure, provider failure, successful stream, malformed stream event, and client cancellation.
- Run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/router.ts`
- `apps/proxy/src/classifier.ts`
- `apps/proxy/src/providers/*`
- `apps/proxy/src/sseObserver.ts`
- `apps/proxy/src/persistence/values.ts`
- `apps/proxy/test/*routing*.test.ts`
- `apps/proxy/test/*stream*.test.ts`

### PM-005: Export Prometheus/OpenMetrics Endpoint

Goal: Expose operational metrics through a production-friendly scrape endpoint.

Scope:

- Add a metrics endpoint, defaulting to disabled unless explicitly enabled.
- Support Prometheus/OpenMetrics text output with correct content type.
- Protect the endpoint through internal binding, admin auth, or a dedicated metrics token.
- Ensure the endpoint does not leak environment secrets or high-cardinality labels.
- Add smoke coverage for enabled and disabled modes.

Acceptance criteria:

- Disabled mode returns 404 or a configured disabled response.
- Enabled mode exposes registered metrics and process/runtime gauges.
- Unauthorized scrapes fail without revealing metric values.
- The metrics endpoint itself is included in HTTP metrics without recursive or unbounded behavior.

Validation:

- Add endpoint tests for disabled, authorized, unauthorized, and content-type behavior.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm smoke` if the smoke profile starts the proxy.

Likely files:

- `apps/proxy/src/server.ts`
- `apps/proxy/src/config.ts`
- `apps/proxy/src/metrics.ts`
- `apps/proxy/test/metrics.test.ts`
- `README.md`

## Phase 2: Operational Health And Runbooks

### PM-006: Add Worker, Outbox, And Database Health Metrics

Goal: Alert on stuck projections and persistence degradation before users report proxy issues.

Scope:

- Track event append failures, outbox enqueue failures, outbox backlog depth, oldest queued item age, processing attempts, retry counts, and dead-letter/final failure counts.
- Track projection cursor lag where projection cursors exist.
- Track database query duration/error counts for admin analytics rollups and hot-path persistence writes.
- Track persistence disabled/enabled state as a gauge.
- Track terminal-pending provider attempts that require reconciliation.

Acceptance criteria:

- Outbox backlog and oldest queued age are visible without querying Postgres manually.
- Event persistence failures are counted separately from provider failures.
- Admin analytics query slowness is visible without adding per-query high-cardinality labels.
- Terminal-pending attempts are visible as a reconciliation health signal.

Validation:

- Add unit/integration tests for outbox metric updates and database error paths where practical.
- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm --filter @proxy/db test` if schema or migration code changes.

Likely files:

- `apps/proxy/src/events/*`
- `apps/proxy/src/persistence/*`
- `apps/proxy/src/outbox*`
- `apps/proxy/test/persistence*.test.ts`

### PM-007: Document Metrics Runbook, Dashboards, And Alerts

Goal: Make the metrics actionable after deployment.

Scope:

- Add a runbook for enabling metrics locally and in production.
- Document scrape configuration, auth/token setup, and expected labels.
- Add suggested dashboard panels for request rate, error rate, p95 latency, classifier failure rate, provider failure rate, stream disconnects, outbox lag, database latency, token volume, and cost rate.
- Add suggested alerts with initial thresholds and investigation steps.
- Add a deployed smoke check that verifies the metrics endpoint and at least one request-path metric after a synthetic proxy request.

Acceptance criteria:

- An operator can enable metrics and verify scrape output from the docs.
- Alerts distinguish proxy health, provider health, classifier health, and persistence health.
- The runbook links back to the metric contract and names the durable data sources for billing-grade analysis.
- Docs avoid treating metrics counters as billing/audit truth.

Validation:

- Run `pnpm smoke` if smoke scripts are updated.
- Run `pnpm typecheck` if TypeScript code is touched.

Likely files:

- `docs/runbooks/proxy-metrics.md`
- `docs/index.md`
- `apps/proxy/scripts/*`
- `README.md`
