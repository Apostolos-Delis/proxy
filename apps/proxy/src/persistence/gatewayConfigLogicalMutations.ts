import { and, eq, sql } from "drizzle-orm";

import {
  deploymentWireBindings,
  logicalModels,
  logicalModelTargets,
  modelDeployments,
  providerConnections
} from "@proxy/db";
import { logicalModelClassifierConfigSchema } from "@proxy/schema";

import { activeClassifierDeployment } from "./classifierDeployment.js";
import {
  logicalModelCreateSchema,
  logicalModelTargetCreateSchema,
  logicalModelTargetUpdateSchema,
  logicalModelUpdateSchema,
  parseGatewayBody
} from "./gatewayConfigSchemas.js";
import { gatewayResourceId } from "./gatewayConfigIds.js";
import {
  assertActiveDependencies,
  assertSlugAvailable,
  fieldError,
  lockScopedRow,
  requireScopedRow,
  scopedId,
  setBooleanEnabled,
  setStatus
} from "./gatewayConfigStore.js";
import {
  GatewayConfigAdminError,
  type GatewayConfigMutationContext
} from "./gatewayConfigTypes.js";
import { workspaceScope } from "./scope.js";

export async function createLogicalModel(
  context: GatewayConfigMutationContext,
  input: unknown,
  preparedId?: string
) {
  const { tx, actor } = context;
  const body = parseGatewayBody(logicalModelCreateSchema, input, "invalid_logical_model");
  await validateLogicalModelDefinition(context, body.resolutionKind, body.routerConfig, body.enabled);
  await assertSlugAvailable(tx, logicalModels, actor, body.slug, "logical_model_slug_exists");
  const id = gatewayResourceId("logicalModel", preparedId);
  const now = new Date();
  await tx.insert(logicalModels).values({
    id,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    slug: body.slug,
    name: body.name,
    description: body.description ?? null,
    resolutionKind: body.resolutionKind,
    routerKind: body.resolutionKind === "router" ? "classifier" : null,
    routerConfig: body.routerConfig,
    status: body.enabled ? "active" : "disabled",
    createdAt: now,
    updatedAt: now
  });
  await context.appendEvent("logical_model", id, "created", {
    id,
    ...body,
    description: body.description ?? null,
    routerKind: body.resolutionKind === "router" ? "classifier" : null,
    status: body.enabled ? "active" : "disabled"
  }, now);
  return { resource: "logicalModel" as const, id };
}

export async function assertCreatedLogicalModelReady(
  context: GatewayConfigMutationContext,
  logicalModelId: string
) {
  const model = await requireScopedRow(
    context.tx,
    logicalModels,
    context.actor,
    logicalModelId,
    "logical_model_not_found"
  );
  await validateLogicalModelDefinition(
    context,
    model.resolutionKind,
    model.routerConfig,
    model.status === "active"
  );
  await assertDirectModelTargetCount(context, logicalModelId);
}

export async function updateLogicalModel(context: GatewayConfigMutationContext, id: string, input: unknown) {
  const { tx, actor } = context;
  const body = parseGatewayBody(logicalModelUpdateSchema, input, "invalid_logical_model");
  const current = await lockLogicalModel(context, id);
  const resolutionKind = body.resolutionKind ?? current.resolutionKind;
  const routerConfig = body.routerConfig ?? current.routerConfig;
  await validateLogicalModelDefinition(context, resolutionKind, routerConfig, current.status === "active");
  const now = new Date();
  const next = {
    name: body.name ?? current.name,
    description: body.description === undefined ? current.description : body.description,
    resolutionKind,
    routerKind: resolutionKind === "router" ? ("classifier" as const) : null,
    routerConfig
  };
  await tx.update(logicalModels).set({ ...next, updatedAt: now }).where(scopedId(logicalModels, actor, id));
  if (current.status === "active") await assertDirectModelTargetCount(context, id);
  await context.appendEvent("logical_model", id, "updated", {
    id,
    slug: current.slug,
    ...next,
    status: current.status
  }, now);
  return { resource: "logicalModel" as const, id };
}

