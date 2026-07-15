import type { GatewayConfigAdminService } from "../../persistence/gatewayConfigAdmin.js";
import { builder } from "../builder.js";

type Connection = Awaited<ReturnType<GatewayConfigAdminService["providerConnections"]>>[number];
type CanonicalModel = Awaited<ReturnType<GatewayConfigAdminService["canonicalModels"]>>[number];
type Deployment = Awaited<ReturnType<GatewayConfigAdminService["modelDeployments"]>>[number];
type WireBinding = Awaited<ReturnType<GatewayConfigAdminService["wireBindings"]>>[number];
type LogicalModel = Awaited<ReturnType<GatewayConfigAdminService["logicalModels"]>>[number];
type LogicalTarget = Awaited<ReturnType<GatewayConfigAdminService["logicalModelTargets"]>>[number];
type AccessProfile = Awaited<ReturnType<GatewayConfigAdminService["accessProfiles"]>>[number];
type ModelGrant = Awaited<ReturnType<GatewayConfigAdminService["modelGrants"]>>[number];

export const GatewayProviderConnection = builder.objectRef<Connection>("GatewayProviderConnection").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    organizationId: t.exposeID("organizationId"),
    workspaceId: t.exposeID("workspaceId"),
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    adapterKind: t.exposeString("adapterKind"),
    authStyle: t.exposeString("authStyle"),
    baseUrl: t.exposeString("baseUrl"),
    region: t.exposeString("region", { nullable: true }),
    secretRef: t.exposeString("secretRef", { nullable: true }),
    secretHint: t.exposeString("secretHint", { nullable: true }),
    credentialConfigured: t.exposeBoolean("credentialConfigured"),
    adapterConfig: t.field({ type: "JSON", resolve: (row) => row.adapterConfig }),
    defaultHeaders: t.field({ type: "JSON", resolve: (row) => row.defaultHeaders }),
    status: t.exposeString("status"),
    enabled: t.boolean({ resolve: (row) => row.status === "active" }),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt")
  })
});

export const GatewayCanonicalModel = builder.objectRef<CanonicalModel>("GatewayCanonicalModel").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    organizationId: t.exposeID("organizationId"),
    workspaceId: t.exposeID("workspaceId"),
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    vendor: t.exposeString("vendor"),
    family: t.exposeString("family"),
    release: t.exposeString("release", { nullable: true }),
    capabilities: t.field({ type: "JSON", resolve: (row) => row.capabilities }),
    status: t.exposeString("status"),
    enabled: t.boolean({ resolve: (row) => row.status === "active" }),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt")
  })
});

export const GatewayModelDeployment = builder.objectRef<Deployment>("GatewayModelDeployment").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    organizationId: t.exposeID("organizationId"),
    workspaceId: t.exposeID("workspaceId"),
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    canonicalModelId: t.exposeID("canonicalModelId"),
    providerConnectionId: t.exposeID("providerConnectionId"),
    upstreamModelId: t.exposeString("upstreamModelId"),
    region: t.exposeString("region", { nullable: true }),
    config: t.field({ type: "JSON", resolve: (row) => row.config }),
    capabilities: t.field({ type: "JSON", resolve: (row) => row.capabilities }),
    pricing: t.field({ type: "JSON", resolve: (row) => row.pricing }),
    status: t.exposeString("status"),
    enabled: t.boolean({ resolve: (row) => row.status === "active" }),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt")
  })
});

export const GatewayWireBinding = builder.objectRef<WireBinding>("GatewayWireBinding").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    organizationId: t.exposeID("organizationId"),
    workspaceId: t.exposeID("workspaceId"),
    deploymentId: t.exposeID("deploymentId"),
    providerConnectionId: t.exposeID("providerConnectionId"),
    apiWireId: t.exposeString("apiWireId"),
    endpointPath: t.exposeString("endpointPath", { nullable: true }),
    requestConfig: t.field({ type: "JSON", resolve: (row) => row.requestConfig }),
    adapterContractVersion: t.exposeString("adapterContractVersion"),
    enabled: t.exposeBoolean("enabled"),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt")
  })
});

export const GatewayLogicalModel = builder.objectRef<LogicalModel>("GatewayLogicalModel").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    organizationId: t.exposeID("organizationId"),
    workspaceId: t.exposeID("workspaceId"),
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    resolutionKind: t.exposeString("resolutionKind"),
    routerKind: t.exposeString("routerKind", { nullable: true }),
    routerConfig: t.field({ type: "JSON", resolve: (row) => row.routerConfig }),
    status: t.exposeString("status"),
    enabled: t.boolean({ resolve: (row) => row.status === "active" }),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt")
  })
});

export const GatewayLogicalModelTarget = builder.objectRef<LogicalTarget>("GatewayLogicalModelTarget").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    organizationId: t.exposeID("organizationId"),
    workspaceId: t.exposeID("workspaceId"),
    logicalModelId: t.exposeID("logicalModelId"),
    deploymentId: t.exposeID("deploymentId"),
    priority: t.exposeInt("priority"),
    enabled: t.exposeBoolean("enabled"),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt")
  })
});

export const GatewayAccessProfile = builder.objectRef<AccessProfile>("GatewayAccessProfile").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    organizationId: t.exposeID("organizationId"),
    workspaceId: t.exposeID("workspaceId"),
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    limits: t.field({ type: "JSON", resolve: (row) => row.limits }),
    status: t.exposeString("status"),
    enabled: t.boolean({ resolve: (row) => row.status === "active" }),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt")
  })
});

export const GatewayModelGrant = builder.objectRef<ModelGrant>("GatewayModelGrant").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    organizationId: t.exposeID("organizationId"),
    workspaceId: t.exposeID("workspaceId"),
    accessProfileId: t.exposeID("accessProfileId"),
    logicalModelId: t.exposeID("logicalModelId"),
    allowedOperations: t.exposeStringList("allowedOperations"),
    parameterCaps: t.field({ type: "JSON", resolve: (row) => row.parameterCaps }),
    enabled: t.exposeBoolean("enabled"),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt")
  })
});

export type GatewayApiKeyAccessProfileAssignmentModel = {
  apiKeyId: string;
  accessProfileId: string;
};

export const GatewayApiKeyAccessProfileAssignment = builder
  .objectRef<GatewayApiKeyAccessProfileAssignmentModel>("GatewayApiKeyAccessProfileAssignment")
  .implement({
    fields: (t) => ({
      apiKeyId: t.exposeID("apiKeyId"),
      accessProfileId: t.exposeID("accessProfileId")
    })
  });
