import {
  compressionPolicySchema,
  defaultCompressionPolicy,
  type CompressionPolicy
} from "@prompt-proxy/schema";

import {
  compressToolResults,
  compressionRulesForPolicy,
  type CompressionRecord
} from "./toolResultCompression.js";
import type { Surface } from "./types.js";
import { isRecord, stableJson } from "./util.js";

export type CompressionPreviewDiffSegment = {
  side: "original" | "compressed";
  text: string;
};

export type CompressionPreviewBlock = {
  blockPath: string;
  toolName: string;
  command: string | null;
  commandClass: string | null;
  ruleId: string;
  ruleVersion: number;
  status: string;
  skipReason: string | null;
  retrievalId: string | null;
  retrievalAvailable: boolean;
  retrievalMarker: string | null;
  originalChars: number;
  compressedChars: number;
  savedChars: number;
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  savedTokens: number;
  estimateSource: string;
  originalSha256: string;
  compressedSha256: string;
  diffSegments: CompressionPreviewDiffSegment[];
};

type CompressionPreviewReceiptBlock = CompressionPreviewBlock & { surface: Surface | null };

export type CompressionPreview = {
  source: "sample" | "request";
  surface: Surface | null;
  contentAvailable: boolean;
  contentRedactionReason: string | null;
  blocks: number;
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  savedTokens: number;
  previewBlocks: CompressionPreviewBlock[];
};

export function previewCompressionSample(input: {
  surface: Surface;
  body: unknown;
  policy?: unknown;
  contentAllowed: boolean;
  contentRedactionReason: string | null;
}): CompressionPreview {
  const policy = previewPolicy(input.policy);
  const rules = compressionRulesForPolicy(policy);
  const options = {
    minOriginalBytes: policy.minOriginalBytes,
    minSavingsTokens: policy.minSavingsTokens,
    measureOnly: true,
    recordSkips: true
  };
  const measured = compressToolResults(input.surface, input.body, rules, options);
  const compressed = compressToolResults(input.surface, input.body, rules, {
    ...options,
    measureOnly: false,
    recordSkips: false
  });
  const previewBlocks = measured.records.map((record) =>
    previewBlock(record, input.surface, input.body, compressed.body, input.contentAllowed)
  );
  return previewReport({
    source: "sample",
    surface: input.surface,
    contentAvailable: input.contentAllowed,
    contentRedactionReason: input.contentAllowed ? null : input.contentRedactionReason,
    previewBlocks
  });
}

export function previewCompressionReceipts(input: {
  blocks: CompressionPreviewReceiptBlock[];
  contentRedactionReason: string;
}): CompressionPreview {
  return previewReport({
    source: "request",
    surface: input.blocks[0]?.surface ?? null,
    contentAvailable: false,
    contentRedactionReason: input.contentRedactionReason,
    previewBlocks: input.blocks
  });
}

export function compressionReceiptPreviewBlock(receipt: {
  surface: string;
  blockPath: string;
  toolName: string;
  command?: string | null;
  commandClass?: string | null;
  ruleId: string;
  ruleVersion: number;
  status: string;
  skipReason?: string | null;
  retrievalId?: string | null;
  retrievalAvailable?: boolean;
  retrievalMarker?: string | null;
  originalChars: number;
  compressedChars: number;
  savedChars: number;
  originalBytes: number;
  compressedBytes: number;
  originalEstimatedTokens: number;
  compressedEstimatedTokens: number;
  savedEstimatedTokens: number;
  estimateSource: string;
  originalSha256: string;
  compressedSha256: string;
}): CompressionPreviewBlock & { surface: Surface | null } {
  return {
    surface: surfaceOrNull(receipt.surface),
    blockPath: receipt.blockPath,
    toolName: receipt.toolName,
    command: receipt.command ?? null,
    commandClass: receipt.commandClass ?? null,
    ruleId: receipt.ruleId,
    ruleVersion: receipt.ruleVersion,
    status: receipt.status,
    skipReason: receipt.skipReason ?? null,
    retrievalId: receipt.retrievalId ?? null,
    retrievalAvailable: receipt.retrievalAvailable === true,
    retrievalMarker: receipt.retrievalMarker ?? null,
    originalChars: receipt.originalChars,
    compressedChars: receipt.compressedChars,
    savedChars: receipt.savedChars,
    originalBytes: receipt.originalBytes,
    compressedBytes: receipt.compressedBytes,
    savedBytes: receipt.originalBytes - receipt.compressedBytes,
    originalTokenEstimate: receipt.originalEstimatedTokens,
    compressedTokenEstimate: receipt.compressedEstimatedTokens,
    savedTokens: receipt.savedEstimatedTokens,
    estimateSource: receipt.estimateSource,
    originalSha256: receipt.originalSha256,
    compressedSha256: receipt.compressedSha256,
    diffSegments: []
  };
}

