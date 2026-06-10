# Frontend Guidelines

These rules apply to `apps/web`, the Prompt Proxy TanStack operations console.

## Architecture

- Use TanStack Router for routing, TanStack Query for server state, and TanStack Table or a small local dense-table component for tabular data.
- Do not introduce a competing router, fetch/cache layer, or global state library without updating `AGENTS.md` and the relevant scope doc.
- Keep route files thin. Route files should own params, loaders, guards, and page composition; business/query shaping belongs in `lib/` or feature modules.
- Put feature-specific UI under `components/<feature>/` and reusable UI primitives under `components/ui/`.
- Prefer `type` aliases over `interface` for object shapes, props, and exported types.

## Component Size

- Keep React component files under 300 lines.
- Keep individual component functions under 150 lines.
- If a page needs more space, split it into feature components, column definitions, data mappers, and formatting helpers.
- Do not hide a large page inside one giant `Page.tsx` with local helper components at the bottom.
- Extract when it reduces real complexity: repeated table columns, timeline rows, inspector panels, status pills, formatting, or query DTO mapping.

## Effects

Do not call React `useEffect` directly in new code.

Use these alternatives:

- Data fetching: TanStack Query loaders or `useQuery`.
- Derived values: compute inline during render or with `useMemo` only when the computation is meaningfully expensive.
- User actions: event handlers such as `onClick`, `onSubmit`, and mutation callbacks.
- Prop-driven reset: use a `key` on the child component.
- External synchronization: create a small named hook and document why an effect is unavoidable.

Examples:

```tsx
// Bad: derived state
const [label, setLabel] = useState("");
useEffect(() => {
  setLabel(`${route} / ${model}`);
}, [route, model]);

// Good: derive during render
const label = `${route} / ${model}`;
```

```tsx
// Bad: effect-driven reset
useEffect(() => {
  setSelectedId(null);
}, [sessionId]);

// Good: remount the detail panel
<SessionDetail key={sessionId} sessionId={sessionId} />
```

## Data Fetching

- Fetch through typed API helpers in `lib/api.ts` or feature-local query helpers.
- Server endpoints should return DTOs shaped for the page. Avoid client-side N+1 fetches from detail views.
- Use query keys that include organization, filters, and entity IDs.
- Mutations should invalidate or update the smallest relevant query set.
- Do not manually poll with `setTimeout` loops. Use TanStack Query refetch intervals or an explicit event stream.

## Rendering Rules

- Do not manipulate the DOM directly from React components. No `document.createElement`, `querySelector`, or imperative DOM injection.
- Do not use nested ternaries. Move branching into a named helper or early variables.
- Avoid render-time JSON/string parsing unless the value is tiny and already local. Parse at the API boundary when possible.
- Use stable dimensions for tables, timelines, inspector panes, and icon buttons so data changes do not shift layout.
- Keep text from overflowing buttons, table cells, chips, and panels. Use truncation or wrapping deliberately.

## UI Style

- Build a dense operations console, not a landing page.
- Use a compact dark shell, collapsible sidebar, metric strips, dense tables, split panes, and timeline inspectors.
- Keep cards at 6px-8px radius and avoid nested cards.
- Use lucide icons for navigation and actions when an icon exists.
- Use status pills for route, model provider, terminal status, prompt capture mode, and confidence.
- Prefer full-width operational layouts over decorative hero sections or marketing cards.
- Avoid one-off colors. Define route/provider/status colors as shared tokens or constants.

## Tables

- Page-level record lists use the shared `ConsoleTable` (`apps/web/src/table/`). It provides search, quick filters, advanced filter rules, sort, column visibility, pagination, and toolbar actions.
- Pass `urlState` so table state syncs to URL query params and views are shareable/deep-linkable. Pass a string prefix (`urlState="costs"`) only if a page ever hosts two synced tables.
- Param scheme: `q` (search), one param per quick-filter id (`user`, `model`, `status`, ...), `sort` (`-tokens` = descending, comma-separated), `page` (1-based), `size`, `hide` (hidden columns), `adv` (advanced rules). Defaults are omitted from the URL; invalid values are sanitized on read. The codec lives in `apps/web/src/table/urlState.ts`.
- Keep memory-backed state (no `urlState`) for tables embedded behind in-page tabs or repeated per row — pair with `stateKey` to reset on tab switches (see `usageBreakdown.tsx`).
- Small embedded action tables inside cards (pending invitations, version history) may stay on the plain `DataTable` primitive; toolbar and pagination chrome would be noise there.

## JSON Display & Editing

- Anywhere the console displays or edits JSON, it must be syntax highlighted. Never render JSON in a plain `<pre>` or `<textarea>`.
- Use the shared components in `apps/web/src/jsonView.tsx`: `JsonView` for read-only display (includes a copy button), `JsonEditor` for editable JSON (highlighted `<pre>` stacked under a transparent-text `<textarea>`).

## Dropdown Menus

- Never render a native `<select>`. The OS draws its option popup with light system styling that cannot be themed and clashes with the dark console shell.
- Use the shared `MenuSelect` component (`apps/web/src/table/MenuSelect.tsx`) for every dropdown. It renders a themed trigger button plus a `menu-select-popover`, supports keyboard dismissal, and marks the active option.
- Style page-specific variants with a `className` on `MenuSelect` plus scoped CSS on `.menu-select > button` (see `.tier-effort` and `.settings-field .menu-select` for examples) instead of reintroducing native controls.
- Do not place `MenuSelect` inside a `<label>` element. Label click-forwarding targets the trigger button and fights the popover's open/close handling; use a `div` with a `span` caption instead.

## Raw Prompt UI

- Raw prompt text is a first-class V1 test-project feature.
- Store prompt text only in `prompt_artifacts.raw_text`; do not embed full prompts in event payloads.
- Prompt viewers should make raw prompt display explicit through page title, labels, and detail context.
- PII filtering and redaction are later hardening work. Do not add ad hoc partial redactors in UI components.
