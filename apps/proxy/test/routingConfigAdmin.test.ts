import { afterEach, describe, expect, it } from "vitest";

import {
  defaultWorkspaceId,
  eventOutbox,
  events,
  organizations,
  providers,
  routingConfigs,
  routingConfigVersions,
  workspaces
} from "@prompt-proxy/db";
import type { RoutingConfig } from "@prompt-proxy/schema";
import { and, asc, eq, inArray } from "drizzle-orm";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const detailFields = `{
  config {
    id
    organizationId
    name
    slug
    description
    status
    activeVersionId
    assignedApiKeyCount
    activeVersion {
      id
      version
      status
      active
      configHash
      createdByUserId
    }
    routes {
      route
      targets {
        providerId
        model
        effort
        effectiveEffort
        verbosity
      }
    }
  }
  versions {
    id
    routingConfigId
    version
    status
    active
    configHash
    createdByUserId
    config
  }
}`;

const listQuery = `query {
  routingConfigs {
    id
    organizationId
    name
    slug
    status
    activeVersionId
    assignedApiKeyCount
    activeVersion { id version status active configHash }
    routes { route targets { providerId model effort effectiveEffort verbosity } }
  }
}`;

const detailQuery = `query Detail($configId: ID!) { routingConfig(configId: $configId) ${detailFields} }`;
const createMutation = `mutation Create($input: CreateRoutingConfigInput!) { createRoutingConfig(input: $input) ${detailFields} }`;
const createVersionMutation = `mutation CreateVersion($configId: ID!, $config: JSON!) { createRoutingConfigVersion(configId: $configId, config: $config) ${detailFields} }`;
const activateMutation = `mutation Activate($configId: ID!, $versionId: ID!) { activateRoutingConfigVersion(configId: $configId, versionId: $versionId) ${detailFields} }`;
const archiveMutation = `mutation Archive($configId: ID!) { archiveRoutingConfig(configId: $configId) ${detailFields} }`;

