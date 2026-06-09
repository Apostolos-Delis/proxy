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
          routingConfigId: targetConfig.id
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
          routingConfigId: null
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

    expect(archived.status).toBe(409);
    expect(archivedBody.error).toBe("routing_config_archived");
    expect(missingVersion.status).toBe(409);
    expect(missingVersionBody.error).toBe("routing_config_active_version_missing");
    expect(crossConfig.status).toBe(404);
    expect(crossConfigBody.error).toBe("routing_config_not_found");
    expect(crossApiKey.status).toBe(404);
    expect(crossApiKeyBody.error).toBe("api_key_not_found");
    expect(defaultApiKey.routingConfigId).toBe(defaultConfigId);
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
});
