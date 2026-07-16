import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  accessProfiles,
  apiKeys,
  defaultWorkspaceId,
  events,
  hashApiKey,
  organizations,
  workspaces
} from "@proxy/db";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const apiKeyFields = `{
  id
  name
  userId
  accessProfileId
  accessProfile { id name status }
  createdAt
  expiresAt
  revokedAt
  lastUsedAt
}`;

describe("API key admin APIs", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("lists access-profile assignments without exposing key material", async () => {
    const fixture = await setup("org_api_key_admin_list");
    const profileId = engineerAccessProfileId("org_api_key_admin_list");
    await fixture.db.insert(apiKeys).values({
      id: "api_key_unassigned",
      organizationId: "org_api_key_admin_list",
      workspaceId: defaultWorkspaceId("org_api_key_admin_list"),
      keyHash: hashApiKey("unassigned-token"),
      name: "Unassigned key"
    });

    const listResult = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { apiKeys ${apiKeyFields} }`
    );
    const detailResult = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query ApiKey($apiKeyId: ID!) { apiKey(apiKeyId: $apiKeyId) ${apiKeyFields} }`,
      { apiKeyId: "org_api_key_admin_list:api-key:default" }
    );
    const serialized = JSON.stringify({ list: listResult.data, detail: detailResult.data });

    expect(listResult.errors).toBeUndefined();
    expect(detailResult.errors).toBeUndefined();
    expect(listResult.data?.apiKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "org_api_key_admin_list:api-key:default",
        accessProfileId: profileId,
        accessProfile: expect.objectContaining({ id: profileId, status: "active" })
      }),
      expect.objectContaining({
        id: "api_key_unassigned",
        accessProfileId: null,
        accessProfile: null
      })
    ]));
    expect(detailResult.data?.apiKey).toEqual(expect.objectContaining({
      id: "org_api_key_admin_list:api-key:default",
      accessProfileId: profileId
    }));
    expect(serialized).not.toContain("keyHash");
    expect(serialized).not.toContain(hashApiKey("unassigned-token"));
    expect(serialized).not.toContain("unassigned-token");
    expect(serialized).not.toContain("proxy-token");
  });

  it("assigns an active access profile and records an audit event", async () => {
    const fixture = await setup("org_api_key_admin_assign");
    const apiKeyId = "org_api_key_admin_assign:api-key:default";
    const accessProfileId = externalAccessProfileId("org_api_key_admin_assign");

    const result = await assignAccessProfile(fixture, apiKeyId, accessProfileId);
    const [row] = await fixture.db
      .select({ accessProfileId: apiKeys.accessProfileId })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId));
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "gateway_config.api_key.access_profile_assigned"));

    expect(result.errors).toBeUndefined();
    expect(result.data?.assignGatewayApiKeyAccessProfile).toEqual({ apiKeyId, accessProfileId });
    expect(row?.accessProfileId).toBe(accessProfileId);
    expect(eventRows).toEqual([
      expect.objectContaining({
        organizationId: "org_api_key_admin_assign",
        scopeType: "api_key",
        scopeId: apiKeyId,
        actorType: "user",
        actorId: "local-user",
        payload: expect.objectContaining({ apiKeyId, accessProfileId })
      })
    ]);
  });

  it("creates API keys whose one-time secret resolves for proxy auth", async () => {
    const fixture = await setup("org_api_key_admin_create");
    const accessProfileId = engineerAccessProfileId("org_api_key_admin_create");

    const response = await postApiKey(fixture, { name: "Proxy key", accessProfileId });
    const created = response.data?.createApiKey;
    const identity = await fixture.persistence.apiKeys.resolve(created.secret);
    const list = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { apiKeys ${apiKeyFields} }`
    )).data?.apiKeys;
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "api_key.created"));

    expect(response.errors).toBeUndefined();
    expect(created.secret).toMatch(/^pp_[0-9a-f]{48}$/);
    expect(created.apiKey).toEqual(expect.objectContaining({
      name: "Proxy key",
      userId: "local-user",
      accessProfileId,
      revokedAt: null
    }));
    expect(identity).toEqual(expect.objectContaining({
      apiKeyId: created.apiKey.id,
      organizationId: "org_api_key_admin_create",
      accessProfileId
    }));
    expect(JSON.stringify(list)).not.toContain(created.secret);
    expect(eventRows).toEqual([
      expect.objectContaining({
        organizationId: "org_api_key_admin_create",
        scopeType: "api_key",
        scopeId: created.apiKey.id,
        actorType: "user",
        actorId: "local-user",
        payload: expect.objectContaining({
          apiKeyId: created.apiKey.id,
          name: "Proxy key",
          accessProfileId
        })
      })
    ]);
  });

  it("rejects invalid API key create requests", async () => {
    const fixture = await setup("org_api_key_admin_create_invalid");

    const missingName = await postApiKey(fixture, {
      name: "",
      accessProfileId: engineerAccessProfileId("org_api_key_admin_create_invalid")
    });
    const missingProfile = await postApiKey(fixture, {
      name: "Missing profile key",
      accessProfileId: "missing-profile"
    });
    const keyRows = await fixture.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.organizationId, "org_api_key_admin_create_invalid"));

    expect(missingName.errors?.[0]?.message).toBe("invalid_api_key_request");
    expect(missingName.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(missingProfile.errors?.[0]?.message).toBe("access_profile_not_found");
    expect(missingProfile.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(keyRows.map((row) => row.id)).toEqual(["org_api_key_admin_create_invalid:api-key:default"]);
  });

  it("revokes API keys and blocks further proxy auth", async () => {
    const fixture = await setup("org_api_key_admin_revoke");
    const createResponse = await postApiKey(fixture, {
      name: "Revocable key",
      accessProfileId: engineerAccessProfileId("org_api_key_admin_revoke")
    });
    const created = createResponse.data?.createApiKey;
    const beforeIdentity = await fixture.persistence.apiKeys.resolve(created.secret);

    const revokeResponse = await revokeKey(fixture, created.apiKey.id);
    const afterIdentity = await fixture.persistence.apiKeys.resolve(created.secret);
    const repeat = await revokeKey(fixture, created.apiKey.id);
    const missing = await revokeKey(fixture, "missing-key");

    expect(beforeIdentity?.apiKeyId).toBe(created.apiKey.id);
    expect(revokeResponse.errors).toBeUndefined();
    expect(revokeResponse.data?.revokeApiKey).toEqual(expect.objectContaining({
      id: created.apiKey.id,
      revokedAt: expect.any(String)
    }));
    expect(afterIdentity).toBeUndefined();
    expect(repeat.errors?.[0]?.message).toBe("api_key_revoked");
    expect(repeat.errors?.[0]?.extensions?.code).toBe("CONFLICT");
    expect(missing.errors?.[0]?.message).toBe("api_key_not_found");
    expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("rejects inactive and cross-workspace assignment targets", async () => {
    const fixture = await setup("org_api_key_admin_rejects");
    const apiKeyId = "org_api_key_admin_rejects:api-key:default";
    const inactiveProfileId = externalAccessProfileId("org_api_key_admin_rejects");
    await fixture.db
      .update(accessProfiles)
      .set({ status: "disabled" })
      .where(eq(accessProfiles.id, inactiveProfileId));
    await fixture.db.insert(organizations).values({
      id: "org_api_key_admin_other",
      slug: "org-api-key-admin-other",
      name: "Other Org"
    });
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_api_key_admin_other"),
      organizationId: "org_api_key_admin_other",
      slug: "default",
      name: "Default"
    });
    await fixture.db.insert(accessProfiles).values({
      id: "other_access_profile",
      organizationId: "org_api_key_admin_other",
      workspaceId: defaultWorkspaceId("org_api_key_admin_other"),
      slug: "other",
      name: "Other profile"
    });

    const inactive = await assignAccessProfile(fixture, apiKeyId, inactiveProfileId);
    const crossWorkspace = await assignAccessProfile(fixture, apiKeyId, "other_access_profile");
    const [row] = await fixture.db
      .select({ accessProfileId: apiKeys.accessProfileId })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId));

    expect(inactive.errors?.[0]?.message).toBe("access_profile_inactive");
    expect(inactive.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(crossWorkspace.errors?.[0]?.message).toBe("access_profile_not_found");
    expect(crossWorkspace.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(row?.accessProfileId).toBe(engineerAccessProfileId("org_api_key_admin_rejects"));
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});

function assignAccessProfile(fixture: PromptTestFixture, apiKeyId: string, accessProfileId: string) {
  return adminGql(
    fixture.proxyUrl,
    fixture.adminHeaders,
    `mutation Assign($apiKeyId: ID!, $accessProfileId: ID!) {
      assignGatewayApiKeyAccessProfile(apiKeyId: $apiKeyId, accessProfileId: $accessProfileId) {
        apiKeyId
        accessProfileId
      }
    }`,
    { apiKeyId, accessProfileId }
  );
}

function postApiKey(fixture: PromptTestFixture, input: { name: string; accessProfileId: string }) {
  return adminGql(
    fixture.proxyUrl,
    fixture.adminHeaders,
    `mutation CreateKey($input: CreateApiKeyInput!) {
      createApiKey(input: $input) {
        apiKey { id name userId accessProfileId revokedAt }
        secret
      }
    }`,
    { input }
  );
}

function revokeKey(fixture: PromptTestFixture, apiKeyId: string) {
  return adminGql(
    fixture.proxyUrl,
    fixture.adminHeaders,
    `mutation RevokeKey($apiKeyId: ID!) {
      revokeApiKey(apiKeyId: $apiKeyId) { id revokedAt }
    }`,
    { apiKeyId }
  );
}

function engineerAccessProfileId(organizationId: string) {
  return `${defaultWorkspaceId(organizationId)}:access-profile:opendoor-engineer`;
}

function externalAccessProfileId(organizationId: string) {
  return `${defaultWorkspaceId(organizationId)}:access-profile:external-economy`;
}
