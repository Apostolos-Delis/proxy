# Implementation Tickets

These tickets break the model routing proxy design into implementation-sized work. The current MVP target is Codex through the OpenAI Responses API and Claude Code through the Anthropic Messages API, with event-backed routing decisions and a cheap structured classifier.

## Assumptions

- Codex/OpenAI Responses and Claude Code/Anthropic Messages are supported surfaces.
- OpenAI and Anthropic are supported upstream providers.
- `router-auto` uses an LLM classifier with structured outputs.
- Classifier failures retry and then fail before provider spend.
- No prompt rewriting, memory injection, or cross-provider translation in the first delivery.
- Events are part of the core design, but realtime dashboards and advanced reports can come later.

## MVP Tickets

### PP-001: Scaffold The TypeScript Service

Build the base Node/TypeScript service with Fastify, configuration loading, logging, test runner, and local development scripts.

Acceptance criteria:

- Service starts locally.
- `GET /healthz` returns `{ "status": "ok" }` without contacting upstream providers.
- Config is validated at startup.
- Unit test and integration test commands exist.

Dependencies: none.

### PP-002: Add Caller Auth And Upstream Secret Handling

Separate caller authentication from upstream provider credentials.

Acceptance criteria:

- Incoming requests require a proxy token.
- Incoming `Authorization` is never forwarded upstream.
- Upstream OpenAI API key is loaded from trusted configuration.
- Auth headers and cookies are redacted from logs/events.

Dependencies: PP-001.

### PP-003: Define Model Catalog And Route Config

Create the data model for provider models, router aliases, capabilities, costs, and route settings.

Acceptance criteria:

- Catalog defines OpenAI models, capabilities, supported reasoning efforts, verbosity support, context window, and cost fields.
- Route config defines `router-fast`, `router-balanced`, `router-hard`, `router-deep`, and `router-auto`.
- Non-alias provider model names are recorded as client hints and treated as auto-routed requests.
- Unsupported model/route config fails startup validation.
- Capability lookup is available to the routing service.

Dependencies: PP-001.

### PP-004: Implement Event Envelope And Durable Event Store

Create the typed event envelope, event append service, and durable storage for request-scoped events.

Acceptance criteria:

- Events include scope, sequence, schema version, actor, producer, correlation ID, causation ID, payload hash, sensitivity, and redaction state.
- Event append validates payload schemas.
- Request-scoped sequence ordering is enforced.
- Route decision events can be appended and queried in tests.

Dependencies: PP-001.

### PP-005: Add Transactional Outbox

Status: implemented in the current MVP.

Queue event fan-out work in the same transaction as event append.

Acceptance criteria:

- Event append creates an outbox item transactionally.
- Outbox items have queued, processing, succeeded, and failed states.
- Local development can use an in-process worker.
- Tests prove event and outbox writes cannot diverge.

Dependencies: PP-004.

### PP-006: Implement OpenAI Responses Surface

Expose the Codex-facing OpenAI Responses-compatible endpoints.

Acceptance criteria:

- `GET /v1/models` returns router aliases clients can choose for explicit routing.
- `POST /v1/responses` accepts Codex Responses request bodies.
- `POST /v1/responses` treats non-alias model names as auto-routed requests.
- Request parsing preserves all unknown protocol fields.
- `x-codex-turn-state`, `x-codex-turn-metadata`, `x-openai-subagent`, request IDs, and trace headers are preserved where safe.

Dependencies: PP-001, PP-002, PP-003.

### PP-007: Implement OpenAI Provider Adapter

Forward routed Responses requests to OpenAI with raw HTTP and byte-preserving streaming.

Acceptance criteria:

- Provider adapter replaces caller auth with upstream OpenAI auth.
- Non-streaming responses pass through status, headers, and body.
- Streaming responses preserve SSE bytes and ordering.
- Client cancellation aborts the upstream request.
- Mid-stream failures are not converted into successful empty responses.

Dependencies: PP-006.

### PP-008: Build Route Context Extraction

Extract the routing features needed by classifier and guardrails without storing raw prompts in route events or classifier payloads.

Acceptance criteria:

- Route context includes input size, estimated tokens, tool count, previous response presence, requested alias, modality flags, and extracted hint labels.
- Raw prompt text, full tool schemas, tool outputs, and terminal output are not stored in route events.
- Request body hash and prompt hash are available for audit/debugging.
- Tests cover empty inputs, large inputs, tool requests, and prior-response requests.

