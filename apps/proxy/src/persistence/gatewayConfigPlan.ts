import { logicalModelClassifierConfigSchema } from "@proxy/schema";

import type { GatewayConfigAdminService } from "./gatewayConfigAdmin.js";
import type { GatewayConfigDocument } from "./gatewayConfigDocument.js";
import { planAccessResources } from "./gatewayConfigPlanAccess.js";
import {
  assertCapabilitiesWithin,
  validateWireBinding
} from "./gatewayConfigDeploymentMutations.js";
import { planLogicalResources } from "./gatewayConfigPlanLogical.js";
import { planPhysicalResources } from "./gatewayConfigPlanPhysical.js";
import {
  active,
  compositeKey,
  type GatewayConfigCurrentState,
  type GatewayConfigPlan,
  GatewayConfigPlanBuilder,
  projectGatewayConfig,
  type ProjectedGatewayConfig
} from "./gatewayConfigPlanSupport.js";
import { GatewayConfigAdminError } from "./gatewayConfigTypes.js";

export {
  type GatewayConfigPlan,
  type GatewayConfigPlanChange
} from "./gatewayConfigPlanSupport.js";

export async function planGatewayConfig(
  service: GatewayConfigAdminService,
  document: GatewayConfigDocument
): Promise<GatewayConfigPlan> {
  const plan = await buildGatewayConfigPlan(service, document);
  await service.preflightCommands({ ...plan.scope, commands: plan.commands });
  return plan;
}

async function buildGatewayConfigPlan(
  service: GatewayConfigAdminService,
  document: GatewayConfigDocument
): Promise<GatewayConfigPlan> {
  const scope = {
    organizationId: document.scope.organization_id,
    workspaceId: document.scope.workspace_id
  };
  const current = await loadCurrentGatewayConfig(service, scope);
  const projected = projectGatewayConfig(current);
  const builder = new GatewayConfigPlanBuilder(scope);
  planPhysicalResources(document, current, projected, builder);
  planLogicalResources(document, current, projected, builder);
  await planAccessResources(service, document, current, projected, builder);
  validateProjectedGatewayConfig(projected);
  return builder.build();
}

export async function applyGatewayConfig(
  service: GatewayConfigAdminService,
  document: GatewayConfigDocument,
  actorUserId: string
) {
  const plan = await buildGatewayConfigPlan(service, document);
  await applyGatewayConfigPlan(service, plan, actorUserId);
  return plan;
}

export async function applyGatewayConfigPlan(
  service: GatewayConfigAdminService,
  plan: GatewayConfigPlan,
  actorUserId: string
) {
  return service.applyCommands({ ...plan.scope, actorUserId, commands: plan.commands });
}

async function loadCurrentGatewayConfig(
  service: GatewayConfigAdminService,
  scope: GatewayConfigPlan["scope"]
): Promise<GatewayConfigCurrentState> {
  const [
    connections,
    canonicalModels,
    deployments,
    bindings,
    logicalModels,
    targets,
    accessProfiles,
    grants
  ] = await Promise.all([
    service.providerConnections(scope),
    service.canonicalModels(scope),
    service.modelDeployments(scope),
    service.wireBindings(scope),
    service.logicalModels(scope),
    service.logicalModelTargets(scope),
    service.accessProfiles(scope),
    service.modelGrants(scope)
  ]);
  return {
    connections,
    canonicalModels,
    deployments,
    bindings,
    logicalModels,
    targets,
    accessProfiles,
    grants
  };
}

function validateProjectedGatewayConfig(projected: ProjectedGatewayConfig) {
  validateConnections(projected);
  validateDeployments(projected);
  validateBindings(projected);
  validateTargets(projected);
  validateLogicalModels(projected);
  validateGrants(projected);
}

function validateConnections(projected: ProjectedGatewayConfig) {
  for (const connection of projected.connectionsById.values()) {
    if (!active(connection.status)) continue;
    if (["bearer", "x-api-key"].includes(connection.authStyle) && !connection.credentialConfigured) {
      invalidProjection(
        `provider_connections.${connection.slug}`,
        "An active authenticated provider connection requires a secret reference."
      );
    }
  }
}

