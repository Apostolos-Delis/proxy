import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import {
  accessProfileModelGrants,
  accessProfiles,
  apiKeys,
  canonicalModels,
  deploymentHealth,
  deploymentWireBindings,
  logicalModels,
  logicalModelTargets,
  modelDeployments,
  providerConnectionHealth,
  providerConnections,
  type ProxyDbSession
} from "@proxy/db";
import {
  gatewayParameterCapsSchema,
  logicalModelClassificationRequestSchema,
  logicalModelClassifierConfigSchema,
  projectLogicalModelClassifierCapabilities,
  type Dialect,
  type GatewayModelCapabilities,
  type GatewayOperationId,
  type GatewayParameterCaps,
  type HarnessCompatibilityProfileId,
  type LogicalModelClassificationFeatures,
  type LogicalModelRouterKind,
  type ProviderAdapterContractVersion,
  type ProviderAdapterKind
} from "@proxy/schema";

import {
  ClassifierError,
  type LogicalModelClassifier,
  type LogicalModelClassifierDeployment
} from "../classifier.js";
import { effectiveGatewayParameters } from "../gatewayRequestConfig.js";
import { resolveWireCompatibility } from "../wireCompatibility.js";
import { activeClassifierDeployment } from "./classifierDeployment.js";
import { isStreamPermissionHealth } from "./providerHealth.js";
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
  isStreaming?: boolean;
  classificationFeatures?: LogicalModelClassificationFeatures;
};

export type ClassifierDecisionEvidence = {
  kind: "classifier";
  classifierDeploymentId: string;
  selectedTargetId: string;
  attempts: number;
  reasonCodes: string[];
  confidence: number;
};

export type ClassifierCallEvidence = {
  provider: string;
  model: string;
  deploymentId: string;
  attempts: number;
  outcome: "succeeded" | "failed";
  usage?: Record<string, unknown>;
  error?: string;
};

export type ResolvedModelTarget = {
  outcome: "resolved";
  accessProfileId: string;
  logicalModelId: string;
  logicalModelSlug: string;
  routerKind: LogicalModelRouterKind | null;
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
  routerDecisionId: string | null;
  routerDecision: ClassifierDecisionEvidence | null;
  classifierCall?: ClassifierCallEvidence;
  parameterCaps: GatewayParameterCaps;
};

export type GrantedLogicalModel = {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
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
  "router_config_invalid",
  "classification_context_invalid",
  "classifier_target_unavailable",
  "classifier_unavailable",
  "classifier_failed",
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
  classifierCall?: ClassifierCallEvidence;
};

export type ModelResolutionResult = ResolvedModelTarget | ModelResolutionDenial;

type EligibleTarget = Omit<
  ResolvedModelTarget,
  "outcome" | "accessProfileId" | "logicalModelId" | "logicalModelSlug" | "routerKind" | "routerDecisionId" | "routerDecision" | "parameterCaps"
> & {
  targetId: string;
  priority: number;
  capabilities: GatewayModelCapabilities;
  deploymentConfig: Record<string, unknown>;
  requestConfig: Record<string, unknown>;
  effectiveParameters: GatewayParameterCaps;
};

export type ModelResolutionOptions = {
  classifier?: LogicalModelClassifier;
  now?: () => Date;
  decisionId?: () => string;
};

