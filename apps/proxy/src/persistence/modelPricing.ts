import { z } from "zod";

import { completeModelPricing, type ModelPricing } from "../pricing.js";

const pricingOverrideSchema = z.object({
  inputCostPerMtok: z.number().nonnegative(),
  outputCostPerMtok: z.number().nonnegative(),
  cacheReadCostPerMtok: z.number().nonnegative().optional(),
  cacheWriteCostPerMtok: z.number().nonnegative().optional()
});

export function pricingFromRow(value: unknown): ModelPricing | undefined {
  const parsed = pricingOverrideSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return completeModelPricing(parsed.data);
}
