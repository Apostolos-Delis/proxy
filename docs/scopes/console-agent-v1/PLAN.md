# Console Agent V1

## Goal

Embed an operations agent in the Prompt Proxy web console that can answer questions about live proxy state and author routing changes with human approval.

The agent should handle prompts like:

- "Why did request `req_...` route to the hard tier?"
- "What did the Codex surface cost us this week, broken down by model?"
- "Create a routing config that pins the classifier to `gpt-5-mini` and sends deep routes to Opus, then assign it to the staging API key."
- "Which API keys are still on the seeded default config?"

The reference design is the `mos_generalist` agent in the mortgages repo (MiOS): a pi-harness agent in a TypeScript service, a small gateway tool surface backed by a policy-enforcing capability registry, proposal/approval gating for writes, and a preview-then-upsert authoring flow. This scope adapts that design to Prompt Proxy's smaller, single-language codebase.

Naming note: in this schema, "agent" already means the calling harness — `agent_sessions` rows are Codex/Claude Code sessions. The console assistant is always "console agent" in tables, event types, and routes to keep the two meanings apart.

## Reference Design: MOS Generalist

What MiOS does, and what we keep, adapt, or drop:

| MiOS pattern | Decision for Prompt Proxy |
| --- | --- |
| pi harness (`@earendil-works/pi-coding-agent` 0.78.1 runtime: agent loop, TypeBox tools, event subscription, JSONL sessions, compaction) | Keep. Same packages. |
| Separate `ai-service` process talking to Rails over HTTP | Drop. Everything here is already TypeScript; the agent runs in-process in `apps/proxy`. |
| 4 gateway tools (`searchCapabilities`, `describeCapability`, `describeCapabilities`, `callCapability`) over a large capability catalog | Adapt. V1 has ~20 capabilities, so the search/describe indirection isn't needed yet. Keep the registry abstraction, register capabilities as direct pi tools generated from it. Revisit gateway tools if the catalog grows past ~30. |
| Capability registry with side-effect classes and policy decisions (`executed` / `proposed` / `denied`) | Keep, simplified to two classes (see Capability Registry). |
| Approval cards in UI for `proposed` decisions | Keep. |
| `ask_user_question` tool (structured clarifying questions, terminates turn) | Keep. |
| `todo` tool for multi-step work | Drop for V1. Conversations here are short. |
| Preview → upsert authoring flow | Keep. Maps directly onto routing config drafts and immutable versions. |
| Wiki memory, MCP adapter, skills, document parsing | Out of scope for V1. |
| No embeddings; explicit search capabilities only | Keep. |

## Current State

The repo already has most building blocks the agent needs:

```text
AdminQueryService           read-side queries: overview, requests, request detail,
                            prompts, usage analytics, sessions, api keys,
                            routing configs, users, invitations
RoutingConfigAdminService   createConfig, createVersion, activateVersion,
                            assignApiKeyRoutingConfig, archiveConfig
routingConfigSchema         strict Zod schema for the full config document
appendAdminAuditEvent       admin audit pattern: event + outbox rows inserted in
                            the same transaction as the state mutation
EventService                proxy request-path event pipeline (manages its own
                            transactions; not shareable with admin writes)
PromptAccessAuditStore      audit rows for raw prompt reads
AdminSessionStore           cookie-authenticated console sessions
apps/web shell              TanStack console shell with per-entity detail routes
```

There is no agent, no conversation persistence, no proposal/approval primitive, and no page-scope mechanism in the web shell yet. Roles exist on `organization_members` but no endpoint checks them. Some read queries also need extension: `AdminQueryService.requests()` and `sessions()` are unfiltered latest-N dumps, the model catalog has no persistence read path (it is built in-memory from config via `buildModelCatalog`), and `overview()` does not report active routing configs.

## Architecture

