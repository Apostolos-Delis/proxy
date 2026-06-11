import { eq } from "drizzle-orm";

import { requests, usageLedger, type PromptProxyTransaction } from "@prompt-proxy/db";

import { pricingForModel, usageCostMicros, type ModelPricingTable } from "../pricing.js";
import { orgPricingOverrideForModel } from "./modelPricing.js";
import { routeForRequest } from "./routeDecision.js";
import { normalizeUsage, providerValue, recordValue, stringValue } from "./values.js";

// The routing classifier makes its own billed LLM call on every uncached
// request. That spend exists only because we route, so it is captured as a
// dedicated ledger row (kind = "classifier") rather than folded into the
// request's provider usage — keeping it out of token totals and the baseline
// counterfactual while still counting toward what the proxy actually spends.
export async function persistClassifierUsage(tx: PromptProxyTransaction, pricing: ModelPricingTable, event: {
  tenantId: string;
  scopeId: string;
  payload: Record<string, unknown>;
}) {
  const usage = recordValue(event.payload.usage);
  if (!usage) return;
  const model = stringValue(event.payload.model);
  if (!model) return;
  const provider = providerValue(event.payload.provider) ?? "openai";

  const [request] = await tx
    .select()
    .from(requests)
    .where(eq(requests.id, event.scopeId))
    .limit(1);
  if (!request) return;

  const normalized = normalizeUsage(usage);
  const modelPricing =
    await orgPricingOverrideForModel(tx, event.tenantId, provider, model) ??
    pricingForModel(pricing, model);
  const costs = usageCostMicros(modelPricing, normalized);
  const route = await routeForRequest(tx, event.scopeId);

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
      target: usageLedger.id,
      set: {
        provider,
        model,
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
      }
    });
}
