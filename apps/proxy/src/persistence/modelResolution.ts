import { and, asc, eq } from "drizzle-orm";

import {
  accessProfileModelGrants,
  accessProfiles,
  apiKeys,
  canonicalModels,
  deploymentWireBindings,
  logicalModels,
  logicalModelTargets,
  modelDeployments,
  providerConnections,
  type ProxyDbSession
} from "@proxy/db";
import {
  gatewayParameterCapsSchema,
  type Dialect,
  type GatewayOperationId,
  type GatewayParameterCaps,
  type HarnessCompatibilityProfileId,
  type ProviderAdapterContractVersion,
  type ProviderAdapterKind
} from "@proxy/schema";

import { resolveWireCompatibility } from "../wireCompatibility.js";
import { workspaceScope } from "./scope.js";

export type ResolveModelInput = {
  organizationId: string;
  workspaceId: string;
  apiKeyId: string;
  ingressWireId: Dialect;
  operationId: GatewayOperationId;
  requestedModel: string;
  parameters?: GatewayParameterCaps;
  harnessProfileId?: HarnessCompatibilityProfileId;
  transport?: "http" | "websocket";
  statefulResponses?: boolean;
  hasPreviousResponseId?: boolean;
  unsupportedFields?: readonly string[];
  bedrockSettingsOnNonBedrockTarget?: boolean;
};

export type ResolvedModelTarget = {
  outcome: "resolved";
  accessProfileId: string;
  logicalModelId: string;
  logicalModelSlug: string;
  deploymentId: string;
  upstreamModelId: string;
  providerConnectionId: string;
  bindingId: string;
  egressWireId: Dialect;
  endpointPath: string | null;
  providerAdapterKind: ProviderAdapterKind;
  providerAdapterContractVersion: ProviderAdapterContractVersion;
  wireAdapterId: string | null;
  wireAdapterVersion: string | null;
  routerDecisionId: null;
};

export const MODEL_RESOLUTION_DENIAL_CODES = [
  "api_key_not_found",
  "api_key_inactive",
  "access_profile_missing",
  "access_profile_inactive",
  "model_access_denied",
  "operation_not_allowed",
  "invalid_parameters",
  "parameter_cap_exceeded",
  "model_inactive",
  "router_resolution_required",
  "local_operation_not_resolvable",
  "model_unavailable",
  "direct_target_count_invalid"
] as const;

export type ModelResolutionDenialCode = typeof MODEL_RESOLUTION_DENIAL_CODES[number];

export type ModelResolutionDenial = {
  outcome: "denied";
  code: ModelResolutionDenialCode;
  requestedModel: string;
  operationId: GatewayOperationId;
};

export type ModelResolutionResult = ResolvedModelTarget | ModelResolutionDenial;

type EligibleTarget = Omit<ResolvedModelTarget, "outcome" | "accessProfileId" | "logicalModelId" | "logicalModelSlug" | "routerDecisionId"> & {
  targetId: string;
  priority: number;
};

export class ModelResolutionService {
  constructor(
    private readonly db: ProxyDbSession,
    private readonly now = () => new Date()
  ) {}

  async resolve(input: ResolveModelInput): Promise<ModelResolutionResult> {
    const [apiKey] = await this.db
      .select({
        id: apiKeys.id,
        accessProfileId: apiKeys.accessProfileId,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt
      })
      .from(apiKeys)
      .where(and(
        workspaceScope(apiKeys, input.organizationId, input.workspaceId),
        eq(apiKeys.id, input.apiKeyId)
      ))
      .limit(1);

    if (!apiKey) return denial(input, "api_key_not_found");
    const now = this.now();
    if (apiKey.revokedAt || (apiKey.expiresAt && apiKey.expiresAt <= now)) {
      return denial(input, "api_key_inactive");
    }
    if (!apiKey.accessProfileId) return denial(input, "access_profile_missing");

    const [profile] = await this.db
      .select({ id: accessProfiles.id, status: accessProfiles.status })
      .from(accessProfiles)
      .where(and(
        workspaceScope(accessProfiles, input.organizationId, input.workspaceId),
        eq(accessProfiles.id, apiKey.accessProfileId)
      ))
      .limit(1);
    if (!profile || profile.status !== "active") return denial(input, "access_profile_inactive");

    const [logicalModel] = await this.db
      .select({
        id: logicalModels.id,
        slug: logicalModels.slug,
        resolutionKind: logicalModels.resolutionKind,
        status: logicalModels.status
      })
      .from(logicalModels)
      .where(and(
        workspaceScope(logicalModels, input.organizationId, input.workspaceId),
        eq(logicalModels.slug, input.requestedModel)
      ))
      .limit(1);
    if (!logicalModel) return denial(input, "model_access_denied");

    const [grant] = await this.db
      .select({
        allowedOperations: accessProfileModelGrants.allowedOperations,
        parameterCaps: accessProfileModelGrants.parameterCaps,
        enabled: accessProfileModelGrants.enabled
      })
      .from(accessProfileModelGrants)
      .where(and(
        workspaceScope(accessProfileModelGrants, input.organizationId, input.workspaceId),
        eq(accessProfileModelGrants.accessProfileId, profile.id),
        eq(accessProfileModelGrants.logicalModelId, logicalModel.id)
      ))
      .limit(1);
    if (!grant || !grant.enabled) return denial(input, "model_access_denied");
    if (!grant.allowedOperations.includes(input.operationId)) {
      return denial(input, "operation_not_allowed");
    }
    if (logicalModel.status !== "active") return denial(input, "model_inactive");
    if (input.operationId === "model.list") return denial(input, "local_operation_not_resolvable");
    if (input.operationId === "text.generate") {
      const parameters = gatewayParameterCapsSchema.safeParse(input.parameters ?? {});
      if (!parameters.success) return denial(input, "invalid_parameters");
      if (exceedsParameterCap(grant.parameterCaps, parameters.data)) {
        return denial(input, "parameter_cap_exceeded");
      }
    }
    if (logicalModel.resolutionKind !== "direct") return denial(input, "router_resolution_required");

    const targets = await this.eligibleTargets(input, logicalModel.id);
    if (targets.length === 0) return denial(input, "model_unavailable");
    if (targets.length !== 1) return denial(input, "direct_target_count_invalid");
    const [target] = targets;
    if (!target) return denial(input, "model_unavailable");

    return {
      outcome: "resolved",
      accessProfileId: profile.id,
      logicalModelId: logicalModel.id,
      logicalModelSlug: logicalModel.slug,
      deploymentId: target.deploymentId,
      upstreamModelId: target.upstreamModelId,
      providerConnectionId: target.providerConnectionId,
      bindingId: target.bindingId,
      egressWireId: target.egressWireId,
      endpointPath: target.endpointPath,
      providerAdapterKind: target.providerAdapterKind,
      providerAdapterContractVersion: target.providerAdapterContractVersion,
      wireAdapterId: target.wireAdapterId,
      wireAdapterVersion: target.wireAdapterVersion,
      routerDecisionId: null
    };
  }

