import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  GATEWAY_OPERATION_IDS,
  providerModelCatalogSchema,
  logicalModelClassifierConfigSchema,
  type BuiltinProvider,
  type Dialect,
  type ProviderModelCatalog,
  type ProviderModelCatalogEntry
} from "@proxy/schema";

import { builtinProviderSeedDefinitions, type BuiltinProviderSeedDefinition } from "./builtinProviderSeed.js";
import type { ProxyDbSession } from "./client.js";
import {
  accessProfileModelGrants,
  accessProfiles,
  canonicalModels,
  deploymentWireBindings,
  logicalModels,
  logicalModelTargets,
  modelCatalogEntries,
  modelDeployments,
  providerConnections
} from "./schema.js";

export type GatewaySeedInput = {
  organizationId: string;
  workspaceId: string;
  classifierModel: string;
  classifierTimeoutMs: number;
  classifierMaxAttempts: number;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  models: {
    provider: BuiltinProvider;
    model: string;
    region?: string;
    surface: Dialect;
  }[];
  codingTargets: GatewaySeedTarget[];
  economyTargets: GatewaySeedTarget[];
};

export type GatewaySeedTarget = {
  provider: BuiltinProvider;
  model: string;
  region?: string;
};

const DEFAULT_CLASSIFIER_INSTRUCTIONS = [
  "Select exactly one eligible target for this AI gateway request.",
  "Use the request context and advertised target capabilities."
].join(" ");

type SeedModel = {
  catalogEntry: ProviderModelCatalogEntry;
  surfaces: Dialect[];
};

export async function seedGatewayResources(
  db: ProxyDbSession,
  input: GatewaySeedInput,
  catalog: ProviderModelCatalog
) {
  const classifierRouterConfig = classifierConfig(input);
  const providerDefinitions = builtinProviderSeedDefinitions(input);
  const models = collectModels(input, await catalogWithStoredEntries(db, input, catalog), providerDefinitions);
  validateTargets(input, models);
  const connections = connectionRows(input, providerDefinitions);

  for (const row of connections) {
    await db
      .insert(providerConnections)
      .values(row)
      .onConflictDoNothing({ target: providerConnections.id });
  }

  const connectionIds = new Map(connections.map((row) => [row.provider, row.id]));
  await seedCatalogEntries(db, input, catalog);

  for (const model of models.values()) {
    const entry = model.catalogEntry;
    const catalogEntryId = modelCatalogEntryId(input.workspaceId, entry.provider, entry.upstreamModelId, entry.region);
    const canonicalId = canonicalModelId(input.workspaceId, entry.canonical.vendor, entry.canonical.key);
    const deploymentId = modelDeploymentId(input.workspaceId, entry.provider, entry.upstreamModelId, entry.region);
    const providerConnectionId = requiredConnectionId(connectionIds, entry.provider);
    const canonicalSlug = physicalModelSlug(entry.canonical.vendor, entry.canonical.slug);
    const deploymentSlug = physicalModelSlug(entry.provider, entry.upstreamModelId, entry.region);

    await db
      .insert(canonicalModels)
      .values({
        id: canonicalId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        slug: canonicalSlug,
        name: entry.canonical.name,
        vendor: entry.canonical.vendor,
        family: entry.canonical.family,
        release: entry.canonical.release ?? null,
        capabilities: entry.canonical.capabilities,
        status: "active"
      })
      .onConflictDoUpdate({
        target: canonicalModels.id,
        set: {
          name: entry.canonical.name,
          vendor: entry.canonical.vendor,
          family: entry.canonical.family,
          release: entry.canonical.release ?? null,
          capabilities: entry.canonical.capabilities,
          updatedAt: new Date()
        }
      });

    await db
      .insert(modelDeployments)
      .values({
        id: deploymentId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        slug: deploymentSlug,
        name: entry.upstreamModelId,
        catalogEntryId,
        canonicalModelId: canonicalId,
        providerConnectionId,
        upstreamModelId: entry.upstreamModelId,
        region: entry.region ?? null,
        capabilities: entry.capabilities,
        pricing: entry.pricing,
        status: "active"
      })
      .onConflictDoUpdate({
        target: modelDeployments.id,
        set: {
          name: entry.upstreamModelId,
          catalogEntryId,
          canonicalModelId: canonicalId,
          providerConnectionId,
          upstreamModelId: entry.upstreamModelId,
          region: entry.region ?? null,
          capabilities: entry.capabilities,
          pricing: entry.pricing,
          updatedAt: new Date()
        }
      });

    for (const surface of model.surfaces) {
      await db
        .insert(deploymentWireBindings)
        .values({
          id: `${deploymentId}:wire:${surface}`,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          deploymentId,
          providerConnectionId,
          apiWireId: surface,
          endpointPath: endpointPath(providerDefinitions, entry.provider, surface),
          adapterContractVersion: "1",
          enabled: true
        })
        .onConflictDoNothing({ target: deploymentWireBindings.id });
    }
  }

  const logicalRows = [
    {
      id: logicalModelId(input.workspaceId, "fable"),
      slug: "fable",
      name: "Fable",
      description: "Direct access to Claude Fable 5.",
      resolutionKind: "direct" as const,
      routerKind: null,
      routerConfig: {}
    },
    {
      id: logicalModelId(input.workspaceId, "coding-auto"),
      slug: "coding-auto",
      name: "Coding Auto",
      description: "Classifier-routed access to the configured coding model set.",
      resolutionKind: "router" as const,
      routerKind: "classifier" as const,
      routerConfig: classifierRouterConfig
    },
    {
      id: logicalModelId(input.workspaceId, "economy-auto"),
      slug: "economy-auto",
      name: "Economy Auto",
      description: "Classifier-routed access limited to economy deployments.",
      resolutionKind: "router" as const,
      routerKind: "classifier" as const,
      routerConfig: classifierRouterConfig
    }
  ];

  for (const row of logicalRows) {
    await db
      .insert(logicalModels)
      .values({
        ...row,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        status: "active"
      })
      .onConflictDoNothing({ target: logicalModels.id });
  }

  const fableTarget = modelDeploymentId(input.workspaceId, "anthropic", "claude-fable-5");
  const codingTargets = uniqueModelKeys(input.codingTargets)
    .map(({ provider, model, region }) => modelDeploymentId(input.workspaceId, provider, model, region));
  const economyTargets = uniqueModelKeys(input.economyTargets)
    .map(({ provider, model, region }) => modelDeploymentId(input.workspaceId, provider, model, region));

  await replaceTargets(db, input, "fable", [fableTarget]);
  await replaceTargets(db, input, "coding-auto", codingTargets);
  await replaceTargets(db, input, "economy-auto", economyTargets);

  const profiles = [
    {
      id: accessProfileId(input.workspaceId, "opendoor-engineer"),
      slug: "opendoor-engineer",
      name: "Opendoor Engineer",
      description: "Full access to the initial gateway logical models."
    },
    {
      id: accessProfileId(input.workspaceId, "external-economy"),
      slug: "external-economy",
      name: "External Economy",
      description: "Economy-only access for external coding harnesses."
    }
  ];

  for (const profile of profiles) {
    await db
      .insert(accessProfiles)
      .values({
        ...profile,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        limits: {},
        status: "active"
      })
      .onConflictDoNothing({ target: accessProfiles.id });
  }

  await replaceGrants(db, input, "opendoor-engineer", ["fable", "coding-auto", "economy-auto"]);
  await replaceGrants(db, input, "external-economy", ["economy-auto"]);

  return {
    engineerAccessProfileId: accessProfileId(input.workspaceId, "opendoor-engineer"),
    externalEconomyAccessProfileId: accessProfileId(input.workspaceId, "external-economy")
  };
}

