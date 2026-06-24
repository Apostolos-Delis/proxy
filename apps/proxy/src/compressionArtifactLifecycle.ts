import type { CompressionPolicy } from "@proxy/schema";

import {
  contentBytes,
  contentChars,
  contentSha256,
  ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE
} from "./compressionContent.js";
import {
  compressionRetrievalId,
  compressionRetrievalMarker
} from "./compressionRetrievalIds.js";
import type { CompressionRecord } from "./toolResultCompression.js";
import type { Surface } from "./types.js";
import { isRecord, roughTokenEstimate } from "./util.js";

type CompressionRecordSnapshot = Pick<
  CompressionRecord,
  | "compressedContentHash"
  | "afterBytes"
  | "afterChars"
  | "afterEstimatedTokens"
  | "compressedTokenEstimate"
  | "savedEstimatedTokens"
  | "savedTokens"
  | "estimateSource"
  | "compressedArtifactId"
  | "retrievalAvailable"
  | "retrievalId"
  | "retrievalMarker"
>;

export type CompressionArtifactStore = {
  captureCompressionArtifact(input: {
    organizationId: string;
    workspaceId: string;
    requestId: string;
    surface: Surface;
    kind: "compression_original_tool_result" | "compression_compressed_tool_result";
    content: unknown;
    blockPath: string;
    toolName: string;
    ruleId: string;
    ruleVersion: number;
    status: CompressionRecord["status"];
  }): Promise<{ id: string } | undefined>;
};

export async function attachOriginalCompressionArtifacts(input: {
  artifactStore?: CompressionArtifactStore;
  tenantId: string;
  workspaceId: string;
  requestId: string;
  surface: Surface;
  policy: CompressionPolicy;
  originalBody: unknown;
  records: CompressionRecord[];
  warn: (error: unknown, message: string) => void;
}) {
  if (!input.artifactStore) return;
  if (!input.policy.storeOriginalArtifact) return;
  for (const record of input.records) {
    if (record.status === "skipped") continue;
    const originalContent = contentAtBlockPath(input.surface, input.originalBody, record.blockPath);
    try {
      const artifact = await input.artifactStore.captureCompressionArtifact({
        organizationId: input.tenantId,
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        surface: input.surface,
        kind: "compression_original_tool_result",
        content: originalContent,
        blockPath: record.blockPath,
        toolName: record.tool,
        ruleId: record.rule,
        ruleVersion: record.ruleVersion,
        status: record.status
      });
      if (artifact) {
        record.originalArtifactId = artifact.id;
        if (compressionPolicyCanRetrieveOriginal(input.policy)) {
          record.retrievalId = compressionRetrievalId({
            requestId: input.requestId,
            blockPath: record.blockPath,
            ruleId: record.rule,
            originalSha256: record.originalContentHash
          });
          record.retrievalAvailable = true;
          record.retrievalMarker = compressionRetrievalMarker({
            retrievalId: record.retrievalId,
            originalSha256: record.originalContentHash
          });
        }
      }
    } catch (error) {
      input.warn(error, "compression artifact capture failed");
    }
  }
}

export async function attachCompressedCompressionArtifacts(input: {
  artifactStore?: CompressionArtifactStore;
  tenantId: string;
  workspaceId: string;
  requestId: string;
  surface: Surface;
  policy: CompressionPolicy;
  transformedBody: unknown;
  records: CompressionRecord[];
  warn: (error: unknown, message: string) => void;
}) {
  if (!input.artifactStore) return;
  if (!input.policy.storeCompressedArtifact) return;
  for (const record of input.records) {
    if (record.status === "skipped") continue;
    const compressedContent = contentAtBlockPath(input.surface, input.transformedBody, record.blockPath);
    try {
      const artifact = await input.artifactStore.captureCompressionArtifact({
        organizationId: input.tenantId,
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        surface: input.surface,
        kind: "compression_compressed_tool_result",
        content: compressedContent,
        blockPath: record.blockPath,
        toolName: record.tool,
        ruleId: record.rule,
        ruleVersion: record.ruleVersion,
        status: record.status
      });
      if (artifact) record.compressedArtifactId = artifact.id;
    } catch (error) {
      input.warn(error, "compression artifact capture failed");
    }
  }
}