  private async eligibleTargets(input: ResolveModelInput, logicalModelId: string) {
    const rows = await this.db
      .select({
        targetId: logicalModelTargets.id,
        priority: logicalModelTargets.priority,
        deploymentId: modelDeployments.id,
        upstreamModelId: modelDeployments.upstreamModelId,
        providerConnectionId: providerConnections.id,
        providerAdapterKind: providerConnections.adapterKind,
        bindingId: deploymentWireBindings.id,
        egressWireId: deploymentWireBindings.apiWireId,
        endpointPath: deploymentWireBindings.endpointPath,
        providerAdapterContractVersion: deploymentWireBindings.adapterContractVersion
      })
      .from(logicalModelTargets)
      .innerJoin(modelDeployments, and(
        eq(modelDeployments.organizationId, logicalModelTargets.organizationId),
        eq(modelDeployments.workspaceId, logicalModelTargets.workspaceId),
        eq(modelDeployments.id, logicalModelTargets.deploymentId)
      ))
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
        eq(deploymentWireBindings.providerConnectionId, providerConnections.id)
      ))
      .where(and(
        workspaceScope(logicalModelTargets, input.organizationId, input.workspaceId),
        workspaceScope(modelDeployments, input.organizationId, input.workspaceId),
        workspaceScope(canonicalModels, input.organizationId, input.workspaceId),
        workspaceScope(providerConnections, input.organizationId, input.workspaceId),
        workspaceScope(deploymentWireBindings, input.organizationId, input.workspaceId),
        eq(logicalModelTargets.logicalModelId, logicalModelId),
        eq(logicalModelTargets.enabled, true),
        eq(modelDeployments.status, "active"),
        eq(canonicalModels.status, "active"),
        eq(providerConnections.status, "active"),
        eq(deploymentWireBindings.enabled, true)
      ))
      .orderBy(
        asc(logicalModelTargets.priority),
        asc(deploymentWireBindings.apiWireId)
      );

    const bindingsByTarget = new Map<string, typeof rows>();
    for (const row of rows) {
      const bindings = bindingsByTarget.get(row.targetId) ?? [];
      bindings.push(row);
      bindingsByTarget.set(row.targetId, bindings);
    }

    const targets = new Map<string, EligibleTarget>();
    for (const [targetId, bindings] of bindingsByTarget) {
      const compatibility = resolveWireCompatibility({
        ingressWireId: input.ingressWireId,
        operationId: input.operationId,
        targetWireIds: bindings.map((binding) => binding.egressWireId),
        harnessProfileId: input.harnessProfileId,
        transport: input.transport,
        statefulResponses: input.statefulResponses,
        hasPreviousResponseId: input.hasPreviousResponseId,
        unsupportedFields: input.unsupportedFields,
        bedrockSettingsOnNonBedrockTarget: input.bedrockSettingsOnNonBedrockTarget
      });
      if (compatibility.outcome === "unsupported") continue;
      const binding = bindings.find((row) => row.egressWireId === compatibility.egressWireId);
      if (!binding) continue;
      targets.set(targetId, {
        ...binding,
        wireAdapterId: compatibility.wireAdapterId,
        wireAdapterVersion: compatibility.wireAdapterVersion
      });
    }
    return [...targets.values()].sort((left, right) => left.priority - right.priority);
  }
}

function exceedsParameterCap(caps: GatewayParameterCaps, parameters: GatewayParameterCaps | undefined) {
  const configuredCaps = Object.values(caps).filter((value): value is number => value !== undefined);
  const requestedValues = Object.values(parameters ?? {}).filter((value): value is number => value !== undefined);
  if (configuredCaps.length === 0) return false;
  if (requestedValues.length === 0) return true;
  return Math.max(...requestedValues) > Math.min(...configuredCaps);
}

function denial(input: ResolveModelInput, code: ModelResolutionDenialCode): ModelResolutionDenial {
  return {
    outcome: "denied",
    code,
    requestedModel: input.requestedModel,
    operationId: input.operationId
  };
}
