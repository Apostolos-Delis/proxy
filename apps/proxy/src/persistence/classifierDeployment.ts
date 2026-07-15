import { and, asc, eq } from "drizzle-orm";

import {
  canonicalModels,
  deploymentWireBindings,
  modelDeployments,
  providerConnections,
  type ProxyDbSession
} from "@proxy/db";

import type { LogicalModelClassifierDeployment } from "../classifier.js";
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
      provider: providerConnections.slug,
      connectionId: providerConnections.id,
      bindingId: deploymentWireBindings.id,
      endpointPath: deploymentWireBindings.endpointPath
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
  return {
    deploymentId: row.deploymentId,
    organizationId,
    workspaceId,
    model: row.model,
    provider: row.provider,
    providerConnectionId: row.connectionId,
    bindingId: row.bindingId
  };
}
