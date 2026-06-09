import { afterEach, describe, expect, it } from "vitest";

import {
  eventOutbox,
  events,
  organizations,
  routingConfigs,
  routingConfigVersions
} from "@prompt-proxy/db";
import type { RoutingConfig } from "@prompt-proxy/schema";
import { and, asc, eq, inArray } from "drizzle-orm";

import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("routing config admin APIs", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("requires browser admin sessions", async () => {
    const fixture = await setup("org_routing_config_auth");

    const list = await fetch(`${fixture.proxyUrl}/admin/routing-configs`);
    const detail = await fetch(`${fixture.proxyUrl}/admin/routing-configs/org_routing_config_auth:routing-config:default`);

    expect(list.status).toBe(401);
    expect(detail.status).toBe(401);
  });

  it("lists org-scoped routing configs with active version and key counts", async () => {
    const fixture = await setup("org_routing_config_list");
    await fixture.db.insert(routingConfigs).values({
      id: "org_routing_config_list:routing-config:archived",
      organizationId: "org_routing_config_list",
      name: "Archived routing config",
      slug: "archived",
      status: "archived"
    });
    await fixture.db.insert(organizations).values({
      id: "org_routing_config_other",
      slug: "org-routing-config-other",
      name: "Other Org"
    });
    await fixture.db.insert(routingConfigs).values({
      id: "org_routing_config_other:routing-config:default",
      organizationId: "org_routing_config_other",
      name: "Other routing config",
      slug: "default"
    });

    const response = await fetch(`${fixture.proxyUrl}/admin/routing-configs`, {
      headers: fixture.adminHeaders
    });
    const body = await response.json();
    const ids = body.data.map((item: any) => item.id);
    const seeded = body.data.find((item: any) => item.id === "org_routing_config_list:routing-config:default");
    const archived = body.data.find((item: any) => item.id === "org_routing_config_list:routing-config:archived");
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(ids).toContain("org_routing_config_list:routing-config:default");
    expect(ids).toContain("org_routing_config_list:routing-config:archived");
    expect(ids).not.toContain("org_routing_config_other:routing-config:default");
    expect(seeded).toEqual(expect.objectContaining({
      organizationId: "org_routing_config_list",
      name: "Default routing config",
      status: "active",
      activeVersionId: "org_routing_config_list:routing-config:default:v1",
      assignedApiKeyCount: 1,
      activeVersion: expect.objectContaining({
        id: "org_routing_config_list:routing-config:default:v1",
        version: 1,
        status: "active",
        active: true,
        configHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }),
      routeMatrix: expect.arrayContaining([
        expect.objectContaining({
          route: "fast",
          openaiModel: "gpt-5.4-mini",
          openaiEffort: "low",
          anthropicModel: "claude-haiku-4-5",
          anthropicEffort: "low"
        }),
        expect.objectContaining({
          route: "deep",
          openaiEffort: "xhigh",
          anthropicEffort: "xhigh"
        })
      ])
    }));
    expect(archived).toEqual(expect.objectContaining({
      status: "archived",
      activeVersion: null,
      routeMatrix: [],
      assignedApiKeyCount: 0
    }));
    expect(serialized).not.toContain("openai-upstream-key");
    expect(serialized).not.toContain("anthropic-upstream-key");
    expect(serialized).not.toContain("keyHash");
  });

  it("serves routing config detail with version history", async () => {
    const fixture = await setup("org_routing_config_detail");

    await fixture.db.insert(organizations).values({
      id: "org_routing_config_detail_other",
      slug: "org-routing-config-detail-other",
      name: "Other Org"
    });
    await fixture.db.insert(routingConfigs).values({
      id: "org_routing_config_detail_other:routing-config:default",
      organizationId: "org_routing_config_detail_other",
      name: "Other routing config",
      slug: "default"
    });

    const response = await fetch(
      `${fixture.proxyUrl}/admin/routing-configs/org_routing_config_detail:routing-config:default`,
      { headers: fixture.adminHeaders }
    );
    const body = await response.json();
    const crossOrg = await fetch(
      `${fixture.proxyUrl}/admin/routing-configs/org_routing_config_detail_other:routing-config:default`,
      { headers: fixture.adminHeaders }
    );
    const missing = await fetch(`${fixture.proxyUrl}/admin/routing-configs/missing_config`, {
      headers: fixture.adminHeaders
    });
    const versionConfig = body.versions[0].config as RoutingConfig;

    expect(response.status).toBe(200);
    expect(body.config).toEqual(expect.objectContaining({
      id: "org_routing_config_detail:routing-config:default",
      assignedApiKeyCount: 1,
      activeVersion: expect.objectContaining({
        id: "org_routing_config_detail:routing-config:default:v1",
        active: true
      })
    }));
    expect(body.versions).toEqual([
      expect.objectContaining({
        id: "org_routing_config_detail:routing-config:default:v1",
        routingConfigId: "org_routing_config_detail:routing-config:default",
        version: 1,
        status: "active",
        active: true,
        configHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        config: expect.any(Object)
      })
    ]);
    expect(versionConfig.routes.hard.openai?.model).toBe("gpt-5.5");
    expect(versionConfig.routes.hard.anthropic?.model).toBe("claude-sonnet-4-5");
    expect(JSON.stringify(body)).not.toContain("openai-upstream-key");
    expect(JSON.stringify(body)).not.toContain("anthropic-upstream-key");
    expect(crossOrg.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it("creates routing configs with active immutable version one", async () => {
    const fixture = await setup("org_routing_config_create");
    const baseConfig = await activeConfig(fixture, "org_routing_config_create:routing-config:default");
    const nextConfig = {
      ...baseConfig,
      displayName: "Created config"
    };

    const response = await fetch(`${fixture.proxyUrl}/admin/routing-configs`, {
      method: "POST",
      headers: {
        ...fixture.adminHeaders,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "Created config",
        slug: "created-config",
        description: "Created through admin API",
        config: nextConfig
      })
    });
    const body = await response.json();
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.scopeId, body.config.id))
      .orderBy(asc(events.sequence));
    const outboxRows = await outboxRowsFor(fixture, eventRows);

    expect(response.status).toBe(201);
    expect(body.config).toEqual(expect.objectContaining({
      name: "Created config",
      slug: "created-config",
      description: "Created through admin API",
      status: "active",
      assignedApiKeyCount: 0,
      activeVersion: expect.objectContaining({
        version: 1,
        status: "active",
        active: true,
        createdByUserId: "local-user"
      })
    }));
    expect(body.versions).toEqual([
      expect.objectContaining({
        version: 1,
        status: "active",
        active: true,
        config: expect.objectContaining({
          displayName: "Created config"
        })
      })
    ]);
    expect(eventRows).toEqual([
      expect.objectContaining({
        sequence: 1,
        organizationId: "org_routing_config_create",
        scopeType: "routing_config",
        scopeId: body.config.id,
        actorType: "user",
        actorId: "local-user",
        eventType: "routing_config.created",
        payload: expect.objectContaining({
          configId: body.config.id,
          versionId: body.config.activeVersionId,
          version: 1,
          configHash: body.config.activeVersion.configHash,
          slug: "created-config",
          status: "active"
        })
      }),
      expect.objectContaining({
        sequence: 2,
        organizationId: "org_routing_config_create",
        scopeType: "routing_config",
        scopeId: body.config.id,
        actorType: "user",
        actorId: "local-user",
        eventType: "routing_config.version_created",
        payload: expect.objectContaining({
          configId: body.config.id,
          versionId: body.config.activeVersionId,
          version: 1,
          configHash: body.config.activeVersion.configHash,
          status: "active"
        })
      })
    ]);
    expect(outboxRows).toHaveLength(2);
  });

  it("creates draft versions, activates them, and writes an audit event", async () => {
    const fixture = await setup("org_routing_config_versions");
    const configId = "org_routing_config_versions:routing-config:default";
    const originalConfig = await activeConfig(fixture, configId);
    const nextConfig = {
      ...originalConfig,
      displayName: "Updated config",
      routes: {
        ...originalConfig.routes,
        hard: {
          ...originalConfig.routes.hard,
          description: "Updated hard route"
        }
      }
    };

    const created = await fetch(`${fixture.proxyUrl}/admin/routing-configs/${configId}/versions`, {
      method: "POST",
      headers: {
        ...fixture.adminHeaders,
        "content-type": "application/json"
      },
      body: JSON.stringify({ config: nextConfig })
    });
    const createdBody = await created.json();
    const draft = createdBody.versions.find((version: any) => version.version === 2);
    const activeBefore = createdBody.versions.find((version: any) => version.active);

    const activated = await fetch(`${fixture.proxyUrl}/admin/routing-configs/${configId}/versions/${draft.id}/activate`, {
      method: "POST",
      headers: fixture.adminHeaders
    });
    const activatedBody = await activated.json();
    const activeAfter = activatedBody.versions.find((version: any) => version.active);
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.scopeId, configId))
      .orderBy(asc(events.sequence));
    const outboxRows = await outboxRowsFor(fixture, eventRows);
    const originalVersion = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.id, `${configId}:v1`));

    expect(created.status).toBe(201);
    expect(createdBody.config.activeVersionId).toBe(`${configId}:v1`);
    expect(draft).toEqual(expect.objectContaining({
      version: 2,
      status: "draft",
      active: false,
      config: expect.objectContaining({
        displayName: "Updated config"
      })
    }));
    expect(activeBefore).toEqual(expect.objectContaining({
      id: `${configId}:v1`,
      version: 1,
      active: true,
      config: expect.objectContaining({
        displayName: originalConfig.displayName
      })
    }));
    expect(activated.status).toBe(200);
    expect(activatedBody.config.activeVersionId).toBe(draft.id);
    expect(activeAfter).toEqual(expect.objectContaining({
      id: draft.id,
      version: 2,
      status: "active",
      active: true,
      config: expect.objectContaining({
        displayName: "Updated config"
      })
    }));
    expect(eventRows).toEqual([
      expect.objectContaining({
        sequence: 1,
        organizationId: "org_routing_config_versions",
        scopeType: "routing_config",
        scopeId: configId,
        actorType: "user",
        actorId: "local-user",
        eventType: "routing_config.version_created",
        payload: expect.objectContaining({
          configId,
          versionId: draft.id,
          version: 2,
          configHash: draft.configHash,
          status: "draft"
        })
      }),
      expect.objectContaining({
        sequence: 2,
        organizationId: "org_routing_config_versions",
        scopeType: "routing_config",
        scopeId: configId,
        actorType: "user",
        actorId: "local-user",
        payload: expect.objectContaining({
          configId,
          versionId: draft.id,
          version: 2,
          configHash: draft.configHash
        })
      })
    ]);
    expect(outboxRows).toHaveLength(2);
    expect(originalVersion[0].config).toEqual(originalConfig);
  });

  it("returns field-level validation errors before inserting invalid versions", async () => {
    const fixture = await setup("org_routing_config_validation");
    const configId = "org_routing_config_validation:routing-config:default";
    const before = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.routingConfigId, configId));

    const response = await fetch(`${fixture.proxyUrl}/admin/routing-configs/${configId}/versions`, {
      method: "POST",
      headers: {
        ...fixture.adminHeaders,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        config: {
          schemaVersion: 1,
          displayName: "Invalid config"
        }
      })
    });
    const body = await response.json();
    const after = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.routingConfigId, configId));
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(and(
        eq(events.scopeId, configId),
        eq(events.eventType, "routing_config.version_created")
      ));

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_routing_config");
    expect(body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringContaining("routes")
      })
    ]));
    expect(after).toHaveLength(before.length);
    expect(eventRows).toHaveLength(0);
  });

  it("archives unassigned routing configs with an audit event", async () => {
    const fixture = await setup("org_routing_config_archive");
    const created = await createRoutingConfig(fixture, "org_routing_config_archive", "Archive candidate");

    const archived = await fetch(`${fixture.proxyUrl}/admin/routing-configs/${created.config.id}/archive`, {
      method: "POST",
      headers: fixture.adminHeaders
    });
    const archivedBody = await archived.json();
    const defaultArchive = await fetch(
      `${fixture.proxyUrl}/admin/routing-configs/org_routing_config_archive:routing-config:default/archive`,
      {
        method: "POST",
        headers: fixture.adminHeaders
      }
    );
    const defaultArchiveBody = await defaultArchive.json();
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.scopeId, created.config.id))
      .orderBy(asc(events.sequence));
    const outboxRows = await outboxRowsFor(fixture, eventRows);

    expect(archived.status).toBe(200);
    expect(archivedBody.config).toEqual(expect.objectContaining({
      id: created.config.id,
      status: "archived"
    }));
    expect(defaultArchive.status).toBe(409);
    expect(defaultArchiveBody.error).toBe("routing_config_in_use");
    expect(eventRows.map((event) => event.eventType)).toEqual([
      "routing_config.created",
      "routing_config.version_created",
      "routing_config.archived"
    ]);
    expect(eventRows[2]).toEqual(expect.objectContaining({
      sequence: 3,
      organizationId: "org_routing_config_archive",
      actorType: "user",
      actorId: "local-user",
      payload: expect.objectContaining({
        configId: created.config.id,
        versionId: created.config.activeVersionId,
        version: 1,
        configHash: created.config.activeVersion.configHash,
        status: "archived"
      })
    }));
    expect(outboxRows).toHaveLength(3);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }

  async function activeConfig(fixture: PromptTestFixture, configId: string) {
    const detail = await fetch(`${fixture.proxyUrl}/admin/routing-configs/${configId}`, {
      headers: fixture.adminHeaders
    }).then((item) => item.json());
    const activeVersion = detail.versions.find((version: any) => version.active);
    return activeVersion.config as RoutingConfig;
  }

  async function createRoutingConfig(fixture: PromptTestFixture, organizationId: string, name: string) {
    const baseConfig = await activeConfig(fixture, `${organizationId}:routing-config:default`);
    const response = await fetch(`${fixture.proxyUrl}/admin/routing-configs`, {
      method: "POST",
      headers: {
        ...fixture.adminHeaders,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        config: {
          ...baseConfig,
          displayName: name
        }
      })
    });
    expect(response.status).toBe(201);
    return response.json();
  }

  async function outboxRowsFor(fixture: PromptTestFixture, eventRows: (typeof events.$inferSelect)[]) {
    if (eventRows.length === 0) return [];
    return fixture.db
      .select()
      .from(eventOutbox)
      .where(inArray(eventOutbox.eventId, eventRows.map((event) => event.id)));
  }
});