describe("routing config admin APIs", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("requires browser admin sessions", async () => {
    const fixture = await setup("org_routing_config_auth");

    const list = await adminGql(fixture.proxyUrl, {}, listQuery);
    const detail = await adminGql(fixture.proxyUrl, {}, detailQuery, {
      configId: "org_routing_config_auth:routing-config:default"
    });

    expect(list.status).toBe(401);
    expect(detail.status).toBe(401);
  });

  it("lists org-scoped routing configs with active version and key counts", async () => {
    const fixture = await setup("org_routing_config_list");
    await fixture.db.insert(routingConfigs).values({
      id: "org_routing_config_list:routing-config:archived",
      organizationId: "org_routing_config_list",
      workspaceId: defaultWorkspaceId("org_routing_config_list"),
      name: "Archived routing config",
      slug: "archived",
      status: "archived"
    });
    await fixture.db.insert(organizations).values({
      id: "org_routing_config_other",
      slug: "org-routing-config-other",
      name: "Other Org"
    });
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_routing_config_other"),
      organizationId: "org_routing_config_other",
      slug: "default",
      name: "Default"
    });
    await fixture.db.insert(routingConfigs).values({
      id: "org_routing_config_other:routing-config:default",
      organizationId: "org_routing_config_other",
      workspaceId: defaultWorkspaceId("org_routing_config_other"),
      name: "Other routing config",
      slug: "default"
    });

    const result = await adminGql(fixture.proxyUrl, fixture.adminHeaders, listQuery);
    const body = result.data?.routingConfigs;
    const ids = body.map((item: any) => item.id);
    const seeded = body.find((item: any) => item.id === "org_routing_config_list:routing-config:default");
    const archived = body.find((item: any) => item.id === "org_routing_config_list:routing-config:archived");
    const serialized = JSON.stringify(body);

    expect(result.status).toBe(200);
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
      routes: expect.arrayContaining([
        expect.objectContaining({
          route: "fast",
          targets: expect.arrayContaining([
            expect.objectContaining({
              providerId: "openai",
              model: "gpt-5.4-mini",
              effort: "low",
              effectiveEffort: "low"
            }),
            expect.objectContaining({
              providerId: "anthropic",
              model: "claude-haiku-4-5",
              effort: "low",
              effectiveEffort: "low"
            })
          ])
        }),
        expect.objectContaining({
          route: "deep",
          targets: expect.arrayContaining([
            expect.objectContaining({ providerId: "openai", effectiveEffort: "xhigh" }),
            expect.objectContaining({ providerId: "anthropic", effectiveEffort: "xhigh" })
          ])
        })
      ])
    }));
    expect(archived).toEqual(expect.objectContaining({
      status: "archived",
      activeVersion: null,
      routes: [],
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
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_routing_config_detail_other"),
      organizationId: "org_routing_config_detail_other",
      slug: "default",
      name: "Default"
    });
    await fixture.db.insert(routingConfigs).values({
      id: "org_routing_config_detail_other:routing-config:default",
      organizationId: "org_routing_config_detail_other",
      workspaceId: defaultWorkspaceId("org_routing_config_detail_other"),
      name: "Other routing config",
      slug: "default"
    });

    const result = await adminGql(fixture.proxyUrl, fixture.adminHeaders, detailQuery, {
      configId: "org_routing_config_detail:routing-config:default"
    });
    const body = result.data?.routingConfig;
    const crossOrg = await adminGql(fixture.proxyUrl, fixture.adminHeaders, detailQuery, {
      configId: "org_routing_config_detail_other:routing-config:default"
    });
    const missing = await adminGql(fixture.proxyUrl, fixture.adminHeaders, detailQuery, {
      configId: "missing_config"
    });
    const versionConfig = body.versions[0].config as RoutingConfig;

    expect(result.status).toBe(200);
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
    expect(versionConfig.routes.hard.targets.find((target) => target.providerId === "openai")?.model).toBe("gpt-5.5");
    expect(versionConfig.routes.hard.targets.find((target) => target.providerId === "anthropic")?.model).toBe("claude-sonnet-4-5");
    expect(JSON.stringify(body)).not.toContain("openai-upstream-key");
    expect(JSON.stringify(body)).not.toContain("anthropic-upstream-key");
    expect(crossOrg.data?.routingConfig).toBeNull();
    expect(missing.data?.routingConfig).toBeNull();
  });

  it("creates routing configs with active immutable version one", async () => {
    const fixture = await setup("org_routing_config_create");
    const baseConfig = await activeConfig(fixture, "org_routing_config_create:routing-config:default");
    const nextConfig = {
      ...baseConfig,
      displayName: "Created config"
    };

    const result = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createMutation, {
      input: {
        name: "Created config",
        description: "Created through admin API",
        config: nextConfig
      }
    });
    const body = result.data?.createRoutingConfig;
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.scopeId, body.config.id))
      .orderBy(asc(events.sequence));
    const outboxRows = await outboxRowsFor(fixture, eventRows);

    expect(result.errors).toBeUndefined();
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

    const created = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createVersionMutation, {
      configId,
      config: nextConfig
    });
    const createdBody = created.data?.createRoutingConfigVersion;
    const draft = createdBody.versions.find((version: any) => version.version === 2);
    const activeBefore = createdBody.versions.find((version: any) => version.active);

    const activated = await adminGql(fixture.proxyUrl, fixture.adminHeaders, activateMutation, {
      configId,
      versionId: draft.id
    });
    const activatedBody = activated.data?.activateRoutingConfigVersion;
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

    expect(created.errors).toBeUndefined();
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
    expect(activated.errors).toBeUndefined();
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

    const result = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createVersionMutation, {
      configId,
      config: {
        schemaVersion: 1,
        displayName: "Invalid config"
      }
    });
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

    expect(result.errors?.[0]?.message).toBe("invalid_routing_config");
    expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(result.errors?.[0]?.extensions?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringContaining("routes")
      })
    ]));
    expect(after).toHaveLength(before.length);
    expect(eventRows).toHaveLength(0);
  });

  it("rejects classifier providers without a Responses endpoint before inserting versions", async () => {
    const fixture = await setup("org_routing_config_classifier_provider");
    const organizationId = "org_routing_config_classifier_provider";
    const configId = `${organizationId}:routing-config:default`;
    const baseConfig = await activeConfig(fixture, configId);
    await fixture.db.insert(providers).values({
      id: "00000000-0000-0000-0000-00000000c017",
      organizationId,
      slug: "chat-only-classifier",
      displayName: "Chat-only classifier",
      baseUrl: "https://chat-only-classifier.example/v1",
      authStyle: "none",
      endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });
    const before = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.routingConfigId, configId));

    const result = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createVersionMutation, {
      configId,
      config: {
        ...baseConfig,
        classifier: {
          ...baseConfig.classifier,
          providerId: "chat-only-classifier"
        }
      }
    });
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

    expect(result.errors?.[0]?.message).toBe("routing_config_classifier_provider_responses_endpoint_required");
    expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(result.errors?.[0]?.extensions?.issues).toEqual([{
      path: "classifier.providerId",
      message: "Classifier provider must expose an OpenAI Responses endpoint."
    }]);
    expect(after).toHaveLength(before.length);
    expect(eventRows).toHaveLength(0);
  });

  it("rejects route targets that cannot serve current surfaces before inserting versions", async () => {
    const fixture = await setup("org_routing_config_target_provider");
    const organizationId = "org_routing_config_target_provider";
    const configId = `${organizationId}:routing-config:default`;
    const baseConfig = await activeConfig(fixture, configId);
    await fixture.db.insert(providers).values({
      id: "00000000-0000-0000-0000-00000000c019",
      organizationId,
      slug: "future-only-target",
      displayName: "Future-only target",
      baseUrl: "https://future-only-target.example/v1",
      authStyle: "none",
      endpoints: [{ dialect: "future-dialect", path: "/future" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });
    const before = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.routingConfigId, configId));

    const result = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createVersionMutation, {
      configId,
      config: {
        ...baseConfig,
        routes: {
          ...baseConfig.routes,
          fast: {
            ...baseConfig.routes.fast,
            targets: [{
              providerId: "future-only-target",
              model: "future-only-model",
              effort: "low"
            }]
          }
        }
      }
    });
    const after = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.routingConfigId, configId));

    expect(result.errors?.[0]?.message).toBe("routing_config_target_validation_failed");
    expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(result.errors?.[0]?.extensions?.issues).toEqual([{
      path: "routes.fast.targets.0.providerId",
      message: "Target provider must expose an OpenAI Responses, OpenAI Chat, or Anthropic Messages endpoint."
    }]);
    expect(after).toHaveLength(before.length);
  });

  it("rechecks classifier provider capabilities before activating drafts", async () => {
    const fixture = await setup("org_routing_config_classifier_activate");
    const organizationId = "org_routing_config_classifier_activate";
    const configId = `${organizationId}:routing-config:default`;
    const providerId = "00000000-0000-0000-0000-00000000c018";
    const baseConfig = await activeConfig(fixture, configId);
    await fixture.db.insert(providers).values({
      id: providerId,
      organizationId,
      slug: "mutable-classifier",
      displayName: "Mutable classifier",
      baseUrl: "https://mutable-classifier.example/v1",
      authStyle: "none",
      endpoints: [{ dialect: "openai-responses", path: "/responses" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });
    const created = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createVersionMutation, {
      configId,
      config: {
        ...baseConfig,
        classifier: {
          ...baseConfig.classifier,
          providerId: "mutable-classifier"
        }
      }
    });
    const draft = created.data?.createRoutingConfigVersion.versions.find((version: any) => version.version === 2);
    expect(created.errors).toBeUndefined();
    expect(draft).toBeTruthy();
    await fixture.db
      .update(providers)
      .set({ endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }] })
      .where(eq(providers.id, providerId));

    const activated = await adminGql(fixture.proxyUrl, fixture.adminHeaders, activateMutation, {
      configId,
      versionId: draft.id
    });
    const detail = await adminGql(fixture.proxyUrl, fixture.adminHeaders, detailQuery, { configId });
    const activationEvents = await fixture.db
      .select()
      .from(events)
      .where(and(
        eq(events.scopeId, configId),
        eq(events.eventType, "routing_config.version_activated")
      ));

    expect(activated.errors?.[0]?.message).toBe("routing_config_classifier_provider_responses_endpoint_required");
    expect(activated.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(detail.data?.routingConfig.config.activeVersionId).toBe(`${configId}:v1`);
    expect(activationEvents).toHaveLength(0);
  });

  it("archives unassigned routing configs with an audit event", async () => {
    const fixture = await setup("org_routing_config_archive");
    const created = await createRoutingConfig(fixture, "org_routing_config_archive", "Archive candidate");

    const archived = await adminGql(fixture.proxyUrl, fixture.adminHeaders, archiveMutation, {
      configId: created.config.id
    });
    const archivedBody = archived.data?.archiveRoutingConfig;
    const defaultArchive = await adminGql(fixture.proxyUrl, fixture.adminHeaders, archiveMutation, {
      configId: "org_routing_config_archive:routing-config:default"
    });
    const eventRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.scopeId, created.config.id))
      .orderBy(asc(events.sequence));
    const outboxRows = await outboxRowsFor(fixture, eventRows);

    expect(archived.errors).toBeUndefined();
    expect(archivedBody.config).toEqual(expect.objectContaining({
      id: created.config.id,
      status: "archived"
    }));
    expect(defaultArchive.errors?.[0]?.message).toBe("routing_config_in_use");
    expect(defaultArchive.errors?.[0]?.extensions?.code).toBe("CONFLICT");
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
    const detail = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, detailQuery, {
      configId
    })).data?.routingConfig;
    const activeVersion = detail.versions.find((version: any) => version.active);
    return activeVersion.config as RoutingConfig;
  }

  async function createRoutingConfig(fixture: PromptTestFixture, organizationId: string, name: string) {
    const baseConfig = await activeConfig(fixture, `${organizationId}:routing-config:default`);
    const result = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createMutation, {
      input: {
        name,
        config: {
          ...baseConfig,
          displayName: name
        }
      }
    });
    expect(result.errors).toBeUndefined();
    return result.data?.createRoutingConfig;
  }

  async function outboxRowsFor(fixture: PromptTestFixture, eventRows: (typeof events.$inferSelect)[]) {
    if (eventRows.length === 0) return [];
    return fixture.db
      .select()
      .from(eventOutbox)
      .where(inArray(eventOutbox.eventId, eventRows.map((event) => event.id)));
  }
});
