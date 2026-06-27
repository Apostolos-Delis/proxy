import type { DialectTranslator } from "./index.js";
import {
  cloneRecord,
  eventType,
  firstChoice,
  formatFrame,
  integerValue,
  parseJsonData,
  stringValue,
  textContent,
  transformSse
} from "./canonical.js";
import { isRecord } from "../util.js";

export const openAIResponsesToChat: DialectTranslator = {
  request: responsesRequestToChat,
  response: responsesResponseToChat,
  sseTransform: responsesSseToChat
};

export const openAIChatToResponses: DialectTranslator = {
  request: chatRequestToResponses,
  response: chatResponseToResponses,
  sseTransform: chatSseToResponses
};

function responsesRequestToChat(body: unknown) {
  const source = cloneRecord(body);
  const request = { ...source };
  const instructions = typeof source.instructions === "string" ? source.instructions : undefined;
  request.messages = responsesInputToMessages(source.input, instructions);
  if (Array.isArray(source.tools)) request.tools = source.tools.map(responsesToolToChat);
  if (isRecord(source.reasoning) && typeof source.reasoning.effort === "string") {
    request.reasoning_effort = source.reasoning.effort;
  }
  if (source.max_output_tokens !== undefined) request.max_completion_tokens = source.max_output_tokens;
  delete request.instructions;
  delete request.input;
  delete request.reasoning;
  delete request.max_output_tokens;
  delete request.text;
  return request;
}

function chatRequestToResponses(body: unknown) {
  const source = cloneRecord(body);
  const request = { ...source };
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const { instructions, input } = chatMessagesToResponsesInput(messages, source.instructions);
  if (instructions) request.instructions = instructions;
  request.input = input;
  if (Array.isArray(source.tools)) request.tools = source.tools.map(chatToolToResponses);
  if (typeof source.reasoning_effort === "string") {
    request.reasoning = {
      ...(isRecord(source.reasoning) ? source.reasoning : {}),
      effort: source.reasoning_effort
    };
  }
  if (source.max_completion_tokens !== undefined) request.max_output_tokens = source.max_completion_tokens;
  delete request.messages;
  delete request.reasoning_effort;
  delete request.max_completion_tokens;
  delete request.stream_options;
  return request;
}

function responsesResponseToChat(body: unknown) {
  const source = cloneRecord(body);
  const output = Array.isArray(source.output) ? source.output : [];
  const content = responsesOutputText(source);
  const toolCalls = responsesOutputToolCalls(output);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: typeof source.id === "string" ? source.id.replace(/^resp_/, "chatcmpl_") : "chatcmpl_translated",
    object: "chat.completion",
    created: typeof source.created_at === "number" ? source.created_at : Math.floor(Date.now() / 1000),
    model: source.model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
    }],
    usage: isRecord(source.usage) ? responsesUsageToChat(source.usage) : undefined
  };
}

function chatResponseToResponses(body: unknown) {
  const source = cloneRecord(body);
  const choice = firstChoice(source.choices);
  const message = isRecord(choice?.message) ? choice.message : {};
  const content = textContent(message.content);
  const output: Record<string, unknown>[] = [];
  if (content) {
    output.push({
      id: "msg_translated",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content }]
    });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const mapped = chatToolCallToResponsesOutput(toolCall);
      if (mapped) output.push(mapped);
    }
  }
  return {
    id: typeof source.id === "string" ? source.id.replace(/^chatcmpl_/, "resp_") : "resp_translated",
    object: "response",
    created_at: source.created,
    model: source.model,
    status: "completed",
    output,
    output_text: content,
    usage: isRecord(source.usage) ? chatUsageToResponses(source.usage) : undefined
  };
}

