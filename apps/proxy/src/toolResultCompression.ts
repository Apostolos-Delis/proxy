import { bashOutputRule } from "./compressionRules/bashOutput.js";
import { mcpJsonRule } from "./compressionRules/mcpJson.js";
import type { EventService } from "./events.js";
import type { JsonObject, Surface } from "./types.js";
import { isRecord, stableJson, stringField } from "./util.js";

// Deterministic compression of tool-result content before it reaches the
// provider. Determinism is non-negotiable: the harness re-sends the full
// conversation every turn, so a given tool result reappears verbatim on every
// subsequent request. A filter that is a pure function of the block content
// produces identical bytes each time, so the prompt-cache prefix stays stable
// and compression compounds instead of busting the cache. No LLM calls here.

export type ToolRef = { name: string; input: unknown };

export type CompressionFilterInput = {
  toolName: string;
  toolInput: unknown;
  content: unknown;
};

// Returns replacement content (a string or content array), or undefined to
// leave the block untouched. Must be deterministic in its inputs.
export type CompressionFilter = (input: CompressionFilterInput) => unknown;

export type CompressionRule = {
  label: string;
  matches: (toolName: string) => boolean;
  filter: CompressionFilter;
};

export type CompressionRecord = {
  tool: string;
  rule: string;
  beforeChars: number;
  afterChars: number;
};

export type CompressionResult = { body: unknown; records: CompressionRecord[] };

// Only results above this size are eligible — keeps the transform off the hot
// path for cheap calls and avoids touching small blocks where compression
// cannot pay for itself.
export const MIN_COMPRESSIBLE_CHARS = 2048;

// Registered rules, evaluated in order; first match wins. Only applied for
// orgs that have opted into tool-result compression.
export const compressionRules: CompressionRule[] = [mcpJsonRule, bashOutputRule];

export function compressToolResults(
  surface: Surface,
  body: unknown,
  rules: CompressionRule[] = compressionRules
): CompressionResult {
  if (rules.length === 0 || !isRecord(body)) return { body, records: [] };
  const records: CompressionRecord[] = [];
  const compressed = surface === "anthropic-messages"
    ? compressAnthropic(body, rules, records)
    : compressOpenAI(body, rules, records);
  return { body: compressed, records };
}

// Compress deterministically, falling back to the original body if the filter
// throws or the org has not opted in. The forwarded bytes depend ONLY on block
// content and the org's static opt-in — never on event I/O or any per-request
// state — so the prompt-cache prefix stays stable.
export function compressOrFallback(
  surface: Surface,
  body: unknown,
  enabled: boolean,
  warn: (error: unknown, message: string) => void
): CompressionResult {
  if (!enabled) return { body, records: [] };
  try {
    return compressToolResults(surface, body);
  } catch (error) {
    warn(error, "tool result compression failed");
    return { body, records: [] };
  }
}

// Compress the request body and, if anything was compressed, emit a
// compression.recorded event for measurement. The compressed body is returned
// regardless of whether the event write succeeds — a failed event must never
// change the bytes we forward (that would bust the cache on the failing turn).
export async function compressForForward(input: {
  events: EventService;
  tenantId: string;
  workspaceId: string;
  requestId: string;
  idempotencyKey: string;
  sessionId?: string;
  surface: Surface;
  body: unknown;
  enabled: boolean;
  warn: (error: unknown, message: string) => void;
}): Promise<unknown> {
  const { body, records } = compressOrFallback(input.surface, input.body, input.enabled, input.warn);
  if (records.length === 0) return body;
  const beforeChars = records.reduce((sum, record) => sum + record.beforeChars, 0);
  const afterChars = records.reduce((sum, record) => sum + record.afterChars, 0);
  try {
    await input.events.append({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      scopeType: "request",
      scopeId: input.requestId,
      sessionId: input.sessionId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      producer: "prompt-proxy.compression",
      eventType: "compression.recorded",
      redactionState: "not_applicable",
      payload: {
        surface: input.surface,
        beforeChars,
        afterChars,
        savedChars: beforeChars - afterChars,
        blocks: records.length,
        byRule: records as unknown as JsonObject[]
      } as JsonObject
    });
  } catch (error) {
    input.warn(error, "compression event emit failed");
  }
  return body;
}

