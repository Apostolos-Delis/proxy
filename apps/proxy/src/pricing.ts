import type { Dialect, Provider, Surface } from "./types.js";
import { unreachable } from "./util.js";

export type ModelPricing = {
  readonly inputCostPerMtok: number;
  readonly outputCostPerMtok: number;
  readonly cacheReadCostPerMtok: number;
  readonly cacheWriteCostPerMtok: number;
};

export type ModelPricingInput = {
  inputCostPerMtok?: number;
  outputCostPerMtok?: number;
  cacheReadCostPerMtok?: number;
  cacheWriteCostPerMtok?: number;
};

export type ModelPricingTable = Readonly<Record<string, ModelPricing>>;

export type UsageTokens = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
};

// Published provider rates: cache reads bill at ~10% of input and Anthropic
// bills 5-minute cache writes at 1.25x input. Used when a pricing entry does
// not set the cache rates explicitly.
const CACHE_READ_INPUT_FRACTION = 0.1;
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;

export type CostBaseline = Readonly<Record<Dialect, string>>;

export const defaultCostBaseline: CostBaseline = Object.freeze({
  "anthropic-messages": "claude-fable-5",
  "openai-responses": "gpt-5.5",
  "openai-chat": "gpt-5.5",
  "bedrock-converse": "amazon.nova-pro-v1:0"
});

export function baselineModelForSurface(baseline: CostBaseline, surface: Surface) {
  switch (surface) {
    case "openai-responses":
      return baseline["openai-responses"];
    case "openai-chat":
      return baseline["openai-chat"];
    case "anthropic-messages":
      return baseline["anthropic-messages"];
    default:
      return unreachable(surface);
  }
}

export function baselineModelForDialect(baseline: CostBaseline, dialect: Dialect) {
  return baseline[dialect] ?? baseline["openai-responses"];
}

export function providerForDialect(dialect: Dialect): Provider {
  switch (dialect) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
    case "openai-chat":
      return "openai";
    case "bedrock-converse":
      return "amazon-bedrock";
    default:
      return unreachable(dialect);
  }
}

export function completeModelPricing(input: ModelPricingInput): ModelPricing {
  const inputCostPerMtok = input.inputCostPerMtok ?? 0;
  return {
    inputCostPerMtok,
    outputCostPerMtok: input.outputCostPerMtok ?? 0,
    cacheReadCostPerMtok: input.cacheReadCostPerMtok ?? roundMicroRate(inputCostPerMtok * CACHE_READ_INPUT_FRACTION),
    cacheWriteCostPerMtok: input.cacheWriteCostPerMtok ?? roundMicroRate(inputCostPerMtok * CACHE_WRITE_INPUT_MULTIPLIER)
  };
}

// Keeps derived cache rates on clean per-MTok values (1e-6 dollar precision)
// instead of float artifacts like 0.30000000000000004.
function roundMicroRate(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function buildModelPricingTable(envCosts: Record<string, ModelPricingInput>): ModelPricingTable {
  const table: Record<string, ModelPricing> = {};
  for (const [model, entry] of Object.entries(envCosts)) {
    table[model] = completeModelPricing(entry);
  }
  return Object.freeze(table);
}

// Models are often referenced by dated identifiers (claude-sonnet-4-5-20250929,
// gpt-5-nano-2025-08-07); pricing falls back to the undated entry.
export function undatedModel(model: string) {
  return model.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
}

export function pricingForModel(table: ModelPricingTable, model: string): ModelPricing | undefined {
  const exact = table[model];
  if (exact) return exact;
  const undated = undatedModel(model);
  return undated === model ? undefined : table[undated];
}

export function providerModelPricingKey(provider: string, model: string) {
  return `${provider}:${model}`;
}

export function pricingForProviderModel(
  table: ModelPricingTable,
  provider: string,
  model: string
): ModelPricing | undefined {
  const exact = table[providerModelPricingKey(provider, model)];
  if (exact) return exact;
  const undated = undatedModel(model);
  return undated === model ? undefined : table[providerModelPricingKey(provider, undated)];
}

export type ModelPricingSource = "default" | "env" | "custom" | "unpriced";

export type ModelPricingEntry = {
  model: string;
  provider: string | null;
  source: ModelPricingSource;
  seenInTraffic: boolean;
  inputCostPerMtok: number | null;
  outputCostPerMtok: number | null;
  cacheReadCostPerMtok: number | null;
  cacheWriteCostPerMtok: number | null;
  updatedAt: string | null;
};

export function applyPricingToEntry(
  entry: ModelPricingEntry,
  pricing: ModelPricing,
  source: Exclude<ModelPricingSource, "unpriced">
) {
  entry.source = source;
  entry.inputCostPerMtok = pricing.inputCostPerMtok;
  entry.outputCostPerMtok = pricing.outputCostPerMtok;
  entry.cacheReadCostPerMtok = pricing.cacheReadCostPerMtok;
  entry.cacheWriteCostPerMtok = pricing.cacheWriteCostPerMtok;
}

export function emptyPricingEntry(model: string, provider: string | null): ModelPricingEntry {
  return {
    model,
    provider,
    source: "unpriced",
    seenInTraffic: false,
    inputCostPerMtok: null,
    outputCostPerMtok: null,
    cacheReadCostPerMtok: null,
    cacheWriteCostPerMtok: null,
    updatedAt: null
  };
}

export function staticPricingEntries(table: ModelPricingTable, envModels: string[]): ModelPricingEntry[] {
  const envModelSet = new Set(envModels);
  return Object.entries(table).map(([model, pricing]) => {
    const entry = emptyPricingEntry(model, null);
    applyPricingToEntry(entry, pricing, envModelSet.has(model) ? "env" : "default");
    return entry;
  });
}

const PRICING_SOURCE_ORDER: Record<ModelPricingSource, number> = {
  unpriced: 0,
  custom: 1,
  env: 2,
  default: 3
};

/** Unpriced traffic first — it is the actionable row — then overrides, then config. */
export function compareModelPricingEntries(left: ModelPricingEntry, right: ModelPricingEntry) {
  const leftSeen = left.seenInTraffic ? 0 : 1;
  const rightSeen = right.seenInTraffic ? 0 : 1;
  return (PRICING_SOURCE_ORDER[left.source] - PRICING_SOURCE_ORDER[right.source]) ||
    (leftSeen - rightSeen) ||
    left.model.localeCompare(right.model);
}

export function usageCostMicros(pricing: ModelPricing | undefined, usage: UsageTokens) {
  if (!pricing) {
    return {
      inputCostMicros: 0,
      outputCostMicros: 0,
      totalCostMicros: 0
    };
  }
  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheCreationInputTokens
  );
  const inputCostMicros = Math.round(
    uncachedInputTokens * pricing.inputCostPerMtok +
    usage.cachedInputTokens * pricing.cacheReadCostPerMtok +
    usage.cacheCreationInputTokens * pricing.cacheWriteCostPerMtok
  );
  const outputCostMicros = Math.round(usage.outputTokens * pricing.outputCostPerMtok);
  return {
    inputCostMicros,
    outputCostMicros,
    totalCostMicros: inputCostMicros + outputCostMicros
  };
}
