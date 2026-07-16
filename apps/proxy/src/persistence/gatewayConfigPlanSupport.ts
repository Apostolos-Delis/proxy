import { isDeepStrictEqual } from "node:util";

import type { GatewayConfigAdminService } from "./gatewayConfigAdmin.js";
import {
  GatewayConfigAdminError,
  type GatewayConfigCommand,
  type GatewayConfigResource,
  type GatewayConfigScope
} from "./gatewayConfigTypes.js";

export type ProviderConnectionRow = Awaited<ReturnType<GatewayConfigAdminService["providerConnections"]>>[number];
export type CanonicalModelRow = Awaited<ReturnType<GatewayConfigAdminService["canonicalModels"]>>[number];
export type ModelDeploymentRow = Awaited<ReturnType<GatewayConfigAdminService["modelDeployments"]>>[number];
export type WireBindingRow = Awaited<ReturnType<GatewayConfigAdminService["wireBindings"]>>[number];
export type LogicalModelRow = Awaited<ReturnType<GatewayConfigAdminService["logicalModels"]>>[number];
export type LogicalModelTargetRow = Awaited<ReturnType<GatewayConfigAdminService["logicalModelTargets"]>>[number];
export type AccessProfileRow = Awaited<ReturnType<GatewayConfigAdminService["accessProfiles"]>>[number];
export type ModelGrantRow = Awaited<ReturnType<GatewayConfigAdminService["modelGrants"]>>[number];

export type GatewayConfigCurrentState = {
  connections: ProviderConnectionRow[];
  canonicalModels: CanonicalModelRow[];
  deployments: ModelDeploymentRow[];
  bindings: WireBindingRow[];
  logicalModels: LogicalModelRow[];
  targets: LogicalModelTargetRow[];
  accessProfiles: AccessProfileRow[];
  grants: ModelGrantRow[];
};

export type ProjectedProviderConnection = Pick<
  ProviderConnectionRow,
  "id" | "slug" | "adapterKind" | "authStyle" | "baseUrl" | "status" | "credentialConfigured" | "platformOwned"
>;
export type ProjectedCanonicalModel = Pick<CanonicalModelRow, "id" | "slug" | "capabilities" | "status">;
export type ProjectedModelDeployment = Pick<
  ModelDeploymentRow,
  "id" | "slug" | "canonicalModelId" | "providerConnectionId" | "capabilities" | "status"
>;
export type ProjectedWireBinding = Pick<
  WireBindingRow,
  "id" | "deploymentId" | "providerConnectionId" | "apiWireId" | "endpointPath" | "enabled"
>;
export type ProjectedLogicalModel = Pick<
  LogicalModelRow,
  "id" | "slug" | "resolutionKind" | "routerConfig" | "status"
>;
export type ProjectedLogicalModelTarget = Pick<
  LogicalModelTargetRow,
  "id" | "logicalModelId" | "deploymentId" | "priority" | "enabled"
>;
export type ProjectedAccessProfile = Pick<AccessProfileRow, "id" | "slug" | "status">;
export type ProjectedModelGrant = Pick<
  ModelGrantRow,
  "id" | "accessProfileId" | "logicalModelId" | "enabled"
>;

export type ProjectedGatewayConfig = {
  connectionsById: Map<string, ProjectedProviderConnection>;
  connectionsBySlug: Map<string, ProjectedProviderConnection>;
  canonicalModelsById: Map<string, ProjectedCanonicalModel>;
  canonicalModelsBySlug: Map<string, ProjectedCanonicalModel>;
  deploymentsById: Map<string, ProjectedModelDeployment>;
  deploymentsBySlug: Map<string, ProjectedModelDeployment>;
  bindingsByIdentity: Map<string, ProjectedWireBinding>;
  logicalModelsById: Map<string, ProjectedLogicalModel>;
  logicalModelsBySlug: Map<string, ProjectedLogicalModel>;
  targetsByIdentity: Map<string, ProjectedLogicalModelTarget>;
  accessProfilesById: Map<string, ProjectedAccessProfile>;
  accessProfilesBySlug: Map<string, ProjectedAccessProfile>;
  grantsByIdentity: Map<string, ProjectedModelGrant>;
};