```text
                       apps/web (console)
  ┌──────────────────────────────────────────────────────┐
  │  Console agent dock (new)                            │
  │  streaming text · tool chips · approval cards ·      │
  │  clarifying questions · page scope injection         │
  └───────────────┬──────────────────────────────────────┘
                  │ cookie-auth /admin/console-agent/* + SSE
  ┌───────────────▼──────────────────────────────────────┐
  │  apps/proxy                                          │
  │  ┌────────────────────────────────────────────────┐  │
  │  │ console agent module (new)                     │  │
  │  │ apps/proxy/src/console-agent/                  │  │
  │  │  pi Agent loop  ←  tools generated from        │  │
  │  │  capability registry (new)                     │  │
  │  └───────┬──────────────────────┬─────────────────┘  │
  │          │ reads                │ writes (proposals)  │
  │  AdminQueryService     RoutingConfigAdminService      │
  │          │                      │                     │
  │          └──► event log (appendAdminAuditEvent) ◄┘    │
  └──────────────────────┬───────────────────────────────┘
                         │ LLM calls via own /v1/* surface
                         ▼
                 Prompt Proxy itself (internal API key)
```

New components: the console agent module, the capability registry, conversation/run/proposal tables, the `/admin/console-agent/*` routes, and the console dock. Everything else is reused.

## Harness

Use pi:

- `@earendil-works/pi-agent-core` — `Agent` class, TypeBox tool definitions, lifecycle event stream (`agent_start` → `message_update` → `tool_execution_*` → `agent_end`), steering and follow-up messages.
- `@earendil-works/pi-ai` — multi-provider LLM API with custom base URL support.
- Decision (CA-003): `@earendil-works/pi-coding-agent` is not a dependency. `pi-agent-core` exposes everything the console agent needs — including the compaction utilities (`shouldCompact`, `compact`) MiOS reaches through the coding-agent package — and transcripts persist via `session_state` JSON, with the round-trip verified by `apps/proxy/test/consoleAgentRuntime.test.ts`.

