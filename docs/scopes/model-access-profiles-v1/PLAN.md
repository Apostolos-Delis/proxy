# Model Access Profiles V1

## Goal

Let organizations control which users can reach advanced routers and models without turning every model-access distinction into an admin role.

The motivating example:

```text
Engineers
  can use fable, hard/deep router tiers, and other advanced coding models.

Non-engineers
  can use only safer or cheaper default routers and models.
```

V1 should make this enforceable at runtime for OpenAI-compatible and Anthropic-compatible proxy traffic, visible in the admin console, and auditable in request/routing history.

## Design Principle

Separate **admin authority** from **runtime model access**.

Organization roles answer:

```text
What can this person administer in the console?
```

Model access profiles answer:

```text
Which routers, route tiers, providers, and models can this person's traffic use?
```

Do not overload `owner`, `admin`, `member`, and `viewer` with job functions like `engineer`, `support`, or `sales`. A user can be an `admin` with standard model access, or a `member` with engineer model access. Those are different axes.

## Current State

The repo already has most of the runtime routing foundation:

```text
organization_members       org membership role and status
invitations                invite carries initial role
api_keys                   traffic identity, owner, scopes, routing config binding
routing_configs            workspace-scoped routing config identity
routing_config_versions    immutable routing config JSON snapshots
workspaces                 default routing config per workspace
route_decisions            selected route/model audit rows
requests                   request current state
events                     durable event log
```

Runtime routing today resolves roughly as:

```text
incoming API key
  -> api key identity
  -> api_keys.routing_config_id or workspace default routing config
  -> active routing config version
  -> classifier decision
  -> routing_config.limits.maxRoute
  -> selected provider/model
```

Important existing behavior to preserve:

- Auto-routed traffic above `limits.maxRoute` is clamped to the configured ceiling.
- Explicit aliases above `limits.maxRoute` are rejected before classification.
- Routing configs choose provider/model per route tier and surface.
- API keys are personal credentials. Proxy traffic attributes to the key owner's user id; harness user headers are audit context only.

Current gaps:

- Member roles are only `owner`, `admin`, `member`, and `viewer`.
- Runtime routing does not load a user's membership role or model-access constraints.
- `/v1/models` lists every router alias regardless of caller access.
- Admin GraphQL carries `identity.role`, but mutation authorization is not consistently enforced.
- Route decision audit rows do not record the access policy that constrained a decision.

## Product Model

### Access Profiles

Add an org-scoped `access_profiles` object:

```text
access_profile
  stable named policy owned by an organization
```

Example profiles:

```text
Engineer
  maxRoute: deep
  allowed router aliases: all
  allowed OpenAI models: fable, hard/deep coding models, standard models
  allowed Anthropic models: advanced coding models, standard models

Standard
  maxRoute: balanced
  allowed router aliases: auto, fast, balanced
  allowed models: approved low/mid-cost models

Restricted
  maxRoute: fast
  allowed router aliases: auto, fast
  allowed models: default low-cost models only
```

### Binding

Access profiles should be assignable at three points:

```text
organization_members.access_profile_id
  default policy for the user's traffic

invitations.access_profile_id
  initial policy accepted with the invite

api_keys.access_profile_id
  optional override for system keys where no real user is available
```

For proxy API keys, the member profile should be the primary source of truth. Per-request harness identity headers must not affect effective access policy.

### Effective Policy

Runtime policy should resolve to one effective access profile:

```text
proxy key with owner user
  -> active organization member for api_keys.user_id
  -> member.access_profile_id

system key with no user
  -> api_keys.access_profile_id
  -> otherwise reject

dev proxy token
  -> seeded user's profile, or seeded engineer profile in local development
```

Unknown users must not silently inherit access from a shared key. That would make the shared key a bypass. A shared-key fallback profile is only for requests with no user signal at all, and it must be no more permissive than the organization's default non-engineer profile.

## Data Model

### access_profiles

