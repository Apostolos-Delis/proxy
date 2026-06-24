# AWS Deployment Runbook

This runbook deploys Proxy to the CDK-managed AWS environment described in `docs/scopes/aws-prod-like-deployment-v1/PLAN.md`.

## Prerequisites

- AWS credentials for account `459063349068`.
- Region `us-east-1`.
- `pnpm install` has completed.
- Docker is available when building the proxy image locally.
- Provider keys are available locally or in your secret manager.
- Optional: current public IPv4/IPv6 CIDRs if you intentionally want to make `/admin/*` private behind a temporary WAF allowlist. Leave this blank for public app-authenticated staging.

```shell
export PROXY_DEPLOY_ENV=staging
export AWS_REGION=us-east-1
export ADMIN_ALLOWED_CIDR=""
export IMAGE_TAG="$(git rev-parse --short HEAD)"
```

To force private admin access for an internal-only environment, set `ADMIN_ALLOWED_CIDR` explicitly:

```shell
export ADMIN_ALLOWED_CIDR="$(curl -fsS4 https://checkip.amazonaws.com)/32"
export ADMIN_ALLOWED_IPV6="$(curl -fsS6 https://api64.ipify.org || true)"
if [ -n "$ADMIN_ALLOWED_IPV6" ]; then
  export ADMIN_ALLOWED_CIDR="${ADMIN_ALLOWED_CIDR},${ADMIN_ALLOWED_IPV6}/128"
fi
```

## First Bootstrap

Deploy the foundation stack first. This creates ECR and the GitHub Actions deploy role. The GitHub workflow expects this stack to exist.

```shell
pnpm --filter @proxy/infra-cdk cdk deploy \
  --require-approval never \
  "proxy-${PROXY_DEPLOY_ENV}-foundation"
```

Build and push the proxy image.

```shell
export PROXY_REPOSITORY_URI="$(aws ecr describe-repositories \
  --repository-names "proxy-${PROXY_DEPLOY_ENV}" \
  --query 'repositories[0].repositoryUri' \
  --output text)"

aws ecr get-login-password | docker login \
  --username AWS \
  --password-stdin "${PROXY_REPOSITORY_URI%/*}"

docker buildx build \
  --platform linux/arm64 \
  --tag "${PROXY_REPOSITORY_URI}:${IMAGE_TAG}" \
  --push \
  .
```

ECR image tags are immutable. If this tag already exists, either reuse it by skipping the build/push step or set a new `IMAGE_TAG`.

Deploy base infrastructure and runtime secret containers.

```shell
pnpm --filter @proxy/infra-cdk cdk deploy \
  --require-approval never \
  -c "runtimeImageTag=${IMAGE_TAG}" \
  -c "${PROXY_DEPLOY_ENV}AdminAllowedCidrs=${ADMIN_ALLOWED_CIDR}" \
  "proxy-${PROXY_DEPLOY_ENV}-network" \
  "proxy-${PROXY_DEPLOY_ENV}-database" \
  "proxy-${PROXY_DEPLOY_ENV}-runtime-secrets" \
  "proxy-${PROXY_DEPLOY_ENV}-operations" \
  "proxy-${PROXY_DEPLOY_ENV}-web"
```

Populate provider secrets before starting the service.

```shell
aws secretsmanager put-secret-value \
  --secret-id "proxy-${PROXY_DEPLOY_ENV}-openai-api-key" \
  --secret-string "$OPENAI_API_KEY"

aws secretsmanager put-secret-value \
  --secret-id "proxy-${PROXY_DEPLOY_ENV}-anthropic-api-key" \
  --secret-string "$ANTHROPIC_API_KEY"
```

Run migrations and seed once.

```shell
pnpm ops:migrate:aws
pnpm ops:seed:aws
```

Deploy the service and edge.

```shell
pnpm --filter @proxy/infra-cdk cdk deploy \
  --require-approval never \
  -c "runtimeImageTag=${IMAGE_TAG}" \
  -c "${PROXY_DEPLOY_ENV}AdminAllowedCidrs=${ADMIN_ALLOWED_CIDR}" \
  "proxy-${PROXY_DEPLOY_ENV}-service" \
  "proxy-${PROXY_DEPLOY_ENV}-edge"
```

Build and sync the web app.

```shell
pnpm build:web:aws

export PROXY_WEB_BUCKET="$(aws cloudformation describe-stacks \
  --stack-name "proxy-${PROXY_DEPLOY_ENV}-web" \
  --query "Stacks[0].Outputs[?OutputKey=='WebAssetsBucketName'].OutputValue" \
  --output text)"

pnpm sync:web:aws
```

Invalidate CloudFront.

```shell
export PROXY_CLOUDFRONT_DISTRIBUTION_ID="$(aws cloudformation describe-stacks \
  --stack-name "proxy-${PROXY_DEPLOY_ENV}-edge" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDistributionId'].OutputValue" \
  --output text)"

aws cloudfront create-invalidation \
  --distribution-id "$PROXY_CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/*"
```

## GitHub Deploy

After the foundation stack exists, use **Actions > AWS Deploy**.

