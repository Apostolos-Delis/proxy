import type { GatewayConfigAdminService } from "./gatewayConfigAdmin.js";
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
  requireReference
} from "./gatewayConfigPlanSupport.js";
import { GatewayConfigAdminError } from "./gatewayConfigTypes.js";

export async function planAccessResources(
  service: GatewayConfigAdminService,
  document: GatewayConfigDocument,
  current: GatewayConfigCurrentState,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder
) {
  planAccessProfiles(document, current, projected, builder);
  planModelGrants(document, current, projected, builder);
  await planApiKeyAssignments(service, document, projected, builder);
}

function planAccessProfiles(
  document: GatewayConfigDocument,
  current: GatewayConfigCurrentState,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder
) {
  const currentBySlug = new Map(current.accessProfiles.map((row) => [row.slug, row]));
  for (const resource of document.access_profiles) {
    const row = currentBySlug.get(resource.slug);
    if (!row) {
      const id = gatewayResourceId("accessProfile");
      builder.create("accessProfile", id, resource.slug, {
        slug: resource.slug,
        name: resource.name,
        description: resource.description ?? null,
        limits: resource.limits,
        enabled: resource.enabled
      });
      const created = { id, slug: resource.slug, status: projectedStatus(resource.enabled) };
      projected.accessProfilesById.set(id, created);
      projected.accessProfilesBySlug.set(resource.slug, created);
      continue;
    }
    const desired = {
      name: resource.name,
      description: resource.description ?? null,
      limits: resource.limits
    };
    const fields = changedFields(row, desired);
    if (fields.length > 0) {
      builder.update(
        "accessProfile",
        row.id,
        resource.slug,
        Object.fromEntries(fields.map((field) => [field, desired[field as keyof typeof desired]])),
        fields
      );
    }
    if (active(row.status) !== resource.enabled) {
      builder.setEnabled("accessProfile", row.id, resource.slug, resource.enabled);
    }
    const next = { id: row.id, slug: row.slug, status: projectedStatus(resource.enabled) };
    projected.accessProfilesById.set(row.id, next);
    projected.accessProfilesBySlug.set(row.slug, next);
  }
}

function planModelGrants(
  document: GatewayConfigDocument,
  current: GatewayConfigCurrentState,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder
) {
  const currentByIdentity = new Map(current.grants.map((row) => [
    compositeKey(row.accessProfileId, row.logicalModelId),
    row
  ]));
  for (const resource of document.model_grants) {
    const profile = requireReference(
      projected.accessProfilesBySlug,
      resource.access_profile,
      `model_grants.${resource.access_profile}.${resource.logical_model}.access_profile`
    );
    const logicalModel = requireReference(
      projected.logicalModelsBySlug,
      resource.logical_model,
      `model_grants.${resource.access_profile}.${resource.logical_model}.logical_model`
    );
    const identity = compositeKey(profile.id, logicalModel.id);
    const reference = `${resource.access_profile}:${resource.logical_model}`;
    const row = currentByIdentity.get(identity);
    const allowedOperations = [...new Set(resource.allowed_operations)].sort();
    if (!row) {
      const id = gatewayResourceId("modelGrant");
      builder.create("modelGrant", id, reference, {
        accessProfileId: profile.id,
        logicalModelId: logicalModel.id,
        allowedOperations,
        parameterCaps: resource.parameter_caps,
        enabled: resource.enabled
      });
      projected.grantsByIdentity.set(identity, {
        id,
        accessProfileId: profile.id,
        logicalModelId: logicalModel.id,
        enabled: resource.enabled
      });
      continue;
    }
    const desired = {
      allowedOperations,
      parameterCaps: resource.parameter_caps
    };
    const comparable = {
      allowedOperations: [...row.allowedOperations].sort(),
      parameterCaps: row.parameterCaps
    };
    const fields = changedFields(comparable, desired);
    if (fields.length > 0) {
      builder.update(
        "modelGrant",
        row.id,
        reference,
        Object.fromEntries(fields.map((field) => [field, desired[field as keyof typeof desired]])),
        fields
      );
    }
    if (row.enabled !== resource.enabled) {
      builder.setEnabled("modelGrant", row.id, reference, resource.enabled);
    }
    projected.grantsByIdentity.set(identity, { ...row, enabled: resource.enabled });
  }
}

async function planApiKeyAssignments(
  service: GatewayConfigAdminService,
  document: GatewayConfigDocument,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder
) {
  const rows = await service.apiKeyAccessProfiles(
    builder.scope,
    document.api_key_assignments.map((assignment) => assignment.api_key_id)
  );
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  for (const assignment of document.api_key_assignments) {
    const row = rowsById.get(assignment.api_key_id);
    if (!row) {
      throw new GatewayConfigAdminError("api_key_not_found", 400, [{
        path: `api_key_assignments.${assignment.api_key_id}`,
        message: "The API key does not exist in the configured scope."
      }]);
    }
    const profile = requireReference(
      projected.accessProfilesBySlug,
      assignment.access_profile,
      `api_key_assignments.${assignment.api_key_id}.access_profile`
    );
    if (!active(profile.status)) {
      throw new GatewayConfigAdminError("gateway_config_projected_state_invalid", 400, [{
        path: `api_key_assignments.${assignment.api_key_id}.access_profile`,
        message: "API keys can only be assigned to an active access profile."
      }]);
    }
    if (row.accessProfileId !== profile.id) builder.assignApiKey(row.id, profile.id);
  }
}