```text
id text primary key
organization_id text not null references organizations(id)
name text not null
slug text not null
description text
status text not null default 'active'
policy jsonb not null
created_by_user_id text references users(id)
created_at timestamptz not null default now()
updated_at timestamptz not null default now()

unique (organization_id, slug)
unique (organization_id, id)
index (organization_id, status)
```

### organization_members

Add:

```text
access_profile_id text
```

Use the shared tenant-scoped foreign key rule below.

### invitations

Add:

```text
access_profile_id text
```

Accepting an invitation copies the profile onto `organization_members.access_profile_id`.

### api_keys

Add:

```text
access_profile_id text
```

This is nullable. Null means the key should resolve through its effective user. Shared/system keys that may operate without a user should be required to set it.

### Tenant-scoped references

Every live `access_profile_id` reference must be constrained by organization:

```text
foreign key (organization_id, access_profile_id)
  references access_profiles(organization_id, id)
```

Apply this rule to `organization_members`, `invitations`, and `api_keys`. Do not use a plain single-column FK to `access_profiles(id)` for assignment tables; it would allow cross-organization profile references if an id were ever supplied from the wrong tenant boundary.

### requests

Add audit snapshot columns:

```text
access_profile_id text
access_profile_name text
access_profile_hash text
```

### route_decisions

Add the same audit snapshot columns:

```text
access_profile_id text
access_profile_name text
access_profile_hash text
```

The hash should be computed from the normalized access profile policy so historical decisions can prove which policy constrained them even after the profile changes.

## Policy Shape

Add a typed schema in `@prompt-proxy/schema` rather than storing arbitrary policy JSON without validation:

```json
{
  "schemaVersion": 1,
  "displayName": "Engineer",
  "maxRoute": "deep",
  "fallbackRoute": "balanced",
  "allowedRouterAliases": {
    "openai-responses": ["router-auto", "router-fast", "router-balanced", "router-hard", "router-deep"],
    "anthropic-messages": ["claude-router-auto", "claude-router-fast", "claude-router-balanced", "claude-router-hard", "claude-router-deep"]
  },
  "allowedModels": {
    "openai": ["gpt-5.4", "gpt-5.4-mini", "fable"],
    "anthropic": ["claude-sonnet-4-6", "claude-opus-4-6"]
  },
  "allowUnlistedModels": false
}
```

Recommended fields for V1:

```text
schemaVersion
displayName
description
maxRoute
fallbackRoute
allowedRouterAliases
allowedModels
allowUnlistedModels
```

Do not add per-feature booleans like `canUseFable` or `canUseDeep`. Those become stale as model names and route tiers evolve. Keep the primitive generic: route ceiling plus allowlists.

## Runtime Enforcement

### Request Flow

The traffic path should become:

```text
incoming request
  -> authenticate API key
  -> build raw RouteContext from request body
  -> resolve effective user identity
  -> resolve model access profile
  -> resolve routing config
  -> merge routing config limits with access profile limits
  -> classify or use explicit alias
  -> select route/provider/model
  -> enforce route ceiling and model allowlist
  -> persist routing decision with access profile snapshot
  -> forward upstream
```

### Route Limits

The effective max route is the stricter of:

```text
routingConfig.limits.maxRoute
accessProfile.maxRoute
```

Preserve existing semantics:

- Auto route above the effective max route: clamp.
- Explicit alias above the effective max route: reject.
- Session memory above a newly lowered effective max route: cap.

### Model Allowlist

After route/provider settings resolve, enforce selected upstream model:

```text
if allowUnlistedModels == false:
  reject unless selectedModel is in allowedModels[selectedProvider]
```

This should happen after session pin handling. A session pin created under a more permissive profile must not bypass a later profile downgrade.

When a pinned model is no longer allowed:

```text
invalidate the pin
resolve current route settings again under the effective policy
if still disallowed, reject with model_not_allowed
```

### Router Alias Allowlist

Explicit model aliases should be checked before classification:

```text
requested model = router-hard
access profile allowedRouterAliases does not include router-hard
  -> reject router_alias_not_allowed
```