function validateDeployments(projected: ProjectedGatewayConfig) {
  for (const deployment of projected.deploymentsById.values()) {
    const canonical = projected.canonicalModelsById.get(deployment.canonicalModelId);
    const connection = projected.connectionsById.get(deployment.providerConnectionId);
    if (!canonical || !connection) {
      invalidProjection(`model_deployments.${deployment.slug}`, "Deployment dependencies do not exist.");
    }
    assertCapabilitiesWithin(canonical.capabilities, deployment.capabilities);
    if (active(deployment.status) && (!active(canonical.status) || !active(connection.status))) {
      invalidProjection(
        `model_deployments.${deployment.slug}.enabled`,
        "Active deployments require an active canonical model and provider connection."
      );
    }
  }
}

function validateBindings(projected: ProjectedGatewayConfig) {
  for (const binding of projected.bindingsByIdentity.values()) {
    const deployment = projected.deploymentsById.get(binding.deploymentId);
    const connection = projected.connectionsById.get(binding.providerConnectionId);
    if (!deployment || !connection || deployment.providerConnectionId !== connection.id) {
      invalidProjection("wire_bindings", "Wire binding dependencies do not exist.");
    }
    validateWireBinding(connection.adapterKind, binding.apiWireId, binding.endpointPath);
    if (binding.enabled && (!active(deployment.status) || !active(connection.status))) {
      invalidProjection("wire_bindings.enabled", "Enabled wire bindings require active physical dependencies.");
    }
  }
}

function validateTargets(projected: ProjectedGatewayConfig) {
  const priorities = new Set<string>();
  for (const target of projected.targetsByIdentity.values()) {
    const logicalModel = projected.logicalModelsById.get(target.logicalModelId);
    const deployment = projected.deploymentsById.get(target.deploymentId);
    if (!logicalModel || !deployment) {
      invalidProjection("logical_model_targets", "Logical model target dependencies do not exist.");
    }
    const priority = compositeKey(target.logicalModelId, String(target.priority));
    if (priorities.has(priority)) {
      invalidProjection("logical_model_targets.priority", "Target priorities must be unique within a logical model.");
    }
    priorities.add(priority);
    if (target.enabled && !active(deployment.status)) {
      invalidProjection("logical_model_targets.enabled", "Enabled targets require an active deployment.");
    }
  }
}

function validateLogicalModels(projected: ProjectedGatewayConfig) {
  for (const model of projected.logicalModelsById.values()) {
    if (!active(model.status)) continue;
    if (model.resolutionKind === "direct") {
      const targetCount = [...projected.targetsByIdentity.values()].filter((target) => (
        target.logicalModelId === model.id && target.enabled
      )).length;
      if (targetCount !== 1) {
        invalidProjection(
          `logical_models.${model.slug}.enabled`,
          "An active direct logical model requires exactly one enabled target."
        );
      }
      continue;
    }
    const config = logicalModelClassifierConfigSchema.safeParse(model.routerConfig);
    if (!config.success) {
      invalidProjection(`logical_models.${model.slug}.classifier_deployment`, "Router configuration is invalid.");
    }
    const deployment = projected.deploymentsById.get(config.data.classifierDeploymentId);
    const connection = deployment
      ? projected.connectionsById.get(deployment.providerConnectionId)
      : undefined;
    const binding = deployment
      ? projected.bindingsByIdentity.get(compositeKey(deployment.id, "openai-responses"))
      : undefined;
    if (
      !deployment ||
      !connection ||
      connection.adapterKind !== "generic-http-json" ||
      !binding?.enabled ||
      !active(deployment.status) ||
      !active(connection.status)
    ) {
      invalidProjection(
        `logical_models.${model.slug}.classifier_deployment`,
        "Active routers require an active generic HTTP classifier deployment and OpenAI Responses binding."
      );
    }
  }
}

function validateGrants(projected: ProjectedGatewayConfig) {
  for (const grant of projected.grantsByIdentity.values()) {
    if (!grant.enabled) continue;
    const profile = projected.accessProfilesById.get(grant.accessProfileId);
    const logicalModel = projected.logicalModelsById.get(grant.logicalModelId);
    if (!profile || !logicalModel || !active(profile.status) || !active(logicalModel.status)) {
      invalidProjection("model_grants.enabled", "Enabled grants require an active profile and logical model.");
    }
  }
}

function invalidProjection(path: string, message: string): never {
  throw new GatewayConfigAdminError("gateway_config_projected_state_invalid", 400, [{ path, message }]);
}
