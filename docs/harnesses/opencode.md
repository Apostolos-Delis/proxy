# opencode Setup

opencode can use Proxy through OpenAI Chat, OpenAI Responses, or Anthropic Messages. The hosted setup uses OpenAI Chat because it is the broadest opencode-compatible path.

## Prerequisites

- Proxy is running, for example at `http://127.0.0.1:8787`.
- You have a Proxy API key from the console's API keys page.
- The key's access profile grants a logical model compatible with the chosen inbound wire.

Provider credentials stay on Proxy provider connections. opencode receives only the Proxy API key.

## One-Liner Setup

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness opencode <api-key>
```

The script authenticates `GET /v1/models`, chooses a granted logical model, stores the key at `~/.proxy/opencode.token`, writes every granted model and its display name to the `prompt-chat` provider in `~/.config/opencode/opencode.json`, and stores the credential in `~/.local/share/opencode/auth.json`. Marker files under `~/.proxy/` protect unmarked user-managed entries. Re-run setup after changing the key's grants to replace the installed catalogue.

## Discover Model IDs

```shell
curl -sS http://127.0.0.1:8787/v1/models \
  -H 'Authorization: Bearer <proxy-api-key>'
```

Use one returned logical model ID. The development seed commonly exposes `coding-auto`, `economy-auto`, and `fable`, depending on the key's access profile.

## OpenAI Chat

This path calls `POST /v1/chat/completions`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "prompt-chat": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Proxy Chat",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1"
      },
      "models": {
        "coding-auto": { "name": "Coding Auto" },
        "economy-auto": { "name": "Economy Auto" },
        "fable": { "name": "Fable" }
      }
    }
  },
  "model": "prompt-chat/coding-auto",
  "small_model": "prompt-chat/coding-auto"
}
```

Run `/connect`, select `prompt-chat`, and paste the Proxy API key.

## OpenAI Responses

Use `@ai-sdk/openai` with the same `/v1` base URL when the opencode integration is intended to emit `POST /v1/responses`. The configured model value remains the logical model ID. Stateful Responses requests and WebSocket traffic require an eligible native Responses target.

## Anthropic Messages

Use `@ai-sdk/anthropic` with the same `/v1` base URL when the integration is intended to emit `POST /v1/messages`. The model value is still a granted logical model ID; there is no wire-specific alias namespace.

## Verify

1. Restart opencode after changing provider configuration.
2. Run `/models` and select the configured logical model.
3. Send a small prompt.
4. In Proxy, confirm the expected inbound wire and inspect the resolution evidence.

## Troubleshooting

- `401`: the opencode credential must be the Proxy API key.
- Model not found or denied: select an ID returned by authenticated `GET /v1/models` and re-run setup if the key's grants changed.
- Wrong inbound wire: check the provider package and keep the base URL at `/v1`, not at a concrete operation path.
- Translated target rejected: inspect the recorded compatibility reason; stateful features can require a native target.
