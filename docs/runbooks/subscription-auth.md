# Subscription Auth Runbook

Subscription credentials let an internal engineer route their own Claude Code or Codex traffic through
the proxy on a personal/workspace subscription credential instead of the company API key. OpenAI Codex
subscription credentials are always enabled. Claude subscription credentials are internal-only,
enabled by default, and disabled with `SUBSCRIPTION_OAUTH_ENABLED=false`.

> **Provider boundary (read first).** For Anthropic, using subscription OAuth tokens outside Claude
> Code/Claude.ai is against the letter of Anthropic's terms; enforcement (bans, throttles) lands on
> the **individual engineer's own Claude account**, not a shared org account. For OpenAI, prefer
> official Codex access tokens where available; short-lived ChatGPT login access tokens must be
> rotated manually when they expire. This feature exists as a deliberate, internal-only convenience
> and must never be offered to external customers. Risk context and the original sign-off gate live in
> [the scope](../scopes/subscription-auth-v1/PLAN.md).

## Enable

1. Leave `SUBSCRIPTION_OAUTH_ENABLED=true` on the proxy, or unset it to use the default-on behavior. `PROVIDER_SECRET_ENCRYPTION_KEY`
   must be set (tokens are encrypted at rest like any BYOK secret), and verify a real company
   `ANTHROPIC_API_KEY` is configured so the disable path degrades gracefully (see below).
2. The Provider keys console now shows an **Auth type** select on "Add provider key".

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

## Anthropic: Mint, Paste, Bind, Use

1. Run `claude setup-token` locally on a Claude Pro/Max account and copy the printed
   `sk-ant-oat01-…` token (inference-scoped, ~1-year lifetime — no refresh subsystem needed).
2. Console → **Provider keys** → **Add provider key** → provider **anthropic** → auth type
   **Subscription** → paste the token. The server rejects wrong prefixes and creation while the flag is
   off.
3. Bind the credential to a prompt-proxy API key **you own** on the **API keys** page. Binding is
   hard-rejected (`provider_credential_owner_mismatch`) when the key belongs to someone else or has
   no owner — one engineer's subscription must never serve another's traffic (pooling is the
   pattern Anthropic bans for).
4. Point Claude Code at the proxy with that API key. Requests forward with
   `Authorization: Bearer <token>` (never `x-api-key`); `anthropic-version`, `anthropic-beta`, and
   the `x-claude-code-*` identity headers (session, agent, and parent-agent ids) pass through
   unchanged. This covers `/v1/messages` and `/v1/messages/count_tokens`.

## OpenAI: Mint, Paste, Bind, Use

1. Create or obtain a Codex access token for ChatGPT-backed Codex usage. For Business/Enterprise,
   prefer the ChatGPT workspace **Access tokens** page. For a local ChatGPT login, `codex login`
   stores a short-lived access token in `~/.codex/auth.json` or the OS credential store; Codex refreshes
   it during normal Codex use, but the proxy does not call OpenAI's refresh endpoint.
2. Get the ChatGPT account ID for the same Codex identity. Codex sends this upstream as the
   `ChatGPT-Account-Id` header.
3. Console → **Provider keys** → **Add provider key** → provider **openai** → auth type
   **Subscription** → paste the Codex access token and ChatGPT account ID. This option is always enabled; it is not gated by `SUBSCRIPTION_OAUTH_ENABLED`. The server stores only the
   access token encrypted at rest and stores the account ID as credential metadata.
4. Bind the credential to a prompt-proxy API key **you own** on the **API keys** page. The same
   `provider_credential_owner_mismatch` guardrail applies to OpenAI subscription credentials.
5. Point Codex at the proxy with that API key. Requests forward to `OPENAI_CHATGPT_BASE_URL`
   (default `https://chatgpt.com/backend-api/codex`) with `Authorization: Bearer <token>` and
   `ChatGPT-Account-Id: <account-id>`. API-key OpenAI traffic continues to use `OPENAI_BASE_URL`.

## Caveats

- **OpenAI refresh:** the proxy does not store or refresh OpenAI refresh tokens. Use official Codex
  access tokens where available, or rotate short-lived ChatGPT login access tokens manually.
- **OpenAI coverage:** this path is for HTTP `/v1/responses`; the OpenAI realtime WebSocket remains on
  the company key path.
- **Agent SDK credit bucket:** since June 15, 2026, Anthropic meters Agent SDK / non-interactive
  usage on subscription plans from a separate monthly credit, distinct from interactive limits.
  Proxied traffic likely draws from that bucket, so a subscription buys less through the proxy than
  in the Claude Code TUI.
- **Model coverage:** the token only covers models the plan grants. Routing configs that select
  models outside the plan will fail upstream for that traffic.
- **Token lifetime:** `setup-token` tokens last about a year and are not auto-rotated; revoke and
  re-paste to rotate. Upstream 401s on a subscription credential usually mean the token was revoked
  or the account was actioned — revoke the credential and fall back to API keys.
- **Prefix drift:** the `sk-ant-oat01-` prefix check (server: `CLAUDE_SUBSCRIPTION_TOKEN_PREFIX` in
  `packages/schema`) will reject future token formats if Anthropic rotates prefixes; update the
  constant if that happens.
