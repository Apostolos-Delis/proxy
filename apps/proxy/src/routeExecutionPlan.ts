import { defaultWorkspaceId } from "@proxy/db";
import {
  routeSkipReasonForCompatibilityReason,
  type RouteCandidateEvaluation,
  type RouteExecutionPlan,
  type RoutePolicyResult,
  type RoutingConfig,
  type RouteTarget
} from "@proxy/schema";

import type { ClassifierSettings } from "./classifier.js";
import type {
  Dialect,
  ProviderEffort,
  ProviderHealthSkip,
  RouteContext,
  RouteDecision,
  SelectedRouteSettings
} from "./types.js";

export type TargetAvailability =
  | { status: "available"; dialect: Dialect; supportedEfforts?: ProviderEffort[]; providerAccountId?: string }
  | { status: "unavailable"; reason: string; dialect?: Dialect; healthSkip?: ProviderHealthSkip };

export type TargetAvailabilityResolver = (
  target: Pick<RouteTarget, "providerId" | "model"> & { dialect?: Dialect },
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
  const candidates = routingConfig
    ? await buildConfiguredRouteCandidates(context, decision, routingConfig.routes[finalRoute].targets, targetAvailability)
    : [];
  const selectedCandidate = candidates.find((candidate) =>
    candidate.providerId === decision.providerSettings?.providerId &&
    candidate.model === decision.providerSettings?.model &&
    candidate.endpointDialect === decision.providerSettings?.dialect
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
      providerId: decision.providerSettings.providerId,
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
  targets: RouteTarget[],
  targetAvailability: TargetAvailabilityResolver
): Promise<RouteCandidateEvaluation[]> {
  const candidates: RouteCandidateEvaluation[] = [];
  const budgetAllowed = budgetAllowedFromChecks(decision.budgetChecks);
  for (const [index, target] of targets.entries()) {
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
    const selected = decision.providerSettings?.providerId === target.providerId &&
      decision.providerSettings.model === target.model &&
      decision.providerSettings.dialect === endpointDialect;
    const eligible = availability.status === "available";
    const providerAccountIds = availability.status === "available" && availability.providerAccountId
      ? [availability.providerAccountId]
      : [];
    candidates.push({
      id: `candidate_${index}`,
      order: index,
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
        capabilityMatch: eligible || selected,
        contextWindowOk: null,
        providerHealthy: providerHealthyFactor(availability),
        accountAvailable: accountAvailableFactor(availability, eligible),
        budgetAllowed,
        rateLimitAllowed: null,
        sessionAffinityMatch: null
      }
    });
  }
  return candidates;
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
    providerId: settings.providerId,
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
