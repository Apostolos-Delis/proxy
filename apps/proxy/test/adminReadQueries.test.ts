import { afterEach, describe, expect, it } from "vitest";

import { agentSessions, defaultWorkspaceId, organizations, requests, routeDecisions, users, workspaces } from "@prompt-proxy/db";

import {
  captureFixture,
  usageDecision,
  usageRequest,
  type PromptTestFixture
} from "./promptTestFixture.js";

// These filtered reads back the console agent's requests/sessions capabilities
// (requestsFiltered/sessionsFiltered); the web console reads via GraphQL.
describe("admin read query filters", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("filters request lists by status, surface, route, session, time range, and limit", async () => {
    const fixture = await setup("org_read_queries");
    const queries = fixture.persistence.adminQueries.forScope("org_read_queries", defaultWorkspaceId("org_read_queries"));
    const inside = new Date("2026-06-08T12:00:00.000Z");
    const outside = new Date("2026-06-01T12:00:00.000Z");

    await fixture.db.insert(organizations).values({
      id: "org_read_other",
      slug: "org-read-other",
      name: "Other Read Org"
    });
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_read_other"),
      organizationId: "org_read_other",
      slug: "default",
      name: "Default"
    });
    await fixture.db.insert(users).values([{ id: "user_a" }, { id: "user_b" }]);
    await fixture.db.insert(agentSessions).values([
      { id: "session_a", organizationId: "org_read_queries", workspaceId: defaultWorkspaceId("org_read_queries"), userId: "user_a", surface: "openai-responses" },
      { id: "session_b", organizationId: "org_read_queries", workspaceId: defaultWorkspaceId("org_read_queries"), userId: "user_b", surface: "anthropic-messages" },
      { id: "session_other", organizationId: "org_read_other", workspaceId: defaultWorkspaceId("org_read_other"), userId: "user_a", surface: "openai-responses" }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("req_fast", "org_read_queries", "user_a", "session_a", "openai-responses", inside),
      {
        ...usageRequest("req_hard", "org_read_queries", "user_b", "session_b", "anthropic-messages", inside),
        routingConfigId: "config_under_test"
      },
      { ...usageRequest("req_failed", "org_read_queries", "user_a", "session_a", "openai-responses", inside), status: "failed" as const },
      usageRequest("req_old", "org_read_queries", "user_a", "session_a", "openai-responses", outside),
      usageRequest("req_other_org", "org_read_other", "user_a", "session_other", "openai-responses", inside)
    ]);
    await fixture.db.insert(routeDecisions).values([
      usageDecision("dec_fast", "req_fast", "org_read_queries", "fast", "openai", "gpt-fast"),
      usageDecision("dec_hard", "req_hard", "org_read_queries", "hard", "anthropic", "claude-hard"),
      usageDecision("dec_other", "req_other_org", "org_read_other", "fast", "openai", "gpt-fast")
    ]);

    const all = await queries.requestsFiltered();
    const bySurface = await queries.requestsFiltered({ surface: "anthropic-messages" });
    const byStatus = await queries.requestsFiltered({ status: "failed" });
    const byRoute = await queries.requestsFiltered({ route: "hard" });
    const bySession = await queries.requestsFiltered({ sessionId: "session_b" });
    const byUser = await queries.requestsFiltered({ userId: "user_b" });
    const byRoutingConfig = await queries.requestsFiltered({ routingConfigId: "config_under_test" });
    const byTime = await queries.requestsFiltered({
      start: "2026-06-08T00:00:00.000Z",
      end: "2026-06-09T00:00:00.000Z"
    });
    const byLimit = await queries.requestsFiltered({ limit: 1 });
    const byBadStatus = await queries.requestsFiltered({ status: "not_a_status" });

    expect(ids(all)).toEqual(expect.arrayContaining(["req_fast", "req_hard", "req_failed", "req_old"]));
    expect(ids(all)).not.toContain("req_other_org");
    expect(ids(bySurface)).toEqual(["req_hard"]);
    expect(ids(byStatus)).toEqual(["req_failed"]);
    expect(ids(byRoute)).toEqual(["req_hard"]);
    expect(ids(bySession)).toEqual(["req_hard"]);
    expect(ids(byUser)).toEqual(["req_hard"]);
    expect(ids(byRoutingConfig)).toEqual(["req_hard"]);
    expect(ids(byTime)).toEqual(expect.arrayContaining(["req_fast", "req_hard", "req_failed"]));
    expect(ids(byTime)).not.toContain("req_old");
    expect(byLimit.data).toHaveLength(1);
    expect(ids(byBadStatus)).toEqual(ids(all));
  });

  it("filters session lists and keeps unfiltered behavior unchanged", async () => {
    const fixture = await setup("org_read_sessions");
    const queries = fixture.persistence.adminQueries.forScope("org_read_sessions", defaultWorkspaceId("org_read_sessions"));

    await fixture.db.insert(users).values([{ id: "user_a" }, { id: "user_b" }]);
    await fixture.db.insert(agentSessions).values([
      {
        id: "session_a",
        organizationId: "org_read_sessions",
        workspaceId: defaultWorkspaceId("org_read_sessions"),
        userId: "user_a",
        surface: "openai-responses",
        updatedAt: new Date("2026-06-08T12:00:00.000Z")
      },
      {
        id: "session_b",
        organizationId: "org_read_sessions",
        workspaceId: defaultWorkspaceId("org_read_sessions"),
        userId: "user_b",
        surface: "anthropic-messages",
        updatedAt: new Date("2026-06-01T12:00:00.000Z")
      }
    ]);

    const all = await queries.sessionsFiltered();
    const bySurface = await queries.sessionsFiltered({ surface: "anthropic-messages" });
    const byUser = await queries.sessionsFiltered({ userId: "user_a" });
    const byTime = await queries.sessionsFiltered({
      start: "2026-06-08T00:00:00.000Z",
      end: "2026-06-09T00:00:00.000Z"
    });
    const byLimit = await queries.sessionsFiltered({ limit: 1 });

    expect(all.data.map((session) => session.sessionId)).toEqual(
      expect.arrayContaining(["session_a", "session_b"])
    );
    expect(bySurface.data.map((session) => session.sessionId)).toEqual(["session_b"]);
    expect(byUser.data.map((session) => session.sessionId)).toEqual(["session_a"]);
    expect(byTime.data.map((session) => session.sessionId)).toEqual(["session_a"]);
    expect(byLimit.data).toHaveLength(1);
  });

  async function setup(...args: Parameters<typeof captureFixture>) {
    activeFixture = await captureFixture(...args);
    return activeFixture;
  }
});

function ids(payload: { data: Array<{ requestId: string }> }) {
  return payload.data.map((row) => row.requestId);
}