export async function setLogicalModelEnabled(
  context: GatewayConfigMutationContext,
  id: string,
  enabled: boolean
) {
  const { tx, actor } = context;
  const current = await lockLogicalModel(context, id);
  if (enabled) {
    await validateLogicalModelDefinition(context, current.resolutionKind, current.routerConfig, true);
  }
  await setStatus(tx, logicalModels, actor, id, enabled);
  if (enabled) await assertDirectModelTargetCount(context, id);
  await context.appendEvent("logical_model", id, enabled ? "enabled" : "disabled", {
    id,
    slug: current.slug,
    status: enabled ? "active" : "disabled"
  });
  return { resource: "logicalModel" as const, id };
}

export async function createLogicalModelTarget(
  context: GatewayConfigMutationContext,
  input: unknown,
  preparedId?: string
) {
  const { tx, actor } = context;
  const body = parseGatewayBody(logicalModelTargetCreateSchema, input, "invalid_logical_model_target");
  await lockLogicalModel(context, body.logicalModelId);
  const deployment = await requireScopedRow(tx, modelDeployments, actor, body.deploymentId, "model_deployment_not_found");
  if (body.enabled) assertActiveDependencies([deployment]);
  const id = gatewayResourceId("logicalModelTarget", preparedId);
  const now = new Date();
  await tx.insert(logicalModelTargets).values({
    id,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    logicalModelId: body.logicalModelId,
    deploymentId: body.deploymentId,
    priority: body.priority,
    enabled: body.enabled,
    createdAt: now,
    updatedAt: now
  });
  await assertTargetMutationReady(context, body.logicalModelId);
  await context.appendEvent("logical_model_target", id, "created", { id, ...body }, now);
  return { resource: "logicalModelTarget" as const, id };
}

export async function updateLogicalModelTarget(
  context: GatewayConfigMutationContext,
  id: string,
  input: unknown
) {
  const { tx, actor } = context;
  const body = parseGatewayBody(logicalModelTargetUpdateSchema, input, "invalid_logical_model_target");
  const existing = await requireScopedRow(tx, logicalModelTargets, actor, id, "logical_model_target_not_found");
  await lockLogicalModel(context, existing.logicalModelId);
  const current = await requireScopedRow(tx, logicalModelTargets, actor, id, "logical_model_target_not_found");
  const deploymentId = body.deploymentId ?? current.deploymentId;
  const deployment = await requireScopedRow(tx, modelDeployments, actor, deploymentId, "model_deployment_not_found");
  if (current.enabled) assertActiveDependencies([deployment]);
  const now = new Date();
  const next = { deploymentId, priority: body.priority ?? current.priority };
  await tx.update(logicalModelTargets).set({ ...next, updatedAt: now })
    .where(scopedId(logicalModelTargets, actor, id));
  await assertTargetMutationReady(context, current.logicalModelId);
  await context.appendEvent("logical_model_target", id, "updated", {
    id,
    logicalModelId: current.logicalModelId,
    ...next,
    enabled: current.enabled
  }, now);
  return { resource: "logicalModelTarget" as const, id };
}

export async function setLogicalModelTargetEnabled(
  context: GatewayConfigMutationContext,
  id: string,
  enabled: boolean
) {
  const { tx, actor } = context;
  const existing = await requireScopedRow(tx, logicalModelTargets, actor, id, "logical_model_target_not_found");
  await lockLogicalModel(context, existing.logicalModelId);
  const current = await requireScopedRow(tx, logicalModelTargets, actor, id, "logical_model_target_not_found");
  if (enabled) {
    const deployment = await requireScopedRow(tx, modelDeployments, actor, current.deploymentId, "model_deployment_not_found");
    assertActiveDependencies([deployment]);
  }
  await setBooleanEnabled(tx, logicalModelTargets, actor, id, enabled);
  await assertTargetMutationReady(context, current.logicalModelId);
  await context.appendEvent("logical_model_target", id, enabled ? "enabled" : "disabled", {
    id,
    logicalModelId: current.logicalModelId,
    deploymentId: current.deploymentId,
    enabled
  });
  return { resource: "logicalModelTarget" as const, id };
}

