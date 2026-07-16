import { afterEach, describe, expect, it } from "vitest";

import {
  defaultWorkspaceId,
  events,
  organizationMembers,
  providerAttempts,
  requests,
  routeDecisions,
  users
} from "@proxy/db";
import { ORGANIZATION_MEMBER_ROLES, type OrganizationMemberRole } from "@proxy/schema";

import { adminGql, captureFixture, sessionEvent, usageDecision, usageRequest, type PromptTestFixture } from "./promptTestFixture.js";

const createApiKeyMutation = `mutation CreateApiKey($input: CreateApiKeyInput!) {
  createApiKey(input: $input) { apiKey { id name } secret }
}`;

describe("admin authorization", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("allows active lower-privilege users to read non-sensitive overview data", async () => {
    const fixture = await setup("org_admin_authz_read");
    const headers = await headersForRole(fixture, ORGANIZATION_MEMBER_ROLES.VIEWER);

    const response = await adminGql(
      fixture.proxyUrl,
      headers,
      "query { overview { organizationId requestCount } }"
    );

    expect(response.errors).toBeUndefined();
    expect(response.data?.overview.organizationId).toBe("org_admin_authz_read");
  });

  it("rejects sensitive queries and mutations for non-admin roles", async () => {
    const fixture = await setup("org_admin_authz_denied");
    const headers = await headersForRole(fixture, ORGANIZATION_MEMBER_ROLES.MEMBER);

    for (const query of [
      "query { prompts { data { artifactId preview } } }",
      "query { apiKeys { id name } }",
      "query { gatewayProviderConnections { id name secretRef } }",
      "query { gatewayModelDeployments { id name pricing } }",
      "query { search(query: \"debug\") { results { id title } } }",
      createApiKeyMutation
    ]) {
      const response = await adminGql(
        fixture.proxyUrl,
        headers,
        query,
        query === createApiKeyMutation
          ? { input: { name: "member-key", accessProfileId: engineerAccessProfileId("org_admin_authz_denied") } }
          : undefined
      );
      expect(response.errors?.[0]?.message).toBe("admin_role_required");
      expect(response.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    }
  });

  it("allows admin users to manage API keys", async () => {
    const fixture = await setup("org_admin_authz_allowed");
    const headers = await headersForRole(fixture, ORGANIZATION_MEMBER_ROLES.ADMIN);

    const response = await adminGql(fixture.proxyUrl, headers, createApiKeyMutation, {
      input: {
        name: "admin-key",
        accessProfileId: engineerAccessProfileId("org_admin_authz_allowed")
      }
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.createApiKey.apiKey).toEqual(expect.objectContaining({ name: "admin-key" }));
    expect(response.data?.createApiKey.secret).toMatch(/^pp_/);
  });

  it("hides gateway decision payloads and raw events from non-admin roles", async () => {
    const fixture = await setup("org_admin_authz_request_detail");
    await seedRequestDetail(fixture);
    const memberHeaders = await headersForRole(fixture, ORGANIZATION_MEMBER_ROLES.MEMBER);
    const query = `query RequestDetail($requestId: ID!) {
      request(requestId: $requestId) {
        request {
          requestId
          requestedLogicalModel
          resolvedLogicalModelId
          accessProfileId
          deploymentId
          providerConnectionId
          routerDecision
          translated
        }
        events {
          eventId
          payload
        }
        routeDecisions {
          requestedLogicalModel
          resolvedLogicalModelId
          accessProfileId
          deploymentId
          providerConnectionId
          routerDecision
          translated
          translatorId
        }
        providerAttempts {
          deploymentId
          providerConnectionId
          adapterClassification
        }
      }
    }`;

    const memberResponse = await adminGql(fixture.proxyUrl, memberHeaders, query, {
      requestId: "request_sanitized"
    });
    expect(memberResponse.errors).toBeUndefined();
    expect(memberResponse.data?.request.request).toEqual(expect.objectContaining({
      requestId: "request_sanitized",
      requestedLogicalModel: "coding-auto",
      resolvedLogicalModelId: expect.stringContaining("logical-model:coding-auto"),
      accessProfileId: expect.stringContaining("access-profile:opendoor-engineer"),
      deploymentId: expect.stringContaining("deployment:openai:gpt-5.4-mini"),
      providerConnectionId: expect.stringContaining("connection:openai"),
      routerDecision: {},
      translated: null
    }));
    expect(memberResponse.data?.request.events).toEqual([]);
    expect(memberResponse.data?.request.routeDecisions).toEqual([]);
    expect(memberResponse.data?.request.providerAttempts).toEqual([]);

    const adminResponse = await adminGql(fixture.proxyUrl, fixture.adminHeaders, query, {
      requestId: "request_sanitized"
    });
    expect(adminResponse.errors).toBeUndefined();
    expect(adminResponse.data?.request.request).toEqual(expect.objectContaining({
      translated: false,
      routerDecision: expect.objectContaining({
        kind: "classifier",
        selectedTargetId: "target_sanitized"
      })
    }));
    expect(adminResponse.data?.request.events[0].payload).toEqual(expect.objectContaining({
      internalHint: "sensitive-routing-context"
    }));
    expect(adminResponse.data?.request.routeDecisions[0]).toEqual(expect.objectContaining({
      requestedLogicalModel: "coding-auto",
      resolvedLogicalModelId: expect.stringContaining("logical-model:coding-auto"),
      deploymentId: expect.stringContaining("deployment:openai:gpt-5.4-mini"),
      providerConnectionId: expect.stringContaining("connection:openai"),
      routerDecision: expect.objectContaining({ selectedTargetId: "target_sanitized" }),
      translated: false,
      translatorId: null
    }));
    expect(adminResponse.data?.request.providerAttempts[0]).toEqual({
      deploymentId: expect.stringContaining("deployment:openai:gpt-5.4-mini"),
      providerConnectionId: expect.stringContaining("connection:openai"),
      adapterClassification: { errorClass: "none" }
    });
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});

function engineerAccessProfileId(organizationId: string) {
  return `${defaultWorkspaceId(organizationId)}:access-profile:opendoor-engineer`;
}

async function seedRequestDetail(fixture: PromptTestFixture) {
  const organizationId = fixture.config.defaultOrganizationId;
  const workspaceId = defaultWorkspaceId(organizationId);
  const logicalModelId = `${workspaceId}:logical-model:coding-auto`;
  const accessProfileId = `${workspaceId}:access-profile:opendoor-engineer`;
  const deploymentId = `${workspaceId}:deployment:openai:gpt-5.4-mini`;
  const providerConnectionId = `${workspaceId}:connection:openai`;
  const routerDecision = {
    kind: "classifier",
    classifierDeploymentId: `${workspaceId}:deployment:openai:route-classifier-cheap`,
    selectedTargetId: "target_sanitized",
    attempts: 1,
    reasonCodes: ["sensitive-internal-signal"],
    confidence: 0.82
  };
  const createdAt = new Date("2026-06-08T12:00:00.000Z");
  await fixture.db.insert(requests).values({
    ...usageRequest("request_sanitized", organizationId, "local-user", "", "openai-responses", createdAt),
    sessionId: null,
    resolvedLogicalModelId: logicalModelId,
    accessProfileId,
    routerKind: "classifier",
    deploymentId,
    providerConnectionId,
    egressWireId: "openai-responses",
    wireAdapterVersion: "1"
  });
  await fixture.db.insert(routeDecisions).values({
    ...usageDecision("decision_sanitized", "request_sanitized", organizationId, "openai-responses", "openai", "gpt-fast"),
    selectedModel: "gpt-5.4-mini",
    resolvedLogicalModelId: logicalModelId,
    accessProfileId,
    routerKind: "classifier",
    deploymentId,
    providerConnectionId,
    egressWireId: "openai-responses",
    wireAdapterVersion: "1",
    routerDecisionId: "router_decision_sanitized",
    routerDecision,
    translated: false
  });
  await fixture.db.insert(providerAttempts).values({
    id: "attempt_sanitized",
    requestId: "request_sanitized",
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    surface: "openai-responses",
    provider: "openai",
    model: "gpt-5.4-mini",
    deploymentId,
    providerConnectionId,
    egressWireId: "openai-responses",
    providerAdapterContractVersion: "1",
    adapterClassification: { errorClass: "none" },
    terminalStatus: "completed",
  });
  await fixture.db.insert(events).values({
    ...sessionEvent("event_sanitized", organizationId, "request_sanitized", "session_sanitized", createdAt),
    eventType: "gateway.resolution_succeeded",
    payload: {
      surface: "openai-responses",
      requestedModel: "coding-auto",
      internalHint: "sensitive-routing-context",
      routerDecision
    }
  });
}

async function headersForRole(fixture: PromptTestFixture, role: OrganizationMemberRole) {
  const userId = `${role}-user`;
  await fixture.db.insert(users).values({
    id: userId,
    email: `${role}@example.com`,
    name: `${role} user`
  });
  await fixture.db.insert(organizationMembers).values({
    organizationId: fixture.config.defaultOrganizationId,
    userId,
    role
  });
  const session = await fixture.persistence.adminSessions.create({
    organizationId: fixture.config.defaultOrganizationId,
    userId,
    ttlSeconds: 3600
  });
  expect(session).not.toBeNull();
  return {
    cookie: `${fixture.config.adminSessionCookieName}=${encodeURIComponent(session?.token ?? "")}`
  };
}
