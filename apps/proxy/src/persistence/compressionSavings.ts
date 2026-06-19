import { numberValue, recordArray, recordValue, stringValue } from "./values.js";

export const COMPRESSION_SAVINGS_SAMPLE_CAP = 10_000;

export type CompressionSavingsRow = {
  rule: string;
  ruleVersion: number;
  tool: string;
  commandClass: string;
  blocks: number;
  beforeChars: number;
  afterChars: number;
  savedChars: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  savedEstimatedTokens: number;
  estimateSource: string;
};

export type CompressionReceiptSavingsInput = {
  eventId: string;
  status: string;
  ruleId: string;
  ruleVersion: number;
  toolName: string;
  commandClass: string | null;
  originalChars: number;
  compressedChars: number;
  savedChars: number;
  originalEstimatedTokens: number;
  compressedEstimatedTokens: number;
  savedEstimatedTokens: number;
  estimateSource: string;
};

export function aggregateCompressionSavings(payloads: unknown[], sampled: boolean) {
  const rows = new Map<string, CompressionSavingsRow>();
  for (const payload of payloads) {
    const record = recordValue(payload);
    if (!record) continue;
    for (const item of recordArray(record.byRule)) {
      const beforeChars = numberValue(item.beforeChars) ?? 0;
      const afterChars = numberValue(item.afterChars) ?? 0;
      const beforeEstimatedTokens = numberValue(item.originalTokenEstimate) ?? numberValue(item.beforeEstimatedTokens) ?? 0;
      const afterEstimatedTokens = numberValue(item.compressedTokenEstimate) ?? numberValue(item.afterEstimatedTokens) ?? 0;
      addCompressionSavingsRow(rows, {
        rule: stringValue(item.rule) ?? "unknown",
        ruleVersion: numberValue(item.ruleVersion) ?? 0,
        tool: stringValue(item.tool) ?? "unknown",
        commandClass: stringValue(item.commandClass) ?? "unknown",
        estimateSource: stringValue(item.estimateSource) ?? stringValue(record.estimateSource) ?? "unknown",
        beforeChars,
        afterChars,
        savedChars: numberValue(item.savedChars) ?? beforeChars - afterChars,
        beforeEstimatedTokens,
        afterEstimatedTokens,
        savedEstimatedTokens: numberValue(item.savedTokens) ?? numberValue(item.savedEstimatedTokens) ?? beforeEstimatedTokens - afterEstimatedTokens
      });
    }
  }
  return compressionSavingsReport([...rows.values()], payloads.length, sampled);
}

export function aggregateCompressionReceiptSavings(receipts: CompressionReceiptSavingsInput[], sampled: boolean) {
  const rows = new Map<string, CompressionSavingsRow>();
  const appliedEventIds = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.status !== "applied") continue;
    appliedEventIds.add(receipt.eventId);
    addCompressionSavingsRow(rows, {
      rule: receipt.ruleId,
      ruleVersion: receipt.ruleVersion,
      tool: receipt.toolName,
      commandClass: receipt.commandClass ?? "unknown",
      estimateSource: receipt.estimateSource,
      beforeChars: receipt.originalChars,
      afterChars: receipt.compressedChars,
      savedChars: receipt.savedChars,
      beforeEstimatedTokens: receipt.originalEstimatedTokens,
      afterEstimatedTokens: receipt.compressedEstimatedTokens,
      savedEstimatedTokens: receipt.savedEstimatedTokens
    });
  }
  return compressionSavingsReport([...rows.values()], appliedEventIds.size, sampled);
}

function addCompressionSavingsRow(
  rows: Map<string, CompressionSavingsRow>,
  input: Omit<CompressionSavingsRow, "blocks">
) {
  const key = `${input.rule}\0${input.ruleVersion}\0${input.tool}\0${input.commandClass}\0${input.estimateSource}`;
  const row = rows.get(key) ?? {
    rule: input.rule,
    ruleVersion: input.ruleVersion,
    tool: input.tool,
    commandClass: input.commandClass,
    blocks: 0,
    beforeChars: 0,
    afterChars: 0,
    savedChars: 0,
    beforeEstimatedTokens: 0,
    afterEstimatedTokens: 0,
    savedEstimatedTokens: 0,
    estimateSource: input.estimateSource
  };
  row.blocks += 1;
  row.beforeChars += input.beforeChars;
  row.afterChars += input.afterChars;
  row.savedChars += input.savedChars;
  row.beforeEstimatedTokens += input.beforeEstimatedTokens;
  row.afterEstimatedTokens += input.afterEstimatedTokens;
  row.savedEstimatedTokens += input.savedEstimatedTokens;
  rows.set(key, row);
}

function compressionSavingsReport(rows: CompressionSavingsRow[], eventCount: number, sampled: boolean) {
  const data = [...rows.values()].sort((left, right) =>
    right.savedEstimatedTokens - left.savedEstimatedTokens ||
    right.savedChars - left.savedChars ||
    left.rule.localeCompare(right.rule) ||
    left.tool.localeCompare(right.tool) ||
    left.commandClass.localeCompare(right.commandClass)
  );
  const totals = data.reduce((acc, row) => {
    acc.blocks += row.blocks;
    acc.beforeChars += row.beforeChars;
    acc.afterChars += row.afterChars;
    acc.savedChars += row.savedChars;
    acc.beforeEstimatedTokens += row.beforeEstimatedTokens;
    acc.afterEstimatedTokens += row.afterEstimatedTokens;
    acc.savedEstimatedTokens += row.savedEstimatedTokens;
    return acc;
  }, emptyCompressionSavingsTotals());

  return {
    eventCount,
    sampled,
    ...totals,
    estimateSource: aggregateEstimateSource(data),
    rows: data
  };
}

function aggregateEstimateSource(rows: CompressionSavingsRow[]) {
  const sources = new Set(rows.map((row) => row.estimateSource));
  if (sources.size === 0) return "unknown";
  return sources.size === 1 ? rows[0].estimateSource : "mixed";
}

function emptyCompressionSavingsTotals() {
  return {
    blocks: 0,
    beforeChars: 0,
    afterChars: 0,
    savedChars: 0,
    beforeEstimatedTokens: 0,
    afterEstimatedTokens: 0,
    savedEstimatedTokens: 0
  };
}