Adopted at 0.79.1 (`pi-agent-core`, `pi-ai`, plus `typebox` 1.1.38 matching pi's own pin for tool schemas).

Rationale: TypeScript like this repo, embeddable rather than CLI-shaped, already proven in-house by MiOS, and tool/event surfaces match what the console needs. The alternative (hand-rolled loop on the existing `LlmClassifier`-style fetch code) would mean rebuilding streaming, tool dispatch, steering, and compaction for no benefit.

## Capability Registry

One declaration per capability, in code:

```ts
type CapabilityDefinition<Input> = {
  key: string;                       // "routing_configs.create.v1"
  description: string;               // shown to the model
  input: z.ZodType<Input>;           // converted to TypeBox/JSON schema for pi
  sideEffect: "none" | "write";
  handler: (ctx: CapabilityContext, input: Input) => Promise<CapabilityResult>;
};
```

V1 has exactly two side-effect classes. MiOS's finer taxonomy (internal write, external write, notification, …) earns its keep only when classes get different policy behavior; until then one `write` class avoids a distinction without a difference. Split it when behavior actually diverges (for example owner-only approval for activation).

`CapabilityContext` carries `organizationId`, acting console user, conversation id, and run id. Policy middleware wraps every handler:

- `sideEffect: "none"` → execute immediately, return `decision: "executed"`.
- `sideEffect: "write"` → persist a proposal row and return `decision: "proposed"` with a preview payload. The handler does not run until a human approves.
- Unknown capability or role check failure → `decision: "denied"` with a reason.

Tools registered on the pi agent are generated from the registry, so the agent's tool list, the policy enforcement point, and the audit producer all derive from one table.

### Read capabilities (V1)

`sideEffect: "none"`. Most wrap existing `AdminQueryService` methods; items marked **(new query)** need new read code and should be sized accordingly.

```text
overview.get.v1                 org snapshot: counts, spend, active configs
                                (new query: overview() lacks active configs)
requests.search.v1              filtered request list (new query: requests() is
                                an unfiltered latest-200 dump today)
requests.get.v1                 request detail: route decision, provider attempts, usage
usage.analytics.v1              usage ledger with filters (existing UsageAnalyticsFilters)
sessions.search.v1              session list (new query: no filters today)
sessions.get.v1                 session detail with pinned routes
routing_configs.list.v1         configs with versions and assignment counts
routing_configs.get.v1          full config document for a version
api_keys.list.v1                keys with routing config assignment
api_keys.get.v1                 key detail
models.catalog.list.v1          model catalog rows with costs (new query: catalog
                                is in-memory from config; no persistence read exists)
prompts.search.v1               prompt artifact list (metadata only)
prompts.get.v1                  raw prompt text — appends the same
                                prompt-access-audit event as the console UI;
                                persisted by reference only (see Data Model)
```

### Validation capability (V1)

`sideEffect: "none"` — validation only, no writes, no proposal. This is new logic, not a service wrapper.

```text
routing_configs.preview.v1      dry run: validate a draft config document with
                                routingConfigSchema, diff against the current
                                active version, return the normalized document
                                and a base-state fingerprint (active version id
                                + config hash)
```

### Write capabilities (V1)

All wrap existing `RoutingConfigAdminService` methods. `sideEffect: "write"`, proposal-gated.

```text
routing_configs.create.v1
routing_configs.create_version.v1
routing_configs.activate_version.v1
routing_configs.archive.v1
api_keys.assign_routing_config.v1
```

### Agent-native tools

- `ask_user_question` — structured clarifying questions (max 4, with options), `terminate: true` so the turn ends and the answer arrives as the next user message. Port of the MiOS tool.

## Flagship Flow: Authoring A Routing Config

Mirrors the MiOS workflow-authoring loop (prepare → preview → upsert with approval), mapped onto the existing immutable-version model:

1. User asks for a routing change in the dock, optionally from a config detail page (page scope provides `configId`).
2. Agent reads current state (`routing_configs.get.v1`, `models.catalog.list.v1`) and drafts a config document.
3. Agent calls `routing_configs.preview.v1`. Validation errors come back as tool results; the agent iterates until the draft is clean. The preview returns the normalized document, a diff against the active version, and a base-state fingerprint.
4. Agent calls `routing_configs.create_version.v1` with the draft. Policy intercepts: a proposal row is persisted (input, preview, base-state fingerprint, dedupe key), the tool returns `decision: "proposed"`, and the run ends with an approval card in the dock showing the diff.
5. User approves or rejects in the console. Approval atomically transitions the proposal `pending → approved` and re-checks the base-state fingerprint in the same transaction — if the config's active version or hash changed since preview, the proposal fails as `stale` and the agent must re-preview. On success, the held `RoutingConfigAdminService.createVersion` call executes under the approving user's identity, appending its domain audit events as usual plus `console_agent.proposal.approved`.
6. Activation is always a separate proposal (`routing_configs.activate_version.v1`), preserving today's draft-then-activate operator model.

## Interface

### HTTP API

Cookie-authenticated, same guard as other `/admin` routes:

```text
POST   /admin/console-agent/conversations                  create conversation
GET    /admin/console-agent/conversations                  list (creator-scoped)
GET    /admin/console-agent/conversations/:id              transcript + proposals
POST   /admin/console-agent/conversations/:id/messages     send user message, start run
GET    /admin/console-agent/runs/:runId/events             SSE stream of run events
POST   /admin/console-agent/runs/:runId/cancel             abort via AbortController
POST   /admin/console-agent/proposals/:proposalId/approve
POST   /admin/console-agent/proposals/:proposalId/reject
```

Authorization per route group:

- Conversations and runs are creator-scoped: `:id`/`:runId` routes verify the conversation's `created_by_user_id` matches the session user, not just org membership.
- Proposals are org-visible to `owner`/`admin` and record both proposer and resolver. Self-approval is allowed in V1: the approval gate is a human-in-the-loop check on agent output, not a two-person rule. A two-person rule can be layered on later without schema changes.

pi lifecycle events map to a small public event vocabulary, as in MiOS's `mapPiEvent`: `run_started`, `text_delta`, `tool_call_started`, `tool_call_finished`, `message_finished`, `question_asked`, `proposal_created`, `run_finished`, `run_failed`. The SSE stream emits all of these. Serving SSE from an admin route is new ground in this repo (the existing `sseObserver.ts` consumes upstream provider streams; it is not a serving pattern). The stream supports reconnect via `Last-Event-ID` replayed from `console_agent_run_events.seq`. `text_delta` events are SSE-only and never persisted — final text lives in `console_agent_messages`; persisted events cover lifecycle, tool calls, proposals, and message-final snapshots.

### Console UI

- A dock in the shell (right-side drawer, toggle in the top bar), available on every page — the MiOS `MortgageOsBotDock` shape, styled to the existing dense/quiet console aesthetic.
- Page scope injection: each route can contribute the entity in view (`requestId`, `configId`, `apiKeyId`, `sessionId`) to the next turn's context, so "why did this request route hard?" works without pasting IDs. Scope is captured on each user message at send time (see Data Model), so it tracks navigation between turns.
- Rendered message kinds: streaming assistant text, collapsible tool-call chips (capability key + duration + decision), approval cards (config diff, approve/reject), clarifying-question cards (option buttons), error states.
- Follows existing frontend rules: TanStack Query for data, no `useEffect`, files under 300 lines, no new state library. SSE consumption goes through a small subscription helper in `lib/`, not component-level effects.

## Data Model

New tables, all org-scoped per the architecture rules (Drizzle schema + migration in the same change). The `console_agent_` prefix keeps them distinct from `agent_sessions`, which means harness sessions:

```text
console_agent_conversations   id, organization_id, created_by_user_id, title,
                              session_state jsonb nullable, created_at, updated_at

console_agent_messages        id, organization_id, conversation_id, role,
                              content jsonb, page_scope jsonb nullable,
                              run_id nullable, created_at

console_agent_runs            id, organization_id, conversation_id,
                              status (running/finished/failed/cancelled/
                              awaiting_input/awaiting_approval),
                              model, usage jsonb, error, started_at, finished_at

console_agent_run_events      id, organization_id, run_id, seq, type,
                              payload jsonb, created_at

console_agent_proposals       id, organization_id, conversation_id, run_id,
                              capability_key, input jsonb, preview jsonb,
                              base_state jsonb, dedupe_key,
                              status (pending/approved/rejected/expired/stale),
                              proposed_by_user_id, resolved_by_user_id,
                              resolved_at, expires_at, created_at
```

- `session_state` on the conversation row holds the model-facing pi transcript, updated in the same transaction that finalizes each run. No object storage. The user-facing transcript always renders from `console_agent_messages` and `console_agent_run_events`, never from `session_state`.
- `page_scope` lives on user message rows because scope changes as the user navigates between turns.
- `dedupe_key` exists only to prevent duplicate proposal rows when the agent retries a tool call. Double-apply protection comes from the atomic `pending → approved` status transition, not from this key.

**Raw prompt text rule.** AGENTS.md allows raw prompt text only in `prompt_artifacts.raw_text`. None of these tables may hold it. `prompts.get.v1` returns raw text to the model within the live turn, but at every persistence boundary — `console_agent_messages`, `console_agent_run_events`, and `session_state` — that tool result is serialized as a reference (`{ artifactId, redacted: true }` plus metadata). A resumed conversation re-fetches the artifact through the capability (appending a fresh access-audit row) instead of replaying stored text.

## Events And Audit

- New producer `prompt-proxy.console-agent` emitting `console_agent.conversation.created`, `console_agent.run.started`, `console_agent.run.finished`, `console_agent.capability.executed`, `console_agent.proposal.created`, `console_agent.proposal.approved`, `console_agent.proposal.rejected`.
- Mechanism: these events follow the `appendAdminAuditEvent` pattern — event and outbox rows inserted in the same transaction as the state mutation they describe, satisfying the same-transaction rule in AGENTS.md. `EventService` is the request-path pipeline and manages its own transactions; it is not used here unless first extended to accept an external transaction.
- Capability handlers reuse the existing services, so domain audit events (`routing_config.*`, prompt access audit) fire exactly as they do from the console UI.
- Event payloads follow the existing rule: no raw prompt text outside `prompt_artifacts.raw_text`.

## Permissions And Safety

- V1 gates the agent UI and API to `owner` and `admin` roles. This is the first endpoint-level role gate in the codebase (`UserAdminService` already enforces owner-role domain invariants, but no route checks `role` today); it is deliberately small — one guard on `/admin/console-agent/*`.
- Writes are only reachable through proposals. The agent process never holds the ability to mutate directly; approval executes under the approving user's identity.
- Approval is an atomic status transition (`UPDATE … SET status = 'approved' WHERE id = $1 AND status = 'pending'`, returning) in the same transaction as the held service call, so concurrent approvals cannot double-apply.
- The approval transaction re-checks the proposal's `base_state` fingerprint and fails the proposal as `stale` if the underlying config changed after preview.
- Proposals expire (default 24h).
- Approval cards render only the server-persisted `preview`/diff from the proposal row as the authoritative description of the change — never agent-generated prose. This is the prompt-injection boundary: `prompts.get.v1` feeds untrusted prompt text into the same context that authors proposals, so the human must approve what the server computed, not what the model wrote.
- `prompts.get.v1` appends prompt-access-audit rows attributed to the console user, flagged as agent-mediated.
- Run loop limits: max turns per run, max tool calls per turn, wall-clock timeout, AbortController on cancel — all configurable via settings.

## Model Access

The agent's own LLM calls go through Prompt Proxy itself via `pi-ai` with a custom base URL and a dedicated internal API key:

- Usage metering, cost attribution, and request logging come for free.
- The internal key's raw token is supplied via environment/secret reference at deploy time, like provider keys. It is never persisted in `organization_settings` or `.prompt-proxy/settings.json`.
- The key row carries an `internal` boolean; usage and overview queries exclude internal-flagged traffic by default so the agent's own calls don't pollute org-facing analytics. Request logs keep the rows, visibly tagged.
- Agent requests pin an explicit route alias in the `console-agent` routing config rather than `router-auto`, so each agent call does not trigger an extra classifier LLM call.
- It dogfoods the product: the agent's traffic exercises routing, persistence, and the usage ledger.

Default model: a hard-tier Anthropic model with thinking enabled; configurable in settings like the classifier.

## Build Plan

1. **Registry + read agent (no UI)** — capability registry, policy middleware (`executed`/`denied` only), pi agent module wired to read capabilities, conversation/run/event tables (org-scoped), `/admin/console-agent/*` routes with SSE, and the new query methods called out above (request/session filters, catalog read, overview active configs). Verified by an integration test driving a conversation over HTTP against seeded data.
2. **Console dock** — shell drawer, streaming transcript, tool chips, page scope injection.
3. **Proposals** — proposal table and lifecycle (atomic approval transition, base-state staleness check, expiry), write capabilities, `routing_configs.preview.v1`, approval cards, approve/reject endpoints, `ask_user_question`.
4. **Hardening** — run limits, role guard, internal API key via secret reference, `internal` flag on API keys plus usage/overview query exclusion, settings page section, runbook doc.

Each phase is independently shippable; phase 1 + 2 already deliver a useful read-only operations copilot.

## Out Of Scope

- MCP servers, skills, wiki-style memory, document parsing (MiOS features we may want later).
- Mutations beyond routing configs and API key assignment (settings, users, invitations).
- Embedding-based search; all retrieval is explicit capability calls.
- Multi-agent / sub-agent orchestration.
- Exposing the agent outside the authenticated console.
- Two-person approval rules (self-approval is allowed in V1).

## Open Questions

1. Should agent traffic be fully partitioned out of the org's request log, or visible but tagged? Default proposal: visible but tagged `internal` and excluded from usage analytics (mechanism specified in Model Access).
2. Conversation visibility: private to the creating user (MiOS default, and what the route authorization above assumes) or org-visible? Default proposal: private in V1.
