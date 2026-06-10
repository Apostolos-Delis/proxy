import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { createPgliteDatabase } from "@prompt-proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@prompt-proxy/db/seed";

import { buildModelCatalog } from "../src/catalog.js";
import type { AppConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";

export async function createSmokePersistence(config: AppConfig, env: NodeJS.ProcessEnv) {
  const client = new PGlite();
  const migration = await readFile(join(process.cwd(), "../../packages/db/migrations/0000_foundation.sql"), "utf8");
  await client.exec(migration);

  const db = createPgliteDatabase(client);
  await seedDatabase(db, seedOptionsFromEnv(env));

  return {
    persistence: createDatabasePersistence(db, buildModelCatalog(config), config, false),
    close: () => client.close()
  };
}
