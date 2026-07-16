import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";

import {
  accessProfileModelGrants,
  accessProfiles,
  apiKeys,
  canonicalModels,
  deploymentWireBindings,
  logicalModels,
  logicalModelTargets,
  modelCatalogEntries,
  modelDeployments,
  providerConnections,
  type ProxyDatabase,
  type ProxyTransaction
} from "@proxy/db";

import {
  GatewayConfigAdminError,
  type GatewayConfigScope
} from "./gatewayConfigTypes.js";
import { assertSafeNonSecretConfig, NonSecretConfigError } from "./nonSecretConfig.js";
import { workspaceScope } from "./scope.js";

export class GatewayConfigQueryStore {
  constructor(private readonly db: ProxyDatabase) {}

  providerConnections(scope: GatewayConfigScope) {
    return this.connectionRows(scope);
  }

  async providerConnection(scope: GatewayConfigScope, id: string) {
    return (await this.connectionRows(scope, id))[0] ?? null;
  }

  async providerConnectionRecord(scope: GatewayConfigScope, id: string) {
    const [row] = await this.db.select().from(providerConnections)
      .where(scopedId(providerConnections, scope, id)).limit(1);
    if (!row) throw new GatewayConfigAdminError("provider_connection_not_found", 404);
    return row;
  }

  canonicalModels(scope: GatewayConfigScope) {
    return this.canonicalModelRows(scope);
  }

  async canonicalModel(scope: GatewayConfigScope, id: string) {
    return (await this.canonicalModelRows(scope, id))[0] ?? null;
  }

  modelDeployments(scope: GatewayConfigScope) {
    return this.deploymentRows(scope);
  }

  modelCatalogEntries(scope: GatewayConfigScope) {
    return this.catalogEntryRows(scope);
  }

  async modelCatalogEntry(scope: GatewayConfigScope, id: string) {
    return (await this.catalogEntryRows(scope, id))[0] ?? null;
  }

  async modelDeployment(scope: GatewayConfigScope, id: string) {
    return (await this.deploymentRows(scope, id))[0] ?? null;
  }

  wireBindings(scope: GatewayConfigScope) {
    return this.bindingRows(scope);
  }

  async wireBinding(scope: GatewayConfigScope, id: string) {
    return (await this.bindingRows(scope, id))[0] ?? null;
  }

  logicalModels(scope: GatewayConfigScope) {
    return this.logicalModelRows(scope);
  }

  async logicalModel(scope: GatewayConfigScope, id: string) {
    return (await this.logicalModelRows(scope, id))[0] ?? null;
  }

  logicalModelTargets(scope: GatewayConfigScope) {
    return this.logicalTargetRows(scope);
  }

  async logicalModelTarget(scope: GatewayConfigScope, id: string) {
    return (await this.logicalTargetRows(scope, id))[0] ?? null;
  }

  accessProfiles(scope: GatewayConfigScope) {
    return this.accessProfileRows(scope);
  }

  async accessProfile(scope: GatewayConfigScope, id: string) {
    return (await this.accessProfileRows(scope, id))[0] ?? null;
  }

  modelGrants(scope: GatewayConfigScope) {
    return this.modelGrantRows(scope);
  }

  async modelGrant(scope: GatewayConfigScope, id: string) {
    return (await this.modelGrantRows(scope, id))[0] ?? null;
  }

  apiKeyAccessProfiles(scope: GatewayConfigScope, ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db.select({
      id: apiKeys.id,
      name: apiKeys.name,
      accessProfileId: apiKeys.accessProfileId
    }).from(apiKeys).where(and(
      workspaceScope(apiKeys, scope.organizationId, scope.workspaceId),
      inArray(apiKeys.id, ids)
    ));
  }

