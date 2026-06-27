import {
  formatFrame,
  integerValue,
  sseFrame,
  stringValue
} from "./canonical.js";
import { isRecord } from "../util.js";
import {
  bedrockConverseErrorToAnthropicMessages,
  bedrockConverseErrorToOpenAI,
  bedrockIncompleteReason,
  bedrockStopReasonToAnthropic,
  bedrockStopReasonToChat,
  bedrockUsageToAnthropic,
  bedrockUsageToChat,
  bedrockUsageToResponses
} from "./bedrockConverseResponse.js";

export async function* bedrockConverseStreamToOpenAIChatSse(events: AsyncIterable<unknown>) {
  const encoder = new TextEncoder();
  const state = {
    finished: false,
    stopReason: undefined as unknown,
    usage: undefined as Record<string, unknown> | undefined
  };

  for await (const event of events) {
    const frames = openAIChatFramesForBedrockEvent(event, state);
    for (const frame of frames) yield encoder.encode(frame);
    if (state.finished) return;
  }
  for (const frame of terminalOpenAIChatFrames(state)) yield encoder.encode(frame);
}

export async function* bedrockConverseStreamToOpenAIResponsesSse(events: AsyncIterable<unknown>) {
  const encoder = new TextEncoder();
  const state = {
    responseCreated: false,
    completed: false,
    finished: false,
    stopReason: undefined as unknown,
    usage: undefined as Record<string, unknown> | undefined,
    textItems: new Set<number>(),
    toolIdsByIndex: new Map<number, string>()
  };

  for await (const event of events) {
    const frames = openAIResponsesFramesForBedrockEvent(event, state);
    for (const frame of frames) yield encoder.encode(frame);
    if (state.finished) return;
  }
  for (const frame of terminalOpenAIResponsesFrames(state)) yield encoder.encode(frame);
}

export async function* bedrockConverseStreamToAnthropicMessagesSse(events: AsyncIterable<unknown>) {
  const encoder = new TextEncoder();
  const state = {
    messageStarted: false,
    completed: false,
    finished: false,
    stopReason: undefined as unknown,
    usage: undefined as Record<string, unknown> | undefined,
    openBlocks: new Set<number>()
  };

  for await (const event of events) {
    const frames = anthropicMessagesFramesForBedrockEvent(event, state);
    for (const frame of frames) yield encoder.encode(frame);
    if (state.finished) return;
  }
  for (const frame of terminalAnthropicMessagesFrames(state)) yield encoder.encode(frame);
}

function openAIChatFramesForBedrockEvent(
  event: unknown,
  state: { finished: boolean; stopReason: unknown; usage?: Record<string, unknown> }
) {
  const source = isRecord(event) ? event : {};
  const exception = bedrockStreamException(source);
  if (exception) {
    state.finished = true;
    return [formatFrame({ data: JSON.stringify(bedrockConverseErrorToOpenAI(exception)) })];
  }
  if (isRecord(source.messageStart)) return [openAIChatChunk({ role: "assistant" }, null)];
  if (isRecord(source.contentBlockStart)) {
    const start = isRecord(source.contentBlockStart.start) ? source.contentBlockStart.start : {};
    const toolUse = isRecord(start.toolUse) ? start.toolUse : undefined;
    if (!toolUse) return [];
    return [openAIChatChunk({
      tool_calls: [{
        index: integerValue(source.contentBlockStart.contentBlockIndex) ?? 0,
        id: stringValue(toolUse.toolUseId),
        type: "function",
        function: { name: stringValue(toolUse.name), arguments: "" }
      }]
    }, null)];
  }
  if (isRecord(source.contentBlockDelta)) {
    const delta = isRecord(source.contentBlockDelta.delta) ? source.contentBlockDelta.delta : {};
    if (typeof delta.text === "string") return [openAIChatChunk({ content: delta.text }, null)];
    const toolUse = isRecord(delta.toolUse) ? delta.toolUse : undefined;
    if (typeof toolUse?.input === "string") {
      return [openAIChatChunk({
        tool_calls: [{
          index: integerValue(source.contentBlockDelta.contentBlockIndex) ?? 0,
          function: { arguments: toolUse.input }
        }]
      }, null)];
    }
  }
  if (isRecord(source.messageStop)) {
    state.stopReason = source.messageStop.stopReason;
    return [openAIChatChunk({}, bedrockStopReasonToChat(state.stopReason))];
  }
  if (isRecord(source.metadata)) {
    if (isRecord(source.metadata.usage)) state.usage = bedrockUsageToChat(source.metadata.usage);
    state.finished = true;
    return [
      openAIChatChunk({}, null, state.usage, true),
      formatFrame({ data: "[DONE]" })
    ];
  }
  return [];
}

