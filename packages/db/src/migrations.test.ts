import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { createPgliteDatabase } from "./client.js";
import { seedDatabase, seedOptionsFromEnv } from "./seed.js";

describe("database migrations", () => {
  it("applies the complete migration chain", async () => {
    const client = await migratedClient();
    const result = await client.query("select count(*)::int as count from organizations");
    const tables = await client.query<{ table_name: string }>(`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'access_profile_model_grants',
          'access_profiles',
          'canonical_models',
          'deployment_health',
          'deployment_wire_bindings',
          'logical_model_targets',
          'logical_models',
          'model_deployments',
          'provider_connection_health',
          'provider_connections'
        )
      order by table_name
    `);
    await client.close();

    expect(result.rows[0]).toEqual({ count: 0 });
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "access_profile_model_grants",
      "access_profiles",
      "canonical_models",
      "deployment_health",
      "deployment_wire_bindings",
      "logical_model_targets",
      "logical_models",
      "model_deployments",
      "provider_connection_health",
      "provider_connections"
    ]);
  });

  it("materializes only gateway request and decision evidence", async () => {
    const client = await migratedClient();
    const requestColumns = await columns(client, "requests");
    const decisionColumns = await columns(client, "route_decisions");
    const attemptColumns = await columns(client, "provider_attempts");
    const sessionColumns = await columns(client, "agent_sessions");
    await client.close();

    expect(requestColumns).toEqual(expect.arrayContaining([
      "access_profile_id",
      "deployment_id",
      "egress_wire_id",
      "ingress_wire_id",
      "operation_id",
      "provider_connection_id",
      "requested_logical_model",
      "resolved_logical_model_id",
      "router_kind",
      "wire_adapter_version"
    ]));
    expect(decisionColumns).toEqual(expect.arrayContaining([
      "access_profile_id",
      "deployment_id",
      "provider_connection_id",
      "requested_logical_model",
      "resolved_logical_model_id",
      "router_decision",
      "router_decision_id"
    ]));
    expect(attemptColumns).toEqual(expect.arrayContaining([
      "deployment_id",
      "provider_adapter_contract_version",
      "provider_connection_id"
    ]));
    expect(sessionColumns).toEqual(expect.arrayContaining([
      "external_session_id",
      "metadata",
      "request_count",
      "surface"
    ]));
  });

  it("enforces workspace-scoped deployment health references", async () => {
    const client = await migratedClient();
    await client.exec(`
      insert into organizations (id, slug, name) values ('org_a', 'org-a', 'Org A');
      insert into workspaces (id, organization_id, slug, name)
      values ('workspace_a', 'org_a', 'default', 'Default');
      insert into provider_connections (
        id, organization_id, workspace_id, provider, slug, name, adapter_kind, auth_style, base_url
      ) values (
        'connection_a', 'org_a', 'workspace_a', 'openai', 'openai', 'OpenAI',
        'generic-http-json', 'bearer', 'https://api.openai.com/v1'
      );
      insert into canonical_models (
        id, organization_id, workspace_id, slug, name, vendor, family
      ) values (
        'model_a', 'org_a', 'workspace_a', 'gpt-test', 'GPT Test', 'openai', 'gpt'
      );
      insert into model_deployments (
        id, organization_id, workspace_id, slug, name, canonical_model_id,
        provider_connection_id, upstream_model_id
      ) values (
        'deployment_a', 'org_a', 'workspace_a', 'gpt-test-openai', 'GPT Test OpenAI',
        'model_a', 'connection_a', 'gpt-test'
      );
      insert into deployment_health (
        id, organization_id, workspace_id, deployment_id, provider_connection_id, status
      ) values (
        'health_a', 'org_a', 'workspace_a', 'deployment_a', 'connection_a', 'healthy'
      );
    `);

    await expect(client.exec(`
      insert into deployment_health (
        id, organization_id, workspace_id, deployment_id, provider_connection_id, status
      ) values (
        'health_invalid', 'org_a', 'workspace_a', 'deployment_a', 'missing', 'healthy'
      );
    `)).rejects.toThrow();
    await client.close();
  });

  it("materializes legacy traffic and preserves health from only its selected account", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client);

    await applyMigration(client, "0030_ai_gateway_runtime_materialization.sql");
    const materialized = await client.query<{
      access_profile_id: string;
      deployment_id: string;
      legacy_provider_account_id: string;
    }>(`
      select
        key.access_profile_id,
        target.deployment_id,
        connection.legacy_provider_account_id
      from api_keys key
      join access_profile_model_grants grant_row
        on grant_row.organization_id = key.organization_id
       and grant_row.workspace_id = key.workspace_id
       and grant_row.access_profile_id = key.access_profile_id
      join logical_model_targets target
        on target.organization_id = grant_row.organization_id
       and target.workspace_id = grant_row.workspace_id
       and target.logical_model_id = grant_row.logical_model_id
      join model_deployments deployment
        on deployment.organization_id = target.organization_id
       and deployment.workspace_id = target.workspace_id
       and deployment.id = target.deployment_id
      join provider_connections connection
        on connection.organization_id = deployment.organization_id
       and connection.workspace_id = deployment.workspace_id
       and connection.id = deployment.provider_connection_id
      where key.id = 'legacy_key'
    `);
    expect(materialized.rows).toEqual([{
      access_profile_id: expect.stringContaining("legacy_org:workspace:default:access-profile:legacy-"),
      deployment_id: "legacy_org:workspace:default:deployment:anthropic:claude-health",
      legacy_provider_account_id: "account_selected"
    }]);

    await applyMigration(client, "0031_remove_coding_tier_model.sql");
    const connectionHealth = await client.query<{ status: string; metadata: { source: string } }>(`
      select status, metadata from provider_connection_health
      where provider_connection_id = 'legacy_org:workspace:default:connection:anthropic'
    `);
    const deploymentHealth = await client.query<{ status: string; metadata: { source: string } }>(`
      select status, metadata from deployment_health
      where deployment_id = 'legacy_org:workspace:default:deployment:anthropic:claude-health'
    `);

    expect(connectionHealth.rows).toEqual([{ status: "healthy", metadata: { source: "selected" } }]);
    expect(deploymentHealth.rows).toEqual([{ status: "healthy", metadata: { source: "selected" } }]);
    expect(await columns(client, "provider_connections")).not.toContain("legacy_provider_account_id");

    const beforeSeed = await migratedGatewaySnapshot(client);
    await seedDatabase(createPgliteDatabase(client), seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "legacy_org",
      SEED_USER_ID: "seed_user",
      PROXY_TOKEN: "seed-token",
      GATEWAY_SEED_CLASSIFIER_MODEL: "route-classifier-cheap"
    }));
    expect(await migratedGatewaySnapshot(client)).toEqual(beforeSeed);
    await client.close();
  });

  it("fails closed when legacy routes conflict for one provider model", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client, { conflictingSettings: true });

    await expect(applyMigration(client, "0030_ai_gateway_runtime_materialization.sql"))
      .rejects.toThrow("AI gateway cutover found conflicting settings for one provider model");
    await client.close();
  });

  it("fails closed when a legacy deployment overrides its provider base URL", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client, { deploymentBaseUrl: "https://override.example/v1" });

    await expect(applyMigration(client, "0030_ai_gateway_runtime_materialization.sql"))
      .rejects.toThrow("AI gateway cutover cannot preserve a deployment base URL override");
    await client.close();
  });

  it("fails closed when a selected legacy provider account uses OAuth", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client);
    await client.exec("update provider_accounts set auth_type = 'oauth' where id = 'account_selected'");

    await expect(applyMigration(client, "0030_ai_gateway_runtime_materialization.sql"))
      .rejects.toThrow("AI gateway cutover cannot map OAuth provider credentials");
    await client.close();
  });

  it("fails closed instead of replacing a missing explicit account", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client, { providerAccountId: "missing_account" });

    await expect(applyMigration(client, "0030_ai_gateway_runtime_materialization.sql"))
      .rejects.toThrow("AI gateway cutover could not resolve a provider adapter or credential");
    await client.close();
  });

  it("fails closed instead of replacing an inactive explicit account", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client);
    await client.exec("update provider_accounts set status = 'disabled' where id = 'account_selected'");

    await expect(applyMigration(client, "0030_ai_gateway_runtime_materialization.sql"))
      .rejects.toThrow("AI gateway cutover could not resolve a provider adapter or credential");
    await client.close();
  });

  it("fails closed instead of replacing a provider-mismatched explicit account", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client, { providerAccountId: "account_mismatched" });

    await expect(applyMigration(client, "0030_ai_gateway_runtime_materialization.sql"))
      .rejects.toThrow("AI gateway cutover could not resolve a provider adapter or credential");
    await client.close();
  });

  it("keeps unbound built-in providers on platform credentials", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client, { providerAccountId: null });
    await client.exec(`
      update provider_accounts
      set secret_ref = null,
          secret_ciphertext = 'unbound-byok-ciphertext',
          secret_hint = 'unbound-byok'
      where id = 'account_selected'
    `);

    await applyMigration(client, "0030_ai_gateway_runtime_materialization.sql");
    const connection = await client.query<{
      platform_owned: boolean;
      secret_ciphertext: string | null;
      secret_ref: string | null;
    }>(`
      select platform_owned, secret_ciphertext, secret_ref
      from provider_connections
      where id = 'legacy_org:workspace:default:connection:anthropic'
    `);
    expect(connection.rows).toEqual([{
      platform_owned: true,
      secret_ciphertext: null,
      secret_ref: "env:ANTHROPIC_API_KEY"
    }]);
    await client.close();
  });

  it("fails closed when active keys require heterogeneous credentials", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client, { providerAccountId: null });
    await client.exec(`
      insert into api_keys (
        id, organization_id, workspace_id, key_hash, name, routing_config_id
      ) values (
        'legacy_key_unbound', 'legacy_org', 'legacy_org:workspace:default',
        'legacy_hash_key_unbound', 'Legacy Unbound Key', 'legacy_config'
      );
      insert into api_key_provider_accounts (
        organization_id, workspace_id, api_key_id, provider_id, provider_account_id
      ) values (
        'legacy_org', 'legacy_org:workspace:default', 'legacy_key',
        '00000000-0000-0000-0000-000000000002', 'account_selected'
      )
    `);

    await expect(applyMigration(client, "0030_ai_gateway_runtime_materialization.sql"))
      .rejects.toThrow("AI gateway cutover cannot preserve heterogeneous provider credentials");
    await client.close();
  });

  it("fails closed for a selected Bedrock default-chain account", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client);
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
        fast: legacyBedrockRoute(),
        balanced: legacyBedrockRoute(),
        hard: legacyBedrockRoute(),
        deep: legacyBedrockRoute()
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
      where id = 'legacy_config_v1'
    `);

    await expect(applyMigration(client, "0030_ai_gateway_runtime_materialization.sql"))
      .rejects.toThrow("AI gateway cutover could not resolve a provider adapter or credential");
    await client.close();
  });

  it("fails closed instead of reusing a conflicting logical model", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client);
    await client.exec(`
      insert into logical_models (
        id, organization_id, workspace_id, slug, name,
        resolution_kind, router_kind, router_config, status
      ) values (
        'legacy_org:workspace:default:logical-model:coding-auto',
        'legacy_org',
        'legacy_org:workspace:default',
        'coding-auto',
        'Conflicting Coding Auto',
        'router',
        'classifier',
        '{"classifierDeploymentId":"wrong"}',
        'active'
      )
    `);

    await expect(applyMigration(client, "0030_ai_gateway_runtime_materialization.sql"))
      .rejects.toThrow("AI gateway cutover found a conflicting logical model");
    await client.close();
  });

  it("fails closed when an active key has no mappable config", async () => {
    const client = await migratedClient("0029_ai_gateway_resolution_evidence.sql");
    await seedLegacyGatewayConfig(client);
    await client.exec(`
      insert into workspaces (id, organization_id, slug, name)
      values ('workspace_unmapped', 'legacy_org', 'unmapped', 'Unmapped');
      insert into api_keys (
        id, organization_id, workspace_id, key_hash, name
      ) values (
        'key_unmapped', 'legacy_org', 'workspace_unmapped', 'hash_unmapped', 'Unmapped'
      )
    `);

    await expect(applyMigration(client, "0030_ai_gateway_runtime_materialization.sql"))
      .rejects.toThrow("AI gateway cutover left an active API key without an access profile");
    await client.close();
  });
});

async function seedLegacyGatewayConfig(
  client: PGlite,
  options: {
    conflictingSettings?: boolean;
    deploymentBaseUrl?: string;
    providerAccountId?: string | null;
  } = {}
) {
  const providerAccountId = options.providerAccountId === undefined
    ? "account_selected"
    : options.providerAccountId;
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
      fast: legacyAnthropicRoute(60000, options.deploymentBaseUrl, providerAccountId),
      balanced: legacyAnthropicRoute(
        options.conflictingSettings ? 61000 : 60000,
        options.deploymentBaseUrl,
        providerAccountId
      ),
      hard: legacyAnthropicRoute(60000, options.deploymentBaseUrl, providerAccountId),
      deep: legacyAnthropicRoute(60000, options.deploymentBaseUrl, providerAccountId)
    }
  };
  await client.exec(`
    insert into organizations (id, slug, name)
    values ('legacy_org', 'legacy-org', 'Legacy Org');
    insert into workspaces (id, organization_id, slug, name)
    values ('legacy_org:workspace:default', 'legacy_org', 'default', 'Default');

    insert into provider_accounts (
      id, organization_id, provider_id, name, auth_type, secret_ref, status
    ) values
      (
        'account_selected', 'legacy_org', '00000000-0000-0000-0000-000000000002',
        'Selected', 'api_key', 'env:SELECTED_KEY', 'active'
      ),
      (
        'account_unrelated', 'legacy_org', '00000000-0000-0000-0000-000000000002',
        'Unrelated', 'api_key', 'env:UNRELATED_KEY', 'active'
      ),
      (
        'account_mismatched', 'legacy_org', '00000000-0000-0000-0000-000000000001',
        'Mismatched', 'api_key', 'env:MISMATCHED_KEY', 'active'
      );
    insert into model_catalog (
      id, organization_id, provider_id, model, capabilities, pricing
    ) values (
      'legacy_catalog', 'legacy_org', '00000000-0000-0000-0000-000000000002',
      'claude-health', '{"tools":true,"contextWindow":100000}',
      '{"inputCostPerMtok":1,"outputCostPerMtok":2}'
    );
    insert into routing_configs (
      id, organization_id, workspace_id, name, slug, status
    ) values (
      'legacy_config', 'legacy_org', 'legacy_org:workspace:default', 'Legacy Config', 'legacy', 'active'
    );
    insert into routing_config_versions (
      id, organization_id, workspace_id, routing_config_id, version,
      config_hash, config, status, activated_at
    ) values (
      'legacy_config_v1', 'legacy_org', 'legacy_org:workspace:default', 'legacy_config', 1,
      'legacy_hash', '${JSON.stringify(config).replaceAll("'", "''")}', 'active', now()
    );
    update routing_configs set active_version_id = 'legacy_config_v1'
    where id = 'legacy_config';
    update workspaces set default_routing_config_id = 'legacy_config'
    where id = 'legacy_org:workspace:default';
    insert into api_keys (
      id, organization_id, workspace_id, key_hash, name, routing_config_id
    ) values (
      'legacy_key', 'legacy_org', 'legacy_org:workspace:default', 'legacy_hash_key',
      'Legacy Key', 'legacy_config'
    );

    insert into provider_account_health (
      id, organization_id, workspace_id, provider_account_id, provider_id,
      status, last_checked_at, metadata
    ) values
      (
        'account_health_selected', 'legacy_org', 'legacy_org:workspace:default', 'account_selected',
        '00000000-0000-0000-0000-000000000002', 'healthy',
        '2025-01-01T00:00:00Z', '{"source":"selected"}'
      ),
      (
        'account_health_unrelated', 'legacy_org', 'legacy_org:workspace:default', 'account_unrelated',
        '00000000-0000-0000-0000-000000000002', 'terminal',
        '2026-01-01T00:00:00Z', '{"source":"unrelated"}'
      );
    insert into provider_model_health (
      id, organization_id, workspace_id, provider_id, provider_account_id,
      model, status, last_error_at, metadata
    ) values
      (
        'model_health_selected', 'legacy_org', 'legacy_org:workspace:default',
        '00000000-0000-0000-0000-000000000002', 'account_selected',
        'claude-health', 'healthy', '2025-01-01T00:00:00Z', '{"source":"selected"}'
      ),
      (
        'model_health_unrelated', 'legacy_org', 'legacy_org:workspace:default',
        '00000000-0000-0000-0000-000000000002', 'account_unrelated',
        'claude-health', 'locked_out', '2026-01-01T00:00:00Z', '{"source":"unrelated"}'
      );
  `);
}

function legacyAnthropicRoute(
  timeoutMs: number,
  baseUrl: string | undefined,
  providerAccountId: string | null
) {
  return {
    retry: { maxAttempts: 1, retryableStatusCodes: [429, 500] },
    anthropic: {
      deployments: [{
        provider: "anthropic",
        model: "claude-health",
        ...(providerAccountId ? { providerAccountId } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        order: 0,
        weight: 1,
        timeoutMs
      }]
    }
  };
}

function legacyBedrockRoute() {
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

async function migratedGatewaySnapshot(client: PGlite) {
  const connection = await client.query<{
    adapter_config: Record<string, unknown>;
    default_headers: Record<string, unknown>;
    platform_owned: boolean;
    secret_ciphertext: string | null;
    secret_hint: string | null;
    secret_ref: string | null;
  }>(`
    select
      adapter_config,
      default_headers,
      platform_owned,
      secret_ciphertext,
      secret_hint,
      secret_ref
    from provider_connections
    where id = 'legacy_org:workspace:default:connection:anthropic'
  `);
  const logicalModel = await client.query<{
    router_config: Record<string, unknown>;
  }>(`
    select router_config
    from logical_models
    where id = 'legacy_org:workspace:default:logical-model:coding-auto'
  `);
  const targets = await client.query<{
    deployment_id: string;
    enabled: boolean;
    priority: number;
  }>(`
    select deployment_id, enabled, priority
    from logical_model_targets
    where logical_model_id = 'legacy_org:workspace:default:logical-model:coding-auto'
    order by priority, deployment_id
  `);
  const key = await client.query<{ access_profile_id: string | null }>(`
    select access_profile_id from api_keys where id = 'legacy_key'
  `);
  return {
    connection: connection.rows[0],
    routerConfig: logicalModel.rows[0]?.router_config,
    targets: targets.rows,
    accessProfileId: key.rows[0]?.access_profile_id
  };
}

async function migratedClient(lastMigration?: string) {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    await applyMigration(client, file);
    if (file === lastMigration) break;
  }
  return client;
}

async function applyMigration(client: PGlite, file: string) {
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  await client.exec(await readFile(join(migrationsDir, file), "utf8"));
}

async function columns(client: PGlite, tableName: string) {
  const result = await client.query<{ column_name: string }>(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = '${tableName}'
    order by column_name
  `);
  return result.rows.map((row) => row.column_name);
}
