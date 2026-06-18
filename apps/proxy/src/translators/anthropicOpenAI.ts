import type { DialectTranslator } from "./index.js";
import {
  cloneRecord,
  eventType,
  firstChoice,
  formatFrame,
  integerValue,
  jsonArguments,
  numberValue,
  parseJsonData,
  parseMaybeJson,
  sseFrame,
  stringValue,
  textContent,
  transformSse
} from "./canonical.js";
import { isRecord } from "../util.js";

const openAIChatFieldsUnsupportedByAnthropic = [
  "audio",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "modalities",
  "n",
  "parallel_tool_calls",
  "prediction",
  "presence_penalty",
  "response_format",
  "seed",
  "service_tier",
  "store",
  "stream_options",
  "top_logprobs",
  "user"
];

const openAIResponsesFieldsUnsupportedByAnthropic = [
  "background",
  "client_metadata",
  "include",
  "max_tool_calls",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_retention",
  "service_tier",
  "store",
  "text",
  "truncation"
];

const anthropicMessagesFieldsUnsupportedByOpenAI = [
  "cache_control",
  "container",
  "context_management",
  "diagnostics",
  "metadata",
  "mcp_servers",
  "output_config",
  "service_tier",
  "thinking",
  "top_k"
];

export const anthropicMessagesToOpenAIChat: DialectTranslator = {
  request: anthropicRequestToChat,
  response: anthropicResponseToChat,
  sseTransform: anthropicSseToChat
};

export const openAIChatToAnthropicMessages: DialectTranslator = {
  request: chatRequestToAnthropic,
  response: chatResponseToAnthropic,
  sseTransform: chatSseToAnthropic
};

export const anthropicMessagesToOpenAIResponses: DialectTranslator = {
  request: anthropicRequestToResponses,
  response: anthropicResponseToResponses,
  sseTransform: anthropicSseToResponses
};

export const openAIResponsesToAnthropicMessages: DialectTranslator = {
  request: responsesRequestToAnthropic,
  response: responsesResponseToAnthropic,
  sseTransform: responsesSseToAnthropic
};

function anthropicRequestToChat(body: unknown) {
  const source = cloneRecord(body);
  const request = { ...source };
  request.messages = anthropicMessagesToChatMessages(source);
  if (Array.isArray(source.tools)) request.tools = source.tools.map(anthropicToolToChat);
  if (source.max_tokens !== undefined) request.max_completion_tokens = source.max_tokens;
  else if (source.max_output_tokens !== undefined) request.max_completion_tokens = source.max_output_tokens;
  if (source.stop_sequences !== undefined) request.stop = source.stop_sequences;
  request.tool_choice = anthropicToolChoiceToChat(source.tool_choice);
  delete request.system;
  delete request.max_tokens;
  delete request.max_output_tokens;
  delete request.stop_sequences;
  deleteFields(request, anthropicMessagesFieldsUnsupportedByOpenAI);
  return request;
}

function anthropicRequestToResponses(body: unknown) {
  const source = cloneRecord(body);
  const request = { ...source };
  const messages = anthropicMessagesToChatMessages(source);
  const { instructions, input } = chatMessagesToResponsesInput(messages);
  if (instructions) request.instructions = instructions;
  request.input = input;
  request.stream = true;
  if (Array.isArray(source.tools)) request.tools = source.tools.map(anthropicToolToResponses);
  if (source.max_tokens !== undefined) request.max_output_tokens = source.max_tokens;
  else if (source.max_output_tokens !== undefined) request.max_output_tokens = source.max_output_tokens;
  if (source.stop_sequences !== undefined) request.stop = source.stop_sequences;
  request.tool_choice = anthropicToolChoiceToResponses(source.tool_choice);
  delete request.system;
  delete request.messages;
  delete request.max_tokens;
  delete request.stop_sequences;
  deleteFields(request, anthropicMessagesFieldsUnsupportedByOpenAI);
  return request;
}

function chatRequestToAnthropic(body: unknown) {
  const source = cloneRecord(body);
  const request = { ...source };
  const { system, messages } = chatMessagesToAnthropic(source.messages);
  if (system.length > 0) request.system = system;
  request.messages = messages;
  if (Array.isArray(source.tools)) request.tools = source.tools.map(chatToolToAnthropic);
  request.tool_choice = chatToolChoiceToAnthropic(source.tool_choice);
  if (source.max_completion_tokens !== undefined) request.max_tokens = source.max_completion_tokens;
  else if (source.max_tokens !== undefined) request.max_tokens = source.max_tokens;
  if (source.stop !== undefined) request.stop_sequences = Array.isArray(source.stop) ? source.stop : [source.stop];
  delete request.reasoning_effort;
  delete request.max_completion_tokens;
  delete request.stop;
  deleteFields(request, openAIChatFieldsUnsupportedByAnthropic);
  return request;
}

