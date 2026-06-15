import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { RoutingConfig } from "@prompt-proxy/schema";

import { hashApiKey } from "./apiKeyHash.js";
import { createPgliteDatabase } from "./client.js";
import {
  apiKeys,
  modelCatalog,
  organizationMembers,
  organizationSettings,
  organizations,
  providers,
  providerAccounts,
  routingConfigs,
  routingConfigVersions,
  users,
  workspaces
} from "./schema.js";
import { seedDatabase, seedOptionsFromEnv } from "./seed.js";
import { defaultWorkspaceId } from "./workspace.js";

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  }
  return client;
}

describe("database seed", () => {
  it("creates local organization, user, providers, models, routing config, and API key idempotently", async () => {
    const client = await migratedClient();
    const db = createPgliteDatabase(client);
    const options = seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_seed",
      SEED_USER_ID: "user_seed",
      SEED_USER_EMAIL: "seed@example.com",
      SEED_USER_NAME: "Seed User",
      ANTHROPIC_BALANCED_MODEL: "claude-sonnet-seed",
      ANTHROPIC_HARD_MODEL: "claude-sonnet-seed",
      PROMPT_PROXY_TOKEN: "seed-proxy-token"
    });

    await seedDatabase(db, options);
    await seedDatabase(db, options);

    const orgRows = await db.select().from(organizations).where(eq(organizations.id, "org_seed"));
    const userRows = await db.select().from(users).where(eq(users.id, "user_seed"));
    const memberRows = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, "org_seed"));
    const providerAccountRows = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.organizationId, "org_seed"));
    const registryProviderRows = await db
      .select()
      .from(providers)
      .where(isNull(providers.organizationId));
    const modelRows = await db
      .select()
      .from(modelCatalog)
      .where(isNull(modelCatalog.organizationId));
    const settingsRows = await db
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, "org_seed"));
    const routingConfigRows = await db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.organizationId, "org_seed"));
    const routingConfigVersionRows = await db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.organizationId, "org_seed"));
    const keyRows = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.organizationId, "org_seed"));
    const workspaceRows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.organizationId, "org_seed"));
    const sandboxOrgRows = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, "org_seed-sandbox"));
    const sandboxMemberRows = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, "org_seed-sandbox"));
    const sandboxWorkspaceRows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.organizationId, "org_seed-sandbox"));
    await expect(db.insert(providers).values({
      id: "00000000-0000-0000-0000-000000000099",
      organizationId: null,
      slug: "openai",
      displayName: "Duplicate OpenAI",
      baseUrl: "https://duplicate.example/v1",
      authStyle: "bearer",
      endpoints: [{ dialect: "openai-responses", path: "/responses" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    })).rejects.toThrow();
    await client.close();

    expect(orgRows).toHaveLength(1);
    expect(userRows[0]?.email).toBe("seed@example.com");
    expect(memberRows).toHaveLength(1);
    expect(sandboxOrgRows).toHaveLength(1);
    expect(sandboxOrgRows[0]?.name).toBe("org_seed Sandbox");
    expect(sandboxMemberRows).toEqual([
      expect.objectContaining({ userId: "user_seed", role: "owner", status: "active" })
    ]);
    expect(providerAccountRows).toHaveLength(2);
    expect(registryProviderRows).toHaveLength(2);
    expect(registryProviderRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "00000000-0000-0000-0000-000000000001",
        slug: "openai",
        baseUrl: "https://api.openai.com/v1",
        authStyle: "bearer",
        endpoints: [
          { dialect: "openai-responses", path: "/responses" },
          { dialect: "openai-chat", path: "/chat/completions" }
        ],
        capabilities: { efforts: ["low", "medium", "high", "xhigh"] },
        forwardHarnessHeaders: true,
        enabled: true
      }),
      expect.objectContaining({
        id: "00000000-0000-0000-0000-000000000002",
        slug: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        authStyle: "x-api-key",
        endpoints: [
          { dialect: "anthropic-messages", path: "/messages" }
        ],
        capabilities: { efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
        forwardHarnessHeaders: true,
        enabled: true
      })
    ]));
    expect(modelRows).toHaveLength(15);
    expect(modelRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: "00000000-0000-0000-0000-000000000001",
        model: "gpt-5.4-mini",
        capabilities: expect.objectContaining({
          source: "models.dev-snapshot",
          surfaces: ["openai-responses", "openai-chat"],
          routes: ["fast"]
        }),
        pricing: expect.objectContaining({
          inputCostPerMtok: 0.25,
          outputCostPerMtok: 2
        })
      }),
      expect.objectContaining({
        providerId: "00000000-0000-0000-0000-000000000002",
        model: "claude-sonnet-seed",
        capabilities: expect.objectContaining({
          routes: ["balanced", "hard"],
          seeded: true
        })
      })
    ]));
    expect(settingsRows[0]?.promptCaptureMode).toBe("raw_text");
    expect(workspaceRows).toEqual([
      expect.objectContaining({
        id: defaultWorkspaceId("org_seed"),
        slug: "default",
        name: "Default",
        defaultRoutingConfigId: "org_seed:routing-config:default"
      })
    ]);
    expect(sandboxWorkspaceRows).toEqual([
      expect.objectContaining({ id: defaultWorkspaceId("org_seed-sandbox"), slug: "default" })
    ]);
    expect(routingConfigRows).toHaveLength(1);
    expect(routingConfigRows[0]?.workspaceId).toBe(defaultWorkspaceId("org_seed"));
    expect(routingConfigRows[0]?.activeVersionId).toBe("org_seed:routing-config:default:v1");
    expect(routingConfigVersionRows).toHaveLength(1);
    expect(routingConfigVersionRows[0]?.version).toBe(1);
    expect(routingConfigVersionRows[0]?.status).toBe("active");
    expect(routingConfigVersionRows[0]?.config).toEqual(expect.objectContaining({
      schemaVersion: 2,
      classifier: expect.objectContaining({
        model: options.classifierModel,
        allowRedactedExcerpt: false
      }),
      routes: expect.objectContaining({
        fast: expect.objectContaining({
          targets: expect.arrayContaining([
            expect.objectContaining({ providerId: "openai", model: "gpt-5.4-mini" }),
            expect.objectContaining({ providerId: "anthropic", model: "claude-haiku-4-5" })
          ])
        }),
        hard: expect.objectContaining({
          targets: expect.arrayContaining([
            expect.objectContaining({ providerId: "anthropic", model: "claude-sonnet-seed" })
          ])
        })
      })
    }));
    const seededConfig = routingConfigVersionRows[0]?.config as RoutingConfig;
    expect(seededConfig.classifier.rules).toBeUndefined();
    expect(seededConfig.routes.fast.targets.find((target) => target.providerId === "anthropic")?.thinking).toBeUndefined();
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]?.workspaceId).toBe(defaultWorkspaceId("org_seed"));
    expect(keyRows[0]?.routingConfigId).toBe("org_seed:routing-config:default");
    expect(keyRows[0]?.userId).toBe("user_seed");
    expect(keyRows[0]?.scopes).toEqual(["proxy", "admin"]);
    expect(keyRows[0]?.keyHash).not.toBe("seed-proxy-token");
    expect(keyRows[0]?.keyHash).toBe(hashApiKey("seed-proxy-token"));
    expect(keyRows[0]?.keyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("does not mutate seeded active version one on rerun", async () => {
    const client = await migratedClient();
    const db = createPgliteDatabase(client);
    const initialOptions = seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_immutable_seed",
      SEED_USER_ID: "user_seed",
      OPENAI_FAST_MODEL: "gpt-initial-fast"
    });
    const changedOptions = seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_immutable_seed",
      SEED_USER_ID: "user_seed",
      OPENAI_FAST_MODEL: "gpt-changed-fast"
    });

    await seedDatabase(db, initialOptions);
    await seedDatabase(db, changedOptions);

    const [version] = await db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.id, "org_immutable_seed:routing-config:default:v1"));
    await client.close();

    expect(version?.config).toEqual(expect.objectContaining({
      routes: expect.objectContaining({
        fast: expect.objectContaining({
          targets: expect.arrayContaining([
            expect.objectContaining({ providerId: "openai", model: "gpt-initial-fast" })
          ])
        })
      })
    }));
  });

  it("does not reactivate v1 when a later version is active", async () => {
    const client = await migratedClient();
    const db = createPgliteDatabase(client);
    const options = seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_active_seed",
      SEED_USER_ID: "user_seed"
    });

    await seedDatabase(db, options);
    const [v1] = await db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.id, "org_active_seed:routing-config:default:v1"));
    const v2Config: RoutingConfig = {
      ...(v1?.config as RoutingConfig),
      description: "Manual active version"
    };
    await db.insert(routingConfigVersions).values({
      id: "org_active_seed:routing-config:default:v2",
      organizationId: "org_active_seed",
      workspaceId: defaultWorkspaceId("org_active_seed"),
      routingConfigId: "org_active_seed:routing-config:default",
      version: 2,
      configHash: "sha256:manual-v2",
      config: v2Config,
      status: "active",
      createdByUserId: "user_seed",
      activatedAt: new Date("2026-06-08T00:00:00.000Z")
    });
    await db
      .update(routingConfigs)
      .set({ activeVersionId: "org_active_seed:routing-config:default:v2" })
      .where(eq(routingConfigs.id, "org_active_seed:routing-config:default"));

    await seedDatabase(db, options);

    const [config] = await db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.id, "org_active_seed:routing-config:default"));
    await client.close();

    expect(config?.activeVersionId).toBe("org_active_seed:routing-config:default:v2");
  });

  it("can explicitly replace and reactivate the seeded routing config version", async () => {
    const client = await migratedClient();
    const db = createPgliteDatabase(client);
    const initialOptions = seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_replace_seed",
      SEED_USER_ID: "user_seed",
      OPENAI_FAST_MODEL: "gpt-initial-fast"
    });
    const replacementOptions = seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_replace_seed",
      SEED_USER_ID: "user_seed",
      OPENAI_FAST_MODEL: "gpt-replaced-fast",
      SEED_REPLACE_ROUTING_CONFIG: "true"
    });

    await seedDatabase(db, initialOptions);
    const [v1] = await db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.id, "org_replace_seed:routing-config:default:v1"));
    const v1Config = v1?.config as RoutingConfig;
    await db.insert(routingConfigVersions).values({
      id: "org_replace_seed:routing-config:default:v2",
      organizationId: "org_replace_seed",
      workspaceId: defaultWorkspaceId("org_replace_seed"),
      routingConfigId: "org_replace_seed:routing-config:default",
      version: 2,
      configHash: "sha256:manual-v2",
      config: {
        ...v1Config,
        displayName: "Manual",
        description: "Manual active version",
        classifier: {
          ...v1Config.classifier,
          model: "manual"
        }
      },
      status: "active",
      createdByUserId: "user_seed",
      activatedAt: new Date("2026-06-08T00:00:00.000Z")
    });
    await db
      .update(routingConfigs)
      .set({ activeVersionId: "org_replace_seed:routing-config:default:v2" })
      .where(eq(routingConfigs.id, "org_replace_seed:routing-config:default"));

    await seedDatabase(db, replacementOptions);

    const [config] = await db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.id, "org_replace_seed:routing-config:default"));
    const [version] = await db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.id, "org_replace_seed:routing-config:default:v1"));
    await client.close();

    expect(config?.activeVersionId).toBe("org_replace_seed:routing-config:default:v1");
    expect(version?.config.routes.fast.targets.find((target) => target.providerId === "openai")?.model).toBe("gpt-replaced-fast");
    expect(version?.config.classifier.timeoutMs).toBe(30000);
  });

  it("fails before partial writes when another organization already owns the proxy token", async () => {
    const client = await migratedClient();
    const db = createPgliteDatabase(client);

    await seedDatabase(db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_token_a",
      SEED_USER_ID: "user_token_a"
    }));
    await expect(seedDatabase(db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_token_b",
      SEED_USER_ID: "user_token_b"
    }))).rejects.toThrow("set a unique PROMPT_PROXY_TOKEN");

    const orgRows = await db.select().from(organizations).where(eq(organizations.id, "org_token_b"));
    await client.close();

    expect(orgRows).toHaveLength(0);
  });
});
