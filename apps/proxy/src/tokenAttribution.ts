import { createHash } from "node:crypto";

import { actorForIdentity, type RequestIdentity } from "./auth.js";
import { jsonPayload, type EventAppender } from "./events.js";
import type { JsonObject, Surface } from "./types.js";
import { isRecord, roughTokenEstimate, stableJson, stringField, unreachable } from "./util.js";

// Bounds the per-name lists so a tool-heavy request cannot bloat the event
// payload; overflow rolls up into a synthetic __other entry.
const MAX_NAMED_ENTRIES = 40;

type Bucket = { chars: number; estimatedTokens: number };

export type TokenAttribution = {
  surface: Surface;
  requestedModel: string;
  systemPrompt: Bucket;
  orgSystemPrompt: Bucket;
  toolSchemas: Bucket & { count: number };
  history: Bucket & { messages: number };
  newToolResults: Bucket & { blocks: number };
  latestUser: Bucket;
  total: Bucket;
  toolSchemasByName: Array<{ name: string; chars: number; estimatedTokens: number }>;
  toolSchemaHashesByName: Array<{ name: string; schemaHash: string; chars: number; estimatedTokens: number }>;
  newToolResultsByTool: Array<{ tool: string; chars: number; estimatedTokens: number; blocks: number }>;
};

export function attributeTokens(surface: Surface, body: unknown, orgSystemPrompt?: string): TokenAttribution {
  const request = isRecord(body) ? body : {};
  const parts = attributionParts(surface, request);
  const orgChars = orgSystemPrompt?.length ?? 0;
  const totalChars =
    parts.systemChars +
    orgChars +
    parts.toolSchemas.total +
    parts.historyChars +
    parts.newToolResults.total +
    parts.latestUserChars;

  const fallbackModel = fallbackModelForSurface(surface);
  return {
    surface,
    requestedModel: typeof request.model === "string" ? request.model : fallbackModel,
    systemPrompt: bucket(parts.systemChars),
    orgSystemPrompt: bucket(orgChars),
    toolSchemas: { ...bucket(parts.toolSchemas.total), count: parts.toolSchemas.count },
    history: { ...bucket(parts.historyChars), messages: parts.historyMessages },
    newToolResults: { ...bucket(parts.newToolResults.total), blocks: parts.newToolResults.blocks },
    latestUser: bucket(parts.latestUserChars),
    total: bucket(totalChars),
    toolSchemasByName: capEntries(parts.toolSchemas.byName).map(([name, chars]) => ({
      name,
      chars,
      estimatedTokens: roughTokenEstimate(chars)
    })),
    toolSchemaHashesByName: capSchemaHashes(parts.toolSchemas.hashesByName).map((entry) => ({
      ...entry,
      estimatedTokens: roughTokenEstimate(entry.chars)
    })),
    newToolResultsByTool: cappedResults(parts.newToolResults).map((entry) => ({
      ...entry,
      estimatedTokens: roughTokenEstimate(entry.chars)
    }))
  };
}

function attributionParts(surface: Surface, request: Record<string, unknown>) {
  switch (surface) {
    case "openai-responses":
      return attributeOpenAI(request);
    case "openai-chat":
      return attributeOpenAIChat(request);
    case "anthropic-messages":
      return attributeAnthropic(request);
    default:
      return unreachable(surface);
  }
}

function fallbackModelForSurface(surface: Surface) {
  switch (surface) {
    case "openai-responses":
      return "router-auto";
    case "openai-chat":
      return "router-auto";
    case "anthropic-messages":
      return "claude-router-auto";
    default:
      return unreachable(surface);
  }
}

export async function appendTokensAttributed(input: {
  events: EventAppender;
  identity: RequestIdentity;
  requestId: string;
  idempotencyKey: string;
  sessionId?: string;
  surface: Surface;
  body: unknown;
  orgSystemPrompt?: string;
  warn: (error: unknown, message: string) => void;
}) {
  try {
    const attribution = attributeTokens(input.surface, input.body, input.orgSystemPrompt);
    await input.events.append({
      tenantId: input.identity.organizationId,
      workspaceId: input.identity.workspaceId,
      scopeType: "request",
      scopeId: input.requestId,
      sessionId: input.sessionId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      actor: actorForIdentity(input.identity),
      producer: "proxy.attribution",
      eventType: "tokens.attributed",
      redactionState: "not_applicable",
      payload: jsonPayload({ ...attribution, sessionId: input.sessionId }) as JsonObject
    });
  } catch (error) {
    input.warn(error, "token attribution failed");
  }
}

type ToolGroup = {
  total: number;
  count: number;
  byName: Map<string, number>;
  hashesByName: Map<string, Map<string, number>>;
};
type ResultGroup = { total: number; blocks: number; byTool: Map<string, number>; blocksByTool: Map<string, number> };

type AttributionParts = {
  systemChars: number;
  toolSchemas: ToolGroup;
  historyChars: number;
  historyMessages: number;
  newToolResults: ResultGroup;
  latestUserChars: number;
};

