import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeyLimitPolicies,
  defaultWorkspaceId,
  events
} from "@prompt-proxy/db";

import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("request rate limits", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("rejects API-key requests over the per-minute cap before provider forwarding", async () => {
    const organizationId = "org_request_rate";
    const workspaceId = defaultWorkspaceId(organizationId);
    const apiKeyId = `${organizationId}:api-key:default`;
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(apiKeyLimitPolicies).values({
      id: "api_key_request_rate_policy",
      organizationId,
      workspaceId,
      apiKeyId,
      policy: {
        requestsPerMinute: 1
      }
    });

    const first = await sendResponse("first request under cap");
    const providerRecordsBeforeSecond = activeFixture.openai.records.length + activeFixture.anthropic.records.length;
    const second = await sendResponse("second request over cap");
    const body = await second.json() as Record<string, unknown>;
    const rejectionEvents = await activeFixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "limit.request_rate_rejected"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(body).toMatchObject({
      error: "request_rate_limit",
      scope: "api_key",
      current: 2,
      limit: 1
    });
    expect(activeFixture.openai.records.length + activeFixture.anthropic.records.length).toBe(providerRecordsBeforeSecond);
    expect(rejectionEvents).toHaveLength(1);
    expect(rejectionEvents[0]?.payload).toMatchObject({
      reason: "request_rate_limit",
      limitType: "requests_per_minute",
      scope: "api_key",
      current: 2,
      limit: 1
    });

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
          max_output_tokens: 16
        })
      });
    }
  });
});