export type GatewayConfigPlanChange = {
  action: "create" | "update" | "enable" | "disable" | "assign";
  resource: GatewayConfigResource | "apiKey";
  reference: string;
  fields?: string[];
};

export type GatewayConfigPlan = {
  scope: GatewayConfigScope;
  changes: GatewayConfigPlanChange[];
  commands: GatewayConfigCommand[];
};

type PlannedCommand = {
  command: GatewayConfigCommand;
  phase: number;
  rank: number;
  sequence: number;
};

export class GatewayConfigPlanBuilder {
  private readonly planned: PlannedCommand[] = [];
  private readonly publicChanges: GatewayConfigPlanChange[] = [];
  private sequence = 0;

  constructor(readonly scope: GatewayConfigScope) {}

  create(
    resource: GatewayConfigResource,
    id: string,
    reference: string,
    body: unknown
  ) {
    this.enqueue({ resource, action: "create", id, body }, 2, writeRank(resource));
    this.publicChanges.push({ action: "create", resource, reference });
  }

  update(resource: GatewayConfigResource, id: string, reference: string, body: unknown, fields: string[]) {
    this.enqueue({ resource, action: "update", id, body }, 2, writeRank(resource));
    this.publicChanges.push({ action: "update", resource, reference, fields: [...fields].sort() });
  }

  stageUpdate(resource: GatewayConfigResource, id: string, body: unknown) {
    this.enqueue({ resource, action: "update", id, body }, 2, writeRank(resource) - 1);
  }

  setEnabled(
    resource: GatewayConfigResource,
    id: string,
    reference: string,
    enabled: boolean,
    visible = true
  ) {
    this.enqueue(
      { resource, action: "setEnabled", id, enabled },
      enabled ? 3 : 1,
      enabled ? enableRank(resource) : disableRank(resource)
    );
    if (visible) {
      this.publicChanges.push({ action: enabled ? "enable" : "disable", resource, reference });
    }
  }

  assignApiKey(id: string, accessProfileId: string) {
    this.enqueue({ resource: "apiKey", action: "assignAccessProfile", id, accessProfileId }, 4, 1);
    this.publicChanges.push({ action: "assign", resource: "apiKey", reference: id, fields: ["accessProfile"] });
  }

  build(): GatewayConfigPlan {
    const ordered = [...this.planned].sort((left, right) => (
      left.phase - right.phase || left.rank - right.rank || left.sequence - right.sequence
    ));
    return {
      scope: this.scope,
      changes: this.publicChanges,
      commands: ordered.map((entry) => entry.command)
    };
  }

  private enqueue(command: GatewayConfigCommand, phase: number, rank: number) {
    this.planned.push({ command, phase, rank, sequence: this.sequence });
    this.sequence += 1;
  }
}

export function changedFields(
  current: Record<string, unknown>,
  desired: Record<string, unknown>
) {
  return Object.keys(desired).filter((field) => !isDeepStrictEqual(current[field], desired[field]));
}

export function compositeKey(...parts: string[]) {
  return parts.join("\0");
}

export function active(status: string) {
  return status === "active";
}

export function projectedStatus(enabled: boolean): "active" | "disabled" {
  return enabled ? "active" : "disabled";
}

export function requireReference<T>(resources: Map<string, T>, reference: string, path: string) {
  const value = resources.get(reference);
  if (value) return value;
  throw new GatewayConfigAdminError("gateway_config_reference_not_found", 400, [{
    path,
    message: `Unknown resource slug: ${reference}`
  }]);
}

