import { builder } from "../builder.js";
import type { ModelPricingEntryModel } from "../models.js";

export const ModelPricingSource = builder.enumType("ModelPricingSource", {
  values: ["default", "env", "custom", "unpriced"] as const
});

export const ModelPricingEntry = builder
  .objectRef<ModelPricingEntryModel>("ModelPricingEntry")
  .implement({
    fields: (t) => ({
      model: t.exposeString("model"),
      provider: t.exposeString("provider", { nullable: true }),
      source: t.field({ type: ModelPricingSource, resolve: (entry) => entry.source }),
      seenInTraffic: t.exposeBoolean("seenInTraffic"),
      inputCostPerMtok: t.exposeFloat("inputCostPerMtok", { nullable: true }),
      outputCostPerMtok: t.exposeFloat("outputCostPerMtok", { nullable: true }),
      cacheReadCostPerMtok: t.exposeFloat("cacheReadCostPerMtok", { nullable: true }),
      cacheWriteCostPerMtok: t.exposeFloat("cacheWriteCostPerMtok", { nullable: true }),
      updatedAt: t.exposeString("updatedAt", { nullable: true })
    })
  });
