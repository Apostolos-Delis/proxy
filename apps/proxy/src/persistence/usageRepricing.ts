import { and, eq, gt } from "drizzle-orm";

import { usageLedger, type PromptProxyDbSession } from "@prompt-proxy/db";

import {
  pricingForModel,
  undatedModel,
  usageCostMicros,
  type ModelPricing,
  type ModelPricingTable
} from "../pricing.js";
import { orgPricingOverrides, type OrgPricingOverride } from "./modelPricing.js";
import type { Provider } from "../types.js";

export type RepriceScope = {
  organizationId: string;
  provider: Provider;
  model: string;
};

// Ledger costs are snapshotted at ingest, so traffic served while a model had
// no rate books $0 forever — even after the rate arrives, spend stays
// understated and "savings" inflate against a fully-priced baseline. Reprice
// those zero-cost rows whenever pricing appears: at boot for default-table
// additions shipped in code, and after setPricing for org overrides. Rows
// priced at ingest keep their snapshot; only the never-priced ones heal.
export async function repriceZeroCostUsage(
  db: PromptProxyDbSession,
  pricing: ModelPricingTable,
  scope?: RepriceScope
) {
  const conditions = [eq(usageLedger.totalCostMicros, 0), gt(usageLedger.totalTokens, 0)];
  if (scope) {
    conditions.push(eq(usageLedger.organizationId, scope.organizationId));
    conditions.push(eq(usageLedger.provider, scope.provider));
  }
  const rows = await db
    .select({
      id: usageLedger.id,
      organizationId: usageLedger.organizationId,
      provider: usageLedger.provider,
      model: usageLedger.model,
      inputTokens: usageLedger.inputTokens,
      cachedInputTokens: usageLedger.cachedInputTokens,
      cacheCreationInputTokens: usageLedger.cacheCreationInputTokens,
      outputTokens: usageLedger.outputTokens
    })
    .from(usageLedger)
    .where(and(...conditions));

  const overridesByOrg = new Map<string, OrgPricingOverride[]>();
  let repriced = 0;
  for (const row of rows) {
    if (scope && row.model !== scope.model && undatedModel(row.model) !== scope.model) continue;
    let overrides = overridesByOrg.get(row.organizationId);
    if (!overrides) {
      overrides = await orgPricingOverrides(db, row.organizationId);
      overridesByOrg.set(row.organizationId, overrides);
    }
    const modelPricing =
      overridePricingFor(overrides, row.provider, row.model) ??
      pricingForModel(pricing, row.model);
    if (!modelPricing) continue;
    const costs = usageCostMicros(modelPricing, row);
    if (costs.totalCostMicros === 0) continue;
    await db
      .update(usageLedger)
      .set({
        inputCostMicros: costs.inputCostMicros,
        outputCostMicros: costs.outputCostMicros,
        totalCostMicros: costs.totalCostMicros
      })
      .where(eq(usageLedger.id, row.id));
    repriced += 1;
  }
  return repriced;
}

function overridePricingFor(
  overrides: OrgPricingOverride[],
  provider: string,
  model: string
): ModelPricing | undefined {
  for (const candidate of [model, undatedModel(model)]) {
    const match = overrides.find((entry) => entry.provider === provider && entry.model === candidate);
    if (match) return match.pricing;
  }
  return undefined;
}