function responsesRequestToAnthropic(body: unknown) {
  const source = cloneRecord(body);
  const request = { ...source };
  const { system, messages } = responsesInputToAnthropic(source.input, source.instructions);
  if (system.length > 0) request.system = system;
  request.messages = messages;
  if (Array.isArray(source.tools)) request.tools = source.tools.flatMap(responsesToolToAnthropic);
  request.tool_choice = responsesToolChoiceToAnthropic(source.tool_choice);
  if (source.max_output_tokens !== undefined) request.max_tokens = source.max_output_tokens;
  const stop = source.stop ?? source.stop_sequences;
  if (stop !== undefined) request.stop_sequences = Array.isArray(stop) ? stop : [stop];
  delete request.instructions;
  delete request.input;
  delete request.reasoning;
  delete request.stop;
  delete request.max_output_tokens;
  deleteFields(request, openAIResponsesFieldsUnsupportedByAnthropic);
  return request;
}

function anthropicResponseToChat(body: unknown) {
  const source = cloneRecord(body);
  const content = Array.isArray(source.content) ? source.content : [];
  const text = anthropicText(content);
  const toolCalls = anthropicToolCallsToChat(content);
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: typeof source.id === "string" ? source.id.replace(/^msg_/, "chatcmpl_") : "chatcmpl_translated",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: source.model,
    choices: [{
      index: 0,
      message,
      finish_reason: anthropicStopReasonToChat(source.stop_reason)
    }],
    usage: isRecord(source.usage) ? anthropicUsageToChat(source.usage) : undefined
  };
}

function anthropicResponseToResponses(body: unknown) {
  const source = cloneRecord(body);
  const content = Array.isArray(source.content) ? source.content : [];
  const text = anthropicText(content);
  const output: Record<string, unknown>[] = [];
  if (text) {
    output.push({
      id: "msg_translated",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text }]
    });
  }
  for (const block of content) {
    const item = anthropicToolUseToResponses(block);
    if (item) output.push(item);
  }
  return {
    id: typeof source.id === "string" ? source.id.replace(/^msg_/, "resp_") : "resp_translated",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: source.model,
    status: "completed",
    output,
    output_text: text,
    usage: isRecord(source.usage) ? anthropicUsageToResponses(source.usage) : undefined
  };
}

function chatResponseToAnthropic(body: unknown) {
  const source = cloneRecord(body);
  const choice = firstChoice(source.choices);
  const message = isRecord(choice?.message) ? choice.message : {};
  const content = chatAssistantContentToAnthropic(message);
  return {
    id: typeof source.id === "string" ? source.id.replace(/^chatcmpl_/, "msg_") : "msg_translated",
    type: "message",
    role: "assistant",
    model: source.model,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: chatFinishReasonToAnthropic(choice?.finish_reason),
    usage: isRecord(source.usage) ? chatUsageToAnthropic(source.usage) : undefined
  };
}

function responsesResponseToAnthropic(body: unknown) {
  const source = cloneRecord(body);
  const output = Array.isArray(source.output) ? source.output : [];
  const content: Record<string, unknown>[] = [];
  const text = responsesOutputText(source);
  if (text) content.push({ type: "text", text });
  for (const item of output) {
    const block = responsesFunctionCallToAnthropic(item);
    if (block) content.push(block);
  }
  return {
    id: typeof source.id === "string" ? source.id.replace(/^resp_/, "msg_") : "msg_translated",
    type: "message",
    role: "assistant",
    model: source.model,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: isRecord(source.usage) ? responsesUsageToAnthropic(source.usage) : undefined
  };
}

