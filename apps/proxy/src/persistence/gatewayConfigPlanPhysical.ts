import type { GatewayConfigDocument } from "./gatewayConfigDocument.js";
import { gatewayResourceId } from "./gatewayConfigIds.js";
import {
  active,
  assertImmutable,
  changedFields,
  compositeKey,
  type GatewayConfigCurrentState,
  GatewayConfigPlanBuilder,
  projectedStatus,
  type ProjectedGatewayConfig,
  requireReference
} from "./gatewayConfigPlanSupport.js";
import { trimProviderBaseUrl } from "./providers.js";

export function planPhysicalResources(
  document: GatewayConfigDocument,
  current: GatewayConfigCurrentState,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder
) {
  planProviderConnections(document, current, projected, builder);
  planCanonicalModels(document, current, projected, builder);
  planModelDeployments(document, current, projected, builder);
  planWireBindings(document, current, projected, builder);
}

function planProviderConnections(
  document: GatewayConfigDocument,
  current: GatewayConfigCurrentState,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder
) {
  const currentBySlug = new Map(current.connections.map((row) => [row.slug, row]));
  for (const resource of document.provider_connections) {
    const row = currentBySlug.get(resource.slug);
    const baseUrl = trimProviderBaseUrl(resource.base_url);
    if (!row) {
      const id = gatewayResourceId("providerConnection");
      builder.create("providerConnection", id, resource.slug, {
        slug: resource.slug,
        name: resource.name,
        adapterKind: resource.adapter_kind,
        authStyle: resource.auth_style,
        baseUrl,
        region: resource.region ?? null,
        ...(resource.secret_ref ? { secretRef: resource.secret_ref } : {}),
        adapterConfig: resource.adapter_config,
        defaultHeaders: resource.default_headers,
        enabled: resource.enabled
      });
      const created = {
        id,
        slug: resource.slug,
        adapterKind: resource.adapter_kind,
        authStyle: resource.auth_style,
        baseUrl,
        credentialConfigured: Boolean(resource.secret_ref),
        status: projectedStatus(resource.enabled)
      };
      projected.connectionsById.set(id, created);
      projected.connectionsBySlug.set(resource.slug, created);
      continue;
    }
    assertImmutable(row.adapterKind, resource.adapter_kind, `provider_connections.${resource.slug}.adapter_kind`);
    const desired = {
      name: resource.name,
      authStyle: resource.auth_style,
      baseUrl,
      region: resource.region ?? null,
      adapterConfig: resource.adapter_config,
      defaultHeaders: resource.default_headers
    };
    const fields = changedFields(row, desired);
    const body: Record<string, unknown> = Object.fromEntries(fields.map((field) => [field, desired[field as keyof typeof desired]]));
    const providerOriginChanged = new URL(baseUrl).origin !== new URL(row.baseUrl).origin;
    if (resource.secret_ref !== undefined && (resource.secret_ref !== row.secretRef || providerOriginChanged)) {
      body.secretRef = resource.secret_ref;
      fields.push("secretRef");
    } else if (resource.clear_secret && row.credentialConfigured) {
      body.clearSecret = true;
      fields.push("credential");
    }
    if (fields.length > 0) {
      builder.update("providerConnection", row.id, resource.slug, body, fields);
    }
    const enabled = active(row.status);
    if (enabled !== resource.enabled) {
      builder.setEnabled("providerConnection", row.id, resource.slug, resource.enabled);
    }
    let credentialConfigured = row.credentialConfigured;
    if (resource.auth_style === "none" || resource.clear_secret) credentialConfigured = false;
    if (resource.secret_ref) credentialConfigured = true;
    const next = {
      id: row.id,
      slug: row.slug,
      adapterKind: row.adapterKind,
      authStyle: resource.auth_style,
      baseUrl,
      credentialConfigured,
      status: projectedStatus(resource.enabled)
    };
    projected.connectionsById.set(row.id, next);
    projected.connectionsBySlug.set(row.slug, next);
  }
}

function planCanonicalModels(
  document: GatewayConfigDocument,
  current: GatewayConfigCurrentState,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder
) {
  const currentBySlug = new Map(current.canonicalModels.map((row) => [row.slug, row]));
  for (const resource of document.canonical_models) {
    const row = currentBySlug.get(resource.slug);
    if (!row) {
      const id = gatewayResourceId("canonicalModel");
      builder.create("canonicalModel", id, resource.slug, {
        slug: resource.slug,
        name: resource.name,
        vendor: resource.vendor,
        family: resource.family,
        release: resource.release ?? null,
        capabilities: resource.capabilities,
        enabled: resource.enabled
      });
      const created = {
        id,
        slug: resource.slug,
        capabilities: resource.capabilities,
        status: projectedStatus(resource.enabled)
      };
      projected.canonicalModelsById.set(id, created);
      projected.canonicalModelsBySlug.set(resource.slug, created);
      continue;
    }
    assertImmutable(row.vendor, resource.vendor, `canonical_models.${resource.slug}.vendor`);
    assertImmutable(row.family, resource.family, `canonical_models.${resource.slug}.family`);
    assertImmutable(row.release, resource.release ?? null, `canonical_models.${resource.slug}.release`);
    assertImmutable(row.capabilities, resource.capabilities, `canonical_models.${resource.slug}.capabilities`);
    if (row.name !== resource.name) {
      builder.update("canonicalModel", row.id, resource.slug, { name: resource.name }, ["name"]);
    }
    if (active(row.status) !== resource.enabled) {
      builder.setEnabled("canonicalModel", row.id, resource.slug, resource.enabled);
    }
    const next = {
      id: row.id,
      slug: row.slug,
      capabilities: row.capabilities,
      status: projectedStatus(resource.enabled)
    };
    projected.canonicalModelsById.set(row.id, next);
    projected.canonicalModelsBySlug.set(row.slug, next);
  }
}

