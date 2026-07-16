import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { createPgliteDatabase } from "./client.js";
import { seedDatabase, seedOptionsFromEnv } from "./seed.js";
import { defaultWorkspaceId } from "./workspace.js";

describe("AI gateway runtime materialization migration", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
  });

  it("materializes an active workspace config and assigns its key", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(client);
    await apply(client, files.filter((file) => file >= "0027" && file <= "0030_ai_gateway_runtime_materialization.sql"));

    const rows = await client.query<{
      access_profile_id: string;
      logical_model: string;
      provider: string;
      model: string;
      wire: string;
    }>(`
      select
        k.access_profile_id,
        lm.slug as logical_model,
        pc.slug as provider,
        d.upstream_model_id as model,
        b.api_wire_id as wire
      from api_keys k
      join access_profile_model_grants g
        on g.access_profile_id = k.access_profile_id
       and g.organization_id = k.organization_id
       and g.workspace_id = k.workspace_id
      join logical_models lm on lm.id = g.logical_model_id
      join logical_model_targets t on t.logical_model_id = lm.id
      join model_deployments d on d.id = t.deployment_id
      join provider_connections pc on pc.id = d.provider_connection_id
      join deployment_wire_bindings b on b.deployment_id = d.id
      where k.id = 'legacy_key'
      order by model, wire
    `);

    expect(rows.rows).toEqual([
      {
        access_profile_id: expect.stringContaining(":access-profile:legacy-"),
        logical_model: "coding-auto",
        provider: "openai",
        model: "gpt-primary",
        wire: "openai-chat"
      },
      {
        access_profile_id: expect.stringContaining(":access-profile:legacy-"),
        logical_model: "coding-auto",
        provider: "openai",
        model: "gpt-primary",
        wire: "openai-responses"
      }
    ]);
    const connections = await client.query<{
      adapter_config: Record<string, unknown>;
      forward_harness_headers: boolean;
      platform_owned: boolean;
      secret_ref: string | null;
    }>(`
      select adapter_config, forward_harness_headers, platform_owned, secret_ref
      from provider_connections
      where id = 'legacy_workspace:connection:openai'
    `);
    expect(connections.rows).toEqual([{
      adapter_config: {},
      forward_harness_headers: true,
      platform_owned: true,
      secret_ref: "env:OPENAI_API_KEY"
    }]);
    const classifier = await client.query<{ router_config: Record<string, unknown> }>(`
      select router_config from logical_models where slug = 'coding-auto'
    `);
    expect(classifier.rows[0]?.router_config).toMatchObject({
      classifierDeploymentId: "legacy_workspace:deployment:openai:route-classifier-cheap",
      timeoutMs: 10000,
      maxAttempts: 2
    });
    const deployment = await client.query<{
      config: Record<string, unknown>;
      pricing: Record<string, unknown>;
    }>(`
      select config, pricing
      from model_deployments
      where upstream_model_id = 'gpt-primary'
    `);
    expect(deployment.rows[0]).toEqual({
      config: {
        timeoutMs: 60000,
        reasoning: { effort: "medium" },
        text: { verbosity: "low" },
        maxOutputTokens: 2048,
        metadata: { owner: "legacy" }
      },
      pricing: {
        inputCostPerMtok: 1,
        outputCostPerMtok: 2
      }
    });
    const canonical = await client.query<{ capabilities: Record<string, unknown> }>(`
      select capabilities
      from canonical_models
      where family = 'gpt-primary'
    `);
    expect(canonical.rows[0]?.capabilities).toEqual({
      contextWindow: 100000,
      modalities: ["text"],
      reasoning: true,
      tools: true
    });
  });

  it("does not overwrite migrated runtime resources when the seed runs afterward", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    const organizationId = "legacy_org";
    const workspaceId = defaultWorkspaceId(organizationId);
    const apiKeyId = `${organizationId}:api-key:default`;
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(
      client,
      false,
      undefined,
      undefined,
      "openai",
      workspaceId,
      apiKeyId
    );
    const config = {
      schemaVersion: 3,
      displayName: "Legacy router",
      classifier: {
        providerId: "openai",
        model: "route-classifier-cheap",
        timeoutMs: 10000,
        maxAttempts: 2
      },
      routes: {
        fast: anthropicRoute(),
        balanced: anthropicRoute(),
        hard: anthropicRoute(),
        deep: anthropicRoute()
      }
    };
    await client.exec(`
      insert into provider_accounts (
        id, organization_id, provider_id, name, secret_ref, status
      ) values (
        'legacy_anthropic_account', 'legacy_org',
        '00000000-0000-0000-0000-000000000002', 'Migrated Anthropic',
        'env:MIGRATED_ANTHROPIC_KEY', 'active'
      );
      update routing_config_versions
      set config = '${JSON.stringify(config).replaceAll("'", "''")}'
      where id = 'legacy_config_v1'
    `);
    await apply(client, files.filter((file) => (
      file >= "0027" && file <= "0030_ai_gateway_runtime_materialization.sql"
    )));
    const before = await runtimeSnapshot(client, workspaceId, apiKeyId);

    await seedDatabase(createPgliteDatabase(client), seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: organizationId,
      SEED_USER_ID: "seed_user",
      PROXY_TOKEN: "seed-token",
      CLASSIFIER_PROVIDER: "openai",
      CLASSIFIER_MODEL: "route-classifier-cheap"
    }));

    expect(await runtimeSnapshot(client, workspaceId, apiKeyId)).toEqual(before);
  });

  it("aborts instead of collapsing conflicting settings for one provider model", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(client, true);
    await apply(client, files.filter((file) => file >= "0027" && file < "0030_ai_gateway_runtime_materialization.sql"));

    await expect(client.exec(await readMigration("0030_ai_gateway_runtime_materialization.sql")))
      .rejects.toThrow("AI gateway cutover found conflicting settings for one provider model");
  });

  it("aborts instead of dropping a deployment base URL override", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(client, false, "https://override.example/v1");
    await apply(client, files.filter((file) => file >= "0027" && file < "0030_ai_gateway_runtime_materialization.sql"));

    await expect(client.exec(await readMigration("0030_ai_gateway_runtime_materialization.sql")))
      .rejects.toThrow("AI gateway cutover cannot preserve a deployment base URL override");
  });

  it("aborts instead of changing an OAuth credential into an API key", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(client);
    await client.exec("update provider_accounts set auth_type = 'oauth' where id = 'legacy_openai_account'");
    await client.exec(`
      insert into api_key_provider_accounts (
        organization_id, workspace_id, api_key_id, provider_id, provider_account_id
      ) values (
        'legacy_org', 'legacy_workspace', 'legacy_key',
        '00000000-0000-0000-0000-000000000001', 'legacy_openai_account'
      )
    `);
    await apply(client, files.filter((file) => file >= "0027" && file < "0030_ai_gateway_runtime_materialization.sql"));

    await expect(client.exec(await readMigration("0030_ai_gateway_runtime_materialization.sql")))
      .rejects.toThrow("AI gateway cutover cannot map OAuth provider credentials");
  });

  it("keeps an unbound built-in provider on its platform credential", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(client);
    await client.exec(`
      update provider_accounts
      set secret_ref = null,
          secret_ciphertext = 'sole-byok-ciphertext',
          secret_hint = 'byok'
      where id = 'legacy_openai_account'
    `);
    await apply(client, files.filter((file) => file >= "0027" && file <= "0030_ai_gateway_runtime_materialization.sql"));

    const connection = await client.query<{
      platform_owned: boolean;
      secret_ciphertext: string | null;
      secret_ref: string | null;
    }>(`
      select platform_owned, secret_ciphertext, secret_ref
      from provider_connections
      where id = 'legacy_workspace:connection:openai'
    `);
    expect(connection.rows).toEqual([{
      platform_owned: true,
      secret_ciphertext: null,
      secret_ref: "env:OPENAI_API_KEY"
    }]);
  });

  it("aborts instead of replacing a missing explicit account with a platform credential", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(client, false, undefined, "missing_account", "anthropic");
    await apply(client, files.filter((file) => file >= "0027" && file < "0030_ai_gateway_runtime_materialization.sql"));

    await expect(client.exec(await readMigration("0030_ai_gateway_runtime_materialization.sql")))
      .rejects.toThrow("AI gateway cutover could not resolve a provider adapter or credential");
  });

  it("aborts instead of replacing an inactive explicit account with a platform credential", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(client, false, undefined, "legacy_openai_account", "anthropic");
    await client.exec("update provider_accounts set status = 'disabled' where id = 'legacy_openai_account'");
    await apply(client, files.filter((file) => file >= "0027" && file < "0030_ai_gateway_runtime_materialization.sql"));

    await expect(client.exec(await readMigration("0030_ai_gateway_runtime_materialization.sql")))
      .rejects.toThrow("AI gateway cutover could not resolve a provider adapter or credential");
  });

  it("aborts instead of replacing a provider-mismatched explicit account with a platform credential", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(client, false, undefined, "legacy_anthropic_account", "anthropic");
    await client.exec(`
      insert into provider_accounts (
        id, organization_id, provider_id, name, secret_ref, status
      ) values (
        'legacy_anthropic_account', 'legacy_org',
        '00000000-0000-0000-0000-000000000002', 'Anthropic', 'env:ANTHROPIC_API_KEY', 'active'
      )
    `);
    await apply(client, files.filter((file) => file >= "0027" && file < "0030_ai_gateway_runtime_materialization.sql"));

    await expect(client.exec(await readMigration("0030_ai_gateway_runtime_materialization.sql")))
      .rejects.toThrow("AI gateway cutover could not resolve a provider adapter or credential");
  });

  it("aborts instead of treating a Bedrock account default chain as a platform credential", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(client);
    const config = {
      schemaVersion: 3,
      displayName: "Legacy Bedrock router",
      classifier: {
        providerId: "openai",
        model: "route-classifier-cheap",
        timeoutMs: 10000,
        maxAttempts: 2
      },
      routes: {
        fast: bedrockRoute(),
        balanced: bedrockRoute(),
        hard: bedrockRoute(),
        deep: bedrockRoute()
      }
    };
    await client.exec(`
      insert into providers (
        id, slug, display_name, base_url, adapter_kind, adapter_config,
        auth_style, endpoints, default_headers, capabilities, enabled
      ) values (
        '00000000-0000-0000-0000-000000000003', 'amazon-bedrock', 'Amazon Bedrock',
        'https://bedrock-runtime.us-east-1.amazonaws.com', 'aws-bedrock-converse',
        '{"credentialMode":"aws_default_chain","region":"us-east-1"}', 'aws-sdk',
        '[{"dialect":"bedrock-converse","operation":"Converse"}]', '{}', '{}', true
      );
      insert into provider_accounts (
        id, organization_id, provider_id, name, settings, status
      ) values (
        'legacy_bedrock_account', 'legacy_org',
        '00000000-0000-0000-0000-000000000003', 'Bedrock account',
        '{"credentialMode":"aws_default_chain","region":"us-east-1"}', 'active'
      );
      update routing_config_versions
      set config = '${JSON.stringify(config).replaceAll("'", "''")}'
      where id = 'legacy_config_v1';
    `);
    await apply(client, files.filter((file) => file >= "0027" && file < "0030_ai_gateway_runtime_materialization.sql"));

    await expect(client.exec(await readMigration("0030_ai_gateway_runtime_materialization.sql")))
      .rejects.toThrow("AI gateway cutover could not resolve a provider adapter or credential");
  });

  it("aborts when active traffic would require heterogeneous provider credentials", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(client);
    await client.exec(`
      insert into api_key_provider_accounts (
        organization_id, workspace_id, api_key_id, provider_id, provider_account_id
      ) values (
        'legacy_org', 'legacy_workspace', 'legacy_key',
        '00000000-0000-0000-0000-000000000001', 'legacy_openai_account'
      )
    `);
    await apply(client, files.filter((file) => file >= "0027" && file < "0030_ai_gateway_runtime_materialization.sql"));

    await expect(client.exec(await readMigration("0030_ai_gateway_runtime_materialization.sql")))
      .rejects.toThrow("AI gateway cutover cannot preserve heterogeneous provider credentials");
  });

  it("aborts instead of reusing a conflicting logical model", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0027"));
    await seedLegacyConfig(client);
    await apply(client, files.filter((file) => file >= "0027" && file < "0030_ai_gateway_runtime_materialization.sql"));
    await client.exec(`
      insert into logical_models (
        id, organization_id, workspace_id, slug, name,
        resolution_kind, router_kind, router_config, status
      ) values (
        'legacy_workspace:logical-model:coding-auto',
        'legacy_org',
        'legacy_workspace',
        'coding-auto',
        'Conflicting Coding Auto',
        'router',
        'classifier',
        '{"classifierDeploymentId":"wrong"}',
        'active'
      );
    `);

    await expect(client.exec(await readMigration("0030_ai_gateway_runtime_materialization.sql")))
      .rejects.toThrow("AI gateway cutover found a conflicting logical model");
  });

  it("aborts when an active key has no mappable config", async () => {
    client = new PGlite();
    const files = await migrationFiles();
    await apply(client, files.filter((file) => file < "0030_ai_gateway_runtime_materialization.sql"));
    await client.exec(`
      insert into organizations (id, slug, name)
      values ('unmapped_org', 'unmapped-org', 'Unmapped Org');
      insert into workspaces (id, organization_id, slug, name)
      values ('unmapped_workspace', 'unmapped_org', 'default', 'Default');
      insert into api_keys (
        id, organization_id, workspace_id, key_hash, name
      ) values (
        'unmapped_key', 'unmapped_org', 'unmapped_workspace', 'unmapped_hash', 'Unmapped'
      );
    `);

    const migration = await readMigration("0030_ai_gateway_runtime_materialization.sql");
    await expect(client.exec(migration)).rejects.toThrow(
      "AI gateway cutover left an active API key without an access profile"
    );
  });
});