async function* anthropicSseToChat(chunks: AsyncIterable<Uint8Array>) {
  let id = "chatcmpl_translated";
  let model: unknown;
  let usage: Record<string, unknown> = {};
  let sawToolCall = false;
  let finishReason: string | null = null;

  yield* transformSse(chunks, (frame) => {
    const event = parseJsonData(frame);
    if (!isRecord(event)) return [];
    const type = eventType(event, frame);
    const message = isRecord(event.message) ? event.message : undefined;
    if (typeof message?.id === "string") id = message.id.replace(/^msg_/, "chatcmpl_");
    if (message?.model !== undefined) model = message.model;
    if (isRecord(message?.usage)) usage = mergeUsage(usage, anthropicUsageToChat(message.usage));
    if (isRecord(event.usage)) usage = mergeUsage(usage, anthropicUsageToChat(event.usage));

    if (type === "message_start") {
      return [chatChunk(id, model, { role: "assistant" }, null)];
    }
    if (type === "content_block_start" && isRecord(event.content_block)) {
      if (event.content_block.type === "tool_use") {
        sawToolCall = true;
        return [chatChunk(id, model, {
          tool_calls: [{
            index: integerValue(event.index) ?? 0,
            id: stringValue(event.content_block.id),
            type: "function",
            function: { name: stringValue(event.content_block.name), arguments: "" }
          }]
        }, null)];
      }
      return [];
    }
    if (type === "content_block_delta" && isRecord(event.delta)) {
      if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
        return [chatChunk(id, model, { content: event.delta.text }, null)];
      }
      if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
        return [chatChunk(id, model, {
          tool_calls: [{
            index: integerValue(event.index) ?? 0,
            function: { arguments: event.delta.partial_json }
          }]
        }, null)];
      }
    }
    if (type === "message_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      const nextFinishReason = anthropicStopReasonToChat(delta.stop_reason);
      if (nextFinishReason) finishReason = nextFinishReason;
      return [];
    }
    if (type === "message_stop") {
      return [
        chatChunk(id, model, {}, finishReason ?? (sawToolCall ? "tool_calls" : "stop")),
        chatChunk(id, model, {}, null, usage, true),
        formatFrame({ data: "[DONE]" })
      ];
    }
    if (type === "error") return [formatFrame({ data: JSON.stringify({ error: event.error ?? event }) })];
    return [];
  });
}

async function* anthropicSseToResponses(chunks: AsyncIterable<Uint8Array>) {
  let id = "resp_translated";
  let model: unknown;
  let responseCreated = false;
  let messageCreated = false;
  let usage: Record<string, unknown> = {};
  let completed = false;

  const ensureResponseCreated = () => {
    if (responseCreated) return [];
    responseCreated = true;
    return [responsesFrame("response.created", {
      type: "response.created",
      response: { id, model, status: "in_progress" }
    })];
  };

  const ensureMessageCreated = () => {
    const out = ensureResponseCreated();
    if (messageCreated) return out;
    messageCreated = true;
    out.push(responsesFrame("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_translated", type: "message", status: "in_progress", role: "assistant", content: [] }
    }));
    return out;
  };

  yield* transformSse(chunks, (frame) => {
    const event = parseJsonData(frame);
    if (!isRecord(event)) return [];
    const type = eventType(event, frame);
    const message = isRecord(event.message) ? event.message : undefined;
    if (typeof message?.id === "string") id = message.id.replace(/^msg_/, "resp_");
    if (message?.model !== undefined) model = message.model;
    if (isRecord(message?.usage)) usage = mergeUsage(usage, anthropicUsageToResponses(message.usage));
    if (isRecord(event.usage)) usage = mergeUsage(usage, anthropicUsageToResponses(event.usage));

    if (type === "message_start") return ensureResponseCreated();
    if (type === "content_block_start" && isRecord(event.content_block) && event.content_block.type === "tool_use") {
      const decoded = decodeNamespacedToolName(stringValue(event.content_block.name));
      return [
        ...ensureResponseCreated(),
        responsesFrame("response.output_item.added", {
          type: "response.output_item.added",
          output_index: integerValue(event.index) ?? 0,
          item: {
            id: stringValue(event.content_block.id),
            type: "function_call",
            call_id: stringValue(event.content_block.id),
            name: decoded.name,
            ...(decoded.namespace !== undefined ? { namespace: decoded.namespace } : {}),
            arguments: "",
            status: "in_progress"
          }
        })
      ];
    }
    if (type === "content_block_delta" && isRecord(event.delta)) {
      if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
        return [
          ...ensureMessageCreated(),
          responsesFrame("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: "msg_translated",
            output_index: 0,
            content_index: 0,
            delta: event.delta.text
          })
        ];
      }
      if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
        return [responsesFrame("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          output_index: integerValue(event.index) ?? 0,
          delta: event.delta.partial_json
        })];
      }
    }
    if (type === "message_stop" && !completed) {
      completed = true;
      return [
        ...ensureResponseCreated(),
        responsesFrame("response.completed", {
          type: "response.completed",
          response: { id, model, status: "completed", usage }
        })
      ];
    }
    if (type === "error") {
      return [responsesFrame("error", { type: "error", error: event.error ?? event })];
    }
    return [];
  });
}