  private async connectionRows(scope: GatewayConfigScope, id?: string) {
    const rows = await this.db
      .select({
        id: providerConnections.id,
        organizationId: providerConnections.organizationId,
        workspaceId: providerConnections.workspaceId,
        provider: providerConnections.provider,
        slug: providerConnections.slug,
        name: providerConnections.name,
        adapterKind: providerConnections.adapterKind,
        authStyle: providerConnections.authStyle,
        baseUrl: providerConnections.baseUrl,
        region: providerConnections.region,
        secretRef: providerConnections.secretRef,
        secretHint: providerConnections.secretHint,
        secretCiphertext: providerConnections.secretCiphertext,
        adapterConfig: providerConnections.adapterConfig,
        defaultHeaders: providerConnections.defaultHeaders,
        capabilities: providerConnections.capabilities,
        platformOwned: providerConnections.platformOwned,
        status: providerConnections.status,
        createdAt: providerConnections.createdAt,
        updatedAt: providerConnections.updatedAt
      })
      .from(providerConnections)
      .where(resourceCondition(providerConnections, scope, id))
      .orderBy(asc(providerConnections.slug));
    return rows.map(({ secretCiphertext, ...row }) => ({
      ...timestamps(row),
      credentialConfigured: Boolean(row.secretRef || secretCiphertext)
    }));
  }

  private async canonicalModelRows(scope: GatewayConfigScope, id?: string) {
    const rows = await this.db.select().from(canonicalModels)
      .where(resourceCondition(canonicalModels, scope, id)).orderBy(asc(canonicalModels.slug));
    return rows.map(timestamps);
  }

  private async deploymentRows(scope: GatewayConfigScope, id?: string) {
    const rows = await this.db.select({
      ...getTableColumns(modelDeployments),
      provider: providerConnections.provider,
      catalogMetadataSource: modelCatalogEntries.metadataSource,
      catalogPricingSource: modelCatalogEntries.pricingSource
    }).from(modelDeployments)
      .innerJoin(providerConnections, and(
        eq(providerConnections.organizationId, modelDeployments.organizationId),
        eq(providerConnections.workspaceId, modelDeployments.workspaceId),
        eq(providerConnections.id, modelDeployments.providerConnectionId)
      ))
      .leftJoin(modelCatalogEntries, and(
        eq(modelCatalogEntries.organizationId, modelDeployments.organizationId),
        eq(modelCatalogEntries.workspaceId, modelDeployments.workspaceId),
        eq(modelCatalogEntries.id, modelDeployments.catalogEntryId)
      ))
      .where(resourceCondition(modelDeployments, scope, id)).orderBy(asc(modelDeployments.slug));
    return rows.map(timestamps);
  }

  private async catalogEntryRows(scope: GatewayConfigScope, id?: string) {
    const rows = await this.db.select().from(modelCatalogEntries)
      .where(resourceCondition(modelCatalogEntries, scope, id))
      .orderBy(asc(modelCatalogEntries.provider), asc(modelCatalogEntries.upstreamModelId));
    return rows.map(timestamps);
  }

  private async bindingRows(scope: GatewayConfigScope, id?: string) {
    const rows = await this.db.select().from(deploymentWireBindings)
      .where(resourceCondition(deploymentWireBindings, scope, id))
      .orderBy(asc(deploymentWireBindings.deploymentId), asc(deploymentWireBindings.apiWireId));
    return rows.map(timestamps);
  }

  private async logicalModelRows(scope: GatewayConfigScope, id?: string) {
    const rows = await this.db.select().from(logicalModels)
      .where(resourceCondition(logicalModels, scope, id)).orderBy(asc(logicalModels.slug));
    return rows.map(timestamps);
  }

  private async logicalTargetRows(scope: GatewayConfigScope, id?: string) {
    const rows = await this.db.select().from(logicalModelTargets)
      .where(resourceCondition(logicalModelTargets, scope, id))
      .orderBy(asc(logicalModelTargets.logicalModelId), asc(logicalModelTargets.priority));
    return rows.map(timestamps);
  }

  private async accessProfileRows(scope: GatewayConfigScope, id?: string) {
    const rows = await this.db.select().from(accessProfiles)
      .where(resourceCondition(accessProfiles, scope, id)).orderBy(asc(accessProfiles.slug));
    return rows.map(timestamps);
  }

  private async modelGrantRows(scope: GatewayConfigScope, id?: string) {
    const rows = await this.db.select().from(accessProfileModelGrants)
      .where(resourceCondition(accessProfileModelGrants, scope, id))
      .orderBy(asc(accessProfileModelGrants.accessProfileId), asc(accessProfileModelGrants.logicalModelId));
    return rows.map(timestamps);
  }
}

