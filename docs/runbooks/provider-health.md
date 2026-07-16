# Provider Connection And Deployment Health

## Health Boundaries

Proxy tracks failures at the physical resource that can actually be remediated:

- `provider_connection_health` covers credentials, quota, rate limits, and provider-wide availability for one connection.
- `deployment_health` covers access, availability, and lockouts for one model deployment.
- Request-only failures do not mutate shared health.

Logical models and access profiles do not own health state. They are caller-facing policy and resolution resources.

## Statuses

| Status | Meaning |
| --- | --- |
| `healthy` | A successful matching provider operation has completed. |
| `cooldown` | A connection-level transient failure has a future retry time. |
| `locked_out` | A deployment-level failure has a future retry time. |
| `terminal` | The resource needs operator action and has no automatic retry time. |
| `unknown` | No conclusive terminal evidence is available. |

The classifier distinguishes authentication, rate limit, quota, provider availability, model availability/access, incompatible requests, stream failures, and unknown failures. Error messages are sanitized before persistence.

## Projection Rules

Terminal provider events include deployment, connection, egress wire, and adapter evidence. The event projector updates health in the same transaction as the event and current request state.

- Successful responses mark the connection healthy.
- Successful responses mark the deployment healthy unless a non-streaming success would incorrectly clear a stream-permission lockout.
- Connection-scoped transient failures become `cooldown` until the classified deadline.
- Deployment-scoped transient failures become `locked_out` until the classified deadline.
- A failure without a retry deadline becomes `terminal`.
- Repeated failures increment `consecutive_failures`.

The resolver excludes resources whose health state does not permit selection. It never redirects to another logical model or workspace.

## Inspect Health

Use the database console while a dedicated GraphQL health view is not present:

```shell
pnpm db:console
```

```ts
await db.select().from(providerConnectionHealth)
await db.select().from(deploymentHealth)
```

Or use the runner for a targeted query:

```shell
pnpm db:runner -- 'await db.select().from(providerConnectionHealth)'
pnpm db:runner -- 'await db.select().from(deploymentHealth)'
```

Correlate a row with `gatewayProviderConnection(id: ...)`, `gatewayModelDeployment(id: ...)`, request details, and provider terminal events. Request evidence includes both physical IDs.

## Remediation

### Connection cooldown or terminal state

1. Inspect `last_error_type`, the safe message, and connection metadata.
2. Verify the connection base URL, auth style, secret reference, secret origin policy, and provider quota.
3. Update the connection through GraphQL or TOML when configuration is wrong.
4. After the credential, quota, or provider issue is fixed, call `resetGatewayProviderConnectionHealth` with the connection ID.
5. Send a controlled request through a logical model that targets the connection.
6. Confirm a successful provider event changes the connection to `healthy`.

### Deployment lockout or terminal state

1. Inspect the deployment's upstream model ID, region, capabilities, and native wire bindings.
2. Verify the provider credential can invoke that exact model or inference profile.
3. Update the deployment through GraphQL or TOML when its configuration is wrong.
4. After the model-access or provider issue is fixed, call `resetGatewayModelDeploymentHealth` with the deployment ID.
5. Send a controlled request through the affected logical model and operation.
6. Disable the target or deployment if the controlled request fails again.

### Bedrock stream permission

A successful non-streaming Converse request does not prove ConverseStream permission. A stream-permission failure excludes the deployment only from streaming requests, while non-streaming requests remain eligible. Verify IAM actions, region, inference-profile access, and the selected deployment ID, reset the deployment health, then prove recovery with a controlled streaming request. A failed proof recreates the lockout.

## Operational Safety

- Do not edit health rows directly. Use the audited reset mutations only after remediation is complete.
- Disable the target or physical resource through the gateway mutation service during remediation.
- Do not create a duplicate logical model to bypass a physical lockout.
- Keep provider secrets out of events, tickets, and diagnostic output.
- Use deployment and connection IDs in incident notes; provider/model strings are not unique physical identities.
