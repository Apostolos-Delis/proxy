# HCT-014: Expose Compatibility Matrix In Admin APIs And Console

Goal: Show operators which harness/provider combinations are safe, translated, blocked, or unsupported.

## Scope

- Add a backend or shared schema API for the generated compatibility matrix.
- Include profile ID, display name, surface, transport, native support, translated support, unsupported stateful features, reason codes, tested fixture count, and last smoke status if available.
- Render the matrix in the operations console without reimplementing compatibility logic in React.
- Keep route files thin and JSON displays syntax-highlighted if matrix details are shown as JSON.
- Add docs that explain how to read the matrix.

## Acceptance Criteria

- The console matrix matches backend/shared compatibility output.
- Operators can distinguish native support, translated support, blocked stateful features, and unsupported paths.
- Fixture counts are generated or loaded from test metadata, not hand-maintained in the UI.
- Docs link to the compatibility matrix and explain support claims.

## Validation

- Run `pnpm --filter @proxy/proxy test`.
- Run `pnpm --filter @proxy/web test` if available.
- Run `pnpm typecheck`.
- Run `pnpm lint`.

## Likely Files

- `apps/proxy/src/graphql/types/routing.ts`
- `apps/proxy/src/graphql/queries.ts`
- `apps/web/src/`
- `docs/harnesses/`
- `docs/index.md`
