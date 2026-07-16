# Cursor BYOK Setup

Cursor can use Proxy through its OpenAI-compatible BYOK path. Cursor sends Chat Completions requests to `POST /v1/chat/completions`; Proxy resolves the requested logical model to an eligible physical deployment.

## Prerequisites

- Proxy is running at a URL Cursor can reach.
- You have a Proxy API key from the console's API keys page.
- The key's access profile grants a logical model with an eligible Chat-native or translatable target.

Cursor receives the Proxy API key, never an upstream provider credential.

## Configure Cursor

1. Query authenticated `GET /v1/models` and note the logical model IDs available to this key.
2. Open Cursor Settings, then Models.
3. Set the OpenAI API key to the Proxy API key.
4. Enable **Override OpenAI Base URL**.
5. Set the base URL to `http://127.0.0.1:8787/v1`, or the deployed HTTPS equivalent.
6. Add the desired returned model ID as a custom model, for example `coding-auto`.
7. Select that model and send a small prompt.

## Verify

In Proxy, confirm the request has inbound wire `openai-chat`, then inspect the resolved logical model, target, deployment, connection, translation path, and provider attempt.

## Notes

- The OpenAI base URL override can affect other Cursor model selections that share that setting. Disable it when those requests should bypass Proxy.
- If loopback is unavailable to Cursor, use a trusted HTTPS endpoint.
- A model ID is authorized only when it appears in `GET /v1/models` for the same API key.
- Translation is request-dependent. A target that cannot preserve the request's features is skipped and recorded in resolution evidence.
