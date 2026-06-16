# Subscription Local Auth Import V1

## Goal

Make subscription credentials usable without asking users to reverse-engineer token fields. The console should guide an engineer through provider-owned auth setup, then bind the resulting subscription credential to proxy API keys.

## V1 Behavior

- Add a provider credential source selector for subscription credentials:
  - **Sign in with OpenAI** starts the Codex device-code flow and stores the resulting ChatGPT subscription tokens.
  - **Import from Codex** reads Codex auth JSON from `PROMPT_PROXY_CODEX_AUTH_FILE`, `CODEX_HOME/auth.json`, or `~/.codex/auth.json`.
  - **Import from Claude Code** reads `CLAUDE_CODE_OAUTH_TOKEN` from the proxy process environment.
  - Manual paste remains as a fallback for both providers.
- Store subscription credentials through the existing provider credential storage path:
  - Secrets are encrypted with `PROVIDER_SECRET_ENCRYPTION_KEY`.
  - OpenAI Codex device auth and auth JSON imports store the access token and refresh token inside an encrypted token bundle.
  - OpenAI token bundles refresh during credential resolution before forwarding traffic.
  - Manual OpenAI token paste remains access-token-only and cannot refresh itself.
- Keep owner-only binding for subscription credentials so a personal subscription credential cannot be bound to another user's API key.
- Keep the Anthropic kill switch: `SUBSCRIPTION_OAUTH_ENABLED=false` blocks Claude subscription credential creation and forwarding, but does not block OpenAI Codex credentials.
- Treat local import as a same-user/local-host workflow. On shared proxy hosts, local import reads the proxy process user's auth material; operators should use manual paste until hosted per-user OAuth exists.

## Operator Setup

### Codex

1. In the console, choose **Codex subscription** and **Sign in with OpenAI**.
2. Open the device sign-in link, enter the one-time code, and finish OpenAI auth.
3. Prompt Proxy stores the encrypted ChatGPT token bundle and advances the API key wizard to provider binding.
4. If hosted device auth is unavailable, run `codex login` on the proxy host and choose **Import from Codex**.
5. Leave auth JSON at `~/.codex/auth.json`, or set `PROMPT_PROXY_CODEX_AUTH_FILE` to a specific auth JSON path.

### Claude Code

1. Run `claude setup-token` while signed into the Claude account that should pay for traffic.
2. Set `CLAUDE_CODE_OAUTH_TOKEN` where the proxy runs and restart the proxy.
3. In the console, choose **Claude subscription** and **Import from Claude Code**.

## Explicit Non-Goals

- No hosted Claude.ai popup inside Prompt Proxy in V1.
- No generic OAuth provider framework; OpenAI support follows Codex's provider-specific device-code flow.
- No per-user server-side credential vault.
- No support for pooling one user's subscription credential across other users' keys.

## Follow-Up: Hosted OAuth Expansion

OpenAI V1 uses device auth because it does not require a hosted callback URL and works when the proxy is not running on the user's laptop. A fuller hosted OAuth expansion would still need provider-specific callback handling, CSRF/state validation, revocation, per-user vault policy, and provider approval for each subscription provider.
