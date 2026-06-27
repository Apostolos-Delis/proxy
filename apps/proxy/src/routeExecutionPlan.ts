import { defaultWorkspaceId } from "@proxy/db";
import {
  routeSkipReasonForCompatibilityReason,
  type RouteCandidateEvaluation,
  type RouteExecutionPlan,
  type RoutePolicyResult,
  type RoutingConfig,
  type RoutingConfigAnthropicDeployment,
  type RoutingConfigOpenAIDeployment
} from "@proxy/schema";

import type { ClassifierSettings } from "./classifier.js";
import type {
  Dialect,
  ProviderAdapterKind,
  ProviderEffort,
  ProviderHealthSkip,
  RouteContext,
  RouteDecision,
  RouteName,
  SelectedRouteSettings
} from "./types.js";
import { deploymentKey } from "./deploymentKey.js";

type PlanTarget = {
  providerId: string;
  model: string;
  dialect?: Dialect;
  providerAccountId?: string;
  bedrockOnlySettings?: boolean;
};

export type ConfiguredRouteDeployment = {
  deployment: RoutingConfigAnthropicDeployment | RoutingConfigOpenAIDeployment;
  sourceIndex: number;
};

type ConfiguredRouteCandidates = {
  candidates: RouteCandidateEvaluation[];
  selectedCandidateId?: string;
};

export type TargetAvailability =
  | { status: "available"; dialect: Dialect; adapterKind?: ProviderAdapterKind; supportedEfforts?: ProviderEffort[]; providerAccountId?: string; contextWindowOk?: boolean | null }
  | { status: "unavailable"; reason: string; dialect?: Dialect; adapterKind?: ProviderAdapterKind; healthSkip?: ProviderHealthSkip; contextWindowOk?: boolean | null };

export type TargetAvailabilityResolver = (
  target: PlanTarget,
  mode?: "native" | "translated"
) => Promise<TargetAvailability>;

export async function buildRouteExecutionPlan(input: {
  requestId: string;
  defaultOrganizationId: string;
  context: RouteContext;
  decision: RouteDecision;
  classifierSettings: ClassifierSettings;
  routingConfig?: RoutingConfig;
  targetAvailability: TargetAvailabilityResolver;
}): Promise<RouteExecutionPlan | undefined> {
  const { requestId, defaultOrganizationId, context, decision, classifierSettings, routingConfig, targetAvailability } = input;
  if (!decision.routingConfig || !decision.providerSettings || !decision.finalRoute) return undefined;
  const finalRoute = decision.finalRoute;
  const organizationId = context.organizationId ?? defaultOrganizationId;
  const workspaceId = context.workspaceId ?? defaultWorkspaceId(organizationId);
  const route = decision.classifier?.recommendedRoute ?? decision.classifierRoute ?? finalRoute;
  const configuredCandidates = routingConfig
    ? await buildConfiguredRouteCandidates(context, decision, routingConfig, targetAvailability)
    : { candidates: [] };
  const candidates = configuredCandidates.candidates;
  const selectedProviderAccountId = decision.providerSettings.deployment.providerAccountId;
  const selectedCandidate = configuredCandidates.selectedCandidateId
    ? candidates.find((candidate) => candidate.id === configuredCandidates.selectedCandidateId)
    : candidates.find((candidate) =>
        candidate.providerId === decision.providerSettings?.provider &&
        candidate.model === decision.providerSettings?.model &&
        candidate.endpointDialect === decision.providerSettings?.dialect &&
        providerAccountMatches(candidate.providerAccountIds, selectedProviderAccountId)
      );
  const finalCandidates = selectedCandidate
    ? candidates
    : [
        ...candidates,
        selectedCandidateEvaluation(
          `candidate_${candidates.length}`,
          candidates.length,
          context,
          decision.providerSettings,
          budgetAllowedFromChecks(decision.budgetChecks)
        )
      ];
  const selectedCandidateId = selectedCandidate?.id ?? `candidate_${candidates.length}`;
  const finalSelectedCandidate = finalCandidates.find((candidate) => candidate.id === selectedCandidateId);
  const endpointDialect = decision.providerSettings.dialect;
  const translated = context.surface !== endpointDialect;

  return {
    schemaVersion: 1,
    requestId,
    organizationId,
    workspaceId,
    apiKeyId: context.apiKeyId ?? "unknown",
    surface: context.surface,
    dialect: context.surface,
    classifier: {
      provider: decision.classifier?.provider ?? classifierSettings.providerId,
      model: decision.classifier?.model ?? classifierSettings.model,
      route,
      confidence: decision.classifier?.confidence ?? null,
      attempts: decision.classifier?.attempts ?? 0,
      dataMode: classifierSettings.allowRedactedExcerpt ? "redacted_excerpt" : "metadata"
    },
    routingConfig: {
      id: decision.routingConfig.configId,
      versionId: decision.routingConfig.versionId,
      version: decision.routingConfig.version,
      hash: decision.routingConfig.configHash
    },
    candidates: finalCandidates,
    selected: {
      candidateId: selectedCandidateId,
      providerId: decision.providerSettings.provider,
      providerAccountId: finalSelectedCandidate?.providerAccountIds[0] ?? null,
      model: decision.providerSettings.model,
      dialect: endpointDialect,
      translated
    },
    policyResults: budgetPolicyResults(decision.budgetChecks)
  };
}