export type ScopedTable =
  | typeof providerConnections
  | typeof canonicalModels
  | typeof modelCatalogEntries
  | typeof modelDeployments
  | typeof deploymentWireBindings
  | typeof logicalModels
  | typeof logicalModelTargets
  | typeof accessProfiles
  | typeof accessProfileModelGrants
  | typeof apiKeys;

type ScopedRow =
  | typeof providerConnections.$inferSelect
  | typeof canonicalModels.$inferSelect
  | typeof modelDeployments.$inferSelect
  | typeof deploymentWireBindings.$inferSelect
  | typeof logicalModels.$inferSelect
  | typeof logicalModelTargets.$inferSelect
  | typeof accessProfiles.$inferSelect
  | typeof accessProfileModelGrants.$inferSelect
  | typeof apiKeys.$inferSelect;

export function requireScopedRow(
  tx: ProxyTransaction,
  table: typeof providerConnections,
  scope: GatewayConfigScope,
  id: string,
  message: string
): Promise<typeof providerConnections.$inferSelect>;
export function requireScopedRow(
  tx: ProxyTransaction,
  table: typeof canonicalModels,
  scope: GatewayConfigScope,
  id: string,
  message: string
): Promise<typeof canonicalModels.$inferSelect>;
export function requireScopedRow(
  tx: ProxyTransaction,
  table: typeof modelDeployments,
  scope: GatewayConfigScope,
  id: string,
  message: string
): Promise<typeof modelDeployments.$inferSelect>;
export function requireScopedRow(
  tx: ProxyTransaction,
  table: typeof deploymentWireBindings,
  scope: GatewayConfigScope,
  id: string,
  message: string
): Promise<typeof deploymentWireBindings.$inferSelect>;
export function requireScopedRow(
  tx: ProxyTransaction,
  table: typeof logicalModels,
  scope: GatewayConfigScope,
  id: string,
  message: string
): Promise<typeof logicalModels.$inferSelect>;
export function requireScopedRow(
  tx: ProxyTransaction,
  table: typeof logicalModelTargets,
  scope: GatewayConfigScope,
  id: string,
  message: string
): Promise<typeof logicalModelTargets.$inferSelect>;
export function requireScopedRow(
  tx: ProxyTransaction,
  table: typeof accessProfiles,
  scope: GatewayConfigScope,
  id: string,
  message: string
): Promise<typeof accessProfiles.$inferSelect>;
export function requireScopedRow(
  tx: ProxyTransaction,
  table: typeof accessProfileModelGrants,
  scope: GatewayConfigScope,
  id: string,
  message: string
): Promise<typeof accessProfileModelGrants.$inferSelect>;
export function requireScopedRow(
  tx: ProxyTransaction,
  table: typeof apiKeys,
  scope: GatewayConfigScope,
  id: string,
  message: string
): Promise<typeof apiKeys.$inferSelect>;
export async function requireScopedRow(
  tx: ProxyTransaction,
  table: ScopedTable,
  scope: GatewayConfigScope,
  id: string,
  message: string
): Promise<ScopedRow> {
  const [row] = await tx.select().from(table as typeof providerConnections)
    .where(scopedId(table, scope, id)).limit(1);
  if (!row) throw new GatewayConfigAdminError(message, 404);
  return row as unknown as ScopedRow;
}

export async function lockScopedRow<T extends ScopedTable>(
  tx: ProxyTransaction,
  table: T,
  scope: GatewayConfigScope,
  id: string,
  message: string
): Promise<T["$inferSelect"]> {
  await tx.execute(sql`
    select ${table.id}
    from ${table}
    where ${table.organizationId} = ${scope.organizationId}
      and ${table.workspaceId} = ${scope.workspaceId}
      and ${table.id} = ${id}
    for update
  `);
  return await requireScopedRow(
    tx,
    table as typeof providerConnections,
    scope,
    id,
    message
  ) as unknown as T["$inferSelect"];
}

export async function assertSlugAvailable(
  tx: ProxyTransaction,
  table: typeof providerConnections | typeof canonicalModels | typeof modelDeployments | typeof logicalModels | typeof accessProfiles,
  scope: GatewayConfigScope,
  slug: string,
  message: string
) {
  const [row] = await tx.select({ id: table.id }).from(table).where(and(
    workspaceScope(table, scope.organizationId, scope.workspaceId),
    eq(table.slug, slug)
  )).limit(1);
  if (row) throw new GatewayConfigAdminError(message, 409, [{ path: "slug", message: "Slug already exists." }]);
}

