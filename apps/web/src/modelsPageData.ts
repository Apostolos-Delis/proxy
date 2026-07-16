import { LOGICAL_MODEL_CLASSIFIER_MAX_CANDIDATES } from "@proxy/schema";

import { graphql } from "./gql";
import type { GatewayModelsQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";

const GatewayModelsDocument = graphql(`
  query GatewayModels {
    gatewayLogicalModels {
      id
      slug
      name
      description
      resolutionKind
      routerConfig
      enabled
    }
    gatewayLogicalModelTargets {
      id
      logicalModelId
      deploymentId
      priority
      enabled
    }
    gatewayModelDeployments {
      id
      name
      upstreamModelId
      providerConnectionId
    }
    gatewayProviderConnections {
      id
      name
      provider
    }
    gatewayWireBindings {
      deploymentId
      apiWireId
      enabled
    }
    gatewayAccessProfiles {
      id
      name
      enabled
    }
    gatewayModelGrants {
      accessProfileId
      logicalModelId
      enabled
    }
    gatewayModelReadiness {
      deployments {
        deploymentId
        available
        classifierCapable
        reasonCodes
        classifierReasonCodes
      }
      logicalModels {
        logicalModelId
        available
        reasonCodes
      }
    }
  }
`);

const CreateLogicalModelDocument = graphql(`
  mutation CreateLogicalModel($input: CreateGatewayLogicalModelInput!) {
    createGatewayLogicalModel(input: $input) {
      id
      slug
    }
  }
`);

export type ModelTargetSummary = {
  targetId: string;
  priority: number;
  enabled: boolean;
  available: boolean;
  reasonCodes: string[];
  deploymentName: string;
  upstreamModelId: string;
  provider: string;
  wires: string[];
};

export type LogicalModelSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: string;
  enabled: boolean;
  available: boolean;
  reasonCodes: string[];
  classifierDeployment: string | null;
  classifierReasonCodes: string[];
  routingPolicy: string | null;
  targets: ModelTargetSummary[];
  wires: string[];
  profiles: string[];
};

export async function fetchGatewayModels() {
  return gqlFetch(GatewayModelsDocument);
}

// routerConfig arrives as an untyped JSON scalar; read the classifier fields
// defensively so a malformed config renders as unknown instead of crashing.
function routerConfigView(value: unknown) {
  const config = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    classifierDeploymentId: typeof config.classifierDeploymentId === "string" ? config.classifierDeploymentId : null,
    instructions: typeof config.instructions === "string" ? config.instructions : null,
    timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : null,
    maxAttempts: typeof config.maxAttempts === "number" ? config.maxAttempts : null
  };
}