async function* chatSseToAnthropic(chunks: AsyncIterable<Uint8Array>) {
  let id = "msg_translated";
  let model: unknown;
  let messageStarted = false;
  let textBlockStarted = false;
  let completed = false;
  let finishReason = "end_turn";
  const openBlockIndexes = new Set<number>();

  const ensureMessageStart = () => {
    if (messageStarted) return [];
    messageStarted = true;
    return [anthropicFrame("message_start", {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } }
    })];
  };
  const closeOpenContentBlocks = () => {
    const out = [...openBlockIndexes]
      .sort((left, right) => left - right)
      .map((index) => anthropicFrame("content_block_stop", { type: "content_block_stop", index }));
    openBlockIndexes.clear();
    return out;
  };
  const terminalFrames = (usage?: Record<string, unknown>) => [
    ...ensureMessageStart(),
    ...closeOpenContentBlocks(),
    anthropicFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: finishReason, stop_sequence: null },
      ...(usage ? { usage } : {})
    }),
    anthropicFrame("message_stop", { type: "message_stop" })
  ];

  yield* transformSse(chunks, (frame) => {
    if (frame.data === "[DONE]") {
      if (completed) return [];
      completed = true;
      return terminalFrames();
    }
    const event = parseJsonData(frame);
    if (!isRecord(event)) return [];
    if (typeof event.id === "string") id = event.id.replace(/^chatcmpl_/, "msg_");
    if (event.model !== undefined) model = event.model;
    if (isRecord(event.usage)) {
      if (completed) return [];
      completed = true;
      return terminalFrames(chatUsageToAnthropic(event.usage));
    }
    const out = ensureMessageStart();
    const choices = Array.isArray(event.choices) ? event.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (!textBlockStarted) {
          textBlockStarted = true;
          out.push(anthropicFrame("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" }
          }));
          openBlockIndexes.add(0);
        }
        out.push(anthropicFrame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta.content }
        }));
      }
      pushChatToolDeltasAsAnthropic(out, delta.tool_calls, openBlockIndexes);
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = chatFinishReasonToAnthropic(choice.finish_reason);
      }
    }
    return out;
  });
}

async function* responsesSseToAnthropic(chunks: AsyncIterable<Uint8Array>) {
  let id = "msg_translated";
  let model: unknown;
  let messageStarted = false;
  let textBlockStarted = false;
  const openBlockIndexes = new Set<number>();

  const ensureMessageStart = () => {
    if (messageStarted) return [];
    messageStarted = true;
    return [anthropicFrame("message_start", {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } }
    })];
  };
  const closeOpenContentBlocks = () => {
    const out = [...openBlockIndexes]
      .sort((left, right) => left - right)
      .map((index) => anthropicFrame("content_block_stop", { type: "content_block_stop", index }));
    openBlockIndexes.clear();
    return out;
  };

  yield* transformSse(chunks, (frame) => {
    const event = parseJsonData(frame);
    if (!isRecord(event)) return [];
    const type = eventType(event, frame);
    const response = isRecord(event.response) ? event.response : undefined;
    if (typeof response?.id === "string") id = response.id.replace(/^resp_/, "msg_");
    if (response?.model !== undefined) model = response.model;
    if (type === "response.created") return ensureMessageStart();
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      const out = ensureMessageStart();
      if (!textBlockStarted) {
        textBlockStarted = true;
        out.push(anthropicFrame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" }
        }));
        openBlockIndexes.add(0);
      }
      out.push(anthropicFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: event.delta }
      }));
      return out;
    }
    if (type === "response.output_item.added" && isRecord(event.item) && event.item.type === "function_call") {
      const outputIndex = integerValue(event.output_index) ?? 0;
      openBlockIndexes.add(outputIndex);
      return [
        ...ensureMessageStart(),
        anthropicFrame("content_block_start", {
          type: "content_block_start",
          index: outputIndex,
          content_block: {
            type: "tool_use",
            id: stringValue(event.item.id) ?? stringValue(event.item.call_id),
            name: stringValue(event.item.name),
            input: {}
          }
        })
      ];
    }
    if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      return [anthropicFrame("content_block_delta", {
        type: "content_block_delta",
        index: integerValue(event.output_index) ?? 0,
        delta: { type: "input_json_delta", partial_json: event.delta }
      })];
    }
    if (type === "response.completed") {
      return [
        ...ensureMessageStart(),
        ...closeOpenContentBlocks(),
        anthropicFrame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: isRecord(response?.usage) ? responsesUsageToAnthropic(response.usage) : undefined
        }),
        anthropicFrame("message_stop", { type: "message_stop" })
      ];
    }
    if (type === "response.failed" || type === "error") {
      return [anthropicFrame("error", { type: "error", error: event.error ?? event })];
    }
    return [];
  });
}

