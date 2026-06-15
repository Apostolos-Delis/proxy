# Subscription Auth V1

> Current implementation note (2026-06-12): this original scope shipped the Anthropic-only V1. A later
> follow-up now also supports OpenAI HTTP Responses subscription credentials by storing a Codex access
> token encrypted at rest, storing `chatgptAccountId` as provider metadata, forwarding to
> `OPENAI_CHATGPT_BASE_URL`, and sending `ChatGPT-Account-Id`. The proxy does not store or refresh
> OpenAI refresh tokens; use official Codex access tokens where available or rotate short-lived ChatGPT
> login tokens manually.

## Goal

Let a user authenticate upstream Anthropic traffic with a **Claude Pro/Max/Team/Enterprise
subscription token** instead of a pay-as-you-go API key, bound per prompt-proxy API key the same way
BYOK provider keys already are.

Scope of V1 is deliberately narrow:

- **Anthropic only.** OpenAI "Sign in with ChatGPT" is a separate follow-up (see Out Of Scope).
- **Internal use only.** This is for our own engineers routing their own Claude subscriptions through
  the proxy, not a customer-facing feature.
- **Paste a long-lived token**, not a full in-console OAuth flow. The user runs `claude setup-token`
  locally and pastes the resulting token into the console.
- **Behind a default-off kill switch for Anthropic** so Claude subscription auth can be disabled at any time. OpenAI Codex subscription auth is always enabled.

## Context And Risk (read first)

This feature is **against the letter of Anthropic's terms of service** and is being built anyway, as a
deliberate, time-boxed decision, for internal use only.

- As of **2026-02-20**, Anthropic's terms state that using OAuth tokens obtained through Claude
  Free/Pro/Max accounts "in any other product, tool, or service — including the Agent SDK — is not
  permitted." Sanctioned surfaces are Claude Code, Claude.ai, Claude Desktop, or tools with explicit
  written authorization. Enforcement (account bans, harness fingerprinting) has been reported since
  early 2026.
- **Consequence:** any ban or throttle lands on the **individual engineer's own Claude account**, not
  a shared org account. This must be communicated to anyone who opts in.
- **Mitigation:** Anthropic subscription auth is gated behind a default-off flag (`SUBSCRIPTION_OAUTH_ENABLED`)
  and is internal-only. We can disable Claude subscription auth in one config change. It must never be offered to external
  customers without revisiting this section.
- **The ToS facts above come from secondary sources.** Before merging, someone must confirm the
  current live Anthropic Consumer/Commercial terms. This single fact governs whether the feature
  should exist at all. **Owner for that sign-off must be named (see Open Questions).**

> The sanctioned path for scaling Anthropic usage remains API keys (BYOK + company keys) and a
> commercial agreement. Subscription tokens are a per-seat internal convenience, **not** a multi-tenant
> scaling mechanism. Pooling one subscription across many users is reselling and is explicitly out.

## Current State

The BYOK credential plumbing is already the right skeleton, and the data model needs **no schema
migration** to support OAuth tokens (all required columns verified present).

```text
provider_accounts          upstream credential, already has:
  auth_type                $type<ProviderAccountAuthType> = "api_key" | "oauth"  (oauth already declared)
  secret_ciphertext        AES-256-GCM blob (today: the API key)
  secret_ref               unused free reference column (do not touch)
  secret_hint              masked display hint (e.g. ••••1234)
  settings                 jsonb Record<string, unknown>, free-form per-account metadata
  created_by_user_id       references users(id); populated on create  (used by the binding guardrail)
  status                   active | disabled
  last_used_at
api_keys                   caller identity, already has:
  user_id                  references users(id), NULLABLE (onDelete: set null)  (the key's owner)
  workspace_id, organization_id
api_key_provider_accounts  binds (org, api_key, provider) -> provider_account  (at most one per provider per key)
```

Relevant code (line refs verified at planning time — this section describes the **pre-implementation**
starting point, not the shipped state):