Inputs:

- `environment`: `staging` or `prod`.
- `image_tag`: optional; defaults to the commit SHA.
- `admin_allowed_cidrs`: optional comma-separated IPv4 or IPv6 CIDRs for private `/admin/*` staging access. Leave blank for public app-authenticated access.
- `seed`: run the seed task after migrations.

The workflow runs typecheck, tests, image build/push, base CDK deploy, migrations, optional seed, service/edge CDK deploy, web sync, CloudFront invalidation, ECS stability wait, and deployed smoke. The GitHub-hosted runner skips admin smoke because admin credentials are not exposed to arbitrary workflow logs.

## Full Deployed Smoke

Run the full smoke from an authenticated workstation.

```shell
export PROXY_DEPLOYED_BASE_URL="https://$(aws cloudformation describe-stacks \
  --stack-name "proxy-${PROXY_DEPLOY_ENV}-edge" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomainName'].OutputValue" \
  --output text)"

export PROXY_DEPLOYED_API_KEY="$(aws secretsmanager get-secret-value \
  --secret-id "proxy-${PROXY_DEPLOY_ENV}-token" \
  --query SecretString \
  --output text)"

export ADMIN_CREDENTIALS="$(aws secretsmanager get-secret-value \
  --secret-id "proxy-${PROXY_DEPLOY_ENV}-admin-credentials" \
  --query SecretString \
  --output text)"

export PROXY_DEPLOYED_ADMIN_EMAIL="$(node -e 'const v = JSON.parse(process.env.ADMIN_CREDENTIALS); process.stdout.write(v.email)')"
export PROXY_DEPLOYED_ADMIN_PASSWORD="$(node -e 'const v = JSON.parse(process.env.ADMIN_CREDENTIALS); process.stdout.write(v.password)')"
export PROXY_DEPLOYED_ORGANIZATION_ID="proxy-${PROXY_DEPLOY_ENV}"

pnpm smoke:deployed
```

This verifies `/healthz`, `/v1/models`, OpenAI Responses SSE, OpenAI Responses WebSocket, Anthropic Messages streaming, admin cookie auth, and persisted request/session/prompt artifacts.

## Codex Config

Use the CloudFront domain as the OpenAI-compatible base URL.

```toml
model = "gpt-5.5"
model_provider = "proxy_aws"
model_reasoning_effort = "high"

[model_providers.proxy_aws]
name = "Proxy AWS"
base_url = "https://REPLACE_WITH_CLOUDFRONT_DOMAIN/v1"
env_key = "PROXY_DEPLOYED_API_KEY"
wire_api = "responses"
supports_websockets = false
```

Then run a small command from Codex and check the admin console or `pnpm smoke:deployed` output for the selected route/model.

## Claude Code Config

Add to `~/.claude/settings.json` (user-level or managed settings only; Claude Code filters `ANTHROPIC_BASE_URL` out of project-scoped settings):

```json
{
  "model": "claude-router-auto",
  "env": {
    "ANTHROPIC_BASE_URL": "https://REPLACE_WITH_CLOUDFRONT_DOMAIN",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  },
  "apiKeyHelper": "echo \"$PROXY_DEPLOYED_API_KEY\""
}
```

Then run `claude` with no extra flags. For a one-off session without touching settings:

```shell
export ANTHROPIC_BASE_URL="https://REPLACE_WITH_CLOUDFRONT_DOMAIN"
export ANTHROPIC_API_KEY="$PROXY_DEPLOYED_API_KEY"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model claude-router-auto
```

## Logs

Proxy logs:

```shell
aws logs tail "/aws/ecs/proxy-${PROXY_DEPLOY_ENV}" --follow
```

Operations logs:

```shell
aws logs tail "/aws/ecs/proxy-${PROXY_DEPLOY_ENV}-operations" --follow
```

No raw prompts should appear in CloudWatch logs. Raw prompt text belongs in Postgres `prompt_artifacts.raw_text`.

## Rollback

Runtime rollback:

```shell
pnpm --filter @proxy/infra-cdk cdk deploy \
  --require-approval never \
  -c "runtimeImageTag=PREVIOUS_IMAGE_TAG" \
  -c "${PROXY_DEPLOY_ENV}AdminAllowedCidrs=${ADMIN_ALLOWED_CIDR}" \
  "proxy-${PROXY_DEPLOY_ENV}-service" \
  "proxy-${PROXY_DEPLOY_ENV}-edge"
```

Web rollback:

```shell
git checkout PREVIOUS_SHA -- apps/web
pnpm build:web:aws
pnpm sync:web:aws
aws cloudfront create-invalidation \
  --distribution-id "$PROXY_CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/*"
```

Database migrations are forward-only. Risky migrations need an explicit rollback note before deploy.

## Cost Controls

- V1 uses no NAT Gateways, no EKS, no Redis, and no OpenSearch.
- Keep `desiredProxyCount=1` until traffic proves otherwise.
- Keep RDS at `db.t4g.micro` and 20 GB for staging.
- Keep CloudWatch log retention short.
- Destroy staging when not in use if cost matters; keep prod deletion protection enabled.
