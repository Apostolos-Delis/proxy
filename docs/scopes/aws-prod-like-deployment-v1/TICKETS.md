# AWS Prod-Like Deployment V1 Tickets

These tickets are ordered for a safe first AWS deployment. Keep each ticket independently reviewable and avoid merging later infrastructure tickets before the earlier runtime and smoke-test tickets are done.

## Ticket 1: Production Runtime Packaging

Dependencies: none.

Scope:

- Add a root Dockerfile for the proxy runtime image.
- Add `start:prod:proxy`.
- Compile TypeScript during build.
- Hard-cut workspace package exports and runtime scripts to built `dist` JavaScript for `@prompt-proxy/proxy`, `@prompt-proxy/db`, and `@prompt-proxy/schema`.
- Make migrate, seed, proxy start, and smoke scripts work from the production image.

Likely files:

- `Dockerfile`
- `package.json`
- `apps/proxy/package.json`
- `packages/db/package.json`
- `packages/schema/package.json`
- `tsconfig*.json`

Acceptance:

- Image builds from a clean checkout.
- Container starts the proxy with `node` and built JavaScript.
- Container can run `pnpm db:migrate` and `pnpm db:seed` against a supplied `DATABASE_URL`.

Validation:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- Docker image build
- Containerized `/healthz` smoke against local Postgres

Rollback:

- Revert the Dockerfile/package export cutover before any CDK service consumes the image.

## Ticket 2: Deployed Smoke Test Scripts

Dependencies: Ticket 1.

Scope:

- Keep current `pnpm smoke` and `pnpm smoke:harnesses` as local mock-provider smoke tests.
- Add deployed-environment smoke commands that accept:
  - public base URL
  - proxy API key
  - admin credentials or admin session setup
  - expected organization id
- Verify through CloudFront:
  - `/healthz`
  - `/v1/models`
  - OpenAI Responses SSE
  - OpenAI Responses WebSocket upgrade
  - Anthropic Messages streaming
  - admin login/me when enabled
  - persisted rows in RDS for request, route decision, provider attempt, usage ledger, session, and prompt artifact

Likely files:

- `apps/proxy/scripts/*`
- `apps/proxy/package.json`
- root `package.json`

Acceptance:

- Local smoke remains mock-backed and fast.
- Deployed smoke fails if CloudFront drops auth headers, session headers, cookies, provider version headers, or WebSocket upgrades.
- Deployed smoke proves persistence with `DATABASE_URL` enabled.

Validation:

- `pnpm smoke`
- `pnpm smoke:harnesses`
- New deployed smoke command against a local reverse proxy or staging URL

Rollback:

- Remove deployed smoke from the deploy workflow only; keep the scripts if useful for diagnosis.

## Ticket 3: CDK Scaffold and Foundation

Dependencies: Ticket 1.

Scope:

- Add `infra/cdk` TypeScript app.
- Add environment config and common tags.
- Add `FoundationStack` with:
  - ECR repository
  - GitHub Actions OIDC deploy role
  - optional read-only synth/diff role
- Add synth-only workflow.

Likely files:

- `infra/cdk/**`
- `.github/workflows/*`
- `package.json`

Acceptance:

- CDK synth works from a clean checkout without live secrets.
- ECR repository and deploy role are scoped to this repo.

Validation:

- `pnpm cdk:synth` or equivalent
- GitHub workflow dry run where possible

Rollback:

- Destroy foundation stack only before any downstream stacks depend on it.

## Ticket 4: Network Stack

Dependencies: Ticket 3.

Scope:

- Add VPC with public runtime subnets and isolated database subnets.
- No NAT Gateways for V1.
- Add ALB, ECS service, operations, and database security groups.
- Require Fargate service and operations tasks to use public runtime subnets with `assignPublicIp: true`.
- Restrict direct ALB ingress to CloudFront origin traffic.

Likely files:

- `infra/cdk/lib/network-stack.ts`
- `infra/cdk/config/*`

Acceptance:

- No NAT Gateway is synthesized.
- Database subnets are isolated.
- ECS task security groups have no public inbound rules.
- ALB cannot be used as an unrestricted public bypass around CloudFront/WAF.

Validation:

- CDK synth
- CDK assertions or snapshot checks for no NAT and expected security group rules

Rollback:

- Destroy the network stack before database/service stacks are created.

## Ticket 5: Database and Runtime Secrets

Dependencies: Ticket 4.

Scope:

- Add RDS PostgreSQL in isolated subnets.
- Enable storage encryption.
- Generate database credentials.
- Create a `DATABASE_URL` secret.
- Add runtime secret containers for provider keys, proxy token, temporary admin credentials, and future admin session secret.
- Keep provider key values operator-populated.

Likely files:

- `infra/cdk/lib/database-stack.ts`
- `infra/cdk/lib/runtime-secrets-stack.ts`
- `infra/cdk/config/*`

Acceptance:

- RDS is not publicly accessible.
- RDS accepts Postgres only from service/operations security groups.
- Runtime tasks can consume secrets without storing secret values in CDK context.

Validation:

