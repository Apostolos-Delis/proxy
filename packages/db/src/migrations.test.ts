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
    await client.close();

    expect(result.rows[0]).toEqual({ count: 0 });
  });
});
