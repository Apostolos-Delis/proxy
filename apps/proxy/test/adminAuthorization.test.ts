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
      "query { providerAccounts { id name secretHint } }",
      "query { routingConfigs { id name } }",
      "query { search(query: \"debug\") { results { id title } } }",
      createApiKeyMutation
    ]) {
      const response = await adminGql(
        fixture.proxyUrl,
        headers,
        query,
        query === createApiKeyMutation ? { input: { name: "member-key" } } : undefined
      );
      expect(response.errors?.[0]?.message).toBe("admin_role_required");
      expect(response.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    }
  });

  it("allows admin users to manage API keys", async () => {
    const fixture = await setup("org_admin_authz_allowed");
    const headers = await headersForRole(fixture, ORGANIZATION_MEMBER_ROLES.ADMIN);

    const response = await adminGql(fixture.proxyUrl, headers, createApiKeyMutation, {
      input: { name: "admin-key" }
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.createApiKey.apiKey).toEqual(expect.objectContaining({ name: "admin-key" }));
    expect(response.data?.createApiKey.secret).toMatch(/^pp_/);
  });

  it("hides request routing internals and raw events from non-admin roles", async () => {
    const fixture = await setup("org_admin_authz_request_detail");
    await seedRequestDetail(fixture);
    const memberHeaders = await headersForRole(fixture, ORGANIZATION_MEMBER_ROLES.MEMBER);
    const query = `query RequestDetail($requestId: ID!) {
      request(requestId: $requestId) {
        request {
          requestId
          selectedCandidateId
          translated
          routeSkipReasons
          routingConfig { configId version configHash }
          classifier
        }
        events {
          eventId
          payload
        }
        routeDecisions {
          routeExecutionPlan
          selectedCandidateId
          translated
          translatorId
        }
        providerAttempts {
          routeCandidateId
          attemptIndex
          fallbackIndex
          skipReason
        }
        healthSkips
      }
    }`;

    const memberResponse = await adminGql(fixture.proxyUrl, memberHeaders, query, {
      requestId: "request_sanitized"
    });
    expect(memberResponse.errors).toBeUndefined();
    expect(memberResponse.data?.request.request).toEqual(expect.objectContaining({
      requestId: "request_sanitized",
      selectedCandidateId: null,
      translated: null,
      routeSkipReasons: [],
      routingConfig: null,
      classifier: null
    }));
    expect(memberResponse.data?.request.events).toEqual([]);
    expect(memberResponse.data?.request.routeDecisions).toEqual([]);
    expect(memberResponse.data?.request.providerAttempts).toEqual([]);
    expect(memberResponse.data?.request.healthSkips).toEqual([]);

    const adminResponse = await adminGql(fixture.proxyUrl, fixture.adminHeaders, query, {
      requestId: "request_sanitized"
    });
    expect(adminResponse.errors).toBeUndefined();
    expect(adminResponse.data?.request.request.routingConfig).toEqual(expect.objectContaining({
      configId: "org_admin_authz_request_detail:routing-config:default"
    }));
    expect(adminResponse.data?.request.request).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_0",
      translated: false,
      routeSkipReasons: []
    }));
    expect(adminResponse.data?.request.request.classifier).toEqual(expect.objectContaining({
      model: "route-classifier-cheap"
    }));
    expect(adminResponse.data?.request.events[0].payload).toEqual(expect.objectContaining({
      internalHint: "sensitive-routing-context"
    }));
    expect(adminResponse.data?.request.routeDecisions[0]).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_0",
      translated: false,
      translatorId: null,
      routeExecutionPlan: expect.objectContaining({
        schemaVersion: 1
      })
    }));
    expect(adminResponse.data?.request.providerAttempts[0]).toEqual({
      routeCandidateId: "candidate_0",
      attemptIndex: 0,
      fallbackIndex: 0,
      skipReason: null
    });
    expect(adminResponse.data?.request.healthSkips).toEqual([
      {
        scope: "provider_account",
        provider: "openai",
        providerId: "00000000-0000-0000-0000-000000000001",
        providerAccountId: "account_sanitized",
        model: "gpt-fast",
        healthStatus: "cooldown",
        errorType: "rate_limited",
        expiresAt: "2026-06-08T12:05:00.000Z"
      }
    ]);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});

