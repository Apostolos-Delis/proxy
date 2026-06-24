# GEPA-Inspired Prompt Optimization

## Summary

GEPA is useful inspiration for prompt, but it should not run in the hot request path.

The right first use is an offline optimization loop for text artifacts the proxy already controls, especially the route classifier prompt. The proxy should continue to route live Codex and Claude Code requests with the currently promoted policy, then use logged outcomes to improve future classifier and rewrite artifacts asynchronously.

```text
live request
  -> classifier prompt v12
  -> route decision
  -> provider call
  -> events: request features, selected route, cost, outcome

offline optimizer
  -> sample labeled cases
  -> evaluate candidate classifier prompts
  -> inspect failures
  -> propose prompt v13
  -> validate on holdout
  -> canary
  -> promote
```

## Non-Goal

Do not run a GEPA-style optimization loop for each incoming prompt before answering.

That would add many model calls, unpredictable latency, and no reliable score for the single request before the agent has run. It would also make live prompt rewriting hard to audit.

## First Target: Route Classifier Prompt

The classifier prompt is currently the best optimization target because it is small, measurable, and directly tied to cost.

Candidate artifact:

```text
classifier.instructions
```

Training examples:

```text
request features
redacted latest-user excerpt, when allowed
requested model
tool count
current route decision
expected route label
outcome signals
```

Metric:

```text
route accuracy
under-routing penalty
over-routing cost penalty
confidence calibration
policy violation penalty
```

Examples that should route deep:

```text
system design
architecture reviews
event-driven architecture
database/schema/storage design
organization-wide prompt/session storage
analytics pipelines
privacy/security/compliance/retention/access-control design
cost-governance strategy
```

Examples that should usually route fast:

```text
ls
git status
simple read-only file listing
formatting-only edits
typos
one-line explanations
```

## Later Targets

Prompt rewriting policy:

```text
candidate artifact: rewrite instructions/template
metric: task success, user correction rate, judge score, schema validity
risk: changes user intent, so requires strict audit and canarying
```

Memory/context injection policy:

```text
candidate artifact: memory selection/injection policy
metric: quality gain minus token cost
risk: privacy, stale context, cross-user leakage
```

Provider/model policy:

```text
candidate artifact: route-to-provider mapping and effort defaults
metric: quality, latency, cost, retry rate
risk: provider capability drift and inconsistent harness behavior
```

## Required Infrastructure

Prompt artifacts:

```text
id
type
version
content
status: draft | candidate | canary | promoted | retired
created_at
promoted_at
```

Eval cases:

```text
request_hash
session_id
surface
features
redacted_excerpt
expected_route
label_source
outcome_signals
```

Optimization runs:

```text
id
artifact_type
seed_version
trainset_id
holdout_id
budget
status
started_at
completed_at
```

Candidate results:

```text
candidate_version
score
under_route_count
over_route_cost
holdout_score
failure_summary
promotion_decision
```

## Data Sources

Initial labels can come from:

```text
manual labels on sampled requests
explicit router aliases such as router-deep
user feedback like "this should have been xhigh"
route upgrades during a session
repeated failed tool/test loops
LLM judge labels for ambiguous cases
held-out benchmark prompts
```

The event log should store prompt hashes, feature summaries, route decisions, cost, usage, and outcome labels. Raw prompts should remain opt-in encrypted artifacts with retention and access controls.

## Promotion Flow

```text
1. Export eval cases from events/projections.
2. Run GEPA-style optimizer offline.
3. Validate best candidates on holdout data.
4. Compare against currently promoted artifact.
5. Canary on a small percentage of traffic.
6. Promote only if quality and cost metrics improve.
7. Keep rollback pointer to prior promoted version.
```

## Implementation Notes

- Keep the live request path deterministic with a selected artifact version.
- Record artifact version on every route decision.
- Use feature-only classifier inputs by default; redacted excerpts should be explicit.
- Penalize under-routing more heavily than over-routing for security, architecture, migration, and production-risk requests.
- Penalize over-routing for simple status/list/read-only commands.
- Keep the optimizer outside the Node request server at first. A Python runner can consume exported eval cases and write candidate artifacts back to the registry.

## MVP Tickets

1. Add versioned `classifier.instructions` artifact storage.
2. Record classifier artifact version in `routing.classification_recorded`.
3. Add route eval case export from events/projections.
4. Add manual labeling command or endpoint for sampled cases.
5. Add an offline GEPA runner for classifier prompt candidates.
6. Add holdout evaluation and report generation.
7. Add canary selection by classifier artifact version.
8. Add promotion and rollback controls.
