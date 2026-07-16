# Monitoring

## Console Workflow

Start at **Overview** for request volume, tokens, spend, recent requests, model usage, and low-confidence classifier decisions. Then use the focused pages:

| Page | Question |
| --- | --- |
| Usage | Which logical models, deployments, providers, keys, users, and surfaces consume tokens? |
| Cost | Which physical deployments and callers drive spend? |
| Caching | Are provider cache reads, cache writes, busts, and compression behaving as expected? |
| Logs | What happened to one request? |
| Sessions | How did a harness session change logical models or deployments over time? |
| Prompts | What captured artifact and event evidence is available? |

Always confirm the active organization and workspace before comparing counts or investigating a request.

## Request Evidence Checklist

For a failed or surprising request, inspect:

1. `ingressWireId` and `operationId`;
2. `requestedLogicalModel` and `resolvedLogicalModelId`;
3. `accessProfileId` and authorization outcome;
4. `routerKind`, confidence, and bounded `routerDecision` when automatic selection ran;
5. `deploymentId`, `providerConnectionId`, and `egressWireId`;
6. `translated`, translator, and adapter versions;
7. provider attempts, status codes, timings, and safe error classes;
8. normalized usage and deployment-priced cost;
9. terminal request status and event ordering.

This separates caller policy, logical selection, wire compatibility, provider health, and upstream execution instead of treating all failures as model errors.

## Metrics

Enable Prometheus/OpenMetrics output:

```shell
METRICS_ENABLED=true
METRICS_EXPORTER=prometheus
METRICS_TOKEN=<strong-random-token>
```

Then scrape `GET /metrics` with the configured bearer token. Keep metrics authentication enabled in production. See the [metrics runbook](../runbooks/proxy-metrics.md) for names, labels, and alerts.

Useful alert dimensions include ingress surface, operation, logical model, deployment, provider connection, terminal status, provider error class, and latency phase. Avoid high-cardinality raw request, user, or session IDs in metrics.

## Health Signals

Connection health captures credential, quota, rate-limit, and provider-wide failures. Deployment health captures exact-model access and availability. A logical model may remain active while one physical target cools down or is locked out.

Use request evidence plus the health tables to identify the affected physical ID. Follow the [provider health runbook](../runbooks/provider-health.md) rather than bypassing health with an alias or ungranted model.

## Event Writer

The bounded event writer exposes queue depth, dropped events, flush failures, flush latency, and oldest queued event age through the development debug endpoint when enabled. Tune:

- `EVENT_WRITER_MAX_ENTRIES`
- `EVENT_WRITER_MAX_BYTES`
- `EVENT_WRITER_BATCH_SIZE`
- `EVENT_WRITER_SHUTDOWN_TIMEOUT_MS`

Request/current-state persistence and audit transactions remain the primary correctness boundary; asynchronous events add observability fan-out.

## Fast Triage

| Symptom | First check |
| --- | --- |
| 401/403 before request row | API key and access-profile assignment |
| Model-access denial | Model grant, operation, parameter caps |
| No eligible target | Enabled resource graph, wire binding, health |
| Classifier failure | Classifier deployment and router decision evidence |
| Provider 401/429/5xx | Connection/deployment health and attempt classification |
| Wrong response framing | Ingress/egress wires and translator version |
| Spend anomaly | Deployment group, usage tokens, persisted deployment pricing |
| Missing prompt text | Prompt-capture mode and retention, not event payloads |
