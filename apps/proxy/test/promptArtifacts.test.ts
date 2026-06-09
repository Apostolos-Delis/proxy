import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  createPgliteDatabase,
  events,
  organizationMembers,
  organizationSettings,
  organizations,
  promptAccessAudit,
  promptArtifacts,
  providerAttempts,
  requests,
  routeDecisions,
  users,
  usageLedger
} from "@prompt-proxy/db";

import { buildModelCatalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import { buildServer } from "../src/server.js";
import { listen, startAnthropicMock, startOpenAIMock, type MockServer } from "./helpers.js";

function testEnv(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    DATABASE_URL: "",
    EVENT_STORE_PATH: "",
    PROMPT_PROXY_TOKEN: "proxy-token",
    OPENAI_API_KEY: "openai-upstream-key",
    OPENAI_BASE_URL: "http://127.0.0.1",
    OPENAI_FAST_MODEL: "gpt-5.4-mini",
    OPENAI_BALANCED_MODEL: "gpt-5.4",
    OPENAI_HARD_MODEL: "gpt-5.5",
    OPENAI_DEEP_MODEL: "gpt-5.5-pro",
    ANTHROPIC_API_KEY: "anthropic-upstream-key",
    ANTHROPIC_BASE_URL: "http://127.0.0.1",
    ANTHROPIC_FAST_MODEL: "claude-haiku-4-5",
    ANTHROPIC_BALANCED_MODEL: "claude-sonnet-4-5",
    ANTHROPIC_HARD_MODEL: "claude-sonnet-4-5",
    ANTHROPIC_DEEP_MODEL: "claude-opus-4-5",
    CLASSIFIER_PROVIDER: "openai",
    CLASSIFIER_MODEL: "route-classifier-cheap",
    MODEL_COSTS_JSON: "",
    ROUTE_POLICY_SOURCE: "central",
    ADMIN_DEV_LOGIN_ENABLED: "true",
    ADMIN_DEV_LOGIN_EMAIL: "local@example.com",
    ADMIN_DEV_LOGIN_PASSWORD: "dev-password",
    SEED_USER_ID: "local-user",
    ...overrides
  };
}

