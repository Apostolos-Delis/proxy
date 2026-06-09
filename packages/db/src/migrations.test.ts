import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("database migrations", () => {
  it("applies the foundation migration", async () => {
    const client = await migratedClient();
    const result = await client.query("select count(*)::int as count from organizations");
    const columns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'prompt_artifacts'
        and column_name in ('raw_text', 'token_estimate', 'source_role', 'source_index')
      order by column_name
    `);
    const sessionColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'user_sessions'
        and column_name in ('organization_id', 'user_id', 'session_token_hash', 'expires_at', 'revoked_at')
      order by column_name
    `);
    const routingConfigColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'routing_configs'
        and column_name in ('organization_id', 'slug', 'status', 'active_version_id')
      order by column_name
    `);
    const routingConfigVersionColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'routing_config_versions'
        and column_name in ('organization_id', 'routing_config_id', 'version', 'config_hash', 'config')
      order by column_name
    `);
    const keyColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'api_keys'
        and column_name = 'routing_config_id'
      order by column_name
    `);
    const organizationSettingsColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'organization_settings'
        and column_name = 'default_routing_config_id'
      order by column_name
    `);
    const requestRoutingColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'requests'
        and column_name in ('routing_config_id', 'routing_config_version_id', 'routing_config_version', 'routing_config_hash')
      order by column_name
    `);
    const decisionRoutingColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'route_decisions'
        and column_name in ('routing_config_id', 'routing_config_version_id', 'routing_config_version', 'routing_config_hash')
      order by column_name
    `);
    const auditColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'prompt_access_audit'
        and column_name in ('organization_id', 'artifact_id', 'request_id', 'user_id', 'admin_session_id', 'access_path')
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
    expect(sessionColumns.rows.map((row) => row.column_name)).toEqual([
      "expires_at",
      "organization_id",
      "revoked_at",
      "session_token_hash",
      "user_id"
    ]);
    expect(routingConfigColumns.rows.map((row) => row.column_name)).toEqual([
      "active_version_id",
      "organization_id",
      "slug",
      "status"
    ]);
    expect(routingConfigVersionColumns.rows.map((row) => row.column_name)).toEqual([
      "config",
      "config_hash",
      "organization_id",
      "routing_config_id",
      "version"
    ]);
    expect(keyColumns.rows.map((row) => row.column_name)).toEqual(["routing_config_id"]);
    expect(organizationSettingsColumns.rows.map((row) => row.column_name)).toEqual(["default_routing_config_id"]);
    expect(requestRoutingColumns.rows.map((row) => row.column_name)).toEqual([
      "routing_config_hash",
      "routing_config_id",
      "routing_config_version",
      "routing_config_version_id"
    ]);
    expect(decisionRoutingColumns.rows.map((row) => row.column_name)).toEqual([
      "routing_config_hash",
      "routing_config_id",
      "routing_config_version",
      "routing_config_version_id"
    ]);
    expect(auditColumns.rows.map((row) => row.column_name)).toEqual([
      "access_path",
      "admin_session_id",
      "artifact_id",
      "organization_id",
      "request_id",
      "user_id"
    ]);
  });

  it("enforces tenant-scoped routing config references", async () => {
    const client = await migratedClient();

    try {
      await client.exec(`
        insert into organizations (id, slug, name) values
          ('org_a', 'org-a', 'Org A'),
          ('org_b', 'org-b', 'Org B');

        insert into routing_configs (id, organization_id, name, slug) values
          ('config_a', 'org_a', 'Config A', 'config-a'),
          ('config_a_peer', 'org_a', 'Config A Peer', 'config-a-peer'),
          ('config_b', 'org_b', 'Config B', 'config-b');
      `);

      await expect(client.exec(`
        insert into routing_config_versions (
          id,
          organization_id,
          routing_config_id,
          version,
          config_hash,
          config
        ) values (
          'version_cross',
          'org_b',
          'config_a',
          1,
          'hash_cross',
          '{}'::jsonb
        );
      `)).rejects.toThrow();

      await client.exec(`
        insert into routing_config_versions (
          id,
          organization_id,
          routing_config_id,
          version,
          config_hash,
          config
        ) values
          ('version_a', 'org_a', 'config_a', 1, 'hash_a', '{}'::jsonb),
          ('version_a_peer', 'org_a', 'config_a_peer', 1, 'hash_a_peer', '{}'::jsonb),
          ('version_b', 'org_b', 'config_b', 1, 'hash_b', '{}'::jsonb);
      `);

      await expect(client.exec(`
        insert into api_keys (id, organization_id, key_hash, name, routing_config_id)
        values ('key_cross', 'org_b', 'hash_key_cross', 'Key Cross', 'config_a');
      `)).rejects.toThrow();

      await expect(client.exec(`
        insert into organization_settings (organization_id, default_routing_config_id)
        values ('org_b', 'config_a');
      `)).rejects.toThrow();

      await expect(client.exec(`
        update routing_configs
        set active_version_id = 'version_b'
        where id = 'config_a';
      `)).rejects.toThrow();

      await expect(client.exec(`
        update routing_configs
        set active_version_id = 'version_a_peer'
        where id = 'config_a';
      `)).rejects.toThrow();

      await expect(client.exec(`
        update routing_configs
        set active_version_id = 'missing_version'
        where id = 'config_a';
      `)).rejects.toThrow();

      await client.exec(`
        update routing_configs
        set active_version_id = 'version_a'
        where id = 'config_a';
      `);

      const active = await client.query<{ active_version_id: string }>(`
        select active_version_id
        from routing_configs
        where id = 'config_a'
      `);

      expect(active.rows[0]).toEqual({ active_version_id: "version_a" });
    } finally {
      await client.close();
    }
  });
});

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const migration = await readFile(join(migrationsDir, file), "utf8");
    await client.exec(migration);
  }

  return client;
}