function attributeAnthropic(request: Record<string, unknown>): AttributionParts {
  const toolSchemas = groupToolSchemas(request.tools, (tool) => stringField(tool, "name"));
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        toolNames.set(block.id, block.name);
      }
    }
  }

  const newToolResults = emptyResultGroup();
  let latestUserChars = 0;
  let historyEnd = messages.length;

  const last = messages.at(-1);
  if (isRecord(last) && last.role === "user") {
    historyEnd = messages.length - 1;
    if (Array.isArray(last.content)) {
      for (const block of last.content) {
        if (isRecord(block) && block.type === "tool_result") {
          const toolUseId = stringField(block, "tool_use_id");
          addResult(newToolResults, toolGroupKey(toolNames.get(toolUseId ?? "") ?? "unknown"), contentChars(block.content));
        } else {
          latestUserChars += contentChars(block);
        }
      }
    } else {
      latestUserChars = contentChars(last.content);
    }
  }

  // History deliberately includes prior assistant tool_use inputs: they are
  // part of the replayed-context cost, the same as prior text turns.
  let historyChars = 0;
  for (const message of messages.slice(0, historyEnd)) {
    historyChars += isRecord(message) ? contentChars(message.content) : contentChars(message);
  }

  return {
    systemChars: contentChars(request.system),
    toolSchemas,
    historyChars,
    historyMessages: historyEnd,
    newToolResults,
    latestUserChars
  };
}

function attributeOpenAI(request: Record<string, unknown>): AttributionParts {
  const toolSchemas = groupToolSchemas(
    request.tools,
    (tool) => stringField(tool, "name") ?? stringField(tool, "type")
  );
  const newToolResults = emptyResultGroup();
  let latestUserChars = 0;
  let historyChars = 0;
  let historyMessages = 0;

  const input = request.input;
  if (typeof input === "string") {
    latestUserChars = input.length;
  } else if (Array.isArray(input)) {
    const callNames = new Map<string, string>();
    for (const item of input) {
      if (isRecord(item) && item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
        callNames.set(item.call_id, item.name);
      }
    }

    // The trailing run of tool outputs / user items is the new turn being
    // submitted in this request; everything before it is replayed history.
    let tailStart = input.length;
    while (tailStart > 0 && isNewTurnItem(input[tailStart - 1])) {
      tailStart -= 1;
    }

    for (const item of input.slice(0, tailStart)) {
      historyChars += contentChars(item);
      historyMessages += 1;
    }
    for (const item of input.slice(tailStart)) {
      if (isRecord(item) && item.type === "function_call_output") {
        const callId = stringField(item, "call_id");
        addResult(newToolResults, toolGroupKey(callNames.get(callId ?? "") ?? "unknown"), contentChars(item.output));
      } else if (isRecord(item) && item.type === "function_call") {
        // Echoed model tool invocations in the new turn are replay cost, not
        // user input and not a tool result.
        historyChars += contentChars(item);
        historyMessages += 1;
      } else {
        latestUserChars += contentChars(item);
      }
    }
  }

  return {
    systemChars: contentChars(request.instructions),
    toolSchemas,
    historyChars,
    historyMessages,
    newToolResults,
    latestUserChars
  };
}

function attributeOpenAIChat(request: Record<string, unknown>): AttributionParts {
  const toolSchemas = groupToolSchemas(request.tools, openAIChatToolName);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const toolNames = openAIChatToolCallNames(messages);
  const newToolResults = emptyResultGroup();
  let systemChars = 0;
  let latestUserChars = 0;
  let historyChars = 0;
  let historyMessages = 0;

  let tailStart = messages.length;
  while (tailStart > 0 && isOpenAIChatNewTurnMessage(messages[tailStart - 1])) {
    tailStart -= 1;
  }

  for (const message of messages.slice(0, tailStart)) {
    if (!isRecord(message)) continue;
    if (message.role === "system" || message.role === "developer") {
      systemChars += contentChars(message.content);
      continue;
    }
    historyChars += contentChars(message.content) + contentChars(message.tool_calls);
    historyMessages += 1;
  }

  for (const message of messages.slice(tailStart)) {
    if (!isRecord(message)) continue;
    if (message.role === "tool") {
      const toolCallId = stringField(message, "tool_call_id");
      addResult(newToolResults, toolGroupKey(toolNames.get(toolCallId ?? "") ?? "unknown"), contentChars(message.content));
    } else if (message.role === "user") {
      latestUserChars += contentChars(message.content);
    } else if (message.role === "system" || message.role === "developer") {
      systemChars += contentChars(message.content);
    }
  }

  return {
    systemChars,
    toolSchemas,
    historyChars,
    historyMessages,
    newToolResults,
    latestUserChars
  };
}

function isOpenAIChatNewTurnMessage(item: unknown) {
  if (!isRecord(item)) return false;
  return item.role === "tool" || item.role === "user";
}

function openAIChatToolName(tool: Record<string, unknown>) {
  if (typeof tool.name === "string") return tool.name;
  const fn = isRecord(tool.function) ? tool.function : undefined;
  return typeof fn?.name === "string" ? fn.name : stringField(tool, "type");
}

