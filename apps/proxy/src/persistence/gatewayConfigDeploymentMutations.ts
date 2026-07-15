import {
  canonicalModels,
  deploymentWireBindings,
  modelDeployments,
  providerConnections
} from "@proxy/db";
import type { GatewayModelCapabilities } from "@proxy/schema";

import {
  modelDeploymentCreateSchema,
  modelDeploymentUpdateSchema,
  parseGatewayBody,
  wireBindingCreateSchema,
  wireBindingUpdateSchema
} from "./gatewayConfigSchemas.js";
import { gatewayResourceId } from "./gatewayConfigIds.js";
import {
  assertActiveDependencies,
  assertNonSecretJson,
  assertSlugAvailable,
  fieldError,
  lockScopedRow,
  requireScopedRow,
  scopedId,
  setBooleanEnabled,
  setStatus
} from "./gatewayConfigStore.js";
import type { GatewayConfigMutationContext } from "./gatewayConfigTypes.js";

export async function createModelDeployment(
  context: GatewayConfigMutationContext,
  input: unknown,
  preparedId?: string
) {
  const { tx, actor } = context;
  const body = parseGatewayBody(modelDeploymentCreateSchema, input, "invalid_model_deployment");
  assertNonSecretJson(body.config, "config");
  assertNonSecretJson(body.capabilities, "capabilities");
  assertNonSecretJson(body.pricing, "pricing");
  const canonical = await requireScopedRow(tx, canonicalModels, actor, body.canonicalModelId, "canonical_model_not_found");
  const connection = await requireScopedRow(
    tx,
    providerConnections,
    actor,
    body.providerConnectionId,
    "provider_connection_not_found"
  );
  assertCapabilitiesWithin(canonical.capabilities, body.capabilities);
  if (body.enabled) assertActiveDependencies([canonical, connection]);
  await assertSlugAvailable(tx, modelDeployments, actor, body.slug, "model_deployment_slug_exists");
  const id = gatewayResourceId("modelDeployment", preparedId);
  const now = new Date();
  await tx.insert(modelDeployments).values({
    id,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    slug: body.slug,
    name: body.name,
    canonicalModelId: body.canonicalModelId,
    providerConnectionId: body.providerConnectionId,
    upstreamModelId: body.upstreamModelId,
    region: body.region ?? null,
    config: body.config,
    capabilities: body.capabilities,
    pricing: body.pricing,
    status: body.enabled ? "active" : "disabled",
    createdAt: now,
    updatedAt: now
  });
  await context.appendEvent("model_deployment", id, "created", {
    id,
    ...body,
    region: body.region ?? null,
    status: body.enabled ? "active" : "disabled"
  }, now);
  return { resource: "modelDeployment" as const, id };
}

export async function updateModelDeployment(context: GatewayConfigMutationContext, id: string, input: unknown) {
  const { tx, actor } = context;
  const body = parseGatewayBody(modelDeploymentUpdateSchema, input, "invalid_model_deployment");
  const current = await lockScopedRow(tx, modelDeployments, actor, id, "model_deployment_not_found");
  const canonical = await requireScopedRow(tx, canonicalModels, actor, current.canonicalModelId, "canonical_model_not_found");
  const capabilities = body.capabilities ?? current.capabilities;
  assertCapabilitiesWithin(canonical.capabilities, capabilities);
  const now = new Date();
  const next = {
    name: body.name ?? current.name,
    upstreamModelId: body.upstreamModelId ?? current.upstreamModelId,
    region: body.region === undefined ? current.region : body.region,
    config: body.config ?? current.config,
    capabilities,
    pricing: body.pricing ?? current.pricing
  };
  assertNonSecretJson(next.config, "config");
  assertNonSecretJson(next.capabilities, "capabilities");
  assertNonSecretJson(next.pricing, "pricing");
  await tx.update(modelDeployments).set({ ...next, updatedAt: now })
    .where(scopedId(modelDeployments, actor, id));
  await context.appendEvent("model_deployment", id, "updated", {
    id,
    slug: current.slug,
    canonicalModelId: current.canonicalModelId,
    providerConnectionId: current.providerConnectionId,
    ...next,
    status: current.status
  }, now);
  return { resource: "modelDeployment" as const, id };
}

export async function setModelDeploymentEnabled(
  context: GatewayConfigMutationContext,
  id: string,
  enabled: boolean
) {
  const { tx, actor } = context;
  const current = await lockScopedRow(tx, modelDeployments, actor, id, "model_deployment_not_found");
  if (enabled) {
    const canonical = await requireScopedRow(tx, canonicalModels, actor, current.canonicalModelId, "canonical_model_not_found");
    const connection = await requireScopedRow(
      tx,
      providerConnections,
      actor,
      current.providerConnectionId,
      "provider_connection_not_found"
    );
    assertActiveDependencies([canonical, connection]);
  }
  await setStatus(tx, modelDeployments, actor, id, enabled);
  await context.appendEvent("model_deployment", id, enabled ? "enabled" : "disabled", {
    id,
    slug: current.slug,
    status: enabled ? "active" : "disabled"
  });
  return { resource: "modelDeployment" as const, id };
}

