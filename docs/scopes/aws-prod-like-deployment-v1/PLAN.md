# AWS Prod-Like Deployment V1

## Goal

Deploy Prompt Proxy to AWS in a production-like shape that is reliable enough for internal company usage, cheap enough to keep running continuously, and close enough to production that the same path can later be hardened instead of replaced.

The first AWS environment should support:

- OpenAI-compatible Codex traffic through `/v1/responses`, including streaming and WebSocket continuations.
- Anthropic-compatible Claude Code traffic through `/v1/messages` and `/v1/messages/count_tokens`.
- The TanStack web console for admin visibility into usage, prompts, sessions, users, routing configs, and API keys.
- Durable Postgres persistence for events, prompt artifacts, route decisions, sessions, usage, API keys, and admin sessions.
- Safe deployment through migrations, smoke checks, rollback, logs, alarms, and secret isolation.

## Recommendation

Use a lightweight AWS CDK deployment modeled after `../atlas-parthenon/atlas/infra/cdk`, not the heavier `../mortgages` Kubernetes path.

Atlas has the right V1 cost posture:

- CDK-owned AWS infrastructure.
- ECR image repositories.
- GitHub Actions OIDC deploy roles.
- ECS Fargate services in public runtime subnets with restrictive security groups.
- RDS Postgres in isolated database subnets.
- No NAT Gateways or interface VPC endpoints for the first cloud-test environment.
- An operations ECS task for migrations and private smoke checks.

Mortgages is useful for production guardrails, but its EKS/Terraform/Redis posture is larger than Prompt Proxy needs right now. Borrow the database protections, migration discipline, resource sizing, health checks, and environment overlays. Do not copy the whole platform shape unless there is an organizational requirement to standardize on EKS.

## Target Topology

```text
Codex / Claude Code / other harnesses
        |
        | HTTPS / SSE / WebSocket
        v
CloudFront distribution
        |
        | /v1/*, /api/*, /admin/*, /healthz
        v
Application Load Balancer
        |
        v
ECS Fargate: prompt-proxy service
        |
        +-- RDS Postgres in isolated subnets
        +-- Secrets Manager runtime secrets
        +-- CloudWatch logs and metrics

Browser
        |
        v
CloudFront distribution
        |
        | default route
        v
S3 private bucket with built Vite assets
```

Use one CloudFront distribution for both the static web console and proxy API routes. That keeps the web console and admin API same-origin, avoids CORS/cookie friction, and gives us one public URL to put into Codex and Claude Code configs.

The CloudFront distribution must be owned by a dedicated `EdgeStack`, not split between web and proxy stacks. `WebStack` should export the S3 bucket origin, `ProxyServiceStack` should export the ALB origin, and `EdgeStack` should own WAF, origin access control, cache/origin request policies, and every behavior rule.

## Infrastructure Components

### CDK app

Add `infra/cdk` using TypeScript. Keep the app small and environment-driven.

Stacks:

- `FoundationStack`
  - ECR repository for the proxy runtime image.
  - GitHub Actions OIDC deploy role scoped to this repository.
  - Optional separate read-only/synth role if we want CDK diff without deploy.

- `NetworkStack`
  - VPC with public runtime subnets and isolated database subnets.
  - No NAT Gateways in V1.
  - ALB security group.
  - ECS service security group.
  - Database security group allowing Postgres only from the ECS service and operations task.
  - Fargate services and operations tasks run in public runtime subnets with `assignPublicIp: true`, no public inbound rules, and outbound internet access for ECR, CloudWatch Logs, Secrets Manager, and provider APIs.
  - ALB ingress is restricted to CloudFront, either through the AWS-managed CloudFront origin-facing prefix list or CloudFront VPC origins if we choose that path.

- `DatabaseStack`
  - RDS PostgreSQL.
  - Encrypted storage.
  - Generated database credentials.
  - `DATABASE_URL` secret assembled for runtime tasks.
  - Staging/prod-like: single-AZ `db.t4g.micro` or smallest acceptable Graviton class, 20 GB gp3 storage, 7 day backups.
  - Production hardening later: Multi-AZ, deletion protection, final snapshots, longer backups, Performance Insights if the cost is justified.

- `RuntimeSecretsStack`
  - Secret containers for:
    - `DATABASE_URL`
    - `PROMPT_PROXY_TOKEN`
    - `OPENAI_API_KEY`
    - `ANTHROPIC_API_KEY`
    - `ADMIN_SESSION_SECRET` once added
    - temporary admin login credentials until real auth exists
    - optional model cost JSON and routing defaults if we do not want them as plain environment variables
  - Operator-populated provider keys. Never commit provider keys into CDK context.

