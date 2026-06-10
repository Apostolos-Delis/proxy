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
        and column_name in ('api_key_id', 'routing_config_id', 'routing_config_version_id', 'routing_config_version', 'routing_config_hash')
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
    const invitationColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'invitations'
        and column_name in ('organization_id', 'email', 'role', 'status', 'token_hash', 'token_prefix', 'invited_by_user_id', 'accepted_user_id', 'expires_at')
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
      "api_key_id",
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
    expect(invitationColumns.rows.map((row) => row.column_name)).toEqual([
      "accepted_user_id",
      "email",
      "expires_at",
      "invited_by_user_id",
      "organization_id",
      "role",
      "status",
      "token_hash",
      "token_prefix"
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

  it("catches up local schemas that predate routing config runtime tables", async () => {
    const client = new PGlite();
    const foundation = await readFile(
      fileURLToPath(new URL("../migrations/0000_foundation.sql", import.meta.url)),
      "utf8"
    );
    const catchup = await readFile(
      fileURLToPath(new URL("../migrations/0002_routing_config_runtime_catchup.sql", import.meta.url)),
      "utf8"
    );

    try {
      await client.exec(foundation);
      await client.exec(`
        alter table routing_configs drop constraint if exists routing_configs_active_version_fk;
        alter table routing_config_versions drop constraint if exists routing_config_versions_config_fk;
        alter table api_keys drop constraint if exists api_keys_routing_config_fk;
        alter table organization_settings drop constraint if exists organization_settings_default_routing_config_fk;

        drop table routing_config_versions;
        drop table routing_configs;
        drop table provider_accounts;
        drop table model_catalog;

        drop index if exists api_keys_routing_config_idx;
        alter table api_keys drop column routing_config_id;
        alter table organization_settings drop column default_routing_config_id;

        drop index if exists requests_routing_config_idx;
        alter table requests
          drop column routing_config_id,
          drop column routing_config_version_id,
          drop column routing_config_version,
          drop column routing_config_hash;

        drop index if exists route_decisions_routing_config_idx;
        alter table route_decisions
          drop column routing_config_id,
          drop column routing_config_version_id,
          drop column routing_config_version,
          drop column routing_config_hash;
      `);

      await client.exec(catchup);

      const constraints = await client.query<{ conname: string }>(`
        select conname
        from pg_constraint
        where conname in (
          'routing_config_versions_config_fk',
          'routing_configs_active_version_fk',
          'api_keys_routing_config_fk',
          'organization_settings_default_routing_config_fk'
        )
        order by conname
      `);
      const requestRoutingColumns = await client.query<{ column_name: string }>(`
        select column_name
        from information_schema.columns
        where table_name = 'requests'
          and column_name in ('routing_config_id', 'routing_config_version_id', 'routing_config_version', 'routing_config_hash')
        order by column_name
      `);

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "api_keys_routing_config_fk",
        "organization_settings_default_routing_config_fk",
        "routing_config_versions_config_fk",
        "routing_configs_active_version_fk"
      ]);
      expect(requestRoutingColumns.rows.map((row) => row.column_name)).toEqual([
        "routing_config_hash",
        "routing_config_id",
        "routing_config_version",
        "routing_config_version_id"
      ]);

      await client.exec(`
        insert into organizations (id, slug, name) values
          ('catchup_org_a', 'catchup-org-a', 'Catchup Org A'),
          ('catchup_org_b', 'catchup-org-b', 'Catchup Org B');

        insert into routing_configs (id, organization_id, name, slug) values
          ('catchup_config_a', 'catchup_org_a', 'Catchup Config A', 'catchup-config-a'),
          ('catchup_config_b', 'catchup_org_b', 'Catchup Config B', 'catchup-config-b');
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
          'catchup_version_cross',
          'catchup_org_b',
          'catchup_config_a',
          1,
          'catchup_hash_cross',
          '{}'::jsonb
        );
      `)).rejects.toThrow();

      await expect(client.exec(`
        insert into api_keys (id, organization_id, key_hash, name, routing_config_id)
        values ('catchup_key_cross', 'catchup_org_b', 'catchup_hash_key_cross', 'Catchup Key Cross', 'catchup_config_a');
      `)).rejects.toThrow();
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
