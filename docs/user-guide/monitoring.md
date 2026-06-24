# Monitoring

Monitoring in Proxy starts in the console and continues through metrics, provider health, and request logs.

## Overview Dashboard

Open **Overview** for the top-level traffic picture:

![Proxy overview dashboard showing traffic, token volume, spend, and routing savings](../assets/proxy-overview.png)

Use this page to watch:

- Request volume.
- Token volume.
- Spend and estimated savings.
- Route quality and low-confidence decisions.
- Recent traffic shape across providers, models, and routes.

## Logs

Open **Logs** when a request needs inspection:

![Proxy logs page showing replayable agent sessions, models, routes, tokens, and cost](../assets/proxy-logs.png)

Use logs to answer:

- Which route was selected?
- Which provider/model handled the request?
- Was the request translated between OpenAI dialects?
- How many tokens and dollars did it use?
- Which routing config version was active?
- Were any provider targets skipped?

## Provider Health

Open **Model providers** for account and model health. Check this when requests fail, retry, or unexpectedly fall back.

Important health signals:

- Account status.
- Last success and last error.
- Cooldown or lockout windows.
- Consecutive failures.
- Per-model health.

## Metrics Endpoint

Enable OpenMetrics/Prometheus export with:

```shell
METRICS_ENABLED=true
METRICS_EXPORTER=prometheus
METRICS_AUTH_MODE=token
METRICS_TOKEN="$(openssl rand -hex 32)"
```

Verify locally:

```shell
curl -fsS \
  -H "Authorization: Bearer ${METRICS_TOKEN}" \
  http://127.0.0.1:8787/metrics | rg "proxy_http_requests_total|proxy_persistence_enabled"
```

Use the [proxy metrics runbook](../runbooks/proxy-metrics.md) for dashboard panels, alert thresholds, and deployed checks.

## First Alerts To Add

| Alert | Why it matters |
| --- | --- |
| Proxy unavailable | Clients cannot reach the gateway |
| High 5xx rate | Recent deploy, provider, or database issues |
| Auth failure spike | Broken API key rollout or token rotation |
| Classifier failure spike | Routing quality can degrade or fail closed |
| Provider failure spike | Upstream key, model, quota, or health issue |
| Outbox stuck | Event projections and console data can lag |
| Database slow/erroring | Usage, sessions, and audit writes are at risk |

## Debugging Order

1. Check **Overview** for whether the issue is broad or isolated.
2. Check **Logs** for one representative request.
3. Check **Model providers** for account/model health.
4. Check metrics for rate, latency, and error-class changes.
5. Check durable events and usage rows if metrics disagree with the console.