function anthropicMessagesToChatMessages(source: Record<string, unknown>) {
  const messages: Record<string, unknown>[] = [];
  appendAnthropicSystem(messages, source.system);
  if (!Array.isArray(source.messages)) return messages;
  for (const message of source.messages) {
    if (!isRecord(message)) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    if (role === "assistant") {
      messages.push(anthropicAssistantToChat(message));
    } else {
      messages.push(...anthropicUserToChatMessages(message));
    }
  }
  return messages.filter((message) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
    if (message.role === "tool") return true;
    return textContent(message.content).length > 0 || Array.isArray(message.content);
  });
}

function appendAnthropicSystem(messages: Record<string, unknown>[], system: unknown) {
  if (typeof system === "string" && system.trim()) {
    messages.push({ role: "system", content: system });
    return;
  }
  if (!Array.isArray(system)) return;
  const parts = system.map((part) => textContent(part)).filter(Boolean);
  if (parts.length > 0) messages.push({ role: "system", content: parts.join("\n\n") });
}

function anthropicUserToChatMessages(message: Record<string, unknown>) {
  const content = message.content;
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content)) return [];
  const messages: Record<string, unknown>[] = [];
  const parts: Record<string, unknown>[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_result") {
      if (parts.length > 0) {
        messages.push({ role: "user", content: collapseChatContent(parts) });
        parts.length = 0;
      }
      messages.push({
        role: "tool",
        tool_call_id: stringValue(block.tool_use_id),
        content: textContent(block.content)
      });
      continue;
    }
    const part = anthropicContentToChat(block);
    if (part) parts.push(part);
  }
  if (parts.length > 0) messages.push({ role: "user", content: collapseChatContent(parts) });
  return messages;
}

function anthropicAssistantToChat(message: Record<string, unknown>) {
  const content = Array.isArray(message.content) ? message.content : [];
  const texts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    if (block.type === "tool_use") {
      toolCalls.push({
        id: stringValue(block.id),
        type: "function",
        function: {
          name: stringValue(block.name),
          arguments: jsonArguments(block.input)
        }
      });
    }
  }
  const out: Record<string, unknown> = { role: "assistant", content: texts.join("") || null };
  if (toolCalls.length > 0) out.tool_calls = toolCalls;
  return out;
}

function anthropicContentToChat(block: Record<string, unknown>) {
  if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
  if (block.type === "image" && isRecord(block.source)) {
    if (block.source.type === "url" && typeof block.source.url === "string") {
      return { type: "image_url", image_url: { url: block.source.url } };
    }
    if (block.source.type === "base64" && typeof block.source.media_type === "string" && typeof block.source.data === "string") {
      return { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
    }
  }
  return undefined;
}

function collapseChatContent(parts: Record<string, unknown>[]) {
  return parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts;
}

function chatMessagesToAnthropic(messages: unknown) {
  const system: Record<string, unknown>[] = [];
  const out: Record<string, unknown>[] = [];
  if (!Array.isArray(messages)) return { system, messages: out };
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = stringValue(message.role);
    if (role === "system" || role === "developer") {
      const text = textContent(message.content);
      if (text) system.push({ type: "text", text });
      continue;
    }
    if (role === "tool") {
      out.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: stringValue(message.tool_call_id) ?? stringValue(message.id),
          content: textContent(message.content)
        }]
      });
      continue;
    }
    if (role === "assistant") {
      const content = chatAssistantContentToAnthropic(message);
      if (content.length > 0) out.push({ role: "assistant", content });
      continue;
    }
    const content = chatContentToAnthropic(message.content);
    if (content.length > 0) out.push({ role: "user", content });
  }
  return { system, messages: out };
}

