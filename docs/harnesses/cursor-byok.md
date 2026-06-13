# Cursor BYOK Setup

Cursor can use Prompt Proxy through its OpenAI-compatible BYOK path. Cursor sends Chat Completions requests to the proxy, and Prompt Proxy routes them through the selected routing config.

## Prerequisites

- Prompt Proxy is running at a URL Cursor can reach.
- You have a Prompt Proxy API key from the console's API keys page.
- The API key is assigned to a routing config with at least one `openai-chat` target, or an `openai-responses` target that can be served through the Chat to Responses translator.

Cursor BYOK means Cursor uses your Prompt Proxy API key. It does not mean Cursor receives upstream provider keys. If you want requests authenticated with a customer-owned OpenAI or custom-provider key, add that key in Prompt Proxy's Provider keys screen and bind it to the same Prompt Proxy API key.

## Configure Cursor

1. Open Cursor Settings.
2. Go to Models.
3. In API Keys, add or update the OpenAI API key with your Prompt Proxy API key.
4. Enable Override OpenAI Base URL.
5. Set the base URL to:

```text
http://127.0.0.1:8787/v1
```

Use your deployed HTTPS URL instead for shared environments.

6. Add custom models with these exact names:

```text
router-auto
router-fast
router-balanced
router-hard
router-deep
```

7. Select `router-auto` for normal use, or a tier-specific alias when you want to pin the route.

## Verify

1. Open Cursor chat or the BYOK-backed model picker.
2. Select `router-auto`.
3. Send a small prompt.
4. In Prompt Proxy, open Logs and confirm a request with surface `openai-chat`.

## Notes

- Cursor's OpenAI base-URL override is an OpenAI-compatible Chat Completions path. Do not use `claude-router-*` aliases there.
- The override can affect other Cursor model selections that use the same OpenAI-compatible setting. Turn it off when you want Cursor-hosted models to bypass Prompt Proxy.
- If local loopback is blocked in your Cursor environment, expose Prompt Proxy through a trusted HTTPS tunnel or use a deployed proxy URL.
- If you see model-not-found errors, confirm the custom model name is one of the `router-*` aliases and that the assigned routing config has a compatible target.