export class ModelResolutionService {
  constructor(
    private readonly db: ProxyDbSession,
    private readonly options: ModelResolutionOptions = {}
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
    const now = this.options.now?.() ?? new Date();
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
        routerKind: logicalModels.routerKind,
        routerConfig: logicalModels.routerConfig,
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
    const eligibleTargets = await this.eligibleTargets(input, logicalModel.id);
    let parameterCapRejected = false;
    const targets = input.operationId === "text.generate"
      ? eligibleTargets.filter((target) => {
          const parameters = gatewayParameterCapsSchema.safeParse(target.effectiveParameters);
          if (!parameters.success) return false;
          const exceeded = exceedsParameterCap(grant.parameterCaps, parameters.data);
          if (exceeded) parameterCapRejected = true;
          return !exceeded;
        })
      : eligibleTargets;
    if (targets.length === 0 && parameterCapRejected) {
      return denial(input, "parameter_cap_exceeded");
    }
    if (targets.length === 0) return denial(input, "model_unavailable");
    if (logicalModel.resolutionKind === "direct") {
      if (targets.length !== 1) return denial(input, "direct_target_count_invalid");
      return resolvedTarget(profile.id, logicalModel, targets[0]!, grant.parameterCaps, null, null);
    }
    if (logicalModel.routerKind !== "classifier") return denial(input, "router_config_invalid");

    const config = logicalModelClassifierConfigSchema.safeParse(logicalModel.routerConfig);
    if (!config.success) return denial(input, "router_config_invalid");
    const classificationRequest = logicalModelClassificationRequestSchema.safeParse({
      context: {
        ...input.classificationFeatures,
        requestedModel: input.requestedModel,
        operationId: input.operationId
      },
      candidates: targets.map((target) => ({
        targetId: target.targetId,
        capabilities: projectLogicalModelClassifierCapabilities(target.capabilities)
      }))
    });
    if (!classificationRequest.success) return denial(input, "classification_context_invalid");
    const classifierTarget = await this.classifierTarget(
      input.organizationId,
      input.workspaceId,
      config.data.classifierDeploymentId
    );
    if (classifierTarget === "recursive") return denial(input, "router_config_invalid");
    if (!classifierTarget) return denial(input, "classifier_target_unavailable");
    if (!this.options.classifier) return denial(input, "classifier_unavailable");

    let decision;
    try {
      decision = await this.options.classifier.classifyLogicalModel({
        config: config.data,
        classifierModel: classifierTarget.model,
        request: classificationRequest.data
      }, classifierTarget);
    } catch (error) {
      return denial(input, "classifier_failed", {
        provider: classifierTarget.provider,
        model: classifierTarget.model,
        deploymentId: config.data.classifierDeploymentId,
        attempts: error instanceof ClassifierError ? error.attempts : 0,
        outcome: "failed",
        usage: error instanceof ClassifierError ? error.usage : undefined,
        error: error instanceof Error ? error.message : "Classifier failed."
      });
    }

    const selected = targets.find((target) => target.targetId === decision.targetId);
    if (!selected) return denial(input, "classifier_failed");
    const evidence: ClassifierDecisionEvidence = {
      kind: "classifier",
      classifierDeploymentId: config.data.classifierDeploymentId,
      selectedTargetId: selected.targetId,
      attempts: decision.attempts,
      reasonCodes: decision.reasonCodes,
      confidence: decision.confidence
    };
    return resolvedTarget(
      profile.id,
      logicalModel,
      selected,
      grant.parameterCaps,
      this.options.decisionId?.() ?? randomUUID(),
      evidence,
      {
        provider: classifierTarget.provider,
        model: classifierTarget.model,
        deploymentId: config.data.classifierDeploymentId,
        attempts: decision.attempts,
        outcome: "succeeded",
        usage: decision.usage
      }
    );
  }