async function* responsesSseToChat(chunks: AsyncIterable<Uint8Array>) {
  let responseId = "chatcmpl_translated";
  let model: unknown;
  let sawToolCall = false;

  yield* transformSse(chunks, (frame) => {
    if (frame.data === "[DONE]") return [formatFrame({ data: "[DONE]" })];
    const event = parseJsonData(frame);
    if (!isRecord(event)) return [];
    const type = eventType(event, frame);
    const response = isRecord(event.response) ? event.response : undefined;
    if (typeof response?.id === "string") responseId = response.id.replace(/^resp_/, "chatcmpl_");
    if (response?.model !== undefined) model = response.model;

    if (type === "response.created") {
      return [chatChunk(responseId, model, { role: "assistant" }, null)];
    }
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      return [chatChunk(responseId, model, { content: event.delta }, null)];
    }
    if (type === "response.output_item.added" && isRecord(event.item) && event.item.type === "function_call") {
      sawToolCall = true;
      const outputIndex = integerValue(event.output_index) ?? integerValue(event.item.output_index) ?? 0;
      return [chatChunk(responseId, model, {
        tool_calls: [{
          index: outputIndex,
          id: stringValue(event.item.id) ?? stringValue(event.item.call_id),
          type: "function",
          function: {
            name: stringValue(event.item.name),
            arguments: ""
          }
        }]
      }, null)];
    }
    if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const outputIndex = integerValue(event.output_index) ?? 0;
      return [chatChunk(responseId, model, {
        tool_calls: [{
          index: outputIndex,
          function: { arguments: event.delta }
        }]
      }, null)];
    }
    if (type === "response.completed") {
      const usage = isRecord(response?.usage) ? responsesUsageToChat(response.usage) : undefined;
      return [
        chatChunk(responseId, model, {}, sawToolCall ? "tool_calls" : "stop"),
        chatChunk(responseId, model, {}, null, usage, true),
        formatFrame({ data: "[DONE]" })
      ];
    }
    if (type === "response.failed" || type === "error") {
      return [formatFrame({ data: JSON.stringify({ error: event.error ?? event }) })];
    }
    return [];
  });
}

async function* chatSseToResponses(chunks: AsyncIterable<Uint8Array>) {
  let responseId = "resp_translated";
  let model: unknown;
  let responseCreated = false;
  let messageCreated = false;
  let completed = false;
  const toolIdsByIndex = new Map<number, string>();

  const ensureResponseCreated = () => {
    if (responseCreated) return [];
    responseCreated = true;
    return [responsesFrame("response.created", {
      type: "response.created",
      response: { id: responseId, model, status: "in_progress" }
    })];
  };

  yield* transformSse(chunks, (frame) => {
    if (frame.data === "[DONE]") {
      if (completed) return [];
      completed = true;
      return [responsesFrame("response.completed", {
        type: "response.completed",
        response: { id: responseId, model, status: "completed" }
      })];
    }
    const event = parseJsonData(frame);
    if (!isRecord(event)) return [];
    if (typeof event.id === "string") responseId = event.id.replace(/^chatcmpl_/, "resp_");
    if (event.model !== undefined) model = event.model;
    const out = ensureResponseCreated();

    if (isRecord(event.usage)) {
      completed = true;
      out.push(responsesFrame("response.completed", {
        type: "response.completed",
        response: {
          id: responseId,
          model,
          status: "completed",
          usage: chatUsageToResponses(event.usage)
        }
      }));
      return out;
    }

    const choices = Array.isArray(event.choices) ? event.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string") {
        if (!messageCreated) {
          messageCreated = true;
          out.push(responsesFrame("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "msg_translated",
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: []
            }
          }));
        }
        out.push(responsesFrame("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: "msg_translated",
          output_index: 0,
          content_index: 0,
          delta: delta.content
        }));
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          if (!isRecord(toolCall)) continue;
          const index = integerValue(toolCall.index) ?? 0;
          const fn = isRecord(toolCall.function) ? toolCall.function : {};
          const toolId = stringValue(toolCall.id) ?? toolIdsByIndex.get(index) ?? `call_${index}`;
          if (!toolIdsByIndex.has(index)) {
            toolIdsByIndex.set(index, toolId);
            out.push(responsesFrame("response.output_item.added", {
              type: "response.output_item.added",
              output_index: index,
              item: {
                id: toolId,
                type: "function_call",
                call_id: toolId,
                name: stringValue(fn.name),
                arguments: "",
                status: "in_progress"
              }
            }));
          }
          if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
            out.push(responsesFrame("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              output_index: index,
              item_id: toolId,
              delta: fn.arguments
            }));
          }
        }
      }
    }
    return out;
  });
}

