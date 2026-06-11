import {
  events,
  invitations,
  providerAttempts,
  routeDecisions,
  usageLedger
} from "@prompt-proxy/db";
import { ROUTE_NAMES, type RoutingConfig } from "@prompt-proxy/schema";

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

export function routeMatrixSummary(config: RoutingConfig) {
  return ROUTE_NAMES.map((route) => {
    const routeConfig = config.routes[route];
    return {
      route,
      description: routeConfig.description ?? null,
      openaiModel: routeConfig.openai?.model ?? null,
      openaiEffort: routeConfig.openai?.reasoning?.effort ?? null,
      anthropicModel: routeConfig.anthropic?.model ?? null,
      anthropicEffort: routeConfig.anthropic?.output_config?.effort ?? null
    };
  });
}

export function providerAttemptSummary(row: ProviderAttemptRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    surface: row.surface,
    provider: row.provider,
    model: row.model,
    upstreamRequestId: row.upstreamRequestId ?? undefined,
    terminalStatus: row.terminalStatus,
    statusCode: row.statusCode ?? undefined,
    error: row.error ?? undefined,
    usage: row.usage as JsonObject,
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