```text
packages/schema/src/index.ts:26          PROVIDER_ACCOUNT_AUTH_TYPES = ["api_key", "oauth"]  (already exists)
packages/db/src/schema.ts                provider_accounts (settings jsonb:307, created_by_user_id:305), api_keys.user_id:11
packages/db/src/secretCrypto.ts          encryptSecret / decryptSecret / secretHint (AES-256-GCM)
persistence/providerCredentials.ts:33    ProviderCredentialStore.resolveForRequest (api_key -> account, 30s cache by account.id)
persistence/providerCredentials.ts:61    combined guard: authType !== "api_key" || !secretCiphertext -> undefined
persistence/providerCredentialAdmin.ts   createCredential (hardcodes auth_type:"api_key"), bindApiKeyCredential, byokAccount (does NOT select createdByUserId today)
graphql/mutations.ts:36                   CreateProviderCredentialInput { provider, name, apiKey }
graphql/types/routing.ts:142              ProviderAccount GQL output ALREADY exposes authType (no new output field needed)
graphql/settingsPayload.ts:45             capability flags computed inline from config (e.g. Boolean(config.databaseUrl))
proxy.ts:290-321                          headersFor() builds upstream headers; Anthropic branch sets x-api-key unconditionally (:311)
proxy.ts (forward path)                   also used by POST /v1/messages AND POST /v1/messages/count_tokens (server.ts)
types.ts:18                               UpstreamCredential { provider, token, providerAccountId }  (no authType yet)
config.ts:22                              booleanEnvSchema (default false) flag pattern; anthropicApiKey defaults to "test-anthropic-key" (:75)
apps/web/src/createProviderCredentialPanel.tsx, providersPage.tsx, providers/data.ts   BYOK UI + client types (generated gql in apps/web/src/gql)
```

Today `resolveForRequest` early-returns on the combined guard above, and `headersFor` only knows
`x-api-key` (Anthropic) / `Authorization: Bearer` (OpenAI), each with a company-key fallback. The
README already lists "Claude subscription/OAuth tokens" as a planned follow-up.

## Product Model

Two models exist; V1 builds only the first and explicitly forbids the second.

```text
Per-user passthrough (V1)
  An engineer mints their own subscription token and binds it to an API key THEY own.
  The proxy forwards only that engineer's token for that engineer's traffic.

Pooled subscriptions (OUT OF SCOPE — reselling)
  One subscription token fans out across many users' traffic.
  This is the abuse pattern Anthropic bans for. Do not build.
```

### Binding guardrail (first-class requirement, not a nicety)

An `oauth` provider account must only be bindable to an API key owned by the same user who created the
credential. Binding a personal subscription token to a shared/team key turns per-user passthrough into
pooling, breaks the "individual usage" assumption, and blows the subscription's rate limits.

Concrete, implementable spec (the owner column exists: `api_keys.user_id`, nullable):

```text
At bind time, when the target provider_account.auth_type == "oauth":
  reject unless api_keys.user_id IS NOT NULL AND api_keys.user_id == provider_account.created_by_user_id
  - null api_keys.user_id (org/workspace key with no human owner) -> HARD REJECT (not a pass)
  - mismatch -> HARD REJECT
  error code: provider_credential_owner_mismatch (409), matching existing AdminMutationError style
```

This is a **hard rejection**, not a warning (resolves prior open question). Implementation note: the
shared `byokAccount` helper does **not** currently select `created_by_user_id`, and `bindApiKeyCredential`
does **not** currently load `api_keys.user_id` — both must be extended. `byokAccount` is shared with the
revoke path, so the added column must be additive only (revoke ignores it).

## Token Mechanics

`claude setup-token` (official Anthropic command) walks the user through OAuth authorization and prints
a **one-year, inference-scoped** token. It requires a Pro/Max/Team/Enterprise plan. It is not saved
anywhere by the CLI — the user copies it out.