function responsesInputToMessages(input: unknown, instructions: string | undefined) {
  const messages: Record<string, unknown>[] = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [responsesFunctionCallToChat(item)]
      });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: stringValue(item.call_id) ?? stringValue(item.id),
        content: textContent(item.output)
      });
      continue;
    }
    const role = typeof item.role === "string" ? item.role : "user";
    messages.push({
      role,
      content: responsesContentToChat(item.content ?? item.text ?? item.input)
    });
  }
  return messages;
}

function chatMessagesToResponsesInput(messages: unknown[], existingInstructions: unknown) {
  const instructionParts = typeof existingInstructions === "string" && existingInstructions.trim()
    ? [existingInstructions]
    : [];
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = typeof message.role === "string" ? message.role : "user";
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
    if (content.length > 0) {
      input.push({
        type: "message",
        role,
        content
      });
    }
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const mapped = chatToolCallToResponsesOutput(toolCall);
        if (mapped) input.push(mapped);
      }
    }
  }
  return {
    instructions: instructionParts.join("\n\n"),
    input
  };
}

function responsesToolToChat(tool: unknown) {
  if (!isRecord(tool) || tool.type !== "function") return tool;
  if (isRecord(tool.function)) return tool;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  };
}

function chatToolToResponses(tool: unknown) {
  if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) return tool;
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  };
}

function responsesContentToChat(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textContent(content);
  return content.map((part) => {
    if (!isRecord(part)) return { type: "text", text: textContent(part) };
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
      return { type: "text", text: part.text };
    }
    if (part.type === "input_image" && part.image_url !== undefined) {
      return { type: "image_url", image_url: part.image_url };
    }
    return part;
  });
}

function chatContentToResponses(content: unknown, role: string) {
  if (typeof content === "string") {
    return [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
  }
  if (!Array.isArray(content)) {
    const text = textContent(content);
    return text ? [{ type: role === "assistant" ? "output_text" : "input_text", text }] : [];
  }
  return content.map((part) => {
    if (!isRecord(part)) return { type: "input_text", text: textContent(part) };
    if (part.type === "text" && typeof part.text === "string") {
      return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
    }
    if (part.type === "image_url" && part.image_url !== undefined) {
      return { type: "input_image", image_url: part.image_url };
    }
    return part;
  });
}

function responsesFunctionCallToChat(item: Record<string, unknown>) {
  return {
    id: stringValue(item.id) ?? stringValue(item.call_id),
    type: "function",
    function: {
      name: stringValue(item.name),
      arguments: stringValue(item.arguments) ?? ""
    }
  };
}

function chatToolCallToResponsesOutput(toolCall: unknown) {
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

function responsesOutputText(source: Record<string, unknown>) {
  if (typeof source.output_text === "string") return source.output_text;
  const output = Array.isArray(source.output) ? source.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!isRecord(block)) continue;
      if ((block.type === "output_text" || block.type === "text") && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  return parts.join("\n");
}

function responsesOutputToolCalls(output: unknown[]) {
  return output
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "function_call")
    .map(responsesFunctionCallToChat);
}

function responsesUsageToChat(usage: Record<string, unknown>) {
  return {
    prompt_tokens: usage.input_tokens,
    prompt_tokens_details: usage.input_tokens_details,
    completion_tokens: usage.output_tokens,
    completion_tokens_details: usage.output_tokens_details,
    total_tokens: usage.total_tokens
  };
}

function chatUsageToResponses(usage: Record<string, unknown>) {
  return {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: usage.prompt_tokens_details,
    output_tokens: usage.completion_tokens,
    output_tokens_details: usage.completion_tokens_details,
    total_tokens: usage.total_tokens
  };
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
      choices: emptyChoices
        ? []
        : [{ index: 0, delta, finish_reason: finishReason }],
      usage: usage ?? null
    })
  });
}

function responsesFrame(event: string, data: Record<string, unknown>) {
  return formatFrame({
    event,
    data: JSON.stringify(data)
  });
}
