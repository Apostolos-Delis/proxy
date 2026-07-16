import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { createPgliteDatabase } from "./client.js";
import { seedGatewayResources } from "./gatewaySeed.js";
import { seedDatabase, seedOptionsFromEnv } from "./seed.js";
import { defaultWorkspaceId } from "./workspace.js";

describe("AI gateway seed", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    const current = client;
    client = undefined;
    await current?.close();
  });

  it("seeds bounded logical models without overwriting operator state on rerun", async () => {
    client = await migratedClient();
    const db = createPgliteDatabase(client);
    const options = seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_gateway_seed",
      SEED_USER_ID: "user_gateway_seed",
      PROXY_TOKEN: "gateway-seed-token",
      SEED_EXTERNAL_ECONOMY_TOKEN: "gateway-external-economy-token"
    });

    await seedDatabase(db, options);
    const firstCounts = await resourceCounts(client, options.organizationId);
    await client.exec(`
      update logical_model_targets
      set enabled = false
      where logical_model_id = '${defaultWorkspaceId(options.organizationId)}:logical-model:fable'
    `);
    await seedDatabase(db, options);
    const secondCounts = await resourceCounts(client, options.organizationId);

    expect(secondCounts).toEqual(firstCounts);
    expect(secondCounts).toEqual({
      connections: 3,
      canonicalModels: 8,
      deployments: 8,
      bindings: 11,
      logicalModels: 3,
      targets: 10,
      profiles: 2,
      grants: 4
    });

    const logicalRows = await client.query<{
      slug: string;
      resolution_kind: string;
      router_kind: string | null;
      upstream_model_id: string;
      priority: number;
      enabled: boolean;
    }>(`
      select lm.slug, lm.resolution_kind, lm.router_kind, md.upstream_model_id, lmt.priority, lmt.enabled
      from logical_models lm
      join logical_model_targets lmt on lmt.logical_model_id = lm.id
      join model_deployments md on md.id = lmt.deployment_id
      where lm.organization_id = '${options.organizationId}'
      order by lm.slug, lmt.priority
    `);
    const fableRows = logicalRows.rows.filter((row) => row.slug === "fable");
    const codingRows = logicalRows.rows.filter((row) => row.slug === "coding-auto");
    const economyRows = logicalRows.rows.filter((row) => row.slug === "economy-auto");

    expect(fableRows).toEqual([{
      slug: "fable",
      resolution_kind: "direct",
      router_kind: null,
      upstream_model_id: "claude-fable-5",
      priority: 0,
      enabled: false
    }]);
    expect(codingRows).toHaveLength(7);
    expect(codingRows.every((row) => row.resolution_kind === "router" && row.router_kind === "classifier")).toBe(true);
    expect(codingRows.map((row) => row.upstream_model_id)).toContain("claude-fable-5");
    expect(codingRows.map((row) => row.upstream_model_id)).not.toContain(options.classifierModel);
    expect(economyRows.map((row) => row.upstream_model_id)).toEqual([
      "gpt-5.4-mini",
      "claude-haiku-4-5"
    ]);

    const [fableCapabilities] = (await client.query<{ capabilities: { contextWindow: number } }>(`
      select cm.capabilities
      from canonical_models cm
      join model_deployments md on md.canonical_model_id = cm.id
      where cm.workspace_id = '${defaultWorkspaceId(options.organizationId)}'
        and md.upstream_model_id = 'claude-fable-5'
    `)).rows;
    expect(fableCapabilities?.capabilities.contextWindow).toBe(1_000_000);

    const routerConfigs = await client.query<{ slug: string; router_config: Record<string, unknown> }>(`
      select slug, router_config
      from logical_models
      where organization_id = '${options.organizationId}' and resolution_kind = 'router'
      order by slug
    `);
    expect(routerConfigs.rows).toEqual([
      {
        slug: "coding-auto",
        router_config: {
          classifierDeploymentId: `${defaultWorkspaceId(options.organizationId)}:deployment:openai:${options.classifierModel}`,
          instructions: expect.stringContaining("Select exactly one eligible target"),
          timeoutMs: options.classifierTimeoutMs,
          maxAttempts: options.classifierMaxAttempts
        }
      },
      {
        slug: "economy-auto",
        router_config: {
          classifierDeploymentId: `${defaultWorkspaceId(options.organizationId)}:deployment:openai:${options.classifierModel}`,
          instructions: expect.stringContaining("Select exactly one eligible target"),
          timeoutMs: options.classifierTimeoutMs,
          maxAttempts: options.classifierMaxAttempts
        }
      }
    ]);

    const grants = await client.query<{ profile: string; logical_model: string }>(`
      select ap.slug as profile, lm.slug as logical_model
      from access_profile_model_grants g
      join access_profiles ap on ap.id = g.access_profile_id
      join logical_models lm on lm.id = g.logical_model_id
      where g.organization_id = '${options.organizationId}'
      order by ap.slug, lm.slug
    `);
    expect(grants.rows).toEqual([
      { profile: "external-economy", logical_model: "economy-auto" },
      { profile: "opendoor-engineer", logical_model: "coding-auto" },
      { profile: "opendoor-engineer", logical_model: "economy-auto" },
      { profile: "opendoor-engineer", logical_model: "fable" }
    ]);

    const keys = await client.query<{ name: string; profile: string; revoked: boolean }>(`
      select ak.name, ap.slug as profile, ak.revoked_at is not null as revoked
      from api_keys ak
      join access_profiles ap on ap.id = ak.access_profile_id
      where ak.organization_id = '${options.organizationId}'
      order by ak.name
    `);
    expect(keys.rows).toEqual([
      { name: "Default local API key", profile: "opendoor-engineer", revoked: false },
      { name: "External economy seed key", profile: "external-economy", revoked: false }
    ]);
    const externalTargets = await client.query<{ upstream_model_id: string }>(`
      select md.upstream_model_id
      from api_keys ak
      join access_profile_model_grants g on g.access_profile_id = ak.access_profile_id
      join logical_model_targets lmt on lmt.logical_model_id = g.logical_model_id
      join model_deployments md on md.id = lmt.deployment_id
      where ak.name = 'External economy seed key'
      order by lmt.priority
    `);
    expect(externalTargets.rows.map((row) => row.upstream_model_id)).toEqual([
      "gpt-5.4-mini",
      "claude-haiku-4-5"
    ]);

    const connections = await client.query<{
      provider: string;
      slug: string;
      capabilities: Record<string, unknown>;
      secret_ref: string | null;
      secret_ciphertext: string | null;
    }>(`
      select provider, slug, capabilities, secret_ref, secret_ciphertext
      from provider_connections
      where organization_id = '${options.organizationId}'
      order by slug
    `);
    expect(connections.rows.map(({ capabilities: _capabilities, ...row }) => row)).toEqual([
      { provider: "amazon-bedrock", slug: "amazon-bedrock", secret_ref: null, secret_ciphertext: null },
      { provider: "anthropic", slug: "anthropic", secret_ref: "env:ANTHROPIC_API_KEY", secret_ciphertext: null },
      { provider: "openai", slug: "openai", secret_ref: "env:OPENAI_API_KEY", secret_ciphertext: null }
    ]);
    expect(connections.rows.find((row) => row.provider === "openai")?.capabilities).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh"],
      promptCaching: { usageShape: "openai" }
    });

    const [beforeCapabilities] = (await client.query<{ capabilities: Record<string, unknown> }>(`
      select cm.capabilities
      from canonical_models cm
      join model_deployments md on md.canonical_model_id = cm.id
      where cm.workspace_id = '${defaultWorkspaceId(options.organizationId)}'
        and md.upstream_model_id = 'gpt-5.4-mini'
    `)).rows;
    await seedGatewayResources(db, gatewayInput(options, defaultWorkspaceId(options.organizationId)), [{
      provider: "openai",
      model: "gpt-5.4-mini",
      capabilities: { contextWindow: 1 },
      pricing: { source: "changed-test-snapshot" }
    }]);
    const [afterCapabilities] = (await client.query<{ capabilities: Record<string, unknown> }>(`
      select cm.capabilities
      from canonical_models cm
      join model_deployments md on md.canonical_model_id = cm.id
      where cm.workspace_id = '${defaultWorkspaceId(options.organizationId)}'
        and md.upstream_model_id = 'gpt-5.4-mini'
    `)).rows;
    expect(afterCapabilities).toEqual(beforeCapabilities);
  });

  it("keeps economy targets independent from additional coding models", async () => {
    client = await migratedClient();
    const db = createPgliteDatabase(client);
    const options = seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_gateway_economy",
      SEED_USER_ID: "user_gateway_economy",
      PROXY_TOKEN: "gateway-economy-token"
    });
    options.models = [
      ...options.models,
      { provider: "openai", model: "gpt-5.5-pro", surface: "openai-responses" },
      { provider: "anthropic", model: "claude-fable-5", surface: "anthropic-messages" }
    ];

    await seedDatabase(db, options);

    const targets = await client.query<{ logical_model: string; upstream_model_id: string }>(`
      select lm.slug as logical_model, md.upstream_model_id
      from logical_models lm
      join logical_model_targets lmt on lmt.logical_model_id = lm.id
      join model_deployments md on md.id = lmt.deployment_id
      where lm.organization_id = '${options.organizationId}'
        and lm.slug in ('coding-auto', 'economy-auto')
      order by lm.slug, lmt.priority
    `);
    const economyTargets = targets.rows
      .filter((row) => row.logical_model === "economy-auto")
      .map((row) => row.upstream_model_id);
    const codingTargets = targets.rows
      .filter((row) => row.logical_model === "coding-auto")
      .map((row) => row.upstream_model_id);

    expect(economyTargets).toEqual(["gpt-5.4-mini", "claude-haiku-4-5"]);
    expect(economyTargets).not.toContain("gpt-5.5-pro");
    expect(economyTargets).not.toContain("claude-fable-5");
    expect(codingTargets).toContain("gpt-5.5-pro");
    expect(codingTargets).toContain("claude-fable-5");
  });

  it("uses distinct deterministic IDs for two workspaces in one organization", async () => {
    client = await migratedClient();
    const db = createPgliteDatabase(client);
    const options = seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_gateway_workspaces",
      SEED_USER_ID: "user_gateway_workspaces",
      PROXY_TOKEN: "gateway-workspaces-token"
    });
    await seedDatabase(db, options);
    await client.exec(`
      insert into workspaces (id, organization_id, slug, name)
      values ('workspace_gateway_secondary', '${options.organizationId}', 'secondary', 'Secondary')
    `);

    await seedGatewayResources(db, gatewayInput(options, "workspace_gateway_secondary"), []);

    const rows = await client.query<{
      workspace_id: string;
      connections: number;
      logical_models: number;
      profiles: number;
      distinct_ids: number;
    }>(`
      select w.id as workspace_id,
        (select count(*) from provider_connections pc where pc.workspace_id = w.id)::int as connections,
        (select count(*) from logical_models lm where lm.workspace_id = w.id)::int as logical_models,
        (select count(*) from access_profiles ap where ap.workspace_id = w.id)::int as profiles,
        (select count(distinct id) from provider_connections pc where pc.workspace_id = w.id)::int as distinct_ids
      from workspaces w
      where w.organization_id = '${options.organizationId}'
      order by w.id
    `);
    expect(rows.rows).toEqual([
      {
        workspace_id: defaultWorkspaceId(options.organizationId),
        connections: 3,
        logical_models: 3,
        profiles: 2,
        distinct_ids: 3
      },
      {
        workspace_id: "workspace_gateway_secondary",
        connections: 3,
        logical_models: 3,
        profiles: 2,
        distinct_ids: 3
      }
    ]);
    const connectionIds = await client.query<{ count: number }>(`
      select count(distinct id)::int as count
      from provider_connections
      where organization_id = '${options.organizationId}'
    `);
    expect(connectionIds.rows).toEqual([{ count: 6 }]);
  });
});

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  return client;
}

