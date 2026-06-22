import { afterEach, describe, expect, it } from "vitest";

import {
  activeRequestLimits,
  apiKeyLimitPolicies,
  budgetWindows,
  defaultWorkspaceId,
  events,
  workspaceLimitPolicies
} from "@prompt-proxy/db";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("limits dashboard GraphQL", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("returns policies, active requests, budget windows, and rejection events", async () => {
    const organizationId = "org_limits_dashboard";
    const workspaceId = defaultWorkspaceId(organizationId);
    const apiKeyId = `${organizationId}:api-key:default`;
    const now = new Date("2026-06-19T12:00:00.000Z");
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(workspaceLimitPolicies).values({
      id: "workspace_policy_dashboard",
      organizationId,
      workspaceId,
      policy: {
        requestsPerMinute: 100
      },
      createdAt: now,
      updatedAt: now
    });
    await activeFixture.db.insert(apiKeyLimitPolicies).values({
      id: "api_key_policy_dashboard",
      organizationId,
      workspaceId,
      apiKeyId,
      policy: {
        parallelRequests: 5
      },
      createdAt: now,
      updatedAt: now
    });
    await activeFixture.db.insert(activeRequestLimits).values({
      id: "active_limit_dashboard",
      organizationId,
      workspaceId,
      apiKeyId,
      requestId: "request_active_dashboard",
      startedAt: now,
      expiresAt: new Date("2026-06-19T12:10:00.000Z")
    });
    await activeFixture.db.insert(budgetWindows).values({
      id: "budget_dashboard",
      organizationId,
      workspaceId,
      scopeType: "workspace",
      scopeId: workspaceId,
      windowType: "daily",
      periodStartAt: now,
      periodEndAt: new Date("2026-06-20T12:00:00.000Z"),
      limitUsd: "25",
      reservedUsd: "3.5",
      actualUsd: "2.25",
      createdAt: now,
      updatedAt: now
    });
    await activeFixture.db.insert(events).values({
      id: "event_budget_rejected_dashboard",
      sequence: 1,
      schemaVersion: 1,
      organizationId,
      workspaceId,
      scopeType: "request",
      scopeId: "request_rejected_dashboard",
      correlationId: "request_rejected_dashboard",
      actorType: "system",
      actorId: apiKeyId,
      producer: "prompt-proxy.limits",
      eventType: "budget.rejected",
      payloadHash: "sha256:budget-rejected-dashboard",
      sensitivity: "internal",
      redactionState: "none",
      payload: {
        scopeType: "workspace",
        limitUsd: 25,
        actualUsd: 26
      },
      createdAt: now
    });

    const result = await adminGql(
      activeFixture.proxyUrl,
      activeFixture.adminHeaders,
      `query LimitsDashboard {
        limitsDashboard {
          workspacePolicies { id policy createdAt }
          apiKeyPolicies { id apiKeyId apiKeyName policy }
          activeRequests { id requestId apiKeyId apiKeyName startedAt expiresAt }
          budgetWindows { id scopeType scopeId windowType limitUsd reservedUsd actualUsd }
          rejectionEvents { eventId eventType scopeId payload }
        }
      }`
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.limitsDashboard).toMatchObject({
      workspacePolicies: [{
        id: "workspace_policy_dashboard",
        policy: { requestsPerMinute: 100 },
        createdAt: "2026-06-19T12:00:00.000Z"
      }],
      apiKeyPolicies: [{
        id: "api_key_policy_dashboard",
        apiKeyId,
        apiKeyName: "Default local API key",
        policy: { parallelRequests: 5 }
      }],
      activeRequests: [{
        id: "active_limit_dashboard",
        requestId: "request_active_dashboard",
        apiKeyId,
        apiKeyName: "Default local API key",
        startedAt: "2026-06-19T12:00:00.000Z",
        expiresAt: "2026-06-19T12:10:00.000Z"
      }],
      budgetWindows: [{
        id: "budget_dashboard",
        scopeType: "workspace",
        scopeId: workspaceId,
        windowType: "daily",
        limitUsd: 25,
        reservedUsd: 3.5,
        actualUsd: 2.25
      }],
      rejectionEvents: [{
        eventId: "event_budget_rejected_dashboard",
        eventType: "budget.rejected",
        scopeId: "request_rejected_dashboard",
        payload: {
          scopeType: "workspace",
          limitUsd: 25,
          actualUsd: 26
        }
      }]
    });
  });
});
