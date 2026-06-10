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

export function lowerHeaders(headers: Record<string, unknown>) {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key.toLowerCase()] = value;
    if (Array.isArray(value) && typeof value[0] === "string") result[key.toLowerCase()] = value[0];
  }
  return result;
}

export function headerValue(headers: Record<string, unknown>, key: string) {
  const value = headers[key] ?? headers[key.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

export function idempotencyFrom(
  surface: string,
  body: unknown,
  headers: Record<string, unknown>
) {
  const explicit =
    headerValue(headers, "idempotency-key") ??
    headerValue(headers, "x-request-id");

  if (explicit && explicit.length > 0) {
    return sha256(`${surface}:explicit:${explicit}`);
  }
  const stableHeader = [
    headerValue(headers, "x-codex-turn-state"),
    headerValue(headers, "x-claude-code-session-id"),
    headerValue(headers, "x-claude-code-agent-id"),
    headerValue(headers, "session_id"),
    headerValue(headers, "x-client-request-id")
  ]
    .filter((value): value is string => typeof value === "string")
    .join(":");
  return sha256(`${surface}:${stableHeader}:${stableJson(body)}`);
}

export function notFoundError(message: string) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 404;
  return error;
}