function previewPolicy(value: unknown): CompressionPolicy {
  const parsed = value === undefined || value === null
    ? defaultCompressionPolicy()
    : { ...defaultCompressionPolicy(), ...compressionPolicySchema.parse(value) };
  return {
    ...parsed,
    mode: parsed.mode === "compress_explicit_lossy" || parsed.mode === "measure_only"
      ? "measure_only"
      : "compress_lossless"
  };
}

function previewBlock(
  record: CompressionRecord,
  surface: Surface,
  originalBody: unknown,
  compressedBody: unknown,
  contentAllowed: boolean
): CompressionPreviewBlock {
  return {
    blockPath: record.blockPath,
    toolName: record.tool,
    command: record.command ?? null,
    commandClass: record.commandClass ?? null,
    ruleId: record.rule,
    ruleVersion: record.ruleVersion,
    status: record.status,
    skipReason: record.skipReason ?? null,
    retrievalId: record.retrievalId ?? null,
    retrievalAvailable: record.retrievalAvailable === true,
    retrievalMarker: record.retrievalMarker ?? null,
    originalChars: record.beforeChars,
    compressedChars: record.afterChars,
    savedChars: record.beforeChars - record.afterChars,
    originalBytes: record.beforeBytes,
    compressedBytes: record.afterBytes,
    savedBytes: record.beforeBytes - record.afterBytes,
    originalTokenEstimate: record.originalTokenEstimate,
    compressedTokenEstimate: record.compressedTokenEstimate,
    savedTokens: record.savedTokens,
    estimateSource: record.estimateSource,
    originalSha256: record.originalContentHash,
    compressedSha256: record.compressedContentHash,
    diffSegments: contentAllowed
      ? diffSegments(
        blockContent(surface, originalBody, record.blockPath),
        blockContent(surface, compressedBody, record.blockPath)
      )
      : []
  };
}

function previewReport(input: {
  source: "sample" | "request";
  surface: Surface | null;
  contentAvailable: boolean;
  contentRedactionReason: string | null;
  previewBlocks: CompressionPreviewBlock[];
}): CompressionPreview {
  const totals = input.previewBlocks.reduce((acc, block) => {
    acc.originalBytes += block.originalBytes;
    acc.compressedBytes += block.compressedBytes;
    acc.savedBytes += block.savedBytes;
    acc.originalTokenEstimate += block.originalTokenEstimate;
    acc.compressedTokenEstimate += block.compressedTokenEstimate;
    acc.savedTokens += block.savedTokens;
    return acc;
  }, {
    originalBytes: 0,
    compressedBytes: 0,
    savedBytes: 0,
    originalTokenEstimate: 0,
    compressedTokenEstimate: 0,
    savedTokens: 0
  });
  return {
    source: input.source,
    surface: input.surface,
    contentAvailable: input.contentAvailable,
    contentRedactionReason: input.contentRedactionReason,
    blocks: input.previewBlocks.length,
    ...totals,
    previewBlocks: input.previewBlocks
  };
}

function diffSegments(original: unknown, compressed: unknown): CompressionPreviewDiffSegment[] {
  return [
    { side: "original", text: previewText(original) },
    { side: "compressed", text: previewText(compressed) }
  ];
}

function previewText(value: unknown) {
  const text = typeof value === "string" ? value : stableJson(value) ?? "null";
  if (text.length <= 800) return text;
  return `${text.slice(0, 380)}\n[...preview truncated...]\n${text.slice(-380)}`;
}

function blockContent(surface: Surface, body: unknown, blockPath: string) {
  const block = valueAtPath(body, blockPath);
  if (!isRecord(block)) return block;
  if (surface === "anthropic-messages") return block.content;
  if (surface === "openai-responses") return block.output;
  if (surface === "openai-chat") return block.content;
  return block;
}

function valueAtPath(value: unknown, path: string) {
  return path.split(".").reduce<unknown>((current, part) => {
    if (Array.isArray(current)) return current[Number(part)];
    if (isRecord(current)) return current[part];
    return undefined;
  }, value);
}

function surfaceOrNull(value: string): Surface | null {
  if (value === "anthropic-messages" || value === "openai-responses" || value === "openai-chat") return value;
  return null;
}
