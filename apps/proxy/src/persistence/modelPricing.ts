import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  modelCatalog,
  providers,
  type PromptProxyDbSession
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

export async function catalogPricingForModel(
  db: PromptProxyDbSession,
  organizationId: string,
  provider: string,
  model: string
): Promise<ModelPricing | undefined> {
  const providerRow = await providerForSlug(db, organizationId, provider);
  if (!providerRow) return undefined;
  const candidates = candidateModels(model);
  const override = await pricingForProviderModels(db, organizationId, providerRow.id, candidates);
  if (override) return override;
  if (providerRow.organizationId !== null) return undefined;
  return pricingForProviderModels(db, null, providerRow.id, candidates);
}

async function providerForSlug(
  db: PromptProxyDbSession,
  organizationId: string,
  slug: string
) {
  const [orgProvider] = await db
    .select({ id: providers.id, organizationId: providers.organizationId })
    .from(providers)
    .where(and(
      eq(providers.organizationId, organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  if (orgProvider) return orgProvider;

  const [builtinProvider] = await db
    .select({ id: providers.id, organizationId: providers.organizationId })
    .from(providers)
    .where(and(
      isNull(providers.organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  return builtinProvider ?? null;
}

async function pricingForProviderModels(
  db: PromptProxyDbSession,
  organizationId: string | null,
  providerId: string,
  candidates: string[]
) {
  const rows = await db
    .select({ model: modelCatalog.model, pricing: modelCatalog.pricing })
    .from(modelCatalog)
    .where(and(
      organizationId === null
        ? isNull(modelCatalog.organizationId)
        : eq(modelCatalog.organizationId, organizationId),
      eq(modelCatalog.providerId, providerId),
      inArray(modelCatalog.model, candidates)
    ));
  const pricingByModel = new Map(rows.map((row) => [row.model, row.pricing]));
  for (const candidate of candidates) {
    const pricing = pricingFromRow(pricingByModel.get(candidate));
    if (pricing) return pricing;
  }
  return undefined;
}

function candidateModels(model: string) {
  return [...new Set([model, undatedModel(model)])];
}