function responsesInputToAnthropic(input: unknown, instructions: unknown) {
  const system: Record<string, unknown>[] = [];
  const instructionText = textContent(instructions);
  if (instructionText) system.push({ type: "text", text: instructionText });
  const messages: Record<string, unknown>[] = [];
  if (typeof input === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: input }] });
    return { system, messages };
  }
  if (!Array.isArray(input)) return { system, messages };
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.type === "function_call") {
      const block = responsesFunctionCallToAnthropic(item);
      if (block) messages.push({ role: "assistant", content: [block] });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: stringValue(item.call_id) ?? stringValue(item.id),
          content: textContent(item.output)
        }]
      });
      continue;
    }
    const role = item.role === "assistant" ? "assistant" : "user";
    if (role === "assistant") {
      const content = responsesAssistantContentToAnthropic(item);
      if (content.length > 0) messages.push({ role, content });
      continue;
    }
    if (item.role === "system" || item.role === "developer") {
      const text = textContent(item.content ?? item.text);
      if (text) system.push({ type: "text", text });
      continue;
    }
    const content = responsesContentToAnthropic(item.content ?? item.text ?? item.input, "user");
    if (content.length > 0) messages.push({ role: "user", content });
  }
  return { system, messages };
}

function chatMessagesToResponsesInput(messages: Record<string, unknown>[]) {
  const instructionParts: string[] = [];
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    const role = stringValue(message.role) ?? "user";
    if (role === "system" || role === "developer") {
      const content = textContent(message.content);
      if (content) instructionParts.push(content);
      continue;
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: stringValue(message.tool_call_id) ?? stringValue(message.id),
        output: textContent(message.content)
      });
      continue;
    }
    const content = chatContentToResponses(message.content, role);
    if (content.length > 0) input.push({ type: "message", role, content });
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const mapped = chatToolCallToResponses(toolCall);
        if (mapped) input.push(mapped);
      }
    }
  }
  return { instructions: instructionParts.join("\n\n"), input };
}

function chatContentToAnthropic(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) {
    const text = textContent(content);
    return text ? [{ type: "text", text }] : [];
  }
  return content.map((part) => {
    if (!isRecord(part)) return { type: "text", text: textContent(part) };
    if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
      return anthropicImageBlockFromUrl(part.image_url.url);
    }
    return { type: "text", text: textContent(part) };
  });
}

function responsesContentToAnthropic(content: unknown, role: "user" | "assistant"): Record<string, unknown>[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) {
    const text = textContent(content);
    return text ? [{ type: "text", text }] : [];
  }
  return content.map((part) => {
    if (!isRecord(part)) return { type: "text", text: textContent(part) };
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
      return { type: "text", text: part.text };
    }
    if (role === "user" && part.type === "input_image") {
      const url = imageUrl(part.image_url);
      if (url) return anthropicImageBlockFromUrl(url);
    }
    return { type: "text", text: textContent(part) };
  });
}

function imageUrl(value: unknown) {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.url === "string") return value.url;
  return undefined;
}

function anthropicImageBlockFromUrl(url: string) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (match) return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  return { type: "image", source: { type: "url", url } };
}

function chatContentToResponses(content: unknown, role: string) {
  if (typeof content === "string") return content ? [{ type: role === "assistant" ? "output_text" : "input_text", text: content }] : [];
  if (!Array.isArray(content)) {
    const text = textContent(content);
    return text ? [{ type: role === "assistant" ? "output_text" : "input_text", text }] : [];
  }
  return content.map((part) => {
    if (!isRecord(part)) return { type: "input_text", text: textContent(part) };
    if (part.type === "text" && typeof part.text === "string") {
      return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
    }
    if (part.type === "image_url" && part.image_url !== undefined) return { type: "input_image", image_url: part.image_url };
    return part;
  });
}

function responsesAssistantContentToAnthropic(item: Record<string, unknown>) {
  return responsesContentToAnthropic(item.content ?? item.text ?? item.output_text, "assistant");
}

function chatAssistantContentToAnthropic(message: Record<string, unknown>) {
  const content = chatContentToAnthropic(message.content);
  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const mapped = chatToolCallToAnthropic(toolCall);
      if (mapped) content.push(mapped);
    }
  }
  return content;
}

function anthropicToolToChat(tool: unknown) {
  if (!isRecord(tool)) return tool;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }
  };
}

function anthropicToolToResponses(tool: unknown) {
  if (!isRecord(tool)) return tool;
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema
  };
}

function chatToolToAnthropic(tool: unknown) {
  if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) return tool;
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  };
}

