import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  apiKeys,
  events,
  hashApiKey,
  organizations,
  routingConfigs
} from "@prompt-proxy/db";
import type { RoutingConfig } from "@prompt-proxy/schema";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const apiKeyFields = "{ id name scopes userId routingConfigId routingConfig { id name status } createdAt expiresAt revokedAt lastUsedAt }";

describe("API key admin APIs", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("lists and serves API key assignment details without key material", async () => {
    const fixture = await setup("org_api_key_admin_list");
    await fixture.db.insert(apiKeys).values({
      id: "api_key_unassigned",
      organizationId: "org_api_key_admin_list",
      keyHash: hashApiKey("unassigned-token"),
      name: "Unassigned key",
      scopes: ["proxy"]
    });

    const listResult = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { apiKeys ${apiKeyFields} }`
    );
    const list = listResult.data?.apiKeys;
    const detailResult = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query ApiKey($apiKeyId: ID!) { apiKey(apiKeyId: $apiKeyId) ${apiKeyFields} }`,
      { apiKeyId: "org_api_key_admin_list:api-key:default" }
    );
    const detail = detailResult.data?.apiKey;
    const serialized = JSON.stringify({ list, detail });

    expect(listResult.status).toBe(200);
    expect(detailResult.status).toBe(200);
    expect(list).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "org_api_key_admin_list:api-key:default",
        routingConfig: expect.objectContaining({
          id: "org_api_key_admin_list:routing-config:default",
          name: "Default routing config",
          status: "active"
        })
      }),
      expect.objectContaining({
        id: "api_key_unassigned",
        routingConfigId: null,
        routingConfig: null
      })
    ]));
    expect(detail).toEqual(expect.objectContaining({
      id: "org_api_key_admin_list:api-key:default",
      routingConfig: expect.objectContaining({
        id: "org_api_key_admin_list:routing-config:default"
      })
    }));
    expect(serialized).not.toContain("keyHash");
    expect(serialized).not.toContain(hashApiKey("unassigned-token"));
    expect(serialized).not.toContain("unassigned-token");
    expect(serialized).not.toContain("proxy-token");
  });

  it("assigns and clears API key routing configs with audit events", async () => {
    const fixture = await setup("org_api_key_admin_assign");
    await fixture.db.insert(apiKeys).values({
      id: "api_key_assignable",
      organizationId: "org_api_key_admin_assign",
      keyHash: hashApiKey("assignment-token"),
      name: "Assignable key",
      scopes: ["proxy"]
    });
    const targetConfig = await createRoutingConfig(fixture, "org_api_key_admin_assign", "Assigned config");

    const assignedResult = await assignRoutingConfig(fixture, "api_key_assignable", targetConfig.id);
    const assigned = assignedResult.data?.assignApiKeyRoutingConfig;
    const assignedIdentity = await fixture.persistence.apiKeys.resolve("assignment-token");

    const clearedResult = await assignRoutingConfig(fixture, "api_key_assignable", null);
    const cleared = clearedResult.data?.assignApiKeyRoutingConfig;
    const clearedIdentity = await fixture.persistence.apiKeys.resolve("assignment-token");
    const resolvedAfterClear = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_api_key_admin_assign",
      routingConfigId: clearedIdentity?.routingConfigId
    });
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "routing_config.api_key_assignment_changed"));

    expect(assignedResult.errors).toBeUndefined();
    expect(assigned).toEqual(expect.objectContaining({
      id: "api_key_assignable",
      routingConfigId: targetConfig.id,
      routingConfig: expect.objectContaining({
        id: targetConfig.id,
        name: "Assigned config",
        status: "active"
      })
    }));
    expect(assignedIdentity?.routingConfigId).toBe(targetConfig.id);
    expect(clearedResult.errors).toBeUndefined();
    expect(cleared).toEqual(expect.objectContaining({
      id: "api_key_assignable",
      routingConfigId: null,
      routingConfig: null
    }));
    expect(clearedIdentity?.routingConfigId).toBeNull();
    expect(resolvedAfterClear.configId).toBe("org_api_key_admin_assign:routing-config:default");
    expect(eventRows).toEqual([
      expect.objectContaining({
        organizationId: "org_api_key_admin_assign",
        scopeType: "api_key",
        scopeId: "api_key_assignable",
        actorType: "user",
        actorId: "local-user",
        payload: expect.objectContaining({
          apiKeyId: "api_key_assignable",
          previousRoutingConfigId: null,
          routingConfigId: targetConfig.id,
          routingConfigVersionId: expect.any(String),
          routingConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      }),
      expect.objectContaining({
        organizationId: "org_api_key_admin_assign",
        scopeType: "api_key",
        scopeId: "api_key_assignable",
        actorType: "user",
        actorId: "local-user",
        payload: expect.objectContaining({
          apiKeyId: "api_key_assignable",
          previousRoutingConfigId: targetConfig.id,
          routingConfigId: null,
          routingConfigVersionId: null,
          routingConfigHash: null
        })
      })
    ]);
  });

  it("creates API keys whose secret resolves for proxy auth", async () => {
    const fixture = await setup("org_api_key_admin_create");
    const targetConfig = await createRoutingConfig(fixture, "org_api_key_admin_create", "Create config");

    const response = await postApiKey(fixture, {
      name: "Harness key",
      scopes: ["proxy", "harness_identity"],
      routingConfigId: targetConfig.id
    });
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
      name: "Harness key",
      userId: null,
      scopes: ["proxy", "harness_identity"],
      routingConfigId: targetConfig.id,
      revokedAt: null
    }));
    expect(identity).toEqual(expect.objectContaining({
      apiKeyId: created.apiKey.id,
      organizationId: "org_api_key_admin_create",
      scopes: ["proxy", "harness_identity"],
      routingConfigId: targetConfig.id
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
          name: "Harness key",
          scopes: ["proxy", "harness_identity"],
          routingConfigId: targetConfig.id,
          routingConfigVersionId: expect.any(String),
          routingConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      })
    ]);
  });

  it("rejects invalid API key create requests", async () => {
    const fixture = await setup("org_api_key_admin_create_invalid");
    await fixture.db.insert(routingConfigs).values({
      id: "org_api_key_admin_create_invalid:routing-config:archived",
      organizationId: "org_api_key_admin_create_invalid",
      name: "Archived config",
      slug: "archived",
      status: "archived"
    });

    const missingName = await postApiKey(fixture, { name: "" });
    const unknownScope = await postApiKey(fixture, { name: "Bad scope key", scopes: ["root"] });
    const archivedConfig = await postApiKey(fixture, {
      name: "Archived target key",
      routingConfigId: "org_api_key_admin_create_invalid:routing-config:archived"
    });
    const keyRows = await fixture.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.organizationId, "org_api_key_admin_create_invalid"));

    expect(missingName.errors?.[0]?.message).toBe("invalid_api_key_request");
    expect(missingName.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(unknownScope.errors?.[0]?.message).toBe("invalid_api_key_request");
    expect(unknownScope.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(archivedConfig.errors?.[0]?.message).toBe("routing_config_archived");
    expect(archivedConfig.errors?.[0]?.extensions?.code).toBe("CONFLICT");
    expect(keyRows.map((row) => row.id)).toEqual(["org_api_key_admin_create_invalid:api-key:default"]);
  });

  it("revokes API keys and blocks further proxy auth", async () => {
    const fixture = await setup("org_api_key_admin_revoke");
    const createResponse = await postApiKey(fixture, { name: "Revocable key" });
    const created = createResponse.data?.createApiKey;
    const beforeIdentity = await fixture.persistence.apiKeys.resolve(created.secret);

    const revokeResponse = await revokeKey(fixture, created.apiKey.id);
    const revoked = revokeResponse.data?.revokeApiKey;
    const afterIdentity = await fixture.persistence.apiKeys.resolve(created.secret);
    const repeat = await revokeKey(fixture, created.apiKey.id);
    const missing = await revokeKey(fixture, "missing-key");
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "api_key.revoked"));

    expect(createResponse.errors).toBeUndefined();
    expect(beforeIdentity?.apiKeyId).toBe(created.apiKey.id);
    expect(revokeResponse.errors).toBeUndefined();
    expect(revoked).toEqual(expect.objectContaining({
      id: created.apiKey.id,
      revokedAt: expect.any(String)
    }));
    expect(afterIdentity).toBeUndefined();
    expect(repeat.errors?.[0]?.message).toBe("api_key_revoked");
    expect(repeat.errors?.[0]?.extensions?.code).toBe("CONFLICT");
    expect(missing.errors?.[0]?.message).toBe("api_key_not_found");
    expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(eventRows).toEqual([
      expect.objectContaining({
        organizationId: "org_api_key_admin_revoke",
        scopeType: "api_key",
        scopeId: created.apiKey.id,
        actorType: "user",
        actorId: "local-user",
        payload: expect.objectContaining({
          apiKeyId: created.apiKey.id,
          name: "Revocable key",
          revokedAt: expect.any(String)
        })
      })
    ]);
  });

  it("rejects archived and cross-organization assignment targets", async () => {
    const fixture = await setup("org_api_key_admin_rejects");
    const defaultApiKeyId = "org_api_key_admin_rejects:api-key:default";
    const defaultConfigId = "org_api_key_admin_rejects:routing-config:default";
    await fixture.db.insert(routingConfigs).values({
      id: "org_api_key_admin_rejects:routing-config:archived",
      organizationId: "org_api_key_admin_rejects",
      name: "Archived config",
      slug: "archived",
      status: "archived"
    });
    await fixture.db.insert(routingConfigs).values({
      id: "org_api_key_admin_rejects:routing-config:empty",
      organizationId: "org_api_key_admin_rejects",
      name: "Empty config",
      slug: "empty",
      status: "active"
    });
    await fixture.db.insert(organizations).values({
      id: "org_api_key_admin_other",
      slug: "org-api-key-admin-other",
      name: "Other Org"
    });
    await fixture.db.insert(routingConfigs).values({
      id: "org_api_key_admin_other:routing-config:default",
      organizationId: "org_api_key_admin_other",
      name: "Other config",
      slug: "other"
    });
    await fixture.db.insert(apiKeys).values({
      id: "other_org_api_key",
      organizationId: "org_api_key_admin_other",
      keyHash: hashApiKey("other-org-token"),
      name: "Other org key",
      scopes: ["proxy"]
    });

    const archived = await assignRoutingConfig(
      fixture,
      defaultApiKeyId,
      "org_api_key_admin_rejects:routing-config:archived"
    );
    const missingVersion = await assignRoutingConfig(
      fixture,
      defaultApiKeyId,
      "org_api_key_admin_rejects:routing-config:empty"
    );
    const crossConfig = await assignRoutingConfig(
      fixture,
      defaultApiKeyId,
      "org_api_key_admin_other:routing-config:default"
    );
    const crossApiKey = await assignRoutingConfig(fixture, "other_org_api_key", defaultConfigId);
    const [defaultApiKey] = await fixture.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, defaultApiKeyId));
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "routing_config.api_key_assignment_changed"));

    expect(archived.errors?.[0]?.message).toBe("routing_config_archived");
    expect(archived.errors?.[0]?.extensions?.code).toBe("CONFLICT");
    expect(missingVersion.errors?.[0]?.message).toBe("routing_config_active_version_missing");
    expect(missingVersion.errors?.[0]?.extensions?.code).toBe("CONFLICT");
    expect(crossConfig.errors?.[0]?.message).toBe("routing_config_not_found");
    expect(crossConfig.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(crossApiKey.errors?.[0]?.message).toBe("api_key_not_found");
    expect(crossApiKey.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(defaultApiKey.routingConfigId).toBe(defaultConfigId);
    expect(eventRows).toHaveLength(0);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }

  async function createRoutingConfig(fixture: PromptTestFixture, organizationId: string, name: string) {
    const defaultDetail = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query Detail($configId: ID!) { routingConfig(configId: $configId) { versions { active config } } }",
      { configId: `${organizationId}:routing-config:default` }
    )).data?.routingConfig;
    const activeVersion = defaultDetail.versions.find((version: any) => version.active);
    const config = {
      ...(activeVersion.config as RoutingConfig),
      displayName: name
    };
    const result = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Create($input: CreateRoutingConfigInput!) {
        createRoutingConfig(input: $input) { config { id name } }
      }`,
      {
        input: {
          name,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          config
        }
      }
    );
    expect(result.errors).toBeUndefined();
    return result.data?.createRoutingConfig.config as { id: string; name: string };
  }

  function assignRoutingConfig(fixture: PromptTestFixture, apiKeyId: string, routingConfigId: string | null) {
    return adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Assign($apiKeyId: ID!, $routingConfigId: ID) {
        assignApiKeyRoutingConfig(apiKeyId: $apiKeyId, routingConfigId: $routingConfigId) {
          id
          routingConfigId
          routingConfig { id name status }
        }
      }`,
      { apiKeyId, routingConfigId }
    );
  }

  function postApiKey(fixture: PromptTestFixture, input: Record<string, unknown>) {
    return adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation CreateKey($input: CreateApiKeyInput!) {
        createApiKey(input: $input) {
          apiKey { id name userId scopes routingConfigId revokedAt }
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
});
