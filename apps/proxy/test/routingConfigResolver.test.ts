import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPgliteDatabase,
  defaultWorkspaceId,
  routingConfigs,
  routingConfigVersions
} from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";

import { loadConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import { RoutingConfigResolver } from "../src/persistence/routingConfig.js";

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

  it("caches routing config resolution until the TTL expires", async () => {
    const fixture = await setup("org_resolver_cache");
    await seed(fixture, "org_resolver_cache", "seed_resolver_cache_user", "seeded-resolver-cache-token");
    const configId = "org_resolver_cache:routing-config:default";
    const workspaceId = defaultWorkspaceId("org_resolver_cache");
    let nowMs = 1_000;
    const resolver = new RoutingConfigResolver(fixture.db, {
      cacheTtlMs: 1_000,
      nowMs: () => nowMs
    });

    const first = await resolver.resolve({
      organizationId: "org_resolver_cache",
      workspaceId,
      routingConfigId: null
    });
    const originalDisplayName = first.config.displayName;
    first.config.displayName = "Mutated response should not leak into cache";
    const cachedClone = await resolver.resolve({
      organizationId: "org_resolver_cache",
      workspaceId,
      routingConfigId: null
    });

    const firstVersion = await activeVersion(fixture, first.versionId);
    const secondVersionId = `${configId}:v2`;
    await fixture.db.insert(routingConfigVersions).values({
      id: secondVersionId,
      organizationId: "org_resolver_cache",
      workspaceId,
      routingConfigId: configId,
      version: 2,
      configHash: "sha256:routing-cache-v2",
      config: {
        ...firstVersion.config,
        displayName: "TTL refreshed routing config",
        classifier: {
          ...firstVersion.config.classifier,
          model: "route-classifier-after-cache-ttl"
        }
      },
      status: "active",
      createdByUserId: "seed_resolver_cache_user",
      activatedAt: new Date("2026-06-08T00:00:00.000Z")
    });
    await fixture.db
      .update(routingConfigs)
      .set({ activeVersionId: secondVersionId })
      .where(eq(routingConfigs.id, configId));

    const stale = await resolver.resolve({
      organizationId: "org_resolver_cache",
      workspaceId,
      routingConfigId: null
    });
    nowMs = 2_001;
    const refreshed = await resolver.resolve({
      organizationId: "org_resolver_cache",
      workspaceId,
      routingConfigId: null
    });

    expect(cachedClone.config.displayName).toBe(originalDisplayName);
    expect(stale).toEqual(expect.objectContaining({
      versionId: first.versionId,
      version: 1,
      configHash: first.configHash
    }));
    expect(refreshed).toEqual(expect.objectContaining({
      versionId: secondVersionId,
      version: 2,
      configHash: "sha256:routing-cache-v2"
    }));
    expect(refreshed.config.classifier.model).toBe("route-classifier-after-cache-ttl");
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
      routingConfigId: configId
    });

    await fixture.persistence.organizationSettings.setSystemPrompt(
      "org_resolver_system_prompt",
      "Follow organization proxy policy."
    );
    const pinnedWithPrompt = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_resolver_system_prompt",
      workspaceId: defaultWorkspaceId("org_resolver_system_prompt"),
      routingConfigId: configId
    });

    await fixture.persistence.organizationSettings.setSystemPrompt("org_resolver_system_prompt", null);
    const pinnedWithoutPrompt = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_resolver_system_prompt",
      workspaceId: defaultWorkspaceId("org_resolver_system_prompt"),
      routingConfigId: configId
    });
    await fixture.persistence.organizationSettings.setAutomaticCaching("org_resolver_system_prompt", true);
    const withAutomaticCaching = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_resolver_system_prompt",
      workspaceId: defaultWorkspaceId("org_resolver_system_prompt"),
      routingConfigId: configId
    });
    await fixture.persistence.organizationSettings.setAutomaticCaching("org_resolver_system_prompt", false);
    const withoutAutomaticCaching = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_resolver_system_prompt",
      workspaceId: defaultWorkspaceId("org_resolver_system_prompt"),
      routingConfigId: configId
    });

    expect(before.organizationSystemPrompt).toBeUndefined();
    expect(pinnedWithPrompt.configId).toBe(configId);
    expect(pinnedWithPrompt.organizationSystemPrompt).toBe("Follow organization proxy policy.");
    expect(pinnedWithoutPrompt.configId).toBe(configId);
    expect(pinnedWithoutPrompt.organizationSystemPrompt).toBeUndefined();
    expect(withAutomaticCaching.automaticCaching).toBe(true);
    expect(withoutAutomaticCaching.automaticCaching).toBe(false);
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
    const persistence = createDatabasePersistence(db, config, false);
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
      PROXY_TOKEN: proxyToken
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