async function seedLegacyConfig(
  client: PGlite,
  conflictingSettings = false,
  deploymentBaseUrl?: string,
  providerAccountId?: string,
  classifierProvider = "openai",
  workspaceId = "legacy_workspace",
  apiKeyId = "legacy_key"
) {
  const config = {
    schemaVersion: 3,
    displayName: "Legacy router",
    classifier: {
      providerId: classifierProvider,
      model: classifierProvider === "openai" ? "route-classifier-cheap" : "claude-classifier-cheap",
      timeoutMs: 10000,
      maxAttempts: 2
    },
    routes: {
      fast: route("medium", deploymentBaseUrl, providerAccountId),
      balanced: route(conflictingSettings ? "high" : "medium", deploymentBaseUrl, providerAccountId),
      hard: route("medium", deploymentBaseUrl, providerAccountId),
      deep: route("medium", deploymentBaseUrl, providerAccountId)
    }
  };
  await client.exec(`
    insert into organizations (id, slug, name)
    values ('legacy_org', 'legacy-org', 'Legacy Org');
    insert into workspaces (id, organization_id, slug, name)
    values ('${workspaceId}', 'legacy_org', 'default', 'Default');
    update providers set
      base_url = 'https://api.openai.com/v1',
      adapter_kind = 'generic-http-json',
      auth_style = 'bearer',
      endpoints = '[{"dialect":"openai-responses","path":"/responses"},{"dialect":"openai-chat","path":"/chat/completions"}]',
      enabled = true
    where id = '00000000-0000-0000-0000-000000000001';
    insert into provider_accounts (
      id, organization_id, provider_id, name, secret_ref, status
    ) values (
      'legacy_openai_account', 'legacy_org',
      '00000000-0000-0000-0000-000000000001', 'OpenAI', 'env:OPENAI_API_KEY', 'active'
    );
    insert into model_catalog (
      id, organization_id, provider_id, model, capabilities, pricing
    ) values (
      'legacy_pricing', 'legacy_org',
      '00000000-0000-0000-0000-000000000001', 'gpt-primary',
      '{"source":"models.dev-snapshot","tools":true,"reasoning":true,"contextWindow":100000,"modalities":["text"],"metadata":{"nested":true},"zero":0,"mixed":["text",1]}',
      '{"inputCostPerMtok":1,"outputCostPerMtok":2}'
    );
    insert into routing_configs (
      id, organization_id, workspace_id, name, slug, status
    ) values (
      'legacy_config', 'legacy_org', '${workspaceId}', 'Legacy Config', 'legacy', 'active'
    );
    insert into routing_config_versions (
      id, organization_id, workspace_id, routing_config_id, version,
      config_hash, config, status, activated_at
    ) values (
      'legacy_config_v1', 'legacy_org', '${workspaceId}', 'legacy_config', 1,
      'legacy_hash', '${JSON.stringify(config).replaceAll("'", "''")}', 'active', now()
    );
    update routing_configs set active_version_id = 'legacy_config_v1'
      where id = 'legacy_config';
    update workspaces set default_routing_config_id = 'legacy_config'
      where id = '${workspaceId}';
    insert into api_keys (
      id, organization_id, workspace_id, key_hash, name, routing_config_id
    ) values (
      '${apiKeyId}', 'legacy_org', '${workspaceId}', 'legacy_hash_key', 'Legacy Key', 'legacy_config'
    );
  `);
}