async function buildConfiguredRouteCandidates(
  context: RouteContext,
  decision: RouteDecision,
  routingConfig: RoutingConfig,
  targetAvailability: TargetAvailabilityResolver
): Promise<ConfiguredRouteCandidates> {
  const candidates: RouteCandidateEvaluation[] = [];
  const providerSettings = decision.providerSettings;
  if (!providerSettings) return { candidates };
  const budgetAllowed = budgetAllowedFromChecks(decision.budgetChecks);
  const deployments = configuredRouteDeployments(routingConfig, decision.finalRoute);
  let selectedCandidateId: string | undefined;
  for (const [index, { deployment, sourceIndex }] of deployments.entries()) {
    const target = {
      providerId: deployment.provider,
      model: deployment.model,
      providerAccountId: deployment.providerAccountId,
      bedrockOnlySettings: hasBedrockOnlySettings(deployment)
    };
    const nativeAvailability = await targetAvailability(target, "native");
    let availability = nativeAvailability;
    let translated = false;
    if (nativeAvailability.status === "unavailable" && nativeAvailability.reason === "dialect_unavailable") {
      availability = await targetAvailability(target, "translated");
      translated = true;
    }
    const endpointDialect = availability.status === "available"
      ? availability.dialect
      : availability.dialect ?? context.surface;
    const skipReason = availability.status === "unavailable"
      ? routeSkipReasonForCompatibilityReason(availability.reason)
      : undefined;
    const providerAccountId = deployment.providerAccountId
      ?? (availability.status === "available" ? availability.providerAccountId : undefined);
    const providerAccountIds = providerAccountId ? [providerAccountId] : [];
    const selectedProviderAccountId = providerSettings.deployment.providerAccountId;
    const candidateId = `candidate_${index}`;
    const selectedBase = providerSettings.provider === target.providerId &&
      providerSettings.model === target.model &&
      providerSettings.dialect === endpointDialect;
    const selectedByDeploymentKey = selectedBase &&
      providerSettings.deployment.key === deploymentKey({
        routingConfigVersionId: decision.routingConfig?.versionId ?? "inline",
        route: decision.finalRoute,
        surface: context.surface,
        deployment,
        index: sourceIndex
      });
    const selectedByFallback = selectedBase &&
      providerAccountMatches(providerAccountIds, selectedProviderAccountId);
    const selected = selectedByDeploymentKey || selectedByFallback;
    if (selectedByDeploymentKey || (selectedByFallback && !selectedCandidateId)) selectedCandidateId = candidateId;
    const eligible = availability.status === "available";
    candidates.push({
      id: candidateId,
      order: deployment.order,
      providerId: target.providerId,
      providerAccountIds,
      model: target.model,
      endpointDialect,
      translated,
      translatorId: translated && endpointDialect !== context.surface
        ? `${context.surface}_to_${endpointDialect}`
        : null,
      compatible: eligible || selected,
      eligible,
      skipReasons: skipReason ? [skipReason] : [],
      factors: {
        nativeDialect: context.surface === endpointDialect,
        capabilityMatch: capabilityMatchFactor(availability, eligible || selected),
        contextWindowOk: availability.contextWindowOk ?? null,
        providerHealthy: providerHealthyFactor(availability),
        accountAvailable: accountAvailableFactor(availability, eligible),
        budgetAllowed,
        rateLimitAllowed: null,
        sessionAffinityMatch: null
      }
    });
  }
  return { candidates, selectedCandidateId };
}