export function assertImmutable(current: unknown, desired: unknown, path: string) {
  if (isDeepStrictEqual(current, desired)) return;
  throw new GatewayConfigAdminError("gateway_config_immutable_field_changed", 400, [{
    path,
    message: "This field cannot be changed declaratively after creation."
  }]);
}

export function projectGatewayConfig(current: GatewayConfigCurrentState): ProjectedGatewayConfig {
  const connections = current.connections.map(({
    id, slug, adapterKind, authStyle, baseUrl, status, credentialConfigured, platformOwned
  }) => ({
    id, slug, adapterKind, authStyle, baseUrl, status, credentialConfigured, platformOwned
  }));
  const canonicalModels = current.canonicalModels.map(({ id, slug, capabilities, status }) => ({
    id, slug, capabilities, status
  }));
  const deployments = current.deployments.map(({
    id, slug, canonicalModelId, providerConnectionId, capabilities, status
  }) => ({ id, slug, canonicalModelId, providerConnectionId, capabilities, status }));
  const bindings = current.bindings.map(({
    id, deploymentId, providerConnectionId, apiWireId, endpointPath, enabled
  }) => ({ id, deploymentId, providerConnectionId, apiWireId, endpointPath, enabled }));
  const logicalModels = current.logicalModels.map(({
    id, slug, resolutionKind, routerConfig, status
  }) => ({ id, slug, resolutionKind, routerConfig, status }));
  const targets = current.targets.map(({
    id, logicalModelId, deploymentId, priority, enabled
  }) => ({ id, logicalModelId, deploymentId, priority, enabled }));
  const accessProfiles = current.accessProfiles.map(({ id, slug, status }) => ({ id, slug, status }));
  const grants = current.grants.map(({ id, accessProfileId, logicalModelId, enabled }) => ({
    id, accessProfileId, logicalModelId, enabled
  }));
  return {
    connectionsById: byId(connections),
    connectionsBySlug: bySlug(connections),
    canonicalModelsById: byId(canonicalModels),
    canonicalModelsBySlug: bySlug(canonicalModels),
    deploymentsById: byId(deployments),
    deploymentsBySlug: bySlug(deployments),
    bindingsByIdentity: new Map(bindings.map((binding) => [
      compositeKey(binding.deploymentId, binding.apiWireId),
      binding
    ])),
    logicalModelsById: byId(logicalModels),
    logicalModelsBySlug: bySlug(logicalModels),
    targetsByIdentity: new Map(targets.map((target) => [
      compositeKey(target.logicalModelId, target.deploymentId),
      target
    ])),
    accessProfilesById: byId(accessProfiles),
    accessProfilesBySlug: bySlug(accessProfiles),
    grantsByIdentity: new Map(grants.map((grant) => [
      compositeKey(grant.accessProfileId, grant.logicalModelId),
      grant
    ]))
  };
}

function byId<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function bySlug<T extends { slug: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.slug, row]));
}

function disableRank(resource: GatewayConfigResource) {
  const ranks: Record<GatewayConfigResource, number> = {
    modelGrant: 10,
    logicalModel: 20,
    logicalModelTarget: 30,
    wireBinding: 40,
    modelDeployment: 50,
    accessProfile: 60,
    canonicalModel: 70,
    providerConnection: 80
  };
  return ranks[resource];
}

function enableRank(resource: GatewayConfigResource) {
  const ranks: Record<GatewayConfigResource, number> = {
    providerConnection: 10,
    canonicalModel: 10,
    accessProfile: 10,
    modelDeployment: 20,
    wireBinding: 30,
    logicalModelTarget: 30,
    logicalModel: 40,
    modelGrant: 50
  };
  return ranks[resource];
}

function writeRank(resource: GatewayConfigResource) {
  const ranks: Record<GatewayConfigResource, number> = {
    providerConnection: 10,
    canonicalModel: 20,
    modelDeployment: 30,
    wireBinding: 40,
    logicalModel: 50,
    accessProfile: 50,
    logicalModelTarget: 60,
    modelGrant: 70
  };
  return ranks[resource];
}
