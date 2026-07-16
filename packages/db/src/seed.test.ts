import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { hashApiKey } from "./apiKeyHash.js";
import { createPgliteDatabase } from "./client.js";
import {
  accessProfiles,
  apiKeys,
  organizationMembers,
  organizations,
  users,
  workspaces
} from "./schema.js";
import { seedDatabase, seedOptionsFromEnv } from "./seed.js";
import { defaultWorkspaceId } from "./workspace.js";

describe("database seed", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    const current = client;
    client = undefined;
    await current?.close();
  });

  it("creates the organization, gateway access, and API key idempotently", async () => {
    client = await migratedClient();
    const db = createPgliteDatabase(client);
    const options = seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_seed",
      SEED_USER_ID: "user_seed",
      SEED_USER_EMAIL: "seed@example.com",
      SEED_USER_NAME: "Seed User",
      PROXY_TOKEN: "seed-token"
    });

    await seedDatabase(db, options);
    await seedDatabase(db, options);

    const orgRows = await db.select().from(organizations).where(eq(organizations.id, "org_seed"));
    const userRows = await db.select().from(users).where(eq(users.id, "user_seed"));
    const memberRows = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, "org_seed"));
    const workspaceRows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.organizationId, "org_seed"));
    const keyRows = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.organizationId, "org_seed"));
    const profileRows = await db
      .select()
      .from(accessProfiles)
      .where(eq(accessProfiles.organizationId, "org_seed"));

    expect(orgRows).toHaveLength(1);
    expect(userRows).toEqual([expect.objectContaining({ email: "seed@example.com", name: "Seed User" })]);
    expect(memberRows).toEqual([
      expect.objectContaining({ userId: "user_seed", role: "owner", status: "active" })
    ]);
    expect(workspaceRows).toEqual([
      expect.objectContaining({ id: defaultWorkspaceId("org_seed"), slug: "default", name: "Default" })
    ]);
    expect(profileRows.map((row) => row.slug).sort()).toEqual(["external-economy", "opendoor-engineer"]);
    expect(keyRows).toEqual([
      expect.objectContaining({
        userId: "user_seed",
        keyHash: hashApiKey("seed-token"),
        accessProfileId: `${defaultWorkspaceId("org_seed")}:access-profile:opendoor-engineer`,
        revokedAt: null
      })
    ]);
  });

  it("fails before writing when another organization owns the token", async () => {
    client = await migratedClient();
    const db = createPgliteDatabase(client);
    await seedDatabase(db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_owner",
      SEED_USER_ID: "owner_user",
      PROXY_TOKEN: "shared-token"
    }));

    await expect(seedDatabase(db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_conflict",
      SEED_USER_ID: "conflict_user",
      PROXY_TOKEN: "shared-token"
    }))).rejects.toThrow(/already assigned/);

    expect(await db.select().from(organizations).where(eq(organizations.id, "org_conflict"))).toHaveLength(0);
  });

  it("parses only current gateway seed environment settings", () => {
    const options = seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_env",
      GATEWAY_SEED_CLASSIFIER_MODEL: "classifier-model",
      GATEWAY_SEED_CLASSIFIER_TIMEOUT_MS: "1234",
      GATEWAY_SEED_CLASSIFIER_MAX_ATTEMPTS: "3",
      OPENAI_BASE_URL: "https://openai.example/v1",
      ANTHROPIC_BASE_URL: "https://anthropic.example/v1",
      PROXY_TOKEN: "proxy-token",
      SEED_EXTERNAL_ECONOMY_TOKEN: "economy-token"
    });

    expect(options).toEqual(expect.objectContaining({
      organizationId: "org_env",
      classifierModel: "classifier-model",
      classifierTimeoutMs: 1234,
      classifierMaxAttempts: 3,
      openaiBaseUrl: "https://openai.example/v1",
      anthropicBaseUrl: "https://anthropic.example/v1",
      proxyToken: "proxy-token",
      externalEconomyToken: "economy-token"
    }));
  });
});

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  return client;
}
