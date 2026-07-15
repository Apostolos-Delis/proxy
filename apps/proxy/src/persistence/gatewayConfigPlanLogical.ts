import type { GatewayConfigDocument } from "./gatewayConfigDocument.js";
import { gatewayResourceId } from "./gatewayConfigIds.js";
import {
  active,
  changedFields,
  compositeKey,
  type GatewayConfigCurrentState,
  GatewayConfigPlanBuilder,
  projectedStatus,
  type ProjectedGatewayConfig,
  type ProjectedLogicalModel,
  type ProjectedModelDeployment,
  requireReference
} from "./gatewayConfigPlanSupport.js";
import { GatewayConfigAdminError } from "./gatewayConfigTypes.js";

export function planLogicalResources(
  document: GatewayConfigDocument,
  current: GatewayConfigCurrentState,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder
) {
  const temporarilyDisabled = new Set<string>();
  planLogicalModels(document, current, projected, builder, temporarilyDisabled);
  planLogicalModelTargets(document, current, projected, builder, temporarilyDisabled);
}

function planLogicalModels(
  document: GatewayConfigDocument,
  current: GatewayConfigCurrentState,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder,
  temporarilyDisabled: Set<string>
) {
  const currentBySlug = new Map(current.logicalModels.map((row) => [row.slug, row]));
  for (const resource of document.logical_models) {
    const classifier = resource.router
      ? requireReference(
        projected.deploymentsBySlug,
        resource.router.classifier_deployment,
        `logical_models.${resource.slug}.classifier_deployment`
      )
      : undefined;
    const routerConfig = classifier && resource.router ? {
      classifierDeploymentId: classifier.id,
      instructions: resource.router.instructions,
      timeoutMs: resource.router.timeout_ms,
      maxAttempts: resource.router.max_attempts
    } : {};
    const row = currentBySlug.get(resource.slug);
    if (!row) {
      const id = gatewayResourceId("logicalModel");
      builder.create("logicalModel", id, resource.slug, {
        slug: resource.slug,
        name: resource.name,
        description: resource.description ?? null,
        resolutionKind: resource.resolution_kind,
        routerConfig,
        enabled: resource.enabled
      });
      const created = {
        id,
        slug: resource.slug,
        resolutionKind: resource.resolution_kind,
        routerConfig,
        status: projectedStatus(resource.enabled)
      };
      projected.logicalModelsById.set(id, created);
      projected.logicalModelsBySlug.set(resource.slug, created);
      continue;
    }
    const desired = {
      name: resource.name,
      description: resource.description ?? null,
      resolutionKind: resource.resolution_kind,
      routerConfig
    };
    const fields = changedFields(row, desired);
    const structuralChange = fields.includes("resolutionKind") || fields.includes("routerConfig");
    if (structuralChange && active(row.status) && resource.enabled) {
      temporarilyDisable(row.id, row.slug, builder, temporarilyDisabled);
    }
    if (fields.length > 0) {
      builder.update(
        "logicalModel",
        row.id,
        resource.slug,
        Object.fromEntries(fields.map((field) => [field, desired[field as keyof typeof desired]])),
        fields
      );
    }
    if (active(row.status) !== resource.enabled) {
      builder.setEnabled("logicalModel", row.id, resource.slug, resource.enabled);
    }
    const next = {
      id: row.id,
      slug: row.slug,
      resolutionKind: resource.resolution_kind,
      routerConfig,
      status: projectedStatus(resource.enabled)
    };
    projected.logicalModelsById.set(row.id, next);
    projected.logicalModelsBySlug.set(row.slug, next);
  }
}

