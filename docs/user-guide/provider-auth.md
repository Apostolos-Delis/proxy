# Provider Connections And Credentials

Provider connections are the gateway's physical endpoint and credential boundary. Applications never supply provider credentials and Proxy API keys never bind directly to them.

## Supported Connection Types

| Adapter kind | Auth styles | Typical use |
| --- | --- | --- |
| `generic-http-json` | `bearer`, `x-api-key`, `none` | OpenAI, Anthropic, and compatible HTTP APIs |
| `aws-bedrock-converse` | `aws-sdk` | Bedrock Converse and ConverseStream |

The connection also stores base URL, optional region, safe default headers, adapter configuration, status, and either a secret reference or encrypted credential material.

## Credential Storage

Use one of two forms:

- `secretRef` for a deployment-resolved secret such as `env:OPENAI_API_KEY`;
- `secret` on an admin mutation, which Proxy encrypts before persistence.

Admin reads return `credentialConfigured`, `secretRef`, and a safe hint. They never return the raw or decrypted value. Set `PROVIDER_SECRET_ENCRYPTION_KEY` to a base64-encoded 32-byte key before storing encrypted material:

```shell
openssl rand -base64 32
```

Raw secrets are rejected in gateway TOML. Declarative configuration accepts `secret_ref` only.

## Origin-Bound Environment References

The stock resolver recognizes `env:OPENAI_API_KEY` for the configured OpenAI origin and `env:ANTHROPIC_API_KEY` for the configured Anthropic origin.

For a custom variable, configure the secret and an exact origin allowlist:

```shell
ACME_LLM_KEY=...
ACME_LLM_KEY_ALLOWED_ORIGINS=https://llm.acme.internal,https://llm-backup.acme.internal
```

Then use `secret_ref = "env:ACME_LLM_KEY"`. Planning and runtime resolution reject a missing variable, an invalid URL, or an origin mismatch. This prevents a valid secret reference from being redirected to an arbitrary endpoint.

## Create An HTTP Connection

```graphql
mutation {
  createGatewayProviderConnection(input: {
    slug: "openai-production"
    name: "OpenAI Production"
    adapterKind: "generic-http-json"
    authStyle: "bearer"
    baseUrl: "https://api.openai.com/v1"
    secretRef: "env:OPENAI_API_KEY"
    adapterConfig: {}
    defaultHeaders: {}
    enabled: true
  }) {
    id
    slug
    credentialConfigured
    status
  }
}
```

For Anthropic, use `authStyle: "x-api-key"`. Use `none` only for explicitly trusted, unauthenticated endpoints. Private upstream IP ranges are denied unless allowed through `ALLOWED_PRIVATE_UPSTREAM_CIDRS`.

After the connection exists, create a deployment and at least one wire binding. A connection alone is not caller-visible.

## Rotate Or Clear A Credential

Update an encrypted secret:

```graphql
mutation {
  updateGatewayProviderConnection(input: {
    id: "workspace:connection:openai"
    secret: "<new-secret>"
  }) {
    id
    credentialConfigured
    secretHint
  }
}
```

Setting a new `secret` or `secretRef` replaces the previous credential form. Use `clearSecret: true` to remove it. Omit all credential fields to preserve the existing credential.

Rotate the external secret first when a secret reference remains stable. Send a controlled request after rotation and confirm connection health returns to `healthy`.

## Bedrock

Bedrock connections use `adapterKind: "aws-bedrock-converse"`, `authStyle: "aws-sdk"`, and an explicit region. The seeded connection uses the AWS default credential chain. Production deployments must deliberately enable the required credential mode and IAM permissions.

Key checks:

1. The connection region and deployment region agree with the model or inference profile.
2. The deployment uses the exact Bedrock model or inference-profile ID.
3. The deployment has a `bedrock-converse` binding.
4. IAM permits both Converse and ConverseStream when streaming traffic is enabled.
5. Cross-region inference profiles are granted in every required region.

`BEDROCK_OPERATOR_DEFAULT_CHAIN_ENABLED` gates operator-chain use. `BEDROCK_LOCAL_CREDENTIALS_ENABLED` and `BEDROCK_AWS_PROFILE` are local-development controls and should not become implicit production credential paths.

A non-streaming success does not clear a stream-permission lockout. Verify with a streaming request.

## Custom OpenAI-Compatible Endpoints

Use `generic-http-json` and bind the deployment to the actual native wire:

- `openai-responses` with an endpoint such as `/responses`;
- `openai-chat` with an endpoint such as `/chat/completions`.

Do not claim an Anthropic or Responses binding merely because a server accepts JSON. Wire bindings are executable protocol contracts, including streaming and error semantics.

## Caller Access Is Separate

Provider connections do not grant caller access. The full path is:

```text
API key -> access profile -> model grant -> logical model -> target -> deployment -> connection
```

To restrict external users to cheaper supply, grant only `economy-auto` to their access profile. Do not create separate copies of provider credentials per caller and do not put caller authorization inside connection configuration.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `credentialConfigured` is false | `secretRef`, encrypted secret, encryption key |
| Secret reference fails | Environment variable, allowed origins, exact connection origin |
| 401 or invalid auth | Auth style, header rendering, secret value, provider connection status upstream |
| Connection cooldown | Rate limit, quota, provider availability, retry deadline |
| Deployment locked out | Exact model access, region, wire, Bedrock IAM |
| Custom endpoint denied | URL normalization and `ALLOWED_PRIVATE_UPSTREAM_CIDRS` |
| Model absent for caller | Access profile and logical-model grant, not provider credentials |

See [provider health](../runbooks/provider-health.md) and the [gateway control-plane runbook](../runbooks/gateway-control-plane.md).