```text
token prefix    sk-ant-oat01-…                 (access token; see prefix-fragility caveat)
lifetime        ~1 year (setup-token)          -> NO refresh infra needed in V1
scope           inference only                  (cannot establish Remote Control sessions)
```

Anthropic documents the proxy path directly: the `ANTHROPIC_AUTH_TOKEN` env var is "sent as the
`Authorization: Bearer` header… when routing through an LLM gateway or proxy that authenticates with
bearer tokens rather than Anthropic API keys." So the forward is a bearer swap.

```text
API-key forward (today)          OAuth forward (V1)
  x-api-key: <key>                 authorization: Bearer <sk-ant-oat01-…>
                                   (NO x-api-key header at all — must be actively omitted)
  anthropic-version: 2023-06-01    anthropic-version: <passthrough, default 2023-06-01 — see caveat>
  anthropic-beta: <passthrough>    anthropic-beta: <passthrough, preserved>
```

**Fingerprint handling.** Anthropic constrains OAuth-token requests to look like Claude Code (identity
headers and/or system-prompt shape). In our case the *real Claude Code client* is the thing pointing at
the proxy, so the incoming request body and `anthropic-beta` / `x-claude-code-*` headers already carry
Claude Code's shape (verified preserved at `proxy.ts:313-317`); we preserve them rather than fabricate
them. Known risks: (a) our org-level system-prompt prepend and (b) classifier-driven request rewrites
altering that shape. **We do not hardcode a fake identity.** If empirical testing shows a specific
`anthropic-beta` (or minimum `anthropic-version`) value is required, we preserve the incoming one and
only add a missing value — verified against a live request, not guessed.

## Decision

Build per-user passthrough with a pasted `setup-token`, Anthropic-only, behind a default-off flag. This
is a small change on top of existing BYOK plumbing with no schema migration, no PKCE, no callback
routes, and no token-refresh subsystem. The `CreateProviderCredentialInput.apiKey` field is **kept as-is
and semantically overloaded** to carry either an API key or a subscription token — we do **not** rename
it to avoid a breaking change across the GraphQL SDL, generated client types, data layer, and panel.

## Feature Flag / Kill Switch

```text
SUBSCRIPTION_OAUTH_ENABLED   booleanEnvSchema, default false  -> config.subscriptionOAuthEnabled
```

Behavior — **two-layer Anthropic check so disabling is immediate**, not subject to the 30s credential cache:

```text
flag ON   Claude oauth credentials can be created, bound, resolved, and forwarded
flag OFF  - createCredential with provider:"anthropic", auth_type:"oauth" is rejected (validation error)
          - resolveForRequest returns undefined for Anthropic oauth accounts (cache-miss path)
          - headersFor ALSO re-checks config.subscriptionOAuthEnabled at forward time and ignores an
            Anthropic oauth credential if the flag is off  (covers cached credentials within the 30s TTL window)
          => Anthropic forward falls back to the company API key (existing behavior)
          - web UI hides the "Claude subscription" auth-type option
          - OpenAI Codex oauth credentials can still be created, bound, resolved, and forwarded
```

The forward-time re-check is required: the credential cache (`providerCredentials.ts:47-48`, keyed by
`account.id`, 30s TTL) returns a cached credential *before* the resolve-path flag check runs, so without
the second check a toggled-off flag would not take effect for up to 30 seconds.

**Company-key dependency:** the flag-off fallback sends the company `ANTHROPIC_API_KEY`. If no valid
company key is configured (the default is the placeholder `"test-anthropic-key"`), flag-off becomes a
silent 401 outage, not graceful degradation. Operators relying solely on personal subscription tokens
must keep a valid company key set, or accept that flag-off stops Anthropic traffic. (Resolves the prior
"silent vs loud" open question: fallback is silent by design; the dependency is documented here and in
Verification.)

## Data Model

No migration. Reuse `provider_accounts` for oauth credentials:

