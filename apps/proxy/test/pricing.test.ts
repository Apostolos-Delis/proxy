import { describe, expect, it } from "vitest";

import { normalizeUsage } from "../src/persistence/values.js";
import {
  buildModelPricingTable,
  completeModelPricing,
  pricingForModel,
  usageCostMicros
} from "../src/pricing.js";

describe("model pricing table", () => {
  it("ships default pricing for the configured route models", () => {
    const table = buildModelPricingTable({});

    expect(table["claude-haiku-4-5"]).toEqual({
      inputCostPerMtok: 1,
      outputCostPerMtok: 5,
      cacheReadCostPerMtok: 0.1,
      cacheWriteCostPerMtok: 1.25
    });
    expect(table["claude-sonnet-4-5"]).toEqual({
      inputCostPerMtok: 3,
      outputCostPerMtok: 15,
      cacheReadCostPerMtok: 0.3,
      cacheWriteCostPerMtok: 3.75
    });
    expect(table["claude-opus-4-5"].inputCostPerMtok).toBe(5);
    expect(table["gpt-5.4-mini"].cacheReadCostPerMtok).toBe(0.025);
    expect(table["gpt-5.5-pro"].outputCostPerMtok).toBe(120);
    // Current production models must be priced or their spend silently books $0.
    expect(table["claude-fable-5"]).toEqual({
      inputCostPerMtok: 10,
      outputCostPerMtok: 50,
      cacheReadCostPerMtok: 1,
      cacheWriteCostPerMtok: 12.5
    });
    expect(table["claude-opus-4-7"].inputCostPerMtok).toBe(5);
    expect(table["claude-opus-4-8"]).toEqual({
      inputCostPerMtok: 5,
      outputCostPerMtok: 25,
      cacheReadCostPerMtok: 0.5,
      cacheWriteCostPerMtok: 6.25
    });
  });

  it("lets MODEL_COSTS_JSON override defaults and price unknown models", () => {
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
    expect(table["claude-sonnet-4-5"].inputCostPerMtok).toBe(3);
  });

  it("resolves dated model identifiers to their undated pricing entry", () => {
    const table = buildModelPricingTable({});

    expect(pricingForModel(table, "claude-sonnet-4-5-20250929")).toEqual(table["claude-sonnet-4-5"]);
    expect(pricingForModel(table, "gpt-5-nano-2025-08-07")).toEqual(table["gpt-5-nano"]);
    expect(pricingForModel(table, "gpt-5.4")).toEqual(table["gpt-5.4"]);
    expect(pricingForModel(table, "totally-unknown-model")).toBeUndefined();
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

describe("normalizeUsage", () => {
  it("keeps openai responses usage inclusive of cached tokens", () => {
    expect(normalizeUsage({
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 600 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 1100
    })).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 600,
      cacheCreationInputTokens: 0,
      outputTokens: 100,
      reasoningTokens: 20,
      totalTokens: 1100
    });
  });

  it("folds anthropic cache reads and writes back into total input", () => {
    expect(normalizeUsage({
      input_tokens: 1000,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 2000,
      output_tokens: 500
    })).toEqual({
      inputTokens: 13000,
      cachedInputTokens: 10000,
      cacheCreationInputTokens: 2000,
      outputTokens: 500,
      reasoningTokens: 0,
      totalTokens: 13500
    });
  });

  it("treats anthropic zero-cache usage as plain input", () => {
    expect(normalizeUsage({
      input_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 5
    })).toEqual({
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
      totalTokens: 105
    });
  });

  it("is idempotent over already-normalized usage", () => {
    const normalized = normalizeUsage({
      input_tokens: 1000,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 2000,
      output_tokens: 500
    });

    expect(normalizeUsage(normalized)).toEqual(normalized);
  });
});