function planModelDeployments(
  document: GatewayConfigDocument,
  current: GatewayConfigCurrentState,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder
) {
  const currentBySlug = new Map(current.deployments.map((row) => [row.slug, row]));
  for (const resource of document.model_deployments) {
    const canonical = requireReference(
      projected.canonicalModelsBySlug,
      resource.canonical_model,
      `model_deployments.${resource.slug}.canonical_model`
    );
    const connection = requireReference(
      projected.connectionsBySlug,
      resource.provider_connection,
      `model_deployments.${resource.slug}.provider_connection`
    );
    const row = currentBySlug.get(resource.slug);
    if (!row) {
      const id = gatewayResourceId("modelDeployment");
      builder.create("modelDeployment", id, resource.slug, {
        slug: resource.slug,
        name: resource.name,
        canonicalModelId: canonical.id,
        providerConnectionId: connection.id,
        upstreamModelId: resource.upstream_model_id,
        region: resource.region ?? null,
        config: resource.config,
        capabilities: resource.capabilities,
        pricing: resource.pricing,
        enabled: resource.enabled
      });
      const created = {
        id,
        slug: resource.slug,
        canonicalModelId: canonical.id,
        providerConnectionId: connection.id,
        capabilities: resource.capabilities,
        status: projectedStatus(resource.enabled)
      };
      projected.deploymentsById.set(id, created);
      projected.deploymentsBySlug.set(resource.slug, created);
      continue;
    }
    assertImmutable(row.canonicalModelId, canonical.id, `model_deployments.${resource.slug}.canonical_model`);
    assertImmutable(row.providerConnectionId, connection.id, `model_deployments.${resource.slug}.provider_connection`);
    const desired = {
      name: resource.name,
      upstreamModelId: resource.upstream_model_id,
      region: resource.region ?? null,
      config: resource.config,
      capabilities: resource.capabilities,
      pricing: resource.pricing
    };
    const fields = changedFields(row, desired);
    if (fields.length > 0) {
      builder.update(
        "modelDeployment",
        row.id,
        resource.slug,
        Object.fromEntries(fields.map((field) => [field, desired[field as keyof typeof desired]])),
        fields
      );
    }
    if (active(row.status) !== resource.enabled) {
      builder.setEnabled("modelDeployment", row.id, resource.slug, resource.enabled);
    }
    const next = {
      id: row.id,
      slug: row.slug,
      canonicalModelId: row.canonicalModelId,
      providerConnectionId: row.providerConnectionId,
      capabilities: resource.capabilities,
      status: projectedStatus(resource.enabled)
    };
    projected.deploymentsById.set(row.id, next);
    projected.deploymentsBySlug.set(row.slug, next);
  }
}

function planWireBindings(
  document: GatewayConfigDocument,
  current: GatewayConfigCurrentState,
  projected: ProjectedGatewayConfig,
  builder: GatewayConfigPlanBuilder
) {
  const currentByIdentity = new Map(current.bindings.map((row) => [compositeKey(row.deploymentId, row.apiWireId), row]));
  for (const resource of document.wire_bindings) {
    const deployment = requireReference(
      projected.deploymentsBySlug,
      resource.deployment,
      `wire_bindings.${resource.deployment}.${resource.api_wire}.deployment`
    );
    const identity = compositeKey(deployment.id, resource.api_wire);
    const reference = `${resource.deployment}:${resource.api_wire}`;
    const row = currentByIdentity.get(identity);
    if (!row) {
      const id = gatewayResourceId("wireBinding");
      builder.create("wireBinding", id, reference, {
        deploymentId: deployment.id,
        apiWireId: resource.api_wire,
        endpointPath: resource.endpoint_path ?? null,
        requestConfig: resource.request_config,
        adapterContractVersion: resource.adapter_contract_version,
        enabled: resource.enabled
      });
      projected.bindingsByIdentity.set(identity, {
        id,
        deploymentId: deployment.id,
        providerConnectionId: deployment.providerConnectionId,
        apiWireId: resource.api_wire,
        endpointPath: resource.endpoint_path ?? null,
        enabled: resource.enabled
      });
      continue;
    }
    const desired = {
      endpointPath: resource.endpoint_path ?? null,
      requestConfig: resource.request_config,
      adapterContractVersion: resource.adapter_contract_version
    };
    const fields = changedFields(row, desired);
    if (fields.length > 0) {
      builder.update(
        "wireBinding",
        row.id,
        reference,
        Object.fromEntries(fields.map((field) => [field, desired[field as keyof typeof desired]])),
        fields
      );
    }
    if (row.enabled !== resource.enabled) {
      builder.setEnabled("wireBinding", row.id, reference, resource.enabled);
    }
    projected.bindingsByIdentity.set(identity, {
      ...row,
      endpointPath: resource.endpoint_path ?? null,
      enabled: resource.enabled
    });
  }
}
