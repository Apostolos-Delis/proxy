import { createHash } from "node:crypto";

export type CompressionRetrievalIdInput = {
  requestId: string;
  blockPath: string;
  ruleId: string;
  originalSha256: string;
};

export function compressionRetrievalId(input: CompressionRetrievalIdInput) {
  return `cmp_${createHash("sha256")
    .update(`${input.requestId}:${input.blockPath}:${input.ruleId}:${input.originalSha256}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export function compressionRetrievalMarker(input: {
  retrievalId: string;
  originalSha256: string;
}) {
  return `[prompt-proxy:compressed id=${input.retrievalId} sha256=${input.originalSha256}]`;
}
