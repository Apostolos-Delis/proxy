import { providerAttempts, usageLedger } from "@proxy/db";

type ProviderAttemptRow = typeof providerAttempts.$inferSelect;
type UsageLedgerRow = typeof usageLedger.$inferSelect;

export type UsageAggregate = ReturnType<typeof emptyUsageAggregate>;

export function latestAttemptsByRequest(attempts: ProviderAttemptRow[]) {
  const latest = new Map<string, ProviderAttemptRow>();
  const sorted = [...attempts].sort((left, right) =>
    timestamp(right.startedAt) - timestamp(left.startedAt)
  );
  for (const attempt of sorted) {
    if (!latest.has(attempt.requestId)) latest.set(attempt.requestId, attempt);
  }
  return latest;
}

export function attemptCounts(attempts: ProviderAttemptRow[]) {
  const counts = new Map<string, number>();
  for (const attempt of attempts) {
    counts.set(attempt.requestId, (counts.get(attempt.requestId) ?? 0) + 1);
  }
  return counts;
}

export function aggregateUsageByRequest(usageRows: UsageLedgerRow[]) {
  const byRequest = new Map<string, UsageAggregate>();
  for (const row of usageRows) {
    const usage = byRequest.get(row.requestId) ?? emptyUsageAggregate();
    addUsageRow(usage, row);
    byRequest.set(row.requestId, usage);
  }
  return byRequest;
}

export function classifierCostByRequestId(classifierUsageRows: UsageLedgerRow[]) {
  const byRequest = new Map<string, number>();
  for (const row of classifierUsageRows) {
    byRequest.set(row.requestId, (byRequest.get(row.requestId) ?? 0) + row.totalCostMicros / 1_000_000);
  }
  return byRequest;
}

export function usageAggregateForRow(row: UsageLedgerRow) {
  const usage = emptyUsageAggregate();
  addUsageRow(usage, row);
  return usage;
}

function addUsageRow(usage: UsageAggregate, row: UsageLedgerRow) {
  usage.inputTokens += row.inputTokens;
  usage.cachedInputTokens += row.cachedInputTokens;
  usage.cacheCreationInputTokens += row.cacheCreationInputTokens;
  usage.outputTokens += row.outputTokens;
  usage.reasoningTokens += row.reasoningTokens;
  usage.totalTokens += row.totalTokens;
  usage.totalCostMicros += row.totalCostMicros;
}

function emptyUsageAggregate() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalCostMicros: 0
  };
}

function timestamp(value: Date | null | undefined) {
  return value?.getTime() ?? 0;
}