Dependencies: PP-003, PP-004, PP-006.

### PP-009: Implement Classifier Data Policy

Enforce the data boundary for classifier calls.

Acceptance criteria:

- Classifier defaults to `features_only`.
- `input_excerpt` is `null` unless trusted central policy enables redacted excerpts.
- Excerpts require same approved provider trust boundary as the upstream request.
- Classifier data mode, provider, model, retention mode, and redaction state are recorded as event metadata.
- Classifier request bodies are not logged.

Dependencies: PP-008.

### PP-010: Implement Structured LLM Classifier

Call the configured cheap classifier model and validate structured output.

Acceptance criteria:

- Classifier uses provider-native structured outputs or an equivalent JSON-schema contract.
- Free-form classifier text is invalid.
- Invalid output, timeout, or transport failure retries within `max_attempts`.
- Exhausted attempts append `routing.classification_failed` and return a router error before upstream provider spend.
- Non-explicit requests are classified even when the client sent an ordinary upstream model name.
- Valid output emits `routing.classification_recorded`.

Dependencies: PP-003, PP-004, PP-009.

### PP-011: Implement Route Resolver And Request Rewrite

Resolve the final route from classifier recommendation plus guardrails, then rewrite only routing fields.

Acceptance criteria:

- Route decisions include `classifier_route`, `final_route`, `guardrail_actions`, selected model, reasoning effort, verbosity, reason codes, and policy version.
- Incompatible classifier routes escalate to the smallest compatible route.
- Budget violations reject or apply configured budget policy before provider spend.
- Explicit aliases force the selected route unless incompatible.
- Only `model`, `reasoning.effort`, and `text.verbosity` are rewritten for OpenAI Responses.
- Tool schemas, tool IDs, `previous_response_id`, `include`, `prompt_cache_key`, and `client_metadata` remain unchanged.

Dependencies: PP-003, PP-008, PP-010.

### PP-012: Add Provider Attempts And Idempotency

Prevent duplicate provider spend and support streamed-response terminal reconciliation.

Acceptance criteria:

- Request idempotency key is accepted or computed before provider work.
- A `provider_attempt` record with `terminal_status: "pending"` is inserted before upstream spend.
- Duplicate idempotency keys do not silently launch a second upstream call.
- Terminal events are appended when streams complete, fail, or cancel.
- Terminal append failure after streamed bytes leaves the attempt in `terminal_pending` and schedules reconciliation.

Dependencies: PP-004, PP-005, PP-007, PP-011.

### PP-013: Add Non-Mutating SSE Observer

Tee-observe streaming Responses events for usage and terminal status without changing client-visible bytes.

Acceptance criteria:

- SSE bytes sent to the client are unchanged.
- Observer extracts response ID, terminal status, error events, token usage, and timing when available.
- Observer parse failure does not corrupt or stop stream passthrough.
- Missing usage is recorded as missing and can be reconciled later.
- Tests include complete streams, mid-event disconnects, malformed events, and terminal usage events.

Dependencies: PP-007, PP-012.

### PP-014: Implement Usage And Cost Projections

Status: implemented in the current MVP.

Build replayable projections for usage, cost, and savings.

Acceptance criteria:

- Usage projection tracks input tokens, cached input tokens, output tokens, reasoning tokens, latency, and time to first byte.
- Cost projection estimates selected-route cost from the model catalog.
- Savings projection compares requested alias/default route to final route.
- Projection cursors allow replay from durable events.
- Missing usage is represented explicitly.

Dependencies: PP-003, PP-004, PP-013.

### PP-015: Build Mock Upstream Test Harness

Create a configurable OpenAI Responses mock provider for integration tests.

Acceptance criteria:

- Mock records raw body, parsed JSON, and request headers.
- Mock can return non-streaming JSON responses.
- Mock can return configurable SSE event sequences.
- Fixtures include `response.created`, `response.output_item.done`, `error`, `response.completed`, usage, and mid-stream failure cases.
- Tests prove Codex-sensitive fields and headers are preserved.

Dependencies: PP-006, PP-007.

### PP-016: Add Codex Local Smoke Profile

Document and verify local Codex usage against the proxy.

Acceptance criteria:

- Example Codex `config.toml` profile is documented.
- Local smoke commands cover simple, normal, and hard prompts.
- Proxy route decision headers/logs make the selected route visible during local testing.
- Smoke instructions avoid exposing upstream OpenAI API keys to Codex directly.