// Both walkers rebuild only the spine that leads to a rewritten block —
// untouched messages/items keep their original references. Bodies reach tens
// of MB and most requests have nothing eligible to compress, so a deep clone
// per request would be an avoidable hot-path allocation. The input body is
// never mutated; spreading a rewritten block preserves its other fields,
// including any cache_control markers.
function compressAnthropic(request: Record<string, unknown>, rules: CompressionRule[], records: CompressionRecord[]): unknown {
  if (!Array.isArray(request.messages)) return request;
  const toolNames = anthropicToolNames(request.messages);
  let changed = false;
  const messages = request.messages.map((message) => {
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((block) => {
      if (!isRecord(block) || block.type !== "tool_result") return block;
      const toolUseId = stringField(block, "tool_use_id");
      const ref = toolUseId ? toolNames.get(toolUseId) : undefined;
      const toolName = ref?.name ?? "unknown";
      const replaced = applyRules(rules, toolName, ref?.input, block.content, records);
      if (replaced === undefined) return block;
      messageChanged = true;
      return { ...block, content: replaced };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...request, messages } : request;
}

function compressOpenAI(request: Record<string, unknown>, rules: CompressionRule[], records: CompressionRecord[]): unknown {
  if (!Array.isArray(request.input)) return request;
  const callNames = openAICallNames(request.input);
  let changed = false;
  const input = request.input.map((item) => {
    if (!isRecord(item) || item.type !== "function_call_output") return item;
    const callId = stringField(item, "call_id");
    const ref = callId ? callNames.get(callId) : undefined;
    const toolName = ref?.name ?? "unknown";
    const replaced = applyRules(rules, toolName, ref?.input, item.output, records);
    if (replaced === undefined) return item;
    changed = true;
    return { ...item, output: replaced };
  });
  return changed ? { ...request, input } : request;
}

// Apply the first matching rule to a tool-result content payload. Records the
// before/after size only when the filter actually shrank the content.
function applyRules(
  rules: CompressionRule[],
  toolName: string,
  toolInput: unknown,
  content: unknown,
  records: CompressionRecord[]
): unknown {
  const beforeChars = contentChars(content);
  if (beforeChars < MIN_COMPRESSIBLE_CHARS) return undefined;
  const rule = rules.find((candidate) => candidate.matches(toolName));
  if (!rule) return undefined;
  const replaced = rule.filter({ toolName, toolInput, content });
  if (replaced === undefined) return undefined;
  const afterChars = contentChars(replaced);
  if (afterChars >= beforeChars) return undefined; // never grow a block
  records.push({ tool: toolName, rule: rule.label, beforeChars, afterChars });
  return replaced;
}

function anthropicToolNames(messages: unknown): Map<string, ToolRef> {
  const map = new Map<string, ToolRef>();
  if (!Array.isArray(messages)) return map;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        map.set(block.id, { name: block.name, input: block.input });
      }
    }
  }
  return map;
}

function openAICallNames(input: unknown[]): Map<string, ToolRef> {
  const map = new Map<string, ToolRef>();
  for (const item of input) {
    if (isRecord(item) && item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
      map.set(item.call_id, { name: item.name, input: item.arguments });
    }
  }
  return map;
}

// Shared shape handler for content filters: tool-result content is either a
// bare string or Claude Code's [{type:"text", text}] block array. Applies a
// per-string transform (which returns a replacement or undefined for "leave
// as-is") and returns the rewritten content, or undefined if nothing changed.
export function mapTextContent(
  content: unknown,
  transform: (text: string) => string | undefined
): unknown {
  if (typeof content === "string") {
    return transform(content);
  }
  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((block) => {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        const replaced = transform(block.text);
        if (replaced !== undefined && replaced !== block.text) {
          changed = true;
          return { ...block, text: replaced };
        }
      }
      return block;
    });
    return changed ? next : undefined;
  }
  return undefined;
}

function contentChars(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  return stableJson(value).length;
}
