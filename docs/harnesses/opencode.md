# opencode Setup

opencode can reach Prompt Proxy through three supported wire paths. Use the chat-compatible path for new setups; the Responses and Anthropic paths are available when you deliberately want those dialects.

## Prerequisites

- Prompt Proxy is running, for example at `http://127.0.0.1:8787`.
- You have a Prompt Proxy API key from the console's API keys page.
- The routing config assigned to that API key has targets compatible with the path you choose.

Use the Prompt Proxy API key in opencode. Do not put your upstream OpenAI, Anthropic, or custom-provider key directly in opencode unless you intentionally want to bypass the proxy. Upstream BYOK belongs in the Prompt Proxy console under Model providers, then gets bound to the Prompt Proxy API key.

## One-Liner Setup

For the default OpenAI-compatible Chat path, the hosted setup script can configure opencode globally:

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness opencode <api-key>
```

It stores a copy of the key at `~/.prompt-proxy/opencode.token`, writes the `prompt-proxy-chat` provider to `~/.config/opencode/opencode.json`, and stores the credential in `~/.local/share/opencode/auth.json`. Create a separate Prompt Proxy API key for opencode when you want opencode to use a different routing config than Claude Code or Codex.
Pass `--harness` more than once when opencode should share one Prompt Proxy API key with another local harness.

## Model IDs

For OpenAI-compatible paths, use:

- `router-auto`
- `router-fast`
- `router-balanced`
- `router-hard`
- `router-deep`

For the Anthropic Messages path, use:

- `claude-router-auto`
- `claude-router-fast`
- `claude-router-balanced`
- `claude-router-hard`
- `claude-router-deep`

`router-auto` and `claude-router-auto` run the classifier. The tier-specific aliases pin the route before provider selection.

## Key Setup

If you do not use the setup script, run `/connect` in opencode, add a custom provider credential whose provider ID matches the `provider` key from the config you choose below, and paste the Prompt Proxy API key.

The examples use these provider IDs:

- `prompt-proxy-chat`
- `prompt-proxy-responses`
- `prompt-proxy-anthropic`

If you use a different ID, update both the `/connect` credential and the `model` / `small_model` prefixes.

## Path 1: OpenAI-Compatible Chat

This is the default path for opencode and other OpenAI-compatible clients. It calls Prompt Proxy at `POST /v1/chat/completions`.

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "prompt-proxy-chat": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Prompt Proxy Chat",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1"
      },
      "models": {
        "router-auto": { "name": "Router Auto" },
        "router-fast": { "name": "Router Fast" },
        "router-balanced": { "name": "Router Balanced" },
        "router-hard": { "name": "Router Hard" },
        "router-deep": { "name": "Router Deep" }
      }
    }
  },
  "model": "prompt-proxy-chat/router-auto",
  "small_model": "prompt-proxy-chat/router-fast"
}
```

Use this path for OSS or hosted OpenAI-compatible chat providers such as vLLM, Ollama, llama.cpp, Groq, Fireworks, Together, OpenRouter, and plain OpenAI Chat Completions targets. Responses-capable and Anthropic Messages targets can also serve this path through translation.

## Path 2: OpenAI Responses

Use this path when your opencode setup is intentionally using an OpenAI provider adapter that sends Responses API requests. It calls Prompt Proxy at `POST /v1/responses`.

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "prompt-proxy-responses": {
      "npm": "@ai-sdk/openai",
      "name": "Prompt Proxy Responses",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1"
      },
      "models": {
        "router-auto": { "name": "Router Auto" },
        "router-fast": { "name": "Router Fast" },
        "router-balanced": { "name": "Router Balanced" },
        "router-hard": { "name": "Router Hard" },
        "router-deep": { "name": "Router Deep" }
      }
    }
  },
  "model": "prompt-proxy-responses/router-auto",
  "small_model": "prompt-proxy-responses/router-fast"
}
```

This path can target native Responses endpoints. It can also target chat-only providers and Anthropic Messages providers through translation. Codex WebSocket traffic and Responses requests with `previous_response_id` remain pinned to native Responses endpoints.

## Path 3: Anthropic Messages

Use this path when opencode is configured through an Anthropic provider adapter. It calls Prompt Proxy at `POST /v1/messages`.

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "prompt-proxy-anthropic": {
      "npm": "@ai-sdk/anthropic",
      "name": "Prompt Proxy Anthropic",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1"
      },
      "models": {
        "claude-router-auto": { "name": "Claude Router Auto" },
        "claude-router-fast": { "name": "Claude Router Fast" },
        "claude-router-balanced": { "name": "Claude Router Balanced" },
        "claude-router-hard": { "name": "Claude Router Hard" },
        "claude-router-deep": { "name": "Claude Router Deep" }
      }
    }
  },
  "model": "prompt-proxy-anthropic/claude-router-auto",
  "small_model": "prompt-proxy-anthropic/claude-router-fast"
}
```

This path can target native Anthropic Messages endpoints, including custom provider rows that expose the `anthropic-messages` dialect. It can also target OpenAI Chat or OpenAI Responses providers through translation.

## Verify

1. Restart opencode after changing provider config.
2. Run `/models` and confirm the provider and aliases appear.
3. Send a small prompt.
4. In Prompt Proxy, open Logs and confirm the request surface:
   - Path 1: `openai-chat`
   - Path 2: `openai-responses`
   - Path 3: `anthropic-messages`

## Troubleshooting

- `401` or auth errors: the opencode provider credential must be the Prompt Proxy API key, not an upstream provider key.
- Model not found: the model ID in opencode must exactly match one of the configured aliases.
- Request reaches the wrong surface: check the provider package and base URL. The base URL should end at `/v1`, not `/v1/chat/completions`, `/v1/responses`, or `/v1/messages`.
- Translated target skipped for a Responses request: Codex WebSocket traffic and requests with `previous_response_id` require a native Responses endpoint.
