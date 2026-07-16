import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeys,
  defaultWorkspaceId,
  events,
  hashApiKey,
  organizationMembers,
  organizations,
  promptAccessAudit,
  promptArtifacts,
  providerAttempts,
  requests,
  routeDecisions,
  usageLedger,
  users,
  workspaces
} from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";

import {
  adminGql,
  captureFixture,
  usageAttempt,
  usageDecision,
  usageRequest,
  usageRow,
  type PromptTestFixture
} from "./promptTestFixture.js";

const promptListQuery = `query Prompts($userId: String, $surface: String, $logicalModel: String, $model: String, $limit: Int, $offset: Int) {
  prompts(userId: $userId, surface: $surface, logicalModel: $logicalModel, model: $model, limit: $limit, offset: $offset) {
    data {
      artifactId
      requestId
      userId
      kind
      surface
      storageMode
      preview
      requestedLogicalModel
      resolvedLogicalModelId
      accessProfileId
      deploymentId
      providerConnectionId
      provider
      selectedModel
      routerDecision
      cost { selected }
    }
    pagination { limit offset count }
  }
}`;

const promptDetailQuery = `query Prompt($artifactId: ID!) {
  prompt(artifactId: $artifactId) {
    artifact {
      artifactId
      requestId
      rawText
      requestedLogicalModel
      resolvedLogicalModelId
      accessProfileId
      deploymentId
      providerConnectionId
      routerDecision
    }
    request {
      requestId
      surface
      provider
      selectedModel
      requestedLogicalModel
      resolvedLogicalModelId
      accessProfileId
      deploymentId
      providerConnectionId
      routerDecision
    }
    events { eventType }
  }
}`;