function terminalOpenAIChatFrames(state: { finished: boolean; usage?: Record<string, unknown> }) {
  if (state.finished) return [];
  state.finished = true;
  return [
    openAIChatChunk({}, null, state.usage, true),
    formatFrame({ data: "[DONE]" })
  ];
}

function openAIResponsesFramesForBedrockEvent(
  event: unknown,
  state: {
    responseCreated: boolean;
    completed: boolean;
    finished: boolean;
    stopReason: unknown;
    usage?: Record<string, unknown>;
    textItems: Set<number>;
    toolIdsByIndex: Map<number, string>;
  }
) {
  const source = isRecord(event) ? event : {};
  const exception = bedrockStreamException(source);
  if (exception) {
    state.finished = true;
    return [responsesFrame("error", {
      type: "error",
      error: bedrockConverseErrorToOpenAI(exception).error
    })];
  }
  if (isRecord(source.messageStart)) return ensureOpenAIResponseCreated(state);
  if (isRecord(source.contentBlockStart)) {
    const start = isRecord(source.contentBlockStart.start) ? source.contentBlockStart.start : {};
    const toolUse = isRecord(start.toolUse) ? start.toolUse : undefined;
    if (!toolUse) return [];
    const outputIndex = integerValue(source.contentBlockStart.contentBlockIndex) ?? 0;
    const toolId = stringValue(toolUse.toolUseId) ?? `call_${outputIndex}`;
    state.toolIdsByIndex.set(outputIndex, toolId);
    return [
      ...ensureOpenAIResponseCreated(state),
      responsesFrame("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          id: toolId,
          type: "function_call",
          call_id: toolId,
          name: stringValue(toolUse.name),
          arguments: "",
          status: "in_progress"
        }
      })
    ];
  }
  if (isRecord(source.contentBlockDelta)) {
    const outputIndex = integerValue(source.contentBlockDelta.contentBlockIndex) ?? 0;
    const delta = isRecord(source.contentBlockDelta.delta) ? source.contentBlockDelta.delta : {};
    if (typeof delta.text === "string") {
      return [
        ...ensureOpenAIResponseTextItem(state, outputIndex),
        responsesFrame("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: `msg_bedrock_${outputIndex}`,
          output_index: outputIndex,
          content_index: 0,
          delta: delta.text
        })
      ];
    }
    const toolUse = isRecord(delta.toolUse) ? delta.toolUse : undefined;
    if (typeof toolUse?.input === "string") {
      return [responsesFrame("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        output_index: outputIndex,
        item_id: state.toolIdsByIndex.get(outputIndex) ?? `call_${outputIndex}`,
        delta: toolUse.input
      })];
    }
  }
  if (isRecord(source.messageStop)) {
    state.stopReason = source.messageStop.stopReason;
    return [];
  }
  if (isRecord(source.metadata)) {
    if (isRecord(source.metadata.usage)) state.usage = bedrockUsageToResponses(source.metadata.usage);
    return terminalOpenAIResponsesFrames(state);
  }
  return [];
}

function ensureOpenAIResponseCreated(state: { responseCreated: boolean }) {
  if (state.responseCreated) return [];
  state.responseCreated = true;
  return [responsesFrame("response.created", {
    type: "response.created",
    response: { id: "resp_bedrock", status: "in_progress" }
  })];
}

function ensureOpenAIResponseTextItem(
  state: { responseCreated: boolean; textItems: Set<number> },
  outputIndex: number
) {
  const out = ensureOpenAIResponseCreated(state);
  if (state.textItems.has(outputIndex)) return out;
  state.textItems.add(outputIndex);
  out.push(responsesFrame("response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: {
      id: `msg_bedrock_${outputIndex}`,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: []
    }
  }));
  return out;
}

function terminalOpenAIResponsesFrames(state: {
  responseCreated: boolean;
  completed: boolean;
  finished: boolean;
  stopReason: unknown;
  usage?: Record<string, unknown>;
}) {
  if (state.finished || state.completed) return [];
  state.completed = true;
  state.finished = true;
  const incompleteReason = bedrockIncompleteReason(state.stopReason);
  return [
    ...ensureOpenAIResponseCreated(state),
    responsesFrame("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_bedrock",
        status: incompleteReason ? "incomplete" : "completed",
        ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
        usage: state.usage ?? {}
      }
    })
  ];
}

