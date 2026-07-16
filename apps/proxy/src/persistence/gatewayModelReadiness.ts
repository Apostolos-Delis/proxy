import { and, eq } from "drizzle-orm";

import {
  canonicalModels,
  deploymentHealth,
  deploymentWireBindings,
  logicalModels,
  logicalModelTargets,
  modelDeployments,
  providerConnectionHealth,
  providerConnections,
  type ProxyDatabase
} from "@proxy/db";
import {
  gatewayModelSupportsText,
  LOGICAL_MODEL_CLASSIFIER_MAX_CANDIDATES,
  logicalModelClassifierConfigSchema,
  mergeGatewayModelCapabilities
} from "@proxy/schema";

import { activeClassifierDeployments } from "./classifierDeployment.js";
import { validateWireBinding } from "./gatewayConfigDeploymentMutations.js";
import type { GatewayConfigScope } from "./gatewayConfigTypes.js";
import { healthStatusUnavailable, isStreamPermissionHealth } from "./providerHealth.js";
import { workspaceScope } from "./scope.js";

export type GatewayDeploymentReadiness = {
  deploymentId: string;
  available: boolean;
  classifierCapable: boolean;
  reasonCodes: string[];
  classifierReasonCodes: string[];
};

export type GatewayLogicalModelReadiness = {
  logicalModelId: string;
  available: boolean;
  reasonCodes: string[];
};

export type GatewayModelReadiness = {
  deployments: GatewayDeploymentReadiness[];
  logicalModels: GatewayLogicalModelReadiness[];
};

