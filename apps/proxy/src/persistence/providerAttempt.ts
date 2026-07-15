import { and, eq } from "drizzle-orm";

import {
  defaultWorkspaceId,
  providerAttempts,
  requests,
  usageLedger,
  type ProxyTransaction
} from "@proxy/db";
import type { ProviderAdapterKind, ProviderAttemptStatus } from "@proxy/schema";

import { gatewayProviderAttemptEvidenceValue } from "../gatewayEvidence.js";
import { usageCostMicros } from "../pricing.js";
import { createId } from "../util.js";
import { catalogPricingForModel } from "./modelPricing.js";
import { routeForRequest } from "./routeDecision.js";
import {
  normalizeUsage,
  numberValue,
  providerValue,
  recordValue,
  routeSkipReasonValue,
  stringValue,
  surfaceValue
} from "./values.js";

type TerminalProviderAttemptStatus = Exclude<ProviderAttemptStatus, "pending">;

export async function persistProviderStarted(tx: ProxyTransaction, event: {
  tenantId: string;
  workspaceId?: string;
  scopeId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}) {
  const payload = event.payload;
  const workspaceId = event.workspaceId ?? defaultWorkspaceId(event.tenantId);
  const gatewayEvidence = gatewayProviderAttemptEvidenceValue(payload);
  await tx
    .update(requests)
    .set({ status: "provider_pending" })
    .where(and(
      eq(requests.id, event.scopeId),
      eq(requests.organizationId, event.tenantId),
      eq(requests.workspaceId, workspaceId)
    ));

  await tx
    .insert(providerAttempts)
    .values({
      id: stringValue(payload.providerAttemptId) ?? createId("provider_attempt"),
      requestId: event.scopeId,
      organizationId: event.tenantId,
      workspaceId,
      surface: surfaceValue(payload.surface) ?? "unknown",
      provider: providerValue(payload.provider) ?? "unknown",
      model: stringValue(payload.model) ?? "unknown",
      adapterKind: providerAdapterKindValue(payload.adapterKind),
      adapterClassification: recordValue(payload.adapterClassification),
      providerAccountId: stringValue(payload.providerAccountId),
      ...gatewayEvidence,
      terminalStatus: "pending",
      routeCandidateId: stringValue(payload.routeCandidateId),
      attemptIndex: numberValue(payload.attemptIndex),
      fallbackIndex: numberValue(payload.fallbackIndex),
      skipReason: routeSkipReasonValue(payload.skipReason),
      startedAt: new Date(event.createdAt)
    })
    .onConflictDoNothing();
}

export async function persistStreamStarted(tx: ProxyTransaction, event: {
  createdAt: string;
  payload: Record<string, unknown>;
}) {
  const providerAttemptId = stringValue(event.payload.providerAttemptId);
  if (!providerAttemptId) return;
  await tx
    .update(providerAttempts)
    .set({ firstByteAt: new Date(event.createdAt) })
    .where(eq(providerAttempts.id, providerAttemptId));
}