function openAIChatToolCallNames(messages: unknown[]) {
  const map = new Map<string, string>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (!isRecord(call) || typeof call.id !== "string") continue;
      const fn = isRecord(call.function) ? call.function : undefined;
      const name = typeof fn?.name === "string" ? fn.name : stringField(call, "name");
      if (name) map.set(call.id, name);
    }
  }
  return map;
}

function isNewTurnItem(item: unknown) {
  if (!isRecord(item)) return false;
  if (item.type === "function_call_output" || item.type === "function_call") return true;
  return item.role === "user";
}

function groupToolSchemas(tools: unknown, nameOf: (tool: Record<string, unknown>) => string | undefined): ToolGroup {
  const group: ToolGroup = { total: 0, count: 0, byName: new Map(), hashesByName: new Map() };
  if (!Array.isArray(tools)) return group;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const serialized = stableJson(tool);
    const chars = serialized.length;
    const name = nameOf(tool) ?? "unknown";
    const key = toolGroupKey(name);
    const schemaHash = `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
    group.total += chars;
    group.count += 1;
    group.byName.set(key, (group.byName.get(key) ?? 0) + chars);
    const hashes = group.hashesByName.get(name) ?? new Map<string, number>();
    hashes.set(schemaHash, (hashes.get(schemaHash) ?? 0) + chars);
    group.hashesByName.set(name, hashes);
  }
  return group;
}

// MCP tool names look like mcp__<server>__<tool>; attribute them per server so
// one chatty server reads as one offender instead of thirty.
function toolGroupKey(name: string) {
  if (!name.startsWith("mcp__")) return name;
  const parts = name.split("__");
  return parts.length >= 3 ? `mcp__${parts[1]}` : name;
}

function emptyResultGroup(): ResultGroup {
  return { total: 0, blocks: 0, byTool: new Map(), blocksByTool: new Map() };
}

function addResult(group: ResultGroup, tool: string, chars: number) {
  group.total += chars;
  group.blocks += 1;
  group.byTool.set(tool, (group.byTool.get(tool) ?? 0) + chars);
  group.blocksByTool.set(tool, (group.blocksByTool.get(tool) ?? 0) + 1);
}

// Size walk without serialization: bodies can be tens of MB, and building a
// throwaway JSON string for them on the hot path is an avoidable allocation.
// Blocks with a string `text` field count exactly their text.
function contentChars(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) {
    let sum = 0;
    for (const item of value) sum += contentChars(item);
    return sum;
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text.length;
    let sum = 0;
    for (const [key, item] of Object.entries(value)) sum += key.length + contentChars(item);
    return sum;
  }
  return 0;
}

function bucket(chars: number): Bucket {
  return { chars, estimatedTokens: roughTokenEstimate(chars) };
}

function cappedResults(group: ResultGroup) {
  const entries = [...group.byTool.entries()]
    .map(([tool, chars]) => ({ tool, chars, blocks: group.blocksByTool.get(tool) ?? 0 }))
    .sort((a, b) => b.chars - a.chars);
  if (entries.length <= MAX_NAMED_ENTRIES) return entries;
  const kept = entries.slice(0, MAX_NAMED_ENTRIES);
  const rest = entries.slice(MAX_NAMED_ENTRIES);
  kept.push({
    tool: "__other",
    chars: rest.reduce((sum, entry) => sum + entry.chars, 0),
    blocks: rest.reduce((sum, entry) => sum + entry.blocks, 0)
  });
  return kept;
}

function capEntries(byName: Map<string, number>) {
  const sorted = [...byName.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length <= MAX_NAMED_ENTRIES) return sorted;
  const kept = sorted.slice(0, MAX_NAMED_ENTRIES);
  const otherChars = sorted.slice(MAX_NAMED_ENTRIES).reduce((sum, [, chars]) => sum + chars, 0);
  kept.push(["__other", otherChars]);
  return kept;
}

function capSchemaHashes(hashesByName: Map<string, Map<string, number>>) {
  const entries = [...hashesByName.entries()]
    .map(([name, hashes]) => ({
      name,
      hashes,
      totalChars: [...hashes.values()].reduce((sum, chars) => sum + chars, 0)
    }))
    .sort((left, right) =>
      Number(right.hashes.size > 1) - Number(left.hashes.size > 1) ||
      right.totalChars - left.totalChars ||
      left.name.localeCompare(right.name)
    )
    .flatMap(({ name, hashes }) =>
      [...hashes.entries()]
        .map(([schemaHash, chars]) => ({ name, schemaHash, chars, churning: hashes.size > 1 }))
        .sort((left, right) => right.chars - left.chars)
    )
    .sort((left, right) =>
      Number(right.churning) - Number(left.churning) ||
      right.chars - left.chars ||
      left.name.localeCompare(right.name)
    )
    .map(({ name, schemaHash, chars }) => ({ name, schemaHash, chars }));
  if (entries.length <= MAX_NAMED_ENTRIES) return entries;
  return entries.slice(0, MAX_NAMED_ENTRIES);
}
