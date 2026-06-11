import type { JsonObject, RoutingConfigSnapshot } from "../types.js";
import { isRecord } from "../util.js";

export type NormalizedUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

// Normalized convention: inputTokens is the TOTAL input presented to the
// model, with cachedInputTokens (cache reads) and cacheCreationInputTokens
// (cache writes) as billed-differently subsets. OpenAI already reports
// input_tokens inclusive of input_tokens_details.cached_tokens, but Anthropic
// reports input_tokens EXCLUSIVE of its top-level cache_read_input_tokens and
// cache_creation_input_tokens — those are folded back in here. Anthropic's
// shape is detected by its top-level cache keys, so re-normalizing an
// already-normalized (camelCase) object stays a no-op.
export function normalizeUsage(usage: Record<string, unknown>): NormalizedUsage {
  const inputDetails = recordValue(usage.input_tokens_details) ?? {};
  const outputDetails = recordValue(usage.output_tokens_details) ?? {};
  const anthropicCacheReadTokens = numberValue(usage.cache_read_input_tokens);
  const anthropicCacheCreationTokens = numberValue(usage.cache_creation_input_tokens);
  const exclusiveInputShape =
    anthropicCacheReadTokens !== undefined || anthropicCacheCreationTokens !== undefined;

  const reportedInputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens) ?? 0;
  const outputTokens = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens) ?? 0;
  const cachedInputTokens =
    numberValue(inputDetails.cached_tokens) ??
    anthropicCacheReadTokens ??
    numberValue(usage.cachedInputTokens) ??
    0;
  const cacheCreationInputTokens =
    anthropicCacheCreationTokens ??
    numberValue(usage.cacheCreationInputTokens) ??
    0;
  const inputTokens = exclusiveInputShape
    ? reportedInputTokens + (anthropicCacheReadTokens ?? 0) + (anthropicCacheCreationTokens ?? 0)
    : reportedInputTokens;
  const reasoningTokens =
    numberValue(outputDetails.reasoning_tokens) ??
    numberValue(usage.reasoningTokens) ??
    0;
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: exclusiveInputShape
      ? inputTokens + outputTokens
      : numberValue(usage.total_tokens) ?? numberValue(usage.totalTokens) ?? inputTokens + outputTokens
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

export function requestStatusValue(value: unknown) {
  if (
    value === "received" ||
    value === "classifying" ||
    value === "provider_pending" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) return value;
  return undefined;
}

export function routingConfigSnapshotValue(value: unknown): RoutingConfigSnapshot | undefined {
  const record = recordValue(value);
  const configId = stringValue(record?.configId);
  const configName = stringValue(record?.configName);
  const versionId = stringValue(record?.versionId);
  const version = numberValue(record?.version);
  const configHash = stringValue(record?.configHash);
  if (!configId || !configName || !versionId || version === undefined || !configHash) return undefined;
  return {
    configId,
    configName,
    versionId,
    version,
    configHash
  };
}