For auto aliases like `router-auto` and `claude-router-auto`, do not require listing every eventual tier. The effective max route handles the selected result.

### `/v1/models`

Today `/v1/models` is unauthenticated and returns every alias. V1 should authenticate it and return only aliases the caller can use.

Compatibility option:

```text
No auth header
  -> return public router aliases only if needed for SDK discovery
  -> omit restricted aliases
```

Preferred behavior:

```text
Require auth for /v1/models and filter by effective access profile.
```

## Admin Authorization

This scope should also make existing admin roles meaningful. Add GraphQL authorization helpers:

```text
requireAuthenticated(context)
requireRole(context, ["owner", "admin"])
requireRole(context, ["owner"])
```

Recommended permissions:

| Capability | Owner | Admin | Member | Viewer |
|---|---:|---:|---:|---:|
| View dashboard, requests, usage | yes | yes | yes | yes |
| View users and roles | yes | yes | no | no |
| Manage users/invitations | yes | yes | no | no |
| Change owner role | yes | no | no | no |
| Manage access profiles | yes | yes | no | no |
| Assign access profiles | yes | yes | no | no |
| Manage routing configs | yes | yes | no | no |
| Manage API keys | yes | yes | limited own keys | no |
| Manage provider credentials | yes | yes | no | no |
| Manage organization settings | yes | yes | no | no |

V1 can keep member key management out of scope if the console is admin-first. If members can create their own keys later, the created key must inherit their model access profile and may not self-escalate.

## Admin Console

### Users

Update the users page to show two separate editable columns:

```text
Role             owner/admin/member/viewer
Model access     Engineer/Standard/Restricted
```

Filters and advanced search should include both fields.

### Invitations

The invite panel should collect:

```text
Role
Model access profile
```

Default role remains `member`. Default model access should be the organization's default profile, likely `Standard`.

### API Keys

The key wizard and detail panel should show:

```text
Owner
Routing config
Model access source
Effective max route
Allowed model summary
```

For shared keys, allow admins to assign an access profile explicitly.

### Access Profiles Page

Add a small admin page for profiles:

```text
Profile list
  name
  max route
  allowed provider/model count
  assigned user count
  assigned key count
  status

Profile detail
  policy editor
  assigned users
  assigned keys
  recent route decisions constrained by this profile
```

Use structured controls for common fields and keep JSON editor access for advanced policy editing. Any JSON display/editing must use the existing `JsonView` / `JsonEditor` components.

## Events And Audit

Add admin events:

```text
access_profile.created
access_profile.updated
access_profile.archived
user.access_profile_changed
api_key.access_profile_changed
```

Add runtime decision payload fields:

```text
accessProfile: {
  profileId
  profileName
  profileHash
  maxRoute
}
```

Add guardrail actions where applicable:

```text
access_profile_route_clamped
access_profile_alias_rejected
access_profile_model_rejected
access_profile_session_pin_invalidated
```

These should be visible in request detail and session detail views.

## Seed Data

Seed at least:

```text
Engineer
  maxRoute: deep
  allowUnlistedModels: true only for local/dev bootstrap, false for production seeds

Standard
  maxRoute: balanced
  allowUnlistedModels: false

Restricted
  maxRoute: fast
  allowUnlistedModels: false
```

For existing members during migration:

```text
owner/admin/member -> Standard
viewer             -> Restricted
```

Do not infer engineer access from admin authority during migration. Owners and admins can explicitly assign Engineer access after the cutover. Local development seed data may still assign the seeded user to Engineer so existing smoke flows keep advanced local routing available.

This is a hard cutover default. After migration, every active member should have an access profile.

## API Design

GraphQL additions:

