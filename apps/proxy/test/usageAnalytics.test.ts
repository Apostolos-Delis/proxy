import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  apiKeys,
  defaultWorkspaceId,
  hashApiKey,
  organizations,
  providerAttempts,
  requests,
  routeDecisions,
  usageLedger,
  users,
  workspaces
} from "@proxy/db";

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
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_usage_other"),
      organizationId: "org_usage_other",
      slug: "default",
      name: "Default"
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
        workspaceId: defaultWorkspaceId("org_usage_admin"),
        userId: "user_a",
        surface: "openai-responses"
      },
      {
        id: "session_b",
        organizationId: "org_usage_admin",
        workspaceId: defaultWorkspaceId("org_usage_admin"),
        userId: "user_b",
        surface: "anthropic-messages"
      },
      {
        id: "session_old",
        organizationId: "org_usage_admin",
        workspaceId: defaultWorkspaceId("org_usage_admin"),
        userId: "user_old",
        surface: "openai-responses"
      },
      {
        id: "session_other_usage",
        organizationId: "org_usage_other",
        workspaceId: defaultWorkspaceId("org_usage_other"),
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
    const allTimeModelUsage = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { usage(groupBy: model) ${usageFields} }`
    )).data?.usage;
    const overviewDashboard = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { overviewDashboard { modelUsage ${usageFields} } }`
    )).data?.overviewDashboard;
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
    expect(overviewDashboard.modelUsage.totals).toEqual(allTimeModelUsage.totals);
    expect(overviewDashboard.modelUsage.data.map((item: any) => item.key)).toEqual(
      allTimeModelUsage.data.map((item: any) => item.key)
    );
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
        workspaceId: defaultWorkspaceId("org_usage_keys"),
        keyHash: hashApiKey("alpha-secret"),
        name: "Alpha key"
      },
      {
        id: "key_beta",
        organizationId: "org_usage_keys",
        workspaceId: defaultWorkspaceId("org_usage_keys"),
        keyHash: hashApiKey("beta-secret"),
        name: "Beta key"
      }
    ]);
    await fixture.db.insert(agentSessions).values([
      {
        id: "session_keys",
        organizationId: "org_usage_keys",
        workspaceId: defaultWorkspaceId("org_usage_keys"),
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
      workspaceId: defaultWorkspaceId("org_usage_key_capture"),
      keyHash: hashApiKey("capture-secret"),
      name: "Capture key"
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

  it("keeps OpenAI Chat as its own usage surface with its own baseline", async () => {
    const fixture = await setup("org_usage_chat_surface");
    const createdAt = new Date("2026-06-08T12:00:00.000Z");

    await fixture.persistence.organizationSettings.setCostBaseline("org_usage_chat_surface", {
      anthropicMessagesModel: null,
      openaiResponsesModel: "gpt-5.5-pro",
      openaiChatModel: "gpt-5.4-mini"
    });
    await fixture.db.insert(users).values([{ id: "user_chat_surface" }]);
    await fixture.db.insert(agentSessions).values([
      {
        id: "session_responses_surface",
        organizationId: "org_usage_chat_surface",
        workspaceId: defaultWorkspaceId("org_usage_chat_surface"),
        userId: "user_chat_surface",
        surface: "openai-responses"
      },
      {
        id: "session_chat_surface",
        organizationId: "org_usage_chat_surface",
        workspaceId: defaultWorkspaceId("org_usage_chat_surface"),
        userId: "user_chat_surface",
        surface: "openai-chat"
      }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("surface_responses_request", "org_usage_chat_surface", "user_chat_surface", "session_responses_surface", "openai-responses", createdAt),
      usageRequest("surface_chat_request", "org_usage_chat_surface", "user_chat_surface", "session_chat_surface", "openai-chat", createdAt)
    ]);
    await fixture.db.insert(routeDecisions).values([
      usageDecision("surface_responses_decision", "surface_responses_request", "org_usage_chat_surface", "fast", "openai", "gpt-5.4-mini"),
      usageDecision("surface_chat_decision", "surface_chat_request", "org_usage_chat_surface", "fast", "openai", "gpt-5.4-mini")
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("surface_responses_attempt", "surface_responses_request", "org_usage_chat_surface", "openai-responses", "openai", "gpt-5.4-mini", "completed", createdAt),
      usageAttempt("surface_chat_attempt", "surface_chat_request", "org_usage_chat_surface", "openai-chat", "openai", "gpt-5.4-mini", "completed", createdAt)
    ]);
    await fixture.db.insert(usageLedger).values([
      usageRow("surface_responses_usage", "surface_responses_request", "surface_responses_attempt", "org_usage_chat_surface", "openai", "gpt-5.4-mini", "fast", 1000, 100, 450),
      usageRow("surface_chat_usage", "surface_chat_request", "surface_chat_attempt", "org_usage_chat_surface", "openai", "gpt-5.4-mini", "fast", 1000, 100, 450)
    ]);

    const usage = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { usage(groupBy: surface) { data { key requestCount cost { baseline } } totals { requestCount cost { baseline } } } }`
    )).data?.usage;
    const bySurface = new Map(usage.data.map((row: { key: string; requestCount: number; cost: { baseline: number } }) => [row.key, row]));

    expect([...bySurface.keys()].sort()).toEqual(["openai-chat", "openai-responses"]);
    expect(bySurface.get("openai-responses")?.requestCount).toBe(1);
    expect(bySurface.get("openai-chat")?.requestCount).toBe(1);
    expect(bySurface.get("openai-responses")?.cost.baseline).toBeCloseTo(0.027);
    expect(bySurface.get("openai-chat")?.cost.baseline).toBeCloseTo(0.00045);
    expect(usage.totals.requestCount).toBe(2);
    expect(usage.totals.cost.baseline).toBeCloseTo(0.02745);
  });

  it("keeps concurrent root fields consistent when they share request scans", async () => {
    const fixture = await setup("org_usage_shared_scan");
    const createdAt = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(users).values([{ id: "user_shared" }]);
    await fixture.db.insert(agentSessions).values({
      id: "session_shared",
      organizationId: "org_usage_shared_scan",
      workspaceId: defaultWorkspaceId("org_usage_shared_scan"),
      userId: "user_shared",
      surface: "openai-responses"
    });
    await fixture.db.insert(requests).values(
      Array.from({ length: 4 }, (_, index) =>
        usageRequest(`shared_request_${index}`, "org_usage_shared_scan", "user_shared", "session_shared", "openai-responses", createdAt))
    );
    await fixture.db.insert(routeDecisions).values(
      Array.from({ length: 4 }, (_, index) =>
        usageDecision(`shared_decision_${index}`, `shared_request_${index}`, "org_usage_shared_scan", "fast", "openai", "gpt-fast"))
    );
    await fixture.db.insert(providerAttempts).values(
      Array.from({ length: 4 }, (_, index) =>
        usageAttempt(`shared_attempt_${index}`, `shared_request_${index}`, "org_usage_shared_scan", "openai-responses", "openai", "gpt-fast", "completed", createdAt))
    );
    await fixture.db.insert(usageLedger).values(
      Array.from({ length: 4 }, (_, index) =>
        usageRow(`shared_usage_${index}`, `shared_request_${index}`, `shared_attempt_${index}`, "org_usage_shared_scan", "openai", "gpt-fast", "fast", 100, 25, 1000))
    );

    // One document, four root fields: overview and usage read the full
    // request scan, requests reads the limited scan, usageTimeseries shares
    // the usage scan. All must agree on the same underlying rows.
    const result = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query {
        overview { requestCount totals { totalTokens } }
        requests { requestId }
        usage(groupBy: route) { totals { requestCount usage { totalTokens } } }
        usageTimeseries(groupBy: route, interval: day) {
          groups { key requestCount }
          points { ts totals { requestCount } }
        }
        usageDashboard(groupBy: route, interval: day) {
          usage { totals { requestCount usage { totalTokens } } }
          timeseries {
            groups { key requestCount }
            points { ts totals { requestCount } }
          }
        }
      }`
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.overview.requestCount).toBe(4);
    expect(result.data?.requests).toHaveLength(4);
    expect(result.data?.usage.totals.requestCount).toBe(4);
    expect(result.data?.usage.totals.usage.totalTokens).toBe(result.data?.overview.totals.totalTokens);
    expect(result.data?.usageDashboard.usage.totals).toEqual(result.data?.usage.totals);
    expect(result.data?.usageTimeseries.groups).toEqual([
      expect.objectContaining({ key: "fast", requestCount: 4 })
    ]);
    expect(result.data?.usageDashboard.timeseries.groups).toEqual(result.data?.usageTimeseries.groups);
    const pointTotal = result.data?.usageTimeseries.points.reduce(
      (sum: number, point: { totals: { requestCount: number } }) => sum + point.totals.requestCount,
      0
    );
    const dashboardPointTotal = result.data?.usageDashboard.timeseries.points.reduce(
      (sum: number, point: { totals: { requestCount: number } }) => sum + point.totals.requestCount,
      0
    );
    expect(pointTotal).toBe(4);
    expect(dashboardPointTotal).toBe(pointTotal);
  });

  it("folds classifier spend into selected cost and savings without inflating tokens or counts", async () => {
    const fixture = await setup("org_usage_classifier");
    const createdAt = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(users).values([{ id: "user_clf" }]);
    await fixture.db.insert(agentSessions).values({
      id: "session_clf",
      organizationId: "org_usage_classifier",
      workspaceId: defaultWorkspaceId("org_usage_classifier"),
      userId: "user_clf",
      surface: "openai-responses"
    });
    await fixture.db.insert(requests).values([
      usageRequest("clf_request", "org_usage_classifier", "user_clf", "session_clf", "openai-responses", createdAt)
    ]);
    await fixture.db.insert(routeDecisions).values([
      usageDecision("clf_decision", "clf_request", "org_usage_classifier", "fast", "openai", "gpt-fast")
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("clf_attempt", "clf_request", "org_usage_classifier", "openai-responses", "openai", "gpt-fast", "completed", createdAt)
    ]);
    await fixture.db.insert(usageLedger).values([
      usageRow("clf_provider_usage", "clf_request", "clf_attempt", "org_usage_classifier", "openai", "gpt-fast", "fast", 100, 25, 1000),
      // The classifier's own billed call: no provider attempt, kind = classifier.
      {
        ...usageRow("clf_classifier_usage", "clf_request", "clf_attempt", "org_usage_classifier", "openai", "gpt-5-nano", "fast", 80, 4, 600),
        providerAttemptId: null,
        kind: "classifier"
      }
    ]);

    const usage = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { usage(groupBy: model) { totals { requestCount usage { totalTokens } cost { selected baseline savings classifier } } } }`
    )).data?.usage;

    // One request, provider tokens only (classifier tokens excluded).
    expect(usage.totals.requestCount).toBe(1);
    expect(usage.totals.usage.totalTokens).toBe(125);
    // Selected = provider 0.001 + classifier 0.0006.
    expect(usage.totals.cost.classifier).toBeCloseTo(0.0006);
    expect(usage.totals.cost.selected).toBeCloseTo(0.0016);
    // Savings = baseline (priced from provider tokens only) minus selected,
    // so the classifier overhead reduces savings dollar for dollar.
    expect(usage.totals.cost.savings).toBeCloseTo(usage.totals.cost.baseline - 0.0016);
  });

  it("prices baseline against the organization's configured baseline models", async () => {
    const fixture = await setup("org_usage_baseline");
    const createdAt = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(users).values([{ id: "user_bl" }]);
    await fixture.db.insert(agentSessions).values({
      id: "session_bl",
      organizationId: "org_usage_baseline",
      workspaceId: defaultWorkspaceId("org_usage_baseline"),
      userId: "user_bl",
      surface: "anthropic-messages"
    });
    await fixture.db.insert(requests).values([
      usageRequest("bl_request", "org_usage_baseline", "user_bl", "session_bl", "anthropic-messages", createdAt)
    ]);
    await fixture.db.insert(routeDecisions).values([
      usageDecision("bl_decision", "bl_request", "org_usage_baseline", "hard", "anthropic", "claude-opus-4-8")
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("bl_attempt", "bl_request", "org_usage_baseline", "anthropic-messages", "anthropic", "claude-opus-4-8", "completed", createdAt)
    ]);
    await fixture.db.insert(usageLedger).values([
      usageRow("bl_usage", "bl_request", "bl_attempt", "org_usage_baseline", "anthropic", "claude-opus-4-8", "hard", 1000, 100, 7500)
    ]);

    const queryUsage = async () => (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { usage(groupBy: model) { totals { cost { selected baseline savings } } } }`
    )).data?.usage;

    // Default counterfactual is claude-fable-5 ($10/$50): 1000 in + 100 out = $0.015.
    const before = await queryUsage();
    expect(before.totals.cost.selected).toBeCloseTo(0.0075);
    expect(before.totals.cost.baseline).toBeCloseTo(0.015);
    expect(before.totals.cost.savings).toBeCloseTo(0.0075);

    await fixture.persistence.organizationSettings.setCostBaseline("org_usage_baseline", {
      anthropicMessagesModel: "claude-haiku-4-5",
      openaiResponsesModel: null,
      openaiChatModel: null
    });

    // Configured counterfactual claude-haiku-4-5 ($1/$5): the same tokens
    // baseline at $0.0015, flipping savings negative.
    const after = await queryUsage();
    expect(after.totals.cost.baseline).toBeCloseTo(0.0015);
    expect(after.totals.cost.savings).toBeCloseTo(-0.006);

    // A request that explicitly pinned a route tier stays its own
    // counterfactual: the hard tier's model (claude-sonnet-4-5 in the test
    // env, $3/$15), unaffected by the org baseline override.
    await fixture.db.insert(requests).values([{
      ...usageRequest("bl_alias_request", "org_usage_baseline", "user_bl", "session_bl", "anthropic-messages", createdAt),
      requestedModel: "claude-router-hard"
    }]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("bl_alias_attempt", "bl_alias_request", "org_usage_baseline", "anthropic-messages", "anthropic", "claude-opus-4-8", "completed", createdAt)
    ]);
    await fixture.db.insert(routeDecisions).values([
      {
        ...usageDecision("bl_alias_decision", "bl_alias_request", "org_usage_baseline", "hard", "anthropic", "claude-sonnet-4-5"),
        requestedModel: "claude-router-hard"
      }
    ]);
    await fixture.db.insert(usageLedger).values([
      usageRow("bl_alias_usage", "bl_alias_request", "bl_alias_attempt", "org_usage_baseline", "anthropic", "claude-opus-4-8", "hard", 1000, 100, 7500)
    ]);

    const summaries = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { requests { requestId baselineCost } }`
    )).data?.requests;
    const byRequest = new Map(
      summaries.map((row: { requestId: string; baselineCost: number }) => [row.requestId, row.baselineCost])
    );
    expect(byRequest.get("bl_alias_request")).toBeCloseTo(0.0045, 6);
    expect(byRequest.get("bl_request")).toBeCloseTo(0.0015, 6);
  });

  it("captures the classifier's own billed call as a priced classifier ledger row", async () => {
    activeFixture = await captureFixture("org_clf_capture", "raw_text", false, {
      envOverrides: { CLASSIFIER_MODEL: "gpt-5-nano" },
      openAIOptions: {
        classifierUsage: { input_tokens: 800, output_tokens: 40 }
      }
    });
    const fixture = activeFixture;

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "router-auto", input: "classify and route me", stream: true })
    });
    await response.text();
    expect(response.status).toBe(200);

    const classifierRows = (await fixture.db.select().from(usageLedger))
      .filter((row) => row.kind === "classifier");
    expect(classifierRows).toHaveLength(1);
    const [row] = classifierRows;
    expect(row.providerAttemptId).toBeNull();
    expect(row.model).toBe("gpt-5-nano");
    expect(row.inputTokens).toBe(800);
    expect(row.outputTokens).toBe(40);
    // gpt-5-nano: input 0.05/MTok, output 0.4/MTok → 800*0.05 + 40*0.4 = 56 micros.
    expect(row.totalCostMicros).toBe(56);
  });

  it("scopes the requests list to the start/end window", async () => {
    const fixture = await setup("org_requests_window");
    const inside = new Date("2026-06-08T12:00:00.000Z");
    const outside = new Date("2026-06-01T12:00:00.000Z");

    await fixture.db.insert(users).values([{ id: "user_window" }]);
    await fixture.db.insert(agentSessions).values({
      id: "session_window",
      organizationId: "org_requests_window",
      workspaceId: defaultWorkspaceId("org_requests_window"),
      userId: "user_window",
      surface: "openai-responses"
    });
    await fixture.db.insert(requests).values([
      usageRequest("window_request_inside", "org_requests_window", "user_window", "session_window", "openai-responses", inside),
      usageRequest("window_request_outside", "org_requests_window", "user_window", "session_window", "openai-responses", outside)
    ]);

    const scoped = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { requests(start: "2026-06-08T00:00:00.000Z", end: "2026-06-09T00:00:00.000Z") { requestId } }`
    );
    const unscoped = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { requests { requestId } }`
    );

    expect(scoped.errors).toBeUndefined();
    expect(scoped.data?.requests.map((item: any) => item.requestId)).toEqual(["window_request_inside"]);
    expect(unscoped.data?.requests.map((item: any) => item.requestId).sort()).toEqual([
      "window_request_inside",
      "window_request_outside"
    ]);
  });

  it("groups usage by model and effort so same-model effort tiers are distinguishable", async () => {
    const fixture = await setup("org_usage_effort");
    const createdAt = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(users).values([{ id: "user_effort" }]);
    await fixture.db.insert(agentSessions).values({
      id: "session_effort",
      organizationId: "org_usage_effort",
      workspaceId: defaultWorkspaceId("org_usage_effort"),
      userId: "user_effort",
      surface: "openai-responses"
    });
    await fixture.db.insert(requests).values([
      usageRequest("eff_request_high", "org_usage_effort", "user_effort", "session_effort", "openai-responses", createdAt),
      usageRequest("eff_request_xhigh", "org_usage_effort", "user_effort", "session_effort", "openai-responses", createdAt)
    ]);
    await fixture.db.insert(routeDecisions).values([
      { ...usageDecision("eff_decision_high", "eff_request_high", "org_usage_effort", "hard", "anthropic", "claude-fable-5"), reasoningEffort: "high" },
      { ...usageDecision("eff_decision_xhigh", "eff_request_xhigh", "org_usage_effort", "hard", "anthropic", "claude-fable-5"), reasoningEffort: "xhigh" }
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("eff_attempt_high", "eff_request_high", "org_usage_effort", "anthropic-messages", "anthropic", "claude-fable-5", "completed", createdAt),
      usageAttempt("eff_attempt_xhigh", "eff_request_xhigh", "org_usage_effort", "anthropic-messages", "anthropic", "claude-fable-5", "completed", createdAt)
    ]);
    await fixture.db.insert(usageLedger).values([
      usageRow("eff_usage_high", "eff_request_high", "eff_attempt_high", "org_usage_effort", "anthropic", "claude-fable-5", "hard", 100, 25, 1000),
      usageRow("eff_usage_xhigh", "eff_request_xhigh", "eff_attempt_xhigh", "org_usage_effort", "anthropic", "claude-fable-5", "hard", 400, 100, 4000)
    ]);

    const usage = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { usage(groupBy: model_effort) ${usageFields} }`
    )).data?.usage;

    expect(usage.groupBy).toBe("model_effort");
    const keys = usage.data.map((item: any) => item.key);
    expect(keys).toContain("claude-fable-5 · high");
    expect(keys).toContain("claude-fable-5 · xhigh");
    const xhigh = usage.data.find((item: any) => item.key === "claude-fable-5 · xhigh");
    expect(xhigh.usage.totalTokens).toBe(500);
    // Same model, different effort → distinct rows with distinct spend.
    expect(xhigh.cost.selected).toBeGreaterThan(0);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
