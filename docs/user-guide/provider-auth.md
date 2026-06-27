# Provider Auth

Provider auth decides which upstream OpenAI, Anthropic, OpenAI-compatible, or Bedrock credential Proxy uses after routing chooses a provider target.

## Credential Types

| Type | Use when | Stored as |
| --- | --- | --- |
| Environment provider key | You want shared company/provider keys for all traffic | Environment variable or secret reference |
| BYOK provider credential | A customer, teammate, or API key should pay with its own provider key | Encrypted `provider_accounts` material |
| Subscription credential | A developer routes Codex or Claude Code through a personal subscription account | Encrypted provider secret bundle |
| Bedrock credential mode | A route target should call Amazon Bedrock through AWS SDK auth | Encrypted Bedrock secret material or operator AWS default-chain/profile reference |

Provider keys are never returned after creation. API keys are hashed; provider secrets are encrypted or referenced as external secrets.

## Required Encryption Key

Set `PROVIDER_SECRET_ENCRYPTION_KEY` before storing provider credentials in Postgres:

```shell
openssl rand -base64 32
```

The value must be a base64-encoded 32-byte key.

## Add A Provider Credential

1. Open **Model providers**.
2. Choose **Add credential**.
3. Select the provider and credential type.
4. Paste the provider key, complete OAuth, or import a local auth file depending on the type.
5. Name the credential so operators can recognize who owns it.
6. Save it.

Proxy validates supported credential shapes, stores the secret encrypted, records a hint, and tracks health once traffic or probes use the credential.

## Bind Provider Credentials To API Keys

1. Open **API keys**.
2. Select a Proxy API key.
3. Bind an OpenAI and/or Anthropic provider credential.
4. Save the assignment.

On each request, Proxy resolves the API key, chooses the provider target from routing, then uses the bound credential for that provider. For OpenAI, Anthropic, and generic HTTP providers, an unbound key can fall back to the environment provider key for that provider. Bedrock route targets must select an active Bedrock provider account.

## Local OpenAI-Compatible Providers

Private OpenAI-compatible providers can be registered as org-scoped providers with `authStyle: "none"` for local development or with a provider credential for authenticated upstreams. The provider must expose an `openai-chat` endpoint such as `/chat/completions`, and route targets should reference a manual model catalog row for that provider/model.

For local vLLM, Ollama, or LM Studio style servers, set the provider base URL to the upstream root, for example `http://127.0.0.1:8000/v1` or `http://127.0.0.1:11434/v1`. Private loopback URLs require `ALLOWED_PRIVATE_UPSTREAM_CIDRS=127.0.0.0/8`.

Run the no-credential smoke harness with:

```shell
pnpm build:runtime
pnpm smoke:local-openai
```

The smoke starts a local OpenAI-compatible mock, creates an org-scoped provider and manual catalog row, assigns a routing config, and verifies non-streaming and streaming Chat Completions traffic reaches `/chat/completions`.

## Amazon Bedrock Provider Credentials

Bedrock uses the builtin `amazon-bedrock` provider, `authStyle: "aws-sdk"`, and the internal `bedrock-converse` dialect. Route targets must reference an active Bedrock provider account; Proxy does not treat Bedrock as a generic bearer-token HTTP provider.

Create or update Bedrock credentials from **Model providers**:

1. Select `amazon-bedrock`.
2. Choose a credential mode.
3. Set the runtime region, for example `us-east-1`.
4. Set discovery regions, for example `us-east-1, us-west-2`.
5. Optionally set a runtime endpoint override.
6. Save the credential, bind it to the API key, then use the routing config editor to choose the credential/region for Bedrock targets.

Credential modes:

| Mode | Stores a secret? | Use when | Required operator config |
| --- | --- | --- | --- |
| `aws_bedrock_bearer_token` | Yes, encrypted bearer token | You use Bedrock API-key style auth | `PROVIDER_SECRET_ENCRYPTION_KEY` |
| `aws_static_keys` | Yes, encrypted access key, secret key, and optional session token | You need an explicit IAM principal per provider account | `PROVIDER_SECRET_ENCRYPTION_KEY` |
| `aws_default_chain` | No | The builtin `amazon-bedrock` account should use the deployment role, workload identity, environment, or local AWS SDK default chain | `BEDROCK_OPERATOR_DEFAULT_CHAIN_ENABLED=true` |
| `aws_profile` | No | Local development or controlled operator deployments should use `BEDROCK_AWS_PROFILE` or `AWS_PROFILE` | `BEDROCK_LOCAL_CREDENTIALS_ENABLED=true` |

Operator credentials are only allowed for builtin Bedrock provider accounts. Org-defined Bedrock providers cannot inherit deployment AWS credentials.

### Local Bedrock Development

Default chain path:

