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
} from "@proxy/db";

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
    promptArtifacts { rawText provider selectedModel cost { selected } }
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
    expect(sessionDetail.promptArtifacts).toEqual([
      expect.objectContaining({
        provider: "openai",
        selectedModel: "gpt-fast",
        cost: { selected: 0.001 }
      }),
      expect.objectContaining({
        provider: "openai",
        selectedModel: "gpt-hard",
        cost: { selected: 0.003 }
      })
    ]);
    expect(sessionDetail.routeDecisions.map((decision: any) => decision.finalRoute).sort()).toEqual(["fast", "hard"]);
    expect(sessionDetail.providerAttempts.map((attempt: any) => attempt.terminalStatus).sort()).toEqual(["completed", "failed"]);
    expect(sessionDetail.usageLedger.map((usage: any) => usage.totalCostMicros).sort()).toEqual([1000, 3000]);
    expect(sessionDetail.events.map((event: any) => event.eventType)).toEqual(["proxy.request_received"]);
    expect(crossUser?.user).toBeNull();
    expect(crossSession?.session).toBeNull();
  });

  it("serves lightweight session prompt previews unless raw text is selected", async () => {
    const fixture = await setup("org_session_preview");
    const createdAt = new Date("2026-06-08T12:00:00.000Z");
    const rawText = `${"A".repeat(180)} full tail`;

    await fixture.db.insert(agentSessions).values({
      id: "session_preview",
      organizationId: "org_session_preview",
      workspaceId: defaultWorkspaceId("org_session_preview"),
      userId: "local-user",
      surface: "openai-responses",
      externalSessionId: "preview-session",
      startedAt: createdAt,
      updatedAt: createdAt
    });
    await fixture.db.insert(requests).values(
      usageRequest("session_preview_request", "org_session_preview", "local-user", "session_preview", "openai-responses", createdAt)
    );
    await fixture.db.insert(promptArtifacts).values(
      sessionPrompt("session_preview_prompt", "org_session_preview", "session_preview_request", rawText, createdAt)
    );

    const previewDetail = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query SessionPreview($sessionId: ID!) {
        session(sessionId: $sessionId) {
          promptArtifacts { preview chars }
        }
      }`,
      { sessionId: "session_preview" }
    )).data?.session;
    const fullDetail = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query SessionFull($sessionId: ID!) {
        session(sessionId: $sessionId) {
          promptArtifacts { rawText preview chars }
        }
      }`,
      { sessionId: "session_preview" }
    )).data?.session;

    expect(previewDetail.promptArtifacts).toEqual([
      expect.objectContaining({
        preview: `${"A".repeat(160)}...`,
        chars: rawText.length
      })
    ]);
    expect(JSON.stringify(previewDetail)).not.toContain("full tail");
    expect(fullDetail.promptArtifacts[0].rawText).toBe(rawText);
  });

  it("replays real and fallback sessions created by proxy requests", async () => {
    const fixture = await setup("org_session_replay_identity");

    const realSessionResponse = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-codex-session-id": "codex-session-real",
        "x-proxy-user-id": "codex_real_user"
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
        "x-proxy-user-id": "fallback_user"
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
      userId: "local-user",
      metadata: expect.objectContaining({ sessionIdentity: "harness" })
    }));
    expect(fallbackSession).toEqual(expect.objectContaining({
      externalSessionId: expect.stringMatching(/^request:/),
      userId: "local-user",
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

  it("reports per-session cache hit rate from ledger cache fields", async () => {
    const fixture = await setup("org_cache_sessions");
    const at = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(users).values([
      { id: "user_cache", email: "cache@example.com", name: "Cache User" }
    ]);
    await fixture.db.insert(agentSessions).values([
      {
        id: "session_cache",
        organizationId: "org_cache_sessions",
        workspaceId: defaultWorkspaceId("org_cache_sessions"),
        userId: "user_cache",
        surface: "anthropic-messages",
        externalSessionId: "claude-session",
        startedAt: at,
        updatedAt: at
      },
      {
        id: "session_cache_openai",
        organizationId: "org_cache_sessions",
        workspaceId: defaultWorkspaceId("org_cache_sessions"),
        userId: "user_cache",
        surface: "openai-responses",
        externalSessionId: "codex-session",
        startedAt: at,
        updatedAt: at
      }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("cache_request", "org_cache_sessions", "user_cache", "session_cache", "anthropic-messages", at),
      usageRequest("cache_request_openai", "org_cache_sessions", "user_cache", "session_cache_openai", "openai-responses", at)
    ]);
    await fixture.db.insert(routeDecisions).values([
      usageDecision("cache_decision", "cache_request", "org_cache_sessions", "hard", "anthropic", "claude-hard"),
      usageDecision("cache_decision_openai", "cache_request_openai", "org_cache_sessions", "hard", "openai", "gpt-hard")
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("cache_attempt", "cache_request", "org_cache_sessions", "anthropic-messages", "anthropic", "claude-hard", "completed", at),
      usageAttempt("cache_attempt_openai", "cache_request_openai", "org_cache_sessions", "openai-responses", "openai", "gpt-hard", "completed", at)
    ]);
    await fixture.db.insert(usageLedger).values([
      {
        // Normalized convention: the inputTokens column is the total prompt
        // input with reads/writes as subsets; only the raw jsonb stays
        // exclusive the way Anthropic reported it.
        ...usageRow("cache_usage", "cache_request", "cache_attempt", "org_cache_sessions", "anthropic", "claude-hard", "hard", 1000, 50, 2000),
        cachedInputTokens: 800,
        cacheCreationInputTokens: 100,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 100
        }
      },
      {
        // OpenAI reports cached tokens as a subset of input_tokens.
        ...usageRow("cache_usage_openai", "cache_request_openai", "cache_attempt_openai", "org_cache_sessions", "openai", "gpt-hard", "hard", 1000, 50, 1500),
        cachedInputTokens: 250,
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 250 }
        }
      }
    ]);

    const sessions = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { sessions {
        sessionId
        cacheHitRate
        usage { cachedInputTokens cacheCreationInputTokens }
        cost { selected }
      } }`
    )).data?.sessions;

    expect(sessions).toHaveLength(2);
    const bySession = Object.fromEntries(sessions.map((session: any) => [session.sessionId, session]));
    expect(bySession.session_cache.usage.cachedInputTokens).toBe(800);
    expect(bySession.session_cache.usage.cacheCreationInputTokens).toBe(100);
    // reads (800) over total prompt input (1000); writes count as misses
    expect(bySession.session_cache.cacheHitRate).toBe(0.8);
    expect(bySession.session_cache.cost.selected).toBeCloseTo(0.002, 6);
    expect(bySession.session_cache_openai.cacheHitRate).toBe(0.25);
  });

  it("labels rejected and unrouted requests in the session model mix", async () => {
    const fixture = await setup("org_rejected_sessions");
    const at = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(users).values([
      { id: "user_rejected", email: "rejected@example.com", name: "Rejected User" }
    ]);
    await fixture.db.insert(agentSessions).values({
      id: "session_rejected",
      organizationId: "org_rejected_sessions",
      workspaceId: defaultWorkspaceId("org_rejected_sessions"),
      userId: "user_rejected",
      surface: "openai-responses",
      externalSessionId: "codex-rejected",
      startedAt: at,
      updatedAt: at
    });
    await fixture.db.insert(requests).values([
      usageRequest("served_request", "org_rejected_sessions", "user_rejected", "session_rejected", "openai-responses", at),
      { ...usageRequest("rejected_request", "org_rejected_sessions", "user_rejected", "session_rejected", "openai-responses", at), status: "failed" as const },
      { ...usageRequest("unrouted_request", "org_rejected_sessions", "user_rejected", "session_rejected", "openai-responses", at), status: "failed" as const }
    ]);
    await fixture.db.insert(routeDecisions).values([
      usageDecision("served_decision", "served_request", "org_rejected_sessions", "hard", "openai", "gpt-hard"),
      {
        // Router rejection: decision recorded, but no model was ever selected.
        id: "rejected_decision",
        requestId: "rejected_request",
        organizationId: "org_rejected_sessions",
        workspaceId: defaultWorkspaceId("org_rejected_sessions"),
        requestedModel: "router-auto",
        reasonCodes: ["request_estimated_input_limit"],
        policyVersion: "test"
      }
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("served_attempt", "served_request", "org_rejected_sessions", "openai-responses", "openai", "gpt-hard", "completed", at)
    ]);

    const sessions = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { sessions { sessionId modelMix } }"
    )).data?.sessions;

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: "session_rejected",
        modelMix: { "gpt-hard": 1, rejected: 1, unknown: 1 }
      })
    ]);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
