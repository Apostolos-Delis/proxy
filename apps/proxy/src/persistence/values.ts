import type { ModelCatalog } from "../catalog.js";
import type { JsonObject } from "../types.js";
import { isRecord } from "../util.js";

export type NormalizedUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export function normalizeUsage(usage: Record<string, unknown>): NormalizedUsage {
  const inputDetails = recordValue(usage.input_tokens_details) ?? {};
  const outputDetails = recordValue(usage.output_tokens_details) ?? {};
  const inputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens) ?? 0;
  const outputTokens = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens) ?? 0;
  const cachedInputTokens =
    numberValue(inputDetails.cached_tokens) ??
    numberValue(usage.cache_read_input_tokens) ??
    numberValue(usage.cachedInputTokens) ??
    0;
  const reasoningTokens =
    numberValue(outputDetails.reasoning_tokens) ??
    numberValue(usage.reasoningTokens) ??
    0;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: numberValue(usage.total_tokens) ?? numberValue(usage.totalTokens) ?? inputTokens + outputTokens
  };
}

export function usageCostMicros(catalog: ModelCatalog, model: string, usage: NormalizedUsage) {
  const entry = Object.values(catalog).find((candidate) => candidate.upstreamModel === model);
  if (!entry) {
    return {
      inputCostMicros: 0,
      outputCostMicros: 0,
      totalCostMicros: 0
    };
  }
  const inputCostMicros = Math.round(usage.inputTokens * entry.inputCostPerMtok);
  const outputCostMicros = Math.round(usage.outputTokens * entry.outputCostPerMtok);
  return {
    inputCostMicros,
    outputCostMicros,
    totalCostMicros: inputCostMicros + outputCostMicros
  };
}

export function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function recordValue(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value as JsonObject : undefined;
}

export function recordArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) as Record<string, unknown>[] : [];
}

export function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function basisPoints(value: unknown) {
  const number = numberValue(value);
  return number === undefined ? undefined : Math.round(number * 10_000);
}

export function routeValue(value: unknown) {
  if (value === "fast" || value === "balanced" || value === "hard" || value === "deep") return value;
  return undefined;
}

export function surfaceValue(value: unknown) {
  if (value === "openai-responses" || value === "anthropic-messages") return value;
  return undefined;
}

export function providerValue(value: unknown) {
  if (value === "openai" || value === "anthropic") return value;
  return undefined;
}
