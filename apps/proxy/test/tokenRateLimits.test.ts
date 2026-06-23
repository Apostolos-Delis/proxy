import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeyLimitPolicies,
  defaultWorkspaceId,
  events,
  requests,
  routingConfigVersions
} from "@prompt-proxy/db";
import type { RoutingConfig } from "@prompt-proxy/schema";

import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("token rate limits", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("rejects API-key requests over the per-minute token cap before provider forwarding", async () => {
    const organizationId = "org_token_rate";
    const workspaceId = defaultWorkspaceId(organizationId);
    const apiKeyId = `${organizationId}:api-key:default`;
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(apiKeyLimitPolicies).values({
      id: "api_key_token_rate_policy",
      organizationId,
      workspaceId,
      apiKeyId,
      policy: {
        tokensPerMinute: 1
      }
    });

    const providerRecordsBefore = activeFixture.openai.records.length + activeFixture.anthropic.records.length;
    const response = await sendResponse("short request over token cap");
    const body = await response.json() as Record<string, unknown>;
    const rejectionEvents = await activeFixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "limit.token_rate_rejected"));
    const requestRows = await activeFixture.db.select().from(requests);

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "token_rate_limit",
      scope: "api_key",
      limit: 1
    });
    expect(Number(body.current)).toBeGreaterThan(1);
    expect(activeFixture.openai.records.length + activeFixture.anthropic.records.length).toBe(providerRecordsBefore);
    expect(rejectionEvents).toHaveLength(1);
    expect(rejectionEvents[0]?.payload).toMatchObject({
      reason: "token_rate_limit",
      limitType: "tokens_per_minute",
      scope: "api_key",
      limit: 1
    });
    expect(requestRows.every((row) => typeof row.metadata.tokenRateEstimate === "number")).toBe(true);

    function sendResponse(input: string) {
      if (!activeFixture) throw new Error("missing fixture");
      return fetch(`${activeFixture.proxyUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "router-hard",
          input,
          max_output_tokens: 60
        })
      });
    }
  });

  it("enforces token caps against route target output settings", async () => {
    const organizationId = "org_token_rate_route_cap";
    const workspaceId = defaultWorkspaceId(organizationId);
    const apiKeyId = `${organizationId}:api-key:default`;
    activeFixture = await captureFixture(organizationId);
    await setDefaultHardOutputCap(activeFixture, organizationId, 200);
    await activeFixture.db.insert(apiKeyLimitPolicies).values({
      id: "api_key_token_rate_route_cap_policy",
      organizationId,
      workspaceId,
      apiKeyId,
      policy: {
        tokensPerMinute: 100
      }
    });

    const providerRecordsBefore = activeFixture.openai.records.length + activeFixture.anthropic.records.length;
    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-hard",
        input: "small request with a route output cap",
        max_output_tokens: 1
      })
    });
    const body = await response.json() as Record<string, unknown>;
    const [requestRow] = await activeFixture.db.select().from(requests);

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "token_rate_limit",
      scope: "api_key",
      limit: 100
    });
    expect(Number(body.current)).toBeGreaterThanOrEqual(200);
    expect(Number(requestRow?.metadata.tokenRateEstimate)).toBeGreaterThanOrEqual(200);
    expect(activeFixture.openai.records.length + activeFixture.anthropic.records.length).toBe(providerRecordsBefore);
  });
});

async function setDefaultHardOutputCap(
  fixture: PromptTestFixture,
  organizationId: string,
  maxOutputTokens: number
) {
  const versionId = `${organizationId}:routing-config:default:v1`;
  const [version] = await fixture.db
    .select()
    .from(routingConfigVersions)
    .where(eq(routingConfigVersions.id, versionId))
    .limit(1);
  expect(version).toBeTruthy();
  const config = structuredClone(version!.config as RoutingConfig);
  config.routes.hard = {
    ...config.routes.hard,
    targets: config.routes.hard.targets.map((target) => ({ ...target, maxOutputTokens }))
  };
  await fixture.db
    .update(routingConfigVersions)
    .set({ config })
    .where(eq(routingConfigVersions.id, versionId));
}
