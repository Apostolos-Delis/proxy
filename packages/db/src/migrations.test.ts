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
    const workspaceColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'workspaces'
        and column_name in ('organization_id', 'slug', 'name', 'default_routing_config_id')
      order by column_name
    `);
    const workspaceScopedColumns = await client.query<{ table_name: string }>(`
      select table_name
      from information_schema.columns
      where column_name = 'workspace_id'
      order by table_name
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
    const compressionReceiptColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'compression_receipts'
        and column_name in (
          'organization_id',
          'workspace_id',
          'request_id',
          'api_key_id',
          'mode',
          'surface',
          'block_path',
          'tool_name',
          'command',
          'command_class',
          'rule_id',
          'rule_version',
          'status',
          'original_chars',
          'compressed_chars',
          'saved_chars',
          'original_bytes',
          'compressed_bytes',
          'original_estimated_tokens',
          'compressed_estimated_tokens',
          'saved_estimated_tokens',
          'estimate_source',
          'original_sha256',
          'compressed_sha256',
          'original_artifact_id',
          'compressed_artifact_id',
          'skip_reason',
          'event_id'
        )
      order by column_name
    `);
    const invitationColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'invitations'
        and column_name in ('organization_id', 'email', 'role', 'status', 'token_hash', 'token_prefix', 'invited_by_user_id', 'accepted_user_id', 'expires_at')
      order by column_name
    `);
    const providerAccountColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'provider_accounts'
        and column_name in ('provider_id', 'base_url', 'auth_type', 'secret_ciphertext', 'secret_hint', 'created_by_user_id', 'last_used_at')
      order by column_name
    `);
    const providerBindingColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'api_key_provider_accounts'
        and column_name in ('organization_id', 'api_key_id', 'provider_id', 'provider_account_id')
      order by column_name
    `);
    const modelCatalogColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'model_catalog'
        and column_name in ('organization_id', 'provider_id', 'model', 'capabilities', 'pricing')
      order by column_name
    `);
    const providerRegistryColumns = await client.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'providers'
        and column_name in ('id', 'organization_id', 'slug', 'display_name', 'base_url', 'auth_style', 'endpoints', 'default_headers', 'capabilities', 'forward_harness_headers', 'enabled')
      order by column_name
    `);
    const retiredPolicyTable = ["route", "policies"].join("_");
    const routePolicyTables = await client.query<{ table_name: string }>(`
      select table_name
      from information_schema.tables
      where table_name = '${retiredPolicyTable}'
    `);
    await client.close();

    expect(result.rows[0]).toEqual({ count: 0 });
    expect(routePolicyTables.rows).toEqual([]);
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
    expect(organizationSettingsColumns.rows.map((row) => row.column_name)).toEqual([]);
    expect(workspaceColumns.rows.map((row) => row.column_name)).toEqual([
      "default_routing_config_id",
      "name",
      "organization_id",
      "slug"
    ]);
    expect(workspaceScopedColumns.rows.map((row) => row.table_name)).toEqual([
      "agent_sessions",
      "api_key_provider_accounts",
      "api_keys",
      "compression_receipts",
      "events",
      "prompt_access_audit",
      "prompt_artifacts",
      "provider_attempts",
      "requests",
      "route_decisions",
      "routing_config_versions",
      "routing_configs",
      "turns",
      "usage_ledger",
      "user_sessions"
    ]);
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
    expect(compressionReceiptColumns.rows.map((row) => row.column_name)).toEqual([
      "api_key_id",
      "block_path",
      "command",
      "command_class",
      "compressed_artifact_id",
      "compressed_bytes",
      "compressed_chars",
      "compressed_estimated_tokens",
      "compressed_sha256",
      "estimate_source",
      "event_id",
      "mode",
      "organization_id",
      "original_artifact_id",
      "original_bytes",
      "original_chars",
      "original_estimated_tokens",
      "original_sha256",
      "request_id",
      "rule_id",
      "rule_version",
      "saved_chars",
      "saved_estimated_tokens",
      "skip_reason",
      "status",
      "surface",
      "tool_name",
      "workspace_id"
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
    expect(providerAccountColumns.rows.map((row) => row.column_name)).toEqual([
      "auth_type",
      "base_url",
      "created_by_user_id",
      "last_used_at",
      "provider_id",
      "secret_ciphertext",
      "secret_hint"
    ]);
    expect(providerBindingColumns.rows.map((row) => row.column_name)).toEqual([
      "api_key_id",
      "organization_id",
      "provider_account_id",
      "provider_id"
    ]);
    expect(modelCatalogColumns.rows.map((row) => row.column_name)).toEqual([
      "capabilities",
      "model",
      "organization_id",
      "pricing",
      "provider_id"
    ]);
    expect(providerRegistryColumns.rows.map((row) => row.column_name)).toEqual([
      "auth_style",
      "base_url",
      "capabilities",
      "default_headers",
      "display_name",
      "enabled",
      "endpoints",
      "forward_harness_headers",
      "id",
      "organization_id",
      "slug"
    ]);
  });

  it("enforces tenant- and workspace-scoped routing config references", async () => {
    const client = await migratedClient();

    try {
      await client.exec(`
        insert into organizations (id, slug, name) values
          ('org_a', 'org-a', 'Org A'),
          ('org_b', 'org-b', 'Org B');

        insert into workspaces (id, organization_id, slug, name) values
          ('ws_a1', 'org_a', 'primary', 'Primary'),
          ('ws_a2', 'org_a', 'secondary', 'Secondary'),
          ('ws_b', 'org_b', 'primary', 'Primary');

        insert into routing_configs (id, organization_id, workspace_id, name, slug) values
          ('config_a', 'org_a', 'ws_a1', 'Config A', 'config-a'),
          ('config_a_peer', 'org_a', 'ws_a1', 'Config A Peer', 'config-a-peer'),
          ('config_b', 'org_b', 'ws_b', 'Config B', 'config-b');
      `);

      await expect(client.exec(`
        insert into routing_config_versions (
          id,
          organization_id,
          workspace_id,
          routing_config_id,
          version,
          config_hash,
          config
        ) values (
          'version_cross',
          'org_b',
          'ws_b',
          'config_a',
          1,
          'hash_cross',
          '{}'::jsonb
        );
      `)).rejects.toThrow();

      await expect(client.exec(`
        insert into routing_config_versions (
          id,
          organization_id,
          workspace_id,
          routing_config_id,
          version,
          config_hash,
          config
        ) values (
          'version_cross_workspace',
          'org_a',
          'ws_a2',
          'config_a',
          1,
          'hash_cross_workspace',
          '{}'::jsonb
        );
      `)).rejects.toThrow();

      await client.exec(`
        insert into routing_config_versions (
          id,
          organization_id,
          workspace_id,
          routing_config_id,
          version,
          config_hash,
          config
        ) values
          ('version_a', 'org_a', 'ws_a1', 'config_a', 1, 'hash_a', '{}'::jsonb),
          ('version_a_peer', 'org_a', 'ws_a1', 'config_a_peer', 1, 'hash_a_peer', '{}'::jsonb),
          ('version_b', 'org_b', 'ws_b', 'config_b', 1, 'hash_b', '{}'::jsonb);
      `);

      await expect(client.exec(`
        insert into api_keys (id, organization_id, workspace_id, key_hash, name, routing_config_id)
        values ('key_cross', 'org_b', 'ws_b', 'hash_key_cross', 'Key Cross', 'config_a');
      `)).rejects.toThrow();

      await expect(client.exec(`
        insert into api_keys (id, organization_id, workspace_id, key_hash, name, routing_config_id)
        values ('key_cross_workspace', 'org_a', 'ws_a2', 'hash_key_cross_ws', 'Key Cross WS', 'config_a');
      `)).rejects.toThrow();

      await expect(client.exec(`
        update workspaces
        set default_routing_config_id = 'config_a'
        where id = 'ws_a2';
      `)).rejects.toThrow();

      await client.exec(`
        update workspaces
        set default_routing_config_id = 'config_a'
        where id = 'ws_a1';
      `);

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

  it("migrates existing org-scoped rows into the default workspace", async () => {
    const client = new PGlite();
    const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    const preWorkspaceFiles = files.filter((file) => file < "0006");

    try {
      for (const file of preWorkspaceFiles) {
        await client.exec(await readFile(join(migrationsDir, file), "utf8"));
      }

      await client.exec(`
        insert into organizations (id, slug, name) values ('org_legacy', 'org-legacy', 'Org Legacy');
        insert into organization_settings (organization_id, default_routing_config_id) values ('org_legacy', null);
        insert into routing_configs (id, organization_id, name, slug) values
          ('legacy_config', 'org_legacy', 'Legacy Config', 'legacy-config');
        update organization_settings set default_routing_config_id = 'legacy_config'
          where organization_id = 'org_legacy';
        insert into api_keys (id, organization_id, key_hash, name, routing_config_id) values
          ('legacy_key', 'org_legacy', 'legacy_hash', 'Legacy Key', 'legacy_config');
        insert into requests (id, organization_id, surface, idempotency_key, requested_model, input_hash) values
          ('legacy_request', 'org_legacy', 'openai-responses', 'legacy-idem', 'router-auto', 'hash');
      `);

      for (const file of files.filter((name) => !preWorkspaceFiles.includes(name))) {
        await client.exec(await readFile(join(migrationsDir, file), "utf8"));
      }

      const workspaceRows = await client.query<{ id: string; default_routing_config_id: string | null }>(`
        select id, default_routing_config_id
        from workspaces
        where organization_id = 'org_legacy'
      `);
      const keyRows = await client.query<{ workspace_id: string }>(`
        select workspace_id from api_keys where id = 'legacy_key'
      `);
      const requestRows = await client.query<{ workspace_id: string }>(`
        select workspace_id from requests where id = 'legacy_request'
      `);

      expect(workspaceRows.rows).toEqual([
        { id: "org_legacy:workspace:default", default_routing_config_id: "legacy_config" }
      ]);
      expect(keyRows.rows).toEqual([{ workspace_id: "org_legacy:workspace:default" }]);
      expect(requestRows.rows).toEqual([{ workspace_id: "org_legacy:workspace:default" }]);
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

        drop table if exists api_key_provider_accounts;
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

  it("attributes unowned API keys and their traffic to the creator on backfill", async () => {
    const client = new PGlite();
    const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    const beforeBackfill = files.filter((file) => file < "0007");

    try {
      for (const file of beforeBackfill) {
        await client.exec(await readFile(join(migrationsDir, file), "utf8"));
      }

      const workspaceId = "org_attr:workspace:default";
      await client.exec(`
        insert into organizations (id, slug, name) values ('org_attr', 'org-attr', 'Org Attr');
        insert into workspaces (id, organization_id, slug, name) values
          ('${workspaceId}', 'org_attr', 'default', 'Default');
        insert into users (id, external_id, name) values
          ('creator_user', 'creator_user', 'Creator'),
          ('ghost_user', 'ghost_user', 'Ghost');

        -- Key whose creator still exists: adopts that creator.
        insert into api_keys (id, organization_id, workspace_id, key_hash, name) values
          ('owned_key', 'org_attr', '${workspaceId}', 'owned_hash', 'Owned Key');
        -- Key whose creator was deleted: must stay null (FK safety).
        insert into api_keys (id, organization_id, workspace_id, key_hash, name) values
          ('orphan_key', 'org_attr', '${workspaceId}', 'orphan_hash', 'Orphan Key');

        insert into events (
          id, sequence, schema_version, organization_id, workspace_id, scope_type, scope_id,
          actor_type, actor_id, producer, event_type, payload_hash, sensitivity, redaction_state,
          payload, created_at
        ) values
          ('evt_owned', 1, 1, 'org_attr', '${workspaceId}', 'api_key', 'owned_key',
           'user', 'creator_user', 'test', 'api_key.created', 'h', 'internal', 'redacted',
           '{}'::jsonb, now()),
          ('evt_orphan', 1, 1, 'org_attr', '${workspaceId}', 'api_key', 'orphan_key',
           'user', 'deleted_user', 'test', 'api_key.created', 'h', 'internal', 'redacted',
           '{}'::jsonb, now());

        insert into agent_sessions (id, organization_id, workspace_id, surface, external_session_id) values
          ('sess_owned', 'org_attr', '${workspaceId}', 'openai-responses', 'ext-owned');

        insert into requests (id, organization_id, workspace_id, api_key_id, session_id, surface, idempotency_key, requested_model, input_hash) values
          ('req_owned', 'org_attr', '${workspaceId}', 'owned_key', 'sess_owned', 'openai-responses', 'idem-owned', 'router-auto', 'hash'),
          ('req_orphan', 'org_attr', '${workspaceId}', 'orphan_key', null, 'openai-responses', 'idem-orphan', 'router-auto', 'hash');

        insert into provider_attempts (id, organization_id, workspace_id, request_id, surface, provider, model) values
          ('att_owned', 'org_attr', '${workspaceId}', 'req_owned', 'openai-responses', 'openai', 'gpt');

        insert into usage_ledger (id, organization_id, workspace_id, request_id, provider_attempt_id, provider, model) values
          ('led_owned', 'org_attr', '${workspaceId}', 'req_owned', 'att_owned', 'openai', 'gpt');
      `);

      await client.exec(await readFile(join(migrationsDir, "0007_api_key_owner_backfill.sql"), "utf8"));

      const keyRows = await client.query<{ id: string; user_id: string | null }>(
        "select id, user_id from api_keys order by id"
      );
      const requestRows = await client.query<{ id: string; user_id: string | null }>(
        "select id, user_id from requests order by id"
      );
      const ledgerRows = await client.query<{ user_id: string | null }>(
        "select user_id from usage_ledger where id = 'led_owned'"
      );
      const sessionRows = await client.query<{ user_id: string | null }>(
        "select user_id from agent_sessions where id = 'sess_owned'"
      );

      expect(keyRows.rows).toEqual([
        { id: "orphan_key", user_id: null },
        { id: "owned_key", user_id: "creator_user" }
      ]);
      expect(requestRows.rows).toEqual([
        { id: "req_orphan", user_id: null },
        { id: "req_owned", user_id: "creator_user" }
      ]);
      expect(ledgerRows.rows).toEqual([{ user_id: "creator_user" }]);
      expect(sessionRows.rows).toEqual([{ user_id: "creator_user" }]);
    } finally {
      await client.close();
    }
  });

  it("strips pre-cutover prompt fields from stored routing config versions", async () => {
    const client = new PGlite();
    const foundation = await readFile(
      fileURLToPath(new URL("../migrations/0000_foundation.sql", import.meta.url)),
      "utf8"
    );
    const cutover = await readFile(
      fileURLToPath(new URL("../migrations/0005_organization_system_prompt.sql", import.meta.url)),
      "utf8"
    );

    try {
      await client.exec(foundation);
      await client.exec(`
        insert into organizations (id, slug, name)
        values ('cutover_org', 'cutover-org', 'Cutover Org');

        insert into routing_configs (id, organization_id, name, slug)
        values ('cutover_config', 'cutover_org', 'Cutover Config', 'cutover-config');

        insert into routing_config_versions (id, organization_id, routing_config_id, version, config_hash, config)
        values
          (
            'cutover_version_stale',
            'cutover_org',
            'cutover_config',
            1,
            'cutover_hash_stale',
            '{"systemPrompt": "Old prompt.", "classifier": {"model": "m", "instructions": "Old instructions."}}'::jsonb
          ),
          (
            'cutover_version_clean',
            'cutover_org',
            'cutover_config',
            2,
            'cutover_hash_clean',
            '{"classifier": {"model": "m", "rules": "Keep auth/ on hard."}}'::jsonb
          );
      `);

      await client.exec(cutover);

      const versions = await client.query<{ id: string; config: Record<string, unknown> }>(`
        select id, config from routing_config_versions order by version
      `);

      expect(versions.rows[0]?.config).toEqual({ classifier: { model: "m" } });
      expect(versions.rows[1]?.config).toEqual({ classifier: { model: "m", rules: "Keep auth/ on hard." } });
    } finally {
      await client.close();
    }
  });

  it("migrates v1 routing config jsonb to v2 target lists", async () => {
    const client = new PGlite();
    const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    const beforeCutover = files.filter((file) => file < "0012_routing_config_v2_cutover.sql");
    const v1Config = legacyRoutingConfig();

    try {
      for (const file of beforeCutover) {
        await client.exec(await readFile(join(migrationsDir, file), "utf8"));
      }

      await client.exec(`
        insert into organizations (id, slug, name) values ('org_v2_migration', 'org-v2-migration', 'Org V2 Migration');
        insert into workspaces (id, organization_id, slug, name) values
          ('org_v2_migration:workspace:default', 'org_v2_migration', 'default', 'Default');
        insert into routing_configs (id, organization_id, workspace_id, name, slug) values
          ('config_v2_migration', 'org_v2_migration', 'org_v2_migration:workspace:default', 'Config V2 Migration', 'default');
        insert into routing_config_versions (
          id,
          organization_id,
          workspace_id,
          routing_config_id,
          version,
          config_hash,
          config,
          status
        ) values (
          'version_v2_migration',
          'org_v2_migration',
          'org_v2_migration:workspace:default',
          'config_v2_migration',
          1,
          'legacy_hash',
          $config$${JSON.stringify(v1Config)}$config$::jsonb,
          'active'
        );
        insert into agent_sessions (
          id,
          organization_id,
          workspace_id,
          surface,
          external_session_id,
          pinned_settings
        ) values (
          'session_v2_migration',
          'org_v2_migration',
          'org_v2_migration:workspace:default',
          'anthropic-messages',
          'session-v2',
          '{"provider":"anthropic","model":"claude-legacy","anthropic":{"model":"claude-legacy"}}'::jsonb
        );
        insert into organization_settings (organization_id, settings) values (
          'org_v2_migration',
          '{"cacheTtlUpgrade":true,"costBaselineAnthropicModel":"claude-baseline","costBaselineOpenaiModel":"gpt-baseline"}'::jsonb
        );
      `);

      await client.exec(await readFile(join(migrationsDir, "0012_routing_config_v2_cutover.sql"), "utf8"));

      const versions = await client.query<{ config_hash: string; config: Record<string, any> }>(`
        select config_hash, config from routing_config_versions where id = 'version_v2_migration'
      `);
      const sessions = await client.query<{ pinned_settings: Record<string, unknown> | null }>(`
        select pinned_settings from agent_sessions where id = 'session_v2_migration'
      `);
      const settings = await client.query<{ settings: Record<string, any> }>(`
        select settings from organization_settings where organization_id = 'org_v2_migration'
      `);
      const databaseHash = await client.query<{ hash: string }>(`
        select encode(sha256(convert_to(config::text, 'UTF8')), 'hex') as hash
        from routing_config_versions
        where id = 'version_v2_migration'
      `);

      expect(versions.rows[0]?.config_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(versions.rows[0]?.config_hash).not.toBe("legacy_hash");
      expect(versions.rows[0]?.config_hash).toBe(databaseHash.rows[0]?.hash);
      expect(versions.rows[0]?.config).toEqual(expect.objectContaining({
        schemaVersion: 2,
        classifier: expect.objectContaining({
          providerId: "openai",
          effort: "minimal"
        })
      }));
      expect(versions.rows[0]?.config.routes.hard.targets).toEqual([
        expect.objectContaining({
          providerId: "anthropic",
          model: "claude-hard",
          effort: "high",
          thinking: { type: "adaptive", display: "omitted" },
          maxOutputTokens: 4096,
          metadata: { retained: true }
        }),
        expect.objectContaining({
          providerId: "openai",
          model: "gpt-hard",
          effort: "high",
          verbosity: "medium",
          maxOutputTokens: 1234
        })
      ]);
      expect(sessions.rows).toEqual([{ pinned_settings: null }]);
      expect(settings.rows[0]?.settings).toEqual({
        cacheTtlUpgrade: true,
        costBaselineByDialect: {
          "anthropic-messages": "claude-baseline",
          "openai-responses": "gpt-baseline",
          "openai-chat": "gpt-baseline"
        }
      });
    } finally {
      await client.close();
    }
  });

  it("aborts the v2 routing config migration before writes on hash collision", async () => {
    const client = new PGlite();
    const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    const beforeCutover = files.filter((file) => file < "0012_routing_config_v2_cutover.sql");
    const v1Config = legacyRoutingConfig();

    try {
      for (const file of beforeCutover) {
        await client.exec(await readFile(join(migrationsDir, file), "utf8"));
      }

      await client.exec(`
        insert into organizations (id, slug, name) values ('org_v2_collision', 'org-v2-collision', 'Org V2 Collision');
        insert into workspaces (id, organization_id, slug, name) values
          ('org_v2_collision:workspace:default', 'org_v2_collision', 'default', 'Default');
        insert into routing_configs (id, organization_id, workspace_id, name, slug) values
          ('config_v2_collision_a', 'org_v2_collision', 'org_v2_collision:workspace:default', 'Config V2 Collision A', 'a'),
          ('config_v2_collision_b', 'org_v2_collision', 'org_v2_collision:workspace:default', 'Config V2 Collision B', 'b');
        insert into routing_config_versions (
          id,
          organization_id,
          workspace_id,
          routing_config_id,
          version,
          config_hash,
          config
        ) values
          (
            'version_v2_collision_a',
            'org_v2_collision',
            'org_v2_collision:workspace:default',
            'config_v2_collision_a',
            1,
            'legacy_hash_a',
            $config$${JSON.stringify(v1Config)}$config$::jsonb
          ),
          (
            'version_v2_collision_b',
            'org_v2_collision',
            'org_v2_collision:workspace:default',
            'config_v2_collision_b',
            1,
            'legacy_hash_b',
            $config$${JSON.stringify(v1Config)}$config$::jsonb
          );
      `);

      await expect(client.exec(
        await readFile(join(migrationsDir, "0012_routing_config_v2_cutover.sql"), "utf8")
      )).rejects.toThrow("routing_config_v2_hash_collision");

      const versions = await client.query<{ id: string; config_hash: string; schema_version: string | null }>(`
        select id, config_hash, config->>'schemaVersion' as schema_version
        from routing_config_versions
        order by id
      `);

      expect(versions.rows).toEqual([
        { id: "version_v2_collision_a", config_hash: "legacy_hash_a", schema_version: "1" },
        { id: "version_v2_collision_b", config_hash: "legacy_hash_b", schema_version: "1" }
      ]);
    } finally {
      await client.close();
    }
  });

  it("backfills provider account bindings onto registry provider ids", async () => {
    const client = new PGlite();
    const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

    try {
      for (const file of files.filter((name) => name < "0010_provider_account_registry.sql")) {
        await client.exec(await readFile(join(migrationsDir, file), "utf8"));
      }

      await client.exec(`
        insert into organizations (id, slug, name) values
          ('org_provider_backfill', 'org-provider-backfill', 'Provider Backfill');
        insert into workspaces (id, organization_id, slug, name) values
          ('org_provider_backfill:workspace:default', 'org_provider_backfill', 'default', 'Default');
        insert into api_keys (id, organization_id, workspace_id, key_hash, name) values
          ('key_provider_backfill', 'org_provider_backfill', 'org_provider_backfill:workspace:default', 'hash', 'Backfill Key');
        insert into provider_accounts (
          id,
          organization_id,
          provider,
          name,
          auth_type,
          secret_ciphertext,
          secret_hint,
          status
        ) values (
          'account_provider_backfill',
          'org_provider_backfill',
          'anthropic',
          'Anthropic Backfill',
          'api_key',
          'ciphertext',
          'hint',
          'active'
        );
        insert into api_key_provider_accounts (
          organization_id,
          workspace_id,
          api_key_id,
          provider,
          provider_account_id
        ) values (
          'org_provider_backfill',
          'org_provider_backfill:workspace:default',
          'key_provider_backfill',
          'anthropic',
          'account_provider_backfill'
        );
      `);

      await client.exec(await readFile(join(migrationsDir, "0010_provider_account_registry.sql"), "utf8"));

      const accountRows = await client.query<{ provider_id: string }>(`
        select provider_id from provider_accounts where id = 'account_provider_backfill'
      `);
      const bindingRows = await client.query<{ provider_id: string }>(`
        select provider_id from api_key_provider_accounts where provider_account_id = 'account_provider_backfill'
      `);
      const removedColumns = await client.query<{ table_name: string }>(`
        select table_name
        from information_schema.columns
        where table_name in ('provider_accounts', 'api_key_provider_accounts')
          and column_name = 'provider'
        order by table_name
      `);

      expect(accountRows.rows).toEqual([{ provider_id: "00000000-0000-0000-0000-000000000002" }]);
      expect(bindingRows.rows).toEqual([{ provider_id: "00000000-0000-0000-0000-000000000002" }]);
      expect(removedColumns.rows).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("backfills model catalog rows onto registry provider ids", async () => {
    const client = new PGlite();
    const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

    try {
      for (const file of files.filter((name) => name < "0011_model_catalog_provider_registry.sql")) {
        await client.exec(await readFile(join(migrationsDir, file), "utf8"));
      }

      await client.exec(`
        insert into organizations (id, slug, name) values
          ('org_model_backfill', 'org-model-backfill', 'Model Backfill');
        insert into model_catalog (
          id,
          organization_id,
          provider,
          model,
          pricing
        ) values (
          'model_override_backfill',
          'org_model_backfill',
          'openai',
          'gpt-custom-backfill',
          '{"inputCostPerMtok": 1, "outputCostPerMtok": 2}'::jsonb
        );
      `);

      await client.exec(await readFile(join(migrationsDir, "0011_model_catalog_provider_registry.sql"), "utf8"));

      const modelRows = await client.query<{ provider_id: string; pricing: Record<string, unknown> }>(`
        select provider_id, pricing from model_catalog where id = 'model_override_backfill'
      `);
      const removedColumns = await client.query<{ table_name: string }>(`
        select table_name
        from information_schema.columns
        where table_name = 'model_catalog'
          and column_name = 'provider'
      `);

      expect(modelRows.rows).toEqual([{
        provider_id: "00000000-0000-0000-0000-000000000001",
        pricing: { inputCostPerMtok: 1, outputCostPerMtok: 2 }
      }]);
      expect(removedColumns.rows).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("removes the old default request input cap from stored routing configs", async () => {
    const client = new PGlite();
    const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    const beforeCutover = files.filter((file) => file < "0017_remove_default_request_input_cap.sql");
    const cappedConfig = {
      schemaVersion: 2,
      displayName: "Capped coding router",
      classifier: {
        providerId: "openai",
        model: "route-classifier-cheap",
        timeoutMs: 1500,
        maxAttempts: 2,
        allowRedactedExcerpt: true
      },
      routes: {
        fast: { targets: [{ providerId: "openai", model: "gpt-fast" }] },
        balanced: { targets: [{ providerId: "openai", model: "gpt-balanced" }] },
        hard: { targets: [{ providerId: "openai", model: "gpt-hard" }] },
        deep: { targets: [{ providerId: "openai", model: "gpt-deep" }] }
      },
      limits: {
        maxRoute: "deep",
        fallbackRoute: "hard",
        maxEstimatedInputTokens: 200000
      },
      session: {
        pinInitialRoute: true,
        allowUpgrade: true,
        allowDowngrade: false
      }
    };
    const customCapConfig = {
      ...cappedConfig,
      displayName: "Custom capped coding router",
      limits: {
        ...cappedConfig.limits,
        maxEstimatedInputTokens: 500000
      }
    };
    const collisionCappedConfig = {
      ...cappedConfig,
      displayName: "Collision capped coding router"
    };
    const collisionUncappedConfig = {
      ...collisionCappedConfig,
      limits: {
        maxRoute: "deep",
        fallbackRoute: "hard"
      }
    };

    try {
      for (const file of beforeCutover) {
        await client.exec(await readFile(join(migrationsDir, file), "utf8"));
      }

      await client.exec(`
        insert into organizations (id, slug, name) values ('org_input_cap_cutover', 'org-input-cap-cutover', 'Org Input Cap Cutover');
        insert into workspaces (id, organization_id, slug, name) values
          ('org_input_cap_cutover:workspace:default', 'org_input_cap_cutover', 'default', 'Default');
        insert into routing_configs (id, organization_id, workspace_id, name, slug) values
          ('config_old_default_cap', 'org_input_cap_cutover', 'org_input_cap_cutover:workspace:default', 'Old Default Cap', 'old-default-cap'),
          ('config_custom_cap', 'org_input_cap_cutover', 'org_input_cap_cutover:workspace:default', 'Custom Cap', 'custom-cap'),
          ('config_collision_cap', 'org_input_cap_cutover', 'org_input_cap_cutover:workspace:default', 'Collision Cap', 'collision-cap');
        insert into routing_config_versions (
          id,
          organization_id,
          workspace_id,
          routing_config_id,
          version,
          config_hash,
          config
        ) values
          (
            'version_old_default_cap',
            'org_input_cap_cutover',
            'org_input_cap_cutover:workspace:default',
            'config_old_default_cap',
            1,
            'old_default_cap_hash',
            $config$${JSON.stringify(cappedConfig)}$config$::jsonb
          ),
          (
            'version_custom_cap',
            'org_input_cap_cutover',
            'org_input_cap_cutover:workspace:default',
            'config_custom_cap',
            1,
            'custom_cap_hash',
            $config$${JSON.stringify(customCapConfig)}$config$::jsonb
          ),
          (
            'version_collision_capped',
            'org_input_cap_cutover',
            'org_input_cap_cutover:workspace:default',
            'config_collision_cap',
            1,
            'collision_capped_hash',
            $config$${JSON.stringify(collisionCappedConfig)}$config$::jsonb
          ),
          (
            'version_collision_uncapped',
            'org_input_cap_cutover',
            'org_input_cap_cutover:workspace:default',
            'config_collision_cap',
            2,
            encode(sha256(convert_to($config$${JSON.stringify(collisionUncappedConfig)}$config$::jsonb::text, 'UTF8')), 'hex'),
            $config$${JSON.stringify(collisionUncappedConfig)}$config$::jsonb
          );
        update routing_configs
        set active_version_id = 'version_collision_capped'
        where id = 'config_collision_cap';
      `);

      await client.exec(await readFile(join(migrationsDir, "0017_remove_default_request_input_cap.sql"), "utf8"));

      const versions = await client.query<{
        id: string;
        cap: string | null;
        config_hash: string;
        database_hash: string;
      }>(`
        select
          id,
          config#>>'{limits,maxEstimatedInputTokens}' as cap,
          config_hash,
          encode(sha256(convert_to(config::text, 'UTF8')), 'hex') as database_hash
        from routing_config_versions
        where organization_id = 'org_input_cap_cutover'
        order by id
      `);

      expect(versions.rows).toEqual([
        {
          id: "version_collision_capped",
          cap: "200000",
          config_hash: "collision_capped_hash",
          database_hash: expect.any(String)
        },
        {
          id: "version_collision_uncapped",
          cap: null,
          config_hash: expect.any(String),
          database_hash: expect.any(String)
        },
        {
          id: "version_custom_cap",
          cap: "500000",
          config_hash: "custom_cap_hash",
          database_hash: expect.any(String)
        },
        {
          id: "version_old_default_cap",
          cap: null,
          config_hash: expect.any(String),
          database_hash: expect.any(String)
        }
      ]);
      expect(versions.rows[3]?.config_hash).toBe(versions.rows[3]?.database_hash);
      expect(versions.rows[1]?.config_hash).toBe(versions.rows[1]?.database_hash);
      const activeConfigs = await client.query<{ active_version_id: string | null }>(`
        select active_version_id
        from routing_configs
        where id = 'config_collision_cap'
      `);
      expect(activeConfigs.rows).toEqual([{ active_version_id: "version_collision_uncapped" }]);
    } finally {
      await client.close();
    }
  });
});

function legacyRoutingConfig() {
  const route = (
    description: string,
    openaiModel: string,
    anthropicModel: string,
    effort: string
  ) => ({
    description,
    openai: {
      model: openaiModel,
      reasoning: { effort },
      text: { verbosity: effort === "low" ? "low" : "medium" }
    },
    anthropic: {
      model: anthropicModel,
      thinking: effort === "low" ? { type: "disabled" } : { type: "adaptive", display: "omitted" },
      output_config: { effort }
    }
  });

  return {
    schemaVersion: 1,
    displayName: "Legacy coding router",
    description: "Legacy v1 config",
    classifier: {
      provider: "openai",
      model: "route-classifier-cheap",
      reasoningEffort: "minimal",
      timeoutMs: 1500,
      maxAttempts: 2,
      allowRedactedExcerpt: true,
      structuredOutput: {
        mode: "json_schema",
        schemaName: "routing_classifier"
      }
    },
    routes: {
      fast: route("Fast", "gpt-fast", "claude-fast", "low"),
      balanced: route("Balanced", "gpt-balanced", "claude-balanced", "medium"),
      hard: {
        ...route("Hard", "gpt-hard", "claude-hard", "high"),
        openai: {
          model: "gpt-hard",
          reasoning: { effort: "high" },
          text: { verbosity: "medium" },
          maxOutputTokens: 1234
        },
        anthropic: {
          model: "claude-hard",
          thinking: { type: "adaptive", display: "omitted" },
          output_config: { effort: "high" },
          maxTokens: 4096,
          metadata: { retained: true }
        }
      },
      deep: route("Deep", "gpt-deep", "claude-deep", "xhigh")
    },
    limits: {
      maxRoute: "deep",
      fallbackRoute: "hard",
      maxEstimatedInputTokens: 200000
    },
    session: {
      pinInitialRoute: true,
      allowUpgrade: true,
      allowDowngrade: false
    }
  };
}

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
