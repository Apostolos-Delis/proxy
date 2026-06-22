import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeyLimitPolicies,
  createPgliteDatabase,
  defaultWorkspaceId,
  workspaceLimitPolicies
} from "@prompt-proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@prompt-proxy/db/seed";

import { loadConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";

describe("limit policy resolver", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("returns no effective policy when the workspace and API key have none", async () => {
    const fixture = await setup("org_limits_empty");
    await seed(fixture, "org_limits_empty", "seed_limits_empty_user", "seeded-limits-empty-token");
    const resolved = await fixture.persistence.limitPolicies.resolve({
      organizationId: "org_limits_empty",
      workspaceId: defaultWorkspaceId("org_limits_empty"),
      apiKeyId: "org_limits_empty:api-key:default"
    });

    expect(resolved.workspacePolicy).toBeUndefined();
    expect(resolved.apiKeyPolicy).toBeUndefined();
    expect(resolved.effectivePolicy).toBeUndefined();
  });

  it("keeps the stricter cap when API-key policy is looser", async () => {
    const organizationId = "org_limits_merge";
    const workspaceId = defaultWorkspaceId(organizationId);
    const apiKeyId = `${organizationId}:api-key:default`;
    const fixture = await setup(organizationId);
    await seed(fixture, organizationId, "seed_limits_merge_user", "seeded-limits-merge-token");
    await fixture.db.insert(workspaceLimitPolicies).values({
      id: "workspace_policy_merge",
      organizationId,
      workspaceId,
      policy: {
        requestsPerMinute: 100,
        tokensPerMinute: 1000,
        parallelRequests: 10,
        budget: {
          dailyUsd: 50,
          weeklyUsd: 200,
          monthlyUsd: 500,
          warningThreshold: 0.8,
          resetTimeUtc: "00:00"
        }
      }
    });
    await fixture.db.insert(apiKeyLimitPolicies).values({
      id: "api_key_policy_merge",
      organizationId,
      workspaceId,
      apiKeyId,
      policy: {
        requestsPerMinute: 120,
        tokensPerMinute: 900,
        parallelRequests: 5,
        budget: {
          dailyUsd: 60,
          weeklyUsd: 150,
          warningThreshold: 0.5,
          resetTimeUtc: "12:00"
        }
      }
    });

    const resolved = await fixture.persistence.limitPolicies.resolve({
      organizationId,
      workspaceId,
      apiKeyId
    });

    expect(resolved.effectivePolicy).toEqual({
      requestsPerMinute: 100,
      tokensPerMinute: 900,
      parallelRequests: 5,
      budget: {
        dailyUsd: 50,
        weeklyUsd: 150,
        monthlyUsd: 500,
        warningThreshold: 0.5
      }
    });
  });

  it("uses API-key caps when the workspace has no matching cap", async () => {
    const organizationId = "org_limits_api_only";
    const workspaceId = defaultWorkspaceId(organizationId);
    const apiKeyId = `${organizationId}:api-key:default`;
    const fixture = await setup(organizationId);
    await seed(fixture, organizationId, "seed_limits_api_user", "seeded-limits-api-token");
    await fixture.db.insert(workspaceLimitPolicies).values({
      id: "workspace_policy_api_only",
      organizationId,
      workspaceId,
      policy: {
        requestsPerMinute: 100
      }
    });
    await fixture.db.insert(apiKeyLimitPolicies).values({
      id: "api_key_policy_api_only",
      organizationId,
      workspaceId,
      apiKeyId,
      policy: {
        tokensPerMinute: 900,
        budget: {
          dailyUsd: 20,
          resetTimeUtc: "12:00"
        }
      }
    });

    const resolved = await fixture.persistence.limitPolicies.resolve({
      organizationId,
      workspaceId,
      apiKeyId
    });

    expect(resolved.effectivePolicy).toEqual({
      requestsPerMinute: 100,
      tokensPerMinute: 900,
      budget: {
        dailyUsd: 20,
        resetTimeUtc: "12:00"
      }
    });
  });

  it("rejects invalid stored policy JSON", async () => {
    const organizationId = "org_limits_invalid";
    const workspaceId = defaultWorkspaceId(organizationId);
    const fixture = await setup(organizationId);
    await seed(fixture, organizationId, "seed_limits_invalid_user", "seeded-limits-invalid-token");
    await client?.exec(`
      insert into workspace_limit_policies (id, organization_id, workspace_id, policy)
      values ('workspace_policy_invalid', '${organizationId}', '${workspaceId}', '{}'::jsonb);
    `);

    await expect(fixture.persistence.limitPolicies.resolve({
      organizationId,
      workspaceId
    })).rejects.toThrow("workspace_limit_policy_invalid");
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
      DEFAULT_ORGANIZATION_ID: organizationId
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
      PROMPT_PROXY_TOKEN: proxyToken
    }));
  }
});
