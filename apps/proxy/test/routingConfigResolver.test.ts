import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPgliteDatabase,
  defaultWorkspaceId,
  organizationSettings,
  routingConfigs,
  routingConfigVersions
} from "@prompt-proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@prompt-proxy/db/seed";

import { buildModelCatalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";

describe("routing config resolver guardrails", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("resolves a newly activated routing config version on the next lookup", async () => {
    const fixture = await setup("org_activation_guardrail");
    await seed(fixture, "org_activation_guardrail", "seed_activation_guardrail_user", "seeded-activation-guardrail-token");
    const configId = "org_activation_guardrail:routing-config:default";
    const first = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_activation_guardrail",
      workspaceId: defaultWorkspaceId("org_activation_guardrail"),
      routingConfigId: null
    });
    const firstVersion = await activeVersion(fixture, first.versionId);
    const secondVersionId = `${configId}:v2`;
    await fixture.db.insert(routingConfigVersions).values({
      id: secondVersionId,
      organizationId: "org_activation_guardrail",
      workspaceId: defaultWorkspaceId("org_activation_guardrail"),
      routingConfigId: configId,
      version: 2,
      configHash: "sha256:activated-routing-config",
      config: {
        ...firstVersion.config,
        displayName: "Activated routing config",
        classifier: {
          ...firstVersion.config.classifier,
          model: "route-classifier-after-activation"
        }
      },
      status: "draft",
      createdByUserId: "seed_activation_guardrail_user"
    });

    await fixture.persistence.routingConfigAdmin.activateVersion({
      organizationId: "org_activation_guardrail",
      workspaceId: defaultWorkspaceId("org_activation_guardrail"),
      actorUserId: "seed_activation_guardrail_user",
      configId,
      versionId: secondVersionId
    });
    const second = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_activation_guardrail",
      workspaceId: defaultWorkspaceId("org_activation_guardrail"),
      routingConfigId: null
    });

    expect(first.version).toBe(1);
    expect(second).toEqual(expect.objectContaining({
      configId,
      versionId: secondVersionId,
      version: 2,
      configHash: "sha256:activated-routing-config"
    }));
    expect(second.config.classifier.model).toBe("route-classifier-after-activation");
  });

  it("resolves API key assignment changes on the next lookup", async () => {
    const fixture = await setup("org_assignment_guardrail");
    await seed(fixture, "org_assignment_guardrail", "seed_assignment_guardrail_user", "seeded-assignment-guardrail-token");
    const defaultConfigId = "org_assignment_guardrail:routing-config:default";
    const assignedConfigId = "org_assignment_guardrail:routing-config:assigned";
    const assignedVersionId = `${assignedConfigId}:v1`;
    const defaultVersion = await activeVersion(fixture, `${defaultConfigId}:v1`);
    await fixture.db.insert(routingConfigs).values({
      id: assignedConfigId,
      organizationId: "org_assignment_guardrail",
      workspaceId: defaultWorkspaceId("org_assignment_guardrail"),
      name: "Assigned guardrail config",
      slug: "assigned-guardrail",
      status: "active"
    });
    await fixture.db.insert(routingConfigVersions).values({
      id: assignedVersionId,
      organizationId: "org_assignment_guardrail",
      workspaceId: defaultWorkspaceId("org_assignment_guardrail"),
      routingConfigId: assignedConfigId,
      version: 1,
      configHash: "sha256:assigned-guardrail-config",
      config: {
        ...defaultVersion.config,
        displayName: "Assigned guardrail router"
      },
      status: "active",
      createdByUserId: "seed_assignment_guardrail_user",
      activatedAt: new Date("2026-06-08T00:00:00.000Z")
    });
    await fixture.db
      .update(routingConfigs)
      .set({ activeVersionId: assignedVersionId })
      .where(eq(routingConfigs.id, assignedConfigId));

    await fixture.persistence.routingConfigAdmin.assignApiKeyRoutingConfig({
      organizationId: "org_assignment_guardrail",
      workspaceId: defaultWorkspaceId("org_assignment_guardrail"),
      actorUserId: "seed_assignment_guardrail_user",
      apiKeyId: "org_assignment_guardrail:api-key:default",
      body: { routingConfigId: assignedConfigId }
    });
    const assignedIdentity = await fixture.persistence.apiKeys.resolve("seeded-assignment-guardrail-token");
    const assigned = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_assignment_guardrail",
      workspaceId: defaultWorkspaceId("org_assignment_guardrail"),
      routingConfigId: assignedIdentity?.routingConfigId
    });

    await fixture.persistence.routingConfigAdmin.assignApiKeyRoutingConfig({
      organizationId: "org_assignment_guardrail",
      workspaceId: defaultWorkspaceId("org_assignment_guardrail"),
      actorUserId: "seed_assignment_guardrail_user",
      apiKeyId: "org_assignment_guardrail:api-key:default",
      body: { routingConfigId: null }
    });
    const clearedIdentity = await fixture.persistence.apiKeys.resolve("seeded-assignment-guardrail-token");
    const cleared = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_assignment_guardrail",
      workspaceId: defaultWorkspaceId("org_assignment_guardrail"),
      routingConfigId: clearedIdentity?.routingConfigId
    });

    expect(assigned.configId).toBe(assignedConfigId);
    expect(assigned.configHash).toBe("sha256:assigned-guardrail-config");
    expect(clearedIdentity?.routingConfigId).toBeNull();
    expect(cleared.configId).toBe(defaultConfigId);
    expect(cleared.versionId).toBe(`${defaultConfigId}:v1`);
  });

  it("returns the organization system prompt alongside resolved configs", async () => {
    const fixture = await setup("org_resolver_system_prompt");
    await seed(fixture, "org_resolver_system_prompt", "seed_resolver_prompt_user", "seeded-resolver-prompt-token");
    const configId = "org_resolver_system_prompt:routing-config:default";

    const before = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_resolver_system_prompt",
      workspaceId: defaultWorkspaceId("org_resolver_system_prompt"),
      routingConfigId: null
    });

    await fixture.db
      .update(organizationSettings)
      .set({ systemPrompt: "Follow organization proxy policy." })
      .where(eq(organizationSettings.organizationId, "org_resolver_system_prompt"));
    const pinnedWithPrompt = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_resolver_system_prompt",
      workspaceId: defaultWorkspaceId("org_resolver_system_prompt"),
      routingConfigId: configId
    });

    await fixture.db
      .delete(organizationSettings)
      .where(eq(organizationSettings.organizationId, "org_resolver_system_prompt"));
    const pinnedWithoutRow = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_resolver_system_prompt",
      workspaceId: defaultWorkspaceId("org_resolver_system_prompt"),
      routingConfigId: configId
    });

    expect(before.organizationSystemPrompt).toBeUndefined();
    expect(pinnedWithPrompt.configId).toBe(configId);
    expect(pinnedWithPrompt.organizationSystemPrompt).toBe("Follow organization proxy policy.");
    expect(pinnedWithoutRow.configId).toBe(configId);
    expect(pinnedWithoutRow.organizationSystemPrompt).toBeUndefined();
  });

  async function setup(organizationId: string) {
    client = new PGlite();
    const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
    const migrationFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of migrationFiles) {
      await client.exec(await readFile(join(migrationsDir, file), "utf8"));
    }
    const db = createPgliteDatabase(client);
    const config = loadConfig({
      ...process.env,
      DEFAULT_ORGANIZATION_ID: organizationId,
      OPENAI_HARD_MODEL: "gpt-routed-hard-test",
      MODEL_COSTS_JSON: JSON.stringify({ "gpt-routed-hard-test": { inputCostPerMtok: 2, outputCostPerMtok: 10 } })
    });
    const catalog = buildModelCatalog(config);
    const persistence = createDatabasePersistence(db, catalog, config, false);
    return { db, persistence };
  }

  async function seed(
    fixture: Awaited<ReturnType<typeof setup>>,
    organizationId: string,
    userId: string,
    proxyToken: string
  ) {
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: organizationId,
      SEED_USER_ID: userId,
      PROMPT_PROXY_TOKEN: proxyToken
    }));
  }

  async function activeVersion(
    fixture: Awaited<ReturnType<typeof setup>>,
    versionId: string
  ) {
    const [version] = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.id, versionId))
      .limit(1);
    expect(version).toBeTruthy();
    return version!;
  }
});
