import { describe, expect, it } from "vitest";

import { compressionReceiptSummary } from "./promptEventTimeline";
import type { CompressionReceipt } from "./promptDetailData";

describe("compressionReceiptSummary", () => {
  it("separates provider rewrites from measurement-only and skipped receipts", () => {
    expect(compressionReceiptSummary([
      receipt({
        id: "receipt_compressed",
        mode: "compress_lossless",
        status: "applied",
        originalBytes: 1_000,
        compressedBytes: 400,
        savedBytes: 600,
        savedTokens: 150
      }),
      receipt({
        id: "receipt_measured",
        mode: "measure_only",
        status: "applied",
        originalBytes: 900,
        compressedBytes: 450,
        savedBytes: 450,
        savedTokens: 112
      }),
      receipt({
        id: "receipt_skipped",
        mode: "compress_lossless",
        status: "skipped",
        originalBytes: 700,
        compressedBytes: 700,
        savedBytes: 0,
        savedTokens: 0
      })
    ])).toEqual({
      compressedCount: 1,
      measuredCount: 1,
      skippedCount: 1,
      providerCompressedCount: 1,
      providerOriginalCount: 2,
      actualOriginalBytes: 1_000,
      actualSavedBytes: 600,
      actualSavedTokens: 150,
      measuredOriginalBytes: 900,
      measuredSavedBytes: 450,
      measuredSavedTokens: 112
    });
  });
});

function receipt(overrides: Partial<CompressionReceipt>): CompressionReceipt {
  return {
    id: "receipt",
    mode: "compress_lossless",
    surface: "anthropic-messages",
    blockPath: "$.messages[2].content[0]",
    toolName: "mcp__linear__list_issues",
    command: null,
    commandClass: null,
    ruleId: "json-whitespace",
    ruleVersion: 1,
    status: "applied",
    skipReason: null,
    retrievalId: null,
    retrievalAvailable: false,
    retrievalMarker: null,
    originalBytes: 0,
    compressedBytes: 0,
    savedBytes: 0,
    originalTokenEstimate: 0,
    compressedTokenEstimate: 0,
    savedTokens: 0,
    estimateSource: "heuristic",
    originalSha256: "original",
    compressedSha256: "compressed",
    originalArtifactId: null,
    compressedArtifactId: null,
    originalArtifactExpiresAt: null,
    compressedArtifactExpiresAt: null,
    ...overrides
  };
}
