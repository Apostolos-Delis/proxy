# Open Model And Bedrock Production Readiness Review

Date: June 27, 2026

Scope: OMB-021 through OMB-026 cumulative implementation, with OMB-027 as the rollout gate. This review covers the native Bedrock adapter path, OpenAI-compatible OSS provider path, route evidence, usage projection, admin health evidence, smoke coverage, and operational runbooks.

## Decision

Status: ready for controlled staging after the target environment passes live Bedrock validation.

This branch meets the local auditability and fail-closed gates. Production promotion remains blocked until a configured AWS environment runs the live Bedrock tests and `pnpm smoke:bedrock` against the exact provider account, region, model or inference profile, and routing config that will receive traffic.

## Gate Summary

| Gate | Status | Evidence |
| --- | --- | --- |
| Prompt text does not appear in events outside `prompt_artifacts.raw_text` | Pass | Prompt capture event payloads store artifact IDs, storage mode, hashes, token estimates, roles, indexes, and metadata. Routing and provider events store request hashes, model/provider IDs, plan evidence, and usage metadata. |
| AWS secrets do not appear in events, logs, or admin reads | Pass | Bedrock secret-bearing modes store encrypted ciphertext and expose only `secretHint`, credential mode, source category, region, endpoint override, and discovery regions. Credential event metadata contains only credential kind and source category. |
| Bedrock usage is attributable | Pass | `usage_ledger` stores organization, workspace, request, provider attempt, provider, model/profile, route tier, tokens, and cost. `provider_attempts` adds provider account, adapter kind, route candidate, fallback, and attempt indexes. `requests` and `route_decisions` add routing config ID/version/hash. |
| Native, translated, and skipped route evidence is durable | Pass | `routing.plan_recorded` persists the route execution plan with candidates, selected candidate, dialect, translation state, translator, compatibility, eligibility, and skip reasons. |
| Stateful and signed/encrypted provider-state boundaries fail closed | Pass | Previous-response translation, stateful Responses translation to Bedrock, OpenAI encrypted reasoning, and Anthropic signed thinking resolve to unavailable/skip reasons instead of fallback forwarding. |
| Admin health and runbooks cover Bedrock failures | Pass | Provider account and model health summarize Bedrock classifications. Runbooks cover model access, stream permission, quota, throttling, region unavailability, guardrail interventions, and unknown failures. |
| Live Bedrock evidence exists for target environment | External gate | Local tests skip without AWS config. Staging/prod owners must run live validation with configured credentials before promotion. |

## Credential Boundary Review

Bedrock is modeled as the builtin `amazon-bedrock` provider with `adapterKind: "aws-bedrock-converse"` and `authStyle: "aws-sdk"`. Native Bedrock route targets require a provider account. They do not silently inherit generic OpenAI or Anthropic provider-key fallback behavior.

Supported credential modes:

| Mode | Secret handling | Boundary |
| --- | --- | --- |
| `aws_bedrock_bearer_token` | Encrypted provider-account secret | Safe for stored BYOK-style Bedrock bearer tokens. |
| `aws_static_keys` | Encrypted provider-account secret | Access key, secret key, and optional session token are decrypted only for runtime resolution. |
| `aws_default_chain` | No stored secret | Only allowed for the builtin operator-managed Bedrock provider when `BEDROCK_OPERATOR_DEFAULT_CHAIN_ENABLED=true`. |
| `aws_profile` | No stored secret | Local development only when local credential fallback is enabled. |

Boundary checks reviewed:

- Org-defined Bedrock providers cannot use operator default-chain or profile credentials.
- Tenant-supplied credential file paths, web identity token file paths, credential process settings, and assume-role fields are rejected in V1.
- Admin reads select `secretHint` and settings, not `secretCiphertext`.
- Admin audit events include credential mode, region, discovery regions, endpoint override, and secret hint, not plaintext secret material.
- Runtime `provider.request_forwarded` events emit `credentialKind` and `credentialSourceCategory`, not bearer tokens, access keys, secret keys, or session tokens.
- Credential resolver failures are redacted to stable Bedrock error codes before classification.

## Event Payload Review

Durable events reviewed:

| Event | Secret/prompt posture |
| --- | --- |
| `prompt_artifacts.captured` | References artifacts by ID and content hash. Does not embed raw prompt content. |
| `routing.classification_recorded` | Stores classifier model/provider, attempts, usage, confidence, route, reason codes, risk, and routing config snapshot. Does not store classifier input excerpt. |
| `routing.plan_recorded` | Stores route execution evidence and candidate metadata. Provider settings are serialized through route evidence, not credential payloads. |
| `routing.decision_recorded` | Drops `providerSettings` and `routeExecutionPlan`; stores selected route/model/provider, classifier metadata, config snapshot, and sanitized provider attempts. |
| `provider.request_started` | Stores request hash, selected provider/model, adapter kind, provider account ID, route candidate, fallback/attempt indexes, and deployment metadata. |
| `provider.request_forwarded` | Stores prepared and forwarded request hashes, Bedrock operation, model, adapter kind, and redacted credential metadata. |
| Terminal provider events | Store status, upstream status, usage, adapter classification, provider account ID, and sanitized error/category metadata. |

Classifier calls may send a redacted excerpt upstream when classifier settings allow it. That excerpt is not persisted in events. Raw prompt storage remains confined to `prompt_artifacts.raw_text` under the configured prompt-capture policy.

## Route Evidence Review

The route execution plan is the durable audit source for route eligibility:

