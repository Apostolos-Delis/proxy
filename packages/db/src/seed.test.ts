import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
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
  providerAccounts,
  routePolicies,
  routingConfigs,
  routingConfigVersions,
  users
} from "./schema.js";
import { seedDatabase, seedOptionsFromEnv } from "./seed.js";

describe("database seed", () => {
  it("creates local organization, user, providers, models, routing config, API key, and policy idempotently", async () => {
    const client = new PGlite();
    const migration = await readFile(
      fileURLToPath(new URL("../migrations/0000_foundation.sql", import.meta.url)),
      "utf8"
    );
    await client.exec(migration);
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
    const providerRows = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.organizationId, "org_seed"));
    const modelRows = await db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.organizationId, "org_seed"));
    const policyRows = await db
      .select()
      .from(routePolicies)
      .where(eq(routePolicies.organizationId, "org_seed"));
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
    const sandboxOrgRows = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, "org_seed-sandbox"));
    const sandboxMemberRows = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, "org_seed-sandbox"));
    await client.close();

    expect(orgRows).toHaveLength(1);
    expect(userRows[0]?.email).toBe("seed@example.com");
    expect(memberRows).toHaveLength(1);
    expect(sandboxOrgRows).toHaveLength(1);
    expect(sandboxOrgRows[0]?.name).toBe("org_seed Sandbox");
    expect(sandboxMemberRows).toEqual([
      expect.objectContaining({ userId: "user_seed", role: "owner", status: "active" })
    ]);
    expect(providerRows).toHaveLength(2);
    expect(modelRows).toHaveLength(7);
    expect(policyRows[0]?.name).toBe("default");
    expect(settingsRows[0]?.defaultRoutingConfigId).toBe("org_seed:routing-config:default");
    expect(routingConfigRows).toHaveLength(1);
    expect(routingConfigRows[0]?.activeVersionId).toBe("org_seed:routing-config:default:v1");
    expect(routingConfigVersionRows).toHaveLength(1);
    expect(routingConfigVersionRows[0]?.version).toBe(1);
    expect(routingConfigVersionRows[0]?.status).toBe("active");
    expect(routingConfigVersionRows[0]?.config).toEqual(expect.objectContaining({
      schemaVersion: 1,
      classifier: expect.objectContaining({
        model: options.classifierModel,
        allowRedactedExcerpt: false
      }),
      routes: expect.objectContaining({
        fast: expect.objectContaining({
          openai: expect.objectContaining({
            model: "gpt-5.4-mini"
          }),
          anthropic: expect.objectContaining({
            model: "claude-haiku-4-5"
          })
        }),
        hard: expect.objectContaining({
          anthropic: expect.objectContaining({
            model: "claude-sonnet-seed"
          })
        })
      })
    }));
    const seededConfig = routingConfigVersionRows[0]?.config as RoutingConfig;
    expect(seededConfig.classifier.rules).toBeUndefined();
    expect(seededConfig.routes.hard.anthropic?.output_config).toBeUndefined();
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]?.routingConfigId).toBe("org_seed:routing-config:default");
    expect(keyRows[0]?.userId).toBeNull();
    expect(keyRows[0]?.scopes).toEqual(["proxy", "admin", "harness_identity"]);
    expect(keyRows[0]?.keyHash).not.toBe("seed-proxy-token");
    expect(keyRows[0]?.keyHash).toBe(hashApiKey("seed-proxy-token"));
    expect(keyRows[0]?.keyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("does not mutate seeded active version one on rerun", async () => {
    const client = new PGlite();
    const migration = await readFile(
      fileURLToPath(new URL("../migrations/0000_foundation.sql", import.meta.url)),
      "utf8"
    );
    await client.exec(migration);
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
          openai: expect.objectContaining({
            model: "gpt-initial-fast"
          })
        })
      })
    }));
  });

  it("does not reactivate v1 when a later version is active", async () => {
    const client = new PGlite();
    const migration = await readFile(
      fileURLToPath(new URL("../migrations/0000_foundation.sql", import.meta.url)),
      "utf8"
    );
    await client.exec(migration);
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
    const client = new PGlite();
    const migration = await readFile(
      fileURLToPath(new URL("../migrations/0000_foundation.sql", import.meta.url)),
      "utf8"
    );
    await client.exec(migration);
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
      routingConfigId: "org_replace_seed:routing-config:default",
      version: 2,
      configHash: "sha256:manual-v2",
      config: {
        ...v1Config,
        schemaVersion: 1,
        displayName: "Manual",
        description: "Manual active version",
        classifier: {
          ...v1Config.classifier,
          model: "manual"
        }
      } as RoutingConfig,
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
    expect(version?.config.routes.fast.openai?.model).toBe("gpt-replaced-fast");
    expect(version?.config.classifier.timeoutMs).toBe(30000);
  });

  it("fails before partial writes when another organization already owns the proxy token", async () => {
    const client = new PGlite();
    const migration = await readFile(
      fileURLToPath(new URL("../migrations/0000_foundation.sql", import.meta.url)),
      "utf8"
    );
    await client.exec(migration);
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
