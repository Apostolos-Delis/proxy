# Subscription Auth Runbook

Subscription credentials let an internal engineer route their own Claude Code or Codex traffic through
the proxy on a personal/workspace subscription credential instead of the company API key. OpenAI Codex
subscription credentials are always enabled. Claude subscription credentials are enabled by default
and disabled with `SUBSCRIPTION_OAUTH_ENABLED=false`.

> **Provider boundary (read first).** Use provider-owned auth flows for accounts the engineer owns:
> console/browser OAuth, `codex login`, or Codex access tokens for OpenAI, and Claude browser OAuth
> or `claude setup-token` for Anthropic. Proxy stores provider secrets encrypted at rest;
> OpenAI console sign-in and Codex auth JSON imports store refresh tokens only inside the encrypted
> provider secret bundle. Claude browser OAuth stores the same long-lived setup-token form that
> Claude Code uses for `CLAUDE_CODE_OAUTH_TOKEN`. This feature is still an
> internal operator workflow, not an external customer-facing pooling product. On shared proxy hosts,
> Claude browser OAuth requires the browser and proxy callback listener to be on the same host.
> Scope details live in [the local auth import plan](../scopes/subscription-local-auth-v1/PLAN.md).

## Enable

1. Leave `SUBSCRIPTION_OAUTH_ENABLED=true` on the proxy, or unset it to use the default-on behavior. `PROVIDER_SECRET_ENCRYPTION_KEY`
   must be set (tokens are encrypted at rest like any BYOK secret), and verify a real company
   `ANTHROPIC_API_KEY` is configured so the disable path degrades gracefully (see below).
2. The Model providers console shows **Claude subscription** and **Codex subscription** connection
   types on "Add credential".

## Disable (kill switch)

Set `SUBSCRIPTION_OAUTH_ENABLED=false` and restart to disable Claude subscription credentials. The Anthropic check is two-layer —
credential resolution refuses Claude oauth accounts and the forward path re-checks the flag — so new
Claude forwards fall back to the company key at once, even for credentials sitting in the 30s in-memory
cache; only requests already on the wire complete with the bearer token. OpenAI Codex subscription credentials remain enabled. Stored tokens stay
encrypted in `provider_accounts` and can be revoked individually from the console. Revoking unbinds
the credential at once, but a copy already in the in-memory cache may forward for up to 30 seconds
on a running instance — the flag is the Claude hard stop, revoke is the per-credential cleanup.

**Company-key dependency:** flag-off Anthropic traffic silently falls back to `ANTHROPIC_API_KEY`. If it is unset or a placeholder, disabling the flag turns Claude subscription traffic
into 401s rather than a graceful fallback — keep a valid company key configured, or accept that flag-off
stops affected Anthropic traffic.

## Anthropic: Browser Sign-In

1. Console → **Model providers** → **Add credential** → **Claude subscription** → source
   **Sign in with Claude**.
2. Start sign-in and finish the Claude browser login for the account that should pay for this
   traffic. The proxy runs a temporary `localhost` callback listener, exchanges the returned code,
   validates the resulting `sk-ant-oat01-` token, encrypts it, and never returns it.
3. Browser sign-in must run on the same machine as the proxy callback listener. If that is not true,
   use the manual fallback below.
4. Bind the credential to a prompt API key **you own** on the **API keys** page. Binding is
   hard-rejected (`provider_credential_owner_mismatch`) when the key belongs to someone else or has
   no owner.
5. Point Claude Code at the proxy with that API key. Requests forward with
   `Authorization: Bearer <token>` (never `x-api-key`); `anthropic-version`, `anthropic-beta`, and
   the `x-claude-code-*` identity headers (session, agent, and parent-agent ids) pass through
   unchanged. This covers `/v1/messages` and `/v1/messages/count_tokens`.

## Anthropic: Manual Fallback

1. Run `claude setup-token` while signed into the Claude account that should pay for this traffic.
2. Console → **Model providers** → **Add credential** → **Claude subscription** → source
   **Paste setup token** → paste the printed `sk-ant-oat01-...` value.