  async listGrantedModels(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId: string;
  }): Promise<GrantedLogicalModel[]> {
    const [apiKey] = await this.db
      .select({
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
    const now = this.options.now?.() ?? new Date();
    if (
      !apiKey?.accessProfileId ||
      apiKey.revokedAt ||
      (apiKey.expiresAt && apiKey.expiresAt <= now)
    ) return [];

    const rows = await this.db
      .select({
        id: logicalModels.id,
        slug: logicalModels.slug,
        name: logicalModels.name,
        createdAt: logicalModels.createdAt,
        profileStatus: accessProfiles.status,
        enabled: accessProfileModelGrants.enabled,
        allowedOperations: accessProfileModelGrants.allowedOperations
      })
      .from(accessProfileModelGrants)
      .innerJoin(accessProfiles, and(
        eq(accessProfiles.organizationId, accessProfileModelGrants.organizationId),
        eq(accessProfiles.workspaceId, accessProfileModelGrants.workspaceId),
        eq(accessProfiles.id, accessProfileModelGrants.accessProfileId)
      ))
      .innerJoin(logicalModels, and(
        eq(logicalModels.organizationId, accessProfileModelGrants.organizationId),
        eq(logicalModels.workspaceId, accessProfileModelGrants.workspaceId),
        eq(logicalModels.id, accessProfileModelGrants.logicalModelId)
      ))
      .where(and(
        workspaceScope(accessProfileModelGrants, input.organizationId, input.workspaceId),
        workspaceScope(accessProfiles, input.organizationId, input.workspaceId),
        workspaceScope(logicalModels, input.organizationId, input.workspaceId),
        eq(accessProfiles.id, apiKey.accessProfileId),
        eq(logicalModels.status, "active")
      ))
      .orderBy(asc(logicalModels.slug));

    return rows
      .filter((row) => (
        row.profileStatus === "active" &&
        row.enabled &&
        row.allowedOperations.includes("model.list")
      ))
      .map(({ id, slug, name, createdAt }) => ({ id, slug, name, createdAt }));
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
        canonicalCapabilities: canonicalModels.capabilities,
        deploymentCapabilities: modelDeployments.capabilities,
        deploymentConfig: modelDeployments.config,
        bindingId: deploymentWireBindings.id,
        egressWireId: deploymentWireBindings.apiWireId,
        endpointPath: deploymentWireBindings.endpointPath,
        providerAdapterContractVersion: deploymentWireBindings.adapterContractVersion,
        requestConfig: deploymentWireBindings.requestConfig,
        connectionHealthStatus: providerConnectionHealth.status,
        connectionCooldownUntil: providerConnectionHealth.cooldownUntil,
        deploymentHealthStatus: deploymentHealth.status,
        deploymentLockoutUntil: deploymentHealth.lockoutUntil,
        deploymentLastErrorType: deploymentHealth.lastErrorType,
        deploymentHealthMetadata: deploymentHealth.metadata
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
      .leftJoin(providerConnectionHealth, and(
        eq(providerConnectionHealth.organizationId, providerConnections.organizationId),
        eq(providerConnectionHealth.workspaceId, providerConnections.workspaceId),
        eq(providerConnectionHealth.providerConnectionId, providerConnections.id)
      ))
      .leftJoin(deploymentHealth, and(
        eq(deploymentHealth.organizationId, modelDeployments.organizationId),
        eq(deploymentHealth.workspaceId, modelDeployments.workspaceId),
        eq(deploymentHealth.deploymentId, modelDeployments.id)
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

    const now = this.options.now?.() ?? new Date();
    const bindingsByTarget = new Map<string, typeof rows>();
    for (const row of rows) {
      if (healthUnavailable(row.connectionHealthStatus, row.connectionCooldownUntil, now)) continue;
      if (
        healthUnavailable(row.deploymentHealthStatus, row.deploymentLockoutUntil, now) &&
        (input.isStreaming || !isStreamPermissionHealth(row.deploymentLastErrorType, row.deploymentHealthMetadata))
      ) continue;
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
      const target = {
        ...binding,
        capabilities: {
          ...binding.canonicalCapabilities,
          ...binding.deploymentCapabilities
        },
        wireAdapterId: compatibility.wireAdapterId,
        wireAdapterVersion: compatibility.wireAdapterVersion,
        effectiveParameters: effectiveGatewayParameters({
          parameters: input.parameters,
          operationId: input.operationId,
          egressWireId: binding.egressWireId,
          deploymentConfig: binding.deploymentConfig,
          requestConfig: binding.requestConfig
        })
      };
      if (!capabilitiesSatisfyRequest(target.capabilities, input, target.effectiveParameters)) continue;
      targets.set(targetId, target);
    }
    return [...targets.values()].sort((left, right) => left.priority - right.priority);
  }

  private async classifierTarget(
    organizationId: string,
    workspaceId: string,
    classifierDeploymentId: string
  ): Promise<LogicalModelClassifierDeployment | "recursive" | undefined> {
    const [logicalReference] = await this.db
      .select({ id: logicalModels.id })
      .from(logicalModels)
      .where(and(
        workspaceScope(logicalModels, organizationId, workspaceId),
        eq(logicalModels.id, classifierDeploymentId)
      ))
      .limit(1);
    if (logicalReference) return "recursive";

    return activeClassifierDeployment(this.db, organizationId, workspaceId, classifierDeploymentId);
  }
}

function capabilitiesSatisfyRequest(
  capabilities: GatewayModelCapabilities,
  input: ResolveModelInput,
  parameters: GatewayParameterCaps
) {
  const modalities = capabilities.modalities;
  if (Array.isArray(modalities) && !modalities.includes("text")) return false;
  if (input.classificationFeatures?.hasTools && hasFalseCapability(capabilities, "tools", "toolCall")) {
    return false;
  }
  if (input.classificationFeatures?.hasImages) {
    if (hasFalseCapability(capabilities, "images", "image")) return false;
    if (Array.isArray(modalities) && !modalities.includes("image")) return false;
  }
  if (input.isStreaming && capabilities.streaming === false) return false;

  const outputTokens = maximumParameterValue(parameters);
  if (
    outputTokens !== undefined &&
    typeof capabilities.maxOutputTokens === "number" &&
    outputTokens > capabilities.maxOutputTokens
  ) return false;

  const inputTokens = input.classificationFeatures?.estimatedInputTokens ?? 0;
  if (
    typeof capabilities.contextWindow === "number" &&
    inputTokens + (outputTokens ?? 0) > capabilities.contextWindow
  ) return false;

  return true;
}

function hasFalseCapability(capabilities: GatewayModelCapabilities, ...keys: string[]) {
  return keys.some((key) => capabilities[key] === false);
}

function maximumParameterValue(parameters: GatewayParameterCaps) {
  const values = Object.values(parameters).filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.max(...values) : undefined;
}

function healthUnavailable(status: string | null, until: Date | null, now: Date) {
  if (status === "terminal" || status === "locked_out") return !until || until > now;
  return status === "cooldown" && (!until || until > now);
}

function resolvedTarget(
  accessProfileId: string,
  logicalModel: { id: string; slug: string; routerKind: LogicalModelRouterKind | null },
  target: EligibleTarget,
  parameterCaps: GatewayParameterCaps,
  routerDecisionId: string | null,
  routerDecision: ClassifierDecisionEvidence | null,
  classifierCall?: ClassifierCallEvidence
): ResolvedModelTarget {
  return {
    outcome: "resolved",
    accessProfileId,
    logicalModelId: logicalModel.id,
    logicalModelSlug: logicalModel.slug,
    routerKind: logicalModel.routerKind,
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
    routerDecisionId,
    routerDecision,
    classifierCall,
    parameterCaps
  };
}

export function exceedsParameterCap(caps: GatewayParameterCaps, parameters: GatewayParameterCaps | undefined) {
  const configuredCaps = Object.values(caps).filter((value): value is number => value !== undefined);
  const requestedValues = Object.values(parameters ?? {}).filter((value): value is number => value !== undefined);
  if (configuredCaps.length === 0) return false;
  if (requestedValues.length === 0) return true;
  return Math.max(...requestedValues) > Math.min(...configuredCaps);
}

function denial(
  input: ResolveModelInput,
  code: ModelResolutionDenialCode,
  classifierCall?: ClassifierCallEvidence
): ModelResolutionDenial {
  return {
    outcome: "denied",
    code,
    requestedModel: input.requestedModel,
    operationId: input.operationId,
    classifierCall
  };
}