function providerAccountMatches(candidateProviderAccountIds: string[], selectedProviderAccountId: string | undefined) {
  if (selectedProviderAccountId) return candidateProviderAccountIds.includes(selectedProviderAccountId);
  return candidateProviderAccountIds.length === 0;
}

export function configuredRouteDeployments(routingConfig: RoutingConfig, route: RouteName | undefined): ConfiguredRouteDeployment[] {
  if (!route) return [];
  const routeConfig = routingConfig.routes[route];
  const anthropicDeployments = routeConfig.anthropic?.deployments ?? [];
  return [
    ...anthropicDeployments.map((deployment, index) => ({
      deployment,
      familyOrder: 0,
      index,
      sourceIndex: index
    })),
    ...(routeConfig.openai?.deployments.map((deployment, index) => ({
      deployment,
      familyOrder: 1,
      index,
      sourceIndex: anthropicDeployments.length + index
    })) ?? [])
  ]
    .sort((left, right) =>
      left.deployment.order - right.deployment.order ||
      left.familyOrder - right.familyOrder ||
      left.index - right.index
    )
    .map(({ deployment, sourceIndex }) => ({ deployment, sourceIndex }));
}

function capabilityMatchFactor(availability: TargetAvailability, fallback: boolean) {
  if (
    availability.status === "unavailable" &&
    (
      availability.reason === "model_capability" ||
      availability.reason === "tool_capability_unavailable" ||
      availability.reason === "image_capability_unavailable" ||
      availability.reason === "streaming_capability_unavailable"
    )
  ) {
    return false;
  }
  return fallback;
}

function hasBedrockOnlySettings(deployment: RoutingConfigOpenAIDeployment | RoutingConfigAnthropicDeployment) {
  const metadata = deployment.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return metadata.bedrock !== undefined ||
    metadata.bedrockConverse !== undefined ||
    metadata.bedrockSettings !== undefined;
}

function budgetAllowedFromChecks(budgetChecks: RouteDecision["budgetChecks"]) {
  if (!budgetChecks?.length) return null;
  return !budgetChecks.some((check) => check.status === "reject");
}

function budgetPolicyResults(budgetChecks: RouteDecision["budgetChecks"]): RoutePolicyResult[] {
  return (budgetChecks ?? []).map((check, index) => ({
    id: `budget_${index}`,
    policy: `budget_${check.scope}_${check.reason}`,
    status: check.status === "reject" ? "blocked" : "allowed",
    skipReason: check.status === "reject" ? "target_skipped_budget_limit" : null,
    current: check.current,
    limit: check.limit
  }));
}

function providerHealthyFactor(availability: TargetAvailability) {
  if (availability.status === "available") return null;
  if (availability.reason === "provider_disabled") return false;
  return null;
}

function accountAvailableFactor(availability: TargetAvailability, eligible: boolean) {
  if (eligible) return true;
  if (availability.status === "unavailable" && availability.reason === "provider_credential_unresolved") {
    return false;
  }
  return null;
}

function selectedCandidateEvaluation(
  id: string,
  order: number,
  context: RouteContext,
  settings: SelectedRouteSettings,
  budgetAllowed: boolean | null
): RouteCandidateEvaluation {
  const translated = context.surface !== settings.dialect;
  return {
    id,
    order,
    providerId: settings.provider,
    providerAccountIds: [],
    model: settings.model,
    endpointDialect: settings.dialect,
    translated,
    translatorId: translated ? `${context.surface}_to_${settings.dialect}` : null,
    compatible: true,
    eligible: true,
    skipReasons: [],
    factors: {
      nativeDialect: !translated,
      capabilityMatch: true,
      contextWindowOk: null,
      providerHealthy: null,
      accountAvailable: true,
      budgetAllowed,
      rateLimitAllowed: null,
      sessionAffinityMatch: null
    }
  };
}
