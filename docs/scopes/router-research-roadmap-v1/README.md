# Router Research Roadmap V1

This folder turns the router research takeaways into concrete implementation scopes.

The upstream research lives in:

- [LiteLLM scoping review](../../research/litellm-scope.md)
- [9router scoping review](../../research/9router-scope.md)
- [Kong scoping review](../../research/kong-scope.md)
- [OmniRoute scoping review](../../research/omniroute-scope.md)
- [Aggregate recommendations](../../research/router-research-recommendations.md)
- [Second-pass implementation follow-up](../../research/router-upstream-implementation-follow-up.md)

## Scope Documents

1. [Route execution plan](route-execution-plan.md) ([tickets](route-execution-plan-tickets.md))
2. [Provider account health](provider-account-health.md)
3. [Auditable fallback](auditable-fallback.md)
4. [Provider registry V2](provider-registry-v2.md)
5. [Harness compatibility tests](harness-compatibility-tests.md)
6. [Policy pipeline](policy-pipeline.md)
7. [Limits and budgets](limits-and-budgets.md)
8. [Tool output compression](tool-output-compression.md)
   - [Tool output compression tickets](tool-output-compression-tickets.md)
9. [Metrics and events](metrics-and-events.md)
10. [Product boundaries](product-boundaries.md)

## Sequencing

The recommended order is:

```text
route execution plan
  -> provider account health
  -> auditable fallback
  -> provider registry V2
  -> policy pipeline
  -> limits and budgets
  -> harness compatibility tests
  -> tool output compression
  -> metrics and events
  -> product boundaries enforced as review criteria throughout
```

Route execution plans come first because every later feature needs a durable place to explain its decisions. Provider health and fallback come next because they define the operational behavior of the router. Provider registry and policy pipeline then make the request path scalable. Harness tests and compression should be added once the route behavior is explainable.

## Shared Principles

- Keep classifier-first routing. Do not add deterministic route fallback when classification fails.
- Prefer native provider dialects. Translation is explicit and tested.
- Record durable route evidence before provider spend.
- Keep raw prompt text inside prompt artifacts only.
- Scope runtime traffic state by organization and workspace.
- Make fallback, compression, provider skipping, and translation visible to operators.
- Do not add arbitrary plugins, MITM behavior, or free-provider aggregation as product goals.
