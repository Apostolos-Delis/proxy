import { and, eq } from "drizzle-orm";

import {
  compressionReceipts,
  promptArtifacts,
  requests,
  type PromptProxyDbSession,
  type PromptProxyTransaction
} from "@prompt-proxy/db";

import type { ProxyEvent } from "../events.js";
import { compressionRetrievalId } from "../compressionRetrievalIds.js";
import { sha256 } from "../util.js";
import { workspaceScope } from "./scope.js";
import { booleanValue, numberValue, recordArray, stringValue } from "./values.js";

export type CompressionRetrievalFailureReason =
  | "not_found"
  | "artifact_missing"
  | "artifact_expired"
  | "artifact_unavailable"
  | "hash_mismatch";

export type CompressionRetrievalInput = {
  organizationId: string;
  workspaceId: string;
  apiKeyId: string;
  retrievalId: string;
  now?: Date;
};

export type CompressionRetrievalMetadata = {
  retrievalId: string;
  receiptId: string;
  requestId: string;
  surface: string;
  blockPath: string;
  toolName: string;
  command: string | null;
  commandClass: string | null;
  ruleId: string;
  ruleVersion: number;
  receiptStatus: string;
  originalSha256: string;
  compressedSha256: string;
  createdAt: string;
};

export type CompressionRetrievalResult =
  | {
    ok: true;
    retrievalId: string;
    content: string;
    metadata: CompressionRetrievalMetadata;
    audit: {
      artifactId: string;
    };
  }
  | {
    ok: false;
    reason: CompressionRetrievalFailureReason;
    metadata?: CompressionRetrievalMetadata;
  };

export async function resolveCompressionRetrieval(
  db: PromptProxyDbSession,
  input: CompressionRetrievalInput
): Promise<CompressionRetrievalResult> {
  const [row] = await db
    .select({
      receipt: {
        id: compressionReceipts.id,
        retrievalId: compressionReceipts.retrievalId,
        requestId: compressionReceipts.requestId,
        surface: compressionReceipts.surface,
        blockPath: compressionReceipts.blockPath,
        toolName: compressionReceipts.toolName,
        command: compressionReceipts.command,
        commandClass: compressionReceipts.commandClass,
        ruleId: compressionReceipts.ruleId,
        ruleVersion: compressionReceipts.ruleVersion,
        status: compressionReceipts.status,
        originalSha256: compressionReceipts.originalSha256,
        compressedSha256: compressionReceipts.compressedSha256,
        originalArtifactId: compressionReceipts.originalArtifactId,
        createdAt: compressionReceipts.createdAt
      },
      artifact: {
        id: promptArtifacts.id,
        storageMode: promptArtifacts.storageMode,
        contentHash: promptArtifacts.contentHash,
        rawText: promptArtifacts.rawText,
        expiresAt: promptArtifacts.expiresAt
      }
    })
    .from(compressionReceipts)
    .leftJoin(
      promptArtifacts,
      and(
        eq(promptArtifacts.id, compressionReceipts.originalArtifactId),
        workspaceScope(promptArtifacts, input.organizationId, input.workspaceId)
      )
    )
    .where(and(
      workspaceScope(compressionReceipts, input.organizationId, input.workspaceId),
      eq(compressionReceipts.apiKeyId, input.apiKeyId),
      eq(compressionReceipts.retrievalId, input.retrievalId)
    ))
    .limit(1);

  if (!row) return { ok: false, reason: "not_found" };
  const metadata = {
    retrievalId: row.receipt.retrievalId ?? input.retrievalId,
    receiptId: row.receipt.id,
    requestId: row.receipt.requestId,
    surface: row.receipt.surface,
    blockPath: row.receipt.blockPath,
    toolName: row.receipt.toolName,
    command: row.receipt.command,
    commandClass: row.receipt.commandClass,
    ruleId: row.receipt.ruleId,
    ruleVersion: row.receipt.ruleVersion,
    receiptStatus: row.receipt.status,
    originalSha256: row.receipt.originalSha256,
    compressedSha256: row.receipt.compressedSha256,
    createdAt: row.receipt.createdAt.toISOString()
  };
  if (!row.receipt.originalArtifactId || !row.artifact?.id) {
    return { ok: false, reason: "artifact_missing", metadata };
  }
  const now = input.now ?? new Date();
  if (row.artifact.expiresAt && row.artifact.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "artifact_expired", metadata };
  }
  if (row.artifact.storageMode !== "raw_text" || row.artifact.rawText === null) {
    return { ok: false, reason: "artifact_unavailable", metadata };
  }
  const contentHash = sha256(row.artifact.rawText);
  if (row.artifact.contentHash !== row.receipt.originalSha256 || contentHash !== row.receipt.originalSha256) {
    return { ok: false, reason: "hash_mismatch", metadata };
  }

  return {
    ok: true,
    retrievalId: metadata.retrievalId,
    content: row.artifact.rawText,
    metadata,
    audit: {
      artifactId: row.receipt.originalArtifactId
    }
  };
}

