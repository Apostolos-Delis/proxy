import { eq } from "drizzle-orm";

import {
  defaultWorkspaceId,
  providerAttempts,
  requests,
  usageLedger,
  type PromptProxyTransaction
} from "@prompt-proxy/db";

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

export async function persistProviderStarted(tx: PromptProxyTransaction, event: {
  tenantId: string;
  workspaceId?: string;
  scopeId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}) {
  const payload = event.payload;
  await tx
    .update(requests)
    .set({ status: "provider_pending" })
    .where(eq(requests.id, event.scopeId));

  await tx
    .insert(providerAttempts)
    .values({
      id: stringValue(payload.providerAttemptId) ?? createId("provider_attempt"),
      requestId: event.scopeId,
      organizationId: event.tenantId,
      workspaceId: event.workspaceId ?? defaultWorkspaceId(event.tenantId),
      surface: surfaceValue(payload.surface) ?? "unknown",
      provider: providerValue(payload.provider) ?? "unknown",
      model: stringValue(payload.model) ?? "unknown",
      terminalStatus: "pending",
      routeCandidateId: stringValue(payload.routeCandidateId),
      attemptIndex: numberValue(payload.attemptIndex),
      fallbackIndex: numberValue(payload.fallbackIndex),
      skipReason: routeSkipReasonValue(payload.skipReason),
      startedAt: new Date(event.createdAt)
    })
    .onConflictDoNothing();
}

export async function persistStreamStarted(tx: PromptProxyTransaction, event: {
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

export async function persistProviderTerminal(tx: PromptProxyTransaction, event: {
  tenantId: string;
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

  await tx
    .update(providerAttempts)
    .set({
      terminalStatus: status,
      statusCode: numberValue(payload.upstreamStatus),
      upstreamRequestId: stringValue(payload.upstreamRequestId) ?? stringValue(event.metadata.upstreamResponseId),
      error,
      usage: usage ?? {},
      completedAt
    })
    .where(eq(providerAttempts.id, providerAttemptId));

  await tx
    .update(requests)
    .set({
      status,
      completedAt
    })
    .where(eq(requests.id, event.scopeId));

  if (!usage) return;
  const [attempt] = await tx
    .select()
    .from(providerAttempts)
    .where(eq(providerAttempts.id, providerAttemptId))
    .limit(1);
  const [request] = await tx
    .select()
    .from(requests)
    .where(eq(requests.id, event.scopeId))
    .limit(1);
  if (!attempt || !request) return;

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

function terminalStatus(eventType: string, payloadStatus: unknown) {
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