function classifierConfig(input: GatewaySeedInput) {
  return logicalModelClassifierConfigSchema.parse({
    classifierDeploymentId: modelDeploymentId(input.workspaceId, "openai", input.classifierModel),
    instructions: DEFAULT_CLASSIFIER_INSTRUCTIONS,
    timeoutMs: input.classifierTimeoutMs,
    maxAttempts: input.classifierMaxAttempts
  });
}

function connectionRows(input: GatewaySeedInput, definitions: BuiltinProviderSeedDefinition[]) {
  return definitions.map((provider) => ({
    provider: provider.provider,
    id: `${input.workspaceId}:connection:${provider.provider}`,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    slug: provider.provider,
    name: provider.displayName,
    adapterKind: provider.adapterKind,
    authStyle: provider.authStyle,
    baseUrl: provider.baseUrl,
    region: provider.connectionRegion,
    secretRef: provider.connectionSecretRef,
    secretHint: provider.connectionSecretHint,
    adapterConfig: provider.adapterConfig,
    defaultHeaders: provider.defaultHeaders,
    capabilities: provider.capabilities,
    platformOwned: true,
    forwardHarnessHeaders: provider.forwardHarnessHeaders,
    status: "active"
  }));
}

async function seedCatalogEntries(
  db: ProxyDbSession,
  input: GatewaySeedInput,
  catalog: ProviderModelCatalog
) {
  for (const entry of catalog.entries) {
    const metadataSource = catalog.sources[entry.metadataSourceId];
    const pricingSource = catalog.sources[entry.pricingSourceId];
    if (!metadataSource || !pricingSource) {
      throw new Error(`Catalog entry ${entry.provider}:${entry.upstreamModelId} references an unknown source.`);
    }
    await db
      .insert(modelCatalogEntries)
      .values({
        id: modelCatalogEntryId(input.workspaceId, entry.provider, entry.upstreamModelId, entry.region),
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        provider: entry.provider,
        upstreamModelId: entry.upstreamModelId,
        canonicalKey: entry.canonical.key,
        canonicalSlug: entry.canonical.slug,
        canonicalName: entry.canonical.name,
        vendor: entry.canonical.vendor,
        family: entry.canonical.family,
        release: entry.canonical.release ?? null,
        region: entry.region ?? null,
        dialects: entry.dialects,
        canonicalCapabilities: entry.canonical.capabilities,
        deploymentCapabilities: entry.capabilities,
        pricing: entry.pricing,
        metadataSource,
        pricingSource,
        status: "active"
      })
      .onConflictDoUpdate({
        target: modelCatalogEntries.id,
        set: {
          canonicalKey: entry.canonical.key,
          canonicalSlug: entry.canonical.slug,
          canonicalName: entry.canonical.name,
          vendor: entry.canonical.vendor,
          family: entry.canonical.family,
          release: entry.canonical.release ?? null,
          dialects: entry.dialects,
          canonicalCapabilities: entry.canonical.capabilities,
          deploymentCapabilities: entry.capabilities,
          pricing: entry.pricing,
          metadataSource,
          pricingSource,
          status: "active",
          updatedAt: new Date()
        }
      });
  }
}

