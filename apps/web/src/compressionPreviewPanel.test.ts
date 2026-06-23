import { describe, expect, it } from "vitest";

import { measureOnlyRuleWarnings } from "./compressionPreviewPanel";

type CompressionPolicy = Parameters<typeof measureOnlyRuleWarnings>[0];

function policy(mode: CompressionPolicy["mode"], enabledRules: string[]): CompressionPolicy {
  return {
    mode,
    minOriginalBytes: 512,
    minSavingsTokens: 0,
    enabledRules,
    storeOriginalArtifact: false,
    storeCompressedArtifact: false
  };
}

describe("measureOnlyRuleWarnings", () => {
  it("names enabled M4 rules while compression is enabled", () => {
    expect(measureOnlyRuleWarnings(policy("compress_lossless", [
      "mcp-json-whitespace",
      "search-result-grouping",
      "diff-compaction",
      "log-output-compaction",
      "json-array-compaction"
    ]))).toEqual([
      "search result grouping",
      "diff compaction",
      "log output compaction",
      "JSON array compaction"
    ]);
  });

  it("does not warn when compression is disabled or only lossless rules are selected", () => {
    expect(measureOnlyRuleWarnings(policy("disabled", ["search-result-grouping"]))).toEqual([]);
    expect(measureOnlyRuleWarnings(policy("compress_lossless", ["mcp-json-whitespace", "json-whitespace"]))).toEqual([]);
  });
});
