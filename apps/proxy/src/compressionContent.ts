import { createHash } from "node:crypto";

import { stableJson } from "./util.js";

export const ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE = "rough_chars_per_4";

export function contentSha256(content: unknown) {
  return `sha256:${createHash("sha256").update(serializedContent(content)).digest("hex")}`;
}

export function contentBytes(content: unknown) {
  return Buffer.byteLength(serializedContent(content));
}

export function contentChars(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  return stableJson(value).length;
}

function serializedContent(content: unknown) {
  if (typeof content === "string") return content;
  return JSON.stringify(content) ?? "null";
}
