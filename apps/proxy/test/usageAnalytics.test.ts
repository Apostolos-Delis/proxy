import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  organizations,
  providerAttempts,
  requests,
  routeDecisions,
  usageLedger,
  users
} from "@prompt-proxy/db";

import {
  captureFixture,
  usageAttempt,
  usageDecision,
  usageRequest,
  usageRow,
  type PromptTestFixture
} from "./promptTestFixture.js";

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

    const modelUsage = await fetch(
      `${fixture.proxyUrl}/admin/usage?groupBy=model&start=2026-06-08T00:00:00.000Z&end=2026-06-09T00:00:00.000Z`,
      { headers: fixture.adminHeaders }
    ).then((item) => item.json());
    const supportedGroups = await Promise.all(
      ["user", "provider", "model", "route", "surface", "session"].map((groupBy) =>
        fetch(`${fixture.proxyUrl}/admin/usage?groupBy=${groupBy}`, {
          headers: fixture.adminHeaders
        }).then((item) => item.json()))
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

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