3. Bind the credential to a prompt API key **you own** on the **API keys** page. Binding is
   hard-rejected (`provider_credential_owner_mismatch`) when the key belongs to someone else or has
   no owner.
4. Point Claude Code at the proxy with that API key. Requests forward with
   `Authorization: Bearer <token>` (never `x-api-key`); `anthropic-version`, `anthropic-beta`, and
   the `x-claude-code-*` identity headers (session, agent, and parent-agent ids) pass through
   unchanged. This covers `/v1/messages` and `/v1/messages/count_tokens`.

## OpenAI: Console Sign-In

1. Console → **Model providers** → **Add credential** → **Codex subscription** → source
   **Sign in with OpenAI**.
2. Start sign-in, open the OpenAI device-code link, and enter the one-time code shown in the wizard.
3. After OpenAI confirms the login, Proxy exchanges the code for Codex OAuth tokens and stores
   the access and refresh tokens inside the encrypted provider secret bundle. The ChatGPT account ID
   is stored as provider metadata for the upstream `ChatGPT-Account-Id` header.
4. Bind the credential to a prompt API key **you own** on the **API keys** page. The same
   `provider_credential_owner_mismatch` guardrail applies to OpenAI subscription credentials.
5. Point Codex at the proxy with that API key. Requests forward to `OPENAI_CHATGPT_BASE_URL`
   (default `https://chatgpt.com/backend-api/codex`) with `Authorization: Bearer <token>` and
   `ChatGPT-Account-Id: <account-id>`. API-key OpenAI traffic continues to use `OPENAI_BASE_URL`.

## OpenAI: Local Import

1. Run `codex login` on the proxy host as the same OS user that runs Proxy. If browser login
   cannot complete there, run `codex login --device-auth`.
2. Confirm the auth cache exists at `~/.codex/auth.json`. If it lives somewhere else, set
   `PROXY_CODEX_AUTH_FILE=/path/to/auth.json` where the proxy runs, then restart the proxy.
3. Console → **Model providers** → **Add credential** → **Codex subscription** → source
   **Import from Codex** → save. The server reads the auth JSON and stores the same encrypted token
   bundle used by the console sign-in flow when a refresh token is present.
4. Bind and use it the same way as the console sign-in path.

## OpenAI: Manual Fallback

1. Create or obtain a Codex access token for ChatGPT-backed Codex usage. For Business/Enterprise,
   prefer the ChatGPT workspace **Access tokens** page.
2. Get the ChatGPT account ID for the same Codex identity. Codex sends this upstream as the
   `ChatGPT-Account-Id` header.
3. Console → **Model providers** → **Add credential** → **Codex subscription** → source
   **Paste token or JSON** → paste the Codex access token and ChatGPT account ID, or paste the full
   Codex auth JSON. This option is always enabled; it is not gated by
   `SUBSCRIPTION_OAUTH_ENABLED`.
4. Bind and use it the same way as the local import path.

## Caveats

- **OpenAI refresh:** console sign-in and Codex auth JSON imports store refresh tokens encrypted and
  refresh access tokens on demand. Manually pasted raw access tokens cannot be refreshed.
- **OpenAI coverage:** this path is for HTTP `/v1/responses`; the OpenAI realtime WebSocket remains on
  the company key path.
- **Model coverage:** the token only covers models the plan grants. Routing configs that select
  models outside the plan will fail upstream for that traffic.
- **Token lifetime:** Claude browser OAuth and `setup-token` credentials last about a year and are
  not auto-rotated; revoke and re-create to rotate. Upstream 401s on a subscription credential
  usually mean the token was revoked or the account was actioned — revoke the credential and fall
  back to API keys.
- **Prefix drift:** the `sk-ant-oat01-` prefix check (server: `CLAUDE_SUBSCRIPTION_TOKEN_PREFIX` in
  `packages/schema`) will reject future token formats if Anthropic rotates prefixes; update the
  constant if that happens.
