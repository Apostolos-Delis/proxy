<img src="../assets/proxy-logo.svg" alt="Proxy logo" width="64" height="64" />

# Proxy User Guide

This is the operator path for running the AI gateway, connecting applications and harnesses, controlling model access, and explaining what happened after a request.

## What Proxy Does

Applications continue using OpenAI- or Anthropic-compatible SDKs. Proxy adds:

- API-key authentication and organization/workspace attribution;
- logical-model authorization through reusable access profiles;
- direct or classifier-backed deployment selection;
- provider connection and API-wire abstraction;
- request, resolution, provider-attempt, usage, cost, session, and prompt evidence;
- operational dashboards for traffic, cost, caching, logs, prompts, keys, users, and settings.

## Read This In Order

1. [Quickstart](quickstart.md): start the stack and send a logical-model request.
2. [API Keys And Harness Setup](api-keys.md): issue keys, assign access profiles, and configure SDKs or harnesses.
3. [Provider Connections And Credentials](provider-auth.md): configure physical upstream endpoints and secrets.
4. [Monitoring](monitoring.md): watch traffic and inspect request evidence.
5. [Sessions And Request Replay](sessions.md): debug a session across logical models and deployments.
6. [Analytics And Spend](analytics.md): explain usage and deployment-priced cost.
7. [Prompt Caching](prompt-caching.md): measure provider cache behavior.
8. [Token Compression](token-compression.md): preview and monitor deterministic tool-result compression.

## Mental Model

```text
API key -> access profile -> model grant -> logical model
  -> eligible deployment -> provider connection + wire binding
```

Each request is admitted through one API wire, authorized against one logical model, resolved to one physical deployment, and recorded before provider I/O. Applications never choose provider credentials or internal deployment IDs.

## Common Tasks

| Task | Start here |
| --- | --- |
| Run Proxy locally | [Quickstart](quickstart.md) |
| Connect an application SDK | [API Keys And Harness Setup](api-keys.md#application-sdks) |
| Give a harness cheaper model access | [API Keys And Harness Setup](api-keys.md#access-profiles) |
| Add or rotate an upstream credential | [Provider Connections And Credentials](provider-auth.md) |
| Add a logical model or deployment | [Gateway control-plane runbook](../runbooks/gateway-control-plane.md) |
| Debug a request or session | [Monitoring](monitoring.md) and [Sessions](sessions.md) |
| Explain spend | [Analytics And Spend](analytics.md) |
| Investigate provider availability | [Provider health runbook](../runbooks/provider-health.md) |

## Reference

- [AI gateway architecture](../model-routing-proxy.md)
- [Gateway control-plane runbook](../runbooks/gateway-control-plane.md)
- [Gateway TOML V1](../scopes/ai-gateway-core-model-v1/TOML.md)
- [Harness compatibility matrix](../harnesses/compatibility-matrix.md)
- [Proxy metrics runbook](../runbooks/proxy-metrics.md)
