# Prompt Proxy

Prompt Proxy is an OpenAI/Anthropic-compatible model routing gateway with durable event and usage capture. The repo is organized for agentic engineering: durable decisions live in docs, transport boundaries stay thin, and provider-specific behavior stays behind adapters.

## Repository Map

- `apps/proxy/` is the Fastify proxy for Codex, Claude Code, and other harnesses.
- `apps/web/` is the TanStack operations console.
- `packages/db/` owns Drizzle schema, migrations, and database client helpers.
- `packages/schema/` owns shared enum-like constants and cross-package types.
- `docs/` owns architecture notes, scope plans, and future work.

## Architecture Rules

- The proxy route handlers are transport boundaries. They may authenticate, parse request envelopes, and call services/helpers, but should not accumulate business logic.
- Provider-specific code belongs in provider adapters or proxy forwarding code. Do not leak provider-specific request fields into shared policy/data-model code unless the field is stored as provider metadata.
- Every durable table and event must be scoped by `organization_id` or the in-memory equivalent `tenantId`.
- Events are the audit and projection backbone. Current-state tables exist for efficient queries and constraints.
- When persistence is enabled, write the event row, outbox row, and matching current-state mutation in the same database transaction.
- Event creation flows through `EventService`. Do not append directly to `packages/db` tables from transport handlers.
- The routing classifier is an LLM call with structured output and retry. Do not add deterministic routing fallback logic.
- Raw prompt text is allowed for this test project, but it must only be stored through `prompt_artifacts.raw_text`. Do not put full prompt text in event payloads.
- API keys must be stored as hashes, never as raw tokens.
- Provider keys should be represented as secret references or encrypted material, not plain text rows.

## Frontend Rules

- `apps/web` uses TanStack Router, TanStack Query, and TanStack Table.
- Follow `docs/frontend-guidelines.md` for frontend implementation rules.
- Do not introduce a competing router, data-fetching library, or global state layer without updating this file and the architecture docs.
- Do not call `useEffect` directly. Use TanStack Query for data fetching, inline derivation for derived state, event handlers for user actions, and a `key` reset for prop-driven resets.
- Keep React component files under 300 lines and individual component functions under 150 lines. Split page composition, table columns, timeline rows, inspector panes, and formatting helpers before files become hard to scan.
- Do not manipulate the DOM directly from React components. Avoid `document.createElement`, `querySelector`, and imperative DOM injection.
- Do not use nested ternaries. Move branching into a named helper or intermediate variables.
- Never render a native `<select>` (or any other OS-styled menu control). The browser draws its popup with light system styling that breaks the dark console theme. Use the shared `MenuSelect` component (`apps/web/src/table/MenuSelect.tsx`) for every dropdown.
- Never ship a form control with default browser styling — an unthemed blue checkbox or grey input is a bug. Boolean toggles use `<input type="checkbox" role="switch">`, which the global switch styles in `pages.css` theme automatically. Checkbox lists set `accent-color: var(--accent)` (see `.scope-option`, `.key-pick-row`). Text inputs follow the bordered `var(--glass-2)` pattern.
- Anywhere the console displays or edits JSON, it must be syntax highlighted. Use the shared components in `apps/web/src/jsonView.tsx`: `JsonView` for read-only display, `JsonEditor` for editable JSON. Never render JSON in a plain `<pre>` or `<textarea>`.
- Prefer `type` aliases over `interface` for props, DTOs, and exported object shapes.
- Keep route files thin: params, loaders, guards, and page composition only. Query shaping and DTO mapping belong in `lib/` or feature modules.
- Use shared components only when duplication becomes real. Keep the first dashboard screens simple and operational.
- UI should be dense, quiet, and scan-friendly. This is an internal operations console, not a landing page.

## Database Rules

- Drizzle schema lives in `packages/db/src/schema.ts`.
- SQL migrations live in `packages/db/migrations/`.
- Add migrations in the same change as schema changes.
- Prefer explicit indexes for org-scoped list/detail queries.
- Use `pnpm db:migrate` to apply migrations against `DATABASE_URL`.
- Local tests may use in-memory stores, but production persistence requires Postgres.

## Commands

```bash
pnpm install
pnpm dev:proxy
pnpm dev:web
pnpm db:migrate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
pnpm smoke:harnesses
```

## Documentation Rules

- Link new durable docs from `docs/index.md`.
- Product behavior changes should update `README.md` or the relevant feature/scope doc.
- Event shape, database, persistence, or dashboard changes should update `docs/scopes/persistence-admin-v1/PLAN.md`.
- Frontend architecture or component-rule changes should update `docs/frontend-guidelines.md`.
- Future prompt optimization ideas belong under `docs/future/`.

## Working Style

- Keep diffs scoped.
- Do not add premature abstractions.
- Fix root causes, not symptoms.
- Let tooling handle formatting.
- Before committing, run the narrowest meaningful validation and report exactly what passed or failed.