export class CompressionRetrievalResolver {
  constructor(private readonly db: PromptProxyDbSession) {}

  resolve(input: CompressionRetrievalInput) {
    return resolveCompressionRetrieval(this.db, input);
  }
}

export async function persistCompressionReceipts(tx: PromptProxyTransaction, event: ProxyEvent) {
  const payload = event.payload;
  const records = recordArray(payload.byRule);
  await tx.delete(compressionReceipts).where(eq(compressionReceipts.eventId, event.eventId));
  if (records.length === 0) return;

  const [request] = await tx
    .select({ apiKeyId: requests.apiKeyId })
    .from(requests)
    .where(and(
      eq(requests.id, event.scopeId),
      eq(requests.organizationId, event.tenantId),
      eq(requests.workspaceId, event.workspaceId)
    ))
    .limit(1);
  const mode = stringValue(payload.mode) ?? modeFromEvent(event.eventType);
  const surface = stringValue(payload.surface) ?? "unknown";
  const values = records.flatMap((record, index) => {
    const originalSha256 = stringValue(record.originalContentHash);
    const compressedSha256 = stringValue(record.compressedContentHash);
    if (!originalSha256 || !compressedSha256) return [];
    const blockPath = stringValue(record.blockPath) ?? `block.${index}`;
    const ruleId = stringValue(record.rule) ?? "unknown";
    const retrievalId = stringValue(record.retrievalId) ?? compressionRetrievalId({
      requestId: event.scopeId,
      blockPath,
      ruleId,
      originalSha256
    });
    return [{
      id: `${event.eventId}:compression:${index}`,
      retrievalId,
      organizationId: event.tenantId,
      workspaceId: event.workspaceId,
      requestId: event.scopeId,
      apiKeyId: request?.apiKeyId ?? null,
      mode,
      surface,
      blockPath,
      toolName: stringValue(record.tool) ?? "unknown",
      command: stringValue(record.command) ?? null,
      commandClass: stringValue(record.commandClass) ?? null,
      ruleId,
      ruleVersion: numberValue(record.ruleVersion) ?? 0,
      status: receiptStatus(stringValue(record.status), event.eventType),
      retrievalAvailable: booleanValue(record.retrievalAvailable) ?? false,
      retrievalMarker: stringValue(record.retrievalMarker) ?? null,
      originalChars: numberValue(record.beforeChars) ?? 0,
      compressedChars: numberValue(record.afterChars) ?? 0,
      savedChars: numberValue(record.savedChars) ??
        (numberValue(record.beforeChars) ?? 0) - (numberValue(record.afterChars) ?? 0),
      originalBytes: numberValue(record.beforeBytes) ?? numberValue(record.beforeChars) ?? 0,
      compressedBytes: numberValue(record.afterBytes) ?? numberValue(record.afterChars) ?? 0,
      originalEstimatedTokens: numberValue(record.originalTokenEstimate) ?? numberValue(record.beforeEstimatedTokens) ?? 0,
      compressedEstimatedTokens: numberValue(record.compressedTokenEstimate) ?? numberValue(record.afterEstimatedTokens) ?? 0,
      savedEstimatedTokens: numberValue(record.savedTokens) ?? numberValue(record.savedEstimatedTokens) ?? 0,
      estimateSource: stringValue(record.estimateSource) ?? "rough_chars_per_4",
      originalSha256,
      compressedSha256,
      originalArtifactId: stringValue(record.originalArtifactId) ?? null,
      compressedArtifactId: stringValue(record.compressedArtifactId) ?? null,
      skipReason: stringValue(record.skipReason) ?? null,
      eventId: event.eventId,
      createdAt: new Date(event.createdAt)
    }];
  });
  if (values.length === 0) return;

  await tx.insert(compressionReceipts).values(values);
}

function modeFromEvent(eventType: string) {
  return eventType === "compression.measurement_recorded" ? "measure_only" : "compress_lossless";
}

function receiptStatus(status: string | undefined, eventType: string) {
  if (status === "candidate") return "measured";
  if (status === "applied" || status === "skipped" || status === "failed") return status;
  return eventType === "compression.measurement_recorded" ? "measured" : "applied";
}
