import {
  events,
  providerAttempts,
  routeDecisions,
  usageLedger
} from "@prompt-proxy/db";

import type { JsonObject } from "../types.js";

type ProviderAttemptRow = typeof providerAttempts.$inferSelect;
type UsageLedgerRow = typeof usageLedger.$inferSelect;

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
}) {
  if (!row.routingConfigId) return null;
  return {
    configId: row.routingConfigId,
    versionId: row.routingConfigVersionId,
    version: row.routingConfigVersion,
    configHash: row.routingConfigHash
  };
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
    providerAttemptId: row.providerAttemptId,
    userId: row.userId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    provider: row.provider,
    model: row.model,
    route: row.route ?? undefined,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
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