// Codex groups tools under `type: "namespace"` containers and routes calls back
// using a separate `namespace` field on each function_call. Anthropic tools are
// flat, so we flatten namespaced sub-tools into individual tools whose names
// encode the namespace, then split the namespace back out when translating the
// response. The encoding is length-prefixed so the split is unambiguous even
// though both the namespace and tool name can contain `_`/`-`.
const NAMESPACED_TOOL_PREFIX = "ns_";
const MAX_ANTHROPIC_TOOL_NAME_LENGTH = 128;

function encodeNamespacedToolName(namespace: string, name: string) {
  return `${NAMESPACED_TOOL_PREFIX}${namespace.length}_${namespace}${name}`;
}

function decodeNamespacedToolName(encoded: string | undefined): { namespace?: string; name: string | undefined } {
  if (typeof encoded !== "string") return { name: encoded };
  const match = /^ns_(\d+)_([\s\S]+)$/.exec(encoded);
  if (!match) return { name: encoded };
  const length = Number(match[1]);
  const rest = match[2];
  if (!Number.isInteger(length) || length <= 0 || length >= rest.length) return { name: encoded };
  return { namespace: rest.slice(0, length), name: rest.slice(length) };
}

function responsesToolToAnthropic(tool: unknown): Record<string, unknown>[] {
  if (!isRecord(tool)) return [];
  if (tool.type === "function") {
    return [{ name: tool.name, description: tool.description, input_schema: tool.parameters }];
  }
  if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
    const namespace = tool.name;
    return tool.tools.flatMap((sub) => {
      if (!isRecord(sub) || sub.type !== "function" || typeof sub.name !== "string") return [];
      const name = encodeNamespacedToolName(namespace, sub.name);
      // Anthropic caps tool names at 128 chars; drop rather than let the whole
      // request fail if a long namespace + sub-tool name overflows the cap.
      if (name.length > MAX_ANTHROPIC_TOOL_NAME_LENGTH) return [];
      return [{ name, description: sub.description, input_schema: sub.parameters }];
    });
  }
  // Provider-hosted/special Codex tools that Anthropic cannot execute
  // (web_search, image_generation, local_shell, tool_search, custom/freeform).
  // Drop them so the request stays valid; the model simply won't call them.
  return [];
}

function anthropicToolChoiceToChat(choice: unknown) {
  if (!isRecord(choice)) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function anthropicToolChoiceToResponses(choice: unknown) {
  if (!isRecord(choice)) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", name: choice.name };
  }
  return undefined;
}

