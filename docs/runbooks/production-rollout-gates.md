# Production SLOs and rollout gates

Use this runbook before increasing Prompt Proxy traffic, changing request-path behavior, changing async observability, or changing ECS/RDS sizing. The goal is to protect correctness and operability while scaling throughput.

## Release gates

Do not promote a release if any required gate is red.

| Area | SLO / gate | Signal today | Gate |
| --- | --- | --- | --- |
| Health check availability | `/healthz` succeeds for 99.9% of checks over 30 minutes. | ALB target health, deployed smoke, CloudWatch `UnHealthyHostCount`. | No unhealthy targets for 10 minutes after deploy; deployed smoke passes. |
| Proxy 5xx rate | Target 5xx rate stays below 0.5% over 5 minutes and below 0.1% over 30 minutes. | ALB `HTTPCode_Target_5XX_Count`; CDK alarm `proxy-target-5xx`. | No new 5xx alarm; canary request error rate below threshold. |
| Pre-forward latency | Cache-hit mock-provider p95 below 500 ms and p99 below 1500 ms; classifier-miss p95 must not regress more than 25% from the last accepted load report. Production p95 must not regress more than 25% from the previous 7-day baseline. | `requestPathLatency` logs, load harness `preForwardMs`, future CloudWatch Logs Insights metric. | Hot-path load report is below fixed threshold; classifier-miss and production canary stay within regression gate. |
| TTFT | Cache-hit mock-provider p95 below 1000 ms and p99 below 2500 ms; classifier-miss p95 must not regress more than 25% from the last accepted load report. Production p95 must not regress more than 25% from the previous 7-day baseline. | Load harness `ttftMs`; request timing `firstByteMs`; provider-specific production baselines. | Hot-path load report is below fixed threshold; classifier-miss and production canary stay within regression gate unless release notes classify provider latency as out of scope. |
| Event flush lag | Async observability queue oldest age stays below 5 seconds p95 and 30 seconds max during steady load. | `/_debug/event-writer.oldestEventAgeMs`, request logs, warning logs. | No sustained queue growth; shutdown drain completes without timeout. |
| Dropped observability events | Dropped observability event rate is 0 during normal traffic; never above 0.1% during intentional stress. | `/_debug/event-writer.dropped`, warning logs, load report notes. | Any drop outside an explicit stress test blocks promotion. |
| RDS CPU/connections/IOPS | CPU below 70%; connections below `DB_POOL_MAX * maxProxyCount` budget and below 70% of RDS max; IOPS and burst balance have 30% headroom. | RDS CloudWatch CPU, connections, read/write IOPS, write latency, burst balance. | No RDS alarm; headroom checked before scale-up and after 30 minutes. |
| Task RSS | ECS memory stays below 75% p95 and below 85% max during load. | ECS service memory utilization; CDK alarm `proxy-high-memory`; load harness local RSS for no-spend dry runs. | No memory alarm; no monotonic RSS growth during the load window. |
| Event-loop lag | p95 below 100 ms and p99 below 250 ms for request-path logs during mock-provider load. | `requestPathLatency.eventLoopLagMs` logs. | Logs Insights sample stays under threshold; any p99 above 500 ms blocks promotion. |

## Required preflight

Run these before staging/prod rollout:

```shell
pnpm build:runtime
pnpm load:proxy -- --profile=smoke --json-out=.context/load-smoke.json
pnpm load:proxy -- --profile=classifier-cache --json-out=.context/load-classifier-cache.json
pnpm load:proxy -- --profile=provider-failures --json-out=.context/load-provider-failures.json
```

For scale-up changes, also run the larger profile against local mocks or a no-spend staging environment:

```shell
pnpm load:proxy -- --profile=scale-readiness --json-out=.context/load-scale-readiness.json
```

Attach the generated JSON files to the rollout issue or PR. If the rollout targets a deployed environment, set `PROMPT_PROXY_LOAD_BASE_URL` and `PROMPT_PROXY_LOAD_API_KEY` and only run against an environment configured for no-spend or controlled-load provider traffic.

## Canary steps

1. Deploy to staging first.
2. Run `pnpm smoke:deployed`.
3. Run the no-spend load smoke and, for scale changes, `scale-readiness`.
4. Watch CloudWatch alarms for at least 10 minutes: target 5xx, response time, unhealthy targets, CPU, memory, restarts, and RDS headroom.
5. Query request latency logs for `requestPathLatency` p95/p99 TTFT, pre-forward latency, and event-loop lag.
6. Check `/_debug/event-writer` during load and after load. Queue depth should return to 0 and dropped count should stay 0 unless the run is an intentional overflow test.
7. Promote to prod only after staging meets all gates.

## Production rollout

1. Confirm RDS headroom using the AWS deployment runbook.
2. Deploy the runtime image and infrastructure sizing change.
3. Run `pnpm smoke:deployed`.
4. Watch canary traffic for 10 minutes before increasing load.
5. During scale-up, increase one dimension at a time: desired task count, max task count, then load profile. Do not raise ECS max tasks beyond the DB pool budget.
6. Keep the previous image tag, previous CDK context, and previous environment config available until the 30-minute post-deploy window is clean.

## Rollback

Use the AWS deployment runbook runtime rollback command for any correctness regression, sustained 5xx, high event-loop lag, or provider forwarding regression.

Async event writer rollback:

1. If `/_debug/event-writer` shows growing depth or drops, stop traffic increase immediately.
2. Capture current `/_debug/event-writer` stats and warning logs.
3. If the task is otherwise healthy, temporarily increase `EVENT_WRITER_MAX_ENTRIES` / `EVENT_WRITER_MAX_BYTES` only to drain a known burst. Do not use this to mask steady overload.
4. Redeploy the previous known-good runtime image if drops continue, flush failures continue, or admin projections fall behind.
5. After rollback, verify `pnpm smoke:deployed`, event writer depth returning to 0, and no new dropped events.

Infra sizing rollback:

1. For ECS regressions, reduce `maxProxyCount` first to stop DB pressure, then lower desired count after traffic stabilizes.
2. Restore the previous CPU/memory/env config and redeploy the service stack.
3. Do not downsize RDS immediately after an incident. Take a snapshot, wait for a quiet window, then downsize only after connection, CPU, and IOPS headroom is proven.
4. If autoscaling causes oscillation, disable the latest scaling policy or restore the prior target CPU/memory thresholds before redeploying.

## Rollout report template

```text
Release:
Image tag:
Environment:
Load reports attached:
- .context/load-smoke.json
- .context/load-classifier-cache.json
- .context/load-provider-failures.json
- .context/load-scale-readiness.json (if scale-up)
SLO gates:
- health:
- 5xx:
- pre-forward latency:
- TTFT:
- event writer lag/drops:
- RDS:
- task RSS/event-loop lag:
Rollback image/config:
Decision:
```