```text
auth_type          "oauth"                                 the runtime discriminant (NOT settings.tokenKind)
secret_ciphertext  encryptSecret(<sk-ant-oat01-…>)         the token IS the secret; reuse the API-key path
secret_hint        secretHint(<token>)                     masked, e.g. ••••1234
settings           { "tokenKind": "claude_oauth", "source": "setup-token" }   HUMAN-READABLE METADATA ONLY
created_by_user_id <actor>                                 enforces the per-user binding guardrail
status             "active"
```

`settings.tokenKind` is operator-facing metadata only and is **not** read by any runtime branch — the
`auth_type` column is the single source of truth for dispatch, so no Zod schema is added for `settings`.
Do not store a refresh token (setup-token does not issue one for V1). The secret only ever lives in
`secret_ciphertext`. The `!secret_ciphertext` null guard in `resolveForRequest` must remain a precondition
for **both** auth types before any decrypt (it is currently fused with the api_key check and must not be
dropped when the branch is split).

## Runtime Flow

```text
POST /v1/messages   AND   POST /v1/messages/count_tokens     (both forward via proxy.headersFor)
  -> authenticate prompt-proxy API key -> org, workspace, api_key, owner
  -> ProviderCredentialStore.resolveForRequest({ org, apiKey, provider: "anthropic" })
       -> cache hit (30s by account.id) -> return cached credential   (flag re-checked downstream in headersFor)
       -> binding -> load provider_account
       -> if !secret_ciphertext: return undefined                     (precondition for ALL auth types)
       -> if auth_type == "api_key": decrypt -> UpstreamCredential { authType:"api_key", token }
       -> if auth_type == "oauth":
            if !config.subscriptionOAuthEnabled -> return undefined    (fall back to company key)
            decrypt -> UpstreamCredential { authType:"oauth", token }
  -> proxy.headersFor("anthropic", incoming, credential)
       -> if credential?.authType == "oauth" AND config.subscriptionOAuthEnabled:
            authorization = `Bearer ${token}`; do NOT set x-api-key
          else:
            x-api-key = (api_key credential token) ?? company key      (unchanged)
          preserve anthropic-version / anthropic-beta / x-claude-code-* as today
  -> forward upstream, persist request/usage/events as today
```

Type change:

```text
UpstreamCredential {
  provider
  token
  providerAccountId
  authType: ProviderAccountAuthType        // NEW — required so headersFor can dispatch
}
```

**Acknowledged debt:** `headersFor` already branches on provider; adding an `authType` branch nests a
second dimension inside the Anthropic block. Acceptable for two providers × two auth types in V1. At the
next auth type (e.g. OpenAI oauth), extract a credential→header strategy rather than deepening the
branching. Noted so it is a deliberate choice, not an accident.

## Admin API Scope

Extend the existing mutation; do not add new endpoints, and do **not** rename `apiKey`.

```text
CreateProviderCredentialInput
  provider
  name
  authType   "api_key" | "oauth"   (NEW field, default "api_key")
  apiKey     string                 (UNCHANGED name; semantically holds the API key OR the sk-ant-oat01 token)
```

`ProviderCredentialAdminService.createCredential`:

```text
- if authType == "oauth":
    require config.subscriptionOAuthEnabled         else validation error (subscription_oauth_disabled)
    require provider == "anthropic"                 else validation error (V1)
    require apiKey startsWith "sk-ant-oat01-"        else validation error (invalid_subscription_token)
    store with auth_type:"oauth", settings.tokenKind:"claude_oauth"
- else: existing api_key path unchanged
```

`bindApiKeyCredential`: apply the binding guardrail from Product Model (load `api_keys.user_id`, extend
`byokAccount` to select `created_by_user_id`, hard-reject null/mismatch with
`provider_credential_owner_mismatch`). Reuse the existing `revokeCredential` path for removal — the
`byokAccount` change is additive and does not alter revoke behavior.

The admin API must continue to **never return the token** — only `secret_hint` and `auth_type` (the
latter is already on the `ProviderAccount` output type).

