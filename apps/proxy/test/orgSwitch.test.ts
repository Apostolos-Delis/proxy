import { afterEach, describe, expect, it } from "vitest";

import { organizationMembers, organizations, requests } from "@prompt-proxy/db";

import { adminGql, captureFixture, usageRequest, type PromptTestFixture } from "./promptTestFixture.js";

describe("organization switching", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("returns the user's organizations from login and me", async () => {
    const fixture = await setup("org_switch");

    const me = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { viewer { organizationId organizations { id name role } } }"
    )).data?.viewer;

    expect(me.organizationId).toBe("org_switch");
    expect(me.organizations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "org_switch", role: "owner" }),
      expect.objectContaining({ id: "org_switch-sandbox", name: "org_switch Sandbox", role: "owner" })
    ]));
  });

  it("switches the session to another organization", async () => {
    const fixture = await setup("org_switch_happy");

    const response = await fetch(`${fixture.proxyUrl}/api/auth/switch-organization`, {
      method: "POST",
      headers: { ...fixture.adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "org_switch_happy-sandbox" })
    });
    const body = await response.json();
    const newCookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";

    expect(response.status).toBe(200);
    expect(body.organizationId).toBe("org_switch_happy-sandbox");
    expect(body.user).toEqual(expect.objectContaining({
      organizationId: "org_switch_happy-sandbox",
      userId: "local-user",
      role: "owner"
    }));
    expect(newCookie).toBeTruthy();
    expect(newCookie).not.toBe(fixture.adminHeaders.cookie);

    const oldSession = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { viewer { organizationId } }"
    );
    expect(oldSession.status).toBe(401);

    const overview = (await adminGql(
      fixture.proxyUrl,
      { cookie: newCookie },
      "query { overview { organizationId } }"
    )).data?.overview;
    expect(overview.organizationId).toBe("org_switch_happy-sandbox");
  });

  it("rejects switching to organizations without an active membership", async () => {
    const fixture = await setup("org_switch_denied");
    await fixture.db.insert(organizations).values([
      { id: "org_no_membership", slug: "org-no-membership", name: "No Membership" },
      { id: "org_deactivated", slug: "org-deactivated", name: "Deactivated" }
    ]);
    await fixture.db.insert(organizationMembers).values({
      organizationId: "org_deactivated",
      userId: "local-user",
      role: "member",
      status: "deactivated"
    });

    for (const organizationId of ["org_missing", "org_no_membership", "org_deactivated"]) {
      const response = await fetch(`${fixture.proxyUrl}/api/auth/switch-organization`, {
        method: "POST",
        headers: { ...fixture.adminHeaders, "content-type": "application/json" },
        body: JSON.stringify({ organizationId })
      });
      expect(response.status).toBe(403);
    }

    const invalidBody = await fetch(`${fixture.proxyUrl}/api/auth/switch-organization`, {
      method: "POST",
      headers: { ...fixture.adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(invalidBody.status).toBe(400);

    const me = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { viewer { organizationId } }"
    )).data?.viewer;
    expect(me.organizationId).toBe("org_switch_denied");
  });

  it("scopes admin queries to the session organization", async () => {
    const fixture = await setup("org_switch_scope");
    await fixture.db.insert(requests).values([
      { ...usageRequest("request_primary", "org_switch_scope", "local-user", "", "openai-responses", new Date()), sessionId: null },
      { ...usageRequest("request_sandbox", "org_switch_scope-sandbox", "local-user", "", "openai-responses", new Date()), sessionId: null }
    ]);

    const primaryRequests = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { requests { requestId } }"
    )).data?.requests;
    expect(primaryRequests.map((item: { requestId: string }) => item.requestId)).toEqual(["request_primary"]);

    const switched = await fetch(`${fixture.proxyUrl}/api/auth/switch-organization`, {
      method: "POST",
      headers: { ...fixture.adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "org_switch_scope-sandbox" })
    });
    const newCookie = switched.headers.get("set-cookie")?.split(";")[0] ?? "";

    const sandboxRequests = (await adminGql(
      fixture.proxyUrl,
      { cookie: newCookie },
      "query { requests { requestId } }"
    )).data?.requests;
    expect(sandboxRequests.map((item: { requestId: string }) => item.requestId)).toEqual(["request_sandbox"]);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
