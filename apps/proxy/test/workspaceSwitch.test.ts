import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultWorkspaceId,
  events,
  promptArtifacts,
  providerAttempts,
  requests,
  routeDecisions,
  routingConfigs,
  usageLedger,
  workspaces
} from "@prompt-proxy/db";

import {
  adminGql,
  captureFixture,
  sessionEvent,
  usageAttempt,
  usageDecision,
  usageRequest,
  usageRow,
  type PromptTestFixture
} from "./promptTestFixture.js";

const switchMutation = `mutation Switch($workspaceId: ID!) {
  switchWorkspace(workspaceId: $workspaceId) {
    workspaceId
    user { workspaceId organizationId }
  }
}`;

const createMutation = `mutation Create($input: CreateWorkspaceInput!) {
  createWorkspace(input: $input) {
    id
    slug
    name
  }
}`;

describe("workspace switching", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("defaults the session to the organization's default workspace", async () => {
    const fixture = await setup("org_ws_default");

    const me = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { viewer { organizationId workspaceId workspaces { id slug name } } }"
    )).data?.viewer;

    expect(me.workspaceId).toBe(defaultWorkspaceId("org_ws_default"));
    expect(me.workspaces).toEqual([
      expect.objectContaining({
        id: defaultWorkspaceId("org_ws_default"),
        slug: "default",
        name: "Default"
      })
    ]);
  });

  it("creates a workspace and switches the session to it without a new cookie", async () => {
    const fixture = await setup("org_ws_create");

    const created = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, createMutation, {
      input: { name: "Staging" }
    })).data?.createWorkspace;
    expect(created).toEqual(expect.objectContaining({ slug: "staging", name: "Staging" }));

    const switched = await adminGql(fixture.proxyUrl, fixture.adminHeaders, switchMutation, {
      workspaceId: created.id
    });
    expect(switched.errors).toBeUndefined();
    expect(switched.setCookie).toBeUndefined();
    expect(switched.data?.switchWorkspace.workspaceId).toBe(created.id);

    const me = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { viewer { workspaceId workspaces { id } } }"
    )).data?.viewer;
    expect(me.workspaceId).toBe(created.id);
    expect(me.workspaces).toHaveLength(2);
  });

  it("provisions a default routing config cloned from the org default for new workspaces", async () => {
    const fixture = await setup("org_ws_provision");
    const created = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, createMutation, {
      input: { name: "Staging" }
    })).data?.createWorkspace;

    await adminGql(fixture.proxyUrl, fixture.adminHeaders, switchMutation, { workspaceId: created.id });
    const configs = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { routingConfigs { slug status activeVersion { version } } }"
    )).data?.routingConfigs;
    expect(configs).toEqual([
      expect.objectContaining({ slug: "default", status: "active", activeVersion: { version: 1 } })
    ]);

    // Traffic resolution no longer dead-ends at routing_config_not_found.
    const resolved = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_ws_provision",
      workspaceId: created.id,
      routingConfigId: null
    });
    expect(resolved.config.routes.balanced.targets.find((target) => target.providerId === "openai")?.model)
      .toBe("gpt-5.4");
  });

  it("self-heals a config-less workspace on the next routing-config read and stays idempotent", async () => {
    const fixture = await setup("org_ws_selfheal");
    // Simulate a workspace created before provisioning-on-creation existed.
    await fixture.db.insert(workspaces).values({
      id: "ws_legacy",
      organizationId: "org_ws_selfheal",
      slug: "legacy",
      name: "Legacy"
    });
    await adminGql(fixture.proxyUrl, fixture.adminHeaders, switchMutation, { workspaceId: "ws_legacy" });

    const first = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { routingConfigs { id slug status } }"
    )).data?.routingConfigs;
    expect(first).toEqual([expect.objectContaining({ slug: "default", status: "active" })]);

    // A second read must not provision a duplicate — same single config id.
    const second = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { routingConfigs { id } }"
    )).data?.routingConfigs;
    expect(second).toEqual([{ id: first[0].id }]);
    const persisted = await fixture.db
      .select({ id: routingConfigs.id })
      .from(routingConfigs)
      .where(eq(routingConfigs.workspaceId, "ws_legacy"));
    expect(persisted).toHaveLength(1);
  });

  it("rejects duplicate workspace slugs and foreign workspace ids", async () => {
    const fixture = await setup("org_ws_denied");
    await fixture.db.insert(workspaces).values({
      id: "ws_foreign",
      organizationId: `org_ws_denied-sandbox`,
      slug: "foreign",
      name: "Foreign"
    });

    const duplicate = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createMutation, {
      input: { name: "Default" }
    });
    expect(duplicate.errors?.[0]?.message).toBe("workspace_slug_exists");
    expect(duplicate.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    for (const workspaceId of ["ws_missing", "ws_foreign"]) {
      const response = await adminGql(fixture.proxyUrl, fixture.adminHeaders, switchMutation, {
        workspaceId
      });
      expect(response.errors?.[0]?.message).toBe("Forbidden");
      expect(response.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    }

    const me = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { viewer { workspaceId } }"
    )).data?.viewer;
    expect(me.workspaceId).toBe(defaultWorkspaceId("org_ws_denied"));
  });

  it("scopes admin queries to the session workspace", async () => {
    const fixture = await setup("org_ws_scope");
    const created = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, createMutation, {
      input: { name: "Second" }
    })).data?.createWorkspace;

    await fixture.db.insert(requests).values([
      { ...usageRequest("request_default_ws", "org_ws_scope", "local-user", "", "openai-responses", new Date()), sessionId: null },
      {
        ...usageRequest("request_second_ws", "org_ws_scope", "local-user", "", "openai-responses", new Date()),
        sessionId: null,
        workspaceId: created.id,
        idempotencyKey: "idem_request_second_ws"
      }
    ]);

    const defaultRequests = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { requests { requestId } }"
    )).data?.requests;
    expect(defaultRequests.map((item: { requestId: string }) => item.requestId)).toEqual(["request_default_ws"]);

    await adminGql(fixture.proxyUrl, fixture.adminHeaders, switchMutation, { workspaceId: created.id });

    const secondRequests = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { requests { requestId } }"
    )).data?.requests;
    expect(secondRequests.map((item: { requestId: string }) => item.requestId)).toEqual(["request_second_ws"]);

    const keys = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { apiKeys { id } }"
    )).data?.apiKeys;
    expect(keys).toEqual([]);
  });

  it("does not attach usage rows from a different workspace to scoped request summaries", async () => {
    const fixture = await setup("org_ws_usage_scope");
    const created = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, createMutation, {
      input: { name: "Second" }
    })).data?.createWorkspace;
    const at = new Date("2026-06-19T12:00:00.000Z");

    await fixture.db.insert(requests).values({
      ...usageRequest("request_usage_scope", "org_ws_usage_scope", "local-user", "", "openai-responses", at),
      sessionId: null
    });
    await fixture.db.insert(routeDecisions).values(
      usageDecision("decision_usage_scope", "request_usage_scope", "org_ws_usage_scope", "fast", "openai", "gpt-fast")
    );
    await fixture.db.insert(providerAttempts).values(
      usageAttempt("attempt_usage_scope", "request_usage_scope", "org_ws_usage_scope", "openai-responses", "openai", "gpt-fast", "completed", at)
    );
    await fixture.db.insert(usageLedger).values({
      ...usageRow("usage_wrong_workspace", "request_usage_scope", "attempt_usage_scope", "org_ws_usage_scope", "openai", "gpt-fast", "fast", 100, 25, 1000),
      workspaceId: created.id
    });

    const defaultRequests = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { requests { requestId usage { totalTokens } selectedCost } }"
    )).data?.requests;
    expect(defaultRequests).toEqual([
      expect.objectContaining({
        requestId: "request_usage_scope",
        usage: expect.objectContaining({ totalTokens: 0 }),
        selectedCost: 0
      })
    ]);
  });

  it("does not attach route decisions from a different workspace to scoped prompt summaries", async () => {
    const fixture = await setup("org_ws_prompt_decisions");
    const created = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, createMutation, {
      input: { name: "Second" }
    })).data?.createWorkspace;
    const at = new Date("2026-06-19T12:00:00.000Z");

    await fixture.db.insert(requests).values({
      ...usageRequest("request_prompt_decision_scope", "org_ws_prompt_decisions", "local-user", "", "openai-responses", at),
      sessionId: null
    });
    await fixture.db.insert(promptArtifacts).values({
      id: "artifact_prompt_decision_scope",
      organizationId: "org_ws_prompt_decisions",
      workspaceId: defaultWorkspaceId("org_ws_prompt_decisions"),
      requestId: "request_prompt_decision_scope",
      kind: "user_message",
      storageMode: "raw_text",
      contentHash: "sha256:prompt_decision_scope",
      rawText: "Prompt with a mismatched decision row",
      createdAt: at
    });
    await fixture.db.insert(routeDecisions).values({
      ...usageDecision("decision_wrong_workspace", "request_prompt_decision_scope", "org_ws_prompt_decisions", "fast", "openai", "gpt-fast"),
      workspaceId: created.id
    });

    const prompts = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { prompts { data { artifactId finalRoute selectedModel } } }"
    )).data?.prompts;
    const prompt = prompts.data.find((item: { artifactId: string }) => item.artifactId === "artifact_prompt_decision_scope");

    expect(prompt).toEqual({
      artifactId: "artifact_prompt_decision_scope",
      finalRoute: null,
      selectedModel: null
    });
  });

  it("does not expose event timelines for requests in other workspaces", async () => {
    const fixture = await setup("org_ws_events");
    const created = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, createMutation, {
      input: { name: "Second" }
    })).data?.createWorkspace;

    await fixture.db.insert(requests).values({
      ...usageRequest("request_default_ws", "org_ws_events", "local-user", "", "openai-responses", new Date()),
      sessionId: null
    });
    await fixture.db.insert(events).values(
      sessionEvent("event_default_ws", "org_ws_events", "request_default_ws", "session_x", new Date())
    );

    const detailQuery = `query Detail($requestId: ID!) {
      request(requestId: $requestId) { request { requestId } events { eventId } }
    }`;

    const sameWorkspace = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      detailQuery,
      { requestId: "request_default_ws" }
    )).data?.request;
    expect(sameWorkspace.request?.requestId).toBe("request_default_ws");
    expect(sameWorkspace.events).toHaveLength(1);

    await adminGql(fixture.proxyUrl, fixture.adminHeaders, switchMutation, { workspaceId: created.id });

    const foreignWorkspace = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      detailQuery,
      { requestId: "request_default_ws" }
    )).data?.request;
    expect(foreignWorkspace.request).toBeNull();
    expect(foreignWorkspace.events).toEqual([]);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