function chatToolChoiceToAnthropic(choice: unknown) {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (isRecord(choice) && choice.type === "function" && isRecord(choice.function) && typeof choice.function.name === "string") {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

function responsesToolChoiceToAnthropic(choice: unknown) {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (isRecord(choice) && choice.type === "function" && typeof choice.name === "string") {
    return { type: "tool", name: choice.name };
  }
  if (isRecord(choice) && choice.type === "function" && isRecord(choice.function) && typeof choice.function.name === "string") {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

function chatToolCallToAnthropic(toolCall: unknown) {
  if (!isRecord(toolCall)) return undefined;
  const fn = isRecord(toolCall.function) ? toolCall.function : {};
  return {
    type: "tool_use",
    id: stringValue(toolCall.id),
    name: stringValue(fn.name),
    input: parseMaybeJson(fn.arguments)
  };
}

function chatToolCallToResponses(toolCall: unknown) {
  if (!isRecord(toolCall)) return undefined;
  const fn = isRecord(toolCall.function) ? toolCall.function : {};
  return {
    id: stringValue(toolCall.id),
    type: "function_call",
    call_id: stringValue(toolCall.id),
    name: stringValue(fn.name),
    arguments: stringValue(fn.arguments) ?? ""
  };
}

function responsesFunctionCallToAnthropic(item: unknown) {
  if (!isRecord(item) || item.type !== "function_call") return undefined;
  const namespace = stringValue(item.namespace);
  const name = stringValue(item.name);
  return {
    type: "tool_use",
    id: stringValue(item.call_id) ?? stringValue(item.id),
    name: namespace && name ? encodeNamespacedToolName(namespace, name) : name,
    input: parseMaybeJson(item.arguments)
  };
}

function anthropicToolUseToResponses(block: unknown) {
  if (!isRecord(block) || block.type !== "tool_use") return undefined;
  const decoded = decodeNamespacedToolName(stringValue(block.name));
  return {
    id: stringValue(block.id),
    type: "function_call",
    call_id: stringValue(block.id),
    name: decoded.name,
    ...(decoded.namespace !== undefined ? { namespace: decoded.namespace } : {}),
    arguments: jsonArguments(block.input)
  };
}

function anthropicToolCallsToChat(content: unknown[]) {
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "tool_use")
    .map((block) => ({
      id: stringValue(block.id),
      type: "function",
      function: {
        name: stringValue(block.name),
        arguments: jsonArguments(block.input)
      }
    }));
}

function anthropicText(content: unknown[]) {
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function responsesOutputText(source: Record<string, unknown>) {
  if (typeof source.output_text === "string") return source.output_text;
  const output = Array.isArray(source.output) ? source.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!isRecord(block)) continue;
      if ((block.type === "output_text" || block.type === "text") && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("");
}

function anthropicUsageToChat(usage: Record<string, unknown>) {
  const promptTokens = numberValue(usage.input_tokens);
  const completionTokens = numberValue(usage.output_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined,
    prompt_tokens_details: usage.cache_read_input_tokens === undefined ? undefined : { cached_tokens: usage.cache_read_input_tokens }
  };
}

function anthropicUsageToResponses(usage: Record<string, unknown>) {
  const inputTokens = numberValue(usage.input_tokens);
  const outputTokens = numberValue(usage.output_tokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined,
    input_tokens_details: usage.cache_read_input_tokens === undefined ? undefined : { cached_tokens: usage.cache_read_input_tokens },
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens
  };
}

function chatUsageToAnthropic(usage: Record<string, unknown>) {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    cache_read_input_tokens: isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cached_tokens : undefined
  };
}

function responsesUsageToAnthropic(usage: Record<string, unknown>) {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: isRecord(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : undefined
  };
}

function mergeUsage(left: Record<string, unknown>, right: Record<string, unknown>) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value !== undefined) merged[key] = value;
  }
  const promptTokens = numberValue(merged.prompt_tokens);
  const completionTokens = numberValue(merged.completion_tokens);
  if (promptTokens !== undefined && completionTokens !== undefined) {
    merged.total_tokens = promptTokens + completionTokens;
  }
  const inputTokens = numberValue(merged.input_tokens);
  const outputTokens = numberValue(merged.output_tokens);
  if (inputTokens !== undefined && outputTokens !== undefined) {
    merged.total_tokens = inputTokens + outputTokens;
  }
  return merged;
}

function anthropicStopReasonToChat(value: unknown) {
  if (value === "tool_use") return "tool_calls";
  if (value === "max_tokens") return "length";
  if (value === "content_filter") return "content_filter";
  if (value === "end_turn") return "stop";
  return null;
}

function chatFinishReasonToAnthropic(value: unknown) {
  if (value === "tool_calls") return "tool_use";
  if (value === "length") return "max_tokens";
  if (value === "content_filter") return "content_filter";
  return "end_turn";
}

function chatChunk(
  id: string,
  model: unknown,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: Record<string, unknown>,
  emptyChoices = false
) {
  return formatFrame({
    data: JSON.stringify({
      id,
      object: "chat.completion.chunk",
      model,
      choices: emptyChoices ? [] : [{ index: 0, delta, finish_reason: finishReason }],
      usage: usage ?? null
    })
  });
}

function responsesFrame(event: string, data: Record<string, unknown>) {
  return sseFrame(event, data);
}

function anthropicFrame(event: string, data: Record<string, unknown>) {
  return sseFrame(event, data);
}

function pushChatToolDeltasAsAnthropic(out: string[], toolCalls: unknown, openBlockIndexes: Set<number>) {
  if (!Array.isArray(toolCalls)) return;
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall)) continue;
    const index = integerValue(toolCall.index) ?? 0;
    const fn = isRecord(toolCall.function) ? toolCall.function : {};
    if (fn.name && !openBlockIndexes.has(index)) {
      openBlockIndexes.add(index);
      out.push(anthropicFrame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: stringValue(toolCall.id),
          name: stringValue(fn.name),
          input: {}
        }
      }));
    }
    if (typeof fn.arguments === "string" && fn.arguments.length > 0 && openBlockIndexes.has(index)) {
      out.push(anthropicFrame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: fn.arguments }
      }));
    }
  }
}

function deleteFields(record: Record<string, unknown>, fields: readonly string[]) {
  for (const field of fields) delete record[field];
}
