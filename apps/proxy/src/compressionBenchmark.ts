import {
  compressToolResults,
  type CompressionOptions,
  type CompressionRecord,
  type CompressionRule
} from "./toolResultCompression.js";
import type { Surface } from "./types.js";

export type CompressionBenchmarkFixture = {
  name: string;
  toolName: string;
  content: string;
  surface?: Surface;
};

export type CompressionBenchmarkRow = {
  rule: string;
  ruleVersion: number;
  samples: number;
  medianSavedTokens: number;
  p95SavedTokens: number;
  totalSavedTokens: number;
};

export function benchmarkCompressionFixtures(
  fixtures: CompressionBenchmarkFixture[],
  rules: CompressionRule[],
  options: CompressionOptions = {}
) {
  const byRule = new Map<string, CompressionRecord[]>();
  for (const fixture of fixtures) {
    const result = compressToolResults(
      fixture.surface ?? "anthropic-messages",
      bodyForFixture(fixture),
      rules,
      options
    );
    for (const record of result.records) {
      const key = `${record.rule}\0${record.ruleVersion}`;
      byRule.set(key, [...(byRule.get(key) ?? []), record]);
    }
  }
  return [...byRule.values()]
    .map((records) => benchmarkRow(records))
    .sort((left, right) =>
      right.medianSavedTokens - left.medianSavedTokens ||
      right.p95SavedTokens - left.p95SavedTokens ||
      left.rule.localeCompare(right.rule)
    );
}

function bodyForFixture(fixture: CompressionBenchmarkFixture) {
  return {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: fixture.toolName, input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: fixture.content }] }
    ]
  };
}

function benchmarkRow(records: CompressionRecord[]): CompressionBenchmarkRow {
  const sorted = records.map((record) => record.savedTokens).sort((left, right) => left - right);
  const first = records[0];
  return {
    rule: first.rule,
    ruleVersion: first.ruleVersion,
    samples: records.length,
    medianSavedTokens: percentile(sorted, 0.5),
    p95SavedTokens: percentile(sorted, 0.95),
    totalSavedTokens: sorted.reduce((sum, value) => sum + value, 0)
  };
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}
