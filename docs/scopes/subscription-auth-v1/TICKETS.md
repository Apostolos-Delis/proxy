# Subscription Auth V1 Tickets

> Historical note (2026-06-12): these tickets describe the original Anthropic-only V1. A follow-up now
> adds OpenAI HTTP Responses subscription credentials with a Codex access token and ChatGPT account ID;
> see the runbook for current operator behavior.

These tickets break the subscription-auth scope ([PLAN.md](PLAN.md)) into PR-sized units.

The intended delivery shape: let an engineer paste a Claude `setup-token` (`sk-ant-oat01-…`) into the
Model providers console, bind it to an API key they own, and have the proxy forward it as a bearer token —
all behind a default-off kill switch, Anthropic-only, internal use only. No PKCE, no callback routes, no
refresh subsystem, no schema migration.

## Delivery Rules

- The feature is gated by `SUBSCRIPTION_OAUTH_ENABLED` (default false) and must never be exposed to
  external customers. The build can land with the flag off without the ToS sign-off (SA-001); only
  enabling it and live verification (SA-009) require sign-off.
- Do **not** rename the GraphQL `apiKey` input field. It is semantically overloaded to carry an API key
  or a subscription token. Renaming breaks the SDL, generated client types, data layer, and panel.
- `provider_accounts.auth_type` is the single runtime discriminant. `settings.tokenKind` is
  human-readable metadata only and must not drive any runtime branch.
- Per-user binding is a **hard rejection**, not a warning. A null-owner (`api_keys.user_id IS NULL`) key
  is rejected for OAuth credentials.
- Never log or return the token. The admin API exposes only `secret_hint` and `auth_type`.
- The kill switch is a **two-layer check** (resolve path + forward path) so disabling takes effect
  immediately, not after the 30s credential cache TTL.
- Do not fabricate a Claude Code identity. Preserve the incoming `anthropic-beta` / `anthropic-version`
  / `x-claude-code-*` headers; only add a value if live testing proves it is required.
- After any change to the Pothos GraphQL types, run `schema:print` then web `codegen` before the web
  code will compile.

## Phase 0: Decision Gate

### SA-001: Confirm ToS Sign-Off And Owner

Goal: Get an explicit, recorded decision that internal-only use of Claude subscription tokens through
the proxy is an accepted risk, and name the owner.

Scope:

- Confirm the current live Anthropic Consumer/Commercial terms language on OAuth tokens in third-party
  tools (the plan cites a 2026-02-20 clarification from secondary sources).
- Record who owns the risk acceptance and the internal-use-only boundary.
- Confirm the messaging to opt-in engineers: bans/throttles land on their personal Claude account.

Acceptance criteria:

- A named owner has signed off on internal-only use, or the feature is shelved.
- The decision and date are recorded in PLAN.md "Context And Risk".
- No code depends on this ticket; it gates **enabling** the flag (SA-009), not building behind it.

Validation:

- None (non-engineering decision ticket).

Likely files:

- `docs/scopes/subscription-auth-v1/PLAN.md`

## Phase 1: Flag And Contract Spine

### SA-002: Add Subscription OAuth Feature Flag And Surface It To The Console

Goal: Introduce the kill switch and propagate it to the web client, since no mechanism currently exposes
an env flag to the console.

Scope:

- Add `SUBSCRIPTION_OAUTH_ENABLED` via `booleanEnvSchema` (default false) → `config.subscriptionOAuthEnabled`.
- Add `subscriptionOAuthEnabled` to the settings response alongside the existing inline capability flags
  (e.g. `databaseEnabled: Boolean(config.databaseUrl)`).
- Expose `subscriptionOAuthEnabled: Boolean` on the `Settings` Pothos type.
- Re-print the SDL and regenerate the web client types.
- Read the flag in the web settings data layer so components can gate on it.

Acceptance criteria:

- With the flag unset, `config.subscriptionOAuthEnabled` is false.
- The `settings` GraphQL query returns `subscriptionOAuthEnabled`.
- The web client compiles against the regenerated types and can read the flag.
- `.env.example` documents the new flag.

Validation:

- Run `pnpm --filter @proxy/proxy schema:print` then `pnpm --filter @proxy/web codegen`.
- Run `pnpm --filter @proxy/proxy test` and `pnpm --filter @proxy/web typecheck`.

Likely files:

- `apps/proxy/src/config.ts`
- `apps/proxy/src/graphql/settingsPayload.ts`
- `apps/proxy/src/graphql/types/settings.ts`
- `apps/web/src/settingsPageData.ts`
- `apps/web/src/gql/*` (generated)
- `.env.example`

## Phase 2: Credential Creation And Storage

### SA-003: Accept OAuth Subscription Tokens In The Create-Credential Mutation

Goal: Let an operator store a subscription token as an `oauth` provider account, reusing the existing
encryption path.

Scope:

- Add `authType: "api_key" | "oauth"` (default `"api_key"`) to `CreateProviderCredentialInput`; keep the
  `apiKey` field name.
