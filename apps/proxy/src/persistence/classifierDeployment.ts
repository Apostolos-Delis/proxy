import { and, asc, eq } from "drizzle-orm";

import {
  canonicalModels,
  deploymentHealth,
  deploymentWireBindings,
  modelDeployments,
  providerConnectionHealth,
  providerConnections,
  type ProxyDbSession
} from "@proxy/db";

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
  const [row] = await db
    .select({
      deploymentId: modelDeployments.id,
      model: modelDeployments.upstreamModelId,
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
      eq(modelDeployments.id, classifierDeploymentId),
      eq(modelDeployments.status, "active"),
      eq(canonicalModels.status, "active"),
      eq(providerConnections.status, "active"),
      eq(providerConnections.adapterKind, "generic-http-json"),
      eq(deploymentWireBindings.enabled, true)
    ))
    .orderBy(asc(deploymentWireBindings.id))
    .limit(1);
  if (!row?.endpointPath) return undefined;
  const now = new Date();
  if (healthStatusUnavailable(row.connectionHealthStatus, row.connectionCooldownUntil, now)) return undefined;
  if (healthStatusUnavailable(row.deploymentHealthStatus, row.deploymentLockoutUntil, now)) return undefined;
  return {
    deploymentId: row.deploymentId,
    organizationId,
    workspaceId,
    model: row.model,
    provider: row.provider,
    providerConnectionId: row.connectionId,
    bindingId: row.bindingId,
    pricing: pricingFromRow(row.pricing)
  };
}
