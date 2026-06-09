import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("database migrations", () => {
  it("applies the foundation migration", async () => {
    const client = new PGlite();
    const migration = await readFile(
      fileURLToPath(new URL("../migrations/0000_foundation.sql", import.meta.url)),
      "utf8"
    );

    await client.exec(migration);
    const result = await client.query("select count(*)::int as count from organizations");
    const columns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'prompt_artifacts'
        and column_name in ('raw_text', 'token_estimate', 'source_role', 'source_index')
      order by column_name
    `);
    await client.close();

    expect(result.rows[0]).toEqual({ count: 0 });
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "raw_text",
      "source_index",
      "source_role",
      "token_estimate"
    ]);
  });
});
