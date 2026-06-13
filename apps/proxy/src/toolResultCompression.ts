import { createHash } from "node:crypto";

import { bashOutputRule, bashOutputRuleForNames } from "./compressionRules/bashOutput.js";
import { jsonWhitespaceRule } from "./compressionRules/jsonWhitespace.js";
import { mcpJsonRule } from "./compressionRules/mcpJson.js";
import type { EventService } from "./events.js";
import type { HarnessProfile } from "./harness.js";
import type { JsonObject, Surface } from "./types.js";
import { isRecord, roughTokenEstimate, stableJson, stringField, unreachable } from "./util.js";

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
  version: number;
  matches: (toolName: string) => boolean;
  filter: CompressionFilter;
  // Per-rule eligibility floor; defaults to MIN_COMPRESSIBLE_CHARS. Cheap O(n)
  // transforms can opt into a lower floor to catch mid-size results.
  minChars?: number;
};

export type CompressionRecord = {
  tool: string;
  rule: string;
  ruleVersion: number;
  beforeChars: number;
  afterChars: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  savedEstimatedTokens: number;
};

export type CompressionResult = { body: unknown; records: CompressionRecord[] };
export type CompressionOptions = { deduplicateToolResults?: boolean; profile?: HarnessProfile };
type DuplicateTracker = Set<string>;

// Only results above this size are eligible — keeps the transform off the hot
// path for cheap calls and avoids touching small blocks where compression
// cannot pay for itself.
export const MIN_COMPRESSIBLE_CHARS = 2048;

// Registered rules, evaluated in order; first successful rewrite wins. Only
// applied for orgs that have opted into tool-result compression.
export const compressionRules: CompressionRule[] = [mcpJsonRule, jsonWhitespaceRule, bashOutputRule];

export function compressionRulesForProfile(profile: HarnessProfile): CompressionRule[] {
  return [mcpJsonRule, bashOutputRuleForNames(profile.bashToolNames)];
}

export function compressToolResults(
  surface: Surface,
  body: unknown,
  rules: CompressionRule[] = compressionRules,
  options: CompressionOptions = {}
): CompressionResult {
  if ((!options.deduplicateToolResults && rules.length === 0) || !isRecord(body)) return { body, records: [] };
  const records: CompressionRecord[] = [];
  const duplicates: DuplicateTracker | undefined = options.deduplicateToolResults ? new Set() : undefined;
  const compressed = compressForSurface(surface, body, rules, records, duplicates);
  return { body: compressed, records };
}

function compressForSurface(
  surface: Surface,
  body: Record<string, unknown>,
  rules: CompressionRule[],
  records: CompressionRecord[],
  duplicates: DuplicateTracker | undefined
) {
  switch (surface) {
    case "openai-responses":
      return compressOpenAI(body, rules, records, duplicates);
    case "openai-chat":
      return compressOpenAIChat(body, rules, records, duplicates);
    case "anthropic-messages":
      return compressAnthropic(body, rules, records, duplicates);
    default:
      return unreachable(surface);
  }
}

// Compress deterministically, falling back to the original body if the filter
// throws or the org has not opted in. The forwarded bytes depend ONLY on block
// content and the org's static opt-in — never on event I/O or any per-request
// state — so the prompt-cache prefix stays stable.
export function compressOrFallback(
  surface: Surface,
  body: unknown,
  enabled: boolean,
  warn: (error: unknown, message: string) => void,
  options: CompressionOptions = {}
): CompressionResult {
  if (!enabled) return { body, records: [] };
  try {
    const rules = options.profile ? compressionRulesForProfile(options.profile) : compressionRules;
    return compressToolResults(surface, body, rules, options);
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
  deduplicateToolResults?: boolean;
  profile?: HarnessProfile;
  warn: (error: unknown, message: string) => void;
}): Promise<unknown> {
  const { body, records } = compressOrFallback(
    input.surface,
    input.body,
    input.enabled,
    input.warn,
    {
      deduplicateToolResults: input.deduplicateToolResults === true,
      profile: input.profile
    }
  );
  if (records.length === 0) return body;
  const beforeChars = records.reduce((sum, record) => sum + record.beforeChars, 0);
  const afterChars = records.reduce((sum, record) => sum + record.afterChars, 0);
  const beforeEstimatedTokens = records.reduce((sum, record) => sum + record.beforeEstimatedTokens, 0);
  const afterEstimatedTokens = records.reduce((sum, record) => sum + record.afterEstimatedTokens, 0);
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
        beforeEstimatedTokens,
        afterEstimatedTokens,
        savedEstimatedTokens: beforeEstimatedTokens - afterEstimatedTokens,
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
function compressAnthropic(
  request: Record<string, unknown>,
  rules: CompressionRule[],
  records: CompressionRecord[],
  duplicates: DuplicateTracker | undefined
): unknown {
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
      const duplicate = applyDuplicateReference(toolName, block.content, records, duplicates);
      if (duplicate !== undefined) {
        messageChanged = true;
        return { ...block, content: duplicate };
      }
      const replaced = applyRules(rules, toolName, ref?.input, block.content, records);
      if (replaced === undefined) {
        trackDuplicateContent(block.content, duplicates);
        return block;
      }
      messageChanged = true;
      return { ...block, content: replaced };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...request, messages } : request;
}