async function catalogWithStoredEntries(
  db: ProxyDbSession,
  input: GatewaySeedInput,
  catalog: ProviderModelCatalog
) {
  const stored = await db
    .select()
    .from(modelCatalogEntries)
    .where(and(
      eq(modelCatalogEntries.organizationId, input.organizationId),
      eq(modelCatalogEntries.workspaceId, input.workspaceId),
      eq(modelCatalogEntries.status, "active")
    ));
  const sources = { ...catalog.sources };
  const entries = new Map(catalog.entries.map((entry) => [
    modelKey(entry.provider, entry.upstreamModelId, entry.region),
    entry
  ]));
  for (const row of stored) {
    if (row.provider !== "openai" && row.provider !== "anthropic" && row.provider !== "amazon-bedrock") continue;
    if (row.metadataSource.type !== "manual") continue;
    const key = modelKey(row.provider, row.upstreamModelId, row.region);
    if (entries.has(key)) continue;
    const metadataSourceId = `stored:${row.id}:metadata`;
    const pricingSourceId = `stored:${row.id}:pricing`;
    sources[metadataSourceId] = row.metadataSource;
    sources[pricingSourceId] = row.pricingSource;
    entries.set(key, {
      provider: row.provider,
      upstreamModelId: row.upstreamModelId,
      canonical: {
        key: row.canonicalKey,
        slug: row.canonicalSlug,
        name: row.canonicalName,
        vendor: row.vendor,
        family: row.family,
        release: row.release,
        capabilities: row.canonicalCapabilities
      },
      region: row.region,
      dialects: row.dialects,
      capabilities: row.deploymentCapabilities,
      pricing: row.pricing as ProviderModelCatalogEntry["pricing"],
      metadataSourceId,
      pricingSourceId
    });
  }
  return providerModelCatalogSchema.parse({ sources, entries: [...entries.values()] });
}

function collectModels(
  input: GatewaySeedInput,
  catalog: ProviderModelCatalog,
  definitions: BuiltinProviderSeedDefinition[]
) {
  const catalogByModel = new Map(catalog.entries.map((entry) => [
    modelKey(entry.provider, entry.upstreamModelId, entry.region),
    entry
  ]));
  const models = new Map<string, SeedModel>();

  const add = (provider: BuiltinProvider, model: string, surface: Dialect, region?: string) => {
    endpointPath(definitions, provider, surface);
    const key = modelKey(provider, model, region);
    const existing = models.get(key);
    if (existing) {
      if (!existing.surfaces.includes(surface)) existing.surfaces.push(surface);
      return;
    }
    const catalogEntry = catalogByModel.get(key);
    if (!catalogEntry) throw new Error(`No catalog entry for configured model ${key}.`);
    if (!catalogEntry.dialects.includes(surface)) {
      throw new Error(`API wire ${surface} is not cataloged for model ${key}.`);
    }
    models.set(key, {
      catalogEntry,
      surfaces: [surface]
    });
  };

  for (const model of input.models) add(model.provider, model.model, model.surface, model.region);
  add("openai", input.classifierModel, "openai-responses");

  return models;
}

function validateTargets(input: GatewaySeedInput, models: Map<string, SeedModel>) {
  for (const [logicalSlug, targets] of [
    ["coding-auto", input.codingTargets],
    ["economy-auto", input.economyTargets]
  ] as const) {
    if (targets.length === 0) throw new Error(`Seeded logical model ${logicalSlug} requires at least one target.`);
    for (const target of targets) {
      if (!models.has(modelKey(target.provider, target.model, target.region))) {
        throw new Error(`Seeded logical model ${logicalSlug} references unconfigured model ${modelKey(target.provider, target.model, target.region)}.`);
      }
    }
  }
}

