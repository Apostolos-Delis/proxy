import {
  cloneRecord,
  jsonArguments,
  numberValue,
  stringValue
} from "./canonical.js";
import { isRecord } from "../util.js";

export function bedrockConverseResponseToOpenAIChat(body: unknown) {
  const source = cloneRecord(body);
  const blocks = bedrockContentBlocks(source);
  const text = bedrockText(blocks);
  const toolCalls = bedrockToolUses(blocks).map(bedrockToolUseToChat);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || null
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: "chatcmpl_bedrock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: source.modelId ?? source.model,
    choices: [{
      index: 0,
      message,
      finish_reason: bedrockStopReasonToChat(source.stopReason)
    }],
    usage: isRecord(source.usage) ? bedrockUsageToChat(source.usage) : undefined
  };
}

export function bedrockConverseResponseToOpenAIResponses(body: unknown) {
  const source = cloneRecord(body);
  const blocks = bedrockContentBlocks(source);
  const text = bedrockText(blocks);
  const output: Record<string, unknown>[] = [];
  if (text) {
    output.push({
      id: "msg_bedrock",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text }]
    });
  }
  for (const block of bedrockToolUses(blocks)) {
    output.push(bedrockToolUseToResponses(block));
  }
  const incompleteReason = bedrockIncompleteReason(source.stopReason);
  return {
    id: "resp_bedrock",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: source.modelId ?? source.model,
    status: incompleteReason ? "incomplete" : "completed",
    ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
    output,
    output_text: text,
    usage: isRecord(source.usage) ? bedrockUsageToResponses(source.usage) : undefined
  };
}

export function bedrockConverseResponseToAnthropicMessages(body: unknown) {
  const source = cloneRecord(body);
  const blocks = bedrockContentBlocks(source);
  const content = [
    ...bedrockTextBlocks(blocks),
    ...bedrockToolUses(blocks).map(bedrockToolUseToAnthropic)
  ];
  return {
    id: "msg_bedrock",
    type: "message",
    role: "assistant",
    model: source.modelId ?? source.model,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: bedrockStopReasonToAnthropic(source.stopReason),
    usage: isRecord(source.usage) ? bedrockUsageToAnthropic(source.usage) : undefined
  };
}

export function bedrockConverseProviderMetadata(body: unknown) {
  const source = cloneRecord(body);
  return {
    provider: "amazon-bedrock",
    bedrock: {
      stopReason: source.stopReason,
      metrics: isRecord(source.metrics) ? source.metrics : undefined,
      trace: isRecord(source.trace) ? source.trace : undefined,
      responseMetadata: isRecord(source.$metadata) ? source.$metadata : undefined
    }
  };
}

export function bedrockConverseErrorToOpenAI(error: unknown) {
  const normalized = normalizeBedrockError(error);
  return {
    error: {
      message: normalized.message,
      type: openAIErrorType(normalized.code),
      code: normalized.code
    }
  };
}

export function bedrockConverseErrorToAnthropicMessages(error: unknown) {
  const normalized = normalizeBedrockError(error);
  return {
    type: "error",
    error: {
      type: anthropicErrorType(normalized.code),
      message: normalized.message
    }
  };
}

function bedrockContentBlocks(source: Record<string, unknown>) {
  const output = isRecord(source.output) ? source.output : {};
  const message = isRecord(output.message) ? output.message : {};
  return Array.isArray(message.content)
    ? message.content.filter(isRecord)
    : [];
}

function bedrockText(blocks: Record<string, unknown>[]) {
  return bedrockTextBlocks(blocks).map((block) => block.text).join("");
}

function bedrockTextBlocks(blocks: Record<string, unknown>[]) {
  return blocks
    .filter((block): block is Record<string, string> => typeof block.text === "string")
    .map((block) => ({ type: "text", text: block.text }));
}

function bedrockToolUses(blocks: Record<string, unknown>[]) {
  return blocks
    .map((block) => isRecord(block.toolUse) ? block.toolUse : undefined)
    .filter((block): block is Record<string, unknown> => block !== undefined);
}

function bedrockToolUseToChat(toolUse: Record<string, unknown>) {
  return {
    id: stringValue(toolUse.toolUseId),
    type: "function",
    function: {
      name: stringValue(toolUse.name),
      arguments: jsonArguments(toolUse.input)
    }
  };
}

function bedrockToolUseToResponses(toolUse: Record<string, unknown>) {
  const id = stringValue(toolUse.toolUseId);
  return {
    id,
    type: "function_call",
    call_id: id,
    name: stringValue(toolUse.name),
    arguments: jsonArguments(toolUse.input)
  };
}

function bedrockToolUseToAnthropic(toolUse: Record<string, unknown>) {
  return {
    type: "tool_use",
    id: stringValue(toolUse.toolUseId),
    name: stringValue(toolUse.name),
    input: toolUse.input ?? {}
  };
}

export function bedrockUsageToChat(usage: Record<string, unknown>) {
  const promptTokens = numberValue(usage.inputTokens);
  const completionTokens = numberValue(usage.outputTokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: numberValue(usage.totalTokens) ??
      (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined)
  };
}

export function bedrockUsageToResponses(usage: Record<string, unknown>) {
  const inputTokens = numberValue(usage.inputTokens);
  const outputTokens = numberValue(usage.outputTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: numberValue(usage.totalTokens) ??
      (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  };
}

export function bedrockUsageToAnthropic(usage: Record<string, unknown>) {
  return {
    input_tokens: numberValue(usage.inputTokens),
    output_tokens: numberValue(usage.outputTokens)
  };
}

export function bedrockStopReasonToChat(reason: unknown) {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "guardrail_intervened" || reason === "content_filtered") return "content_filter";
  return "stop";
}

export function bedrockStopReasonToAnthropic(reason: unknown) {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "stop_sequence") return "stop_sequence";
  if (reason === "guardrail_intervened" || reason === "content_filtered") return "refusal";
  return "end_turn";
}

export function bedrockIncompleteReason(reason: unknown) {
  if (reason === "max_tokens") return "max_output_tokens";
  if (reason === "guardrail_intervened" || reason === "content_filtered") return "content_filter";
  return undefined;
}

function normalizeBedrockError(error: unknown) {
  const source = isRecord(error) ? error : {};
  return {
    code: stringValue(source.name) ?? stringValue(source.code) ?? "bedrock_error",
    message: stringValue(source.message) ?? "Bedrock request failed."
  };
}

function openAIErrorType(code: string) {
  const lower = code.toLowerCase();
  if (lower.includes("throttl") || lower.includes("quota")) return "rate_limit_error";
  if (lower.includes("access") || lower.includes("auth") || lower.includes("credential")) return "authentication_error";
  if (lower.includes("validation") || lower.includes("unsupported")) return "invalid_request_error";
  return "server_error";
}

function anthropicErrorType(code: string) {
  const lower = code.toLowerCase();
  if (lower.includes("throttl") || lower.includes("quota")) return "rate_limit_error";
  if (lower.includes("access") || lower.includes("auth") || lower.includes("credential")) return "authentication_error";
  if (lower.includes("validation") || lower.includes("unsupported")) return "invalid_request_error";
  return "api_error";
}