export async function persistProviderTerminal(tx: ProxyTransaction, event: {
  tenantId: string;
  workspaceId: string;
  scopeId: string;
  createdAt: string;
  eventType: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}) {
  const payload = event.payload;
  const providerAttemptId = stringValue(payload.providerAttemptId);
  if (!providerAttemptId) return;
  const status = terminalStatus(event.eventType, payload.terminalStatus);
  const usage = recordValue(payload.usage);
  const completedAt = new Date(event.createdAt);
  const error = errorText(payload.error) ?? errorText(event.metadata.error);
  const adapterKind = providerAdapterKindValue(payload.adapterKind);
  const adapterClassification = recordValue(payload.adapterClassification);
  const gatewayEvidence = gatewayProviderAttemptEvidenceValue(payload);
  const [attempt] = await tx
    .select()
    .from(providerAttempts)
    .where(and(
      eq(providerAttempts.id, providerAttemptId),
      eq(providerAttempts.organizationId, event.tenantId),
      eq(providerAttempts.workspaceId, event.workspaceId),
      eq(providerAttempts.requestId, event.scopeId)
    ))
    .limit(1);
  if (!attempt) throw new Error("Provider terminal event does not match a scoped provider attempt.");
  if (
    gatewayEvidence && (
      attempt.deploymentId !== gatewayEvidence.deploymentId ||
      attempt.providerConnectionId !== gatewayEvidence.providerConnectionId ||
      attempt.egressWireId !== gatewayEvidence.egressWireId ||
      attempt.providerAdapterContractVersion !== gatewayEvidence.providerAdapterContractVersion
    )
  ) {
    throw new Error("Provider terminal evidence does not match the provider attempt target.");
  }
  const update = {
    terminalStatus: status,
    statusCode: numberValue(payload.upstreamStatus),
    upstreamRequestId: stringValue(payload.upstreamRequestId) ?? stringValue(event.metadata.upstreamResponseId),
    error,
    usage: usage ?? {},
    completedAt,
    ...(adapterKind === undefined ? {} : { adapterKind }),
    ...(adapterClassification === undefined ? {} : { adapterClassification })
  };

  await tx
    .update(providerAttempts)
    .set(update)
    .where(and(
      eq(providerAttempts.id, providerAttemptId),
      eq(providerAttempts.organizationId, event.tenantId),
      eq(providerAttempts.workspaceId, event.workspaceId),
      eq(providerAttempts.requestId, event.scopeId)
    ));

  await tx
    .update(requests)
    .set({
      status,
      completedAt
    })
    .where(and(
      eq(requests.id, event.scopeId),
      eq(requests.organizationId, event.tenantId),
      eq(requests.workspaceId, event.workspaceId)
    ));

  if (!usage) return;
  const [request] = await tx
    .select()
    .from(requests)
    .where(and(
      eq(requests.id, event.scopeId),
      eq(requests.organizationId, event.tenantId),
      eq(requests.workspaceId, event.workspaceId)
    ))
    .limit(1);
  if (!request) return;

  const normalized = normalizeUsage(usage);
  const modelPricing = await catalogPricingForModel(tx, event.tenantId, attempt.provider, attempt.model);
  const costs = usageCostMicros(modelPricing, normalized);
  const route = await routeForRequest(tx, event.scopeId);

  await tx
    .insert(usageLedger)
    .values({
      id: createId("usage"),
      organizationId: event.tenantId,
      workspaceId: request.workspaceId,
      userId: request.userId,
      sessionId: request.sessionId,
      requestId: event.scopeId,
      providerAttemptId,
      provider: attempt.provider,
      model: attempt.model,
      route,
      inputTokens: normalized.inputTokens,
      cachedInputTokens: normalized.cachedInputTokens,
      cacheCreationInputTokens: normalized.cacheCreationInputTokens,
      outputTokens: normalized.outputTokens,
      reasoningTokens: normalized.reasoningTokens,
      totalTokens: normalized.totalTokens,
      inputCostMicros: costs.inputCostMicros,
      outputCostMicros: costs.outputCostMicros,
      totalCostMicros: costs.totalCostMicros,
      usage
    })
    .onConflictDoUpdate({
      target: usageLedger.providerAttemptId,
      set: {
        inputTokens: normalized.inputTokens,
        cachedInputTokens: normalized.cachedInputTokens,
        cacheCreationInputTokens: normalized.cacheCreationInputTokens,
        outputTokens: normalized.outputTokens,
        reasoningTokens: normalized.reasoningTokens,
        totalTokens: normalized.totalTokens,
        inputCostMicros: costs.inputCostMicros,
        outputCostMicros: costs.outputCostMicros,
        totalCostMicros: costs.totalCostMicros,
        usage
      }
    });
}

function terminalStatus(eventType: string, payloadStatus: unknown): TerminalProviderAttemptStatus {
  if (payloadStatus === "completed" || payloadStatus === "failed" || payloadStatus === "cancelled") {
    return payloadStatus;
  }
  if (eventType === "provider.response_completed") return "completed";
  if (eventType === "provider.response_cancelled") return "cancelled";
  return "failed";
}

function errorText(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
}

function providerAdapterKindValue(value: unknown): ProviderAdapterKind | undefined {
  if (value === "generic-http-json" || value === "aws-bedrock-converse") return value;
  return undefined;
}