async function runtimeSnapshot(client: PGlite, workspaceId: string, apiKeyId: string) {
  const connection = await client.query<{
    adapter_config: Record<string, unknown>;
    platform_owned: boolean;
    secret_ciphertext: string | null;
    secret_ref: string | null;
  }>(`
    select adapter_config, platform_owned, secret_ciphertext, secret_ref
    from provider_connections
    where id = '${workspaceId}:connection:anthropic'
  `);
  const logicalModel = await client.query<{ router_config: Record<string, unknown> }>(`
    select router_config
    from logical_models
    where organization_id = 'legacy_org'
      and workspace_id = '${workspaceId}'
      and slug = 'coding-auto'
  `);
  const targets = await client.query<{
    deployment_id: string;
    enabled: boolean;
    priority: number;
  }>(`
    select t.deployment_id, t.enabled, t.priority
    from logical_model_targets t
    join logical_models lm on lm.id = t.logical_model_id
    where lm.organization_id = 'legacy_org'
      and lm.workspace_id = '${workspaceId}'
      and lm.slug = 'coding-auto'
    order by t.priority, t.deployment_id
  `);
  const key = await client.query<{ access_profile_id: string | null }>(`
    select access_profile_id from api_keys where id = '${apiKeyId}'
  `);
  return {
    connection: connection.rows[0],
    routerConfig: logicalModel.rows[0]?.router_config,
    targets: targets.rows,
    accessProfileId: key.rows[0]?.access_profile_id
  };
}

