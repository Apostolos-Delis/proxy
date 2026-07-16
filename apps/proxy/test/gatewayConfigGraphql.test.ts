import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  accessProfileModelGrants,
  accessProfiles,
  apiKeys,
  defaultWorkspaceId,
  deploymentHealth,
  eventOutbox,
  events,
  organizationMembers,
  providerConnectionHealth,
  users
} from "@proxy/db";

import type { ProxyEvent } from "../src/events.js";
import { parseGatewayConfigDocument } from "../src/persistence/gatewayConfigDocument.js";
import { applyGatewayConfig } from "../src/persistence/gatewayConfigPlan.js";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

let activeFixture: PromptTestFixture | undefined;

describe("gateway configuration GraphQL", () => {
  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("authors and reads the complete gateway resource graph without exposing secret material", async () => {
    const fixture = await setup("org_gateway_graphql_crud");
    const connection = await mutation(fixture, `
      mutation Create($input: CreateGatewayProviderConnectionInput!) {
        value: createGatewayProviderConnection(input: $input) {
          id provider slug name baseUrl capabilities secretRef secretHint credentialConfigured enabled
        }
      }
    `, {
      input: {
        provider: "openai",
        slug: "graphql-openai",
        name: "GraphQL OpenAI",
        adapterKind: "generic-http-json",
        authStyle: "bearer",
        baseUrl: fixture.openai.url,
        secret: "sk-graphql-openai-key",
        capabilities: { efforts: ["low", "medium", "high"] },
        enabled: true
      }
    });
    expect(connection).toMatchObject({
      provider: "openai",
      slug: "graphql-openai",
      capabilities: { efforts: ["low", "medium", "high"] },
      secretRef: null,
      secretHint: "••••-key",
      credentialConfigured: true,
      enabled: true
    });

    const canonical = await mutation(fixture, `
      mutation Create($input: CreateGatewayCanonicalModelInput!) {
        value: createGatewayCanonicalModel(input: $input) { id slug capabilities enabled }
      }
    `, {
      input: {
        slug: "graphql-model",
        name: "GraphQL Model",
        vendor: "acme",
        family: "graphql-1",
        capabilities: { tools: true, contextWindow: 200000 },
        enabled: true
      }
    });
    const deployment = await mutation(fixture, `
      mutation Create($input: CreateGatewayModelDeploymentInput!) {
        value: createGatewayModelDeployment(input: $input) { id slug canonicalModelId providerConnectionId enabled }
      }
    `, {
      input: {
        slug: "graphql-deployment",
        name: "GraphQL Deployment",
        canonicalModelId: canonical.id,
        providerConnectionId: connection.id,
        upstreamModelId: "graphql-model-v1",
        capabilities: { tools: false, contextWindow: 128000 },
        enabled: true
      }
    });
    const binding = await mutation(fixture, `
      mutation Create($input: CreateGatewayWireBindingInput!) {
        value: createGatewayWireBinding(input: $input) { id deploymentId apiWireId endpointPath enabled }
      }
    `, {
      input: {
        deploymentId: deployment.id,
        apiWireId: "openai-responses",
        endpointPath: "/responses",
        enabled: true
      }
    });
    const logicalEventOffset = fixture.persistence.eventService.listEvents().length;
    const logicalModel = await mutation(fixture, `
      mutation Create($input: CreateGatewayLogicalModelInput!) {
        value: createGatewayLogicalModel(input: $input) { id slug resolutionKind enabled }
      }
    `, {
      input: {
        slug: "graphql-direct",
        name: "GraphQL Direct",
        resolutionKind: "direct",
        enabled: true,
        initialTargets: [{ deploymentId: deployment.id, priority: 0, enabled: true }]
      }
    });
    const scope = {
      organizationId: fixture.config.defaultOrganizationId,
      workspaceId: defaultWorkspaceId(fixture.config.defaultOrganizationId)
    };
    const target = (await fixture.persistence.gatewayConfigAdmin.logicalModelTargets(scope))
      .find((row) => row.logicalModelId === logicalModel.id)!;
    const activeReadiness = await modelReadiness(fixture);
    expect(activeReadiness.deployments.find((row) => row.deploymentId === deployment.id)).toMatchObject({
      available: true,
      classifierCapable: true,
      reasonCodes: [],
      classifierReasonCodes: []
    });
    expect(activeReadiness.logicalModels.find((row) => row.logicalModelId === logicalModel.id)).toMatchObject({
      available: true,
      reasonCodes: []
    });
    const graphqlLifecycle = fixture.persistence.eventService.listEvents().slice(logicalEventOffset);
    const tomlEventOffset = fixture.persistence.eventService.listEvents().length;
    await applyGatewayConfig(
      fixture.persistence.gatewayConfigAdmin,
      parseGatewayConfigDocument(`
version = 1
[scope]
organization_id = "${scope.organizationId}"
workspace_id = "${scope.workspaceId}"
[[logical_models]]
slug = "toml-direct"
name = "TOML Direct"
resolution_kind = "direct"
enabled = true
[[logical_model_targets]]
logical_model = "toml-direct"
deployment = "graphql-deployment"
priority = 0
enabled = true
`),
      fixture.config.seedUserId
    );
    const tomlLifecycle = fixture.persistence.eventService.listEvents().slice(tomlEventOffset);
    expect(normalizeLogicalLifecycle(tomlLifecycle)).toEqual(normalizeLogicalLifecycle(graphqlLifecycle));
    const profile = await mutation(fixture, `
      mutation Create($input: CreateGatewayAccessProfileInput!) {
        value: createGatewayAccessProfile(input: $input) { id slug limits enabled }
      }
    `, {
      input: {
        slug: "graphql-profile",
        name: "GraphQL Profile",
        limits: { requests_per_minute: 60 },
        enabled: true,
        initialGrants: [{
          logicalModelId: logicalModel.id,
          allowedOperations: ["text.generate", "model.list"],
          enabled: true
        }]
      }
    });
    const grant = (await fixture.persistence.gatewayConfigAdmin.modelGrants(scope))
      .find((row) => row.accessProfileId === profile.id)!;
    const apiKeyId = `${fixture.config.defaultOrganizationId}:api-key:default`;
    const assignment = await mutation(fixture, `mutation Assign($apiKeyId: ID!, $accessProfileId: ID!) {
      value: assignGatewayApiKeyAccessProfile(apiKeyId: $apiKeyId, accessProfileId: $accessProfileId) {
        apiKeyId accessProfileId
      }
    }`, { apiKeyId, accessProfileId: profile.id });
    expect(assignment).toEqual({ apiKeyId, accessProfileId: profile.id });

    const updated = await mutation(fixture, `mutation Update($input: UpdateGatewayProviderConnectionInput!) {
      value: updateGatewayProviderConnection(input: $input) { id name secretRef credentialConfigured }
    }`, { input: { id: connection.id, name: "GraphQL OpenAI Updated" } });
    expect(updated).toMatchObject({
      name: "GraphQL OpenAI Updated",
      secretRef: null,
      credentialConfigured: true
    });

    await fixture.db.insert(providerConnectionHealth).values({
      id: "connection_health_graphql",
      organizationId: fixture.config.defaultOrganizationId,
      workspaceId: scope.workspaceId,
      providerConnectionId: connection.id,
      status: "terminal",
      lastErrorType: "auth_invalid"
    });
    await fixture.db.insert(deploymentHealth).values({
      id: "deployment_health_graphql",
      organizationId: fixture.config.defaultOrganizationId,
      workspaceId: scope.workspaceId,
      deploymentId: deployment.id,
      providerConnectionId: connection.id,
      status: "terminal",
      lastErrorType: "model_access_denied"
    });
    const unhealthyReadiness = await modelReadiness(fixture);
    expect(unhealthyReadiness.deployments.find((row) => row.deploymentId === deployment.id)).toMatchObject({
      available: false,
      classifierCapable: false,
      reasonCodes: ["provider_connection_unhealthy", "deployment_unhealthy"],
      classifierReasonCodes: ["provider_connection_unhealthy", "deployment_unhealthy"]
    });
    expect(unhealthyReadiness.logicalModels.find((row) => row.logicalModelId === logicalModel.id)).toMatchObject({
      available: false,
      reasonCodes: ["target_unavailable"]
    });
    const resetEventOffset = fixture.persistence.eventService.listEvents().length;
    await mutation(fixture, `mutation Reset($id: ID!) {
      value: resetGatewayProviderConnectionHealth(id: $id) { id }
    }`, { id: connection.id });
    await mutation(fixture, `mutation Reset($id: ID!) {
      value: resetGatewayModelDeploymentHealth(id: $id) { id }
    }`, { id: deployment.id });
    expect(await fixture.db.select().from(providerConnectionHealth)
      .where(eq(providerConnectionHealth.providerConnectionId, connection.id))).toEqual([]);
    expect(await fixture.db.select().from(deploymentHealth)
      .where(eq(deploymentHealth.deploymentId, deployment.id))).toEqual([]);
    expect((await modelReadiness(fixture)).deployments.find((row) => row.deploymentId === deployment.id))
      .toMatchObject({ available: true, classifierCapable: true });
    expect(fixture.persistence.eventService.listEvents().slice(resetEventOffset).map((event) => event.eventType)).toEqual([
      "gateway_config.provider_connection.health_reset",
      "gateway_config.model_deployment.health_reset"
    ]);

    const deploymentSecret = "sk-graphql-deployment-leak";
    const rejectedDeploymentConfig = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Update($input: UpdateGatewayModelDeploymentInput!) {
        updateGatewayModelDeployment(input: $input) { id config }
      }`,
      { input: { id: deployment.id, config: { nested: { apiKey: deploymentSecret } } } }
    );
    expect(rejectedDeploymentConfig.errors?.[0]?.message).toBe("gateway_config_secret_forbidden");
    expect(rejectedDeploymentConfig.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(JSON.stringify(rejectedDeploymentConfig)).not.toContain(deploymentSecret);

    const pricingSecret = "sk-graphql-pricing-leak";
    const rejectedDeploymentPricing = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Update($input: UpdateGatewayModelDeploymentInput!) {
        updateGatewayModelDeployment(input: $input) { id pricing }
      }`,
      { input: { id: deployment.id, pricing: { tokenValue: pricingSecret } } }
    );
    expect(rejectedDeploymentPricing.errors?.[0]?.message).toBe("invalid_model_deployment");
    expect(rejectedDeploymentPricing.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(JSON.stringify(rejectedDeploymentPricing)).not.toContain(pricingSecret);

    const bindingSecret = "sk-graphql-binding-leak";
    const rejectedBindingConfig = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Update($input: UpdateGatewayWireBindingInput!) {
        updateGatewayWireBinding(input: $input) { id requestConfig }
      }`,
      { input: { id: binding.id, requestConfig: { nested: { password: bindingSecret } } } }
    );
    expect(rejectedBindingConfig.errors?.[0]?.message).toBe("gateway_config_secret_forbidden");
    expect(rejectedBindingConfig.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(JSON.stringify(rejectedBindingConfig)).not.toContain(bindingSecret);

    const listed = await adminGql(fixture.proxyUrl, fixture.adminHeaders, `query GatewayConfig {
      gatewayProviderConnections { id slug name credentialConfigured }
      gatewayCanonicalModel(id: "${canonical.id}") { id slug }
      gatewayModelDeployment(id: "${deployment.id}") { id slug config pricing }
      gatewayWireBinding(id: "${binding.id}") { id apiWireId requestConfig }
      gatewayLogicalModel(id: "${logicalModel.id}") { id slug enabled }
      gatewayLogicalModelTarget(id: "${target.id}") { id priority }
      gatewayAccessProfile(id: "${profile.id}") { id slug }
      gatewayModelGrant(id: "${grant.id}") { id allowedOperations }
    }`);
    expect(listed.errors).toBeUndefined();
    expect(listed.data?.gatewayProviderConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: connection.id, name: "GraphQL OpenAI Updated" })
    ]));
    expect(listed.data?.gatewayModelDeployment).toMatchObject({ config: {} });
    expect(listed.data?.gatewayModelDeployment).toMatchObject({ pricing: {} });
    expect(listed.data?.gatewayWireBinding).toMatchObject({ requestConfig: {} });
    expect(JSON.stringify(listed)).not.toContain("sk-graphql-");

    const forbiddenField = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { gatewayProviderConnections { id secretCiphertext } }"
    );
    expect(forbiddenField.errors?.[0]?.message).toContain("Cannot query field \"secretCiphertext\"");

    const disabled = await mutation(fixture, `mutation Disable($id: ID!) {
      value: disableGatewayModelGrant(id: $id) { id enabled }
    }`, { id: grant.id });
    expect(disabled).toEqual({ id: grant.id, enabled: false });
  });

  it("requires an admin role for gateway mutations and exposes every resource lifecycle operation", async () => {
    const fixture = await setup("org_gateway_graphql_auth");
    const memberHeaders = await headersForMember(fixture);
    const denied = await adminGql(fixture.proxyUrl, memberHeaders, `mutation Create($input: CreateGatewayAccessProfileInput!) {
      createGatewayAccessProfile(input: $input) { id }
    }`, { input: { slug: "forbidden", name: "Forbidden" } });
    expect(denied.errors?.[0]?.message).toBe("admin_role_required");
    expect(denied.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

    const deniedRead = await adminGql(fixture.proxyUrl, memberHeaders, "query { gatewayAccessProfiles { id } }");
    expect(deniedRead.errors?.[0]?.message).toBe("admin_role_required");
    expect(deniedRead.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

    const introspection = await adminGql(fixture.proxyUrl, fixture.adminHeaders, `query {
      __schema { mutationType { fields { name } } }
    }`);
    expect(introspection.errors).toBeUndefined();
    const fields = introspection.data?.__schema.mutationType.fields.map((field: { name: string }) => field.name);
    for (const resource of [
      "ProviderConnection",
      "CanonicalModel",
      "ModelDeployment",
      "WireBinding",
      "LogicalModel",
      "LogicalModelTarget",
      "AccessProfile",
      "ModelGrant"
    ]) {
      expect(fields).toEqual(expect.arrayContaining([
        `createGateway${resource}`,
        `updateGateway${resource}`,
        `enableGateway${resource}`,
        `disableGateway${resource}`
      ]));
    }
    expect(fields).toContain("assignGatewayApiKeyAccessProfile");
    expect(fields).toContain("createGatewayApiKeyWithModels");
    expect(fields).toEqual(expect.arrayContaining([
      "resetGatewayProviderConnectionHealth",
      "resetGatewayModelDeploymentHealth"
    ]));
  });

  it("rolls back the profile graph when atomic key issuance fails", async () => {
    const fixture = await setup("org_gateway_graphql_atomic_key");
    const scope = {
      organizationId: fixture.config.defaultOrganizationId,
      workspaceId: defaultWorkspaceId(fixture.config.defaultOrganizationId)
    };
    const model = (await fixture.persistence.gatewayConfigAdmin.logicalModels(scope))
      .find((row) => row.slug === "fable")!;
    const before = {
      profiles: (await fixture.db.select().from(accessProfiles)).length,
      grants: (await fixture.db.select().from(accessProfileModelGrants)).length,
      keys: (await fixture.db.select().from(apiKeys)).length,
      events: (await fixture.db.select().from(events)).length,
      outbox: (await fixture.db.select().from(eventOutbox)).length,
      mirroredEvents: fixture.persistence.eventService.listEvents().length
    };

    await expect(fixture.persistence.gatewayConfigAdmin.createApiKeyWithModels({
      ...scope,
      actorUserId: "missing-user",
      name: "Rollback key",
      logicalModelIds: [model.id]
    })).rejects.toThrow();

    expect({
      profiles: (await fixture.db.select().from(accessProfiles)).length,
      grants: (await fixture.db.select().from(accessProfileModelGrants)).length,
      keys: (await fixture.db.select().from(apiKeys)).length,
      events: (await fixture.db.select().from(events)).length,
      outbox: (await fixture.db.select().from(eventOutbox)).length,
      mirroredEvents: fixture.persistence.eventService.listEvents().length
    }).toEqual(before);
  });
});

async function setup(organizationId: string) {
  activeFixture = await captureFixture(organizationId, "raw_text", false, {
    envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" }
  });
  return activeFixture;
}

async function mutation(
  fixture: PromptTestFixture,
  query: string,
  variables: Record<string, unknown>
) {
  const response = await adminGql(fixture.proxyUrl, fixture.adminHeaders, query, variables);
  expect(response.errors).toBeUndefined();
  return response.data!.value;
}

async function headersForMember(fixture: PromptTestFixture) {
  const userId = "gateway-member";
  await fixture.db.insert(users).values({
    id: userId,
    email: "gateway-member@example.com",
    name: "Gateway Member"
  });
  await fixture.db.insert(organizationMembers).values({
    organizationId: fixture.config.defaultOrganizationId,
    userId,
    role: "member"
  });
  const session = await fixture.persistence.adminSessions.create({
    organizationId: fixture.config.defaultOrganizationId,
    userId,
    ttlSeconds: 3_600
  });
  return { cookie: `${fixture.config.adminSessionCookieName}=${encodeURIComponent(session!.token)}` };
}

async function modelReadiness(fixture: PromptTestFixture) {
  const response = await adminGql(fixture.proxyUrl, fixture.adminHeaders, `query {
    gatewayModelReadiness {
      deployments { deploymentId available classifierCapable reasonCodes classifierReasonCodes }
      logicalModels { logicalModelId available reasonCodes }
    }
  }`);
  expect(response.errors).toBeUndefined();
  return response.data!.gatewayModelReadiness as {
    deployments: Array<{
      deploymentId: string;
      available: boolean;
      classifierCapable: boolean;
      reasonCodes: string[];
      classifierReasonCodes: string[];
    }>;
    logicalModels: Array<{ logicalModelId: string; available: boolean; reasonCodes: string[] }>;
  };
}

function normalizeLogicalLifecycle(events: ProxyEvent[]) {
  return events.map((event) => {
    const payload = { ...event.payload };
    delete payload.id;
    delete payload.slug;
    delete payload.name;
    delete payload.logicalModelId;
    return { eventType: event.eventType, payload };
  });
}