```graphql
type AccessProfile {
  id: ID!
  name: String!
  slug: String!
  description: String
  status: String!
  policy: JSON!
  assignedUserCount: Int!
  assignedApiKeyCount: Int!
  createdAt: String!
  updatedAt: String!
}

input CreateAccessProfileInput {
  name: String!
  description: String
  policy: JSON!
}

input UpdateAccessProfileInput {
  name: String
  description: String
  policy: JSON
}

extend type Query {
  accessProfiles: [AccessProfile!]!
  accessProfile(profileId: ID!): AccessProfile
}

extend type Mutation {
  createAccessProfile(input: CreateAccessProfileInput!): AccessProfile!
  updateAccessProfile(profileId: ID!, input: UpdateAccessProfileInput!): AccessProfile!
  archiveAccessProfile(profileId: ID!): AccessProfile!
  assignUserAccessProfile(userId: ID!, profileId: ID!): UserAccessProfileResult!
  assignApiKeyAccessProfile(apiKeyId: ID!, profileId: ID): ApiKey!
}
```

Existing user and invitation GraphQL types should expose `accessProfile`.

## Implementation Plan

1. Add access profile schema types in `packages/schema`.
2. Add database tables/columns and migration.
3. Seed default profiles and backfill existing members.
4. Add persistence services for access profile admin and runtime resolution.
5. Add GraphQL queries/mutations and role authorization helpers.
6. Reject shared-key fallback profile assignments that are more permissive than the organization's default non-engineer profile.
7. Update traffic auth/routing to resolve effective profiles and enforce route/model policy.
8. Persist access profile snapshots in request and route decision projections.
9. Update `/v1/models` to authenticate and filter.
10. Update web generated GraphQL types and admin UI pages.
11. Add focused tests across schema, runtime policy, GraphQL auth, and UI data helpers.
12. Update README or setup docs if API-key/model-access behavior changes for operators.

## Tests

Runtime tests:

- Auto route above profile max route clamps to the profile max route.
- Explicit alias above profile max route rejects.
- Selected model outside `allowedModels` rejects.
- Lowering a profile invalidates an existing session pin to a newly disallowed model.
- Routing config max route and access profile max route merge to the stricter value.
- Proxy key uses key owner's member profile.
- Harness user headers do not change effective policy.
- Shared-key fallback profile assignment rejects profiles above the organization default non-engineer ceiling.
- `/v1/models` only returns allowed aliases for a caller.

Admin tests:

- Owner/admin can create and assign profiles.
- Member/viewer cannot create or assign profiles.
- Admin cannot remove or downgrade the last owner if existing owner safeguards apply.
- Invitation acceptance copies access profile onto membership.
- Archiving an assigned profile is rejected or requires reassignment.

Projection/audit tests:

- Requests persist access profile snapshot fields.
- Route decisions persist access profile snapshot fields.
- Guardrail actions include access-profile policy actions.

Web tests:

- User role and model access are displayed separately.
- Invite form sends role plus access profile.
- API key detail shows effective model access source.
- Profile policy JSON uses shared syntax-highlighted JSON components.

## Rollout

V1 can ship as a hard cutover with safe defaults:

1. Migrate schema and seed default profiles.
2. Backfill all active members with a profile.
3. Keep `allowUnlistedModels` permissive only for local/dev Engineer bootstrap if the model catalog is not complete.
4. Enforce `maxRoute` first.
5. Ship production Standard and Restricted profiles with explicit allowlists before claiming non-engineer model-subset enforcement.

This avoids a long compatibility shim while still giving operators a safe path to tighten policy.

## Out Of Scope

- SCIM, SAML group sync, or external IdP-driven profile assignment.
- Per-repository, per-project, or per-prompt dynamic policy overrides.
- Spend quotas by user or team.
- Approval workflows for one-off access escalation.
- Provider registry work from provider architecture V1.
- A new global state layer or competing frontend data-fetching library.

## Open Questions

1. Should missing user headers on shared harness keys be rejected, or assigned the restricted fallback profile?
2. Should `member` users be allowed to create personal API keys, or is key creation admin-only for V1?
3. Does `/v1/models` need unauthenticated SDK discovery compatibility, or can it require auth?
4. What are the initial production model allowlists for Engineer, Standard, and Restricted?
5. Should access profiles be org-scoped only, or should workspaces be able to set a default profile later?
