import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  GATEWAY_OPERATION_IDS,
  logicalModelClassifierConfigSchema,
  type BuiltinProvider,
  type Dialect,
  type GatewayModelCapabilities
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
  modelDeployments,
  providerConnections
} from "./schema.js";

export type GatewaySeedSnapshotEntry = {
  provider: BuiltinProvider;
  model: string;
  capabilities: GatewayModelCapabilities;
  pricing: Record<string, unknown>;
};

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
    surface: "openai-responses" | "openai-chat" | "anthropic-messages";
  }[];
  codingTargets: GatewaySeedTarget[];
  economyTargets: GatewaySeedTarget[];
};

export type GatewaySeedTarget = {
  provider: BuiltinProvider;
  model: string;
};

const DEFAULT_CLASSIFIER_INSTRUCTIONS = [
  "Select exactly one eligible target for this AI gateway request.",
  "Use the request context and advertised target capabilities."
].join(" ");

type SeedModel = {
  provider: BuiltinProvider;
  model: string;
  surfaces: Dialect[];
  capabilities: GatewayModelCapabilities;
  pricing: Record<string, unknown>;
};

export async function seedGatewayResources(
  db: ProxyDbSession,
  input: GatewaySeedInput,
  snapshot: GatewaySeedSnapshotEntry[]
) {
  const classifierRouterConfig = classifierConfig(input);
  const providerDefinitions = builtinProviderSeedDefinitions(input);
  const models = collectModels(input, snapshot, providerDefinitions);
  validateTargets(input, models);
  const connections = connectionRows(input, providerDefinitions);

  for (const row of connections) {
    await db
      .insert(providerConnections)
      .values(row)
      .onConflictDoNothing({ target: providerConnections.id });
  }

  const connectionIds = new Map(connections.map((row) => [row.provider, row.id]));

  for (const model of models.values()) {
    const canonicalId = canonicalModelId(input.workspaceId, model.provider, model.model);
    const deploymentId = modelDeploymentId(input.workspaceId, model.provider, model.model);
    const providerConnectionId = requiredConnectionId(connectionIds, model.provider);
    const slug = physicalModelSlug(model.provider, model.model);

    await db
      .insert(canonicalModels)
      .values({
        id: canonicalId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        slug,
        name: model.model,
        vendor: model.provider,
        family: model.model,
        capabilities: model.capabilities,
        status: "active"
      })
      .onConflictDoNothing({ target: canonicalModels.id });

    await db
      .insert(modelDeployments)
      .values({
        id: deploymentId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        slug,
        name: model.model,
        canonicalModelId: canonicalId,
        providerConnectionId,
        upstreamModelId: model.model,
        capabilities: {},
        pricing: model.pricing,
        status: "active"
      })
      .onConflictDoNothing({ target: modelDeployments.id });

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
          endpointPath: endpointPath(providerDefinitions, model.provider, surface),
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
    .map(({ provider, model }) => modelDeploymentId(input.workspaceId, provider, model));
  const economyTargets = uniqueModelKeys(input.economyTargets)
    .map(({ provider, model }) => modelDeploymentId(input.workspaceId, provider, model));

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

function collectModels(
  input: GatewaySeedInput,
  snapshot: GatewaySeedSnapshotEntry[],
  definitions: BuiltinProviderSeedDefinition[]
) {
  const snapshotByModel = new Map(snapshot.map((entry) => [modelKey(entry.provider, entry.model), entry]));
  const models = new Map<string, SeedModel>();

  const add = (provider: BuiltinProvider, model: string, surface: Dialect) => {
    endpointPath(definitions, provider, surface);
    const key = modelKey(provider, model);
    const existing = models.get(key);
    if (existing) {
      if (!existing.surfaces.includes(surface)) existing.surfaces.push(surface);
      return;
    }
    const snapshotEntry = snapshotByModel.get(key);
    models.set(key, {
      provider,
      model,
      surfaces: [surface],
      capabilities: snapshotEntry?.capabilities ?? {},
      pricing: snapshotEntry?.pricing ?? { source: "env" }
    });
  };

  for (const model of input.models) add(model.provider, model.model, model.surface);
  add("anthropic", "claude-fable-5", "anthropic-messages");
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
      if (!models.has(modelKey(target.provider, target.model))) {
        throw new Error(`Seeded logical model ${logicalSlug} references unconfigured model ${target.provider}:${target.model}.`);
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

function uniqueModelKeys(models: { provider: BuiltinProvider; model: string }[]) {
  return [...new Map(models.map((model) => [modelKey(model.provider, model.model), model])).values()];
}

function canonicalModelId(workspaceId: string, provider: BuiltinProvider, model: string) {
  return `${workspaceId}:canonical:${provider}:${model}`;
}

function modelDeploymentId(workspaceId: string, provider: BuiltinProvider, model: string) {
  return `${workspaceId}:deployment:${provider}:${model}`;
}

function logicalModelId(workspaceId: string, logicalSlug: string) {
  return `${workspaceId}:logical-model:${logicalSlug}`;
}

function accessProfileId(workspaceId: string, profileSlug: string) {
  return `${workspaceId}:access-profile:${profileSlug}`;
}

function modelKey(provider: BuiltinProvider, model: string) {
  return `${provider}:${model}`;
}

function physicalModelSlug(provider: BuiltinProvider, model: string) {
  const suffix = sha256(modelKey(provider, model)).slice(0, 8);
  const prefix = slug(`${provider}-${model}`).slice(0, 119).replace(/-+$/g, "") || "model";
  return `${prefix}-${suffix}`;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "model";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
