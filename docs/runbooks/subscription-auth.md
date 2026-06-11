# Subscription Auth Runbook

Claude subscription tokens let an internal engineer route their own Claude Code traffic through the
proxy on their personal Pro/Max plan instead of the company API key. The feature is Anthropic-only,
internal-only, and **off by default** behind `SUBSCRIPTION_OAUTH_ENABLED`.

> **ToS boundary (read first).** Using subscription OAuth tokens outside Claude Code/Claude.ai is
> against the letter of Anthropic's terms; enforcement (bans, throttles) lands on the **individual
> engineer's own Claude account**, not a shared org account. The feature exists as a deliberate,
> internal-only convenience and must never be offered to external customers. Risk context and the
> sign-off gate live in [the scope](../scopes/subscription-auth-v1/PLAN.md).

## Enable

1. Set `SUBSCRIPTION_OAUTH_ENABLED=true` on the proxy and restart. `PROVIDER_SECRET_ENCRYPTION_KEY`
   must also be set (tokens are encrypted at rest like any BYOK secret), and verify a real company
   `ANTHROPIC_API_KEY` is configured so the disable path degrades gracefully (see below).
2. The Provider keys console now shows an **Auth type** select on "Add provider key".

## Disable (kill switch)

Unset the flag (or set `SUBSCRIPTION_OAUTH_ENABLED=false`) and restart. The check is two-layer —
credential resolution refuses oauth accounts and the forward path re-checks the flag — so new
forwards fall back to the company key at once, even for credentials sitting in the 30s in-memory
cache; only requests already on the wire complete with the bearer token. Stored tokens stay
encrypted in `provider_accounts` and can be revoked individually from the console. Revoking unbinds
the credential at once, but a copy already in the in-memory cache may forward for up to 30 seconds
on a running instance — the flag is the hard stop, revoke is the per-credential cleanup.

**Company-key dependency:** flag-off traffic silently falls back to the company `ANTHROPIC_API_KEY`.
If that is unset or a placeholder, disabling the flag turns subscription traffic into 401s rather
than a graceful fallback — keep a valid company key configured, or accept that flag-off stops
Anthropic traffic for affected keys.

## Mint, Paste, Bind, Use

1. Run `claude setup-token` locally on a Claude Pro/Max account and copy the printed
   `sk-ant-oat01-…` token (inference-scoped, ~1-year lifetime — no refresh subsystem needed).
2. Console → **Provider keys** → **Add provider key** → Auth type "Claude subscription (Pro/Max)" →
   paste the token. The server rejects non-Anthropic providers, wrong prefixes, and creation while
   the flag is off.
3. Bind the credential to a prompt-proxy API key **you own** on the **API keys** page. Binding is
   hard-rejected (`provider_credential_owner_mismatch`) when the key belongs to someone else or has
   no owner — one engineer's subscription must never serve another's traffic (pooling is the
   pattern Anthropic bans for).
4. Point Claude Code at the proxy with that API key. Requests forward with
   `Authorization: Bearer <token>` (never `x-api-key`); `anthropic-version`, `anthropic-beta`, and
   the `x-claude-code-*` identity headers (session, agent, and parent-agent ids) pass through
   unchanged. This covers `/v1/messages` and `/v1/messages/count_tokens`.

## Caveats

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
