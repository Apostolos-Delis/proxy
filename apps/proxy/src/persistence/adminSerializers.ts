import {
  events,
  invitations,
  providerAttempts,
  routeDecisions,
  usageLedger
} from "@prompt-proxy/db";
import { ROUTE_NAMES, type RouteTarget, type RoutingConfig } from "@prompt-proxy/schema";

import { anthropicEffortForModel, nearestReasoningEffort, reasoningEffortsFromCapabilities } from "../catalog.js";
import type { JsonObject } from "../types.js";
import { effectiveInvitationStatus } from "./userAdmin.js";

type ProviderAttemptRow = typeof providerAttempts.$inferSelect;
type UsageLedgerRow = typeof usageLedger.$inferSelect;
type RoutingConfigProviderSummary = {
  capabilities: Record<string, unknown>;
  endpoints?: readonly { dialect: string }[];
};

export function invitationSummary(
  row: typeof invitations.$inferSelect,
  inviter: { id: string; name: string | null; email: string | null } | null,
  now = new Date()
) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    name: row.name ?? undefined,
    role: row.role,
    status: effectiveInvitationStatus(row, now),
    tokenPrefix: row.tokenPrefix,
    invitedBy: inviter
      ? {
          userId: inviter.id,
          name: inviter.name ?? undefined,
          email: inviter.email ?? undefined
        }
      : null,
    acceptedUserId: row.acceptedUserId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastSentAt: row.lastSentAt?.toISOString() ?? undefined,
    acceptedAt: row.acceptedAt?.toISOString() ?? undefined,
    revokedAt: row.revokedAt?.toISOString() ?? undefined
  };
}

export function routeDecisionSummary(row: typeof routeDecisions.$inferSelect) {
  return {
    id: row.id,
    requestId: row.requestId,
    requestedModel: row.requestedModel,
    classifierRoute: row.classifierRoute ?? undefined,
    finalRoute: row.finalRoute ?? undefined,
    selectedProvider: row.selectedProvider ?? undefined,
    selectedModel: row.selectedModel ?? undefined,
    reasoningEffort: row.reasoningEffort ?? undefined,
    verbosity: row.verbosity ?? undefined,
    routingConfig: routingConfigSummary(row),
    confidence: row.confidence,
    reasonCodes: row.reasonCodes,
    guardrailActions: row.guardrailActions,
    budgetChecks: row.budgetChecks,
    classifier: row.classifier,
    routeExecutionPlan: row.routeExecutionPlan,
    selectedCandidateId: row.selectedCandidateId ?? undefined,
    translated: row.translated,
    translatorId: row.translatorId ?? undefined,
    policyVersion: row.policyVersion,
    createdAt: row.createdAt.toISOString()
  };
}

export function routingConfigSummary(row: {
  routingConfigId: string | null;
  routingConfigVersionId: string | null;
  routingConfigVersion: number | null;
  routingConfigHash: string | null;
  routingConfigName?: string | null;
}) {
  if (!row.routingConfigId) return null;
  return {
    configId: row.routingConfigId,
    configName: row.routingConfigName ?? null,
    versionId: row.routingConfigVersionId,
    version: row.routingConfigVersion,
    configHash: row.routingConfigHash
  };
}

export function routingConfigRoutesSummary(
  config: RoutingConfig,
  providersBySlug = new Map<string, RoutingConfigProviderSummary>()
) {
  return ROUTE_NAMES.map((route) => {
    const routeConfig = config.routes[route];
    return {
      route,
      description: routeConfig.description ?? null,
      targets: routeConfig.targets.map((target) => routeTargetSummary(target, providersBySlug))
    };
  });
}

function routeTargetSummary(target: RouteTarget, providersBySlug: Map<string, RoutingConfigProviderSummary>) {
  const provider = providersBySlug.get(target.providerId);
  return {
    providerId: target.providerId,
    model: target.model,
    effort: target.effort ?? null,
    effectiveEffort: effectiveEffort(target, provider),
    thinking: target.thinking ?? null,
    maxOutputTokens: target.maxOutputTokens ?? null,
    verbosity: target.verbosity ?? null,
    metadata: target.metadata ?? null
  };
}

function effectiveEffort(target: RouteTarget, provider?: RoutingConfigProviderSummary) {
  if (!target.effort) return null;
  if (
    target.providerId === "anthropic" ||
    provider?.endpoints?.some((endpoint) => endpoint.dialect === "anthropic-messages")
  ) {
    if (target.thinking?.type !== "adaptive") return null;
    return anthropicEffortForModel(target.model, target.effort) ?? null;
  }
  const supportedEfforts = reasoningEffortsFromCapabilities(provider?.capabilities);
  if (supportedEfforts !== undefined) {
    if (supportedEfforts.length === 0) return null;
    return nearestReasoningEffort(target.effort, supportedEfforts) ?? target.effort;
  }
  return target.effort;
}

export function providerAttemptSummary(row: ProviderAttemptRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    surface: row.surface,
    provider: row.provider,
    model: row.model,
    providerAccountId: row.providerAccountId ?? undefined,
    upstreamRequestId: row.upstreamRequestId ?? undefined,
    terminalStatus: row.terminalStatus,
    statusCode: row.statusCode ?? undefined,
    error: row.error ?? undefined,
    usage: row.usage as JsonObject,
    routeCandidateId: row.routeCandidateId ?? undefined,
    attemptIndex: row.attemptIndex ?? undefined,
    fallbackIndex: row.fallbackIndex ?? undefined,
    skipReason: row.skipReason ?? undefined,
    startedAt: row.startedAt.toISOString(),
    firstByteAt: row.firstByteAt?.toISOString() ?? undefined,
    completedAt: row.completedAt?.toISOString() ?? undefined
  };
}

export function usageLedgerSummary(row: UsageLedgerRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    providerAttemptId: row.providerAttemptId ?? undefined,
    kind: row.kind,
    userId: row.userId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    provider: row.provider,
    model: row.model,
    route: row.route ?? undefined,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    inputCostMicros: row.inputCostMicros,
    outputCostMicros: row.outputCostMicros,
    totalCostMicros: row.totalCostMicros,
    usage: row.usage as JsonObject,
    createdAt: row.createdAt.toISOString()
  };
}

export function eventSummary(row: typeof events.$inferSelect) {
  return {
    eventId: row.id,
    sequence: row.sequence,
    tenantId: row.organizationId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    sessionId: row.sessionId ?? undefined,
    correlationId: row.correlationId ?? undefined,
    eventType: row.eventType,
    producer: row.producer,
    payload: row.payload as JsonObject,
    metadata: row.metadata as JsonObject,
    createdAt: row.createdAt.toISOString()
  };
}