function planLogicalModelTargets(
  document: GatewayConfigDocument,
  current: GatewayConfigCurrentState,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder,
  temporarilyDisabled: Set<string>
) {
  const currentByIdentity = new Map(current.targets.map((row) => [
    compositeKey(row.logicalModelId, row.deploymentId),
    row
  ]));
  const existingLogicalModelIds = new Set(current.logicalModels.map((row) => row.id));
  const resolved = document.logical_model_targets.map((resource) => {
    const logicalModel = requireReference(
      projected.logicalModelsBySlug,
      resource.logical_model,
      `logical_model_targets.${resource.logical_model}.${resource.deployment}.logical_model`
    );
    const deployment = requireReference(
      projected.deploymentsBySlug,
      resource.deployment,
      `logical_model_targets.${resource.logical_model}.${resource.deployment}.deployment`
    );
    const identity = compositeKey(logicalModel.id, deployment.id);
    const reference = `${resource.logical_model}:${resource.deployment}`;
    const row = currentByIdentity.get(identity);
    return { resource, logicalModel, deployment, identity, reference, row };
  });
  stageChangedTargetPriorities(current, resolved, builder);
  for (const { resource, logicalModel, deployment, identity, reference, row } of resolved) {
    if (!row) {
      if (resource.enabled && existingLogicalModelIds.has(logicalModel.id)) {
        ensureTargetMutationAllowed(logicalModel, builder, temporarilyDisabled);
      }
      const id = gatewayResourceId("logicalModelTarget");
      builder.create("logicalModelTarget", id, reference, {
        logicalModelId: logicalModel.id,
        deploymentId: deployment.id,
        priority: resource.priority,
        enabled: resource.enabled
      });
      projected.targetsByIdentity.set(identity, {
        id,
        logicalModelId: logicalModel.id,
        deploymentId: deployment.id,
        priority: resource.priority,
        enabled: resource.enabled
      });
      continue;
    }
    if (row.priority !== resource.priority) {
      builder.update(
        "logicalModelTarget",
        row.id,
        reference,
        { priority: resource.priority },
        ["priority"]
      );
    }
    if (row.enabled !== resource.enabled) {
      ensureTargetMutationAllowed(logicalModel, builder, temporarilyDisabled);
      builder.setEnabled("logicalModelTarget", row.id, reference, resource.enabled);
    }
    projected.targetsByIdentity.set(identity, {
      ...row,
      priority: resource.priority,
      enabled: resource.enabled
    });
  }
}

type ResolvedTarget = {
  resource: GatewayConfigDocument["logical_model_targets"][number];
  logicalModel: ProjectedLogicalModel;
  deployment: ProjectedModelDeployment;
  identity: string;
  reference: string;
  row: GatewayConfigCurrentState["targets"][number] | undefined;
};

function stageChangedTargetPriorities(
  current: GatewayConfigCurrentState,
  resolved: ResolvedTarget[],
  builder: GatewayConfigPlanBuilder
) {
  const reservedByModel = new Map<string, Set<number>>();
  for (const target of current.targets) {
    const reserved = reservedByModel.get(target.logicalModelId) ?? new Set<number>();
    reserved.add(target.priority);
    reservedByModel.set(target.logicalModelId, reserved);
  }
  for (const target of resolved) {
    const reserved = reservedByModel.get(target.logicalModel.id) ?? new Set<number>();
    reserved.add(target.resource.priority);
    reservedByModel.set(target.logicalModel.id, reserved);
  }
  for (const target of resolved) {
    if (!target.row || target.row.priority === target.resource.priority) continue;
    const reserved = reservedByModel.get(target.logicalModel.id)!;
    const temporaryPriority = availableTemporaryPriority(reserved);
    reserved.add(temporaryPriority);
    builder.stageUpdate("logicalModelTarget", target.row.id, { priority: temporaryPriority });
  }
}

function availableTemporaryPriority(reserved: Set<number>) {
  for (let priority = 1_000_000; priority >= 0; priority -= 1) {
    if (!reserved.has(priority)) return priority;
  }
  throw new GatewayConfigAdminError("gateway_config_projected_state_invalid", 400, [{
    path: "logical_model_targets.priority",
    message: "No temporary target priority is available for this update."
  }]);
}

function ensureTargetMutationAllowed(
  logicalModel: ProjectedLogicalModel,
  builder: GatewayConfigPlanBuilder,
  temporarilyDisabled: Set<string>
) {
  if (logicalModel.status === "active" && logicalModel.resolutionKind === "direct") {
    temporarilyDisable(logicalModel.id, logicalModel.slug, builder, temporarilyDisabled);
  }
}

function temporarilyDisable(
  id: string,
  slug: string,
  builder: GatewayConfigPlanBuilder,
  temporarilyDisabled: Set<string>
) {
  if (temporarilyDisabled.has(id)) return;
  temporarilyDisabled.add(id);
  builder.setEnabled("logicalModel", id, slug, false, false);
  builder.setEnabled("logicalModel", id, slug, true, false);
}