export function scopedId(table: ScopedTable, scope: GatewayConfigScope, id: string) {
  return and(
    workspaceScope(table, scope.organizationId, scope.workspaceId),
    eq(table.id, id)
  )!;
}

export async function setStatus(
  tx: ProxyTransaction,
  table: typeof providerConnections | typeof canonicalModels | typeof modelDeployments | typeof logicalModels | typeof accessProfiles,
  scope: GatewayConfigScope,
  id: string,
  enabled: boolean
) {
  await tx.execute(sql`update ${table} set status = ${enabled ? "active" : "disabled"}, updated_at = ${new Date()} where organization_id = ${scope.organizationId} and workspace_id = ${scope.workspaceId} and id = ${id}`);
}

export async function setBooleanEnabled(
  tx: ProxyTransaction,
  table: typeof deploymentWireBindings | typeof logicalModelTargets | typeof accessProfileModelGrants,
  scope: GatewayConfigScope,
  id: string,
  enabled: boolean
) {
  await tx.execute(sql`update ${table} set enabled = ${enabled}, updated_at = ${new Date()} where organization_id = ${scope.organizationId} and workspace_id = ${scope.workspaceId} and id = ${id}`);
}

export function assertActiveDependencies(rows: { status: string }[]) {
  if (rows.some((row) => row.status !== "active")) {
    throw new GatewayConfigAdminError("gateway_config_dependency_inactive", 400);
  }
}

export function fieldError(message: string, path: string, detail: string) {
  return new GatewayConfigAdminError(message, 400, [{ path, message: detail }]);
}

export function assertNonSecretJson(value: Record<string, unknown>, path: string) {
  try {
    assertSafeNonSecretConfig(value);
  } catch (error) {
    if (error instanceof NonSecretConfigError) {
      throw fieldError("gateway_config_secret_forbidden", path, error.message);
    }
    throw error;
  }
}

export function mapGatewayConstraintError(error: unknown) {
  const details = databaseErrorDetails(error);
  const mappings: Record<string, { message: string; path: string }> = {
    provider_connections_org_workspace_slug_idx: { message: "provider_connection_slug_exists", path: "slug" },
    canonical_models_org_workspace_slug_idx: { message: "canonical_model_slug_exists", path: "slug" },
    model_deployments_org_workspace_slug_idx: { message: "model_deployment_slug_exists", path: "slug" },
    logical_models_org_workspace_slug_idx: { message: "logical_model_slug_exists", path: "slug" },
    access_profiles_org_workspace_slug_idx: { message: "access_profile_slug_exists", path: "slug" },
    deployment_wire_bindings_org_workspace_deployment_wire_idx: {
      message: "wire_binding_exists",
      path: "apiWireId"
    },
    logical_model_targets_org_workspace_model_deployment_idx: {
      message: "logical_model_target_deployment_exists",
      path: "deploymentId"
    },
    logical_model_targets_org_workspace_model_priority_idx: {
      message: "logical_model_target_priority_exists",
      path: "priority"
    },
    access_profile_model_grants_org_workspace_profile_model_idx: {
      message: "model_grant_exists",
      path: "logicalModelId"
    }
  };
  for (const [constraint, mapping] of Object.entries(mappings)) {
    if (details.includes(constraint)) {
      return new GatewayConfigAdminError(mapping.message, 409, [{
        path: mapping.path,
        message: "A resource with this scoped identity already exists."
      }]);
    }
  }
  return error;
}

function databaseErrorDetails(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as {
    message?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    cause?: unknown;
  };
  return [candidate.message, candidate.constraint, candidate.constraint_name, databaseErrorDetails(candidate.cause)]
    .filter((value) => value !== undefined)
    .join(" ");
}

function resourceCondition(table: ScopedTable, scope: GatewayConfigScope, id?: string) {
  return id ? scopedId(table, scope, id) : workspaceScope(table, scope.organizationId, scope.workspaceId);
}

function timestamps<T extends { createdAt: Date; updatedAt: Date }>(row: T) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}