- Extend the Zod body schema and resolver passthrough in lock-step.
- In `createCredential`, when `authType === "oauth"`: require `config.subscriptionOAuthEnabled`
  (`subscription_oauth_disabled`), require `provider === "anthropic"`, require the token to start with
  `sk-ant-oat01-` (`invalid_subscription_token`); store `auth_type:"oauth"`,
  `settings.tokenKind:"claude_oauth"`, encrypted ciphertext, and a masked hint.
- Leave the existing `api_key` path unchanged.
- Re-print SDL + regenerate web types for the new input field.

Acceptance criteria:

- Creating an oauth credential with the flag on and a valid prefix persists an `auth_type:"oauth"` row.
- Flag off → rejected with `subscription_oauth_disabled`.
- Non-anthropic provider or bad prefix → rejected with field-level errors.
- The token is never returned; only `secret_hint` and `auth_type` are.

Validation:

- Run `pnpm --filter @proxy/proxy schema:print` then `pnpm --filter @proxy/web codegen`.
- Add create-path unit tests; run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/graphql/mutations.ts`
- `apps/proxy/src/persistence/providerCredentialAdmin.ts`
- `apps/proxy/test/providerCredentials.test.ts`

## Phase 3: Binding Guardrail

### SA-004: Enforce Per-User Binding For OAuth Credentials

Goal: Prevent a personal subscription token from being bound to a shared key (the anti-pooling control).

Scope:

- Extend the shared `byokAccount` helper to also select `created_by_user_id` (additive; revoke ignores it).
- In `bindApiKeyCredential`, load `api_keys.user_id` for the target key.
- When the target provider account is `oauth`, reject unless `api_keys.user_id` is non-null and equals
  `provider_accounts.created_by_user_id`; throw `provider_credential_owner_mismatch` (409) otherwise.
- Leave `api_key` binding behavior unchanged.

Acceptance criteria:

- Binding an oauth credential to a key owned by the same user succeeds.
- Binding to a key owned by a different user is rejected.
- Binding to a key with a null `user_id` is rejected.
- The `byokAccount` change does not alter revoke behavior.

Validation:

- Add bind guardrail unit tests (two distinct users, two keys); run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/persistence/providerCredentialAdmin.ts`
- `apps/proxy/test/providerCredentials.test.ts`

## Phase 4: Runtime Forwarding

### SA-005: Resolve OAuth Credentials At Request Time

Goal: Make `resolveForRequest` return oauth credentials (behind the flag), carrying the auth type.

Scope:

- Add `authType: ProviderAccountAuthType` to `UpstreamCredential`.
- Split the current combined guard so the `!secret_ciphertext` null check remains a precondition for
  **both** auth types before any decrypt.
- For `auth_type === "oauth"`: return undefined when `config.subscriptionOAuthEnabled` is false (company-key
  fallback); otherwise decrypt and return `{ authType:"oauth", token, … }`.
- Keep the existing `api_key` path and the 30s cache (now caching the credential with its `authType`).

Acceptance criteria:

- Flag on → oauth account resolves to a credential with `authType:"oauth"`.
- Flag off → oauth account resolves to undefined.
- An oauth row with null ciphertext resolves to undefined.
- `api_key` resolution is unchanged.

Validation:

- Add resolver unit tests; run `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/types.ts`
- `apps/proxy/src/persistence/providerCredentials.ts`
- `apps/proxy/test/providerCredentials.test.ts`

### SA-006: Forward OAuth Credentials As Bearer With A Kill-Switch Re-Check

Goal: Send oauth credentials as `Authorization: Bearer` (not `x-api-key`) on every Anthropic forward
surface, and enforce the kill switch at forward time.

Scope:

- In `headersFor`, when the credential `authType` is `"oauth"` **and** `config.subscriptionOAuthEnabled`
  is true: set `authorization: Bearer <token>` and do not set `x-api-key`.
- Otherwise keep the current Anthropic behavior (`x-api-key` = credential token ?? company key).
- Preserve `anthropic-version`, `anthropic-beta`, and `x-claude-code-*` passthrough.
- Confirm both `POST /v1/messages` and `POST /v1/messages/count_tokens` route through this dispatch.

Acceptance criteria:

- oauth + flag on → `authorization` set, `x-api-key` absent, beta/version preserved.
- oauth + flag off → oauth ignored, company key used (cache-window kill switch works).
- `api_key` and OpenAI paths unchanged.
- count-tokens requests forward the bearer token, not `x-api-key`.

Validation:

- Add `headersFor` unit tests covering oauth on/off, api_key, and count-tokens; run
  `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/src/proxy.ts`
- `apps/proxy/test/proxy.test.ts`

## Phase 5: Console UI

### SA-007: Add Subscription Auth To The Model Providers Console

Goal: Let an operator add a subscription token from the console and distinguish it from API keys.

Scope:

- Add an auth-type select ("API key" / "Claude subscription (Pro/Max)") to the create panel, shown only
  when `settings.subscriptionOAuthEnabled` is true.
