import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { createPgliteDatabase } from "@prompt-proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@prompt-proxy/db/seed";

import { buildModelCatalog } from "../src/catalog.js";
import type { AppConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";

export async function createSmokePersistence(config: AppConfig, env: NodeJS.ProcessEnv) {
  const client = new PGlite();
  const migration = await readFile(
    fileURLToPath(new URL("../../../packages/db/migrations/0000_foundation.sql", import.meta.url)),
    "utf8"
  );
  await client.exec(migration);

  const db = createPgliteDatabase(client);
  await seedDatabase(db, seedOptionsFromEnv(env));

  return {
    persistence: createDatabasePersistence(db, buildModelCatalog(config), config, false),
    close: () => client.close()
  };
}
