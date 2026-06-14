# Claude Code Setup

Claude Code reaches Prompt Proxy through the Anthropic Messages surface at `POST /v1/messages`.

## Prerequisites

- Prompt Proxy is running, for example at `http://127.0.0.1:8787`.
- You have a Prompt Proxy API key from the console's API keys page.
- The routing config assigned to that key has native Anthropic targets or translated OpenAI Chat/Responses targets.

Use the Prompt Proxy API key in Claude Code. Upstream Anthropic or OpenAI keys belong in Prompt Proxy provider credentials, not in the harness, unless you intentionally want to bypass the proxy.

## Environment

```shell
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/v1
export ANTHROPIC_API_KEY=<prompt-proxy-api-key>
```

Use router aliases as the model:

- `claude-router-auto`
- `claude-router-fast`
- `claude-router-balanced`
- `claude-router-hard`
- `claude-router-deep`

`claude-router-auto` runs the classifier. Tier-specific aliases pin the route before provider selection.

## Target Coverage

Claude Code requests are native when a target exposes `anthropic-messages`. They can also route to OpenAI targets through translation:

- OpenAI Chat targets receive Chat Completions requests and return Anthropic Messages-shaped responses/SSE to Claude Code.
- OpenAI Responses targets receive Responses requests and return Anthropic Messages-shaped responses/SSE to Claude Code.

Route decisions include `translated_request:anthropic-messages_to_openai-chat` or `translated_request:anthropic-messages_to_openai-responses` when translation is used.

## Verify

1. Start Prompt Proxy.
2. Run a small Claude Code prompt using one of the router aliases.
3. In Prompt Proxy, open Logs and confirm the request surface is `anthropic-messages`.
4. Check the selected provider/model and route decision guardrail actions.

## Troubleshooting

- `401` or auth errors: `ANTHROPIC_API_KEY` must be the Prompt Proxy API key.
- Request reaches Anthropic directly: confirm `ANTHROPIC_BASE_URL` points to Prompt Proxy and includes `/v1`.
- Target unavailable: check provider enabled state, provider key binding, and whether the target exposes `anthropic-messages`, `openai-chat`, or `openai-responses`.
