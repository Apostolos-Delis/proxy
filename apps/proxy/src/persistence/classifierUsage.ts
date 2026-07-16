import { and, eq } from "drizzle-orm";

import {
  modelDeployments,
  providerConnections,
  requests,
  usageLedger,
  type ProxyTransaction
} from "@proxy/db";

import { usageCostMicros } from "../pricing.js";
import { pricingFromRow } from "./modelPricing.js";
import { normalizeUsage, providerValue, recordValue, stringValue } from "./values.js";

// The routing classifier makes its own billed LLM call on every uncached
// request. That spend exists only because we route, so it is captured as a
// dedicated ledger row (kind = "classifier") rather than folded into the
// request's provider usage — keeping it out of token totals and the baseline
// counterfactual while still counting toward what the proxy actually spends.
export async function persistClassifierUsage(tx: ProxyTransaction, event: {
  tenantId: string;
  scopeId: string;
  payload: Record<string, unknown>;
}) {
  const usage = recordValue(event.payload.usage);
  if (!usage) return;
  const model = stringValue(event.payload.model);
  if (!model) return;
  const provider = providerValue(event.payload.provider) ?? "unknown";
  const deploymentId = stringValue(event.payload.classifierDeploymentId);
  if (!deploymentId) throw new Error("Classifier usage is missing its deployment id.");

  const [request] = await tx
    .select()
    .from(requests)
    .where(eq(requests.id, event.scopeId))
    .limit(1);
  if (!request) return;

  const normalized = normalizeUsage(usage);
  const [deployment] = await tx
    .select({ pricing: modelDeployments.pricing })
    .from(modelDeployments)
    .innerJoin(providerConnections, and(
      eq(providerConnections.organizationId, modelDeployments.organizationId),
      eq(providerConnections.workspaceId, modelDeployments.workspaceId),
      eq(providerConnections.id, modelDeployments.providerConnectionId)
    ))
    .where(and(
      eq(modelDeployments.organizationId, event.tenantId),
      eq(modelDeployments.workspaceId, request.workspaceId),
      eq(modelDeployments.id, deploymentId),
      eq(modelDeployments.upstreamModelId, model),
      eq(providerConnections.slug, provider)
    ))
    .limit(1);
  if (!deployment) throw new Error("Classifier usage does not match a scoped deployment.");
  const modelPricing = pricingFromRow(deployment.pricing);
  const costs = usageCostMicros(modelPricing, normalized);
  await tx
    .insert(usageLedger)
    .values({
      // Deterministic per request so replaying the event is idempotent.
      id: `usage_classifier_${event.scopeId}`,
      organizationId: event.tenantId,
      workspaceId: request.workspaceId,
      userId: request.userId,
      sessionId: request.sessionId,
      requestId: event.scopeId,
      providerAttemptId: null,
      kind: "classifier",
      provider,
      model,
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
      target: usageLedger.id,
      set: {
        provider,
        model,
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