Dependencies: PP-006, PP-007, PP-011.

## Hardening Tickets

### PP-017: Add Policy Trust Controls

Status: implemented in the current MVP.

Gate local route policy so untrusted repo-local configuration cannot redirect provider traffic or increase spend.

Acceptance criteria:

- Central policy is the default.
- User-local policy can be enabled for local development.
- Repo-local policy requires explicit trust.
- Changed repo-local policy invalidates trust.
- Untrusted policy falls back to central policy.

Dependencies: PP-003, PP-011.

### PP-018: Add Budget Enforcement

Status: implemented in the current MVP.

Add per-user, per-team, and per-route budget controls.

Acceptance criteria:

- Budget policy can reject requests before classifier/provider spend.
- Budget warning events are emitted.
- Budget checks are represented in route decision events.
- Tests cover reject, warning-only, and route-limited policies.

Dependencies: PP-004, PP-011, PP-014.

### PP-019: Add Session-Aware Routing

Status: implemented in the current MVP.

Use session memory to avoid route churn and improve cost attribution.

Acceptance criteria:

- Session route memory stores current route bias.
- Sessions can upgrade when classifier or repeated failures justify it.
- Sessions do not downgrade unless policy or explicit user alias allows it.
- Session-scoped events and cost summaries are available.

Dependencies: PP-011, PP-014.

### PP-020: Add Route Quality Discovery

Status: implemented in the current MVP.

Identify missed savings and low-quality savings from historical events.

Acceptance criteria:

- Report calls where a cheaper route likely would have worked.
- Report calls where cheap routing caused retries or repair turns.
- Report sessions where classifier confidence was low.
- Reports can run from route, usage, and event metadata without reading raw prompt text.

Dependencies: PP-014, PP-019.

## Surface And Provider Tickets

### PP-021: Define Surface And Provider Adapter Contracts

Status: implemented in the current MVP.

Formalize extension points after the OpenAI/Codex path proves stable.

Acceptance criteria:

- Surface adapter contract owns client protocol parsing, preservation, and response streaming.
- Provider adapter contract owns upstream auth, headers, retries, and stream behavior.
- Cross-protocol translation is not part of the base provider contract.
- Tests prove OpenAI Responses behavior still works through the interface.

Dependencies: PP-006, PP-007, PP-011.

### PP-022: Add Anthropic Messages Surface For Claude Code

Status: implemented in the current MVP.

Expose Claude Code-compatible Anthropic Messages endpoints.

Acceptance criteria:

- `POST /v1/messages` is accepted.
- `POST /v1/messages/count_tokens` passes through or routes safely.
- `GET /v1/models` returns Claude router aliases.
- `anthropic-beta`, `anthropic-version`, `X-Claude-Code-Session-Id`, `X-Claude-Code-Agent-Id`, and `X-Claude-Code-Parent-Agent-Id` are preserved.
- Anthropic stream events are passed through without reconstruction.

Dependencies: PP-021.

### PP-023: Add Anthropic Provider Adapter

Status: implemented in the current MVP.

Forward Anthropic Messages requests upstream while preserving Claude Code behavior.

Acceptance criteria:

- Provider adapter injects upstream Anthropic auth.
- Tool-use and tool-result pairing is preserved.
- Anthropic stream sequencing is preserved.
- Usage/cost events are emitted from Anthropic terminal events.
- Effort/thinking settings are rewritten only through route decisions.

Dependencies: PP-021, PP-022.

### PP-024: Add Prompt Rewriting And Memory Planning Spike

Status: documented as a planning spike; prompt rewriting and memory injection remain non-goals for the current routing MVP.

Design the next phase after model routing has production data.

Acceptance criteria:

- Defines explicit rewrite mode boundaries.
- Defines memory retrieval and injection policy.
- Defines redaction, audit, and opt-in controls.
- Defines evals proving quality and cost impact before rollout.

Dependencies: PP-020.

## Prompt Storage And Analytics Tickets

These tickets extend the routing MVP into organization-wide prompt storage, usage analysis, and investigation workflows. The durable Postgres foundation already exists in the current workspace; this section tracks the remaining productized capture and analytics work. See `docs/scopes/persistence-admin-v1/PLAN.md` and `docs/scopes/tanstack-admin-app-v1/PLAN.md` for the fuller V1 shape.