export async function createWireBinding(
  context: GatewayConfigMutationContext,
  input: unknown,
  preparedId?: string
) {
  const { tx, actor } = context;
  const body = parseGatewayBody(wireBindingCreateSchema, input, "invalid_wire_binding");
  assertNonSecretJson(body.requestConfig, "requestConfig");
  const deployment = await requireScopedRow(tx, modelDeployments, actor, body.deploymentId, "model_deployment_not_found");
  const connection = await requireScopedRow(
    tx,
    providerConnections,
    actor,
    deployment.providerConnectionId,
    "provider_connection_not_found"
  );
  validateWireBinding(connection.adapterKind, body.apiWireId, body.endpointPath ?? null);
  if (body.enabled) assertActiveDependencies([deployment, connection]);
  const id = gatewayResourceId("wireBinding", preparedId);
  const now = new Date();
  await tx.insert(deploymentWireBindings).values({
    id,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    deploymentId: body.deploymentId,
    providerConnectionId: deployment.providerConnectionId,
    apiWireId: body.apiWireId,
    endpointPath: body.endpointPath ?? null,
    requestConfig: body.requestConfig,
    adapterContractVersion: body.adapterContractVersion,
    enabled: body.enabled,
    createdAt: now,
    updatedAt: now
  });
  await context.appendEvent("deployment_wire_binding", id, "created", {
    id,
    ...body,
    providerConnectionId: deployment.providerConnectionId,
    endpointPath: body.endpointPath ?? null
  }, now);
  return { resource: "wireBinding" as const, id };
}

export async function updateWireBinding(context: GatewayConfigMutationContext, id: string, input: unknown) {
  const { tx, actor } = context;
  const body = parseGatewayBody(wireBindingUpdateSchema, input, "invalid_wire_binding");
  const current = await lockScopedRow(tx, deploymentWireBindings, actor, id, "wire_binding_not_found");
  const connection = await requireScopedRow(
    tx,
    providerConnections,
    actor,
    current.providerConnectionId,
    "provider_connection_not_found"
  );
  const endpointPath = body.endpointPath === undefined ? current.endpointPath : body.endpointPath;
  validateWireBinding(connection.adapterKind, current.apiWireId, endpointPath);
  const now = new Date();
  const next = {
    endpointPath,
    requestConfig: body.requestConfig ?? current.requestConfig,
    adapterContractVersion: body.adapterContractVersion ?? current.adapterContractVersion
  };
  assertNonSecretJson(next.requestConfig, "requestConfig");
  await tx.update(deploymentWireBindings).set({ ...next, updatedAt: now })
    .where(scopedId(deploymentWireBindings, actor, id));
  await context.appendEvent("deployment_wire_binding", id, "updated", {
    id,
    deploymentId: current.deploymentId,
    providerConnectionId: current.providerConnectionId,
    apiWireId: current.apiWireId,
    ...next,
    enabled: current.enabled
  }, now);
  return { resource: "wireBinding" as const, id };
}

export async function setWireBindingEnabled(
  context: GatewayConfigMutationContext,
  id: string,
  enabled: boolean
) {
  const { tx, actor } = context;
  const current = await lockScopedRow(tx, deploymentWireBindings, actor, id, "wire_binding_not_found");
  if (enabled) {
    const deployment = await requireScopedRow(tx, modelDeployments, actor, current.deploymentId, "model_deployment_not_found");
    const connection = await requireScopedRow(
      tx,
      providerConnections,
      actor,
      current.providerConnectionId,
      "provider_connection_not_found"
    );
    assertActiveDependencies([deployment, connection]);
    validateWireBinding(connection.adapterKind, current.apiWireId, current.endpointPath);
  }
  await setBooleanEnabled(tx, deploymentWireBindings, actor, id, enabled);
  await context.appendEvent("deployment_wire_binding", id, enabled ? "enabled" : "disabled", {
    id,
    deploymentId: current.deploymentId,
    apiWireId: current.apiWireId,
    enabled
  });
  return { resource: "wireBinding" as const, id };
}

export function validateWireBinding(adapterKind: string, wireId: string, endpointPath: string | null) {
  const bedrockWire = wireId === "bedrock-converse";
  const bedrockAdapter = adapterKind === "aws-bedrock-converse";
  if (bedrockWire !== bedrockAdapter) {
    throw fieldError(
      "wire_binding_adapter_incompatible",
      "apiWireId",
      "The wire is incompatible with the provider connection adapter."
    );
  }
  if (bedrockWire && endpointPath !== null) {
    throw fieldError("wire_binding_endpoint_invalid", "endpointPath", "Bedrock bindings cannot define an endpoint path.");
  }
  if (!bedrockWire && (!endpointPath || !/^\/(?!\/)[^\\\s?#]*$/.test(endpointPath))) {
    throw fieldError(
      "wire_binding_endpoint_invalid",
      "endpointPath",
      "HTTP bindings require a path beginning with '/' and cannot include a query or fragment."
    );
  }
}

export function assertCapabilitiesWithin(canonical: GatewayModelCapabilities, deployment: GatewayModelCapabilities) {
  for (const [key, value] of Object.entries(deployment)) {
    if (!capabilityWithin(canonical[key], value)) {
      throw fieldError(
        "model_deployment_capabilities_expand_canonical",
        `capabilities.${key}`,
        "Deployment capabilities may only narrow the canonical model."
      );
    }
  }
}

function capabilityWithin(
  canonical: GatewayModelCapabilities[string] | undefined,
  deployment: GatewayModelCapabilities[string]
) {
  if (typeof deployment === "boolean") return deployment === false || canonical === true;
  if (typeof deployment === "number") return typeof canonical === "number" && deployment <= canonical;
  return Array.isArray(canonical) && deployment.every((entry) => canonical.includes(entry));
}