async function resourceCounts(client: PGlite, organizationId: string) {
  const result = await client.query<{
    connections: number;
    canonical_models: number;
    deployments: number;
    bindings: number;
    logical_models: number;
    targets: number;
    profiles: number;
    grants: number;
  }>(`
    select
      (select count(*) from provider_connections where organization_id = '${organizationId}')::int as connections,
      (select count(*) from canonical_models where organization_id = '${organizationId}')::int as canonical_models,
      (select count(*) from model_deployments where organization_id = '${organizationId}')::int as deployments,
      (select count(*) from deployment_wire_bindings where organization_id = '${organizationId}')::int as bindings,
      (select count(*) from logical_models where organization_id = '${organizationId}')::int as logical_models,
      (select count(*) from logical_model_targets where organization_id = '${organizationId}')::int as targets,
      (select count(*) from access_profiles where organization_id = '${organizationId}')::int as profiles,
      (select count(*) from access_profile_model_grants where organization_id = '${organizationId}')::int as grants
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Gateway resource count query returned no rows.");
  return {
    connections: row.connections,
    canonicalModels: row.canonical_models,
    deployments: row.deployments,
    bindings: row.bindings,
    logicalModels: row.logical_models,
    targets: row.targets,
    profiles: row.profiles,
    grants: row.grants
  };
}

function gatewayInput(options: ReturnType<typeof seedOptionsFromEnv>, workspaceId: string) {
  const economyModels = [
    { provider: "openai" as const, model: "gpt-5.4-mini", surface: "openai-responses" as const },
    { provider: "openai" as const, model: "gpt-5.4-mini", surface: "openai-chat" as const },
    { provider: "anthropic" as const, model: "claude-haiku-4-5", surface: "anthropic-messages" as const }
  ];
  return {
    organizationId: options.organizationId,
    workspaceId,
    classifierModel: options.classifierModel,
    classifierTimeoutMs: options.classifierTimeoutMs,
    classifierMaxAttempts: options.classifierMaxAttempts,
    openaiBaseUrl: options.openaiBaseUrl,
    anthropicBaseUrl: options.anthropicBaseUrl,
    models: [
      ...options.models.map(({ provider, model, surface }) => ({ provider, model, surface })),
      ...economyModels
    ],
    codingTargets: uniqueTargets([
      ...options.models.map(({ provider, model }) => ({ provider, model })),
      { provider: "anthropic" as const, model: "claude-fable-5" }
    ]),
    economyTargets: uniqueTargets(economyModels)
  };
}

function uniqueTargets<T extends { provider: string; model: string }>(targets: T[]) {
  return [...new Map(targets.map((target) => [`${target.provider}:${target.model}`, target])).values()];
}
