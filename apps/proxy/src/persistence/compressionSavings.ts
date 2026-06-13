import { numberValue, recordArray, recordValue, stringValue } from "./values.js";

export const COMPRESSION_SAVINGS_SAMPLE_CAP = 10_000;

export type CompressionSavingsRow = {
  rule: string;
  ruleVersion: number;
  tool: string;
  blocks: number;
  beforeChars: number;
  afterChars: number;
  savedChars: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  savedEstimatedTokens: number;
};

export function aggregateCompressionSavings(payloads: unknown[], sampled: boolean) {
  const rows = new Map<string, CompressionSavingsRow>();
  for (const payload of payloads) {
    const record = recordValue(payload);
    if (!record) continue;
    for (const item of recordArray(record.byRule)) {
      const rule = stringValue(item.rule) ?? "unknown";
      const ruleVersion = numberValue(item.ruleVersion) ?? 0;
      const tool = stringValue(item.tool) ?? "unknown";
      const key = `${rule}\0${ruleVersion}\0${tool}`;
      const row = rows.get(key) ?? {
        rule,
        ruleVersion,
        tool,
        blocks: 0,
        beforeChars: 0,
        afterChars: 0,
        savedChars: 0,
        beforeEstimatedTokens: 0,
        afterEstimatedTokens: 0,
        savedEstimatedTokens: 0
      };
      const beforeChars = numberValue(item.beforeChars) ?? 0;
      const afterChars = numberValue(item.afterChars) ?? 0;
      const beforeEstimatedTokens = numberValue(item.beforeEstimatedTokens) ?? 0;
      const afterEstimatedTokens = numberValue(item.afterEstimatedTokens) ?? 0;
      row.blocks += 1;
      row.beforeChars += beforeChars;
      row.afterChars += afterChars;
      row.savedChars += numberValue(item.savedChars) ?? beforeChars - afterChars;
      row.beforeEstimatedTokens += beforeEstimatedTokens;
      row.afterEstimatedTokens += afterEstimatedTokens;
      row.savedEstimatedTokens += numberValue(item.savedEstimatedTokens) ?? beforeEstimatedTokens - afterEstimatedTokens;
      rows.set(key, row);
    }
  }

  const data = [...rows.values()].sort((left, right) =>
    right.savedEstimatedTokens - left.savedEstimatedTokens ||
    right.savedChars - left.savedChars ||
    left.rule.localeCompare(right.rule) ||
    left.tool.localeCompare(right.tool)
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
    eventCount: payloads.length,
    sampled,
    ...totals,
    rows: data
  };
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
