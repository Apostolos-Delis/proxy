import { and, eq } from "drizzle-orm";

import { compressionReceipts, requests, type PromptProxyTransaction } from "@prompt-proxy/db";

import type { ProxyEvent } from "../events.js";
import { numberValue, recordArray, stringValue } from "./values.js";

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
    return [{
      id: `${event.eventId}:compression:${index}`,
      organizationId: event.tenantId,
      workspaceId: event.workspaceId,
      requestId: event.scopeId,
      apiKeyId: request?.apiKeyId ?? null,
      mode,
      surface,
      blockPath: stringValue(record.blockPath) ?? `block.${index}`,
      toolName: stringValue(record.tool) ?? "unknown",
      command: stringValue(record.command) ?? null,
      commandClass: stringValue(record.commandClass) ?? null,
      ruleId: stringValue(record.rule) ?? "unknown",
      ruleVersion: numberValue(record.ruleVersion) ?? 0,
      status: receiptStatus(stringValue(record.status), event.eventType),
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