describe("admin prompt APIs", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("requires browser admin sessions for admin APIs", async () => {
    const fixture = await setup("org_admin_auth");

    const unauthenticated = await adminGql(
      fixture.proxyUrl,
      {},
      "query { overview { organizationId } }"
    );
    const me = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { viewer { user { organizationId userId email role } } }"
    )).data?.viewer;
    const logout = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "mutation { logout }"
    );
    const afterLogout = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { overview { organizationId } }"
    );

    const anonymousIntrospection = await adminGql(
      fixture.proxyUrl,
      {},
      "query { __schema { queryType { name } } }"
    );

    expect(unauthenticated.status).toBe(401);
    expect(anonymousIntrospection.errors?.[0]?.message).toContain("Introspection requires");
    expect(me.user).toEqual(expect.objectContaining({
      organizationId: "org_admin_auth",
      userId: "local-user",
      email: "local@example.com",
      role: "owner"
    }));
    expect(logout.status).toBe(200);
    expect(logout.data?.logout).toBe(true);
    expect(logout.setCookie).toContain("Max-Age=0");
    expect(afterLogout.status).toBe(401);
  });

  it("serves OpenAI prompt detail and audits raw prompt reads", async () => {
    const fixture = await setup("org_prompt_admin");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-proxy-user-id": "user_prompt_admin"
      },
      body: JSON.stringify({
        model: "coding-auto",
        input: "Investigate prompt admin APIs.",
        stream: true
      })
    });
    await response.text();

    const prompts = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, promptListQuery, {
      userId: "local-user",
      surface: "openai-responses",
      logicalModel: `${defaultWorkspaceId("org_prompt_admin")}:logical-model:coding-auto`,
      model: "gpt-5.4-mini",
      limit: 10,
      offset: 0
    })).data?.prompts;
    const latestUser = prompts.data.find((item: any) => item.kind === "user_message");
    const usageBeforeDetail = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { usage(groupBy: logical_model) { totals { requestCount } } }"
    );
    const auditAfterListAndUsage = await fixture.db.select().from(promptAccessAudit);
    const detail = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, promptDetailQuery, {
      artifactId: latestUser.artifactId
    })).data?.prompt;

    await fixture.db.insert(organizations).values({
      id: "org_other",
      slug: "org-other",
      name: "Other Org"
    });
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_other"),
      organizationId: "org_other",
      slug: "default",
      name: "Default"
    });
    await fixture.db.insert(requests).values({
      id: "request_other",
      organizationId: "org_other",
      workspaceId: defaultWorkspaceId("org_other"),
      surface: "openai-responses",
      idempotencyKey: "idem_other",
      requestedModel: "coding-auto",
      inputHash: "sha256:other",
      inputChars: 5
    });
    await fixture.db.insert(promptArtifacts).values({
      id: "artifact_other",
      organizationId: "org_other",
      workspaceId: defaultWorkspaceId("org_other"),
      requestId: "request_other",
      kind: "user_message",
      storageMode: "raw_text",
      contentHash: "sha256:other",
      rawText: "other org prompt"
    });
    const crossOrg = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, promptDetailQuery, {
      artifactId: "artifact_other"
    })).data;
    const auditRows = await fixture.db.select().from(promptAccessAudit);
    const auditList = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { promptAccessAudit { artifactId requestId userId accessPath } }"
    )).data?.promptAccessAudit;

    expect(response.status).toBe(200);
    expect(usageBeforeDetail.status).toBe(200);
    expect(auditAfterListAndUsage).toHaveLength(0);
    expect(prompts.pagination).toEqual({ limit: 10, offset: 0, count: expect.any(Number) });
    expect(prompts.data.length).toBeGreaterThan(0);
    expect(prompts.data.every((item: any) => item.userId === "local-user")).toBe(true);
    expect(latestUser).toEqual(expect.objectContaining({
      surface: "openai-responses",
      storageMode: "raw_text",
      preview: "Investigate prompt admin APIs.",
      requestedLogicalModel: "coding-auto",
      provider: "openai",
      selectedModel: "gpt-5.4-mini",
      accessProfileId: expect.stringContaining("opendoor-engineer"),
      deploymentId: expect.stringContaining("gpt-5.4-mini"),
      providerConnectionId: expect.stringContaining("connection:openai")
    }));
    expect(latestUser.routerDecision).toEqual(expect.objectContaining({
      kind: "classifier",
      classifierDeploymentId: expect.stringContaining("route-classifier-cheap")
    }));
    expect(detail.artifact.rawText).toBe("Investigate prompt admin APIs.");
    expect(detail.artifact.requestedLogicalModel).toBe("coding-auto");
    expect(detail.artifact.routerDecision).toEqual(latestUser.routerDecision);
    expect(detail.request).toEqual(expect.objectContaining({
      requestId: latestUser.requestId,
      provider: "openai",
      selectedModel: "gpt-5.4-mini",
      requestedLogicalModel: "coding-auto",
      accessProfileId: latestUser.accessProfileId,
      deploymentId: latestUser.deploymentId,
      providerConnectionId: latestUser.providerConnectionId
    }));
    expect(detail.events.map((event: any) => event.eventType)).toContain("prompt_artifacts.captured");
    expect(crossOrg?.prompt).toBeNull();
    expect(auditRows).toEqual([
      expect.objectContaining({
        organizationId: "org_prompt_admin",
        artifactId: latestUser.artifactId,
        requestId: latestUser.requestId,
        userId: "local-user",
        accessPath: "/admin/graphql#prompt"
      })
    ]);
    expect(auditList).toEqual([
      expect.objectContaining({
        artifactId: latestUser.artifactId,
        requestId: latestUser.requestId,
        userId: "local-user"
      })
    ]);
  });

  it("serves Anthropic prompt detail after proxy capture", async () => {
    const fixture = await setup("org_anthropic_prompt_admin");

    const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-claude-code-session-id": "claude-admin-session",
        "x-proxy-user-id": "claude_user"
      },
      body: JSON.stringify({
        model: "fable",
        system: "Use the underwriting rules.",
        messages: [{ role: "user", content: "Review this Claude Code task." }],
        max_tokens: 256,
        stream: true
      })
    });
    await response.text();

    const prompts = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, promptListQuery, {
      userId: "local-user",
      surface: "anthropic-messages",
      logicalModel: `${defaultWorkspaceId("org_anthropic_prompt_admin")}:logical-model:fable`,
      model: "claude-fable-5"
    })).data?.prompts;
    const latestUser = prompts.data.find((item: any) => item.kind === "user_message");
    const detail = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, promptDetailQuery, {
      artifactId: latestUser.artifactId
    })).data?.prompt;

    expect(response.status).toBe(200);
    expect(latestUser).toEqual(expect.objectContaining({
      surface: "anthropic-messages",
      preview: "Review this Claude Code task.",
      requestedLogicalModel: "fable",
      provider: "anthropic",
      selectedModel: "claude-fable-5",
      routerDecision: {}
    }));
    expect(detail.artifact.rawText).toBe("Review this Claude Code task.");
    expect(detail.request).toEqual(expect.objectContaining({
      requestId: latestUser.requestId,
      surface: "anthropic-messages",
      provider: "anthropic",
      selectedModel: "claude-fable-5",
      requestedLogicalModel: "fable",
      routerDecision: {}
    }));
    expect(detail.events.map((event: any) => event.eventType)).toContain("prompt_artifacts.captured");
  });

  it("lists prompt artifacts once when requests have provider and classifier usage", async () => {
    const fixture = await setup("org_prompt_usage_join");
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    await fixture.db.insert(requests).values({
      ...usageRequest(
        "request_prompt_usage_join",
        "org_prompt_usage_join",
        "local-user",
        "",
        "openai-responses",
        createdAt
      ),
      sessionId: null
    });
    await fixture.db.insert(routeDecisions).values(usageDecision(
      "decision_prompt_usage_join",
      "request_prompt_usage_join",
      "org_prompt_usage_join",
      "openai-responses",
      "openai",
      "gpt-5.5"
    ));
    await fixture.db.insert(providerAttempts).values(usageAttempt(
      "attempt_prompt_usage_join",
      "request_prompt_usage_join",
      "org_prompt_usage_join",
      "openai-responses",
      "openai",
      "gpt-5.5",
      "completed",
      createdAt
    ));
    await fixture.db.insert(promptArtifacts).values({
      id: "artifact_prompt_usage_join",
      organizationId: "org_prompt_usage_join",
      workspaceId: defaultWorkspaceId("org_prompt_usage_join"),
      requestId: "request_prompt_usage_join",
      kind: "user_message",
      storageMode: "raw_text",
      contentHash: "sha256:prompt_usage_join",
      rawText: "Prompt with provider and classifier usage.",
      createdAt
    });
    await fixture.db.insert(usageLedger).values([
      usageRow(
        "usage_prompt_usage_join_provider",
        "request_prompt_usage_join",
        "attempt_prompt_usage_join",
        "org_prompt_usage_join",
        "openai",
        "gpt-5.5",
        10,
        20,
        2_000
      ),
      {
        id: "usage_prompt_usage_join_classifier",
        organizationId: "org_prompt_usage_join",
        workspaceId: defaultWorkspaceId("org_prompt_usage_join"),
        requestId: "request_prompt_usage_join",
        kind: "classifier",
        provider: "openai",
        model: "route-classifier-cheap",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        totalCostMicros: 9_000
      }
    ]);

    const prompts = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, promptListQuery, {
      limit: 10,
      offset: 0
    })).data?.prompts;
    const rows = prompts.data.filter((item: any) => item.requestId === "request_prompt_usage_join");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      artifactId: "artifact_prompt_usage_join",
      cost: { selected: 0.011 },
      provider: "openai",
      selectedModel: "gpt-5.5"
    }));
  });

  it("uses API-key ownership instead of spoofed harness user headers", async () => {
    const fixture = await setup("org_api_key_identity");

    await fixture.db.insert(users).values({
      id: "api_owner",
      email: "api-owner@example.com"
    });
    await fixture.db.insert(organizationMembers).values({
      organizationId: "org_api_key_identity",
      userId: "api_owner",
      role: "admin"
    });
    await fixture.db.insert(apiKeys).values({
      id: "api_key_owned",
      organizationId: "org_api_key_identity",
      workspaceId: defaultWorkspaceId("org_api_key_identity"),
      userId: "api_owner",
      keyHash: hashApiKey("owned-token"),
      name: "Owned Proxy Token",
      accessProfileId: `${defaultWorkspaceId("org_api_key_identity")}:access-profile:opendoor-engineer`
    });

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer owned-token",
        "content-type": "application/json",
        "x-proxy-user-id": "spoofed_user",
        "x-proxy-team-id": "spoofed_team",
        "x-codex-session-id": "api-key-session"
      },
      body: JSON.stringify({
        model: "coding-auto",
        input: "Store this under the API key owner.",
        stream: true
      })
    });
    await response.text();

    const promptForOwner = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, promptListQuery, {
      userId: "api_owner"
    })).data?.prompts;
    const promptForSpoofedUser = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, promptListQuery, {
      userId: "spoofed_user"
    })).data?.prompts;
    const requestRows = await fixture.db.select().from(requests);
    const eventRows = await fixture.db.select().from(events);
    const received = eventRows.find((event) => event.eventType === "proxy.request_received");

    expect(response.status).toBe(200);
    expect(promptForOwner.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: "api_owner",
        preview: "Store this under the API key owner."
      })
    ]));
    expect(promptForSpoofedUser.data).toEqual([]);
    expect(requestRows[0]).toEqual(expect.objectContaining({
      organizationId: "org_api_key_identity",
      userId: "api_owner",
      accessProfileId: expect.stringContaining("opendoor-engineer"),
      requestedLogicalModel: "coding-auto"
    }));
    expect(received?.actorType).toBe("user");
    expect(received?.actorId).toBe("api_owner");
    expect(received?.payload).toEqual(expect.objectContaining({
      authSource: "api_key",
      apiKeyId: "api_key_owned",
      requestedLogicalModel: "coding-auto",
      userId: "api_owner",
      teamId: null,
      harnessUserId: "spoofed_user",
      harnessTeamId: "spoofed_team"
    }));
  });

  it("uses API-key ownership for the seeded local API key", async () => {
    const fixture = await setup("org_seeded_key_identity");
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_seeded_key_identity",
      SEED_USER_ID: "local-user",
      PROXY_TOKEN: "proxy-token",
      OPENAI_BASE_URL: fixture.openai.url,
      ANTHROPIC_BASE_URL: fixture.anthropic.url
    }));

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-proxy-user-id": "codex_seeded_user",
        "x-proxy-team-id": "codex_seeded_team",
        "x-codex-session-id": "seeded-api-key-session"
      },
      body: JSON.stringify({
        model: "coding-auto",
        input: "Store this under the key owner.",
        stream: true
      })
    });
    await response.text();

    const promptForHarnessUser = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, promptListQuery, {
      userId: "codex_seeded_user"
    })).data?.prompts;
    const promptForSeedUser = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, promptListQuery, {
      userId: "local-user"
    })).data?.prompts;
    const eventRows = await fixture.db.select().from(events);
    const received = eventRows.find((event) => event.eventType === "proxy.request_received");

    expect(response.status).toBe(200);
    expect(promptForHarnessUser.data).toHaveLength(0);
    expect(promptForSeedUser.data).toHaveLength(1);
    expect(received?.payload).toEqual(expect.objectContaining({
      authSource: "api_key",
      apiKeyId: "org_seeded_key_identity:api-key:default",
      requestedLogicalModel: "coding-auto",
      userId: "local-user",
      teamId: null,
      harnessUserId: "codex_seeded_user",
      harnessTeamId: "codex_seeded_team"
    }));
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
