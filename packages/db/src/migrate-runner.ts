import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

export type RunDatabaseMigrationsInput = {
  databaseUrl: string;
  migrationsDir?: string;
  onApplied?: (filename: string) => void;
};

export async function runDatabaseMigrations(input: RunDatabaseMigrationsInput) {
  const migrationsDir = input.migrationsDir ?? fileURLToPath(new URL("../migrations", import.meta.url));
  const sql = postgres(input.databaseUrl, { max: 1, onnotice: () => undefined });
  const appliedFiles: string[] = [];

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS prompt_proxy_schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `;

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const applied = await sql`
        SELECT filename
        FROM prompt_proxy_schema_migrations
        WHERE filename = ${file}
        LIMIT 1
      `;
      if (applied.length > 0) continue;

      const migration = await readFile(join(migrationsDir, file), "utf8");
      await sql.begin(async (transaction) => {
        await transaction.unsafe(migration);
        await transaction`
          INSERT INTO prompt_proxy_schema_migrations (filename)
          VALUES (${file})
        `;
      });

      appliedFiles.push(file);
      input.onApplied?.(file);
    }

    return { appliedFiles };
  } finally {
    await sql.end();
  }
}