export async function gatewayModelReadiness(
  db: ProxyDatabase,
  scope: GatewayConfigScope
): Promise<GatewayModelReadiness> {
  const deploymentRows = await db
    .select({
      deploymentId: modelDeployments.id,
      deploymentStatus: modelDeployments.status,
      canonicalStatus: canonicalModels.status,
      canonicalCapabilities: canonicalModels.capabilities,
      deploymentCapabilities: modelDeployments.capabilities,
      connectionStatus: providerConnections.status,
      connectionAdapterKind: providerConnections.adapterKind,
      bindingId: deploymentWireBindings.id,
      bindingEnabled: deploymentWireBindings.enabled,
      bindingWireId: deploymentWireBindings.apiWireId,
      endpointPath: deploymentWireBindings.endpointPath,
      connectionHealthStatus: providerConnectionHealth.status,
      connectionCooldownUntil: providerConnectionHealth.cooldownUntil,
      deploymentHealthStatus: deploymentHealth.status,
      deploymentLockoutUntil: deploymentHealth.lockoutUntil,
      deploymentLastErrorType: deploymentHealth.lastErrorType,
      deploymentHealthMetadata: deploymentHealth.metadata
    })
    .from(modelDeployments)
    .innerJoin(canonicalModels, and(
      eq(canonicalModels.organizationId, modelDeployments.organizationId),
      eq(canonicalModels.workspaceId, modelDeployments.workspaceId),
      eq(canonicalModels.id, modelDeployments.canonicalModelId)
    ))
    .innerJoin(providerConnections, and(
      eq(providerConnections.organizationId, modelDeployments.organizationId),
      eq(providerConnections.workspaceId, modelDeployments.workspaceId),
      eq(providerConnections.id, modelDeployments.providerConnectionId)
    ))
    .leftJoin(deploymentWireBindings, and(
      eq(deploymentWireBindings.organizationId, modelDeployments.organizationId),
      eq(deploymentWireBindings.workspaceId, modelDeployments.workspaceId),
      eq(deploymentWireBindings.deploymentId, modelDeployments.id),
      eq(deploymentWireBindings.providerConnectionId, providerConnections.id)
    ))
    .leftJoin(providerConnectionHealth, and(
      eq(providerConnectionHealth.organizationId, providerConnections.organizationId),
      eq(providerConnectionHealth.workspaceId, providerConnections.workspaceId),
      eq(providerConnectionHealth.providerConnectionId, providerConnections.id)
    ))
    .leftJoin(deploymentHealth, and(
      eq(deploymentHealth.organizationId, modelDeployments.organizationId),
      eq(deploymentHealth.workspaceId, modelDeployments.workspaceId),
      eq(deploymentHealth.deploymentId, modelDeployments.id)
    ))
    .where(and(
      workspaceScope(modelDeployments, scope.organizationId, scope.workspaceId),
      workspaceScope(canonicalModels, scope.organizationId, scope.workspaceId),
      workspaceScope(providerConnections, scope.organizationId, scope.workspaceId)
    ));

  type DeploymentReadinessRow = (typeof deploymentRows)[number];
  const now = new Date();
  const runtimeBindingReady = (row: DeploymentReadinessRow) => {
    if (!row.bindingId || !row.bindingEnabled || !row.bindingWireId) return false;
    try {
      validateWireBinding(row.connectionAdapterKind, row.bindingWireId, row.endpointPath);
      return true;
    } catch {
      return false;
    }
  };
  const classifierBindingReady = (row: DeploymentReadinessRow) => (
    row.bindingEnabled === true &&
    row.bindingWireId === "openai-responses" &&
    row.connectionAdapterKind === "generic-http-json" &&
    Boolean(row.endpointPath)
  );
  const deploymentReasonCodes = (rows: DeploymentReadinessRow[]) => {
    const row = rows[0]!;
    const reasons: string[] = [];
    if (row.deploymentStatus !== "active") reasons.push("deployment_disabled");
    if (row.canonicalStatus !== "active") reasons.push("canonical_model_disabled");
    if (!gatewayModelSupportsText(mergeGatewayModelCapabilities(
      row.canonicalCapabilities,
      row.deploymentCapabilities
    ))) reasons.push("text_modality_unavailable");
    if (row.connectionStatus !== "active") reasons.push("provider_connection_disabled");
    if (healthStatusUnavailable(row.connectionHealthStatus, row.connectionCooldownUntil, now)) {
      reasons.push("provider_connection_unhealthy");
    }
    if (
      healthStatusUnavailable(row.deploymentHealthStatus, row.deploymentLockoutUntil, now) &&
      !isStreamPermissionHealth(row.deploymentLastErrorType, healthMetadata(row.deploymentHealthMetadata))
    ) {
      reasons.push("deployment_unhealthy");
    }
    if (!rows.some(runtimeBindingReady)) reasons.push("wire_binding_unavailable");
    return reasons;
  };
  const classifierReasonCodes = (rows: DeploymentReadinessRow[], deploymentReasons: string[]) => {
    const reasons = [...deploymentReasons];
    if (rows[0]!.connectionAdapterKind !== "generic-http-json") {
      reasons.push("classifier_adapter_incompatible");
    }
    if (!rows.some(classifierBindingReady)) reasons.push("classifier_wire_unavailable");
    if (reasons.length === 0) reasons.push("classifier_unavailable");
    return [...new Set(reasons)];
  };

  const rowsByDeployment = new Map<string, typeof deploymentRows>();
  for (const row of deploymentRows) {
    const rows = rowsByDeployment.get(row.deploymentId) ?? [];
    rows.push(row);
    rowsByDeployment.set(row.deploymentId, rows);
  }

  const classifierDeploymentIds = new Set((await activeClassifierDeployments(
    db,
    scope.organizationId,
    scope.workspaceId,
    [...rowsByDeployment.keys()]
  )).map((deployment) => deployment.deploymentId));

  const deployments = [...rowsByDeployment].map(([deploymentId, rows]) => {
    const reasonCodes = deploymentReasonCodes(rows);
    const classifierCapable = classifierDeploymentIds.has(deploymentId);
    return {
      deploymentId,
      available: reasonCodes.length === 0,
      classifierCapable,
      reasonCodes,
      classifierReasonCodes: classifierCapable ? [] : classifierReasonCodes(rows, reasonCodes)
    };
  }).sort((left, right) => left.deploymentId.localeCompare(right.deploymentId));

  const [modelRows, targetRows] = await Promise.all([
    db.select({
      id: logicalModels.id,
      status: logicalModels.status,
      resolutionKind: logicalModels.resolutionKind,
      routerConfig: logicalModels.routerConfig
    }).from(logicalModels).where(workspaceScope(logicalModels, scope.organizationId, scope.workspaceId)),
    db.select({
      logicalModelId: logicalModelTargets.logicalModelId,
      deploymentId: logicalModelTargets.deploymentId,
      enabled: logicalModelTargets.enabled
    }).from(logicalModelTargets)
      .where(workspaceScope(logicalModelTargets, scope.organizationId, scope.workspaceId))
  ]);
  const deploymentAvailability = new Map(deployments.map((row) => [row.deploymentId, row.available]));
  const logicalModelReadiness = modelRows.map((model) => {
    const targets = targetRows.filter((target) => target.logicalModelId === model.id);
    const enabledTargets = targets.filter((target) => target.enabled);
    const availableTargets = enabledTargets.filter((target) => deploymentAvailability.get(target.deploymentId));
    const reasonCodes: string[] = [];
    if (model.status !== "active") reasonCodes.push("logical_model_disabled");
    if (model.resolutionKind === "direct") {
      if (enabledTargets.length !== 1) reasonCodes.push("direct_target_count_invalid");
      else if (availableTargets.length !== 1) reasonCodes.push("target_unavailable");
    } else {
      if (
        enabledTargets.length < 1 ||
        enabledTargets.length > LOGICAL_MODEL_CLASSIFIER_MAX_CANDIDATES
      ) {
        reasonCodes.push("router_target_count_invalid");
      }
      if (availableTargets.length === 0) reasonCodes.push("target_unavailable");
      const config = logicalModelClassifierConfigSchema.safeParse(model.routerConfig);
      if (!config.success) reasonCodes.push("router_config_invalid");
      else if (!classifierDeploymentIds.has(config.data.classifierDeploymentId)) {
        reasonCodes.push("classifier_deployment_unavailable");
      }
    }
    return {
      logicalModelId: model.id,
      available: reasonCodes.length === 0,
      reasonCodes
    };
  }).sort((left, right) => left.logicalModelId.localeCompare(right.logicalModelId));

  return { deployments, logicalModels: logicalModelReadiness };
}

function healthMetadata(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
