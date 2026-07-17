# Claude Code Setup

Claude Code reaches Proxy through the Anthropic Messages surface at `POST /v1/messages`.

## Prerequisites

- Proxy is running, for example at `http://127.0.0.1:8787`.
- You have a Proxy API key from the console's API keys page.
- The key's access profile grants a logical model with an Anthropic-native or translatable target.

Use the Proxy API key in Claude Code. Provider credentials stay on provider connections inside Proxy.

## One-Liner Setup

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness claude-code <api-key>
```

The script authenticates `GET /v1/models`, chooses a granted logical model, stores the key at `~/.proxy/claude-code.token`, and points `~/.claude/settings.json` at Proxy. It also registers that default with its catalogue display name and description as Claude Code's custom model option. It tracks the fields it owns in `~/.proxy/claude-code-settings.marker.json` and leaves unmarked user-managed values unchanged.

Pass `--harness` more than once to share one Proxy API key across local harnesses.

Claude Code filters gateway-discovered model IDs to names beginning with `claude` or `anthropic`. Provider-neutral Proxy IDs such as `coding-auto` remain available through the configured custom model option and `--model`, but Claude Code cannot display the complete granted catalogue. Re-run setup after changing the key's grants to refresh the selected model metadata.

## Manual Setup

First list the models granted to the key:

```shell
curl -sS http://127.0.0.1:8787/v1/models \
  -H 'Authorization: Bearer <proxy-api-key>'
```

Then configure one returned logical model, such as `coding-auto` or `economy-auto`:

```shell
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=<proxy-api-key>
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model coding-auto
```

`coding-auto` and `economy-auto` are classifier-backed logical models in the development seed. `fable` is a direct logical model. The API key's access profile determines which IDs are visible and usable.

## Target Coverage

Claude Code requests are native when the selected target exposes `anthropic-messages`. Proxy can also translate them to targets exposing `openai-chat` or `openai-responses`. Resolution fails before provider spend when no eligible target can safely serve the request features.

The request inspector records the requested and resolved logical model, selected target and deployment, provider connection, wire binding, translator, and fallback evidence.

## Verify

1. Run `GET /v1/models` with the same API key and confirm the configured logical model is present.
2. Send a small Claude Code prompt.
3. In Proxy, open Requests and confirm the inbound wire is `anthropic-messages`.
4. Check the resolution evidence and terminal provider attempt.

## Troubleshooting

- `401`: `ANTHROPIC_API_KEY` must be the Proxy API key.
- Model not found or denied: use an ID returned by authenticated `GET /v1/models` and check the key's access profile.
- Updated grant missing from the custom option: re-run the hosted setup command.
- Request reaches Anthropic directly: confirm `ANTHROPIC_BASE_URL` points to Proxy.
- No compatible target: check the logical model targets, deployment status, wire bindings, connection health, and translator support.