async function validateLogicalModelDefinition(
  context: GatewayConfigMutationContext,
  resolutionKind: "direct" | "router",
  routerConfig: Record<string, unknown>,
  requireActive: boolean
) {
  const { tx, actor } = context;
  if (resolutionKind === "direct") {
    if (Object.keys(routerConfig).length > 0) {
      throw fieldError("logical_model_router_config_invalid", "routerConfig", "Direct models cannot define router configuration.");
    }
    return;
  }
  const config = logicalModelClassifierConfigSchema.safeParse(routerConfig);
  if (!config.success) {
    throw new GatewayConfigAdminError("logical_model_router_config_invalid", 400, config.error.issues.map((issue) => ({
      path: `routerConfig.${issue.path.join(".")}`,
      message: issue.message
    })));
  }
  const deployment = await requireScopedRow(
    tx,
    modelDeployments,
    actor,
    config.data.classifierDeploymentId,
    "classifier_deployment_not_found"
  );
  const connection = await requireScopedRow(
    tx,
    providerConnections,
    actor,
    deployment.providerConnectionId,
    "provider_connection_not_found"
  );
  const [binding] = await tx.select({ id: deploymentWireBindings.id })
    .from(deploymentWireBindings)
    .where(and(
      workspaceScope(deploymentWireBindings, actor.organizationId, actor.workspaceId),
      eq(deploymentWireBindings.deploymentId, deployment.id),
      eq(deploymentWireBindings.apiWireId, "openai-responses")
    ))
    .limit(1);
  if (!binding || connection.adapterKind !== "generic-http-json") {
    throw fieldError(
      "classifier_deployment_wire_incompatible",
      "routerConfig.classifierDeploymentId",
      "Classifier deployments require an OpenAI Responses binding on a generic HTTP connection."
    );
  }
  if (requireActive && !await activeClassifierDeployment(
    tx,
    actor.organizationId,
    actor.workspaceId,
    deployment.id
  )) {
    throw fieldError(
      "classifier_deployment_inactive",
      "routerConfig.classifierDeploymentId",
      "Active router models require an active classifier deployment and binding."
    );
  }
}

async function assertDirectModelTargetCount(context: GatewayConfigMutationContext, logicalModelId: string) {
  const { tx, actor } = context;
  const model = await requireScopedRow(tx, logicalModels, actor, logicalModelId, "logical_model_not_found");
  if (model.status !== "active" || model.resolutionKind !== "direct") return;
  const [row] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(logicalModelTargets)
    .where(and(
      workspaceScope(logicalModelTargets, actor.organizationId, actor.workspaceId),
      eq(logicalModelTargets.logicalModelId, logicalModelId),
      eq(logicalModelTargets.enabled, true)
    ));
  if (Number(row?.count ?? 0) !== 1) {
    throw new GatewayConfigAdminError("direct_logical_model_target_count_invalid", 400, [{
      path: "enabled",
      message: "An active direct logical model requires exactly one enabled target."
    }]);
  }
}

function assertTargetMutationReady(context: GatewayConfigMutationContext, logicalModelId: string) {
  if (context.deferredLogicalModelIds.has(logicalModelId)) return;
  return assertDirectModelTargetCount(context, logicalModelId);
}

async function lockLogicalModel(context: GatewayConfigMutationContext, logicalModelId: string) {
  const { tx, actor } = context;
  return lockScopedRow(tx, logicalModels, actor, logicalModelId, "logical_model_not_found");
}