export function applyRetrievalMarkers(surface: Surface, body: unknown, records: CompressionRecord[]) {
  let nextBody = body;
  for (const record of records) {
    if (record.status !== "applied" || !record.retrievalMarker) continue;
    const marker = record.retrievalMarker;
    const updated = replaceContentAtBlockPath(surface, nextBody, record.blockPath, (content) =>
      markedContent(content, marker)
    );
    if (updated === undefined) {
      delete record.retrievalAvailable;
      delete record.retrievalId;
      delete record.retrievalMarker;
      continue;
    }
    if (contentChars(updated.content) >= record.beforeChars) {
      delete record.retrievalAvailable;
      delete record.retrievalId;
      delete record.retrievalMarker;
      continue;
    }
    nextBody = updated.body;
    updateCompressedRecordStats(record, updated.content);
  }
  return nextBody;
}

export function snapshotCompressionRecords(records: CompressionRecord[]): CompressionRecordSnapshot[] {
  return records.map((record) => ({
    compressedContentHash: record.compressedContentHash,
    afterBytes: record.afterBytes,
    afterChars: record.afterChars,
    afterEstimatedTokens: record.afterEstimatedTokens,
    compressedTokenEstimate: record.compressedTokenEstimate,
    savedEstimatedTokens: record.savedEstimatedTokens,
    savedTokens: record.savedTokens,
    estimateSource: record.estimateSource,
    compressedArtifactId: record.compressedArtifactId,
    retrievalAvailable: record.retrievalAvailable,
    retrievalId: record.retrievalId,
    retrievalMarker: record.retrievalMarker
  }));
}

export function restoreCompressionRecords(records: CompressionRecord[], snapshots: CompressionRecordSnapshot[]) {
  for (const [index, snapshot] of snapshots.entries()) {
    const record = records[index];
    if (!record) continue;
    Object.assign(record, snapshot);
    if (snapshot.compressedArtifactId === undefined) delete record.compressedArtifactId;
    if (snapshot.retrievalAvailable === undefined) delete record.retrievalAvailable;
    if (snapshot.retrievalId === undefined) delete record.retrievalId;
    if (snapshot.retrievalMarker === undefined) delete record.retrievalMarker;
  }
}

export function clearRetrievalMarkerMetadata(records: CompressionRecord[]) {
  for (const record of records) {
    delete record.retrievalAvailable;
    delete record.retrievalId;
    delete record.retrievalMarker;
  }
}

function compressionPolicyCanRetrieveOriginal(policy: CompressionPolicy) {
  return policy.mode === "measure_only" || policy.mode === "compress_lossless" || policy.mode === "compress_explicit_lossy";
}

function markedContent(content: unknown, marker: string) {
  if (typeof content !== "string") return undefined;
  return `${content}\n\n${marker}`;
}

function replaceContentAtBlockPath(
  surface: Surface,
  body: unknown,
  blockPath: string,
  replace: (content: unknown) => unknown
) {
  return replaceAtPath(body, blockPath.split("."), (block) => {
    if (!isRecord(block)) return undefined;
    const key = contentKeyForSurface(surface);
    const nextContent = replace(block[key]);
    if (nextContent === undefined) return undefined;
    return { block: { ...block, [key]: nextContent }, content: nextContent };
  });
}

function replaceAtPath(
  value: unknown,
  path: string[],
  replace: (value: unknown) => { block: unknown; content: unknown } | undefined
): { body: unknown; content: unknown } | undefined {
  if (path.length === 0) {
    const replaced = replace(value);
    return replaced ? { body: replaced.block, content: replaced.content } : undefined;
  }
  const [part, ...rest] = path;
  if (part === undefined) return undefined;
  if (Array.isArray(value)) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) return undefined;
    const replaced = replaceAtPath(value[index], rest, replace);
    if (!replaced) return undefined;
    const next = [...value];
    next[index] = replaced.body;
    return { body: next, content: replaced.content };
  }
  if (!isRecord(value) || part === undefined) return undefined;
  const replaced = replaceAtPath(value[part], rest, replace);
  if (!replaced) return undefined;
  return { body: { ...value, [part]: replaced.body }, content: replaced.content };
}

function contentKeyForSurface(surface: Surface) {
  if (surface === "openai-responses") return "output";
  return "content";
}

function updateCompressedRecordStats(record: CompressionRecord, content: unknown) {
  const afterChars = contentChars(content);
  const afterTokens = roughTokenEstimate(afterChars);
  record.compressedContentHash = contentSha256(content);
  record.afterBytes = contentBytes(content);
  record.afterChars = afterChars;
  record.afterEstimatedTokens = afterTokens;
  record.compressedTokenEstimate = afterTokens;
  record.savedEstimatedTokens = record.beforeEstimatedTokens - afterTokens;
  record.savedTokens = record.savedEstimatedTokens;
  record.estimateSource = ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE;
}

function contentAtBlockPath(surface: Surface, body: unknown, blockPath: string) {
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
