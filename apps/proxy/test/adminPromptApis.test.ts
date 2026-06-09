import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeys,
  events,
  hashApiKey,
  organizationMembers,
  organizations,
  promptAccessAudit,
  promptArtifacts,
  requests,
  users
} from "@prompt-proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@prompt-proxy/db/seed";

import { sha256 } from "../src/util.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("admin prompt APIs", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("requires browser admin sessions for admin APIs", async () => {
    const fixture = await setup("org_admin_auth");

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

  it("serves OpenAI prompt detail and audits raw prompt reads", async () => {
    const fixture = await setup("org_prompt_admin");

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

  it("serves Anthropic prompt detail after proxy capture", async () => {
    const fixture = await setup("org_anthropic_prompt_admin");

    const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-claude-code-session-id": "claude-admin-session",
        "x-prompt-proxy-user-id": "claude_user"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        system: "Use the underwriting rules.",
        messages: [{ role: "user", content: "Review this Claude Code task." }],
        max_tokens: 256,
        stream: true
      })
    });
    await response.text();

    const prompts = await fetch(
      `${fixture.proxyUrl}/admin/prompts?userId=claude_user&surface=anthropic-messages&route=hard&model=claude-sonnet-4-5`,
      { headers: fixture.adminHeaders }
    ).then((item) => item.json());
    const latestUser = prompts.data.find((item: any) => item.kind === "latest_user_message");
    const detail = await fetch(`${fixture.proxyUrl}/admin/prompts/${latestUser.artifactId}`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());

    expect(response.status).toBe(200);
    expect(latestUser).toEqual(expect.objectContaining({
      surface: "anthropic-messages",
      preview: "Review this Claude Code task.",
      finalRoute: "hard",
      provider: "anthropic",
      selectedModel: "claude-sonnet-4-5"
    }));
    expect(detail.artifact.rawText).toBe("Review this Claude Code task.");
    expect(detail.request).toEqual(expect.objectContaining({
      requestId: latestUser.requestId,
      surface: "anthropic-messages",
      provider: "anthropic",
      selectedModel: "claude-sonnet-4-5",
      finalRoute: "hard"
    }));
    expect(detail.events.map((event: any) => event.eventType)).toContain("prompt_artifacts.captured");
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
      userId: "api_owner",
      keyHash: hashApiKey("owned-proxy-token"),
      name: "Owned Proxy Token",
      scopes: ["proxy"]
    });

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer owned-proxy-token",
        "content-type": "application/json",
        "x-prompt-proxy-user-id": "spoofed_user",
        "x-prompt-proxy-team-id": "spoofed_team",
        "x-codex-session-id": "api-key-session"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "Store this under the API key owner.",
        stream: true
      })
    });
    await response.text();

    const promptForOwner = await fetch(`${fixture.proxyUrl}/admin/prompts?userId=api_owner`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
    const promptForSpoofedUser = await fetch(`${fixture.proxyUrl}/admin/prompts?userId=spoofed_user`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
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
      userId: "api_owner"
    }));
    expect(received?.actorType).toBe("user");
    expect(received?.actorId).toBe("api_owner");
    expect(received?.payload).toEqual(expect.objectContaining({
      authSource: "api_key",
      apiKeyId: "api_key_owned",
      routingConfigId: null,
      userId: "api_owner",
      teamId: null,
      harnessUserId: "spoofed_user",
      harnessTeamId: "spoofed_team"
    }));
  });

  it("keeps harness user headers for the seeded local API key", async () => {
    const fixture = await setup("org_seeded_harness_identity");
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_seeded_harness_identity",
      SEED_USER_ID: "local-user",
      PROMPT_PROXY_TOKEN: "proxy-token"
    }));

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-prompt-proxy-user-id": "codex_seeded_user",
        "x-prompt-proxy-team-id": "codex_seeded_team",
        "x-codex-session-id": "seeded-api-key-session"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "Store this under the harness user.",
        stream: true
      })
    });
    await response.text();

    const promptForHarnessUser = await fetch(`${fixture.proxyUrl}/admin/prompts?userId=codex_seeded_user`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
    const promptForSeedUser = await fetch(`${fixture.proxyUrl}/admin/prompts?userId=local-user`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
    const eventRows = await fixture.db.select().from(events);
    const received = eventRows.find((event) => event.eventType === "proxy.request_received");

    expect(response.status).toBe(200);
    expect(promptForHarnessUser.data).toHaveLength(1);
    expect(promptForSeedUser.data).toHaveLength(0);
    expect(received?.payload).toEqual(expect.objectContaining({
      authSource: "api_key",
      apiKeyId: "org_seeded_harness_identity:api-key:default",
      routingConfigId: "org_seeded_harness_identity:routing-config:default",
      userId: "codex_seeded_user",
      teamId: "codex_seeded_team"
    }));
  });

  it("lists API key routing assignments without key hashes", async () => {
    const fixture = await setup("org_admin_api_keys");
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_admin_api_keys",
      SEED_USER_ID: "local-user",
      PROMPT_PROXY_TOKEN: "proxy-token"
    }));

    const response = await fetch(`${fixture.proxyUrl}/admin/api-keys`, {
      headers: fixture.adminHeaders
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        id: "org_admin_api_keys:api-key:default",
        organizationId: "org_admin_api_keys",
        userId: null,
        name: "Default local API key",
        scopes: ["proxy", "admin", "harness_identity"],
        routingConfigId: "org_admin_api_keys:routing-config:default",
        routingConfig: expect.objectContaining({
          id: "org_admin_api_keys:routing-config:default",
          name: "Default routing config",
          status: "active"
        })
      })
    ]);
    expect(body.data[0]).not.toHaveProperty("keyHash");
    expect(body.data[0]).not.toHaveProperty("secret");
  });

  it("lists unassigned API keys with explicit null routing assignment", async () => {
    const fixture = await setup("org_unassigned_admin_api_keys");
    await fixture.db.insert(apiKeys).values({
      id: "api_key_unassigned",
      organizationId: "org_unassigned_admin_api_keys",
      keyHash: hashApiKey("unassigned-token"),
      name: "Unassigned key",
      scopes: ["proxy"]
    });

    const response = await fetch(`${fixture.proxyUrl}/admin/api-keys`, {
      headers: fixture.adminHeaders
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        id: "api_key_unassigned",
        routingConfigId: null,
        routingConfig: null
      })
    ]);
    expect(body.data[0]).not.toHaveProperty("keyHash");
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
