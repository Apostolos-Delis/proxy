import { z } from "zod";

import { completeModelPricing, type ModelPricing } from "../pricing.js";

const modelPricingRateFields = {
  inputCostPerMtok: z.number().finite().nonnegative(),
  outputCostPerMtok: z.number().finite().nonnegative(),
  cacheReadCostPerMtok: z.number().finite().nonnegative().optional(),
  cacheWriteCostPerMtok: z.number().finite().nonnegative().optional()
};
export const modelPricingRatesSchema = z.strictObject({
  ...modelPricingRateFields,
  largeContext: z.strictObject({
    thresholdInputTokens: z.number().int().positive(),
    ...modelPricingRateFields
  }).optional()
});
export const modelPricingConfigSchema = z.union([
  z.strictObject({}),
  modelPricingRatesSchema
]);
const storedModelPricingRatesSchema = z.object({
  ...modelPricingRateFields,
  largeContext: z.object({
    thresholdInputTokens: z.number().int().positive(),
    ...modelPricingRateFields
  }).optional()
});

export function pricingFromRow(value: unknown): ModelPricing | undefined {
  const parsed = storedModelPricingRatesSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return completeModelPricing(parsed.data);
}
