import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  accessProfileModelGrants,
  accessProfiles,
  apiKeys,
  canonicalModels,
  createPgliteDatabase,
  defaultWorkspaceId,
  deploymentHealth,
  deploymentWireBindings,
  logicalModels,
  logicalModelTargets,
  modelDeployments,
  providerConnections,
  workspaces
} from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";
import type { GatewayModelCapabilities } from "@proxy/schema";

import {
  ModelResolutionService,
  type ModelResolutionDenialCode,
  type ModelResolutionResult
} from "../src/persistence/modelResolution.js";

describe("logical model resolution", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
  });

  it("resolves one authorized direct model through native or installed translated wires", async () => {
    const fixture = await setup("org_resolution_direct");
    client = fixture.client;
    const native = await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      ingressWireId: "anthropic-messages"
    }));
    const translated = await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      ingressWireId: "openai-responses"
    }));
    const countTokens = await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      ingressWireId: "anthropic-messages",
      operationId: "text.count_tokens"
    }));

    expect(native).toEqual(expect.objectContaining({
      outcome: "resolved",
      logicalModelSlug: "fable",
      upstreamModelId: "claude-fable-5",
      egressWireId: "anthropic-messages",
      endpointPath: "/messages",
      wireAdapterId: null,
      wireAdapterVersion: null,
      routerDecisionId: null
    }));
    expect(translated).toEqual(expect.objectContaining({
      outcome: "resolved",
      upstreamModelId: "claude-fable-5",
      egressWireId: "anthropic-messages",
      wireAdapterId: "openai-responses-to-anthropic-messages",
      wireAdapterVersion: "1"
    }));
    expect(countTokens).toEqual(expect.objectContaining({
      outcome: "resolved",
      egressWireId: "anthropic-messages"
    }));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      ingressWireId: "openai-responses",
      operationId: "text.count_tokens"
    })), "model_unavailable");
  });

  it("filters direct targets by explicit capability constraints", async () => {
    const fixture = await setup("org_resolution_capabilities");
    client = fixture.client;
    const workspaceId = defaultWorkspaceId(fixture.organizationId);
    const deploymentId = `${workspaceId}:deployment:anthropic:claude-fable-5`;
    const cases: Array<{
      capabilities: GatewayModelCapabilities;
      input: Partial<Parameters<ModelResolutionService["resolve"]>[0]>;
    }> = [
      {
        capabilities: { tools: false },
        input: { classificationFeatures: { hasTools: true } }
      },
      {
        capabilities: { modalities: ["text"] },
        input: { classificationFeatures: { hasImages: true } }
      },
      {
        capabilities: { modalities: ["image"] },
        input: {}
      },
      {
        capabilities: { contextWindow: 100 },
        input: { classificationFeatures: { estimatedInputTokens: 101 } }
      },
      {
        capabilities: { maxOutputTokens: 100 },
        input: { parameters: { max_output_tokens: 101 } }
      },
      {
        capabilities: { streaming: false },
        input: { isStreaming: true }
      }
    ];

    for (const testCase of cases) {
      await fixture.db
        .update(modelDeployments)
        .set({ capabilities: testCase.capabilities })
        .where(eq(modelDeployments.id, deploymentId));
      expectDenial(
        await fixture.resolver.resolve(resolveInput(fixture.organizationId, testCase.input)),
        "model_unavailable"
      );
    }

    await fixture.db
      .update(modelDeployments)
      .set({ capabilities: {} })
      .where(eq(modelDeployments.id, deploymentId));
    expect((await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      classificationFeatures: { estimatedInputTokens: 100, hasTools: true, hasImages: true },
      parameters: { max_output_tokens: 100 },
      isStreaming: true
    }))).outcome).toBe("resolved");
  });

  it("returns typed denials for missing grants, disallowed operations, and exceeded caps", async () => {
    const fixture = await setup("org_resolution_access", {
      SEED_EXTERNAL_ECONOMY_TOKEN: "external-resolution-token"
    });
    client = fixture.client;
    const workspaceId = defaultWorkspaceId(fixture.organizationId);
    const externalKeyId = `${fixture.organizationId}:api-key:external-economy`;
    await fixture.db
      .update(apiKeys)
      .set({ revokedAt: null })
      .where(eq(apiKeys.id, externalKeyId));

    expectDenial(await fixture.resolver.resolve({
      ...resolveInput(fixture.organizationId),
      apiKeyId: externalKeyId
    }), "model_access_denied");

    const engineerProfileId = `${workspaceId}:access-profile:opendoor-engineer`;
    const fableId = `${workspaceId}:logical-model:fable`;
    await fixture.db
      .update(accessProfileModelGrants)
      .set({ allowedOperations: ["model.list"] })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, engineerProfileId),
        eq(accessProfileModelGrants.logicalModelId, fableId)
      ));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId)), "operation_not_allowed");

    await fixture.db
      .update(accessProfileModelGrants)
      .set({
        allowedOperations: ["text.generate", "text.count_tokens"],
        parameterCaps: { max_tokens: 100 }
      })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, engineerProfileId),
        eq(accessProfileModelGrants.logicalModelId, fableId)
      ));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      parameters: { max_output_tokens: 101 }
    })), "parameter_cap_exceeded");
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId)), "parameter_cap_exceeded");
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      parameters: { max_tokens: 1.5 }
    })), "invalid_parameters");
    expect((await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      parameters: { max_completion_tokens: 100 }
    }))).outcome).toBe("resolved");
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      parameters: { max_tokens: undefined, max_output_tokens: 101 }
    })), "parameter_cap_exceeded");
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      parameters: { max_tokens: undefined }
    })), "parameter_cap_exceeded");
    expect((await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      operationId: "text.count_tokens"
    }))).outcome).toBe("resolved");
  });

  it("applies the Anthropic token default before grant and deployment capacity checks", async () => {
    const fixture = await setup("org_resolution_anthropic_default");
    client = fixture.client;
    const workspaceId = defaultWorkspaceId(fixture.organizationId);
    const profileId = `${workspaceId}:access-profile:opendoor-engineer`;
    const logicalModelId = `${workspaceId}:logical-model:fable`;
    const deploymentId = `${workspaceId}:deployment:anthropic:claude-fable-5`;

    await fixture.db
      .update(accessProfileModelGrants)
      .set({ parameterCaps: { max_tokens: 4095 } })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, profileId),
        eq(accessProfileModelGrants.logicalModelId, logicalModelId)
      ));
    expectDenial(
      await fixture.resolver.resolve(resolveInput(fixture.organizationId)),
      "parameter_cap_exceeded"
    );

    await fixture.db
      .update(accessProfileModelGrants)
      .set({ parameterCaps: { max_tokens: 4096 } })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, profileId),
        eq(accessProfileModelGrants.logicalModelId, logicalModelId)
      ));
    expect((await fixture.resolver.resolve(resolveInput(fixture.organizationId))).outcome)
      .toBe("resolved");

    await fixture.db
      .update(accessProfileModelGrants)
      .set({ parameterCaps: {} })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, profileId),
        eq(accessProfileModelGrants.logicalModelId, logicalModelId)
      ));
    await fixture.db
      .update(modelDeployments)
      .set({ capabilities: { maxOutputTokens: 4095 } })
      .where(eq(modelDeployments.id, deploymentId));
    expectDenial(
      await fixture.resolver.resolve(resolveInput(fixture.organizationId)),
      "model_unavailable"
    );

    await fixture.db
      .update(modelDeployments)
      .set({ capabilities: { maxOutputTokens: 4096 } })
      .where(eq(modelDeployments.id, deploymentId));
    expect((await fixture.resolver.resolve(resolveInput(fixture.organizationId))).outcome)
      .toBe("resolved");
  });

  it("filters every disabled resource before returning a target", async () => {
    const fixture = await setup("org_resolution_disabled");
    client = fixture.client;
    const workspaceId = defaultWorkspaceId(fixture.organizationId);
    const profileId = `${workspaceId}:access-profile:opendoor-engineer`;
    const logicalModelId = `${workspaceId}:logical-model:fable`;
    const deploymentId = `${workspaceId}:deployment:anthropic:claude-fable-5`;
    const connectionId = `${workspaceId}:connection:anthropic`;
    const bindingId = `${deploymentId}:wire:anthropic-messages`;
    const canonicalModelId = `${workspaceId}:canonical:anthropic:claude-fable-5`;
    const targetId = (await fixture.db
      .select({ id: logicalModelTargets.id })
      .from(logicalModelTargets)
      .where(eq(logicalModelTargets.logicalModelId, logicalModelId))
      .limit(1))[0]?.id;
    expect(targetId).toBeTruthy();

    await fixture.db.update(accessProfiles).set({ status: "disabled" }).where(eq(accessProfiles.id, profileId));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId)), "access_profile_inactive");
    await fixture.db.update(accessProfiles).set({ status: "active" }).where(eq(accessProfiles.id, profileId));

    await fixture.db
      .update(accessProfileModelGrants)
      .set({ enabled: false })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, profileId),
        eq(accessProfileModelGrants.logicalModelId, logicalModelId)
      ));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId)), "model_access_denied");
    await fixture.db
      .update(accessProfileModelGrants)
      .set({ enabled: true })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, profileId),
        eq(accessProfileModelGrants.logicalModelId, logicalModelId)
      ));

    await fixture.db.update(logicalModels).set({ status: "disabled" }).where(eq(logicalModels.id, logicalModelId));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId)), "model_inactive");
    await fixture.db.update(logicalModels).set({ status: "active" }).where(eq(logicalModels.id, logicalModelId));

    await fixture.db.update(logicalModelTargets).set({ enabled: false }).where(eq(logicalModelTargets.id, targetId!));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId)), "model_unavailable");
    await fixture.db.update(logicalModelTargets).set({ enabled: true }).where(eq(logicalModelTargets.id, targetId!));

    await fixture.db.update(modelDeployments).set({ status: "disabled" }).where(eq(modelDeployments.id, deploymentId));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId)), "model_unavailable");
    await fixture.db.update(modelDeployments).set({ status: "active" }).where(eq(modelDeployments.id, deploymentId));

    await fixture.db.update(canonicalModels).set({ status: "disabled" }).where(eq(canonicalModels.id, canonicalModelId));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId)), "model_unavailable");
    await fixture.db.update(canonicalModels).set({ status: "active" }).where(eq(canonicalModels.id, canonicalModelId));

    await fixture.db.update(providerConnections).set({ status: "disabled" }).where(eq(providerConnections.id, connectionId));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId)), "model_unavailable");
    await fixture.db.update(providerConnections).set({ status: "active" }).where(eq(providerConnections.id, connectionId));

    await fixture.db.update(deploymentWireBindings).set({ enabled: false }).where(eq(deploymentWireBindings.id, bindingId));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId)), "model_unavailable");
  });

  it("limits Bedrock stream-permission health to streaming requests", async () => {
    const fixture = await setup("org_resolution_stream_health");
    client = fixture.client;
    const workspaceId = defaultWorkspaceId(fixture.organizationId);
    const deploymentId = `${workspaceId}:deployment:anthropic:claude-fable-5`;
    const providerConnectionId = `${workspaceId}:connection:anthropic`;
    await fixture.db.insert(deploymentHealth).values({
      id: "deployment_health_stream_permission",
      organizationId: fixture.organizationId,
      workspaceId,
      deploymentId,
      providerConnectionId,
      status: "terminal",
      lastErrorType: "model_access_denied",
      metadata: { bedrockErrorKind: "stream_permission_denied" }
    });

    expect((await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      isStreaming: false
    }))).outcome).toBe("resolved");
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      isStreaming: true
    })), "model_unavailable");

    await fixture.db.update(deploymentHealth).set({ metadata: {} })
      .where(eq(deploymentHealth.deploymentId, deploymentId));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      isStreaming: false
    })), "model_unavailable");
  });

  it("rejects incompatible wires and direct models with multiple eligible targets", async () => {
    const fixture = await setup("org_resolution_eligibility");
    client = fixture.client;
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      ingressWireId: "bedrock-converse"
    })), "model_unavailable");
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      ingressWireId: "openai-responses",
      transport: "websocket"
    })), "model_unavailable");
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      ingressWireId: "openai-responses",
      hasPreviousResponseId: true
    })), "model_unavailable");
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      ingressWireId: "openai-responses",
      unsupportedFields: ["previous_response_id"]
    })), "model_unavailable");
    const workspaceId = defaultWorkspaceId(fixture.organizationId);
    const [openaiDeployment] = await fixture.db
      .select({ id: modelDeployments.id })
      .from(modelDeployments)
      .where(and(
        eq(modelDeployments.workspaceId, workspaceId),
        eq(modelDeployments.upstreamModelId, "gpt-5.4-mini")
      ))
      .limit(1);
    expect(openaiDeployment).toBeTruthy();
    const chatDirectId = `${workspaceId}:logical-model:chat-direct`;
    await fixture.db.insert(logicalModels).values({
      id: chatDirectId,
      organizationId: fixture.organizationId,
      workspaceId,
      slug: "chat-direct",
      name: "Chat Direct",
      resolutionKind: "direct",
      status: "active"
    });
    await fixture.db.insert(logicalModelTargets).values({
      id: "target_chat_direct",
      organizationId: fixture.organizationId,
      workspaceId,
      logicalModelId: chatDirectId,
      deploymentId: openaiDeployment!.id,
      priority: 0,
      enabled: true
    });
    await fixture.db.insert(accessProfileModelGrants).values({
      id: "grant_chat_direct",
      organizationId: fixture.organizationId,
      workspaceId,
      accessProfileId: `${workspaceId}:access-profile:opendoor-engineer`,
      logicalModelId: chatDirectId,
      allowedOperations: ["text.generate"],
      enabled: true
    });
    await fixture.db
      .update(deploymentWireBindings)
      .set({ enabled: false })
      .where(and(
        eq(deploymentWireBindings.deploymentId, openaiDeployment!.id),
        eq(deploymentWireBindings.apiWireId, "openai-responses")
      ));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      ingressWireId: "openai-responses",
      requestedModel: "chat-direct",
      statefulResponses: true
    })), "model_unavailable");
    await fixture.db
      .update(deploymentWireBindings)
      .set({ enabled: true })
      .where(eq(deploymentWireBindings.deploymentId, openaiDeployment!.id));

    await fixture.db.insert(logicalModelTargets).values({
      id: "target_fable_second",
      organizationId: fixture.organizationId,
      workspaceId,
      logicalModelId: `${workspaceId}:logical-model:fable`,
      deploymentId: openaiDeployment!.id,
      priority: 1,
      enabled: true
    });

    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      ingressWireId: "anthropic-messages"
    })), "direct_target_count_invalid");
  });

  it("cannot substitute API keys across organization or workspace scope", async () => {
    const fixture = await setup("org_resolution_scope_a");
    client = fixture.client;
    await fixture.db.insert(workspaces).values({
      id: "workspace_resolution_scope_a_secondary",
      organizationId: fixture.organizationId,
      slug: "secondary",
      name: "Secondary"
    });
    expectDenial(await fixture.resolver.resolve({
      ...resolveInput(fixture.organizationId),
      workspaceId: "workspace_resolution_scope_a_secondary"
    }), "api_key_not_found");
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_resolution_scope_b",
      SEED_USER_ID: "user_resolution_scope_b",
      SEED_USER_EMAIL: "scope-b@example.com",
      PROXY_TOKEN: "resolution-scope-b-token"
    }));

    expectDenial(await fixture.resolver.resolve({
      ...resolveInput(fixture.organizationId),
      apiKeyId: "org_resolution_scope_b:api-key:default"
    }), "api_key_not_found");
    expectDenial(await fixture.resolver.resolve({
      ...resolveInput(fixture.organizationId),
      workspaceId: defaultWorkspaceId("org_resolution_scope_b")
    }), "api_key_not_found");
    expect((await fixture.resolver.resolve(resolveInput("org_resolution_scope_b"))).outcome).toBe("resolved");
  });

  it("denies revoked, expired, exactly expired, and profile-less keys", async () => {
    const fixture = await setup("org_resolution_key_lifecycle");
    client = fixture.client;
    const keyId = `${fixture.organizationId}:api-key:default`;
    const now = new Date("2026-07-15T12:00:00.000Z");
    const resolver = new ModelResolutionService(fixture.db, { now: () => now });

    await fixture.db.update(apiKeys).set({ revokedAt: now }).where(eq(apiKeys.id, keyId));
    expectDenial(await resolver.resolve(resolveInput(fixture.organizationId)), "api_key_inactive");

    await fixture.db
      .update(apiKeys)
      .set({ revokedAt: null, expiresAt: new Date(now.getTime() - 1) })
      .where(eq(apiKeys.id, keyId));
    expectDenial(await resolver.resolve(resolveInput(fixture.organizationId)), "api_key_inactive");

    await fixture.db.update(apiKeys).set({ expiresAt: now }).where(eq(apiKeys.id, keyId));
    expectDenial(await resolver.resolve(resolveInput(fixture.organizationId)), "api_key_inactive");

    await fixture.db
      .update(apiKeys)
      .set({ expiresAt: null, accessProfileId: null })
      .where(eq(apiKeys.id, keyId));
    expectDenial(await resolver.resolve(resolveInput(fixture.organizationId)), "access_profile_missing");
  });

  it("fails closed when no classifier runtime is installed", async () => {
    const fixture = await setup("org_resolution_router");
    client = fixture.client;
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      requestedModel: "coding-auto"
    })), "classifier_unavailable");
  });
});

async function setup(organizationId: string, env: NodeJS.ProcessEnv = {}) {
  const client = await migratedClient();
  const db = createPgliteDatabase(client);
  await seedDatabase(db, seedOptionsFromEnv({
    DEFAULT_ORGANIZATION_ID: organizationId,
    SEED_USER_ID: `user_${organizationId}`,
    PROXY_TOKEN: `token_${organizationId}`,
    ...env
  }));
  return {
    client,
    db,
    resolver: new ModelResolutionService(db),
    organizationId
  };
}

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  return client;
}

function resolveInput(
  organizationId: string,
  overrides: Partial<Parameters<ModelResolutionService["resolve"]>[0]> = {}
) {
  return {
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    apiKeyId: `${organizationId}:api-key:default`,
    ingressWireId: "anthropic-messages" as const,
    operationId: "text.generate" as const,
    requestedModel: "fable",
    ...overrides
  };
}

function expectDenial(result: ModelResolutionResult, code: ModelResolutionDenialCode) {
  expect(result).toEqual(expect.objectContaining({ outcome: "denied", code }));
}
