import { describe, expect, it } from "vitest";

import {
  buildModelPricingTable,
  completeModelPricing,
  pricingForProviderModel,
  pricingForModel,
  providerModelPricingKey,
  usageCostMicros
} from "../src/pricing.js";

describe("model pricing table", () => {
  it("starts empty without explicit no-database pricing", () => {
    const table = buildModelPricingTable({});

    expect(table).toEqual({});
  });

  it("builds an explicit in-memory pricing table", () => {
    const table = buildModelPricingTable({
      "claude-haiku-4-5": { inputCostPerMtok: 2, outputCostPerMtok: 8 },
      "my-private-model": {
        inputCostPerMtok: 10,
        outputCostPerMtok: 40,
        cacheReadCostPerMtok: 0.5,
        cacheWriteCostPerMtok: 11
      }
    });

    expect(table["claude-haiku-4-5"]).toEqual({
      inputCostPerMtok: 2,
      outputCostPerMtok: 8,
      cacheReadCostPerMtok: 0.2,
      cacheWriteCostPerMtok: 2.5
    });
    expect(table["my-private-model"]).toEqual({
      inputCostPerMtok: 10,
      outputCostPerMtok: 40,
      cacheReadCostPerMtok: 0.5,
      cacheWriteCostPerMtok: 11
    });
    expect(table["claude-sonnet-4-5"]).toBeUndefined();
  });

  it("resolves dated model identifiers to their undated pricing entry", () => {
    const table = buildModelPricingTable({
      "claude-sonnet-4-5": { inputCostPerMtok: 3, outputCostPerMtok: 15 },
      "gpt-5-nano": { inputCostPerMtok: 0.05, outputCostPerMtok: 0.4 },
      "gpt-5.4": { inputCostPerMtok: 1.25, outputCostPerMtok: 10 }
    });

    expect(pricingForModel(table, "claude-sonnet-4-5-20250929")).toEqual(table["claude-sonnet-4-5"]);
    expect(pricingForModel(table, "gpt-5-nano-2025-08-07")).toEqual(table["gpt-5-nano"]);
    expect(pricingForModel(table, "gpt-5.4")).toEqual(table["gpt-5.4"]);
    expect(pricingForModel(table, "totally-unknown-model")).toBeUndefined();
  });

  it("resolves provider-qualified catalog pricing without crossing providers", () => {
    const table = {
      [providerModelPricingKey("openai", "shared-model")]: completeModelPricing({
        inputCostPerMtok: 1,
        outputCostPerMtok: 2
      }),
      [providerModelPricingKey("acme", "shared-model")]: completeModelPricing({
        inputCostPerMtok: 10,
        outputCostPerMtok: 20
      }),
      [providerModelPricingKey("anthropic", "claude-sonnet-4-5")]: completeModelPricing({
        inputCostPerMtok: 3,
        outputCostPerMtok: 15
      })
    };

    expect(pricingForProviderModel(table, "openai", "shared-model")?.inputCostPerMtok).toBe(1);
    expect(pricingForProviderModel(table, "acme", "shared-model")?.inputCostPerMtok).toBe(10);
    expect(pricingForProviderModel(table, "anthropic", "claude-sonnet-4-5-20250929")).toEqual(
      table[providerModelPricingKey("anthropic", "claude-sonnet-4-5")]
    );
    expect(pricingForProviderModel(table, "openai", "claude-sonnet-4-5")).toBeUndefined();
  });
});

describe("usageCostMicros", () => {
  it("prices cached input tokens at the cache-read rate", () => {
    const pricing = completeModelPricing({
      inputCostPerMtok: 1.25,
      outputCostPerMtok: 10
    });

    const costs = usageCostMicros(pricing, {
      inputTokens: 1000,
      cachedInputTokens: 600,
      cacheCreationInputTokens: 0,
      outputTokens: 100
    });

    expect(costs.inputCostMicros).toBe(575);
    expect(costs.outputCostMicros).toBe(1000);
    expect(costs.totalCostMicros).toBe(1575);
  });

  it("prices anthropic cache writes at the cache-write rate", () => {
    const pricing = completeModelPricing({ inputCostPerMtok: 1, outputCostPerMtok: 5 });

    const costs = usageCostMicros(pricing, {
      inputTokens: 13000,
      cachedInputTokens: 10000,
      cacheCreationInputTokens: 2000,
      outputTokens: 500
    });

    expect(costs.inputCostMicros).toBe(4500);
    expect(costs.outputCostMicros).toBe(2500);
    expect(costs.totalCostMicros).toBe(7000);
  });

  it("never bills negative uncached input when subsets exceed the total", () => {
    const pricing = completeModelPricing({ inputCostPerMtok: 100, outputCostPerMtok: 1 });

    const costs = usageCostMicros(pricing, {
      inputTokens: 100,
      cachedInputTokens: 150,
      cacheCreationInputTokens: 0,
      outputTokens: 0
    });

    expect(costs.inputCostMicros).toBe(Math.round(150 * 10));
  });

  it("returns zero cost without pricing", () => {
    expect(usageCostMicros(undefined, {
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 1000
    })).toEqual({ inputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0 });
  });
});
