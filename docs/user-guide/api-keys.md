# API Keys And Harness Setup

Proxy API keys authenticate client traffic and attach requests to an organization, workspace, user, routing config, and optional provider credential bindings.

## What A Proxy API Key Controls

A key can carry:

- Owner/user attribution.
- Workspace scope.
- Routing config assignment.
- Provider credential bindings for BYOK or subscription traffic.
- Setup snippets for one or more harnesses.

The raw key is shown only once when created. Proxy stores a hash, not the plaintext key.

## Create A Key

1. Open the console.
2. Go to **API keys**.
3. Choose **Create key**.
4. Name the key after the person, service, or harness that will use it.
5. Pick the target workspace and routing config.
6. Select the harnesses you want setup snippets for.
7. Create the key and copy the generated secret immediately.

Use separate keys when you want different routing configs, attribution, provider bindings, or revocation boundaries.

## Use The Hosted Setup Script

The proxy hosts an idempotent setup script that writes only Proxy-owned marker blocks.

Configure all supported local harnesses with one key:

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- <proxy-api-key>
```

Configure a single harness:

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness codex <proxy-api-key>
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness claude-code <proxy-api-key>
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness opencode <proxy-api-key>
```

Configure a selected set:

```shell
curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness claude-code --harness codex <proxy-api-key>
```

By default, shared setup stores the key at `~/.proxy/token`. Harness-specific setup stores keys such as `~/.proxy/codex.token` and `~/.proxy/claude-code.token`.

## Manual Codex Setup

In `~/.codex/config.toml`:

```toml
# >>> proxy codex defaults >>>
model = "router-auto"
model_provider = "proxy"
# <<< proxy codex defaults <<<

# >>> proxy codex provider proxy >>>
[model_providers.proxy]
name = "Proxy"
base_url = "http://127.0.0.1:8787/v1"
env_key = "PROXY_TOKEN"
wire_api = "responses"
supports_websockets = true
# <<< proxy codex provider proxy <<<
```

In your shell profile:

```shell
export PROXY_TOKEN="$(cat ~/.proxy/token)"
```

## Manual Claude Code Setup

In `~/.claude/settings.json`:

```json
{
  "model": "claude-router-auto",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  },
  "apiKeyHelper": "cat ~/.proxy/token"
}
```

Claude Code strips `ANTHROPIC_BASE_URL` from project settings, so use user-level or managed settings.

## Manual opencode Setup

Use the generated snippets from the API-key wizard when possible. The full manual reference is [opencode setup](../harnesses/opencode.md).

## Manual Cursor BYOK Setup

Cursor uses an OpenAI-compatible base URL. Use the generated snippets when possible, or follow [Cursor BYOK setup](../harnesses/cursor-byok.md).

## Assign Routing Configs

Routing config precedence is:

1. API key assignment.
2. Workspace default.
3. Seeded default.

Use API-key assignment for controlled experiments, team-specific policy, or a key that should pin a provider/model tier map.

## Revoke Or Rotate A Key

1. Open **API keys**.
2. Find the key.
3. Revoke it.
4. Create a replacement key.
5. Re-run the hosted setup script for affected harnesses.

Revocation takes effect at Proxy auth. Existing upstream requests already on the wire can still complete.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Client gets 401 | Wrong key, revoked key, missing `PROXY_TOKEN`, or using provider key instead of Proxy key |
| Request appears under wrong user | Key owner/attribution or harness identity headers |
| Request uses unexpected model | API-key routing config assignment and model alias |
| Setup script reports conflicts | Existing unmarked config blocks; inspect the reported file before rerunning |
