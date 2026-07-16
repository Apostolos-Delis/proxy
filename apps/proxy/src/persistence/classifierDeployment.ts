import { and, eq, inArray } from "drizzle-orm";

import {
  canonicalModels,
  deploymentHealth,
  deploymentWireBindings,
  modelDeployments,
  providerConnectionHealth,
  providerConnections,
  type ProxyDbSession
} from "@proxy/db";
import { gatewayModelSupportsText, mergeGatewayModelCapabilities } from "@proxy/schema";

import type { LogicalModelClassifierDeployment } from "../classifier.js";
import { pricingFromRow } from "./modelPricing.js";
import { healthStatusUnavailable } from "./providerHealth.js";
import { workspaceScope } from "./scope.js";

export async function activeClassifierDeployment(
  db: ProxyDbSession,
  organizationId: string,
  workspaceId: string,
  classifierDeploymentId: string
): Promise<LogicalModelClassifierDeployment | undefined> {
  return (await activeClassifierDeployments(
    db,
    organizationId,
    workspaceId,
    [classifierDeploymentId]
  ))[0];
}

export async function activeClassifierDeployments(
  db: ProxyDbSession,
  organizationId: string,
  workspaceId: string,
  classifierDeploymentIds: readonly string[]
): Promise<LogicalModelClassifierDeployment[]> {
  const ids = [...new Set(classifierDeploymentIds)];
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      deploymentId: modelDeployments.id,
      model: modelDeployments.upstreamModelId,
      canonicalCapabilities: canonicalModels.capabilities,
      deploymentCapabilities: modelDeployments.capabilities,
      pricing: modelDeployments.pricing,
      provider: providerConnections.provider,
      connectionId: providerConnections.id,
      bindingId: deploymentWireBindings.id,
      endpointPath: deploymentWireBindings.endpointPath,
      connectionHealthStatus: providerConnectionHealth.status,
      connectionCooldownUntil: providerConnectionHealth.cooldownUntil,
      deploymentHealthStatus: deploymentHealth.status,
      deploymentLockoutUntil: deploymentHealth.lockoutUntil
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
    .innerJoin(deploymentWireBindings, and(
      eq(deploymentWireBindings.organizationId, modelDeployments.organizationId),
      eq(deploymentWireBindings.workspaceId, modelDeployments.workspaceId),
      eq(deploymentWireBindings.deploymentId, modelDeployments.id),
      eq(deploymentWireBindings.providerConnectionId, providerConnections.id),
      eq(deploymentWireBindings.apiWireId, "openai-responses")
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
      workspaceScope(modelDeployments, organizationId, workspaceId),
      workspaceScope(canonicalModels, organizationId, workspaceId),
      workspaceScope(providerConnections, organizationId, workspaceId),
      workspaceScope(deploymentWireBindings, organizationId, workspaceId),
      eq(modelDeployments.status, "active"),
      eq(canonicalModels.status, "active"),
      eq(providerConnections.status, "active"),
      eq(providerConnections.adapterKind, "generic-http-json"),
      eq(deploymentWireBindings.enabled, true),
      inArray(modelDeployments.id, ids)
    ));
  const now = new Date();
  return rows.flatMap((row) => {
    if (!row.endpointPath) return [];
    if (healthStatusUnavailable(row.connectionHealthStatus, row.connectionCooldownUntil, now)) return [];
    if (healthStatusUnavailable(row.deploymentHealthStatus, row.deploymentLockoutUntil, now)) return [];
    if (!gatewayModelSupportsText(mergeGatewayModelCapabilities(
      row.canonicalCapabilities,
      row.deploymentCapabilities
    ))) return [];
    return [{
      deploymentId: row.deploymentId,
      organizationId,
      workspaceId,
      model: row.model,
      provider: row.provider,
      providerConnectionId: row.connectionId,
      bindingId: row.bindingId,
      pricing: pricingFromRow(row.pricing)
    }];
  });
}
