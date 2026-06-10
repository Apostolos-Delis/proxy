import { afterEach, describe, expect, it } from "vitest";

import { defaultWorkspaceId, events, requests, workspaces } from "@prompt-proxy/db";

import {
  adminGql,
  captureFixture,
  sessionEvent,
  usageRequest,
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
