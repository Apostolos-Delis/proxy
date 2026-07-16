import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeys,
  defaultWorkspaceId,
  eventOutbox,
  events,
  logicalModelTargets,
  providerConnections
} from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";
import type { ProxyEvent } from "../src/events.js";
import { gatewayResourceId } from "../src/persistence/gatewayConfigIds.js";
import {
  createGatewayConfig as create,
  setGatewayConfigEnabled as enabled,
  setupGatewayConfig as setup,
  updateGatewayConfig as update
} from "./gatewayConfigTestSupport.js";

describe("gateway configuration admin", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
  });

  it("manages the full gateway resource graph with redacted atomic audit events", async () => {
    const fixture = await setup("org_gateway_admin_crud");
    client = fixture.client;
    const observedEvents: ProxyEvent[] = [];
    fixture.eventService.subscribe((event) => observedEvents.push(event));

    const connectionId = await create(fixture, "providerConnection", {
      slug: "acme-openai",
      name: "Acme OpenAI",
      adapterKind: "generic-http-json",
      authStyle: "bearer",
      baseUrl: "http://10.1.2.3:8000/v1/",
      secret: "sk-control-plane-secret",
      defaultHeaders: { "x-region": "iad" },
      enabled: true
    });
    const connection = await fixture.service.providerConnection(fixture.actor, connectionId);
    expect(connection).toMatchObject({
      slug: "acme-openai",
      baseUrl: "http://10.1.2.3:8000/v1",
      secretRef: null,
      secretHint: "••••cret",
      credentialConfigured: true,
      status: "active"
    });
    expect(connection).not.toHaveProperty("secretCiphertext");

    const canonicalModelId = await create(fixture, "canonicalModel", {
      slug: "acme-model",
      name: "Acme Model",
      vendor: "acme",
      family: "acme-1",
      capabilities: { tools: true, contextWindow: 200_000, modalities: ["text"] },
      enabled: true
    });
    const deploymentId = await create(fixture, "modelDeployment", {
      slug: "acme-model-primary",
      name: "Acme Model Primary",
      canonicalModelId,
      providerConnectionId: connectionId,
      upstreamModelId: "acme-model-2026-07",
      capabilities: { tools: false, contextWindow: 128_000, modalities: ["text"] },
      pricing: { inputCostPerMtok: 1 },
      enabled: true
    });
    const bindingId = await create(fixture, "wireBinding", {
      deploymentId,
      apiWireId: "openai-responses",
      endpointPath: "/responses",
      enabled: true
    });
    const logicalModelId = await create(fixture, "logicalModel", {
      slug: "acme-direct",
      name: "Acme Direct",
      resolutionKind: "direct",
      enabled: false
    });
    const targetId = await create(fixture, "logicalModelTarget", {
      logicalModelId,
      deploymentId,
      priority: 0,
      enabled: true
    });
    await enabled(fixture, "logicalModel", logicalModelId, true);
    const accessProfileId = await create(fixture, "accessProfile", {
      slug: "acme-services",
      name: "Acme Services",
      limits: { requests_per_minute: 120 },
      enabled: true
    });
    const grantId = await create(fixture, "modelGrant", {
      accessProfileId,
      logicalModelId,
      allowedOperations: ["text.generate", "model.list"],
      parameterCaps: { max_output_tokens: 8_192 },
      enabled: true
    });
    const apiKeyId = `${fixture.actor.organizationId}:api-key:default`;
    await fixture.service.applyCommands({
      ...fixture.actor,
      commands: [{ resource: "apiKey", action: "assignAccessProfile", id: apiKeyId, accessProfileId }]
    });

    await update(fixture, "providerConnection", connectionId, { name: "Acme OpenAI Production" });
    await update(fixture, "canonicalModel", canonicalModelId, { name: "Acme Model 1" });
    await update(fixture, "modelDeployment", deploymentId, { name: "Primary", pricing: { inputCostPerMtok: 0.9 } });
    await update(fixture, "wireBinding", bindingId, { requestConfig: { store: false } });
    await update(fixture, "logicalModel", logicalModelId, { name: "Acme Direct 1" });
    await update(fixture, "logicalModelTarget", targetId, { priority: 2 });
    await update(fixture, "accessProfile", accessProfileId, { limits: { requests_per_minute: 90 } });
    await update(fixture, "modelGrant", grantId, { parameterCaps: { max_output_tokens: 4_096 } });

    expect(await fixture.service.providerConnections(fixture.actor)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: connectionId, name: "Acme OpenAI Production" })
    ]));
    expect(await fixture.service.canonicalModel(fixture.actor, canonicalModelId)).toMatchObject({ name: "Acme Model 1" });
    expect(await fixture.service.modelDeployment(fixture.actor, deploymentId)).toMatchObject({ name: "Primary" });
    expect(await fixture.service.wireBinding(fixture.actor, bindingId)).toMatchObject({ requestConfig: { store: false } });
    expect(await fixture.service.logicalModel(fixture.actor, logicalModelId)).toMatchObject({ status: "active" });
    expect(await fixture.service.logicalModelTarget(fixture.actor, targetId)).toMatchObject({ priority: 2 });
    expect(await fixture.service.accessProfile(fixture.actor, accessProfileId)).toMatchObject({
      limits: { requests_per_minute: 90 }
    });
    expect(await fixture.service.modelGrant(fixture.actor, grantId)).toMatchObject({
      parameterCaps: { max_output_tokens: 4_096 }
    });

    const [storedKey] = await fixture.db.select({ accessProfileId: apiKeys.accessProfileId })
      .from(apiKeys).where(eq(apiKeys.id, apiKeyId));
    expect(storedKey?.accessProfileId).toBe(accessProfileId);
    const [storedConnection] = await fixture.db.select({ ciphertext: providerConnections.secretCiphertext })
      .from(providerConnections).where(eq(providerConnections.id, connectionId));
    expect(storedConnection?.ciphertext).toMatch(/^v1:/);
    expect(storedConnection?.ciphertext).not.toContain("sk-control-plane-secret");

    const auditEvents = await fixture.db.select({ payload: events.payload })
      .from(events).where(eq(events.producer, "proxy.admin.gateway-config"));
    const auditJson = JSON.stringify(auditEvents);
    expect(auditJson).not.toContain("sk-control-plane-secret");
    expect(auditJson).not.toContain(storedConnection?.ciphertext);
    const outbox = await fixture.db.select().from(eventOutbox);
    expect(outbox).toHaveLength(auditEvents.length);
    expect(observedEvents).toHaveLength(auditEvents.length);
    expect(observedEvents.every((event) => event.producer === "proxy.admin.gateway-config")).toBe(true);

    await enabled(fixture, "modelGrant", grantId, false);
    await enabled(fixture, "accessProfile", accessProfileId, false);
    await enabled(fixture, "logicalModel", logicalModelId, false);
    await enabled(fixture, "logicalModelTarget", targetId, false);
    await enabled(fixture, "wireBinding", bindingId, false);
    await enabled(fixture, "modelDeployment", deploymentId, false);
    await enabled(fixture, "canonicalModel", canonicalModelId, false);
    await enabled(fixture, "providerConnection", connectionId, false);
    expect(await fixture.service.modelGrant(fixture.actor, grantId)).toMatchObject({ enabled: false });
    expect(await fixture.service.providerConnection(fixture.actor, connectionId)).toMatchObject({ status: "disabled" });
  });

  it("rejects invalid code-owned identifiers and expanding deployment capabilities", async () => {
    const fixture = await setup("org_gateway_admin_validation");
    client = fixture.client;
    await expect(create(fixture, "providerConnection", {
      slug: "bad-adapter",
      name: "Bad Adapter",
      adapterKind: "uninstalled-adapter",
      authStyle: "none",
      baseUrl: "http://10.1.2.3:8000/v1"
    })).rejects.toThrow("invalid_provider_connection");

    const workspaceId = fixture.actor.workspaceId;
    const deploymentId = `${workspaceId}:deployment:openai:gpt-5.4-mini`;
    await expect(create(fixture, "wireBinding", {
      deploymentId,
      apiWireId: "invented-wire",
      endpointPath: "/responses"
    })).rejects.toThrow("invalid_wire_binding");

    const profileId = `${workspaceId}:access-profile:opendoor-engineer`;
    const modelId = `${workspaceId}:logical-model:coding-auto`;
    await expect(create(fixture, "modelGrant", {
      accessProfileId: profileId,
      logicalModelId: modelId,
      allowedOperations: ["images.generate"]
    })).rejects.toThrow("invalid_model_grant");

    const canonicalModelId = `${workspaceId}:canonical:openai:gpt-5.4-mini`;
    const connectionId = `${workspaceId}:connection:openai`;
    await expect(create(fixture, "modelDeployment", {
      slug: "expanding-deployment",
      name: "Expanding Deployment",
      canonicalModelId,
      providerConnectionId: connectionId,
      upstreamModelId: "expanding",
      capabilities: { contextWindow: 999_999_999 }
    })).rejects.toThrow("model_deployment_capabilities_expand_canonical");

    for (const [slug, config] of [
      ["undefined-json", { value: undefined }],
      ["nan-json", { value: Number.NaN }],
      ["bigint-json", { value: 1n }],
      ["date-json", { value: new Date("2026-01-01T00:00:00.000Z") }],
      ["oversized-utf8-json", { value: "€".repeat(30_000) }]
    ] as const) {
      await expect(create(fixture, "modelDeployment", {
        slug,
        name: slug,
        canonicalModelId,
        providerConnectionId: connectionId,
        upstreamModelId: slug,
        config
      }), slug).rejects.toThrow("invalid_model_deployment");
    }

    const overDepth: Record<string, unknown> = {};
    let cursor = overDepth;
    for (let index = 0; index < 65; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    await expect(create(fixture, "modelDeployment", {
      slug: "over-depth-json",
      name: "Over-depth JSON",
      canonicalModelId,
      providerConnectionId: connectionId,
      upstreamModelId: "over-depth-json",
      config: overDepth
    })).rejects.toMatchObject({
      message: "invalid_model_deployment",
      statusCode: 400,
      issues: expect.arrayContaining([
        expect.objectContaining({ message: "JSON objects cannot exceed 64 levels of nesting." })
      ])
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(create(fixture, "modelDeployment", {
      slug: "cyclic-json",
      name: "Cyclic JSON",
      canonicalModelId,
      providerConnectionId: connectionId,
      upstreamModelId: "cyclic-json",
      config: cyclic
    })).rejects.toMatchObject({ message: "invalid_model_deployment", statusCode: 400 });
  });

  it("requires credentials for non-platform Bedrock connections", async () => {
    const fixture = await setup("org_gateway_admin_bedrock_credentials");
    client = fixture.client;
    const connection = {
      name: "Private Bedrock",
      adapterKind: "aws-bedrock-converse",
      authStyle: "aws-sdk",
      baseUrl: "http://10.1.2.3:8000",
      region: "us-east-1"
    };

    await expect(create(fixture, "providerConnection", {
      ...connection,
      slug: "private-bedrock-active",
      enabled: true
    })).rejects.toThrow("provider_connection_credential_missing");

    const disabledId = await create(fixture, "providerConnection", {
      ...connection,
      slug: "private-bedrock-disabled",
      enabled: false
    });
    await expect(enabled(fixture, "providerConnection", disabledId, true))
      .rejects.toThrow("provider_connection_credential_missing");

    const credentialedId = await create(fixture, "providerConnection", {
      ...connection,
      slug: "private-bedrock-credentialed",
      secret: "bedrock-credential-material",
      enabled: true
    });
    expect(await fixture.service.providerConnection(fixture.actor, credentialedId))
      .toMatchObject({ status: "active", credentialConfigured: true });

    const platformId = `${fixture.actor.workspaceId}:connection:platform-bedrock`;
    await fixture.db.insert(providerConnections).values({
      id: platformId,
      organizationId: fixture.actor.organizationId,
      workspaceId: fixture.actor.workspaceId,
      slug: "platform-bedrock",
      name: "Platform Bedrock",
      adapterKind: "aws-bedrock-converse",
      authStyle: "aws-sdk",
      baseUrl: "http://10.1.2.3:8000",
      region: "us-east-1",
      platformOwned: true,
      status: "disabled"
    });
    await enabled(fixture, "providerConnection", platformId, true);
    expect(await fixture.service.providerConnection(fixture.actor, platformId))
      .toMatchObject({ status: "active", credentialConfigured: false, platformOwned: true });
  });

  it("applies ordered provider updates against transaction-local state", async () => {
    const fixture = await setup("org_gateway_admin_ordered_provider_updates");
    client = fixture.client;
    const connectionId = await create(fixture, "providerConnection", {
      slug: "ordered-provider",
      name: "Ordered Provider",
      adapterKind: "generic-http-json",
      authStyle: "bearer",
      baseUrl: "http://10.1.2.3:8000/v1",
      secret: "sk-initial-provider-secret",
      enabled: true
    });

    await fixture.service.applyCommands({
      ...fixture.actor,
      commands: [
        {
          resource: "providerConnection",
          action: "update",
          id: connectionId,
          body: {
            baseUrl: "http://10.2.3.4:8000/v1",
            secret: "sk-replacement-provider-secret"
          }
        },
        {
          resource: "providerConnection",
          action: "update",
          id: connectionId,
          body: {
            baseUrl: "http://10.2.3.4:8000/v2",
            name: "Ordered Provider Updated"
          }
        }
      ]
    });

    expect(await fixture.service.providerConnection(fixture.actor, connectionId)).toMatchObject({
      baseUrl: "http://10.2.3.4:8000/v2",
      name: "Ordered Provider Updated",
      credentialConfigured: true
    });

    const staleConnectionId = await create(fixture, "providerConnection", {
      slug: "stale-provider",
      name: "Stale Provider",
      adapterKind: "generic-http-json",
      authStyle: "bearer",
      baseUrl: "http://10.1.2.3:8000/v1",
      secret: "sk-stale-provider-secret"
    });
    await fixture.db.update(providerConnections).set({
      baseUrl: "http://127.0.0.1:8000/v1",
      status: "disabled"
    }).where(eq(providerConnections.id, staleConnectionId));
    await fixture.service.applyCommands({
      ...fixture.actor,
      commands: [
        {
          resource: "providerConnection",
          action: "update",
          id: staleConnectionId,
          body: {
            baseUrl: "http://10.3.4.5:8000/v1",
            secret: "sk-stale-provider-replacement"
          }
        },
        {
          resource: "providerConnection",
          action: "setEnabled",
          id: staleConnectionId,
          enabled: true
        }
      ]
    });
    expect(await fixture.service.providerConnection(fixture.actor, staleConnectionId)).toMatchObject({
      baseUrl: "http://10.3.4.5:8000/v1",
      status: "active"
    });
  });

  it("preserves trusted connection metadata across control-plane updates", async () => {
    const fixture = await setup("org_gateway_admin_trusted_connection");
    client = fixture.client;
    const connectionId = `${fixture.actor.workspaceId}:connection:openai`;

    await update(fixture, "providerConnection", connectionId, { name: "OpenAI Production" });
    await enabled(fixture, "providerConnection", connectionId, false);
    await enabled(fixture, "providerConnection", connectionId, true);

    const [connection] = await fixture.db.select({
      adapterConfig: providerConnections.adapterConfig,
      forwardHarnessHeaders: providerConnections.forwardHarnessHeaders,
      name: providerConnections.name,
      platformOwned: providerConnections.platformOwned,
      status: providerConnections.status
    }).from(providerConnections).where(eq(providerConnections.id, connectionId));
    expect(connection).toEqual({
      adapterConfig: {},
      forwardHarnessHeaders: true,
      name: "OpenAI Production",
      platformOwned: true,
      status: "active"
    });
  });

  it("requires active classifier dependencies only when a router is activated", async () => {
    const fixture = await setup("org_gateway_admin_router");
    client = fixture.client;
    const workspaceId = fixture.actor.workspaceId;
    const classifierDeploymentId = `${workspaceId}:deployment:openai:gpt-5.4-mini`;
    const classifierBindingId = `${classifierDeploymentId}:wire:openai-responses`;
    await enabled(fixture, "wireBinding", classifierBindingId, false);
    const logicalModelId = await create(fixture, "logicalModel", {
      slug: "disabled-router",
      name: "Disabled Router",
      resolutionKind: "router",
      routerConfig: {
        classifierDeploymentId,
        instructions: "Choose one eligible target.",
        timeoutMs: 5_000,
        maxAttempts: 2
      },
      enabled: false
    });
    await expect(enabled(fixture, "logicalModel", logicalModelId, true))
      .rejects.toThrow("classifier_deployment_inactive");
    await enabled(fixture, "wireBinding", classifierBindingId, true);
    await enabled(fixture, "logicalModel", logicalModelId, true);
    expect(await fixture.service.logicalModel(fixture.actor, logicalModelId)).toMatchObject({ status: "active" });
  });

  it("maps natural-key conflicts to stable control-plane errors", async () => {
    const fixture = await setup("org_gateway_admin_conflicts");
    client = fixture.client;
    const workspaceId = fixture.actor.workspaceId;
    const deploymentId = `${workspaceId}:deployment:openai:gpt-5.4-mini`;
    await expect(create(fixture, "wireBinding", {
      deploymentId,
      apiWireId: "openai-responses",
      endpointPath: "/responses"
    })).rejects.toThrow("wire_binding_exists");

    const logicalModelId = await create(fixture, "logicalModel", {
      slug: "conflict-direct",
      name: "Conflict Direct",
      resolutionKind: "direct"
    });
    await create(fixture, "logicalModelTarget", {
      logicalModelId,
      deploymentId,
      priority: 20
    });
    await expect(create(fixture, "logicalModelTarget", {
      logicalModelId,
      deploymentId,
      priority: 21
    })).rejects.toThrow("logical_model_target_deployment_exists");
    await expect(create(fixture, "logicalModelTarget", {
      logicalModelId,
      deploymentId: `${workspaceId}:deployment:anthropic:claude-fable-5`,
      priority: 20
    })).rejects.toThrow("logical_model_target_priority_exists");

    const profileId = await create(fixture, "accessProfile", {
      slug: "conflict-profile",
      name: "Conflict Profile"
    });
    await create(fixture, "modelGrant", {
      accessProfileId: profileId,
      logicalModelId,
      allowedOperations: ["model.list"]
    });
    await expect(create(fixture, "modelGrant", {
      accessProfileId: profileId,
      logicalModelId,
      allowedOperations: ["model.list"]
    })).rejects.toThrow("model_grant_exists");
  });

  it("keeps active direct models at exactly one enabled target", async () => {
    const fixture = await setup("org_gateway_admin_direct");
    client = fixture.client;
    const workspaceId = fixture.actor.workspaceId;
    const fableId = `${workspaceId}:logical-model:fable`;
    const [fableTarget] = await fixture.db.select({ id: logicalModelTargets.id })
      .from(logicalModelTargets).where(and(
        eq(logicalModelTargets.logicalModelId, fableId),
        eq(logicalModelTargets.enabled, true)
      ));
    expect(fableTarget).toBeTruthy();
    await expect(enabled(fixture, "logicalModelTarget", fableTarget!.id, false))
      .rejects.toThrow("direct_logical_model_target_count_invalid");
    expect(await fixture.service.logicalModelTarget(fixture.actor, fableTarget!.id)).toMatchObject({ enabled: true });

    const emptyDirectId = await create(fixture, "logicalModel", {
      slug: "empty-direct",
      name: "Empty Direct",
      resolutionKind: "direct"
    });
    await expect(enabled(fixture, "logicalModel", emptyDirectId, true))
      .rejects.toThrow("direct_logical_model_target_count_invalid");
    expect(await fixture.service.logicalModel(fixture.actor, emptyDirectId)).toMatchObject({ status: "disabled" });
  });

  it("rolls back a deferred direct-model batch when final target cardinality is invalid", async () => {
    const fixture = await setup("org_gateway_admin_deferred_direct_rollback");
    client = fixture.client;
    const observedEvents: ProxyEvent[] = [];
    fixture.eventService.subscribe((event) => observedEvents.push(event));
    const logicalModelId = gatewayResourceId("logicalModel");
    const firstTargetId = gatewayResourceId("logicalModelTarget");
    const secondTargetId = gatewayResourceId("logicalModelTarget");
    const workspaceId = fixture.actor.workspaceId;

    await expect(fixture.service.applyCommands({
      ...fixture.actor,
      commands: [
        {
          resource: "logicalModel",
          action: "create",
          id: logicalModelId,
          body: {
            slug: "invalid-deferred-direct",
            name: "Invalid Deferred Direct",
            resolutionKind: "direct",
            enabled: true
          }
        },
        {
          resource: "logicalModelTarget",
          action: "create",
          id: firstTargetId,
          body: {
            logicalModelId,
            deploymentId: `${workspaceId}:deployment:openai:gpt-5.4-mini`,
            priority: 0,
            enabled: true
          }
        },
        {
          resource: "logicalModelTarget",
          action: "create",
          id: secondTargetId,
          body: {
            logicalModelId,
            deploymentId: `${workspaceId}:deployment:anthropic:claude-fable-5`,
            priority: 1,
            enabled: true
          }
        }
      ]
    })).rejects.toThrow("direct_logical_model_target_count_invalid");

    expect(await fixture.service.logicalModel(fixture.actor, logicalModelId)).toBeNull();
    expect(await fixture.service.logicalModelTarget(fixture.actor, firstTargetId)).toBeNull();
    expect(await fixture.service.logicalModelTarget(fixture.actor, secondTargetId)).toBeNull();
    const auditEvents = await fixture.db.select().from(events);
    const rejectedIds = new Set([logicalModelId, firstTargetId, secondTargetId]);
    expect(auditEvents.some((event) => rejectedIds.has(event.scopeId))).toBe(false);
    expect(observedEvents.some((event) => rejectedIds.has(event.scopeId))).toBe(false);
  });

  it("rolls back a command batch and rejects cross-workspace references", async () => {
    const fixture = await setup("org_gateway_admin_rollback");
    client = fixture.client;
    const observedEvents: ProxyEvent[] = [];
    fixture.eventService.subscribe((event) => observedEvents.push(event));
    await expect(fixture.service.applyCommands({
      ...fixture.actor,
      commands: [
        {
          resource: "accessProfile",
          action: "create",
          body: { slug: "rolled-back", name: "Rolled Back" }
        },
        {
          resource: "providerConnection",
          action: "update",
          id: "missing_connection",
          body: { name: "Missing" }
        }
      ]
    })).rejects.toThrow("provider_connection_not_found");
    expect(await fixture.service.accessProfiles(fixture.actor)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "rolled-back" })
    ]));
    const rolledBackEvents = await fixture.db.select().from(events)
      .where(eq(events.scopeType, "access_profile"));
    expect(rolledBackEvents.some((event) => event.payload.slug === "rolled-back")).toBe(false);
    expect(observedEvents.some((event) => event.payload.slug === "rolled-back")).toBe(false);

    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_gateway_admin_other",
      SEED_USER_ID: "user_gateway_admin_other",
      SEED_USER_EMAIL: "gateway-admin-other@example.com",
      PROXY_TOKEN: "token_gateway_admin_other"
    }));
    const otherWorkspaceId = defaultWorkspaceId("org_gateway_admin_other");
    await expect(fixture.service.applyCommands({
      ...fixture.actor,
      commands: [{
        resource: "apiKey",
        action: "assignAccessProfile",
        id: `${fixture.actor.organizationId}:api-key:default`,
        accessProfileId: `${otherWorkspaceId}:access-profile:opendoor-engineer`
      }]
    })).rejects.toThrow("access_profile_not_found");
  });
});