- `WebStack`
  - Private S3 bucket for `apps/web/dist`.
  - Web asset deployment/prefixing.
  - Export S3 bucket origin metadata for `EdgeStack`.
  - Build the web app with same-origin API paths, ideally `VITE_PROMPT_PROXY_API_BASE=""`.

- `ProxyServiceStack`
  - ECS cluster.
  - Fargate task definition for `apps/proxy`.
  - One desired task for V1.
  - Service runs in public runtime subnets with `assignPublicIp: true`; the task security group allows inbound traffic only from the ALB security group.
  - Health check on `/healthz`.
  - ALB target group with long enough idle timeout for streaming and WebSocket traffic.
  - Export ALB origin metadata for `EdgeStack`.

- `EdgeStack`
  - One CloudFront distribution.
  - S3 origin with origin access control.
  - ALB origin for proxy/admin/API traffic.
  - WAF with basic IP rate limits.
  - Optional WAF admin allowlist for private internal staging only.
  - Optional Route 53/ACM custom domain.
  - SPA fallback to `index.html`.
  - Explicit behavior matrix for static assets, `/v1/*`, `/api/*`, `/admin/*`, and `/healthz`.
  - App-level auth for admin APIs; add SSO/OIDC before treating this as a true production admin surface.

- `OperationsStack`
  - Admin ECS task definition using the same image and secrets as the service.
  - Tasks run in public runtime subnets with `assignPublicIp: true`, no public inbound rules, and database access through the operations security group.
  - Commands for:
    - `pnpm db:migrate`
    - `pnpm db:seed`
    - deployed-environment smoke checks once those scripts exist
  - Security group with database access and no public inbound rules.

## Edge Behavior Requirements

CloudFront behavior configuration is part of the security boundary. These behaviors should be implemented in `EdgeStack`.

| Path | Origin | Methods | Caching | Forwarding | Notes |
| --- | --- | --- | --- | --- | --- |
| `/assets/*` and fingerprinted static files | S3 | `GET`, `HEAD` | Long-lived immutable cache | No cookies, no auth headers, no query strings unless Vite assets require them | Static assets only. |
| `/`, route paths, and `index.html` | S3 | `GET`, `HEAD` | Short/no-cache for `index.html` | No cookies, no auth headers | SPA fallback must not apply to API paths. |
| `/v1/*` | ALB | All methods plus WebSocket upgrade support | Disabled | All query strings; headers including `Authorization`, `x-api-key`, `Content-Type`, `Accept`, `Idempotency-Key`, `x-request-id`, `traceparent`, `tracestate`, `anthropic-version`, `anthropic-beta`, `openai-beta`, `x-codex-session-id`, `x-claude-code-session-id`, `x-claude-code-agent-id`, `x-claude-code-parent-agent-id`; no cookies unless later required | Required for Codex/Claude Code auth, streaming, provider beta/version behavior, and session attribution. |
| `/api/*` | ALB | All methods | Disabled | All query strings; `Cookie`, `Content-Type`, `Accept`, `x-request-id`, tracing headers | Admin auth uses cookies; responses must set `Cache-Control: no-store`. |
| `/admin/*` | ALB | All methods | Disabled | All query strings; `Cookie`, `Content-Type`, `Accept`, `x-request-id`, tracing headers | Admin data includes prompts and usage; responses must set `Cache-Control: no-store`. |
| `/healthz` | ALB | `GET`, `HEAD` | Short cache or disabled | No cookies, no auth headers | Health checks must not prove API behavior by themselves. |

ALB idle timeout and CloudFront origin settings must support long-running SSE and WebSocket requests. The deployed smoke suite must verify both paths through CloudFront, not just directly against the ALB.

## Runtime Packaging

Prompt Proxy does not currently have production Docker packaging. Add it before deploying.

Required changes:

- Root `Dockerfile` using Node 22 and pnpm.
- Production script for proxy startup, for example `pnpm start:prod:proxy`.
- Compile TypeScript during image build.
- Run `node` against built JavaScript in production, not `tsx`.
- Hard-cut package exports and scripts for `@prompt-proxy/proxy`, `@prompt-proxy/db`, and `@prompt-proxy/schema` to built `dist` JavaScript, including migrate, seed, smoke, and proxy startup scripts.
- Keep web build separate from the proxy runtime image unless we intentionally choose to serve static assets from Fastify later.

Suggested image shape:

```text
base -> install pnpm
deps -> install workspace deps
build -> pnpm build
runtime -> production deps + built proxy + packages
```