describe("prompt artifact capture", () => {
  let app: ReturnType<typeof buildServer> | undefined;
  let client: PGlite | undefined;
  let openai: MockServer | undefined;
  let anthropic: MockServer | undefined;

  afterEach(async () => {
    await app?.close();
    await openai?.close();
    await anthropic?.close();
    await client?.close();
    app = undefined;
    openai = undefined;
    anthropic = undefined;
    client = undefined;
  });

  it("captures OpenAI string input, instructions, and tool metadata", async () => {
    const fixture = await captureFixture("org_openai_string");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        instructions: "Always answer in terse bullets.",
        input: "Write tests for @filename.",
        tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);
    const eventRows = await fixture.db.select().from(events);
    const captureEvent = eventRows.find((event) => event.eventType === "prompt_artifacts.captured");
    const requestDetail = captureEvent
      ? await fetch(`${fixture.proxyUrl}/admin/requests/${captureEvent.scopeId}`, {
          headers: fixture.adminHeaders
        }).then((item) => item.json())
      : undefined;

    expect(response.status).toBe(200);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "instructions",
        storageMode: "raw_text",
        rawText: "Always answer in terse bullets.",
        sourceRole: "system"
      }),
      expect.objectContaining({
        kind: "latest_user_message",
        storageMode: "raw_text",
        rawText: "Write tests for @filename.",
        sourceRole: "user",
        sourceIndex: 0
      }),
      expect.objectContaining({
        kind: "tool_schema_metadata",
        storageMode: "hash_only",
        rawText: null,
        sourceRole: "tool",
        metadata: expect.objectContaining({
          surface: "openai-responses",
          toolCount: 1,
          tools: [{ type: "function", name: "shell" }]
        })
      })
    ]));
    expect(captureEvent?.payload).toEqual(expect.objectContaining({
      surface: "openai-responses",
      artifactCount: 3,
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          artifactId: expect.any(String),
          kind: "instructions",
          storageMode: "raw_text",
          contentHash: expect.stringMatching(/^sha256:/)
        }),
        expect.objectContaining({
          artifactId: expect.any(String),
          kind: "latest_user_message",
          storageMode: "raw_text",
          contentHash: expect.stringMatching(/^sha256:/)
        }),
        expect.objectContaining({
          artifactId: expect.any(String),
          kind: "tool_schema_metadata",
          storageMode: "hash_only",
          metadata: expect.objectContaining({ toolCount: 1 })
        })
      ])
    }));
    expect(requestDetail?.events.map((event: any) => event.eventType)).toContain("prompt_artifacts.captured");
    expect(eventPayloadText(eventRows)).not.toContain("Always answer in terse bullets.");
    expect(eventPayloadText(eventRows)).not.toContain("Write tests for @filename.");
    expect(eventPayloadText(eventRows)).not.toContain("parameters");
  });

  it("captures only the latest OpenAI user message from array input", async () => {
    const fixture = await captureFixture("org_openai_array");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "old request" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "ack" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "latest request" }] }
        ],
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);

    expect(response.status).toBe(200);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "latest_user_message",
        storageMode: "raw_text",
        rawText: "latest request",
        sourceRole: "user",
        sourceIndex: 2
      })
    ]));
    expect(rows.some((row) => row.rawText === "old request")).toBe(false);
  });

  it("captures Anthropic system, latest user message, and tool metadata", async () => {
    const fixture = await captureFixture("org_anthropic");

    const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        system: "Use the mortgage domain rules.",
        messages: [
          { role: "user", content: "older question" },
          { role: "assistant", content: "ack" },
          { role: "user", content: [{ type: "text", text: "latest Claude question" }] }
        ],
        tools: [{ name: "bash", input_schema: { type: "object" } }],
        max_tokens: 1024,
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);
    const eventRows = await fixture.db.select().from(events);
    const captureEvent = eventRows.find((event) => event.eventType === "prompt_artifacts.captured");

    expect(response.status).toBe(200);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "system",
        storageMode: "raw_text",
        rawText: "Use the mortgage domain rules.",
        sourceRole: "system"
      }),
      expect.objectContaining({
        kind: "latest_user_message",
        storageMode: "raw_text",
        rawText: "latest Claude question",
        sourceRole: "user",
        sourceIndex: 2
      }),
      expect.objectContaining({
        kind: "tool_schema_metadata",
        storageMode: "hash_only",
        metadata: expect.objectContaining({
          surface: "anthropic-messages",
          toolCount: 1,
          tools: [{ type: null, name: "bash" }]
        })
      })
    ]));
    expect(captureEvent?.payload).toEqual(expect.objectContaining({
      surface: "anthropic-messages",
      artifactCount: 3,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ kind: "system" }),
        expect.objectContaining({ kind: "latest_user_message" }),
        expect.objectContaining({ kind: "tool_schema_metadata" })
      ])
    }));
    expect(eventPayloadText(eventRows)).not.toContain("Use the mortgage domain rules.");
    expect(eventPayloadText(eventRows)).not.toContain("latest Claude question");
    expect(eventPayloadText(eventRows)).not.toContain("input_schema");
  });

  it("fails before classifier or provider spend when prompt capture fails", async () => {
    const fixture = await captureFixture("org_capture_failure", "raw_text", true);

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "this should not reach the classifier",
        stream: true
      })
    });
    await response.text();

    expect(response.status).toBe(500);
    expect(openai?.records).toHaveLength(0);
  });

  it("keeps prompt content hash-only when raw capture is not enabled", async () => {
    const fixture = await captureFixture("org_hash_only", "hash_only");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "Do not store me raw.",
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);

    expect(response.status).toBe(200);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "latest_user_message",
        storageMode: "hash_only",
        rawText: null,
        sourceRole: "user"
      })
    ]));
    expect(rows.some((row) => row.rawText === "Do not store me raw.")).toBe(false);
  });

  it("handles empty input without writing raw prompt artifacts", async () => {
    const fixture = await captureFixture("org_empty");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: [],
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);

    expect(response.status).toBe(200);
    expect(rows.filter((row) => row.storageMode === "raw_text")).toHaveLength(0);
  });

  it("requires browser admin sessions for admin APIs", async () => {
    const fixture = await captureFixture("org_admin_auth");

    const unauthenticated = await fetch(`${fixture.proxyUrl}/admin/overview`);
    const me = await fetch(`${fixture.proxyUrl}/api/auth/me`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
    const logout = await fetch(`${fixture.proxyUrl}/api/auth/logout`, {
      method: "POST",
      headers: fixture.adminHeaders
    });
    const afterLogout = await fetch(`${fixture.proxyUrl}/admin/overview`, {
      headers: fixture.adminHeaders
    });

    expect(unauthenticated.status).toBe(401);
    expect(me.user).toEqual(expect.objectContaining({
      organizationId: "org_admin_auth",
      userId: "local-user",
      email: "local@example.com",
      role: "owner"
    }));
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(afterLogout.status).toBe(401);
  });

  it("serves org-scoped prompt list and detail admin APIs", async () => {
    const fixture = await captureFixture("org_prompt_admin");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-prompt-proxy-user-id": "user_prompt_admin"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "Investigate prompt admin APIs.",
        stream: true
      })
    });
    await response.text();

    const prompts = await fetch(
      `${fixture.proxyUrl}/admin/prompts?userId=user_prompt_admin&surface=openai-responses&route=hard&model=gpt-5.5&limit=10&offset=0`,
      { headers: fixture.adminHeaders }
    ).then((item) => item.json());
    const latestUser = prompts.data.find((item: any) => item.kind === "latest_user_message");
    const usageBeforeDetail = await fetch(`${fixture.proxyUrl}/admin/usage?groupBy=route`, {
      headers: fixture.adminHeaders
    });
    const auditAfterListAndUsage = await fixture.db.select().from(promptAccessAudit);
    const detail = await fetch(`${fixture.proxyUrl}/admin/prompts/${latestUser.artifactId}`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());

    await fixture.db.insert(organizations).values({
      id: "org_other",
      slug: "org-other",
      name: "Other Org"
    });
    await fixture.db.insert(requests).values({
      id: "request_other",
      organizationId: "org_other",
      surface: "openai-responses",
      idempotencyKey: "idem_other",
      requestedModel: "router-auto",
      inputHash: "sha256:other",
      inputChars: 5
    });
    await fixture.db.insert(promptArtifacts).values({
      id: "artifact_other",
      organizationId: "org_other",
      requestId: "request_other",
      kind: "latest_user_message",
      storageMode: "raw_text",
      contentHash: "sha256:other",
      rawText: "other org prompt"
    });
    const crossOrg = await fetch(`${fixture.proxyUrl}/admin/prompts/artifact_other`, {
      headers: fixture.adminHeaders
    });
    const auditRows = await fixture.db.select().from(promptAccessAudit);
    const auditList = await fetch(`${fixture.proxyUrl}/admin/prompt-access-audit`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());

    expect(response.status).toBe(200);
    expect(usageBeforeDetail.status).toBe(200);
    expect(auditAfterListAndUsage).toHaveLength(0);
    expect(prompts.pagination).toEqual({ limit: 10, offset: 0, count: expect.any(Number) });
    expect(prompts.data.length).toBeGreaterThan(0);
    expect(prompts.data.every((item: any) => item.userId === "user_prompt_admin")).toBe(true);
    expect(latestUser).toEqual(expect.objectContaining({
      surface: "openai-responses",
      storageMode: "raw_text",
      preview: "Investigate prompt admin APIs.",
      finalRoute: "hard",
      provider: "openai",
      selectedModel: "gpt-5.5"
    }));
    expect(detail.artifact.rawText).toBe("Investigate prompt admin APIs.");
    expect(detail.request).toEqual(expect.objectContaining({
      requestId: latestUser.requestId,
      provider: "openai",
      selectedModel: "gpt-5.5",
      finalRoute: "hard"
    }));
    expect(detail.events.map((event: any) => event.eventType)).toContain("prompt_artifacts.captured");
    expect(crossOrg.status).toBe(404);
    expect(auditRows).toEqual([
      expect.objectContaining({
        organizationId: "org_prompt_admin",
        artifactId: latestUser.artifactId,
        requestId: latestUser.requestId,
        userId: "local-user",
        route: "hard",
        accessPath: `/admin/prompts/${latestUser.artifactId}`
      })
    ]);
    expect(auditList.data).toEqual([
      expect.objectContaining({
        artifactId: latestUser.artifactId,
        requestId: latestUser.requestId,
        userId: "local-user",
        route: "hard"
      })
    ]);
  });

  it("configures prompt retention and redacts expired raw artifacts", async () => {
    const fixture = await captureFixture("org_prompt_retention");

    const settings = await fetch(`${fixture.proxyUrl}/admin/settings/prompt-capture`, {
      method: "PATCH",
      headers: {
        ...fixture.adminHeaders,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        promptCaptureMode: "raw_text",
        retentionDays: 1
      })
    }).then((item) => item.json());
    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "Expire this raw prompt.",
        stream: true
      })
    });
    await response.text();

    const [artifact] = await fixture.db
      .select()
      .from(promptArtifacts)
      .where(eq(promptArtifacts.kind, "latest_user_message"));
    const originalHash = artifact.contentHash;
    await fixture.db
      .update(promptArtifacts)
      .set({ expiresAt: new Date("2026-06-07T00:00:00.000Z") })
      .where(eq(promptArtifacts.id, artifact.id));
    const redaction = await fixture.persistence.promptArtifacts.redactExpired(
      "org_prompt_retention",
      new Date("2026-06-08T00:00:00.000Z")
    );
    const detail = await fetch(`${fixture.proxyUrl}/admin/prompts/${artifact.id}`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
    const usage = await fetch(`${fixture.proxyUrl}/admin/usage?groupBy=route`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());

    expect(settings).toEqual({
      organizationId: "org_prompt_retention",
      promptCaptureMode: "raw_text",
      retentionDays: 1
    });
    expect(response.status).toBe(200);
    expect(artifact.rawText).toBe("Expire this raw prompt.");
    expect(artifact.expiresAt).toBeInstanceOf(Date);
    expect(redaction).toEqual({ redactedCount: 1 });
    expect(detail.artifact).toEqual(expect.objectContaining({
      storageMode: "redacted",
      rawText: null,
      redactedText: "Redacted by retention policy.",
      contentHash: originalHash
    }));
    expect(detail.artifact.metadata).toEqual(expect.objectContaining({
      chars: "Expire this raw prompt.".length
    }));
    expect(usage.totals.requestCount).toBeGreaterThan(0);
  });

  it("serves persisted usage analytics with grouping and time filters", async () => {
    const fixture = await captureFixture("org_usage_admin");
    const inside = new Date("2026-06-08T12:00:00.000Z");
    const outside = new Date("2026-06-01T12:00:00.000Z");

    await fixture.db.insert(users).values([
      { id: "user_a" },
      { id: "user_b" },
      { id: "user_old" }
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
      }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("usage_request_fast", "org_usage_admin", "user_a", "session_a", "openai-responses", inside),
      usageRequest("usage_request_hard", "org_usage_admin", "user_b", "session_b", "anthropic-messages", inside),
      usageRequest("usage_request_old", "org_usage_admin", "user_old", "session_old", "openai-responses", outside)
    ]);
    await fixture.db.insert(routeDecisions).values([
      usageDecision("usage_decision_fast", "usage_request_fast", "org_usage_admin", "fast", "openai", "gpt-fast"),
      usageDecision("usage_decision_hard", "usage_request_hard", "org_usage_admin", "hard", "anthropic", "claude-hard"),
      usageDecision("usage_decision_old", "usage_request_old", "org_usage_admin", "fast", "openai", "gpt-old")
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("usage_attempt_fast", "usage_request_fast", "org_usage_admin", "openai-responses", "openai", "gpt-fast", "completed", inside),
      usageAttempt("usage_attempt_hard_old", "usage_request_hard", "org_usage_admin", "anthropic-messages", "anthropic", "claude-hard", "failed", new Date("2026-06-08T12:00:01.000Z")),
      usageAttempt("usage_attempt_hard_new", "usage_request_hard", "org_usage_admin", "anthropic-messages", "anthropic", "claude-hard", "failed", new Date("2026-06-08T12:00:02.000Z")),
      usageAttempt("usage_attempt_old", "usage_request_old", "org_usage_admin", "openai-responses", "openai", "gpt-old", "completed", outside)
    ]);
    await fixture.db.insert(usageLedger).values([
      usageRow("usage_fast", "usage_request_fast", "usage_attempt_fast", "org_usage_admin", "openai", "gpt-fast", "fast", 100, 25, 1000),
      usageRow("usage_hard_retry", "usage_request_hard", "usage_attempt_hard_old", "org_usage_admin", "anthropic", "claude-hard", "hard", 10, 5, 500),
      usageRow("usage_hard", "usage_request_hard", "usage_attempt_hard_new", "org_usage_admin", "anthropic", "claude-hard", "hard", 200, 50, 3000),
      usageRow("usage_old", "usage_request_old", "usage_attempt_old", "org_usage_admin", "openai", "gpt-old", "fast", 999, 999, 9999)
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

  it("serves org-scoped users and sessions admin APIs", async () => {
    const fixture = await captureFixture("org_users_sessions");
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
    await fixture.db.insert(agentSessions).values([
      {
        id: "session_admin",
        organizationId: "org_users_sessions",
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

    const usersList = await fetch(`${fixture.proxyUrl}/admin/users`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
    const userDetail = await fetch(`${fixture.proxyUrl}/admin/users/user_session_admin`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
    const sessionsList = await fetch(`${fixture.proxyUrl}/admin/sessions`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
    const sessionDetail = await fetch(`${fixture.proxyUrl}/admin/sessions/session_admin`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
    const crossUser = await fetch(`${fixture.proxyUrl}/admin/users/user_other_org`, {
      headers: fixture.adminHeaders
    });
    const crossSession = await fetch(`${fixture.proxyUrl}/admin/sessions/session_other`, {
      headers: fixture.adminHeaders
    });

    expect(usersList.data).toEqual(expect.arrayContaining([
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
    expect(sessionsList.data).toEqual([
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
    expect(crossUser.status).toBe(404);
    expect(crossSession.status).toBe(404);
  });

  async function captureFixture(
    organizationId: string,
    promptCaptureMode: "hash_only" | "raw_text" = "raw_text",
    failCapture = false
  ) {
    client = new PGlite();
    const migration = await readFile(
      fileURLToPath(new URL("../../../packages/db/migrations/0000_foundation.sql", import.meta.url)),
      "utf8"
    );
    await client.exec(migration);
    const db = createPgliteDatabase(client);
    openai = await startOpenAIMock();
    anthropic = await startAnthropicMock();
    const config = loadConfig({
      ...testEnv(),
      DEFAULT_ORGANIZATION_ID: organizationId,
      OPENAI_BASE_URL: openai.url,
      ANTHROPIC_BASE_URL: anthropic.url,
      LOG_LEVEL: "fatal"
    });
    const catalog = buildModelCatalog(config);
    const persistence = createDatabasePersistence(db, catalog, config, false);
    if (failCapture) {
      persistence.promptArtifacts.capture = async () => {
        throw new Error("capture_failed");
      };
    }

    await db.insert(organizations).values({
      id: organizationId,
      slug: organizationId,
      name: organizationId
    });
    await db.insert(users).values({
      id: "local-user",
      email: "local@example.com",
      name: "Local User"
    });
    await db.insert(organizationMembers).values({
      organizationId,
      userId: "local-user",
      role: "owner"
    });
    await db.insert(organizationSettings).values({
      organizationId,
      promptCaptureMode
    });

    app = buildServer(config, { persistence });
    const proxyUrl = await listen(app);
    return {
      db,
      persistence,
      proxyUrl,
      adminHeaders: await loginAdmin(proxyUrl)
    };
  }
});

async function loginAdmin(proxyUrl: string) {
  const response = await fetch(`${proxyUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "local@example.com",
      password: "dev-password"
    })
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toBeTruthy();
  return { cookie: cookie ?? "" };
}

function usageRequest(
  id: string,
  organizationId: string,
  userId: string,
  sessionId: string,
  surface: "openai-responses" | "anthropic-messages",
  createdAt: Date
) {
  return {
    id,
    organizationId,
    userId,
    sessionId,
    surface,
    idempotencyKey: `idem_${id}`,
    requestedModel: "router-auto",
    inputHash: `sha256:${id}`,
    inputChars: 10,
    status: "completed" as const,
    createdAt
  };
}

function usageDecision(
  id: string,
  requestId: string,
  organizationId: string,
  finalRoute: "fast" | "hard",
  selectedProvider: "openai" | "anthropic",
  selectedModel: string
) {
  return {
    id,
    requestId,
    organizationId,
    requestedModel: "router-auto",
    finalRoute,
    selectedProvider,
    selectedModel,
    policyVersion: "test"
  };
}

function usageAttempt(
  id: string,
  requestId: string,
  organizationId: string,
  surface: "openai-responses" | "anthropic-messages",
  provider: "openai" | "anthropic",
  model: string,
  terminalStatus: "completed" | "failed",
  startedAt: Date
) {
  return {
    id,
    requestId,
    organizationId,
    surface,
    provider,
    model,
    terminalStatus,
    startedAt,
    completedAt: startedAt
  };
}

function usageRow(
  id: string,
  requestId: string,
  providerAttemptId: string,
  organizationId: string,
  provider: "openai" | "anthropic",
  model: string,
  route: "fast" | "hard",
  inputTokens: number,
  outputTokens: number,
  totalCostMicros: number
) {
  return {
    id,
    organizationId,
    requestId,
    providerAttemptId,
    provider,
    model,
    route,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    totalCostMicros
  };
}

function sessionPrompt(
  id: string,
  organizationId: string,
  requestId: string,
  rawText: string,
  createdAt: Date
) {
  return {
    id,
    organizationId,
    requestId,
    kind: "latest_user_message",
    storageMode: "raw_text" as const,
    contentHash: `sha256:${id}`,
    rawText,
    sourceRole: "user",
    metadata: { chars: rawText.length },
    createdAt
  };
}

function sessionEvent(
  id: string,
  organizationId: string,
  requestId: string,
  sessionId: string,
  createdAt: Date
) {
  return {
    id,
    sequence: 1,
    schemaVersion: 1,
    organizationId,
    scopeType: "request",
    scopeId: requestId,
    sessionId,
    correlationId: requestId,
    actorType: "user",
    actorId: "test",
    producer: "test",
    eventType: "proxy.request_received",
    payloadHash: `sha256:${id}`,
    sensitivity: "internal",
    redactionState: "redacted",
    payload: {
      surface: "openai-responses",
      requestedModel: "router-auto"
    },
    metadata: {},
    createdAt
  };
}

function eventPayloadText(rows: Array<typeof events.$inferSelect>) {
  return rows.map((row) => JSON.stringify(row.payload)).join("\n");
}
