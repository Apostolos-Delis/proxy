import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { createPgliteDatabase } from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";

import type { AppConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";

export async function createSmokePersistence(config: AppConfig, env: NodeJS.ProcessEnv) {
  const client = new PGlite();
  await applySmokeMigrations(client);

  const db = createPgliteDatabase(client);
  await seedDatabase(db, seedOptionsFromEnv(env));

  return {
    persistence: createDatabasePersistence(db, config, false),
    close: () => client.close()
  };
}

async function applySmokeMigrations(client: PGlite) {
  const migrationsDir = [
    join(process.cwd(), "../../packages/db/migrations"),
    join(process.cwd(), "../../packages/db/dist/migrations")
  ].find((path) => existsSync(path));
  if (!migrationsDir) throw new Error("Smoke migrations directory not found.");
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  }
}
