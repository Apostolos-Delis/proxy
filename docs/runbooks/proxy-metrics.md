# Proxy Metrics Runbook

Prompt Proxy exposes operational metrics for alerting and production diagnosis. Metrics are not the billing or audit source of truth; durable events, current-state tables, `usage_ledger`, and SQL rollups remain authoritative for usage analytics and replay.

The metric taxonomy and label policy live in [the proxy metrics scope](../scopes/proxy-metrics-v1/PLAN.md).

## Enable Metrics

Metrics are disabled by default. Enable the OpenMetrics/Prometheus endpoint with:

```shell
METRICS_ENABLED=true
METRICS_EXPORTER=prometheus
METRICS_PATH=/metrics
METRICS_AUTH_MODE=token
METRICS_TOKEN="$(openssl rand -hex 32)"
```

In production, `METRICS_AUTH_MODE=none` is rejected. Token auth accepts either:

```text
Authorization: Bearer <METRICS_TOKEN>
x-api-key: <METRICS_TOKEN>
```

When metrics are disabled, `GET /metrics` returns 404. When token auth is enabled without a token, `GET /metrics` returns 401.

## Verify Locally

Start the proxy with metrics enabled, then generate one request and scrape:

```shell
curl -fsS http://127.0.0.1:8787/healthz >/dev/null

curl -fsS \
  -H "Authorization: Bearer ${METRICS_TOKEN}" \
  http://127.0.0.1:8787/metrics | rg "prompt_proxy_http_requests_total|prompt_proxy_http_request_duration_seconds"
```

Expected:

- `prompt_proxy_http_requests_total` includes a `route_family="health"` sample.
- `prompt_proxy_http_request_duration_seconds` includes histogram buckets.
- `prompt_proxy_persistence_enabled` is `1` when `DATABASE_URL` is active, otherwise `0`.

Run focused automated coverage with:

```shell
pnpm build:runtime
pnpm --filter @prompt-proxy/proxy exec vitest run test/metrics.test.ts
```

## Scrape Configuration

Prometheus example:

```yaml
scrape_configs:
  - job_name: prompt-proxy
    metrics_path: /metrics
    scheme: https
    authorization:
      type: Bearer
      credentials: ${METRICS_TOKEN}
    static_configs:
      - targets:
          - prompt-proxy.example.com
```

For CloudWatch Agent, Grafana Agent, or another collector, use the same bearer token and preserve the OpenMetrics content type. Do not forward user cookies, admin session cookies, provider keys, or prompt-proxy API keys to the metrics endpoint.

## Dashboard Panels

Suggested first dashboard:

| Panel | Metrics |
| --- | --- |
| Request rate | `rate(prompt_proxy_http_requests_total[5m])` grouped by `route_family`, `status_class` |
| Model request rate | `rate(prompt_proxy_model_requests_total[5m])` grouped by `surface`, `terminal_status` |
| Error rate | `rate(prompt_proxy_http_requests_total{error_class!="none"}[5m]) / rate(prompt_proxy_http_requests_total[5m])` |
| p95 HTTP latency | `histogram_quantile(0.95, sum by (le, route_family) (rate(prompt_proxy_http_request_duration_seconds_bucket[5m])))` |
| p95 provider latency | `histogram_quantile(0.95, sum by (le, provider, model) (rate(prompt_proxy_provider_attempt_duration_seconds_bucket[5m])))` |
| p95 time to first byte | `histogram_quantile(0.95, sum by (le, provider, model) (rate(prompt_proxy_provider_time_to_first_byte_seconds_bucket[5m])))` |
| Classifier health | `rate(prompt_proxy_classifier_attempts_total[5m])` grouped by `outcome`, `error_class` |
| Provider health | `rate(prompt_proxy_provider_attempts_total[5m])` grouped by `provider`, `terminal_status`, `error_class` |
| Stream health | `rate(prompt_proxy_provider_stream_disconnects_total[5m])`, `rate(prompt_proxy_sse_observer_parse_failures_total[5m])`, `rate(prompt_proxy_provider_protocol_mismatches_total[5m])` |
| Outbox health | `prompt_proxy_outbox_backlog`, `prompt_proxy_outbox_oldest_item_age_seconds` |
| Database latency/errors | p95 `prompt_proxy_db_query_duration_seconds`, `rate(prompt_proxy_db_errors_total[5m])` |
| Token and cost rate | `rate(prompt_proxy_usage_tokens_total[5m])`, `rate(prompt_proxy_cost_usd_total[5m])` |
| Reconciliation risk | `prompt_proxy_terminal_pending_provider_attempts` |

## Alerts

Initial thresholds should be tuned after a few days of baseline traffic.

| Alert | Initial threshold | First checks |
| --- | --- | --- |
| Proxy unavailable | `up == 0` or scrape missing for 2 intervals | ECS/process health, deploy status, load balancer target health |
| High 5xx rate | 5xx `prompt_proxy_http_requests_total` over 2% for 10m | Proxy logs, recent deploy, database connectivity |
| Auth failure spike | `error_class="auth"` request rate doubles baseline | API key rollout, client config, token rotation |
| Classifier failure spike | `rate(prompt_proxy_classifier_attempts_total{outcome="failed"}[5m])` over 5% | Classifier provider key/base URL, structured output errors, timeout settings |
| Provider failure spike | `rate(prompt_proxy_provider_attempts_total{terminal_status="failed"}[5m])` over 5% by provider | Provider status, selected model availability, BYOK credential bindings |
| Provider p95 latency high | p95 provider duration above 60s for 10m | Provider latency, route mix, streaming clients |
| Stream disconnect spike | Disconnect/protocol mismatch rate above baseline | Client cancellations, proxy/load balancer idle timeout, provider SSE behavior |
| Outbox stuck | `prompt_proxy_outbox_backlog > 0` and oldest age over 5m | Event handler errors, projection worker health |
| DB slow/erroring | DB p95 above 2s or any sustained `prompt_proxy_db_errors_total` | Postgres CPU/locks, migration status, usage rollup query plans |
| Terminal pending attempts | Gauge remains above 0 for 10m | Reconciliation path, provider terminal append errors, stream disconnects |

## Troubleshooting

- If `/metrics` is 404, check `METRICS_ENABLED=true` and `METRICS_EXPORTER=prometheus`.
- If `/metrics` is 401, check `METRICS_TOKEN` and the bearer or `x-api-key` header.
- If counters are present but request metrics are absent, generate a request after the process starts; scrapes show metrics accumulated in the current process.
- If provider usage metrics are absent for successful requests, inspect provider terminal events and `usage_ledger`; providers sometimes omit usage on failures or incomplete streams.
- If metric cost rates disagree with billing reports, trust `usage_ledger` and SQL rollups first. Metrics counters are process-local telemetry and can reset on deploy.
- If custom provider/model labels collapse to `custom` or `unknown`, update the allowlist/normalization policy before exposing raw user-defined labels.

## Deployed Check

After enabling metrics in a deployed environment:

```shell
curl -fsS "${PROMPT_PROXY_DEPLOYED_BASE_URL}/healthz" >/dev/null

curl -fsS \
  -H "Authorization: Bearer ${METRICS_TOKEN}" \
  "${PROMPT_PROXY_DEPLOYED_BASE_URL}/metrics" | rg "prompt_proxy_http_requests_total|prompt_proxy_persistence_enabled"
```

This verifies the edge path preserves auth headers and that the endpoint is reachable. Full request-path behavior is covered by `pnpm smoke:deployed`; metrics-specific endpoint behavior is covered by `apps/proxy/test/metrics.test.ts`.