Because `CreateProviderCredentialInput` and the `Settings` type change, **regenerate the schema + client**:
`pnpm --filter @prompt-proxy/proxy schema:print` then the web `codegen`, before the web code will compile.

## Web App Scope

**Flag propagation** (no existing mechanism surfaces an env flag to the client — build it explicitly):

```text
1. config.ts            add SUBSCRIPTION_OAUTH_ENABLED -> config.subscriptionOAuthEnabled
2. settingsPayload.ts   add subscriptionOAuthEnabled: config.subscriptionOAuthEnabled to the response
                        (alongside the existing inline capability flags)
3. Settings GQL type    expose subscriptionOAuthEnabled: Boolean
4. codegen              re-print schema + regenerate web types
5. panel                read the flag from the settings query
```

`createProviderCredentialPanel.tsx`:

```text
- add an auth-type select: "API key" | "Claude subscription (Pro/Max)"
- option only shown when settings.subscriptionOAuthEnabled is true
- when "Claude subscription":
    helper text: run `claude setup-token`, paste the sk-ant-oat01-… token into the apiKey field
    client-side prefix validation
    a short ToS/risk callout (uses your personal subscription; bans hit your own account)
```

`providersPage.tsx`: show `auth_type` per credential (API key vs Subscription tag). The `authType` field
is already on the `ProviderAccount` output type, so no schema change is needed for the list view.

## Security And Privacy

- Token encrypted at rest with the existing AES-256-GCM path; never logged, never returned by the admin
  API (mirror the masked-hint rule — verified the existing create/bind audit events log only `secretHint`
  / ids, never ciphertext; keep it that way).
- Per-user binding guardrail (above) prevents a personal token from silently serving the whole org;
  null-owner keys are rejected outright.
- The 30s credential cache holds decrypted tokens in memory exactly as it does for API keys today — no
  change to that risk profile; the forward-time flag re-check ensures a disabled flag stops use of cached
  oauth tokens immediately.
- Flag-off path must never decrypt the token onto an outbound request (guaranteed by the two-layer check).

## Testing

```text
unit  resolveForRequest: oauth account + flag ON  -> credential.authType == "oauth"
unit  resolveForRequest: oauth account + flag OFF -> undefined (company-key fallback)
unit  resolveForRequest: oauth account, null secret_ciphertext -> undefined (precondition holds)
unit  headersFor anthropic + oauth + flag ON  -> authorization Bearer set, x-api-key ABSENT, anthropic-beta preserved
unit  headersFor anthropic + oauth + flag OFF -> oauth ignored, x-api-key (company key) set  (cache-window kill switch)
unit  headersFor anthropic + api_key -> unchanged (x-api-key set, no authorization)
unit  count_tokens path with an oauth credential -> forwards Bearer, not x-api-key
unit  createCredential oauth + flag OFF -> rejected (subscription_oauth_disabled)
unit  createCredential oauth bad prefix -> rejected (invalid_subscription_token)
unit  bind oauth account to a key owned by the SAME user -> accepted
unit  bind oauth account to a key owned by a DIFFERENT user -> rejected (provider_credential_owner_mismatch)
unit  bind oauth account to a key with NULL user_id -> rejected
```

Existing integration-style fixtures in `apps/proxy/test/providerCredentials.test.ts` (real Fastify
server, admin GQL client, mock upstream) are the model; the guardrail tests need two distinct users with
two keys. Local dev needs no real token — the oauth path is exercised with a fake `sk-ant-oat01-…` value
against the mock upstream. A real token is required only for the manual Verification step below.

## Verification (must do before relying on it)

A real `sk-ant-oat01-` token is required; none of the below can be proven from code alone.