export function logicalModelSummaries(data: GatewayModelsQuery): LogicalModelSummary[] {
  const deployments = new Map(data.gatewayModelDeployments.map((deployment) => [deployment.id, deployment]));
  const connections = new Map(data.gatewayProviderConnections.map((connection) => [connection.id, connection]));
  const deploymentReadiness = new Map(
    data.gatewayModelReadiness.deployments.map((row) => [row.deploymentId, row])
  );
  const logicalReadiness = new Map(
    data.gatewayModelReadiness.logicalModels.map((row) => [row.logicalModelId, row])
  );
  const profileNames = new Map(
    data.gatewayAccessProfiles.filter((profile) => profile.enabled).map((profile) => [profile.id, profile.name])
  );
  const wiresByDeployment = new Map<string, string[]>();
  for (const binding of data.gatewayWireBindings) {
    if (!binding.enabled) continue;
    const wires = wiresByDeployment.get(binding.deploymentId) ?? [];
    wires.push(binding.apiWireId);
    wiresByDeployment.set(binding.deploymentId, wires);
  }

  return [...data.gatewayLogicalModels]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((model) => {
      const config = routerConfigView(model.routerConfig);
      const targets = data.gatewayLogicalModelTargets
        .filter((target) => target.logicalModelId === model.id)
        .sort((left, right) => left.priority - right.priority)
        .map((target) => {
          const deployment = deployments.get(target.deploymentId);
          const connection = deployment ? connections.get(deployment.providerConnectionId) : undefined;
          const wires = wiresByDeployment.get(target.deploymentId) ?? [];
          const readiness = deploymentReadiness.get(target.deploymentId);
          return {
            targetId: target.id,
            priority: target.priority,
            enabled: target.enabled,
            available: target.enabled && readiness?.available === true,
            reasonCodes: target.enabled ? readiness?.reasonCodes ?? ["deployment_not_found"] : ["target_disabled"],
            deploymentName: deployment?.name ?? target.deploymentId,
            upstreamModelId: deployment?.upstreamModelId ?? "unknown",
            provider: connection?.provider ?? "unknown",
            wires
          };
        });
      const classifierDeployment = config.classifierDeploymentId
        ? deployments.get(config.classifierDeploymentId)?.name ?? config.classifierDeploymentId
        : null;
      const classifierReadiness = config.classifierDeploymentId
        ? deploymentReadiness.get(config.classifierDeploymentId)
        : undefined;
      const readiness = logicalReadiness.get(model.id);
      return {
        id: model.id,
        slug: model.slug,
        name: model.name,
        description: model.description ?? null,
        kind: model.resolutionKind,
        enabled: model.enabled,
        available: readiness?.available === true,
        reasonCodes: readiness?.reasonCodes ?? ["readiness_not_found"],
        classifierDeployment: model.resolutionKind === "router" ? classifierDeployment : null,
        classifierReasonCodes: model.resolutionKind === "router"
          ? classifierReadiness?.classifierReasonCodes ?? ["classifier_deployment_not_found"]
          : [],
        routingPolicy: model.resolutionKind === "router" ? config.instructions : null,
        targets,
        wires: [...new Set(targets.flatMap((target) => (target.available ? target.wires : [])))].sort(),
        profiles: data.gatewayModelGrants
          .filter((grant) => grant.enabled && grant.logicalModelId === model.id)
          .map((grant) => profileNames.get(grant.accessProfileId))
          .filter((name): name is string => Boolean(name))
          .sort()
      };
    });
}

export type DeploymentOption = {
  id: string;
  label: string;
  hint: string;
  classifierCapable: boolean;
};

