# Analytics And Spend

Proxy computes usage and spend from provider token counts, routing decisions, and local pricing. The console turns that into operator dashboards.

## What Proxy Records

For each request, Proxy can record:

- Input, cached input, cache creation, output, reasoning, and total tokens.
- Selected model and provider.
- Baseline model for savings comparisons.
- Cost at the rates active when the usage row was written.
- Classifier usage and provider attempts.
- Workspace, user, session, API key, route, and surface dimensions.

## Usage And Cost Pages

Use **Usage / Cost** to answer:

- Which users, workspaces, sessions, providers, or routes drive volume?
- How much did the selected model cost?
- How much would the balanced baseline have cost?
- Which routes produce savings or overruns?
- Are cached tokens actually reducing effective cost?

## Pricing Resolution

Pricing resolves in this order:

1. Built-in defaults in `apps/proxy/src/pricing.ts`.
2. `MODEL_COSTS_JSON` at process start.
3. Per-organization overrides from the console.

Ledger rows keep the rates in effect when they were written. Baseline comparisons can use current pricing for what-if analysis.

## Savings Model

Proxy compares the actual selected model against a baseline route model using the same token counts. This gives an operational estimate of routing savings, not provider invoice truth.

Use savings to spot:

- Requests where a cheaper tier worked.
- Requests where an expensive tier was justified.
- Workspaces that consistently need deeper models.
- Routing configs that drift from expected cost behavior.

## Token Attribution

Token attribution splits request cost and volume by useful dimensions:

- Prompt artifacts and request artifacts.
- Tool-result compression receipts.
- Provider attempts.
- Session and route context.

Use attribution when the question is "what part of the request made this expensive?"

## Cost Investigation Workflow

1. Open **Usage / Cost** and find the spike by time window.
2. Group by workspace, user, provider, model, route, or surface.
3. Open example requests from the expensive group.
4. Inspect prompt artifacts and compression receipts.
5. Check whether the route was pinned or classifier-selected.
6. Adjust routing config, provider pricing, or compression settings if the examples prove a pattern.

## Metrics Versus Ledger

Metrics are process-local operational telemetry. The durable usage ledger and SQL rollups are the audit source of truth.

If metrics and dashboards disagree, trust:

1. `usage_ledger`
2. Request/session SQL rollups
3. Durable events
4. Metrics counters