- For the subscription option: helper text to run `claude setup-token` and paste the `sk-ant-oat01-…`
  value into the existing token field, client-side prefix validation, and a short ToS/risk callout
  (personal subscription; bans hit your own account).
- Show an `auth_type` tag (API key vs Subscription) on the provider credentials list (the `authType` field is
  already on the `ProviderAccount` output type — no schema change needed for the list).

Acceptance criteria:

- With the flag off, the subscription option is not shown.
- Submitting a subscription token calls the existing mutation with `authType:"oauth"`.
- The list visually distinguishes subscription credentials from API keys.
- No direct `useEffect` is introduced.

Validation:

- Run `pnpm --filter @proxy/web typecheck` and `pnpm build`.
- Manual check of the create + list flow against a local proxy with the flag on.

Likely files:

- `apps/web/src/createProviderCredentialPanel.tsx`
- `apps/web/src/providersPage.tsx`
- `apps/web/src/providers/data.ts`

## Phase 6: Verification, Tests, And Docs

### SA-008: Integration Tests For Guardrail, Kill Switch, And Count-Tokens

Goal: Cover the cross-cutting behaviors that single-unit tests miss, using the existing integration-style
fixtures (real Fastify server, admin GQL client, mock upstream).

Scope:

- Two-user fixture proving the binding guardrail (same-user accept, different-user reject, null-owner
  reject) end to end through the admin API.
- Flag-off kill-switch test proving a bound oauth credential stops being forwarded immediately (covering
  the cached-credential path).
- Count-tokens path forwarding a bearer token with a mock upstream assertion.
- Local-dev note: these run with a fake `sk-ant-oat01-…` value; no real token required.

Acceptance criteria:

- The guardrail and kill-switch behaviors are proven against the running server, not just unit mocks.
- Tests assert the upstream `Authorization` / `x-api-key` headers via the mock upstream.
- Suite is green with the flag toggled both ways.

Validation:

- Run `pnpm build:runtime` then `pnpm --filter @proxy/proxy test`.

Likely files:

- `apps/proxy/test/providerCredentials.test.ts`
- `apps/proxy/test/proxy.test.ts`

### SA-009: Live-Token Verification

Goal: Prove the forward actually works against `api.anthropic.com` with a real subscription token. Gated
on SA-001.

Scope:

- Mint a token via `claude setup-token` on a Pro/Max account; bind it to a personal key with the flag on.
- Run a real Claude Code request through the proxy and confirm a 200 upstream.
- Determine whether the org system-prompt prepend / classifier rewrite trips any fingerprint check, and
  whether a specific `anthropic-beta` or minimum `anthropic-version` is required.
- Confirm the usage bucket (June 15 Agent SDK credit) and that routed model names are covered by the plan.
- Confirm flag-off fallback with and without a valid company `ANTHROPIC_API_KEY`.

Acceptance criteria:

- A real request succeeds end to end through the proxy on a subscription token.
- Any required header tweak is captured back into PLAN.md and SA-006, or the limitation is documented.
- The company-key-absent flag-off behavior is confirmed and documented.

Validation:

- Manual end-to-end run; record results in the PR description and PLAN.md "Known Caveats".

Likely files:

- `docs/scopes/subscription-auth-v1/PLAN.md`

### SA-010: Docs And Operator Runbook

Goal: Make the feature usable and the kill switch operable without reading the code.

Scope:

- Update the README BYOK section (it currently lists "Claude subscription/OAuth tokens" as a planned
  follow-up) to document minting and pasting a `setup-token`.
- Add a short runbook: how to enable/disable the flag, the per-user binding rule, the June 15 Agent SDK
  credit caveat, and the company-key dependency under flag-off.
- Link the runbook from `docs/index.md`.

Acceptance criteria:

- An engineer can mint, paste, bind, and use a subscription token from docs alone.
- An operator can disable the feature and understands the fallback behavior.
- Docs state the internal-only / ToS boundary.

Validation:

- Run `rg "setup-token|SUBSCRIPTION_OAUTH_ENABLED" docs README.md`.

Likely files:

- `README.md`
- `docs/runbooks/subscription-auth.md`
- `docs/index.md`

## Suggested PR Batches

1. SA-002 + SA-003: flag spine and the oauth create/storage path (nothing forwards yet).
2. SA-004: per-user binding guardrail.
3. SA-005 + SA-006: runtime resolution and bearer forwarding (feature works behind the flag).
4. SA-007: console UI.
5. SA-008: integration tests (can also land alongside batches 2–3).
6. SA-010: docs and runbook.

SA-001 runs upfront in parallel (non-engineering). SA-009 is last and is gated on SA-001 plus a complete
build.

## Dependency Graph

```text
SA-001  (ToS sign-off, non-eng) ─────────────────────────────┐
                                                             gates
SA-002                                                         │
  -> SA-003                                                    v
       -> SA-004 ───────────────┐                           SA-009
  -> SA-005                      │                          (verify)
       -> SA-006 ──┬──> SA-007 ──┤
                   └──> SA-008 ──┘
                                  -> SA-010 (docs, after SA-007)
```