### PP-025: Resolve Proxy Requests Through API Keys

Status: implemented in the current MVP.

Replace global-token request ownership with API-key-backed organization and user identity.

Acceptance criteria:

- Incoming bearer tokens and `x-api-key` values are hashed and resolved through `api_keys`.
- Revoked or expired API keys are rejected before route classification or provider spend.
- Request persistence uses `api_keys.organization_id` and `api_keys.user_id`.
- `api_keys.last_used_at` updates on successful auth.
- `PROMPT_PROXY_TOKEN` remains only as an explicit local-development fallback.
- Harness-supplied user/team headers are stored as metadata unless a later org setting marks them trusted.

Dependencies: PP-002, PP-004.

### PP-026: Normalize Durable Session Identity

Status: implemented in the current MVP.

Make every stored request replayable by attaching it to either a real harness session or an explicit request-scoped fallback session.

Acceptance criteria:

- Codex session headers and metadata are normalized into `agent_sessions`.
- Claude Code session headers are normalized into `agent_sessions`.
- Requests without stable session identity get a synthetic `request:{requestId}` session.
- Synthetic sessions are marked with metadata so the UI can label them as unthreaded.
- Session identity is scoped by organization and surface so identical external IDs from different orgs do not collide.

Dependencies: PP-019, PP-025.

### PP-027: Extend Prompt Artifact Storage For V1 Raw Text

Status: implemented in the current MVP.

Add the schema fields needed to store prompt text directly for the prototype while preserving the hash-based artifact model.

Acceptance criteria:

- `prompt_artifacts` supports `raw_text`, token estimate, source role, and source index.
- `storage_mode` includes `raw_text`.
- Existing hash-only artifact metadata remains valid.
- Content hash is still populated for every artifact.
- Migration tests cover fresh schema creation.
- PII filtering, redaction, and encrypted blob storage are explicitly deferred to a hardening ticket.

Dependencies: PP-004.

### PP-028: Capture Prompt Artifacts At Surface Boundaries

Status: implemented in the current MVP.

Extract prompt artifacts before request rewrite so organization analytics can inspect the user-visible input that arrived at the proxy.

Acceptance criteria:

- OpenAI Responses capture includes latest user message, instructions, and tool schema metadata.
- Anthropic Messages capture includes latest user message, system text, and tool schema metadata.
- Captured prompt text is written to `prompt_artifacts.raw_text` when capture mode is `raw_text`.
- Prompt artifacts include request ID, organization ID, surface, kind, source role/index, chars, token estimate, and content hash.
- Full prompt text is never embedded in event payloads.
- Tests cover string input, array message input, empty input, and tool-bearing requests.

Dependencies: PP-025, PP-027.

### PP-029: Record Prompt Capture Events

Status: implemented in the current MVP.

Add small lifecycle events that link request timelines to prompt artifacts without duplicating prompt text.

Acceptance criteria:

- Prompt capture emits an event containing artifact IDs, kinds, hashes, storage mode, and metadata.
- Event payloads omit raw prompt text and tool schemas.
- Request detail timelines include the prompt capture event in chronological order.
- Failed prompt capture does not silently continue into provider spend unless policy explicitly allows hash-only fallback.
- Tests prove prompt text stays out of `events.payload`.

Dependencies: PP-028.

### PP-030: Add Prompt Artifact Admin APIs

Status: implemented in the current MVP.

Expose org-scoped prompt list and prompt detail endpoints backed by Postgres.

Acceptance criteria:

- `GET /admin/prompts` returns prompt artifacts scoped to the authenticated organization.
- `GET /admin/prompts/:artifactId` returns raw prompt text plus related request, route, provider, usage, and event context.
- Prompt list supports pagination and basic filters for user, surface, route, model, and time range.
- Prompt detail returns 404 for artifacts outside the caller's organization.
- Responses are shaped for the web app and avoid client-side N+1 joins.

Dependencies: PP-025, PP-028, PP-029.

### PP-031: Add Organization Usage Analytics APIs

Status: implemented in the current MVP.

Provide aggregate usage and cost data for organization-wide analysis.

Acceptance criteria:

- `GET /admin/usage` supports time range and group-by parameters.
- Group-by supports user, provider, model, route, surface, and session.
- Results include input tokens, cached input tokens, output tokens, reasoning tokens, total tokens, selected cost, baseline cost, and savings.
- Failure and retry rates are included where provider attempts are available.
- Queries are scoped by organization and backed by persisted rows, not in-memory projections.

