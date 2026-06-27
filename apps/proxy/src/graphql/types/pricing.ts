import { builder } from "../builder.js";
import type { ModelCatalogEntryModel, ModelPricingEntryModel } from "../models.js";
import type { BedrockModelDiscoveryResult as BedrockModelDiscoveryResultModel } from "../../jobs/bedrockModelDiscovery.js";

type BedrockModelDiscoveryRegionErrorModel = BedrockModelDiscoveryResultModel["errors"][number];

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

export const ModelCatalogEntry = builder
  .objectRef<ModelCatalogEntryModel>("ModelCatalogEntry")
  .implement({
    fields: (t) => ({
      provider: t.exposeString("provider"),
      model: t.exposeString("model"),
      displayName: t.exposeString("displayName", { nullable: true }),
      catalogSource: t.exposeString("catalogSource"),
      providerAccountId: t.exposeString("providerAccountId", { nullable: true }),
      region: t.exposeString("region", { nullable: true }),
      bedrockModelSource: t.exposeString("bedrockModelSource", { nullable: true }),
      bedrockInferenceProfileArn: t.exposeString("bedrockInferenceProfileArn", { nullable: true }),
      bedrockInferenceProfileId: t.exposeString("bedrockInferenceProfileId", { nullable: true }),
      bedrockInferenceProfileSource: t.exposeString("bedrockInferenceProfileSource", { nullable: true }),
      bedrockInferenceProfileGeography: t.exposeString("bedrockInferenceProfileGeography", { nullable: true }),
      bedrockBaseModelId: t.exposeString("bedrockBaseModelId", { nullable: true }),
      bedrockFoundationModelId: t.exposeString("bedrockFoundationModelId", { nullable: true }),
      dialects: t.exposeStringList("dialects"),
      contextWindow: t.exposeInt("contextWindow", { nullable: true }),
      maxOutputTokens: t.exposeInt("maxOutputTokens", { nullable: true }),
      supportsStreaming: t.exposeBoolean("supportsStreaming", { nullable: true }),
      supportsTools: t.exposeBoolean("supportsTools", { nullable: true }),
      supportsImages: t.exposeBoolean("supportsImages", { nullable: true }),
      supportsReasoning: t.exposeBoolean("supportsReasoning", { nullable: true }),
      warnings: t.exposeStringList("warnings"),
      pricingKnown: t.exposeBoolean("pricingKnown"),
      inputCostPerMtok: t.exposeFloat("inputCostPerMtok", { nullable: true }),
      outputCostPerMtok: t.exposeFloat("outputCostPerMtok", { nullable: true }),
      cacheReadCostPerMtok: t.exposeFloat("cacheReadCostPerMtok", { nullable: true }),
      cacheWriteCostPerMtok: t.exposeFloat("cacheWriteCostPerMtok", { nullable: true }),
      updatedAt: t.exposeString("updatedAt")
    })
  });

export const BedrockModelDiscoveryRegionError = builder
  .objectRef<BedrockModelDiscoveryRegionErrorModel>("BedrockModelDiscoveryRegionError")
  .implement({
    fields: (t) => ({
      region: t.exposeString("region"),
      error: t.exposeString("error")
    })
  });

export const BedrockModelDiscoveryResult = builder
  .objectRef<BedrockModelDiscoveryResultModel>("BedrockModelDiscoveryResult")
  .implement({
    fields: (t) => ({
      status: t.exposeString("status"),
      provider: t.string({
        nullable: true,
        resolve: (result) => result.status === "completed" ? result.provider : null
      }),
      providerAccountId: t.exposeString("providerAccountId"),
      error: t.string({
        nullable: true,
        resolve: (result) => result.status === "failed" ? result.error : null
      }),
      regions: t.exposeStringList("regions"),
      modelsSeen: t.exposeInt("modelsSeen"),
      modelsApplied: t.exposeInt("modelsApplied"),
      inserted: t.exposeInt("inserted"),
      updated: t.exposeInt("updated"),
      skipped: t.exposeInt("skipped"),
      errors: t.field({
        type: [BedrockModelDiscoveryRegionError],
        resolve: (result) => result.errors
      })
    })
  });