function route(effort = "medium", baseUrl?: string, providerAccountId?: string) {
  return {
    retry: { maxAttempts: 1, retryableStatusCodes: [429, 500] },
    openai: {
      deployments: [{
        provider: "openai",
        model: "gpt-primary",
        ...(baseUrl ? { baseUrl } : {}),
        ...(providerAccountId ? { providerAccountId } : {}),
        order: 0,
        weight: 1,
        timeoutMs: 60000,
        reasoning: { effort },
        text: { verbosity: "low" },
        maxOutputTokens: 2048,
        metadata: { owner: "legacy" }
      }]
    }
  };
}

function bedrockRoute() {
  return {
    retry: { maxAttempts: 1, retryableStatusCodes: [429, 500] },
    bedrock: {
      deployments: [{
        provider: "amazon-bedrock",
        model: "amazon.nova-pro-v1:0",
        providerAccountId: "legacy_bedrock_account",
        order: 0,
        weight: 1,
        timeoutMs: 60000
      }]
    }
  };
}

function anthropicRoute() {
  return {
    retry: { maxAttempts: 1, retryableStatusCodes: [429, 500] },
    anthropic: {
      deployments: [{
        provider: "anthropic",
        model: "claude-migrated",
        providerAccountId: "legacy_anthropic_account",
        order: 0,
        weight: 1,
        timeoutMs: 60000
      }]
    }
  };
}

async function migrationFiles() {
  const directory = migrationsDirectory();
  return (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
}

async function apply(client: PGlite, files: string[]) {
  for (const file of files) await client.exec(await readMigration(file));
}

function readMigration(file: string) {
  return readFile(join(migrationsDirectory(), file), "utf8");
}

function migrationsDirectory() {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}
