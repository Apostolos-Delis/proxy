import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  defaultWorkspaceId,
  events,
  organizationMembers,
  organizations,
  promptArtifacts,
  providerAttempts,
  requests,
  routeDecisions,
  usageLedger,
  users,
  workspaces
} from "@prompt-proxy/db";

import {
  adminGql,
  captureFixture,
  sessionEvent,
  sessionPrompt,
  usageAttempt,
  usageDecision,
  usageRequest,
  usageRow,
  type PromptTestFixture
} from "./promptTestFixture.js";

const sessionDetailQuery = `query SessionDetail($sessionId: ID!) {
  session(sessionId: $sessionId) {
    session { sessionId externalSessionId sessionIdentity userId }
    user
    requests { requestId }
    promptArtifacts { rawText }
    routeDecisions { finalRoute }
    providerAttempts { terminalStatus }
    usageLedger { totalCostMicros }
    events { eventType }
  }
}`;

describe("session replay admin APIs", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("serves org-scoped users and sessions admin APIs", async () => {
    const fixture = await setup("org_users_sessions");
    const first = new Date("2026-06-08T12:00:00.000Z");
    const second = new Date("2026-06-08T12:01:00.000Z");

    await fixture.db.insert(users).values([
      { id: "user_session_admin", email: "session@example.com", name: "Session Admin" },
      { id: "user_other_org", email: "other@example.com", name: "Other User" }
    ]);
    await fixture.db.insert(organizationMembers).values({
      organizationId: "org_users_sessions",
      userId: "user_session_admin",
      role: "admin"
    });
    await fixture.db.insert(organizations).values({
      id: "org_session_other",
      slug: "org-session-other",
      name: "Other Session Org"
    });
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_session_other"),
      organizationId: "org_session_other",
      slug: "default",
      name: "Default"
    });
    await fixture.db.insert(agentSessions).values([
      {
        id: "session_admin",
        organizationId: "org_users_sessions",
        workspaceId: defaultWorkspaceId("org_users_sessions"),
        userId: "user_session_admin",
        surface: "openai-responses",
        externalSessionId: "codex-session",
        currentRoute: "hard",
        metadata: { sessionIdentity: "harness" },
        startedAt: first,
        updatedAt: second
      },
      {
        id: "session_other",
        organizationId: "org_session_other",
        workspaceId: defaultWorkspaceId("org_session_other"),
        userId: "user_other_org",
        surface: "openai-responses",
        externalSessionId: "other-session"
      }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("session_request_fast", "org_users_sessions", "user_session_admin", "session_admin", "openai-responses", first),
      usageRequest("session_request_hard", "org_users_sessions", "user_session_admin", "session_admin", "openai-responses", second),
      usageRequest("session_request_other", "org_session_other", "user_other_org", "session_other", "openai-responses", second)
    ]);
    await fixture.db.insert(routeDecisions).values([
      usageDecision("session_decision_fast", "session_request_fast", "org_users_sessions", "fast", "openai", "gpt-fast"),
      usageDecision("session_decision_hard", "session_request_hard", "org_users_sessions", "hard", "openai", "gpt-hard"),
      usageDecision("session_decision_other", "session_request_other", "org_session_other", "fast", "openai", "gpt-other")
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("session_attempt_fast", "session_request_fast", "org_users_sessions", "openai-responses", "openai", "gpt-fast", "completed", first),
      usageAttempt("session_attempt_hard", "session_request_hard", "org_users_sessions", "openai-responses", "openai", "gpt-hard", "failed", second),
      usageAttempt("session_attempt_other", "session_request_other", "org_session_other", "openai-responses", "openai", "gpt-other", "completed", second)
    ]);
    await fixture.db.insert(usageLedger).values([
      usageRow("session_usage_fast", "session_request_fast", "session_attempt_fast", "org_users_sessions", "openai", "gpt-fast", "fast", 100, 20, 1000),
      usageRow("session_usage_hard", "session_request_hard", "session_attempt_hard", "org_users_sessions", "openai", "gpt-hard", "hard", 200, 30, 3000),
      usageRow("session_usage_other", "session_request_other", "session_attempt_other", "org_session_other", "openai", "gpt-other", "fast", 999, 999, 9999)
    ]);
    await fixture.db.insert(promptArtifacts).values([
      sessionPrompt("session_prompt_fast", "org_users_sessions", "session_request_fast", "First session prompt", first),
      sessionPrompt("session_prompt_hard", "org_users_sessions", "session_request_hard", "Second session prompt", second),
      sessionPrompt("session_prompt_other", "org_session_other", "session_request_other", "Other org prompt", second)
    ]);
    await fixture.db.insert(events).values([
      sessionEvent("session_event_fast", "org_users_sessions", "session_request_fast", "session_admin", first),
      sessionEvent("session_event_other", "org_session_other", "session_request_other", "session_other", second)
    ]);

    const usersList = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { users {
        userId
        email
        requestCount
        sessionCount
        usage { inputTokens outputTokens totalTokens }
        cost { selected }
      } }`
    )).data?.users;
    const userDetail = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query UserDetail($userId: ID!) {
        user(userId: $userId) {
          user { userId requestCount sessionCount }
          sessions { sessionId routeChanges }
          requests { requestId }
        }
      }`,
      { userId: "user_session_admin" }
    )).data?.user;
    const sessionsList = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { sessions {
        sessionId
        userId
        requestCount
        routeChanges
        modelMix
        routeMix
        terminalStatusSummary
      } }`
    )).data?.sessions;
    const sessionDetail = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      sessionDetailQuery,
      { sessionId: "session_admin" }
    )).data?.session;
    const crossUser = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query CrossUser($userId: ID!) { user(userId: $userId) { user { userId } } }",
      { userId: "user_other_org" }
    )).data;
    const crossSession = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query CrossSession($sessionId: ID!) { session(sessionId: $sessionId) { session { sessionId } } }",
      { sessionId: "session_other" }
    )).data;

    expect(usersList).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: "user_session_admin",
        email: "session@example.com",
        requestCount: 2,
        sessionCount: 1,
        usage: expect.objectContaining({
          inputTokens: 300,
          outputTokens: 50,
          totalTokens: 350
        }),
        cost: expect.objectContaining({ selected: 0.004 })
      })
    ]));
    expect(userDetail.user).toEqual(expect.objectContaining({
      userId: "user_session_admin",
      requestCount: 2,
      sessionCount: 1
    }));
    expect(userDetail.sessions[0]).toEqual(expect.objectContaining({
      sessionId: "session_admin",
      routeChanges: 1
    }));
    expect(userDetail.requests).toHaveLength(2);
    expect(sessionsList).toEqual([
      expect.objectContaining({
        sessionId: "session_admin",
        userId: "user_session_admin",
        requestCount: 2,
        routeChanges: 1,
        modelMix: { "gpt-fast": 1, "gpt-hard": 1 },
        routeMix: { fast: 1, hard: 1 },
        terminalStatusSummary: { completed: 1, failed: 1 }
      })
    ]);
    expect(sessionDetail.session).toEqual(expect.objectContaining({
      sessionId: "session_admin",
      externalSessionId: "codex-session",
      sessionIdentity: "harness"
    }));
    expect(sessionDetail.user).toEqual(expect.objectContaining({ id: "user_session_admin" }));
    expect(sessionDetail.requests).toHaveLength(2);
    expect(sessionDetail.promptArtifacts.map((artifact: any) => artifact.rawText)).toEqual([
      "First session prompt",
      "Second session prompt"
    ]);
    expect(sessionDetail.routeDecisions.map((decision: any) => decision.finalRoute).sort()).toEqual(["fast", "hard"]);
    expect(sessionDetail.providerAttempts.map((attempt: any) => attempt.terminalStatus).sort()).toEqual(["completed", "failed"]);
    expect(sessionDetail.usageLedger.map((usage: any) => usage.totalCostMicros).sort()).toEqual([1000, 3000]);
    expect(sessionDetail.events.map((event: any) => event.eventType)).toEqual(["proxy.request_received"]);
    expect(crossUser?.user).toBeNull();
    expect(crossSession?.session).toBeNull();
  });

  it("replays real and fallback sessions created by proxy requests", async () => {
    const fixture = await setup("org_session_replay_identity");

    const realSessionResponse = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-codex-session-id": "codex-session-real",
        "x-prompt-proxy-user-id": "codex_real_user"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "Real session prompt.",
        stream: true
      })
    });
    await realSessionResponse.text();

    const fallbackSessionResponse = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-prompt-proxy-user-id": "fallback_user"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "Fallback session prompt.",
        stream: true
      })
    });
    await fallbackSessionResponse.text();

    const sessionRows = await fixture.db.select().from(agentSessions);
    const realSession = sessionRows.find((session) => session.externalSessionId === "codex-session-real");
    const fallbackSession = sessionRows.find((session) => session.metadata.sessionIdentity === "request_fallback");
    expect(realSession).toBeDefined();
    expect(fallbackSession).toBeDefined();

    const realDetail = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      sessionDetailQuery,
      { sessionId: realSession?.id ?? "" }
    )).data?.session;
    const fallbackDetail = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      sessionDetailQuery,
      { sessionId: fallbackSession?.id ?? "" }
    )).data?.session;

    expect(realSessionResponse.status).toBe(200);
    expect(fallbackSessionResponse.status).toBe(200);
    expect(realSession).toEqual(expect.objectContaining({
      externalSessionId: "codex-session-real",
      userId: "codex_real_user",
      metadata: expect.objectContaining({ sessionIdentity: "harness" })
    }));
    expect(fallbackSession).toEqual(expect.objectContaining({
      externalSessionId: expect.stringMatching(/^request:/),
      userId: "fallback_user",
      metadata: expect.objectContaining({ sessionIdentity: "request_fallback" })
    }));
    expect(realDetail.session).toEqual(expect.objectContaining({
      sessionId: realSession?.id,
      externalSessionId: "codex-session-real",
      sessionIdentity: "harness"
    }));
    expect(fallbackDetail.session).toEqual(expect.objectContaining({
      sessionId: fallbackSession?.id,
      externalSessionId: fallbackSession?.externalSessionId,
      sessionIdentity: "request_fallback"
    }));
    expect(realDetail.promptArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawText: "Real session prompt." })
    ]));
    expect(fallbackDetail.promptArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawText: "Fallback session prompt." })
    ]));
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
