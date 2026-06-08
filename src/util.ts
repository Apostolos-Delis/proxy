import { createHash, randomUUID } from "node:crypto";

import type { JsonValue } from "./types.js";

export function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function stableJson(value: unknown) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function roughTokenEstimate(chars: number) {
  return Math.ceil(chars / 4);
}