function compressOpenAI(
  request: Record<string, unknown>,
  rules: CompressionRule[],
  records: CompressionRecord[],
  duplicates: DuplicateTracker | undefined
): unknown {
  if (!Array.isArray(request.input)) return request;
  const callNames = openAICallNames(request.input);
  let changed = false;
  const input = request.input.map((item) => {
    if (!isRecord(item) || item.type !== "function_call_output") return item;
    const callId = stringField(item, "call_id");
    const ref = callId ? callNames.get(callId) : undefined;
    const toolName = ref?.name ?? "unknown";
    const duplicate = applyDuplicateReference(toolName, item.output, records, duplicates);
    if (duplicate !== undefined) {
      changed = true;
      return { ...item, output: duplicate };
    }
    const replaced = applyRules(rules, toolName, ref?.input, item.output, records);
    if (replaced === undefined) {
      trackDuplicateContent(item.output, duplicates);
      return item;
    }
    changed = true;
    return { ...item, output: replaced };
  });
  return changed ? { ...request, input } : request;
}

function compressOpenAIChat(
  request: Record<string, unknown>,
  rules: CompressionRule[],
  records: CompressionRecord[],
  duplicates: DuplicateTracker | undefined
): unknown {
  if (!Array.isArray(request.messages)) return request;
  const callRefs = openAIChatCallRefs(request.messages);
  let changed = false;
  const messages = request.messages.map((message) => {
    if (!isRecord(message) || message.role !== "tool") return message;
    const toolCallId = stringField(message, "tool_call_id");
    const ref = toolCallId ? callRefs.get(toolCallId) : undefined;
    const toolName = ref?.name ?? "unknown";
    const duplicate = applyDuplicateReference(toolName, message.content, records, duplicates);
    if (duplicate !== undefined) {
      changed = true;
      return { ...message, content: duplicate };
    }
    const replaced = applyRules(rules, toolName, ref?.input, message.content, records);
    if (replaced === undefined) {
      trackDuplicateContent(message.content, duplicates);
      return message;
    }
    changed = true;
    return { ...message, content: replaced };
  });
  return changed ? { ...request, messages } : request;
}

// Apply the first rule that shrinks a tool-result content payload. Records the
// before/after size only when the filter actually shrank the content.
function applyRules(
  rules: CompressionRule[],
  toolName: string,
  toolInput: unknown,
  content: unknown,
  records: CompressionRecord[]
): unknown {
  const beforeChars = contentChars(content);
  for (const rule of rules) {
    if (!rule.matches(toolName)) continue;
    if (beforeChars < (rule.minChars ?? MIN_COMPRESSIBLE_CHARS)) continue;
    const replaced = rule.filter({ toolName, toolInput, content });
    if (replaced === undefined) continue;
    const afterChars = contentChars(replaced);
    if (afterChars >= beforeChars) continue;
    const beforeEstimatedTokens = roughTokenEstimate(beforeChars);
    const afterEstimatedTokens = roughTokenEstimate(afterChars);
    records.push({
      tool: toolName,
      rule: rule.label,
      ruleVersion: rule.version,
      beforeChars,
      afterChars,
      beforeEstimatedTokens,
      afterEstimatedTokens,
      savedEstimatedTokens: beforeEstimatedTokens - afterEstimatedTokens
    });
    return replaced;
  }
  return undefined;
}

function applyDuplicateReference(
  toolName: string,
  content: unknown,
  records: CompressionRecord[],
  duplicates: DuplicateTracker | undefined
): unknown {
  if (!duplicates) return undefined;
  const fingerprint = contentFingerprint(content);
  if (fingerprint.chars < MIN_COMPRESSIBLE_CHARS) return undefined;
  if (!duplicates.has(fingerprint.key)) return undefined;
  const replacement = duplicateReference(content, fingerprint.hash, fingerprint.chars);
  const afterChars = contentChars(replacement);
  if (afterChars >= fingerprint.chars) return undefined;
  const beforeEstimatedTokens = roughTokenEstimate(fingerprint.chars);
  const afterEstimatedTokens = roughTokenEstimate(afterChars);
  records.push({
    tool: toolName,
    rule: "duplicate-tool-result-reference",
    ruleVersion: 1,
    beforeChars: fingerprint.chars,
    afterChars,
    beforeEstimatedTokens,
    afterEstimatedTokens,
    savedEstimatedTokens: beforeEstimatedTokens - afterEstimatedTokens
  });
  return replacement;
}

function trackDuplicateContent(content: unknown, duplicates: DuplicateTracker | undefined) {
  if (!duplicates) return;
  const fingerprint = contentFingerprint(content);
  if (fingerprint.chars >= MIN_COMPRESSIBLE_CHARS) duplicates.add(fingerprint.key);
}

function contentFingerprint(content: unknown) {
  const serialized = typeof content === "string" ? content : stableJson(content);
  const hash = createHash("sha256").update(serialized).digest("hex");
  const chars = typeof content === "string" ? content.length : serialized.length;
  return { hash, chars, key: `${hash}:${serialized.length}` };
}

function duplicateReference(content: unknown, hash: string, originalChars: number) {
  const text = `[duplicate tool result omitted; contentHash=sha256:${hash}; originalChars=${originalChars}]`;
  return Array.isArray(content) ? [{ type: "text", text }] : text;
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

function openAIChatCallRefs(messages: unknown[]): Map<string, ToolRef> {
  const map = new Map<string, ToolRef>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (!isRecord(call) || typeof call.id !== "string") continue;
      const fn = isRecord(call.function) ? call.function : undefined;
      const name = (fn ? stringField(fn, "name") : undefined) ?? stringField(call, "name");
      if (name) map.set(call.id, { name, input: fn?.arguments ?? call.arguments });
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
