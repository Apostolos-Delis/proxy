import {
  events,
  invitations,
  providerAttempts,
  routeDecisions,
  usageLedger
} from "@proxy/db";
import { ROUTE_NAMES, type Effort, type RoutingConfig } from "@proxy/schema";

import { anthropicEffortForModel, reasoningEffortsFromCapabilities } from "../catalog.js";
import type { JsonObject } from "../types.js";
import { effectiveInvitationStatus } from "./userAdmin.js";

type ProviderAttemptRow = typeof providerAttempts.$inferSelect;
type UsageLedgerRow = typeof usageLedger.$inferSelect;

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
  providersBySlug = new Map<string, { capabilities: Record<string, unknown> }>()
) {
  return ROUTE_NAMES.map((route) => {
    const routeConfig = config.routes[route];
    const targets = [
      ...(routeConfig.openai?.deployments.map((deployment) => ({
        providerId: deployment.provider,
        model: deployment.model,
        effort: deployment.reasoning?.effort ?? null,
        effectiveEffort: effectiveOpenAIEffort(deployment.provider, deployment.reasoning?.effort, providersBySlug),
        thinking: null,
        maxOutputTokens: deployment.maxOutputTokens ?? null,
        verbosity: deployment.text?.verbosity ?? null,
        metadata: deployment.metadata ?? null,
        order: deployment.order
      })) ?? []),
      ...(routeConfig.anthropic?.deployments.map((deployment) => ({
        providerId: deployment.provider,
        model: deployment.model,
        effort: deployment.output_config?.effort ?? null,
        effectiveEffort: deployment.thinking?.type === "adaptive" && deployment.output_config?.effort
          ? anthropicEffortForModel(deployment.model, deployment.output_config.effort)
          : null,
        thinking: deployment.thinking ?? null,
        maxOutputTokens: deployment.maxTokens ?? null,
        verbosity: null,
        metadata: deployment.metadata ?? null,
        order: deployment.order
      })) ?? [])
    ].sort((left, right) => left.order - right.order)
      .map(({ order: _order, ...target }) => target);
    return {
      route,
      description: routeConfig.description ?? null,
      targets
    };
  });
}

function effectiveOpenAIEffort(
  provider: string,
  effort: Effort | undefined,
  providersBySlug: Map<string, { capabilities: Record<string, unknown> }>
) {
  if (!effort) return null;
  const supported = reasoningEffortsFromCapabilities(providersBySlug.get(provider)?.capabilities) ?? [];
  if (supported.length === 0) return effort;
  return supported.includes(effort) ? effort : null;
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
