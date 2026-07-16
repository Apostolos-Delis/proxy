# Proxy Docs

## User Guide

- [Proxy user guide](user-guide/README.md)
- [Quickstart](user-guide/quickstart.md)
- [API keys and harness setup](user-guide/api-keys.md)
- [Provider connections and credentials](user-guide/provider-auth.md)
- [Monitoring](user-guide/monitoring.md)
- [Sessions and request replay](user-guide/sessions.md)
- [Analytics and spend](user-guide/analytics.md)
- [Prompt caching](user-guide/prompt-caching.md)
- [Token compression](user-guide/token-compression.md)

## Architecture

- [AI gateway architecture](model-routing-proxy.md)
- [AI gateway core data model V1](scopes/ai-gateway-core-model-v1/PLAN.md)
- [Gateway configuration TOML V1](scopes/ai-gateway-core-model-v1/TOML.md)
- [Frontend guidelines](frontend-guidelines.md)

## Delivery

- [AI gateway core data model V1 tickets](scopes/ai-gateway-core-model-v1/TICKETS.md)
- [Gateway control-plane runbook](runbooks/gateway-control-plane.md)
- [Provider health runbook](runbooks/provider-health.md)
- [AWS deployment runbook](runbooks/aws-deployment.md)
- [Proxy metrics runbook](runbooks/proxy-metrics.md)
- [Prompt caching runbook](runbooks/prompt-caching.md)
- [Production SLOs and rollout gates](runbooks/production-rollout-gates.md)

## Harness Setup

- [Harness compatibility matrix](harnesses/compatibility-matrix.md)
- [opencode setup](harnesses/opencode.md)
- [Cursor BYOK setup](harnesses/cursor-byok.md)
- [Claude Code setup](harnesses/claude-code.md)

## Research And Prior Scopes

These documents preserve the analysis that led to the current gateway model. They are not current runtime or operations contracts.

- [Enterprise AI gateway strategy and target architecture](research/enterprise-ai-gateway-analysis.md)
- [Router research aggregate recommendations](research/router-research-recommendations.md)
- [LiteLLM scoping review](research/litellm-scope.md)
- [9router scoping review](research/9router-scope.md)
- [Kong scoping review](research/kong-scope.md)
- [OmniRoute scoping review](research/omniroute-scope.md)
- [Router upstream implementation follow-up](research/router-upstream-implementation-follow-up.md)
- [Archived provider prompt-caching expansion](research/provider-prompt-caching.md)
- [Archived provider prompt-caching tickets](research/provider-prompt-caching-tickets.md)
- [Prior implementation scopes](scopes/)

## Future Work

- [GEPA-inspired prompt optimization](future/gepa-prompt-optimization.md)
- [Token cost reduction](future/token-cost-reduction.md)
- [Tool result compression walkthrough](future/tool-result-compression-walkthrough.md)
- [Spike: tool search + defer_loading injection](future/tool-search-defer-loading-spike.md)
