import {
  events,
  invitations,
  providerAttempts,
  routeDecisions,
  usageLedger
} from "@proxy/db";

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
    selectedProvider: row.selectedProvider ?? undefined,
    selectedModel: row.selectedModel ?? undefined,
    reasoningEffort: row.reasoningEffort ?? undefined,
    verbosity: row.verbosity ?? undefined,
    ingressWireId: row.ingressWireId ?? undefined,
    operationId: row.operationId ?? undefined,
    requestedLogicalModel: row.requestedLogicalModel ?? undefined,
    resolvedLogicalModelId: row.resolvedLogicalModelId ?? undefined,
    accessProfileId: row.accessProfileId ?? undefined,
    routerKind: row.routerKind ?? undefined,
    deploymentId: row.deploymentId ?? undefined,
    providerConnectionId: row.providerConnectionId ?? undefined,
    egressWireId: row.egressWireId ?? undefined,
    wireAdapterVersion: row.wireAdapterVersion ?? undefined,
    confidence: row.confidence,
    reasonCodes: row.reasonCodes,
    guardrailActions: row.guardrailActions,
    routerDecisionId: row.routerDecisionId ?? undefined,
    routerDecision: row.routerDecision as JsonObject,
    translated: row.translated,
    translatorId: row.translatorId ?? undefined,
    policyVersion: row.policyVersion,
    createdAt: row.createdAt.toISOString()
  };
}

export function providerAttemptSummary(row: ProviderAttemptRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    surface: row.surface,
    provider: row.provider,
    model: row.model,
    adapterKind: row.adapterKind ?? undefined,
    adapterClassification: row.adapterClassification as JsonObject | undefined,
    deploymentId: row.deploymentId ?? undefined,
    providerConnectionId: row.providerConnectionId ?? undefined,
    egressWireId: row.egressWireId ?? undefined,
    providerAdapterContractVersion: row.providerAdapterContractVersion ?? undefined,
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
