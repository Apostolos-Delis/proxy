import type {
  CompressionPreview,
  CompressionPreviewBlock,
  CompressionPreviewDiffSegment
} from "../../compressionPreview.js";
import { builder } from "../builder.js";
import { ToolResultCompressionPolicyInput } from "./settings.js";

export const CompressionPreviewDiffSegmentType = builder
  .objectRef<CompressionPreviewDiffSegment>("CompressionPreviewDiffSegment")
  .implement({
    fields: (t) => ({
      side: t.exposeString("side"),
      text: t.exposeString("text")
    })
  });

export const CompressionPreviewBlockType = builder
  .objectRef<CompressionPreviewBlock>("CompressionPreviewBlock")
  .implement({
    fields: (t) => ({
      blockPath: t.exposeString("blockPath"),
      toolName: t.exposeString("toolName"),
      command: t.exposeString("command", { nullable: true }),
      commandClass: t.exposeString("commandClass", { nullable: true }),
      ruleId: t.exposeString("ruleId"),
      ruleVersion: t.exposeInt("ruleVersion"),
      status: t.exposeString("status"),
      skipReason: t.exposeString("skipReason", { nullable: true }),
      originalChars: t.exposeInt("originalChars"),
      compressedChars: t.exposeInt("compressedChars"),
      savedChars: t.exposeInt("savedChars"),
      originalBytes: t.exposeInt("originalBytes"),
      compressedBytes: t.exposeInt("compressedBytes"),
      savedBytes: t.exposeInt("savedBytes"),
      originalTokenEstimate: t.exposeInt("originalTokenEstimate"),
      compressedTokenEstimate: t.exposeInt("compressedTokenEstimate"),
      savedTokens: t.exposeInt("savedTokens"),
      estimateSource: t.exposeString("estimateSource"),
      originalSha256: t.exposeString("originalSha256"),
      compressedSha256: t.exposeString("compressedSha256"),
      diffSegments: t.expose("diffSegments", { type: [CompressionPreviewDiffSegmentType] })
    })
  });

export const CompressionPreviewType = builder
  .objectRef<CompressionPreview>("CompressionPreview")
  .implement({
    fields: (t) => ({
      source: t.exposeString("source"),
      surface: t.exposeString("surface", { nullable: true }),
      contentAvailable: t.exposeBoolean("contentAvailable"),
      contentRedactionReason: t.exposeString("contentRedactionReason", { nullable: true }),
      blocks: t.exposeInt("blocks"),
      originalBytes: t.exposeInt("originalBytes"),
      compressedBytes: t.exposeInt("compressedBytes"),
      savedBytes: t.exposeInt("savedBytes"),
      originalTokenEstimate: t.exposeInt("originalTokenEstimate"),
      compressedTokenEstimate: t.exposeInt("compressedTokenEstimate"),
      savedTokens: t.exposeInt("savedTokens"),
      previewBlocks: t.expose("previewBlocks", { type: [CompressionPreviewBlockType] })
    })
  });

export const CompressionPreviewInput = builder.inputType("CompressionPreviewInput", {
  fields: (t) => ({
    requestId: t.id(),
    surface: t.string(),
    body: t.field({ type: "JSON" }),
    policy: t.field({ type: ToolResultCompressionPolicyInput })
  })
});
