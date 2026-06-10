import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  apiKeys,
  hashApiKey,
  organizations,
  providerAttempts,
  requests,
  routeDecisions,
  usageLedger,
  users
} from "@prompt-proxy/db";

import {
  adminGql,
  captureFixture,
  usageAttempt,
  usageDecision,
  usageRequest,
  usageRow,
  type PromptTestFixture
} from "./promptTestFixture.js";

const usageFields = `{
  groupBy
  data {
    key
    requestCount
    failedRequests
    retriedRequests
    latency { averageMs p95Ms }
    usage { inputTokens outputTokens totalTokens }
    cost { selected }
  }
  totals {
    requestCount
    failedRequests
    retriedRequests
    failureRate
    retryRate
    usage { inputTokens outputTokens }
    cost { selected }
  }
}`;

const timeseriesQuery = `query Timeseries($groupBy: UsageGroupBy, $interval: UsageInterval, $start: String, $end: String, $limit: Int) {
  usageTimeseries(groupBy: $groupBy, interval: $interval, start: $start, end: $end, limit: $limit) {
    groupBy
    interval
    start
    end
    groups { key requestCount usage { totalTokens } cost { selected } }
    points { ts totals { requestCount } groups }
  }
}`;

describe("usage analytics admin APIs", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("serves persisted usage analytics with grouping, time filters, and organization scoping", async () => {
    const fixture = await setup("org_usage_admin");
    const inside = new Date("2026-06-08T12:00:00.000Z");
    const outside = new Date("2026-06-01T12:00:00.000Z");

    await fixture.db.insert(organizations).values({
      id: "org_usage_other",
      slug: "org-usage-other",
      name: "Other Usage Org"
    });
    await fixture.db.insert(users).values([
      { id: "user_a" },
      { id: "user_b" },
      { id: "user_old" },
      { id: "user_other_usage" }
    ]);
    await fixture.db.insert(agentSessions).values([
      {
        id: "session_a",
        organizationId: "org_usage_admin",
        userId: "user_a",
        surface: "openai-responses"
      },
      {
        id: "session_b",
        organizationId: "org_usage_admin",
        userId: "user_b",
        surface: "anthropic-messages"
      },
      {
        id: "session_old",
        organizationId: "org_usage_admin",
        userId: "user_old",
        surface: "openai-responses"
      },
      {
        id: "session_other_usage",
        organizationId: "org_usage_other",
        userId: "user_other_usage",
        surface: "openai-responses"
      }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("usage_request_fast", "org_usage_admin", "user_a", "session_a", "openai-responses", inside),
      usageRequest("usage_request_hard", "org_usage_admin", "user_b", "session_b", "anthropic-messages", inside),
      usageRequest("usage_request_old", "org_usage_admin", "user_old", "session_old", "openai-responses", outside),
      usageRequest("usage_request_other", "org_usage_other", "user_other_usage", "session_other_usage", "openai-responses", inside)
    ]);
    await fixture.db.insert(routeDecisions).values([
      usageDecision("usage_decision_fast", "usage_request_fast", "org_usage_admin", "fast", "openai", "gpt-fast"),
      usageDecision("usage_decision_hard", "usage_request_hard", "org_usage_admin", "hard", "anthropic", "claude-hard"),
      usageDecision("usage_decision_old", "usage_request_old", "org_usage_admin", "fast", "openai", "gpt-old"),
      usageDecision("usage_decision_other", "usage_request_other", "org_usage_other", "fast", "openai", "gpt-other-org")
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("usage_attempt_fast", "usage_request_fast", "org_usage_admin", "openai-responses", "openai", "gpt-fast", "completed", inside),
      usageAttempt("usage_attempt_hard_old", "usage_request_hard", "org_usage_admin", "anthropic-messages", "anthropic", "claude-hard", "failed", new Date("2026-06-08T12:00:01.000Z")),
      usageAttempt("usage_attempt_hard_new", "usage_request_hard", "org_usage_admin", "anthropic-messages", "anthropic", "claude-hard", "failed", new Date("2026-06-08T12:00:02.000Z")),
      usageAttempt("usage_attempt_old", "usage_request_old", "org_usage_admin", "openai-responses", "openai", "gpt-old", "completed", outside),
      usageAttempt("usage_attempt_other", "usage_request_other", "org_usage_other", "openai-responses", "openai", "gpt-other-org", "completed", inside)
    ]);
    await fixture.db.insert(usageLedger).values([
      usageRow("usage_fast", "usage_request_fast", "usage_attempt_fast", "org_usage_admin", "openai", "gpt-fast", "fast", 100, 25, 1000),
      usageRow("usage_hard_retry", "usage_request_hard", "usage_attempt_hard_old", "org_usage_admin", "anthropic", "claude-hard", "hard", 10, 5, 500),
      usageRow("usage_hard", "usage_request_hard", "usage_attempt_hard_new", "org_usage_admin", "anthropic", "claude-hard", "hard", 200, 50, 3000),
      usageRow("usage_old", "usage_request_old", "usage_attempt_old", "org_usage_admin", "openai", "gpt-old", "fast", 999, 999, 9999),
      usageRow("usage_other", "usage_request_other", "usage_attempt_other", "org_usage_other", "openai", "gpt-other-org", "fast", 999, 999, 9999)
    ]);

    const modelUsage = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { usage(groupBy: model, start: "2026-06-08T00:00:00.000Z", end: "2026-06-09T00:00:00.000Z") ${usageFields} }`
    )).data?.usage;
    const supportedGroups = await Promise.all(
      ["user", "provider", "model", "route", "surface", "session"].map(async (groupBy) =>
        (await adminGql(
          fixture.proxyUrl,
          fixture.adminHeaders,
          `query { usage(groupBy: ${groupBy}) ${usageFields} }`
        )).data?.usage)
    );
    const hardGroup = modelUsage.data.find((item: any) => item.key === "claude-hard");

    expect(modelUsage.groupBy).toBe("model");
    expect(modelUsage.totals.requestCount).toBe(2);
    expect(modelUsage.totals.usage.inputTokens).toBe(310);
    expect(modelUsage.totals.usage.outputTokens).toBe(80);
    expect(modelUsage.totals.cost.selected).toBeCloseTo(0.0045);
    expect(modelUsage.totals.failedRequests).toBe(1);
    expect(modelUsage.totals.retriedRequests).toBe(1);
    expect(modelUsage.totals.failureRate).toBe(0.5);
    expect(modelUsage.totals.retryRate).toBe(0.5);
    expect(modelUsage.data.map((item: any) => item.key)).not.toContain("gpt-old");
    expect(modelUsage.data.map((item: any) => item.key)).not.toContain("gpt-other-org");
    expect(hardGroup).toEqual(expect.objectContaining({
      key: "claude-hard",
      requestCount: 1,
      failedRequests: 1,
      retriedRequests: 1
    }));
    expect(supportedGroups.map((item: any) => item.groupBy)).toEqual([
      "user",
      "provider",
      "model",
      "route",
      "surface",
      "session"
    ]);
  });

  it("groups usage by API key and serves bucketed timeseries with group collapse", async () => {
    const fixture = await setup("org_usage_keys");
    const dayOne = new Date("2026-06-07T10:00:00.000Z");
    const dayTwo = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(users).values([{ id: "user_keys" }]);
    await fixture.db.insert(apiKeys).values([
      {
        id: "key_alpha",
        organizationId: "org_usage_keys",
        keyHash: hashApiKey("alpha-secret"),
        name: "Alpha key",
        scopes: ["proxy"]
      },
      {
        id: "key_beta",
        organizationId: "org_usage_keys",
        keyHash: hashApiKey("beta-secret"),
        name: "Beta key",
        scopes: ["proxy"]
      }
    ]);
    await fixture.db.insert(agentSessions).values([
      {
        id: "session_keys",
        organizationId: "org_usage_keys",
        userId: "user_keys",
        surface: "openai-responses"
      }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("key_request_alpha_one", "org_usage_keys", "user_keys", "session_keys", "openai-responses", dayOne, "key_alpha"),
      usageRequest("key_request_alpha_two", "org_usage_keys", "user_keys", "session_keys", "openai-responses", dayTwo, "key_alpha"),
      usageRequest("key_request_beta", "org_usage_keys", "user_keys", "session_keys", "openai-responses", dayTwo, "key_beta"),
      usageRequest("key_request_anonymous", "org_usage_keys", "user_keys", "session_keys", "openai-responses", dayTwo)
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("key_attempt_alpha_one", "key_request_alpha_one", "org_usage_keys", "openai-responses", "openai", "gpt-fast", "completed", dayOne),
      {
        ...usageAttempt("key_attempt_alpha_two", "key_request_alpha_two", "org_usage_keys", "openai-responses", "openai", "gpt-fast", "completed", dayTwo),
        completedAt: new Date(dayTwo.getTime() + 200)
      },
      {
        ...usageAttempt("key_attempt_beta", "key_request_beta", "org_usage_keys", "openai-responses", "openai", "gpt-fast", "completed", dayTwo),
        completedAt: new Date(dayTwo.getTime() + 100)
      },
      usageAttempt("key_attempt_anonymous", "key_request_anonymous", "org_usage_keys", "openai-responses", "openai", "gpt-fast", "completed", dayTwo)
    ]);
    await fixture.db.insert(usageLedger).values([
      usageRow("key_usage_alpha_one", "key_request_alpha_one", "key_attempt_alpha_one", "org_usage_keys", "openai", "gpt-fast", "fast", 100, 25, 1000),
      usageRow("key_usage_alpha_two", "key_request_alpha_two", "key_attempt_alpha_two", "org_usage_keys", "openai", "gpt-fast", "fast", 200, 50, 2000),
      usageRow("key_usage_beta", "key_request_beta", "key_attempt_beta", "org_usage_keys", "openai", "gpt-fast", "fast", 400, 100, 4000),
      usageRow("key_usage_anonymous", "key_request_anonymous", "key_attempt_anonymous", "org_usage_keys", "openai", "gpt-fast", "fast", 10, 5, 500)
    ]);

    const keyUsage = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { usage(groupBy: api_key) ${usageFields} }`
    )).data?.usage;
    const timeseries = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, timeseriesQuery, {
      groupBy: "api_key",
      interval: "day",
      start: "2026-06-07T00:00:00.000Z",
      end: "2026-06-08T23:59:59.000Z"
    })).data?.usageTimeseries;
    const collapsed = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, timeseriesQuery, {
      groupBy: "api_key",
      interval: "day",
      start: "2026-06-07T00:00:00.000Z",
      end: "2026-06-08T23:59:59.000Z",
      limit: 2
    })).data?.usageTimeseries;

    expect(keyUsage.groupBy).toBe("api_key");
    expect(keyUsage.data.map((item: any) => item.key)).toEqual(["key_beta", "key_alpha", "unknown"]);
    const alphaGroup = keyUsage.data.find((item: any) => item.key === "key_alpha");
    expect(alphaGroup).toEqual(expect.objectContaining({
      requestCount: 2,
      usage: expect.objectContaining({ totalTokens: 375 })
    }));
    expect(alphaGroup.cost.selected).toBeCloseTo(0.003);
    expect(alphaGroup.latency).toEqual({ averageMs: 100, p95Ms: 200 });

    expect(timeseries.groupBy).toBe("api_key");
    expect(timeseries.interval).toBe("day");
    expect(timeseries.groups.map((item: any) => item.key)).toEqual(["key_beta", "key_alpha", "unknown"]);
    expect(timeseries.points).toHaveLength(2);
    const [firstPoint, secondPoint] = timeseries.points;
    expect(firstPoint.ts).toBe("2026-06-07T00:00:00.000Z");
    expect(firstPoint.totals.requestCount).toBe(1);
    expect(firstPoint.groups.key_alpha.usage.totalTokens).toBe(125);
    expect(secondPoint.ts).toBe("2026-06-08T00:00:00.000Z");
    expect(secondPoint.totals.requestCount).toBe(3);
    expect(secondPoint.groups.key_beta.cost.selected).toBeCloseTo(0.004);
    expect(secondPoint.groups.unknown.requestCount).toBe(1);

    expect(collapsed.groups.map((item: any) => item.key)).toEqual(["key_beta", "key_alpha", "__other__"]);
    const collapsedSecondPoint = collapsed.points[1];
    expect(collapsedSecondPoint.groups.__other__.requestCount).toBe(1);
    expect(collapsedSecondPoint.groups.__other__.usage.totalTokens).toBe(15);
  });

  it("records the API key on proxied requests and attributes usage to it", async () => {
    const fixture = await setup("org_usage_key_capture");
    await fixture.db.insert(apiKeys).values({
      id: "key_capture",
      organizationId: "org_usage_key_capture",
      keyHash: hashApiKey("capture-secret"),
      name: "Capture key",
      scopes: ["proxy"]
    });

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer capture-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "summarize this changelog",
        stream: true
      })
    });
    await response.text();
    expect(response.status).toBe(200);

    const requestRows = await fixture.db
      .select()
      .from(requests)
      .where(eq(requests.organizationId, "org_usage_key_capture"));
    expect(requestRows).toHaveLength(1);
    expect(requestRows[0].apiKeyId).toBe("key_capture");

    const keyUsage = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { usage(groupBy: api_key) ${usageFields} }`
    )).data?.usage;
    expect(keyUsage.data.map((item: any) => item.key)).toEqual(["key_capture"]);
    expect(keyUsage.data[0].requestCount).toBe(1);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