```shell
export BEDROCK_OPERATOR_DEFAULT_CHAIN_ENABLED=true
export BEDROCK_LOCAL_CREDENTIALS_ENABLED=true
export AWS_REGION=us-east-1
export AWS_PROFILE=bedrock-dev

pnpm build:runtime
AWS_BEDROCK_TEST_MODEL=anthropic.claude-3-5-haiku-20241022-v1:0 pnpm smoke:bedrock
```

Bearer-token path:

```shell
export BEDROCK_LOCAL_CREDENTIALS_ENABLED=true
export AWS_REGION=us-east-1
export AWS_BEARER_TOKEN_BEDROCK=...
export AWS_BEDROCK_TEST_MODEL=anthropic.claude-3-5-haiku-20241022-v1:0

pnpm --filter @proxy/proxy exec vitest run test/bedrockLive.test.ts
```

For normal routed traffic, prefer creating a Bedrock provider account with `aws_bedrock_bearer_token` and storing the token through the admin flow instead of relying on `AWS_BEARER_TOKEN_BEDROCK`.

### Least-Privilege IAM Examples

Runtime-only role for direct foundation-model invocation:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-haiku-20241022-v1:0"
      ]
    }
  ]
}
```

Add inference-profile and guardrail permissions only when routes use them:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:GetInferenceProfile"
      ],
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/*",
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/*",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:GetGuardrail",
        "bedrock:ApplyGuardrail"
      ],
      "Resource": [
        "arn:aws:bedrock:us-east-1:123456789012:guardrail/*"
      ]
    }
  ]
}
```

Discovery role for importing region/account-specific catalog data:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:ListFoundationModels",
        "bedrock:GetFoundationModel",
        "bedrock:ListInferenceProfiles",
        "bedrock:GetInferenceProfile"
      ],
      "Resource": "*"
    }
  ]
}
```

Keep discovery permissions separate from runtime invocation when possible. Runtime traffic needs `InvokeModel`; streaming traffic also needs `InvokeModelWithResponseStream`; inference profiles need `GetInferenceProfile`; guardrail-enabled routes need `GetGuardrail` and `ApplyGuardrail`.

### Bedrock Route Controls

Bedrock targets expose Bedrock-only controls in the routing editor:

- Credential / region selects the provider account and runtime region.
- Inference profile and profile geography control cross-region/profile model IDs.
- Service tier maps to Bedrock performance configuration.
- Guardrail ID and version map to Bedrock guardrail config.
- Request metadata template sends string-valued Bedrock request metadata.

These settings live in route-target metadata and are only applied to `amazon-bedrock` targets.

### LiteLLM And Kong Bridge Mode

LiteLLM or Kong can front Bedrock and expose an OpenAI-compatible endpoint. Register that bridge as a generic OpenAI-compatible provider, add manual model catalog rows, and use the local OpenAI-compatible provider workflow.

Bridge mode is for spikes or customer-specific evaluation. Proxy will see the bridge as generic HTTP, not as native Bedrock, so Bedrock credential source, discovery, inference profile, guardrail, region, and Bedrock-specific health evidence remain outside Proxy.

## Live Bedrock Integration Test

The Bedrock live test is skipped unless a workstation or CI job explicitly provides AWS access:

```shell
AWS_REGION=us-east-1 \
AWS_BEDROCK_TEST_MODEL=anthropic.claude-3-5-haiku-20241022-v1:0 \
pnpm --filter @proxy/proxy exec vitest run test/bedrockLive.test.ts
```

The test uses the AWS SDK default chain or `AWS_BEARER_TOKEN_BEDROCK` from the local environment, covers `Converse` and `ConverseStream`, and never runs by default. Set `AWS_BEDROCK_TEST_TOOL_MODEL` to also verify forced tool use for a model that supports tools.

## Subscription Auth

Subscription credentials are useful when an engineer wants Codex or Claude Code traffic to use their own provider subscription instead of a shared company API key.

OpenAI Codex subscription options:

- Sign in with OpenAI.
- Import local `~/.codex/auth.json`.
- Paste a Codex token or auth JSON.

Anthropic Claude subscription options:

- Sign in with Claude.
- Paste a `claude setup-token` value.

Detailed guardrails and fallback behavior are in the [subscription auth runbook](../runbooks/subscription-auth.md).

## Provider Health

Provider account health appears in the console after failures, probes, cooldowns, or successful traffic. Use it to answer:

- Is a provider account active, cooling down, locked out, or revoked?
- Which model failed?
- Was the failure auth, rate limit, model availability, network, or protocol related?
- Is Proxy skipping a candidate because a credential is unhealthy?

See [provider account health](../runbooks/provider-account-health.md) for the operational model.

## Security Notes

- Do not paste provider keys into routing configs, docs, or event payloads.
- Do not give a user-owned subscription credential to another user's API key; Proxy enforces owner binding for subscription credentials.
- Rotate or revoke upstream provider credentials at the provider first, then revoke or replace the Proxy credential.
- In production, configure real company provider keys even if most traffic uses BYOK; fallback paths depend on them.
