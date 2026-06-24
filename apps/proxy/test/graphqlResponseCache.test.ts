import { afterEach, describe, expect, it } from "vitest";

import { organizationMembers, users } from "@proxy/db";

import { adminGql, captureFixture, loginAdmin, type PromptTestFixture } from "./promptTestFixture.js";

const viewerQuery = `query Viewer {
  viewer {
    organizationId
    workspaceId
    user { sessionId }
    workspaces { id name }
  }
}`;

const createWorkspaceMutation = `mutation CreateWorkspace($input: CreateWorkspaceInput!) {
  createWorkspace(input: $input) {
    id
    name
  }
}`;

const switchWorkspaceMutation = `mutation SwitchWorkspace($workspaceId: ID!) {
  switchWorkspace(workspaceId: $workspaceId) {
    workspaceId
    workspaces { id name }
  }
}`;

const usersQuery = `query UsersList {
  users {
    userId
    membership { role status }
  }
}`;

const updateUserRoleMutation = `mutation UpdateUserRole($userId: ID!, $role: MemberRole!) {
  updateUserRole(userId: $userId, role: $role) {
    userId
    role
    previousRole
  }
}`;

let activeFixture: PromptTestFixture | undefined;

describe("admin GraphQL response cache", () => {
  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("emits private ETags for scoped authenticated GET queries and honors revalidation", async () => {
    const fixture = await setup("org_graphql_response_cache");
    const url = graphQLUrl(fixture.proxyUrl, viewerQuery, "scope-a", "0");

    const first = await fetch(url, { headers: fixture.adminHeaders });
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toContain("private");
    expect((await first.json()).data.viewer.organizationId).toBe("org_graphql_response_cache");

    const revalidated = await fetch(url, {
      headers: { ...fixture.adminHeaders, "if-none-match": etag ?? "" }
    });

    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");

    const postWithEtag = await fetch(`${fixture.proxyUrl}/admin/graphql`, {
      method: "POST",
      headers: {
        ...fixture.adminHeaders,
        "content-type": "application/json",
        "if-none-match": etag ?? ""
      },
      body: JSON.stringify({ query: viewerQuery })
    });
    expect(postWithEtag.status).toBe(200);
    expect((await postWithEtag.json()).data.viewer.organizationId).toBe("org_graphql_response_cache");

    const created = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createWorkspaceMutation, {
      input: { name: "Cache Test" }
    });
    expect(created.errors).toBeUndefined();
    expect(created.data?.createWorkspace.name).toBe("Cache Test");

    const switched = await adminGql(fixture.proxyUrl, fixture.adminHeaders, switchWorkspaceMutation, {
      workspaceId: created.data?.createWorkspace.id
    });
    expect(switched.errors).toBeUndefined();
    expect(switched.data?.switchWorkspace.workspaceId).toBe(created.data?.createWorkspace.id);

    const invalidated = await fetch(url, {
      headers: { ...fixture.adminHeaders, "if-none-match": etag ?? "" }
    });
    const invalidatedBody = await invalidated.json();
    expect(invalidated.status).toBe(200);
    expect(invalidatedBody.data.viewer.workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Cache Test" })
    ]));

    const epochBusted = await fetch(graphQLUrl(fixture.proxyUrl, viewerQuery, "scope-a", "1"), {
      headers: fixture.adminHeaders
    });

    expect(epochBusted.status).toBe(200);
    expect(epochBusted.headers.get("etag")).toBeTruthy();
    expect(epochBusted.headers.get("etag")).not.toBe(etag);
  });

  it("does not cache unmarked GET queries", async () => {
    const fixture = await setup("org_graphql_response_cache_unmarked");
    const params = new URLSearchParams({ query: viewerQuery });
    const response = await fetch(`${fixture.proxyUrl}/admin/graphql?${params}`, {
      headers: fixture.adminHeaders
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeNull();
  });

  it("invalidates scoped cached queries after wrapper-result mutations", async () => {
    const fixture = await setup("org_graphql_response_cache_user_mutation");
    const memberId = "cache_member";
    await fixture.db.insert(users).values({
      id: memberId,
      email: "cache-member@example.com",
      name: "Cache Member"
    });
    await fixture.db.insert(organizationMembers).values({
      organizationId: "org_graphql_response_cache_user_mutation",
      userId: memberId,
      role: "member"
    });
    const readerHeaders = await loginAdmin(fixture.proxyUrl);
    const url = graphQLUrl(fixture.proxyUrl, usersQuery, "scope-users", "0");

    const first = await fetch(url, { headers: readerHeaders });
    const etag = first.headers.get("etag");
    const firstBody = await first.json();

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    expect(firstBody.data.users).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: memberId,
        membership: { role: "member", status: "active" }
      })
    ]));

    const revalidated = await fetch(url, {
      headers: { ...readerHeaders, "if-none-match": etag ?? "" }
    });
    expect(revalidated.status).toBe(304);

    const updated = await adminGql(fixture.proxyUrl, fixture.adminHeaders, updateUserRoleMutation, {
      userId: memberId,
      role: "admin"
    });
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.updateUserRole).toEqual({
      userId: memberId,
      role: "admin",
      previousRole: "member"
    });

    const invalidated = await fetch(url, {
      headers: { ...readerHeaders, "if-none-match": etag ?? "" }
    });
    const invalidatedEtag = invalidated.headers.get("etag");
    const invalidatedBody = await invalidated.json();
    expect(invalidated.status).toBe(200);
    expect(invalidatedEtag).toBeTruthy();
    expect(invalidatedEtag).not.toBe(etag);
    expect(invalidatedBody.data.users).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: memberId,
        membership: { role: "admin", status: "active" }
      })
    ]));
  });
});

async function setup(organizationId: string) {
  activeFixture = await captureFixture(organizationId);
  return activeFixture;
}

function graphQLUrl(proxyUrl: string, query: string, scope: string, epoch: string) {
  const params = new URLSearchParams({
    query,
    gqlCacheScope: scope,
    gqlCacheEpoch: epoch
  });
  return `${proxyUrl}/admin/graphql?${params}`;
}