- CDK synth
- CDK diff
- Migration task connectivity after Ticket 6

Rollback:

- For staging, destroy after snapshot/export if data matters.
- For production, deletion protection/final snapshot rules must be explicit before deployment.

## Ticket 6: Proxy Service and Operations Task

Dependencies: Tickets 1, 4, 5.

Scope:

- Add ECS cluster.
- Add proxy Fargate service using the production image.
- Add ALB target group and `/healthz` health check.
- Add operations task using the same image and secrets.
- Add migration and seed task commands.
- Configure CloudWatch logs with short retention.

Likely files:

- `infra/cdk/lib/proxy-service-stack.ts`
- `infra/cdk/lib/operations-stack.ts`
- deploy scripts or workflow helpers

Acceptance:

- Proxy task becomes healthy behind ALB.
- Operations task can run migrations against RDS.
- Service and operations tasks have outbound provider/API access through the chosen egress path.

Validation:

- CDK synth
- ECS service stability
- operations task `pnpm db:migrate`
- direct private/admin smoke where available

Rollback:

- Redeploy previous image tag or set service desired count to zero in staging.

## Ticket 7: Web Hosting

Dependencies: Ticket 3.

Scope:

- Add private S3 bucket for `apps/web/dist`.
- Build web with `VITE_PROMPT_PROXY_API_BASE=""`.
- Add S3 asset sync/prefixing.
- Export bucket/origin metadata to `EdgeStack`.

Likely files:

- `infra/cdk/lib/web-stack.ts`
- `.github/workflows/*`
- web build/deploy scripts

Acceptance:

- Web assets publish to private S3.
- No public bucket access is required.
- Built web uses same-origin admin/API calls.

Validation:

- `pnpm --filter @prompt-proxy/web build`
- CDK synth
- S3 sync dry run where possible

Rollback:

- Restore previous S3 artifact prefix or redeploy previous git SHA.

## Ticket 8: Edge Stack and Admin Access Gate

Dependencies: Tickets 4, 6, 7.

Scope:

- Add `EdgeStack` owning:
  - CloudFront distribution
  - S3 origin access control
  - ALB origin
  - WAF rate limits
  - optional custom domain
  - SPA fallback
  - all behavior policies
- Implement the behavior matrix from `PLAN.md`.
- Disable caching for `/v1/*`, `/api/*`, and `/admin/*`.
- Forward required auth, cookie, provider version/beta, harness/session, request, and tracing headers.
- Gate public `/api/*` and `/admin/*` exposure on one access-control choice:
  - company SSO/trusted access layer
  - Cognito/OIDC
  - temporary WAF/CloudFront allowlist for internal staging only

Likely files:

- `infra/cdk/lib/edge-stack.ts`
- `infra/cdk/config/*`
- proxy/admin cookie settings if needed

Acceptance:

- One CloudFront URL serves both web and API/admin.
- ALB direct access cannot bypass WAF/admin access controls.
- Admin/API responses are not cached.
- Codex/Claude headers survive CloudFront.
- WebSocket upgrade succeeds through CloudFront.

Validation:

- CDK synth
- deployed smoke from Ticket 2
- manual admin login check
- Codex and Claude Code against CloudFront URL

Rollback:

- Revert CloudFront distribution to previous config or redeploy previous CDK artifact.

## Ticket 9: Deploy Workflow

Dependencies: Tickets 1-8.

Scope:

- Add GitHub Actions deploy workflow:
  - install
  - typecheck/test/build
  - build/push proxy image
  - build web
  - CDK synth/deploy
  - run migrations
  - seed when explicitly requested
  - update ECS service
  - sync web assets
  - invalidate CloudFront
  - wait for ECS stability
  - run deployed smoke
- Add protected environment controls for production.

Likely files:

- `.github/workflows/aws-deploy.yml`
- deploy scripts under `scripts/` or `infra/cdk/scripts/`

Acceptance:

- Manual staging deploy runs end to end.
- Failed migration or smoke check stops rollout.
- Production deploy requires protected environment approval.

Validation:

- Workflow dry run where possible.
- First staging deploy.
- Deployed smoke.

Rollback:

- Workflow supports redeploying a previous image/artifact SHA.

## Ticket 10: Deployment Runbook and Final Acceptance

Dependencies: Ticket 9.

Scope:

- Add a runbook for:
  - first account bootstrap
  - secret population
  - first deploy
  - migrations and seeds
  - rollback
  - Codex config
  - Claude Code config
  - CloudWatch log review
  - cost controls
- Run the full acceptance checklist from `PLAN.md`.

Likely files:

- `docs/runbooks/aws-deployment.md`
- `README.md`
- `docs/index.md`

Acceptance:

- A new operator can deploy staging from the runbook.
- The deployed endpoint works for Codex and Claude Code.
- RDS contains persisted request and prompt artifacts.
- No raw prompts appear in CloudWatch logs.

Validation:

- Full staging deploy.
- Deployed smoke.
- Manual Codex and Claude Code harness checks.

Rollback:

- Follow the runbook rollback section and verify the previous endpoint behavior.