function anthropicMessagesFramesForBedrockEvent(
  event: unknown,
  state: {
    messageStarted: boolean;
    completed: boolean;
    finished: boolean;
    stopReason: unknown;
    usage?: Record<string, unknown>;
    openBlocks: Set<number>;
  }
) {
  const source = isRecord(event) ? event : {};
  const exception = bedrockStreamException(source);
  if (exception) {
    state.finished = true;
    return [anthropicFrame("error", bedrockConverseErrorToAnthropicMessages(exception))];
  }
  if (isRecord(source.messageStart)) return ensureAnthropicMessageStart(state);
  if (isRecord(source.contentBlockStart)) {
    const start = isRecord(source.contentBlockStart.start) ? source.contentBlockStart.start : {};
    const toolUse = isRecord(start.toolUse) ? start.toolUse : undefined;
    if (!toolUse) return [];
    const index = integerValue(source.contentBlockStart.contentBlockIndex) ?? 0;
    state.openBlocks.add(index);
    return [
      ...ensureAnthropicMessageStart(state),
      anthropicFrame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: stringValue(toolUse.toolUseId),
          name: stringValue(toolUse.name),
          input: {}
        }
      })
    ];
  }
  if (isRecord(source.contentBlockDelta)) {
    const index = integerValue(source.contentBlockDelta.contentBlockIndex) ?? 0;
    const delta = isRecord(source.contentBlockDelta.delta) ? source.contentBlockDelta.delta : {};
    if (typeof delta.text === "string") {
      const out = ensureAnthropicTextBlock(state, index);
      out.push(anthropicFrame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: delta.text }
      }));
      return out;
    }
    const toolUse = isRecord(delta.toolUse) ? delta.toolUse : undefined;
    if (typeof toolUse?.input === "string") {
      return [anthropicFrame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: toolUse.input }
      })];
    }
  }
  if (isRecord(source.contentBlockStop)) {
    const index = integerValue(source.contentBlockStop.contentBlockIndex) ?? 0;
    state.openBlocks.delete(index);
    return [anthropicFrame("content_block_stop", { type: "content_block_stop", index })];
  }
  if (isRecord(source.messageStop)) {
    state.stopReason = source.messageStop.stopReason;
    return [];
  }
  if (isRecord(source.metadata)) {
    if (isRecord(source.metadata.usage)) state.usage = bedrockUsageToAnthropic(source.metadata.usage);
    return terminalAnthropicMessagesFrames(state);
  }
  return [];
}

function ensureAnthropicMessageStart(state: { messageStarted: boolean }) {
  if (state.messageStarted) return [];
  state.messageStarted = true;
  return [anthropicFrame("message_start", {
    type: "message_start",
    message: {
      id: "msg_bedrock",
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  })];
}

function ensureAnthropicTextBlock(state: { messageStarted: boolean; openBlocks: Set<number> }, index: number) {
  const out = ensureAnthropicMessageStart(state);
  if (state.openBlocks.has(index)) return out;
  state.openBlocks.add(index);
  out.push(anthropicFrame("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" }
  }));
  return out;
}

function terminalAnthropicMessagesFrames(state: {
  messageStarted: boolean;
  completed: boolean;
  finished: boolean;
  stopReason: unknown;
  usage?: Record<string, unknown>;
  openBlocks: Set<number>;
}) {
  if (state.finished || state.completed) return [];
  state.completed = true;
  state.finished = true;
  const closeFrames = [...state.openBlocks]
    .sort((left, right) => left - right)
    .map((index) => anthropicFrame("content_block_stop", { type: "content_block_stop", index }));
  state.openBlocks.clear();
  return [
    ...ensureAnthropicMessageStart(state),
    ...closeFrames,
    anthropicFrame("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: bedrockStopReasonToAnthropic(state.stopReason),
        stop_sequence: null
      },
      ...(state.usage ? { usage: state.usage } : {})
    }),
    anthropicFrame("message_stop", { type: "message_stop" })
  ];
}

function openAIChatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: Record<string, unknown>,
  emptyChoices = false
) {
  return formatFrame({
    data: JSON.stringify({
      id: "chatcmpl_bedrock",
      object: "chat.completion.chunk",
      choices: emptyChoices
        ? []
        : [{ index: 0, delta, finish_reason: finishReason }],
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

function bedrockStreamException(source: Record<string, unknown>) {
  const entry = Object.entries(source).find(([key]) => key.endsWith("Exception"));
  if (!entry) return undefined;
  const [name, value] = entry;
  return {
    name,
    message: isRecord(value) ? stringValue(value.message) : undefined
  };
}
