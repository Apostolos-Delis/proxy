# Proxy Docs

## User Guide

- [Proxy user guide](user-guide/README.md)
- [Quickstart](user-guide/quickstart.md)
- [API keys and harness setup](user-guide/api-keys.md)
- [Provider auth](user-guide/provider-auth.md)
- [Monitoring](user-guide/monitoring.md)
- [Sessions and request replay](user-guide/sessions.md)
- [Analytics and spend](user-guide/analytics.md)
- [Token compression](user-guide/token-compression.md)

## Architecture

- [Model routing proxy design](model-routing-proxy.md)
- [Frontend guidelines](frontend-guidelines.md)
- [Persistence and admin console scope](scopes/persistence-admin-v1/PLAN.md)
- [TanStack admin app scope](scopes/tanstack-admin-app-v1/PLAN.md)
- [Routing configs scope](scopes/routing-configs-v1/PLAN.md)
- [Model access profiles scope](scopes/model-access-profiles-v1/PLAN.md)
- [AWS prod-like deployment scope](scopes/aws-prod-like-deployment-v1/PLAN.md)
- [Subscription auth scope](scopes/subscription-auth-v1/PLAN.md)
- [Subscription local auth import scope](scopes/subscription-local-auth-v1/PLAN.md)
- [Provider architecture scope](scopes/provider-architecture-v1/PLAN.md)
- [Harness model translation scope](scopes/harness-model-translation-v1/PLAN.md)
- [Proxy metrics scope](scopes/proxy-metrics-v1/PLAN.md)
- [Reversible compression scope](scopes/reversible-compression-v1/PLAN.md)
- [Reversible compression retrieval tool injection spike](scopes/reversible-compression-v1/RETRIEVAL_TOOL_INJECTION_SPIKE.md)

## Research

- [Router research aggregate recommendations](research/router-research-recommendations.md)
- [LiteLLM scoping review](research/litellm-scope.md)
- [9router scoping review](research/9router-scope.md)
- [Kong scoping review](research/kong-scope.md)
- [OmniRoute scoping review](research/omniroute-scope.md)
- [Router upstream implementation follow-up](research/router-upstream-implementation-follow-up.md)

## Router Research Scopes

- [Router research roadmap index](scopes/router-research-roadmap-v1/README.md)
- [Route execution plan scope](scopes/router-research-roadmap-v1/route-execution-plan.md)
- [Provider account health scope](scopes/router-research-roadmap-v1/provider-account-health.md)
- [Auditable fallback scope](scopes/router-research-roadmap-v1/auditable-fallback.md)
- [Provider registry V2 scope](scopes/router-research-roadmap-v1/provider-registry-v2.md)
- [Harness compatibility tests scope](scopes/router-research-roadmap-v1/harness-compatibility-tests.md)
- [Policy pipeline scope](scopes/router-research-roadmap-v1/policy-pipeline.md)
- [Limits and budgets scope](scopes/router-research-roadmap-v1/limits-and-budgets.md)
- [Tool output compression scope](scopes/router-research-roadmap-v1/tool-output-compression.md)
- [Metrics and events scope](scopes/router-research-roadmap-v1/metrics-and-events.md)
- [Product boundaries scope](scopes/router-research-roadmap-v1/product-boundaries.md)

## Execution

- [Implementation tickets](implementation-tickets.md)
- [Route execution plan V1 tickets](scopes/router-research-roadmap-v1/route-execution-plan-tickets.md)
- [Routing configs V1 tickets](scopes/routing-configs-v1/TICKETS.md)
- [AWS prod-like deployment tickets](scopes/aws-prod-like-deployment-v1/TICKETS.md)
- [Subscription auth V1 tickets](scopes/subscription-auth-v1/TICKETS.md)
- [Provider architecture V1 tickets](scopes/provider-architecture-v1/TICKETS.md)
- [Harness model translation V1 tickets](scopes/harness-model-translation-v1/TICKETS.md)
- [Tool output compression tickets](scopes/router-research-roadmap-v1/tool-output-compression-tickets.md)
- [Reversible compression V1 tickets](scopes/reversible-compression-v1/TICKETS.md)
- [Proxy metrics V1 tickets](scopes/proxy-metrics-v1/TICKETS.md)
- [Harness compatibility tests V1 tickets](scopes/router-research-roadmap-v1/harness-compatibility-tests-tickets.md)
- [Routing configs runbook](runbooks/routing-configs.md)
- [AWS deployment runbook](runbooks/aws-deployment.md)
- [Proxy metrics runbook](runbooks/proxy-metrics.md)
- [Production SLOs and rollout gates](runbooks/production-rollout-gates.md)
- [Subscription auth runbook](runbooks/subscription-auth.md)
- [Provider account health runbook](runbooks/provider-account-health.md)

## Harness Setup

- [Harness compatibility matrix](harnesses/compatibility-matrix.md)
- [opencode setup](harnesses/opencode.md)
- [Cursor BYOK setup](harnesses/cursor-byok.md)
- [Claude Code setup](harnesses/claude-code.md)

## Future Work

- [GEPA-inspired prompt optimization](future/gepa-prompt-optimization.md)
- [Token cost reduction](future/token-cost-reduction.md)
- [Provider prompt caching expansion](future/provider-prompt-caching.md)
- [Tool result compression walkthrough](future/tool-result-compression-walkthrough.md)
- [Spike: tool search + defer_loading injection](future/tool-search-defer-loading-spike.md)