```text
1. Mint a token via `claude setup-token` on a Pro/Max account.
2. Bind it to a personal prompt-proxy API key with the flag ON.
3. Run a real Claude Code request through the proxy and confirm a 200 from api.anthropic.com.
4. Confirm whether the org system-prompt prepend / classifier rewrite trips any fingerprint check, and
   whether a specific anthropic-beta / minimum anthropic-version is required.
5. Confirm which usage bucket the traffic draws from (see June 15 caveat) and that routed model names
   are covered by the subscription.
6. Confirm flag-off fallback behavior with AND without a valid company ANTHROPIC_API_KEY configured.
```

## Known Caveats

- **June 15, 2026 Agent SDK credit:** Anthropic notes that from 2026-06-15, Agent SDK / `claude -p`
  usage on subscription plans draws from a separate monthly Agent SDK credit, distinct from interactive
  limits. Proxied traffic likely lands in that bucket, so a subscription buys less through the proxy
  than in the interactive TUI. Set expectations accordingly.
- **Company-key dependency under flag-off:** silent fallback only degrades gracefully if a valid company
  `ANTHROPIC_API_KEY` is set; otherwise flag-off yields 401s (see Feature Flag section).
- **Token-prefix check is fragile:** Anthropic has changed token prefixes before. The `sk-ant-oat01-`
  check will reject validly-issued future tokens with a different prefix — keep the check loose/centralized
  and revisit if Anthropic rotates prefixes.
- **Model coverage:** subscription tokens only cover models the plan grants; routing must not select a
  model the subscription can't serve (operational concern; covered by Verification step 5, no V1 test).
- **`anthropic-beta` / `anthropic-version` requirements for oauth tokens are unconfirmed** — resolve in
  Verification; do not hardcode.

## Out Of Scope

- Full in-console OpenAI "Sign in with ChatGPT" OAuth (the current follow-up supports pasted Codex
  access tokens plus ChatGPT account IDs, not a browser login flow).
- Full in-console "Sign in with Claude" OAuth flow (authorize redirect, PKCE, callback routes).
- Token refresh / rotation subsystem (unnecessary for the 1-year setup-token).
- Pooled / shared subscription tokens (reselling — prohibited).
- Subscription auth on the OpenAI realtime WebSocket (already company-key only).
- Any external-customer exposure.

## Delivery Order

```text
1. config flag + settingsPayload + Settings GQL type + codegen (the propagation spine).
2. Mutation: authType field, oauth create path, prefix/flag validation.
3. Binding guardrail: extend byokAccount + bind path, owner check, error code.
4. resolveForRequest oauth branch (preserve the !secret_ciphertext precondition).
5. UpstreamCredential.authType + headersFor oauth branch + forward-time flag re-check.
6. Web panel auth-type select + risk callout + auth_type tag on the list.
7. Tests (incl. guardrail + count_tokens + flag-off kill switch).
8. Live-token verification (manual; requires the ToS sign-off first).
```

## Effort

```text
config flag + settings propagation + codegen     ~0.5 day
mutation + oauth create path                      ~0.5 day
binding guardrail (byokAccount + bind + tests)    ~0.5 day
resolveForRequest + headersFor + types            ~1 day
web UI (select, callout, list tag, flag read)     ~1 day
tests                                             ~0.5 day
live-token verification                           ~0.5 day
-----------------------------------------------------------
total                                             ~4–4.5 days (excludes the ToS sign-off)
```

## Implementation Tickets

PR-sized tickets live in [TICKETS.md](TICKETS.md) (SA-001 … SA-010), grouped to match the Delivery Order
above and carrying the hardened design decisions from this plan.

## Open Questions

1. Who owns the ToS sign-off, and is internal-only use an acceptable risk to them? (Blocks step 8.)
2. Do we surface the June 15 Agent SDK credit limitation in the UI, or only in onboarding docs?
3. Is a 1-year token acceptable as-is, or do we want an expiry reminder / rotation nudge before then?
4. Should we proactively detect/disable an oauth credential that starts returning 401s upstream (token
   revoked by the user or banned by Anthropic), or leave that to manual revoke for V1?