- Candidate provider, model/profile, endpoint dialect, selected dialect, adapter kind, and route tier.
- Native versus translated status.
- Translator ID when translation is used.
- Compatibility status and compatibility reason.
- Eligibility and skip reasons such as missing credential, previous-response boundary, encrypted reasoning, signed reasoning, health cooldown, model capability mismatch, or Bedrock settings on a non-Bedrock target.
- Selected candidate ID, fallback order, and attempt order.

This is sufficient to explain these cases:

- Native OpenAI or Anthropic passthrough.
- OpenAI-compatible OSS targets through `generic-http-json`.
- OpenAI Chat, OpenAI Responses, or Anthropic Messages translated to Bedrock Converse.
- Bedrock targets skipped before forwarding because credentials, region, capability, statefulness, signed thinking, or encrypted reasoning make the request unsafe.

## Usage And Cost Review

Bedrock runtime usage is projected through the same provider attempt ledger as other providers. Attribution is join-backed:

1. `usage_ledger.organization_id` and `usage_ledger.workspace_id` identify the tenant scope.
2. `usage_ledger.provider_attempt_id` joins to `provider_attempts.id`.
3. `provider_attempts.provider_account_id` identifies the Bedrock provider account.
4. `usage_ledger.provider` and `usage_ledger.model` identify the provider and selected model/profile. For inference-profile routing, the selected profile ID is the model string.
5. `usage_ledger.route` identifies the route tier.
6. `usage_ledger.request_id` joins to `requests` and `route_decisions` for routing config ID, version ID, version number, and config hash.
7. Catalog pricing is looked up by provider/model when terminal provider usage is persisted.

The current usage analytics UI can aggregate by provider/model/route and request/session/user/API key dimensions. Dedicated provider-account or routing-config grouping is not required for correctness because the stored ledger is attributable by join, but it is a reasonable post-V1 admin analytics enhancement if operators need first-class charts for those dimensions.

## Stateful Boundary Review

The fail-closed cases are explicit:

| Boundary | Expected behavior |
| --- | --- |
| OpenAI Responses `previous_response_id` to non-native provider | Target unavailable with `target_unavailable_previous_response_id`; no translated Bedrock forwarding. |
| Stateful OpenAI Responses to Bedrock | Target unavailable with `target_unavailable_stateful_translation`; no silent fallback across provider state. |
| OpenAI encrypted reasoning include to Bedrock | Target unavailable with `target_unavailable_encrypted_reasoning`. |
| Anthropic signed thinking to Bedrock | Target unavailable with `target_unavailable_signed_reasoning`. |
| Bedrock-only settings on non-Bedrock target | Target unavailable with `bedrock_settings_on_non_bedrock_target` evidence. |

Fallback remains allowed only for explicitly configured retryable provider failures. It must not cross request-state boundaries that the compatibility layer marks unavailable.

## Production Rollout Checklist

Complete these before increasing real traffic:

| Item | Gate |
| --- | --- |
| Database migrations applied | `0023_provider_adapter_contract`, `0024_model_catalog_source`, `0025_provider_attempt_adapter_metadata`, and `0026_bedrock_model_catalog_discovery` are applied in the target environment. |
| Secret encryption configured | `PROVIDER_SECRET_ENCRYPTION_KEY` is present before creating encrypted Bedrock bearer-token or static-key credentials. |
| Bedrock operator credential flags set intentionally | `BEDROCK_OPERATOR_DEFAULT_CHAIN_ENABLED` and `BEDROCK_LOCAL_CREDENTIALS_ENABLED` are set only where intended. |
| Provider account created | Active `amazon-bedrock` provider account has credential mode, region, and discovery regions matching the rollout plan. |
| IAM is least-privilege | Runtime identity or stored static key can invoke only the intended Bedrock model/profile and optional guardrail resources; discovery permissions are granted only where catalog refresh is required. |
| Catalog evidence exists | Bedrock model/profile rows exist for the target region and provider account, with source, capabilities, context window, pricing, and discovery timestamp. |
| Routing config validated | Target routes reference an active provider account, model/profile, region, and only Bedrock-compatible settings. |
| Health is clean | Provider account health and provider model health show no active cooldown/lockout for the rollout target. |
| Prompt/secret audit spot-check complete | Recent request events contain hashes and metadata only; provider account admin reads do not expose secret ciphertext or plaintext. |
| Local validation passed | `pnpm lint`, `pnpm typecheck`, `pnpm test`, OSS smoke, and Bedrock smoke command have been run. |
| Live Bedrock validation passed | `pnpm --filter @proxy/proxy exec vitest run test/bedrockLive.test.ts --reporter verbose` and `pnpm smoke:bedrock` pass with `AWS_REGION`, `AWS_BEDROCK_TEST_MODEL`, and credentials configured. |
| Staging canary passed | `pnpm smoke:deployed` and provider-specific canary checks pass in staging before production promotion. |

## Residual Risks

- Live Bedrock validation is environment-dependent and skips by design in unconfigured local or CI environments.
- Native Bedrock V1 is conservative for non-Claude model families. Discovery may list more models than the runtime should route until curated capability metadata marks them supported.
- Bridge mode through LiteLLM or Kong remains useful for evaluation, but Proxy will see those as generic HTTP providers and will not capture native Bedrock auth, region, guardrail, discovery, or health evidence.
- The stored ledger supports provider-account and routing-config attribution by joins; additional admin aggregate views can be added after rollout if operators need them.
