import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createPgliteDatabase } from "./client.js";
import {
  modelCatalog,
  organizationMembers,
  organizations,
  providerAccounts,
  routePolicies,
  users
} from "./schema.js";
import { seedDatabase, seedOptionsFromEnv } from "./seed.js";

describe("database seed", () => {
  it("creates local organization, user, providers, models, and policy idempotently", async () => {
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
      ANTHROPIC_HARD_MODEL: "claude-sonnet-seed"
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
    await client.close();

    expect(orgRows).toHaveLength(1);
    expect(userRows[0]?.email).toBe("seed@example.com");
    expect(memberRows).toHaveLength(1);
    expect(providerRows).toHaveLength(2);
    expect(modelRows).toHaveLength(7);
    expect(policyRows[0]?.name).toBe("default");
  });
});
