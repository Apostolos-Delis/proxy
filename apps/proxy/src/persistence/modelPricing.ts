import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  modelCatalog,
  type PromptProxyDbSession,
  type PromptProxyTransaction
} from "@prompt-proxy/db";

import { completeModelPricing, undatedModel, type ModelPricing } from "../pricing.js";

// An org pricing override is a model_catalog row whose pricing jsonb carries
// numeric per-MTok rates. Seeded rows store marker objects like
// {source: "env"} and parse as "no override".
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

export type OrgPricingOverride = {
  provider: string;
  model: string;
  pricing: ModelPricing;
  updatedAt: Date;
};

export async function orgPricingOverrides(
  db: PromptProxyDbSession,
  organizationId: string
): Promise<OrgPricingOverride[]> {
  const rows = await db
    .select({
      provider: modelCatalog.provider,
      model: modelCatalog.model,
      pricing: modelCatalog.pricing,
      updatedAt: modelCatalog.updatedAt
    })
    .from(modelCatalog)
    .where(eq(modelCatalog.organizationId, organizationId));
  return rows.flatMap((row) => {
    const pricing = pricingFromRow(row.pricing);
    return pricing
      ? [{ provider: row.provider, model: row.model, pricing, updatedAt: row.updatedAt }]
      : [];
  });
}

// Overrides are stored under the model name the operator typed (usually
// undated), while provider attempts carry the requested identifier (often
// dated) — check the exact name first, then its undated form.
export async function orgPricingOverrideForModel(
  tx: PromptProxyTransaction,
  organizationId: string,
  provider: string,
  model: string
): Promise<ModelPricing | undefined> {
  if (provider !== "openai" && provider !== "anthropic") return undefined;
  const candidates = [...new Set([model, undatedModel(model)])];
  const rows = await tx
    .select({ model: modelCatalog.model, pricing: modelCatalog.pricing })
    .from(modelCatalog)
    .where(and(
      eq(modelCatalog.organizationId, organizationId),
      eq(modelCatalog.provider, provider),
      inArray(modelCatalog.model, candidates)
    ));
  const pricingByModel = new Map(rows.map((row) => [row.model, row.pricing]));
  for (const candidate of candidates) {
    const pricing = pricingFromRow(pricingByModel.get(candidate));
    if (pricing) return pricing;
  }
  return undefined;
}
