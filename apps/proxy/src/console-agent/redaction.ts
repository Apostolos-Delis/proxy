import { isRecord } from "../util.js";
import { capabilityToolName } from "./tools.js";
import { PROMPT_GET_CAPABILITY_KEY } from "./capabilities/read.js";

export const REDACTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  capabilityToolName(PROMPT_GET_CAPABILITY_KEY)
]);

// Reference serialization per the plan's raw prompt text rule: persisted tool
// results become { artifactId, redacted: true } plus known-safe metadata, so
// new text-bearing fields stay unpersisted by default. Model-authored text in
// assistant messages is outside this boundary and persists as-is.
const REFERENCE_KEYS = [
  "found",
  "artifactId",
  "requestId",
  "kind",
  "storageMode",
  "sourceRole",
  "tokenEstimate",
  "createdAt"
] as const;

function promptReference(value: unknown): Record<string, unknown> {
  const source = isRecord(value) ? value : {};
  const reference: Record<string, unknown> = {};
  for (const key of REFERENCE_KEYS) {
    const entry = source[key];
    if (entry === null || ["string", "number", "boolean"].includes(typeof entry)) {
      reference[key] = entry;
    }
  }
  reference.redacted = true;
  return reference;
}

function redactDecision(value: unknown): Record<string, unknown> {
  if (isRecord(value) && typeof value.decision === "string") {
    return {
      decision: value.decision,
      output: promptReference(value.output)
    };
  }
  return promptReference(value);
}

function redactToolResultMessage(message: Record<string, unknown>): Record<string, unknown> {
  const details = redactDecision(message.details);
  return {
    ...message,
    content: [{ type: "text", text: JSON.stringify(details) }],
    details
  };
}

function isRedactedToolResult(value: Record<string, unknown>) {
  return (
    value.role === "toolResult" &&
    typeof value.toolName === "string" &&
    REDACTED_TOOL_NAMES.has(value.toolName)
  );
}

function isRedactedToolPayload(value: Record<string, unknown>) {
  return typeof value.toolName === "string" && REDACTED_TOOL_NAMES.has(value.toolName);
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = walk(entry);
  }
  if (isRedactedToolResult(result)) return redactToolResultMessage(result);
  if (isRedactedToolPayload(result)) {
    if ("result" in result) result.result = redactDecision(result.result);
    if ("partialResult" in result) result.partialResult = redactDecision(result.partialResult);
  }
  return result;
}

export function redactSessionState(messages: unknown[]): Record<string, unknown> {
  return { messages: messages.map(walk) };
}

export function redactRunEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return walk(payload) as Record<string, unknown>;
}
