import {
  accessProfileModelGrants,
  accessProfiles,
  apiKeys,
  logicalModels
} from "@proxy/db";

import {
  accessProfileCreateSchema,
  accessProfileUpdateSchema,
  modelGrantCreateSchema,
  modelGrantUpdateSchema,
  parseGatewayBody
} from "./gatewayConfigSchemas.js";
import { gatewayResourceId } from "./gatewayConfigIds.js";
import {
  assertActiveDependencies,
  assertSlugAvailable,
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

export async function createAccessProfile(
  context: GatewayConfigMutationContext,
  input: unknown,
  preparedId?: string
) {
  const { tx, actor } = context;
  const body = parseGatewayBody(accessProfileCreateSchema, input, "invalid_access_profile");
  await assertSlugAvailable(tx, accessProfiles, actor, body.slug, "access_profile_slug_exists");
  const id = gatewayResourceId("accessProfile", preparedId);
  const now = new Date();
  await tx.insert(accessProfiles).values({
    id,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    slug: body.slug,
    name: body.name,
    description: body.description ?? null,
    limits: body.limits,
    status: body.enabled ? "active" : "disabled",
    createdAt: now,
    updatedAt: now
  });
  await context.appendEvent("access_profile", id, "created", {
    id,
    ...body,
    description: body.description ?? null,
    status: body.enabled ? "active" : "disabled"
  }, now);
  return { resource: "accessProfile" as const, id };
}

export async function updateAccessProfile(context: GatewayConfigMutationContext, id: string, input: unknown) {
  const { tx, actor } = context;
  const body = parseGatewayBody(accessProfileUpdateSchema, input, "invalid_access_profile");
  const current = await lockScopedRow(tx, accessProfiles, actor, id, "access_profile_not_found");
  const now = new Date();
  const next = {
    name: body.name ?? current.name,
    description: body.description === undefined ? current.description : body.description,
    limits: body.limits ?? current.limits
  };
  await tx.update(accessProfiles).set({ ...next, updatedAt: now }).where(scopedId(accessProfiles, actor, id));
  await context.appendEvent("access_profile", id, "updated", {
    id,
    slug: current.slug,
    ...next,
    status: current.status
  }, now);
  return { resource: "accessProfile" as const, id };
}

export async function setAccessProfileEnabled(
  context: GatewayConfigMutationContext,
  id: string,
  enabled: boolean
) {
  const { tx, actor } = context;
  const current = await lockScopedRow(tx, accessProfiles, actor, id, "access_profile_not_found");
  await setStatus(tx, accessProfiles, actor, id, enabled);
  await context.appendEvent("access_profile", id, enabled ? "enabled" : "disabled", {
    id,
    slug: current.slug,
    status: enabled ? "active" : "disabled"
  });
  return { resource: "accessProfile" as const, id };
}

export async function createModelGrant(
  context: GatewayConfigMutationContext,
  input: unknown,
  preparedId?: string
) {
  const { tx, actor } = context;
  const body = parseGatewayBody(modelGrantCreateSchema, input, "invalid_model_grant");
  const profile = await requireScopedRow(tx, accessProfiles, actor, body.accessProfileId, "access_profile_not_found");
  const logicalModel = await requireScopedRow(tx, logicalModels, actor, body.logicalModelId, "logical_model_not_found");
  if (body.enabled) assertActiveDependencies([profile, logicalModel]);
  const allowedOperations = [...new Set(body.allowedOperations)];
  const id = gatewayResourceId("modelGrant", preparedId);
  const now = new Date();
  await tx.insert(accessProfileModelGrants).values({
    id,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    accessProfileId: body.accessProfileId,
    logicalModelId: body.logicalModelId,
    allowedOperations,
    parameterCaps: body.parameterCaps,
    enabled: body.enabled,
    createdAt: now,
    updatedAt: now
  });
  await context.appendEvent("access_profile_model_grant", id, "created", {
    id,
    ...body,
    allowedOperations
  }, now);
  return { resource: "modelGrant" as const, id };
}

export async function updateModelGrant(context: GatewayConfigMutationContext, id: string, input: unknown) {
  const { tx, actor } = context;
  const body = parseGatewayBody(modelGrantUpdateSchema, input, "invalid_model_grant");
  const current = await lockScopedRow(tx, accessProfileModelGrants, actor, id, "model_grant_not_found");
  const now = new Date();
  const next = {
    allowedOperations: body.allowedOperations ? [...new Set(body.allowedOperations)] : current.allowedOperations,
    parameterCaps: body.parameterCaps ?? current.parameterCaps
  };
  await tx.update(accessProfileModelGrants).set({ ...next, updatedAt: now })
    .where(scopedId(accessProfileModelGrants, actor, id));
  await context.appendEvent("access_profile_model_grant", id, "updated", {
    id,
    accessProfileId: current.accessProfileId,
    logicalModelId: current.logicalModelId,
    ...next,
    enabled: current.enabled
  }, now);
  return { resource: "modelGrant" as const, id };
}

export async function setModelGrantEnabled(
  context: GatewayConfigMutationContext,
  id: string,
  enabled: boolean
) {
  const { tx, actor } = context;
  const current = await lockScopedRow(tx, accessProfileModelGrants, actor, id, "model_grant_not_found");
  if (enabled) {
    const profile = await requireScopedRow(tx, accessProfiles, actor, current.accessProfileId, "access_profile_not_found");
    const logicalModel = await requireScopedRow(tx, logicalModels, actor, current.logicalModelId, "logical_model_not_found");
    assertActiveDependencies([profile, logicalModel]);
  }
  await setBooleanEnabled(tx, accessProfileModelGrants, actor, id, enabled);
  await context.appendEvent("access_profile_model_grant", id, enabled ? "enabled" : "disabled", {
    id,
    accessProfileId: current.accessProfileId,
    logicalModelId: current.logicalModelId,
    enabled
  });
  return { resource: "modelGrant" as const, id };
}

export async function assignApiKeyAccessProfile(
  context: GatewayConfigMutationContext,
  apiKeyId: string,
  accessProfileId: string
) {
  const { tx, actor } = context;
  const key = await lockScopedRow(tx, apiKeys, actor, apiKeyId, "api_key_not_found");
  const profile = await requireScopedRow(tx, accessProfiles, actor, accessProfileId, "access_profile_not_found");
  if (profile.status !== "active") throw new GatewayConfigAdminError("access_profile_inactive", 400);
  const now = new Date();
  await tx.update(apiKeys).set({ accessProfileId }).where(scopedId(apiKeys, actor, apiKeyId));
  await context.appendEvent("api_key", apiKeyId, "access_profile_assigned", {
    apiKeyId,
    apiKeyName: key.name,
    accessProfileId
  }, now);
  return { resource: "apiKey" as const, id: apiKeyId };
}