export function deploymentOptions(data: GatewayModelsQuery): DeploymentOption[] {
  const connections = new Map(data.gatewayProviderConnections.map((connection) => [connection.id, connection]));
  const readiness = new Map(
    data.gatewayModelReadiness.deployments.map((row) => [row.deploymentId, row])
  );
  return data.gatewayModelDeployments
    .filter((deployment) => readiness.get(deployment.id)?.available)
    .map((deployment) => {
      const connection = connections.get(deployment.providerConnectionId)!;
      return {
        id: deployment.id,
        label: deployment.name,
        hint: `${deployment.upstreamModelId} · ${connection.provider}`,
        classifierCapable: readiness.get(deployment.id)?.classifierCapable === true
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export type RouterDefaults = {
  classifierDeploymentId: string | null;
  timeoutMs: number;
  maxAttempts: number;
};

// New routers copy the classifier tuning already proven in this workspace so
// the modal does not ask for timeouts nobody knows how to pick.
export function routerDefaults(data: GatewayModelsQuery): RouterDefaults {
  const classifierDeployments = new Set(
    deploymentOptions(data).filter((deployment) => deployment.classifierCapable).map((deployment) => deployment.id)
  );
  for (const model of data.gatewayLogicalModels) {
    if (model.resolutionKind !== "router") continue;
    const config = routerConfigView(model.routerConfig);
    if (config.classifierDeploymentId && classifierDeployments.has(config.classifierDeploymentId)) {
      return {
        classifierDeploymentId: config.classifierDeploymentId,
        timeoutMs: config.timeoutMs ?? 4_000,
        maxAttempts: config.maxAttempts ?? 2
      };
    }
  }
  return { classifierDeploymentId: null, timeoutMs: 4_000, maxAttempts: 2 };
}

export const defaultRouterPolicy = [
  "Judge the complexity of each request from its context (estimated input size, tool usage, and the input excerpt).",
  "Route straightforward or short requests to the cheapest capable target and complex, multi-step, or high-stakes requests to the strongest target."
].join(" ");

export type CreateLogicalModelDraft = {
  slug: string;
  name: string;
  description: string;
  kind: "direct" | "router";
  deploymentIds: string[];
  policy: string;
  classifierDeploymentId: string;
};

export function composeRouterInstructions(
  policy: string,
  targets: { targetId: string; label: string }[]
) {
  const instructions = [
    "Select exactly one eligible target for this AI gateway request.",
    policy.trim(),
    "Targets:",
    ...targets.map((target) => `- ${target.targetId}: ${target.label}`)
  ].join("\n");
  if (instructions.length > 20_000) {
    throw new Error("Routing policy and target descriptions must fit within 20,000 characters.");
  }
  return instructions;
}

export async function createLogicalModel(
  draft: CreateLogicalModelDraft,
  defaults: RouterDefaults,
  deployments: DeploymentOption[]
) {
  const targetIds = draft.deploymentIds.map(() => `logical_target_${crypto.randomUUID()}`);
  return (await gqlFetch(CreateLogicalModelDocument, {
    input: logicalModelCreateInput(draft, defaults, deployments, targetIds)
  })).createGatewayLogicalModel;
}

export function logicalModelCreateInput(
  draft: CreateLogicalModelDraft,
  defaults: RouterDefaults,
  deployments: DeploymentOption[],
  targetIds: string[]
) {
  if (targetIds.length !== draft.deploymentIds.length) {
    throw new Error("logical_model_target_ids_mismatch");
  }
  const base = {
    slug: draft.slug.trim(),
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    enabled: true
  };
  const initialTargets = draft.deploymentIds.map((deploymentId, priority) => ({
    id: targetIds[priority]!,
    deploymentId,
    priority,
    enabled: true
  }));
  if (draft.kind === "direct") {
    return { ...base, resolutionKind: "direct" as const, initialTargets };
  }

  const labels = new Map(deployments.map((option) => [option.id, `${option.label} (${option.hint})`]));
  const instructionTargets = initialTargets.map((target) => ({
    targetId: target.id,
    label: labels.get(target.deploymentId) ?? target.deploymentId
  }));
  const routerConfig = {
    classifierDeploymentId: draft.classifierDeploymentId,
    instructions: composeRouterInstructions(draft.policy, instructionTargets),
    timeoutMs: defaults.timeoutMs,
    maxAttempts: defaults.maxAttempts
  };
  return { ...base, resolutionKind: "router" as const, routerConfig, initialTargets };
}

export function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 128).replace(/-+$/g, "");
}

export function createModelBlocker(draft: CreateLogicalModelDraft): string | null {
  if (!draft.name.trim()) return "Enter a model name.";
  if (draft.name.trim().length > 256) return "Model name must be 256 characters or fewer.";
  if (draft.description.trim().length > 2_000) return "Description must be 2,000 characters or fewer.";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug.trim())) {
    return "Slug must be lowercase letters, digits, and hyphens.";
  }
  if (draft.slug.trim().length > 128) return "Slug must be 128 characters or fewer.";
  if (draft.kind === "direct" && draft.deploymentIds.length !== 1) {
    return "Pick exactly one deployment.";
  }
  if (draft.kind === "router") {
    if (draft.deploymentIds.length < 2) return "Pick at least two deployments to route between.";
    if (draft.deploymentIds.length > LOGICAL_MODEL_CLASSIFIER_MAX_CANDIDATES) {
      return `Pick no more than ${LOGICAL_MODEL_CLASSIFIER_MAX_CANDIDATES} route targets.`;
    }
    if (!draft.policy.trim()) return "Describe the routing policy.";
    if (draft.policy.length > 20_000) return "Routing policy must be 20,000 characters or fewer.";
    if (!draft.classifierDeploymentId) return "Pick a classifier deployment.";
  }
  return null;
}
