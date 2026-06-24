# Provider Auth

Provider auth decides which upstream OpenAI or Anthropic credential Proxy uses after routing chooses a provider target.

## Credential Types

| Type | Use when | Stored as |
| --- | --- | --- |
| Environment provider key | You want shared company/provider keys for all traffic | Environment variable or secret reference |
| BYOK provider credential | A customer, teammate, or API key should pay with its own provider key | Encrypted `provider_accounts` material |
| Subscription credential | A developer routes Codex or Claude Code through a personal subscription account | Encrypted provider secret bundle |

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

On each request, Proxy resolves the API key, chooses the provider target from routing, then uses the bound credential for that provider. If no credential is bound, Proxy falls back to the environment provider key for that provider.

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