The web deployment should build `apps/web` in CI and sync `apps/web/dist` to S3.

## Environment Variables

Runtime service:

- `PORT=8787`
- `DATABASE_URL` from Secrets Manager
- `DEFAULT_ORGANIZATION_ID`
- `PROMPT_PROXY_TOKEN` from Secrets Manager for the seeded/internal API key path
- `ALLOW_DEV_PROXY_TOKEN_FALLBACK=false`
- `OPENAI_API_KEY` from Secrets Manager
- `OPENAI_BASE_URL`
- `ANTHROPIC_API_KEY` from Secrets Manager
- `ANTHROPIC_BASE_URL`
- `CLASSIFIER_PROVIDER`
- `CLASSIFIER_MODEL`
- `CLASSIFIER_TIMEOUT_MS`
- `CLASSIFIER_MAX_ATTEMPTS`
- `PROVIDER_RATE_LIMIT_MAX_ATTEMPTS`
- `PROVIDER_RATE_LIMIT_BASE_DELAY_MS`
- `PROVIDER_RATE_LIMIT_MAX_DELAY_MS`
- `MODEL_COSTS_JSON`
- `ADMIN_CORS_ORIGIN` only if the console and API are not same-origin
- `ADMIN_DEV_LOGIN_ENABLED=false` for true production; for first internal staging, use a strong temporary password and restrict access
- `LOG_LEVEL=info`

Web build:

- `VITE_PROMPT_PROXY_API_BASE=""` for same-origin CloudFront routing, or the full public API origin if we intentionally split console and API domains.

Seed/migration task:

- `SEED_USER_ID`
- `SEED_USER_EMAIL`
- `SEED_USER_NAME`
- same provider and classifier defaults used by the runtime service

## Deployment Workflow

Use GitHub Actions with OIDC into AWS.

Manual workflow:

1. Install dependencies.
2. Run `pnpm typecheck`.
3. Run `pnpm test`.
4. Build proxy Docker image.
5. Push image to ECR with the git SHA tag.
6. Build `apps/web` with the target public API base.
7. `cdk synth`.
8. `cdk deploy` foundation/network/database/secrets if needed.
9. Run the operations ECS task for `pnpm db:migrate`.
10. Run `pnpm db:seed` only for initial bootstrapping or explicitly requested seed updates.
11. Deploy or update WAF rate limits and optional private-staging admin allowlists.
12. Deploy or update the ECS service with the new image tag.
13. Sync web assets to S3.
14. Invalidate CloudFront for changed web shell assets.
15. Wait for ECS service stability.
16. Run deployed public smoke checks:
    - `GET /healthz`
    - `GET /v1/models`
    - OpenAI Responses SSE request through CloudFront
    - OpenAI Responses WebSocket upgrade through CloudFront
    - Anthropic Messages streaming request through CloudFront
    - admin login/me through CloudFront if admin auth is enabled
    - persistence check against RDS for request, route decision, provider attempt, usage ledger, session, and prompt artifact rows
17. Run local mock-provider smoke checks separately:
    - `pnpm smoke`
    - `pnpm smoke:harnesses`

The existing `pnpm smoke` and `pnpm smoke:harnesses` scripts are local smoke tests. They start local mock providers and should not be treated as proof that CloudFront, ALB, ECS, RDS, deployed WebSocket routing, or real provider egress works.

Rollback:

- ECS: redeploy the previous image tag.
- Web: restore the previous S3 artifact prefix or rerun the workflow with the previous git SHA.
- Database: migrations are forward-only. Any risky migration must ship with an explicit rollback SQL note before deploy.

## Cost Posture

Keep V1 cheap by avoiding fixed infrastructure we do not need yet.

Use:

- S3 + CloudFront for the web console.
- One ECS Fargate task for the proxy.
- One small RDS Postgres instance.
- One ALB behind CloudFront.
- Short CloudWatch log retention.
- No NAT Gateways.
- No EKS.
- No ElastiCache/Redis.
- No OpenSearch.
- No always-on worker until the outbox has async processing that cannot run in-process.

Main fixed cost drivers:

- RDS instance and storage.
- ALB.
- Baseline Fargate task.
- CloudWatch logs if prompt-heavy request logs are too verbose.

Cost controls:

- Use staging single-AZ.
- Use log retention of 7-30 days.
- Do not log raw prompt text in CloudWatch.
- Keep raw prompts in Postgres only, through `prompt_artifacts.raw_text`.
- Use AWS Budgets for the account or project tag.
- Tag all resources with `app=prompt-proxy`, `environment`, and `owner`.

## Security Baseline

Minimum before wider company usage:

- TLS at CloudFront.
- RDS not publicly accessible.
- RDS encrypted at rest.
- Provider credentials in Secrets Manager.
- API keys stored only as hashes in Postgres.
- `ALLOW_DEV_PROXY_TOKEN_FALLBACK=false`.
- No raw prompts in event payloads or logs.
- CloudWatch logs redacted of headers and request bodies.
- WAF rate limiting at the edge.
- Admin console uses app-level auth in V1; private-staging WAF allowlists are optional.

Open issue:

- The current admin login is dev-password based. For a true production deployment, add OIDC/Cognito/SSO or put the admin console behind a trusted access layer.

## Observability

CloudWatch:

- ECS service logs.
- ALB access logs to S3 if request-level debugging is needed.
- RDS logs exports for PostgreSQL and upgrade logs.
- Alarms for:
  - ECS task unhealthy/restart loop.
  - ALB 5xx.
  - target health count below desired.
  - RDS CPU/storage/connection saturation.
  - classifier/provider failure rate, once emitted as metrics.

Application:

- Keep structured logs at request boundaries.
- Log route decisions and provider/model ids.
- Do not log full prompt text.
- Add a deployment version/git SHA to response headers or health output.

## Data and Retention

Postgres is the source of truth for:

- Organizations.
- Users.
- API keys and routing-config assignment.
- Routing configs and immutable versions.
- Events and outbox rows.
- Requests, provider attempts, route decisions, sessions, usage ledger.
- Prompt artifacts, including raw prompts for this test project.

V1 retention:

- Keep all request metadata.
- Keep raw prompts for a configurable window through prompt-capture settings.
- Add a future retention worker before real production if prompt volume grows.

## Why Not Lambda/API Gateway First

Lambda would reduce idle compute, but it is a poor fit for this first version because the gateway needs long streaming responses, WebSocket continuations, simple TCP-style upstream proxying, and predictable process-local Fastify behavior. ECS Fargate keeps the existing app shape intact and is closer to Atlas.

## Why Not EKS First

EKS is justified if the company standard mandates it or if we need shared cluster operations from day one. For this project, it adds control-plane complexity, Helm surface area, cluster upgrades, node/Fargate profile choices, and operational work that does not reduce cost for a first internal deployment. Mortgages is useful as a mature production reference, not as the V1 baseline.

## Implementation Work Breakdown

Break this into PR-sized tickets in [TICKETS.md](TICKETS.md). Do not implement this as one large infrastructure PR. The critical sequence is:

1. Production packaging and built-JS runtime cutover.
2. Deployed smoke test scripts.
3. CDK scaffold, foundation, and network.
4. Database and runtime secrets.
5. Proxy service and operations task.
6. Web hosting.
7. Edge stack with explicit behavior policies and admin access control.
8. Deploy workflow.
9. Runbook and final acceptance pass.

## Acceptance Criteria

- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass in CI.
- CDK synthesizes from a clean checkout without live secrets.
- AWS staging deploy creates no NAT Gateway, no EKS cluster, and no Redis/ElastiCache.
- Fargate service and operations tasks either have `assignPublicIp: true` in public subnets or an explicitly implemented NAT/VPC endpoint egress path.
- RDS is private, encrypted, and accessible only from ECS service/admin tasks.
- The CloudFront distribution is owned by `EdgeStack`, uses disabled caching for API/admin paths, forwards required auth/session/provider headers and admin cookies, and prevents direct ALB bypass.
- Proxy is reachable through HTTPS at the public CloudFront URL.
- Web console is reachable through the same CloudFront URL.
- `/healthz` and `/v1/models` pass public smoke checks.
- Codex can use the deployed `/v1` base URL with `supports_websockets = true`.
- Claude Code can use the deployed Anthropic-compatible base URL.
- Deployed smoke checks prove SSE, WebSocket upgrade, auth/header forwarding, admin cookie auth, and RDS persistence through CloudFront.
- WAF rate limiting and app-level admin auth are in place before `/api/*` or `/admin/*` is publicly reachable.
- Events and prompt artifacts are persisted to RDS.
- Provider keys are only loaded from Secrets Manager.
- Raw prompts do not appear in CloudWatch logs.

## Open Questions

- Which AWS account and region should own the first environment?
- Do we have a Route 53 hosted zone ready, or should V1 use the CloudFront-generated domain?
- Is there an existing company SSO/access proxy we should use for the admin console instead of adding Cognito?
- Should production prompt retention be disabled, short-lived, or fully enabled for the initial internal trial?
- Do we want this deployed from GitHub Actions only, or should local CDK deploys remain supported for the first environment?
