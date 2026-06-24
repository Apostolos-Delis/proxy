import { and, eq, gt } from "drizzle-orm";

import { usageLedger, type ProxyDbSession } from "@proxy/db";

import {
  undatedModel,
  usageCostMicros
} from "../pricing.js";
import { catalogPricingForModel } from "./modelPricing.js";
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
  db: ProxyDbSession,
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

  let repriced = 0;
  for (const row of rows) {
    if (scope && row.model !== scope.model && undatedModel(row.model) !== scope.model) continue;
    const modelPricing = await catalogPricingForModel(db, row.organizationId, row.provider, row.model);
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
