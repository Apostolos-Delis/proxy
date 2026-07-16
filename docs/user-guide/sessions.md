# Sessions And Request Replay

Sessions group related harness requests for replay and cache analysis. The current table remains named `agent_sessions`, but session evidence is derived from logical models and physical deployments rather than model tiers.

## Session List

The Logs session view summarizes:

- surface and external session identity;
- request count and recent activity;
- logical-model changes and logical-model mix;
- deployment and upstream-model mix;
- terminal status counts;
- usage, cost, and cache-hit rate.

A logical-model change means caller intent changed. A deployment change means the same or another logical model resolved to different physical supply. Keep those signals separate during incident analysis.

## Session Detail

The detail view joins:

- request summaries;
- prompt artifacts;
- generic resolution-decision rows;
- provider attempts;
- usage ledger entries;
- ordered events.

For one request, follow this sequence:

```text
request received
  -> gateway admission and authorization
  -> logical-model resolution
  -> provider request forwarded
  -> provider terminal event
  -> usage and request terminal state
```

Classifier-backed logical models include router decision evidence. Direct models should have no classifier cost or router decision.

## Prompt Evidence

Raw prompt text is available only when prompt capture permits it and only through `prompt_artifacts.raw_text`. Events contain hashes and bounded metadata, not full prompts. Prompt access is audited.

Use the artifact list to compare source role/index, capture mode, selected model, logical model, deployment, token estimate, and cost. Respect retention and access controls when sharing incident evidence.

## Debugging Patterns

| Observation | Interpretation |
| --- | --- |
| Requested model absent from caller catalog | Access-profile or grant issue |
| Logical model resolved, no deployment | Broken/disabled graph or wire incompatibility |
| Logical model stable, deployment changes | Classifier selection or physical health/capacity change |
| Deployment stable, upstream model string changes | Deployment configuration changed; inspect audit history |
| Provider attempt exists, no terminal state | Streaming disconnect or terminal persistence failure |
| High classifier cost on direct model | Configuration defect; direct resolution must not classify |
| Cache hit rate falls after deployment change | Provider prefix/cache affinity changed |

## Rejected Requests

A rejected request can still belong to a session and appear in model/status summaries. It may have admission evidence without a provider attempt or usage row. Do not infer missing telemetry merely because physical execution never began.

## Cross-Scope Safety

Session, request, artifact, decision, attempt, and usage queries are organization- and workspace-scoped. A session ID from another scope must not resolve. If expected records are missing, confirm the console workspace before changing persistence or replay logic.
