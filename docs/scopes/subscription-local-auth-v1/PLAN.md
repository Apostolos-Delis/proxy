# Subscription Local Auth Import V1

## Goal

Make subscription credentials usable without asking users to reverse-engineer token fields. The console should guide an engineer through provider-owned auth setup, then import the resulting local auth material for both Codex and Claude Code.

## V1 Behavior

- Add a provider credential source selector for subscription credentials:
  - **Import from Codex** reads Codex auth JSON from `PROMPT_PROXY_CODEX_AUTH_FILE`, `CODEX_HOME/auth.json`, or `~/.codex/auth.json`.
  - **Import from Claude Code** reads `CLAUDE_CODE_OAUTH_TOKEN` from the proxy process environment.
  - Manual paste remains as a fallback for both providers.
- Store subscription credentials through the existing provider credential storage path:
  - Secrets are encrypted with `PROVIDER_SECRET_ENCRYPTION_KEY`.
  - OpenAI Codex auth JSON is parsed to store only the access token and ChatGPT account ID.
  - OpenAI refresh tokens are never stored.
- Keep owner-only binding for subscription credentials so a personal subscription credential cannot be bound to another user's API key.
- Keep the Anthropic kill switch: `SUBSCRIPTION_OAUTH_ENABLED=false` blocks Claude subscription credential creation and forwarding, but does not block OpenAI Codex credentials.
- Treat local import as a same-user/local-host workflow. On shared proxy hosts, local import reads the proxy process user's auth material; operators should use manual paste until hosted per-user OAuth exists.

## Operator Setup

### Codex

1. Run `codex login` on the proxy host as the same OS user that runs Prompt Proxy.
2. Use `codex login --device-auth` when browser callback login is unavailable.
3. Leave auth JSON at `~/.codex/auth.json`, or set `PROMPT_PROXY_CODEX_AUTH_FILE` to a specific auth JSON path.
4. In the console, choose **Codex subscription** and **Import from Codex**.

### Claude Code

1. Run `claude setup-token` while signed into the Claude account that should pay for traffic.
2. Set `CLAUDE_CODE_OAUTH_TOKEN` where the proxy runs and restart the proxy.
3. In the console, choose **Claude subscription** and **Import from Claude Code**.

## Explicit Non-Goals

- No hosted ChatGPT or Claude.ai popup inside Prompt Proxy in V1.
- No refresh-token storage or background refresh loop.
- No per-user server-side credential vault.
- No support for pooling one user's subscription credential across other users' keys.

## Follow-Up: Hosted OAuth V2

A true in-console sign-in flow would require provider-specific OAuth/app-server integration, CSRF/state handling, callback URLs, per-user credential ownership, token refresh, revocation, and hosted deployment policy review. V1 deliberately avoids that blast radius by importing credentials already minted by each provider's official CLI.
