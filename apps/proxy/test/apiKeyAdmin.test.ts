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

import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

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

    const listResponse = await fetch(`${fixture.proxyUrl}/admin/api-keys`, {
      headers: fixture.adminHeaders
    });
    const list = await listResponse.json();
    const detailResponse = await fetch(
      `${fixture.proxyUrl}/admin/api-keys/org_api_key_admin_list:api-key:default`,
      { headers: fixture.adminHeaders }
    );
    const detail = await detailResponse.json();
    const serialized = JSON.stringify({ list, detail });

    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    expect(list.data).toEqual(expect.arrayContaining([
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
    expect(detail.apiKey).toEqual(expect.objectContaining({
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

    const assignedResponse = await patchRoutingConfig(fixture, "api_key_assignable", targetConfig.id);
    const assigned = await assignedResponse.json();
    const assignedIdentity = await fixture.persistence.apiKeys.resolve("assignment-token");

    const clearedResponse = await patchRoutingConfig(fixture, "api_key_assignable", null);
    const cleared = await clearedResponse.json();
    const clearedIdentity = await fixture.persistence.apiKeys.resolve("assignment-token");
    const resolvedAfterClear = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_api_key_admin_assign",
      routingConfigId: clearedIdentity?.routingConfigId
    });
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "routing_config.api_key_assignment_changed"));

    expect(assignedResponse.status).toBe(200);
    expect(assigned.apiKey).toEqual(expect.objectContaining({
      id: "api_key_assignable",
      routingConfigId: targetConfig.id,
      routingConfig: expect.objectContaining({
        id: targetConfig.id,
        name: "Assigned config",
        status: "active"
      })
    }));
    expect(assignedIdentity?.routingConfigId).toBe(targetConfig.id);
    expect(clearedResponse.status).toBe(200);
    expect(cleared.apiKey).toEqual(expect.objectContaining({
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
    const created = await response.json();
    const identity = await fixture.persistence.apiKeys.resolve(created.secret);
    const listResponse = await fetch(`${fixture.proxyUrl}/admin/api-keys`, {
      headers: fixture.adminHeaders
    });
    const list = await listResponse.json();
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "api_key.created"));

    expect(response.status).toBe(201);
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
    const missingNameBody = await missingName.json();
    const unknownScope = await postApiKey(fixture, { name: "Bad scope key", scopes: ["root"] });
    const unknownScopeBody = await unknownScope.json();
    const archivedConfig = await postApiKey(fixture, {
      name: "Archived target key",
      routingConfigId: "org_api_key_admin_create_invalid:routing-config:archived"
    });
    const archivedConfigBody = await archivedConfig.json();
    const keyRows = await fixture.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.organizationId, "org_api_key_admin_create_invalid"));

    expect(missingName.status).toBe(400);
    expect(missingNameBody.error).toBe("invalid_api_key_request");
    expect(unknownScope.status).toBe(400);
    expect(unknownScopeBody.error).toBe("invalid_api_key_request");
    expect(archivedConfig.status).toBe(409);
    expect(archivedConfigBody.error).toBe("routing_config_archived");
    expect(keyRows.map((row) => row.id)).toEqual(["org_api_key_admin_create_invalid:api-key:default"]);
  });

  it("revokes API keys and blocks further proxy auth", async () => {
    const fixture = await setup("org_api_key_admin_revoke");
    const createResponse = await postApiKey(fixture, { name: "Revocable key" });
    const created = await createResponse.json();
    const beforeIdentity = await fixture.persistence.apiKeys.resolve(created.secret);

    const revokeResponse = await fetch(
      `${fixture.proxyUrl}/admin/api-keys/${created.apiKey.id}/revoke`,
      { method: "POST", headers: fixture.adminHeaders }
    );
    const revoked = await revokeResponse.json();
    const afterIdentity = await fixture.persistence.apiKeys.resolve(created.secret);
    const repeat = await fetch(
      `${fixture.proxyUrl}/admin/api-keys/${created.apiKey.id}/revoke`,
      { method: "POST", headers: fixture.adminHeaders }
    );
    const repeatBody = await repeat.json();
    const missing = await fetch(
      `${fixture.proxyUrl}/admin/api-keys/missing-key/revoke`,
      { method: "POST", headers: fixture.adminHeaders }
    );
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "api_key.revoked"));

    expect(createResponse.status).toBe(201);
    expect(beforeIdentity?.apiKeyId).toBe(created.apiKey.id);
    expect(revokeResponse.status).toBe(200);
    expect(revoked.apiKey).toEqual(expect.objectContaining({
      id: created.apiKey.id,
      revokedAt: expect.any(String)
    }));
    expect(afterIdentity).toBeUndefined();
    expect(repeat.status).toBe(409);
    expect(repeatBody.error).toBe("api_key_revoked");
    expect(missing.status).toBe(404);
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

    const archived = await patchRoutingConfig(
      fixture,
      defaultApiKeyId,
      "org_api_key_admin_rejects:routing-config:archived"
    );
    const archivedBody = await archived.json();
    const missingVersion = await patchRoutingConfig(
      fixture,
      defaultApiKeyId,
      "org_api_key_admin_rejects:routing-config:empty"
    );
    const missingVersionBody = await missingVersion.json();
    const crossConfig = await patchRoutingConfig(
      fixture,
      defaultApiKeyId,
      "org_api_key_admin_other:routing-config:default"
    );
    const crossConfigBody = await crossConfig.json();
    const crossApiKey = await patchRoutingConfig(fixture, "other_org_api_key", defaultConfigId);
    const crossApiKeyBody = await crossApiKey.json();
    const [defaultApiKey] = await fixture.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, defaultApiKeyId));
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "routing_config.api_key_assignment_changed"));

    expect(archived.status).toBe(409);
    expect(archivedBody.error).toBe("routing_config_archived");
    expect(missingVersion.status).toBe(409);
    expect(missingVersionBody.error).toBe("routing_config_active_version_missing");
    expect(crossConfig.status).toBe(404);
    expect(crossConfigBody.error).toBe("routing_config_not_found");
    expect(crossApiKey.status).toBe(404);
    expect(crossApiKeyBody.error).toBe("api_key_not_found");
    expect(defaultApiKey.routingConfigId).toBe(defaultConfigId);
    expect(eventRows).toHaveLength(0);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }

  async function createRoutingConfig(fixture: PromptTestFixture, organizationId: string, name: string) {
    const defaultDetail = await fetch(`${fixture.proxyUrl}/admin/routing-configs/${organizationId}:routing-config:default`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
    const activeVersion = defaultDetail.versions.find((version: any) => version.active);
    const config = {
      ...(activeVersion.config as RoutingConfig),
      displayName: name
    };
    const response = await fetch(`${fixture.proxyUrl}/admin/routing-configs`, {
      method: "POST",
      headers: {
        ...fixture.adminHeaders,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        config
      })
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    return body.config as { id: string; name: string };
  }

  function patchRoutingConfig(fixture: PromptTestFixture, apiKeyId: string, routingConfigId: string | null) {
    return fetch(`${fixture.proxyUrl}/admin/api-keys/${apiKeyId}/routing-config`, {
      method: "PATCH",
      headers: {
        ...fixture.adminHeaders,
        "content-type": "application/json"
      },
      body: JSON.stringify({ routingConfigId })
    });
  }

  function postApiKey(fixture: PromptTestFixture, body: Record<string, unknown>) {
    return fetch(`${fixture.proxyUrl}/admin/api-keys`, {
      method: "POST",
      headers: {
        ...fixture.adminHeaders,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  }
});