Dependencies: PP-014, PP-025.

### PP-032: Add Users And Sessions Admin APIs

Status: implemented in the current MVP.

Expose org-scoped user and session views for prompt and cost investigation.

Acceptance criteria:

- `GET /admin/users` returns users with request count, session count, token totals, cost totals, and recent activity.
- `GET /admin/users/:userId` returns user-level usage plus recent sessions and requests.
- `GET /admin/sessions` returns sessions with request count, model mix, route changes, tokens, cost, and terminal status summary.
- `GET /admin/sessions/:sessionId` returns all rows needed for session replay.
- All queries reject cross-organization access.

Dependencies: PP-026, PP-031.

### PP-033: Add Browser Auth And Organization Context

Status: implemented in the current MVP.

Move the operations console away from static bearer-token auth.

Acceptance criteria:

- `user_sessions` stores hashed opaque session tokens with expiry and revocation fields.
- `POST /api/auth/login`, `POST /api/auth/logout`, and `GET /api/auth/me` exist.
- Login sets an HttpOnly session cookie.
- Local/dev login is env-gated and resolves a seeded user.
- Every admin API scopes results to organizations where the session user is an active member.
- Unauthenticated web users are redirected to `/login`.

Dependencies: PP-025.

### PP-034: Build Prompt And Usage Web Views

Status: implemented in the current MVP.

Add the first organization analytics surfaces to the TanStack admin app.

Acceptance criteria:

- `/usage` shows dense aggregate tables for tokens, cost, savings, routes, providers, models, and users.
- `/prompts` shows prompt artifact rows with preview, user, session, request, surface, storage mode, hash, route, selected model, and cost.
- `/prompts/:artifactId` shows raw prompt text and related request/session/route/provider/usage/event context.
- Views use TanStack Query or route loaders for data fetching.
- No direct `useEffect` calls are introduced.
- Loading, empty, error, and unauthorized states are implemented.

Dependencies: PP-030, PP-031, PP-033.

### PP-035: Build Session Replay

Status: implemented in the current MVP.

Create a chronological investigation view for all observable proxy activity in a session.

Acceptance criteria:

- `/sessions` lists org-scoped sessions with usage, route, model, and terminal summaries.
- `/sessions/:sessionId` displays a chronological timeline sourced from persisted request, prompt artifact, route decision, provider attempt, usage, and event rows.
- Timeline rows include prompt capture, routing context, classifier, route decision, provider start/stream, terminal status, and usage.
- The UI distinguishes real harness sessions from request-scoped fallback sessions.
- A single session-detail endpoint powers the view without client-side N+1 queries.

Dependencies: PP-026, PP-032, PP-034.

### PP-036: Add Prompt Retention And Redaction Hardening

Status: implemented in the current MVP.

Add controls for keeping raw prompt capture safe beyond the prototype.

Acceptance criteria:

- Organization settings can configure prompt capture mode and retention period.
- Expired prompt artifacts can be deleted or redacted without breaking request/event timelines.
- Redaction jobs preserve content hash and metadata needed for aggregate analytics.
- Raw prompt access is separable from aggregate analytics access.
- Tests cover retention expiry and redacted artifact reads.

Dependencies: PP-028, PP-030, PP-033.

### PP-037: Add Raw Prompt Access Auditing

Status: implemented in the current MVP.

Record who viewed sensitive prompt content and from where.

Acceptance criteria:

- Raw prompt detail reads append or persist an audit record containing actor, organization, artifact ID, request ID, route, timestamp, and access path.
- Aggregate prompt list and usage endpoints do not create raw-content access records.
- Audit records are organization-scoped and queryable by admins.
- Failed cross-org reads do not leak artifact existence.

Dependencies: PP-030, PP-033, PP-036.

### PP-038: Add Prompt Analytics Validation Coverage

Cover the end-to-end prompt storage and analytics path.

Acceptance criteria:

- Integration tests cover OpenAI Responses prompt capture through admin prompt reads.
- Integration tests cover Anthropic Messages prompt capture through admin prompt reads.
- API-key identity tests prove request ownership is not trusted from harness headers.
- Session replay tests cover real and fallback session identities.
- Usage analytics tests cover group-by queries and organization scoping.
- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.

Dependencies: PP-025, PP-026, PP-030, PP-031, PP-032, PP-034, PP-035.
