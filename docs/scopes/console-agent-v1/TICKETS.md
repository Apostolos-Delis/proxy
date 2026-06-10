# Console Agent V1 Tickets

These tickets break the [console agent scope](PLAN.md) into PR-sized units.

The intended delivery shape is four independently shippable phases: read agent backend, console dock, proposal-gated writes, then hardening. Phases 1 + 2 already deliver a useful read-only operations copilot.

## Delivery Rules

- All `console_agent_*` tables and events are organization scoped. "Agent" alone means the calling harness; the assistant is always "console agent".
- Audit events follow the `appendAdminAuditEvent` pattern: event and outbox rows insert in the same transaction as the state mutation. Do not route console agent audit through `EventService`.
- No raw prompt text in `console_agent_*` tables or `session_state`. `prompts.get.v1` results serialize as artifact references at every persistence boundary.
- Writes are only reachable through proposals. Approval is an atomic `pending → approved` transition plus a base-state staleness check, executed under the approving user's identity.
- Approval cards render only the server-persisted proposal preview, never agent-generated prose.
- `text_delta` events are SSE-only; persisted run events cover lifecycle, tool calls, proposals, and message-final snapshots.
- Two side-effect classes only (`none`, `write`); no gateway tools in V1.
- Frontend follows existing rules: TanStack Query, no `useEffect`, files under 300 lines, SSE consumption through a `lib/` helper.

## Phase 0: Foundations

### CA-001: Add Console Agent Tables

Goal: Create the durable storage for conversations, messages, runs, run events, and proposals.

Scope:

- Add `console_agent_conversations` with `session_state` jsonb.
- Add `console_agent_messages` with per-message `page_scope` jsonb.
- Add `console_agent_runs` with the six run statuses from the plan.
- Add `console_agent_run_events` with monotonic `seq` per run.
- Add `console_agent_proposals` with `base_state`, `dedupe_key`, proposer/resolver columns, and the five proposal statuses.
- Add org-scoped indexes for list/detail queries and a unique index supporting proposal dedupe.

Acceptance criteria:

- Every table carries `organization_id` with an index.
- `console_agent_run_events` supports ordered replay by `(run_id, seq)`.
- Proposal status transitions can be enforced with a single-row conditional update.
- Existing migration tests pass.

Validation:

- Run `pnpm --filter @prompt-proxy/db test`.
- Run `pnpm db:migrate` against local Postgres.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/migrations/*.sql`
- `packages/db/src/schema.test.ts`

### CA-002: Extend Admin Read Queries For The Capability Surface

Goal: Close the read-query gaps the capability list depends on.

Scope:

- Add filter parameters to `AdminQueryService.requests()` (status, surface, route, API key, session, time range, limit) instead of the hardcoded latest-200 dump.
- Add filter parameters to `sessions()`.
- Add a model catalog read that exposes catalog rows with costs (the catalog is in-memory from config; decide between a query-service accessor over `buildModelCatalog` output or a persistence-backed read).
- Extend `overview()` to include active routing configs.

Acceptance criteria:

- Existing console pages keep working unchanged (default parameters preserve current behavior).
- New filters are exercised by unit tests against seeded data.
- Catalog read returns provider, model, and cost metadata for every catalog row.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/proxy/src/catalog.ts`
- `apps/proxy/src/server.ts`

### CA-003: Adopt The pi Runtime Packages

Goal: Bring the pi harness into the workspace and prove the embedding shape before building on it.

Scope:

- Add `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` to `apps/proxy` (pin latest; 0.79.1 at scope-writing time).
- Decide whether `@earendil-works/pi-coding-agent` session runtime (SessionManager, compaction) imports cleanly server-side; if not, document that transcripts persist via `session_state` only.
- Stand up a minimal agent loop in a unit test: one stub tool, scripted LLM transport, assert the lifecycle event sequence and tool execution.
- Verify the agent state (messages) round-trips through JSON serialization for `session_state`.

Acceptance criteria:

- A unit test drives a two-turn agent loop with a stub tool and observes `agent_start` → `tool_execution_*` → `agent_end`.
- The session-runtime decision is recorded in the plan's Harness section.
- No provider network calls in tests.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.
- Run `pnpm typecheck` and `pnpm build`.

Likely files:

- `apps/proxy/package.json`
- `apps/proxy/src/console-agent/runtime.test.ts`
- `docs/scopes/console-agent-v1/PLAN.md`

## Phase 1: Read Agent Backend

### CA-004: Capability Registry And Policy Middleware

Goal: Create the single declaration table that produces the agent's tools, policy enforcement, and audit.

Scope:

- Add `CapabilityDefinition` and `CapabilityContext` types with `sideEffect: "none" | "write"`.
- Implement policy middleware returning `executed`, `proposed`, or `denied` decisions (`proposed` may throw "not implemented" until CA-013).
- Generate pi tools from registry entries (Zod input converted to the JSON schema pi expects).
- Emit `console_agent.capability.executed` audit events through the `appendAdminAuditEvent` pattern.

Acceptance criteria:

- A registry entry declared once appears as a pi tool with matching schema and description.
- `none` capabilities execute and audit; unknown keys return `denied`.
- Policy middleware is the only path from tool call to handler.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/console-agent/registry.ts`
- `apps/proxy/src/console-agent/policy.ts`
- `apps/proxy/src/persistence/adminAudit.ts`

### CA-005: Implement Read Capabilities

Goal: Register the thirteen read capabilities over the query layer.

Scope:

- Wrap `AdminQueryService` methods per the plan's read capability list, including the CA-002 extensions.
- `prompts.get.v1` appends a `PromptAccessAuditStore` row attributed to the console user and flagged agent-mediated, and returns artifact id + metadata alongside raw text so persistence boundaries can serialize by reference.
- Keep tool result payloads compact: summaries and ids, not full row dumps, so transcripts stay small.

Acceptance criteria:

- Each capability has a unit test against seeded data.
- `prompts.get.v1` access produces the same audit row shape as the console prompt detail page.
- No capability returns more rows than its declared limit.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/console-agent/capabilities/read.ts`
- `apps/proxy/src/persistence/promptAccessAudit.ts`
- `apps/proxy/src/persistence/adminQueries.ts`

### CA-006: Conversation And Run Persistence

Goal: Persist conversations, messages, runs, and run events with the prompt-text redaction boundary.

Scope:

- Add a console agent store over the CA-001 tables: create conversation, append message, open/finalize run, append run events with `seq`.
- Persist `session_state` on the conversation row in the same transaction that finalizes a run.
- Implement the redaction boundary: `prompts.get.v1` tool results serialize as `{ artifactId, redacted: true }` + metadata in messages, run events, and `session_state`.
- Append `console_agent.conversation.created`, `console_agent.run.started`, and `console_agent.run.finished` audit events inside the owning transactions.

Acceptance criteria:

- A finalized run leaves consistent rows: messages, ordered events, run status, updated `session_state`.
- No raw prompt text appears in any persisted row or `session_state` for a conversation that used `prompts.get.v1` (asserted by test).
- Event, outbox, and state rows for each audit event commit in one transaction.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/persistence/consoleAgentStore.ts`
- `apps/proxy/src/console-agent/redaction.ts`
- `packages/db/src/schema.ts`

### CA-007: Agent Runtime Service

Goal: Assemble the pi agent and orchestrate runs end to end on the server.

Scope:

- Build the system prompt: role, capability manifest from the registry, routing-config schema summary, org snapshot, page scope.
- Wire `pi-ai` to the proxy's own `/v1/*` surface with a base URL and env-supplied token, pinning an explicit route alias (not `router-auto`).
- Map pi lifecycle events to the public vocabulary (`run_started`, `text_delta`, `tool_call_started`, `tool_call_finished`, `message_finished`, `run_finished`, `run_failed`) and feed the CA-006 store (deltas excluded from persistence).
- Resume conversations from `session_state`; handle run statuses including `awaiting_input`.
- Support cancellation via AbortController.

Acceptance criteria:

- A scripted-transport test runs a multi-tool conversation, resumes it in a fresh runtime instance, and produces identical transcripts.
- Cancellation marks the run `cancelled` and finalizes persistence cleanly.
- No `text_delta` rows in `console_agent_run_events`.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/console-agent/runtime.ts`
- `apps/proxy/src/console-agent/systemPrompt.ts`
- `apps/proxy/src/console-agent/eventMapper.ts`

### CA-008: Console Agent HTTP Routes And SSE

Goal: Expose the agent over cookie-authenticated admin routes with live streaming.

Scope:

- Add the eight `/admin/console-agent/*` routes from the plan (proposal endpoints may 501 until CA-013).
- Enforce creator scoping on conversation and run routes in addition to org scoping.
- Serve SSE for run events with heartbeats and `Last-Event-ID` replay from `console_agent_run_events.seq` (new ground — `sseObserver.ts` is a consumer, not a pattern to copy).
- Keep route handlers thin per the architecture rules; orchestration stays in the runtime service.

Acceptance criteria:

- A second admin user cannot read or cancel another user's conversation or run.
- Reconnecting with `Last-Event-ID` replays missed persisted events then continues live.
- Route handlers contain no business logic beyond auth, parsing, and service calls.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/src/consoleAgentRoutes.ts`
- `apps/proxy/src/server.ts`
- `apps/proxy/src/adminAuth.ts`

### CA-009: Read Agent Integration Test

Goal: Prove the phase 1 slice end to end before any UI exists.

Scope:

- Drive a full conversation over HTTP against seeded data with a mock upstream (reuse the `pnpm smoke` mock-provider approach for the agent's LLM calls).
- Cover: create conversation, send message, stream events, tool calls against read capabilities, transcript fetch, cancel.
- Assert audit events and prompt-access audit rows landed.

Acceptance criteria:

- The test runs in CI without provider credentials.
- A failure identifies which phase broke: auth, run orchestration, capability execution, streaming, or persistence.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.
- Run `pnpm smoke` to confirm no proxy-path regressions.

Likely files:

- `apps/proxy/src/console-agent/integration.test.ts`
- `scripts/` (only if the smoke harness needs a shared mock helper)

## Phase 2: Console Dock

### CA-010: Console Agent Dock Shell And Transcript

Goal: Add the dock to the console shell with conversation management and transcript rendering.

Scope:

- Right-side drawer with a top-bar toggle, available on every page, styled to the existing dense/quiet aesthetic.
- Conversation create/list (creator-scoped) and message send via TanStack Query.
- Render persisted transcripts: user/assistant messages and finalized tool results (no streaming yet).

Acceptance criteria:

- Dock opens on any console page without disturbing page layout or routing.
- Component files stay under 300 lines; no `useEffect`.
- Transcript reload after refresh matches what was streamed.

Validation:

- Run `pnpm typecheck` and existing web tests.
- Manual check via `pnpm dev:local`.

Likely files:

- `apps/web/src/shell.tsx`
- `apps/web/src/consoleAgentDock.tsx`
- `apps/web/src/consoleAgentMessages.tsx`
- `apps/web/src/api.ts`

### CA-011: Live Streaming And Tool Chips

Goal: Make running turns visible in real time.

Scope:

- SSE subscription helper in `lib/` (no component-level effects) consuming the run event stream with `Last-Event-ID` reconnect.
- Streaming assistant text from `text_delta` events.
- Collapsible tool-call chips: capability key, duration, decision; error and `run_failed` states; cancel button.

Acceptance criteria:

- A dropped connection resumes mid-run without duplicated or missing events.
- Tool chips show `executed`/`denied` decisions as they complete.
- Cancel reflects the `cancelled` run status in the transcript.

Validation:

- Run `pnpm typecheck`.
- Manual check via `pnpm dev:local` against a mock-backed agent run.

Likely files:

- `apps/web/src/lib/agentStream.ts`
- `apps/web/src/consoleAgentDock.tsx`
- `apps/web/src/consoleAgentToolChip.tsx`

### CA-012: Page Scope Injection

Goal: Let the agent see the entity the user is looking at.

Scope:

- Each detail route contributes its entity (`requestId`, `configId`, `apiKeyId`, `sessionId`) to the dock's context.
- Captured per user message at send time and stored in `console_agent_messages.page_scope`.
- Runtime service folds page scope into the turn context (CA-007 already accepts it).

Acceptance criteria:

- Asking "why did this request route hard?" from a request detail page works without pasting an id.
- Navigating between pages updates the scope used by the next message, not previous ones.

Validation:

- Run `pnpm typecheck`.
- Manual check via `pnpm dev:local`.

Likely files:

- `apps/web/src/consoleAgentScope.ts`
- `apps/web/src/router.tsx`
- `apps/proxy/src/console-agent/systemPrompt.ts`

## Phase 3: Proposals And Writes

### CA-013: Proposal Lifecycle Service And Endpoints

Goal: Build the human-approval primitive for agent writes.

Scope:

- Proposal creation with `input`, `preview`, `base_state` fingerprint, `dedupe_key`, proposer, and expiry (default 24h).
- Approval: atomic `pending → approved` conditional update, base-state re-check (fail as `stale`), held capability execution under the approving user's identity — all in one transaction with `console_agent.proposal.approved` audit.
- Rejection and expiry paths with matching audit events.
- `POST /admin/console-agent/proposals/:proposalId/{approve,reject}` endpoints; proposals org-visible to owner/admin; self-approval allowed.

Acceptance criteria:

- Two concurrent approvals of one proposal execute the capability exactly once.
- A proposal whose config changed after preview fails as `stale` without side effects.
- Expired proposals cannot be approved.
- Proposer and resolver are both recorded.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`, including a concurrency test for the atomic transition.

Likely files:

- `apps/proxy/src/console-agent/proposals.ts`
- `apps/proxy/src/consoleAgentRoutes.ts`
- `apps/proxy/src/persistence/consoleAgentStore.ts`

### CA-014: Routing Config Preview Capability

Goal: Give the agent a dry-run validator so drafts converge before any proposal exists.

Scope:

- `routing_configs.preview.v1`: validate a draft document with `routingConfigSchema`, diff against the current active version, return the normalized document and a base-state fingerprint (active version id + config hash).
- Validation failures return Zod paths as tool results the agent can iterate on.
- No writes, no proposal — `sideEffect: "none"`.

Acceptance criteria:

- An invalid draft returns actionable validation paths; a valid draft returns a normalized document, diff, and fingerprint.
- Previewing against a config with no active version works (new-config case).

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/console-agent/capabilities/preview.ts`
- `packages/schema/src/index.ts`

### CA-015: Write Capabilities Behind Proposals

Goal: Register the five write capabilities, proposal-gated end to end.

Scope:

- Wrap `createConfig`, `createVersion`, `activateVersion`, `archiveConfig`, and `assignApiKeyRoutingConfig` as `sideEffect: "write"` capabilities.
- Policy middleware persists a proposal (with the CA-014 fingerprint) and returns `decision: "proposed"`; the run ends `awaiting_approval`.
- Approved execution flows through CA-013 under the approver's identity, emitting the existing `routing_config.*` domain audit events.

Acceptance criteria:

- The flagship flow from the plan works over HTTP: draft → preview → propose → approve → new version exists; activation requires a second proposal.
- A rejected proposal leaves no routing config changes.
- The agent process has no code path that mutates routing configs without a proposal.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.

Likely files:

- `apps/proxy/src/console-agent/capabilities/write.ts`
- `apps/proxy/src/console-agent/policy.ts`
- `apps/proxy/src/persistence/routingConfigAdmin.ts`

### CA-016: Approval Cards In The Dock

Goal: Render proposals for human decision in the UI.

Scope:

- Approval card in the transcript: capability key, server-persisted preview/diff, proposer, expiry, approve/reject buttons.
- Render exclusively the proposal row's `preview` — never agent prose — as the description of the change (prompt-injection boundary).
- Show resolved states: approved (with resulting version link), rejected, stale, expired.

Acceptance criteria:

- The card's diff matches the proposal row byte-for-byte, not the assistant message text.
- Approving from the dock updates the transcript and the routing config detail page data.
- Stale and expired proposals render distinctly with no actionable buttons.

Validation:

- Run `pnpm typecheck`.
- Manual check via `pnpm dev:local` through the full flagship flow.

Likely files:

- `apps/web/src/consoleAgentProposalCard.tsx`
- `apps/web/src/consoleAgentDock.tsx`
- `apps/web/src/api.ts`

### CA-017: ask_user_question Tool And Question Cards

Goal: Let the agent ask structured clarifying questions instead of guessing.

Scope:

- Port the MiOS `ask_user_question` tool: up to 4 questions with 2-4 options each, `terminate: true`, run ends `awaiting_input`.
- Question card in the dock with option buttons; the selection submits as the next user message and resumes the conversation.

Acceptance criteria:

- A turn ending in a question persists cleanly and resumes with the user's answer in context.
- Free-text override is available alongside the option buttons.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.
- Manual check via `pnpm dev:local`.

Likely files:

- `apps/proxy/src/console-agent/askUserQuestion.ts`
- `apps/web/src/consoleAgentQuestionCard.tsx`

## Phase 4: Hardening

### CA-018: Run Limits, Role Gate, And Agent Settings

Goal: Bound what a run can do and who can use the agent.

Scope:

- Enforce max turns per run, max tool calls per turn, and wall-clock timeout; exceeded limits finalize the run as `failed` with a clear error.
- Gate `/admin/console-agent/*` to `owner` and `admin` roles — the first endpoint-level role check; keep it one guard.
- Surface agent settings (default model, thinking level, limits) through the existing settings system and a settings page section.

Acceptance criteria:

- A `member`-role session receives 403 on every console agent route.
- Limit breaches stop runs without corrupting persistence.
- Settings changes apply per the existing settings semantics and are covered by tests.

Validation:

- Run `pnpm --filter @prompt-proxy/proxy test`.
- Run `pnpm typecheck`.

Likely files:

- `apps/proxy/src/console-agent/runtime.ts`
- `apps/proxy/src/consoleAgentRoutes.ts`
- `apps/proxy/src/settings.ts`
- `apps/web/src/settingsPage.tsx`

### CA-019: Internal API Key And Analytics Exclusion

Goal: Give the agent first-class, non-polluting access to the proxy itself.

Scope:

- Internal API key raw token supplied via environment/secret reference at deploy time; never persisted in settings rows or `.prompt-proxy/settings.json`.
- Add an `internal` boolean to `api_keys`; exclude internal-flagged traffic from usage and overview queries by default while keeping request log rows visibly tagged.
- Seed a `console-agent` routing config pinning explicit route aliases (no `router-auto`, so agent calls skip the classifier) and assign the internal key to it.

Acceptance criteria:

- Agent traffic appears in request logs tagged internal and is absent from usage analytics by default.
- Agent LLM calls produce no classifier provider attempts.
- Seeding is idempotent and the internal key never appears in plaintext storage.

Validation:

- Run `pnpm --filter @prompt-proxy/db test` and `pnpm --filter @prompt-proxy/proxy test`.
- Run `pnpm db:seed` twice.

Likely files:

- `packages/db/src/schema.ts`
- `packages/db/src/seed.ts`
- `apps/proxy/src/persistence/adminQueries.ts`
- `apps/proxy/src/config.ts`

### CA-020: Runbook And Docs

Goal: Make the console agent operable and discoverable.

Scope:

- Add `docs/runbooks/console-agent.md`: enabling the agent, internal key setup, limits, proposal lifecycle, troubleshooting stuck runs.
- Update `README.md` with the new admin endpoints and console behavior.
- Confirm `docs/index.md` links plan, tickets, and runbook.

Acceptance criteria:

- A new operator can enable the agent locally from the runbook alone.
- README endpoint list matches the implemented routes.

Validation:

- Docs-only review; verify commands in the runbook against `pnpm dev:local`.

Likely files:

- `docs/runbooks/console-agent.md`
- `README.md`
- `docs/index.md`
