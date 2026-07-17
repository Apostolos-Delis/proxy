# API Keys And Harness Setup

Proxy API keys authenticate gateway traffic and bind a caller to one organization, workspace, optional user, and access profile. Keys are stored as hashes and the plaintext secret is returned only when the key is created.

## Access Profiles

An access profile is a reusable entitlement set. Its model grants define:

- which logical models the key may request;
- which operations are allowed, such as `text.generate` or `model.list`;
- optional output-token parameter caps;
- optional concurrent-request, request-rate, and token-rate limits.

The seeded profiles demonstrate the intended split:

| Profile | Intended caller | Initial logical models |
| --- | --- | --- |
| `opendoor-engineer` | Trusted internal engineers and services | `fable`, `coding-auto`, `economy-auto` |
| `external-economy` | External or lower-trust harnesses | `economy-auto` |

Access profiles grant logical models, not provider models or credentials. Physical deployments can change without reissuing keys.

## Create A Key

1. Open **API keys**.
2. Select **Create key**.
3. Enter a descriptive application, environment, or harness name.
4. Choose the access profile.
5. Choose the harnesses whose setup instructions should be shown.
6. Create the key and store the secret immediately.

The console derives a recommended setup model from the profile's enabled grants. It cannot create a key with a disabled profile or a profile that has no usable generate/list grant.

GraphQL callers must also supply the profile:

```graphql
mutation {
  createApiKey(input: {
    name: "payments-production"
    accessProfileId: "workspace:access-profile:service-default"
  }) {
    apiKey { id name accessProfileId }
    secret
  }
}
```

## Application SDKs

OpenAI SDKs use the `/v1` base URL and bearer authentication:

```ts
const client = new OpenAI({
  baseURL: "https://proxy.example.com/v1",
  apiKey: process.env.PROXY_API_KEY
});

await client.responses.create({
  model: "coding-auto",
  input: "Summarize the ticket."
});
```

Anthropic SDKs use the gateway origin and the same Proxy secret:

```ts
const client = new Anthropic({
  baseURL: "https://proxy.example.com",
  apiKey: process.env.PROXY_API_KEY
});

await client.messages.create({
  model: "fable",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Review the change." }]
});
```

Check `GET /v1/models` with the key before deployment. It is the authoritative caller-visible logical-model list.

## Hosted Harness Setup

Configure Claude Code, Codex, and opencode with one command:

```shell
curl -fsSL https://proxy.example.com/setup.sh | bash -s -- <proxy-api-key>
```

Select one or more harnesses:

```shell
curl -fsSL https://proxy.example.com/setup.sh | bash -s -- --harness codex <key>
curl -fsSL https://proxy.example.com/setup.sh | bash -s -- --harness claude-code --harness opencode <key>
```

The script stores the key with mode `0600`, updates only Proxy-owned marker blocks, and reports conflicts with user-managed settings instead of overwriting them.

It also reads the key-filtered model list: Codex and opencode receive the complete granted catalogue, while Claude Code receives the selected default as a named custom model option. Re-run setup after changing the key's grants to refresh those local entries.

Use separate keys when harnesses need different profiles, attribution, rate limits, environments, or revocation boundaries.

## Manual Claude Code Setup

Merge into `~/.claude/settings.json`:

```json
{
  "model": "economy-auto",
  "env": {
    "ANTHROPIC_BASE_URL": "https://proxy.example.com",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  },
  "apiKeyHelper": "cat ~/.proxy/claude-code.token"
}
```

`ANTHROPIC_BASE_URL` must be user-level or managed Claude Code settings. The model must be granted to the key.

## Manual Codex Setup

Store the key in an environment variable, then configure `~/.codex/config.toml`:

```toml
model = "coding-auto"
model_provider = "proxy"

[model_providers.proxy]
name = "Proxy"
base_url = "https://proxy.example.com/v1"
env_key = "PROXY_API_KEY"
wire_api = "responses"
supports_websockets = false
```

WebSockets stay disabled in the general setup because automatic logical models can select a non-Responses-native deployment. HTTP supports the registered compatibility translations; WebSocket traffic is native-wire only.

## Change A Key's Profile

Use the profile menu on the API-key table or GraphQL:

```graphql
mutation {
  assignGatewayApiKeyAccessProfile(
    apiKeyId: "api_key_123"
    accessProfileId: "workspace:access-profile:external-economy"
  ) {
    apiKeyId
    accessProfileId
  }
}
```

The new catalog and authorization take effect on the next request. This operation is audited.

## Revoke Or Replace A Key

Keys are not recoverable or rotated in place:

1. Create a replacement key with the intended access profile.
2. Deploy it to the caller.
3. Verify `lastUsedAt` on the replacement.
4. Revoke the old key.

A revoked key fails authentication immediately. Never paste plaintext keys into events, prompts, configuration TOML, or issue text.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Key is unauthorized | Secret value, revoked state, workspace, auth header |
| Model missing from discovery | Profile, enabled grant, `model.list`, logical-model status |
| Generate request denied | `text.generate` grant and parameter caps |
| Unexpected physical model | Logical-model targets and resolution evidence, not key configuration |
| Harness uses wrong model | Harness config and the profile's granted logical-model slugs |
| Codex WebSocket failure | Keep `supports_websockets = false` unless the logical model is native Responses-only |

See the [gateway control-plane runbook](../runbooks/gateway-control-plane.md) to create or change profiles and grants.