async function replaceTargets(
  db: ProxyDbSession,
  input: GatewaySeedInput,
  logicalSlug: string,
  deploymentIds: string[]
) {
  if (deploymentIds.length === 0) {
    throw new Error(`Seeded logical model ${logicalSlug} requires at least one deployment.`);
  }

  const modelId = logicalModelId(input.workspaceId, logicalSlug);
  const desired = deploymentIds.map((deploymentId, priority) => ({
    id: `${modelId}:target:${sha256(deploymentId).slice(0, 12)}`,
    deploymentId,
    priority,
    enabled: true
  }));
  const [existing] = await db
    .select({ id: logicalModelTargets.id })
    .from(logicalModelTargets)
    .where(and(
      eq(logicalModelTargets.organizationId, input.organizationId),
      eq(logicalModelTargets.workspaceId, input.workspaceId),
      eq(logicalModelTargets.logicalModelId, modelId)
    ))
    .limit(1);
  if (existing) return;

  await db
    .insert(logicalModelTargets)
    .values(desired.map((target) => ({
      ...target,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      logicalModelId: modelId
    })))
    .onConflictDoNothing();
}

async function replaceGrants(
  db: ProxyDbSession,
  input: GatewaySeedInput,
  profileSlug: string,
  logicalSlugs: string[]
) {
  const profileId = accessProfileId(input.workspaceId, profileSlug);
  const [existing] = await db
    .select({ id: accessProfileModelGrants.id })
    .from(accessProfileModelGrants)
    .where(and(
      eq(accessProfileModelGrants.organizationId, input.organizationId),
      eq(accessProfileModelGrants.workspaceId, input.workspaceId),
      eq(accessProfileModelGrants.accessProfileId, profileId)
    ))
    .limit(1);
  if (existing) return;

  for (const logicalSlug of logicalSlugs) {
    const id = `${profileId}:grant:${logicalSlug}`;
    await db
      .insert(accessProfileModelGrants)
      .values({
        id,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        accessProfileId: profileId,
        logicalModelId: logicalModelId(input.workspaceId, logicalSlug),
        allowedOperations: [...GATEWAY_OPERATION_IDS],
        parameterCaps: {},
        enabled: true
      })
      .onConflictDoNothing({ target: accessProfileModelGrants.id });
  }
}

function requiredConnectionId(connections: Map<BuiltinProvider, string>, provider: BuiltinProvider) {
  const connectionId = connections.get(provider);
  if (!connectionId) throw new Error(`No seeded provider connection for ${provider}.`);
  return connectionId;
}

function endpointPath(
  definitions: BuiltinProviderSeedDefinition[],
  provider: BuiltinProvider,
  surface: Dialect
) {
  const definition = definitions.find((entry) => entry.provider === provider);
  const endpoint = definition?.endpoints.find((entry) => entry.dialect === surface);
  if (!endpoint) throw new Error(`API wire ${surface} is incompatible with provider ${provider}.`);
  return "path" in endpoint ? endpoint.path : null;
}

function uniqueModelKeys(models: GatewaySeedTarget[]) {
  return [...new Map(models.map((model) => [modelKey(model.provider, model.model, model.region), model])).values()];
}

function modelCatalogEntryId(workspaceId: string, provider: BuiltinProvider, model: string, region?: string | null) {
  return `${workspaceId}:catalog:${provider}:${model}:${region ?? "default"}`;
}

function canonicalModelId(workspaceId: string, vendor: string, canonicalSlug: string) {
  return `${workspaceId}:canonical:${vendor}:${canonicalSlug}`;
}

function modelDeploymentId(workspaceId: string, provider: BuiltinProvider, model: string, region?: string | null) {
  const regionSuffix = region ? `:${region}` : "";
  return `${workspaceId}:deployment:${provider}:${model}${regionSuffix}`;
}

function logicalModelId(workspaceId: string, logicalSlug: string) {
  return `${workspaceId}:logical-model:${logicalSlug}`;
}

function accessProfileId(workspaceId: string, profileSlug: string) {
  return `${workspaceId}:access-profile:${profileSlug}`;
}

function modelKey(provider: BuiltinProvider, model: string, region?: string | null) {
  return `${provider}:${model}:${region ?? "default"}`;
}

function physicalModelSlug(provider: string, model: string, region?: string | null) {
  const identity = `${provider}:${model}:${region ?? "default"}`;
  const suffix = sha256(identity).slice(0, 8);
  const prefix = slug(`${provider}-${model}-${region ?? ""}`).slice(0, 119).replace(/-+$/g, "") || "model";
  return `${prefix}-${suffix}`;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "model";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