async function seedRequestDetail(fixture: PromptTestFixture) {
  const organizationId = fixture.config.defaultOrganizationId;
  const routingConfigId = `${organizationId}:routing-config:default`;
  const createdAt = new Date("2026-06-08T12:00:00.000Z");
  await fixture.db.insert(requests).values({
    ...usageRequest("request_sanitized", organizationId, "local-user", "", "openai-responses", createdAt),
    sessionId: null,
    routingConfigId,
    routingConfigVersionId: `${routingConfigId}:v1`,
    routingConfigVersion: 1,
    routingConfigHash: "sha256:sanitized-request"
  });
  await fixture.db.insert(routeDecisions).values({
    ...usageDecision("decision_sanitized", "request_sanitized", organizationId, "fast", "openai", "gpt-fast"),
    routingConfigId,
    routingConfigVersionId: `${routingConfigId}:v1`,
    routingConfigVersion: 1,
    routingConfigHash: "sha256:sanitized-decision",
    classifier: {
      model: "route-classifier-cheap",
      confidence: 0.82,
      reasonCodes: ["sensitive-internal-signal"]
    },
    routeExecutionPlan: requestRouteExecutionPlan(organizationId) as never,
    selectedCandidateId: "candidate_0",
    translated: false
  });
  await fixture.db.insert(providerAttempts).values({
    id: "attempt_sanitized",
    requestId: "request_sanitized",
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    surface: "openai-responses",
    provider: "openai",
    model: "gpt-fast",
    terminalStatus: "completed",
    routeCandidateId: "candidate_0",
    attemptIndex: 0,
    fallbackIndex: 0
  });
  await fixture.db.insert(events).values({
    ...sessionEvent("event_sanitized", organizationId, "request_sanitized", "session_sanitized", createdAt),
    eventType: "routing.decision_recorded",
    payload: {
      surface: "openai-responses",
      requestedModel: "router-auto",
      internalHint: "sensitive-routing-context",
      healthSkips: [
        {
          scope: "provider_account",
          provider: "openai",
          providerId: "00000000-0000-0000-0000-000000000001",
          providerAccountId: "account_sanitized",
          model: "gpt-fast",
          healthStatus: "cooldown",
          errorType: "rate_limited",
          expiresAt: "2026-06-08T12:05:00.000Z",
          rawError: "upstream secret error text"
        }
      ]
    }
  });
}

function requestRouteExecutionPlan(organizationId: string) {
  const routingConfigId = `${organizationId}:routing-config:default`;
  return {
    schemaVersion: 1,
    requestId: "request_sanitized",
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    apiKeyId: "api_key_sanitized",
    surface: "openai-responses",
    dialect: "openai-responses",
    classifier: {
      provider: "openai",
      model: "route-classifier-cheap",
      route: "fast",
      confidence: 0.82,
      attempts: 1,
      dataMode: "metadata"
    },
    routingConfig: {
      id: routingConfigId,
      versionId: `${routingConfigId}:v1`,
      version: 1,
      hash: "sha256:sanitized-decision"
    },
    candidates: [
      {
        id: "candidate_0",
        order: 0,
        providerId: "openai",
        providerAccountIds: [],
        model: "gpt-fast",
        endpointDialect: "openai-responses",
        translated: false,
        translatorId: null,
        compatible: true,
        eligible: true,
        skipReasons: [],
        factors: {
          nativeDialect: true,
          capabilityMatch: true,
          contextWindowOk: null,
          providerHealthy: null,
          accountAvailable: true,
          budgetAllowed: null,
          rateLimitAllowed: null,
          sessionAffinityMatch: null
        }
      }
    ],
    selected: {
      candidateId: "candidate_0",
      providerId: "openai",
      providerAccountId: null,
      model: "gpt-fast",
      dialect: "openai-responses",
      translated: false
    },
    policyResults: []
  };
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
