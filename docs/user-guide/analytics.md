# Analytics And Spend

Proxy separates caller intent from physical supply:

- group by `logical_model` to understand what applications requested;
- group by `deployment` to understand where traffic and spend landed;
- group by provider, model, surface, API key, user, or session for operational attribution.

## Usage Dimensions

Each group reports request/failure/retry counts, latency, input tokens, cached input, cache creation, output, reasoning, total tokens, and cost. Classifier cost is tracked separately from provider execution cost.

Use logical-model and deployment views together. A stable logical model can move between deployments without an application change; a deployment can serve several logical models.

## Pricing

Pricing belongs to `model_deployments`. It can represent the actual upstream model, region, or private endpoint contract being invoked. Provider usage is normalized and priced at write time across:

- uncached input;
- cache reads;
- cache writes;
- output.

Usage ledger rows retain their computed costs. Updating deployment pricing affects future traffic and current baseline comparisons, not the historical ledger value.

The Billing page edits deployment pricing. Unpriced deployment checks compare observed deployment usage with configured deployment rows.

## Baselines And Savings

Baseline models are configured per ingress wire for comparative reporting. Savings are analytical, not a substitute for physical cost accounting. Confirm that the baseline model and rates are appropriate before using savings in business reporting.

Do not describe a classifier's cheaper selection as savings unless the same normalized token usage and current pricing are compared consistently.

## Cache Analytics

Cached input and cache-creation tokens are separate from ordinary input because providers bill them differently. Watch both token share and request hit rate. A high token hit rate with a low request hit rate can be valid when only large requests reuse prefixes.

Use Caching reports for cache bust causes, idle gaps, prewarm outcomes, and compression savings before changing provider cache controls.

## Investigation Workflow

1. Set the organization, workspace, and time range.
2. Start with `logical_model` to find the caller-facing change.
3. Compare `deployment` and provider groups to locate physical movement.
4. Split by API key or user for ownership.
5. Inspect representative requests for resolution and attempt evidence.
6. Verify deployment pricing and normalized token fields.
7. Change logical targets, access policy, pricing, or optimization settings only after the evidence identifies the correct boundary.

## Common Misreads

| Observation | Verify before concluding |
| --- | --- |
| Logical-model spend rose | Request volume, token size, target deployment mix |
| Deployment spend rose | Pricing change, physical selection, provider cache rate |
| Classifier cost rose | Router request volume, classifier deployment, retries |
| Cache savings fell | Deployment change, prefix stability, TTL, request shape |
| User has unexpected spend | API-key attribution and workspace selection |
| Historical cost changed in a chart | Whether the chart is ledger cost or recomputed baseline |
