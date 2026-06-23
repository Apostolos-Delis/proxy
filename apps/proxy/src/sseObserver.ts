import type { Dialect, JsonObject, JsonValue } from "./types.js";
import { isRecord, sha256 } from "./util.js";

export type StreamObservation = {
  bytes: number;
  status?: "completed" | "failed" | "cancelled";
  usage?: JsonValue;
  upstreamResponseId?: string;
  error?: string;
  observerError?: string;
  streamMetadata?: JsonObject;
  observerDrift?: JsonObject[];
  observerDriftTruncated?: boolean;
  outputText?: string;
  outputTextTruncated?: boolean;
};

export const MAX_OUTPUT_TEXT_CHARS = 200_000;
const MAX_STREAM_METADATA_STRING_CHARS = 20_000;
const MAX_STREAM_METADATA_ITEMS = 100;
const MAX_OBSERVER_DRIFT_EVENTS = 20;
const STREAM_METADATA_RAW_STRING_KEYS = new Set(["arguments", "inputJson", "thinking", "signature", "text", "cited_text"]);

const OPENAI_RESPONSES_EVENT_TYPES = new Set([
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_delta",
  "response.mcp_call.in_progress",
  "response.mcp_call.completed",
  "response.mcp_call.failed",
  "response.code_interpreter_call.in_progress",
  "response.code_interpreter_call.interpreting",
  "response.code_interpreter_call.completed",
  "response.file_search_call.in_progress",
  "response.file_search_call.searching",
  "response.file_search_call.completed",
  "response.web_search_call.in_progress",
  "response.web_search_call.searching",
  "response.web_search_call.completed",
  "error"
]);

const ANTHROPIC_MESSAGES_EVENT_TYPES = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
  "error"
]);

const ANTHROPIC_DELTA_TYPES = new Set([
  "text_delta",
  "input_json_delta",
  "thinking_delta",
  "signature_delta",
  "citations_delta"
]);

type OpenAiOutputItemMetadata = {
  outputIndex?: number;
  itemId?: string;
  type?: string;
  status?: string;
  role?: string;
  name?: string;
  namespace?: string;
  callId?: string;
  lifecycle: string[];
};

type OpenAiToolCallMetadata = {
  outputIndex?: number;
  itemId?: string;
  callId?: string;
  name?: string;
  namespace?: string;
  arguments?: string;
  argumentsTruncated?: boolean;
};

type OpenAiReasoningSummaryMetadata = {
  outputIndex?: number;
  itemId?: string;
  summaryIndex?: number;
  type?: string;
  text?: string;
  textTruncated?: boolean;
  lifecycle: string[];
};

type AnthropicBlockMetadata = {
  index: number;
  type?: string;
  id?: string;
  name?: string;
  inputJson?: string;
  inputJsonTruncated?: boolean;
  thinking?: string;
  thinkingTruncated?: boolean;
  signature?: string;
  signatureTruncated?: boolean;
  citations?: JsonValue[];
  stopped?: boolean;
};

export type SseObserver = {
  observe(chunk: Uint8Array): void;
  finish(status?: "cancelled"): StreamObservation;
};

export function sseObserverForDialect(dialect: Dialect): SseObserver {
  switch (dialect) {
    case "anthropic-messages":
      return new AnthropicMessagesSseObserver();
    case "openai-chat":
      return new OpenAiChatSseObserver();
    case "openai-responses":
      return new OpenAiResponsesSseObserver();
  }
}

export function streamObservationEventMetadata(observation: StreamObservation) {
  const { outputText: _text, outputTextTruncated: _truncated, streamMetadata, ...rest } = observation;
  if (!streamMetadata) return rest;
  return {
    ...rest,
    streamMetadata: sanitizeStreamMetadata(streamMetadata) as JsonObject
  };
}

// Shared SSE plumbing: byte accounting, frame splitting, decode-error
// capture, and the output-text cap. Subclasses interpret events for exactly
// one dialect — the dialect is known at construction, never sniffed from
// frame shapes.
abstract class DialectSseObserver implements SseObserver {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  protected readonly observation: StreamObservation = { bytes: 0 };

  observe(chunk: Uint8Array) {
    this.observation.bytes += chunk.byteLength;

    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
      this.drain();
    } catch (error) {
      this.observation.observerError =
        error instanceof Error ? error.message : "SSE observer failed.";
    }
  }

  finish(status?: "cancelled") {
    if (status) this.observation.status = status;
    try {
      this.buffer += this.decoder.decode();
      this.drain(true);
    } catch (error) {
      this.observation.observerError =
        error instanceof Error ? error.message : "SSE observer failed.";
    }
    return { ...this.observation };
  }

  protected abstract applyEvent(event: Record<string, unknown>): void;

  private drain(final = false) {
    while (true) {
      const index = this.buffer.search(/\r?\n\r?\n/);
      if (index === -1) break;
      const frame = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(this.buffer[index] === "\r" ? index + 4 : index + 2);
      this.processFrame(frame);
    }

    if (final && this.buffer.trim()) {
      this.processFrame(this.buffer);
      this.buffer = "";
    }
  }

  private processFrame(frame: string) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");

    if (!data || data === "[DONE]") return;

    try {
      const parsed = JSON.parse(data);
      if (isRecord(parsed)) this.applyEvent(parsed);
    } catch {
      this.observation.observerError = "SSE observer could not parse event data.";
    }
  }

  protected eventType(event: Record<string, unknown>) {
    return typeof event.type === "string" ? event.type : undefined;
  }

  protected recordDrift(event: Record<string, unknown>, reason: string) {
    const current = this.observation.observerDrift ?? [];
    if (current.length >= MAX_OBSERVER_DRIFT_EVENTS) {
      this.observation.observerDriftTruncated = true;
      return;
    }
    current.push(compactObject({
      reason,
      eventType: this.eventType(event) ?? "missing",
      deltaType: isRecord(event.delta) ? stringValue(event.delta.type) : undefined,
      keys: Object.keys(event).sort()
    }));
    this.observation.observerDrift = current;
  }

  protected mergeUsage(next: Record<string, unknown>) {
    const current = this.observation.usage;
    this.observation.usage = (isRecord(current) ? { ...current, ...next } : next) as JsonValue;
  }

  protected appendOutputText(delta: string) {
    if (this.observation.outputTextTruncated) return;
    const current = this.observation.outputText ?? "";
    const remaining = MAX_OUTPUT_TEXT_CHARS - current.length;
    if (remaining <= 0 || delta.length > remaining) {
      this.observation.outputText = current + delta.slice(0, Math.max(0, remaining));
      this.observation.outputTextTruncated = true;
      return;
    }
    this.observation.outputText = current + delta;
  }
}

class OpenAiResponsesSseObserver extends DialectSseObserver {
  private readonly outputItems: OpenAiOutputItemMetadata[] = [];
  private readonly toolCalls: OpenAiToolCallMetadata[] = [];
  private readonly reasoningSummaries: OpenAiReasoningSummaryMetadata[] = [];
  private readonly errors: JsonObject[] = [];
  private metadataTruncated = false;

  protected applyEvent(event: Record<string, unknown>) {
    const type = this.eventType(event);
    if (!type) {
      this.recordDrift(event, "missing_event_type");
    } else if (!OPENAI_RESPONSES_EVENT_TYPES.has(type)) {
      this.recordDrift(event, "unknown_event_type");
    }

    if (type === "response.completed") this.observation.status = "completed";
    if (type === "response.failed" || type === "error") this.observation.status = "failed";

    const response = isRecord(event.response) ? event.response : undefined;
    if (response) {
      if (isRecord(response.usage)) this.mergeUsage(response.usage);
      if (typeof response.id === "string") this.observation.upstreamResponseId = response.id;
      if (isRecord(response.error) && typeof response.error.message === "string") {
        this.observation.error = response.error.message;
        this.recordError(response.error);
      }
    }

    if (type === "error") {
      if (typeof event.message === "string") {
        this.observation.error = event.message;
        this.recordError(event);
      } else if (isRecord(event.error) && typeof event.error.message === "string") {
        this.observation.error = event.error.message;
        this.recordError(event.error);
      }
    }

    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      this.appendOutputText(event.delta);
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      this.recordOutputItem(event, type === "response.output_item.added" ? "added" : "done");
    }

    if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      this.recordFunctionCallDelta(event, type === "response.function_call_arguments.done");
    }

    if (
      type === "response.reasoning_summary_part.added" ||
      type === "response.reasoning_summary_part.done" ||
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_summary_text.done"
    ) {
      this.recordReasoningSummary(event, type);
    }
  }

  private recordOutputItem(event: Record<string, unknown>, lifecycle: "added" | "done") {
    const item = isRecord(event.item) ? event.item : undefined;
    if (!item) return;
    const outputIndex = integerValue(event.output_index) ?? integerValue(item.output_index);
    const itemId = stringValue(event.item_id) ?? stringValue(item.id) ?? stringValue(item.call_id);
    const outputItem = this.findOrCreateOutputItem(outputIndex, itemId);
    if (!outputItem) return;

    outputItem.outputIndex ??= outputIndex;
    outputItem.itemId ??= itemId;
    outputItem.type = stringValue(item.type) ?? outputItem.type;
    outputItem.status = stringValue(item.status) ?? outputItem.status;
    outputItem.role = stringValue(item.role) ?? outputItem.role;
    outputItem.name = stringValue(item.name) ?? outputItem.name;
    outputItem.namespace = stringValue(item.namespace) ?? outputItem.namespace;
    outputItem.callId = stringValue(item.call_id) ?? outputItem.callId;
    pushUnique(outputItem.lifecycle, lifecycle);

    if (outputItem.type === "function_call") {
      this.recordFunctionCallItem(event, item);
    }
    this.syncMetadata();
  }

  private recordFunctionCallItem(event: Record<string, unknown>, item: Record<string, unknown>) {
    const outputIndex = integerValue(event.output_index) ?? integerValue(item.output_index);
    const itemId = stringValue(event.item_id) ?? stringValue(item.id) ?? stringValue(item.call_id);
    const callId = stringValue(item.call_id) ?? itemId;
    const toolCall = this.findOrCreateToolCall(outputIndex, itemId, callId);
    if (!toolCall) return;

    toolCall.outputIndex ??= outputIndex;
    toolCall.itemId ??= itemId;
    toolCall.callId ??= callId;
    toolCall.name = stringValue(item.name) ?? toolCall.name;
    toolCall.namespace = stringValue(item.namespace) ?? toolCall.namespace;
    if (typeof item.arguments === "string") {
      toolCall.arguments = item.arguments.slice(0, MAX_STREAM_METADATA_STRING_CHARS);
      toolCall.argumentsTruncated = item.arguments.length > MAX_STREAM_METADATA_STRING_CHARS;
    }
  }

  private recordFunctionCallDelta(event: Record<string, unknown>, done: boolean) {
    const outputIndex = integerValue(event.output_index);
    const itemId = stringValue(event.item_id);
    const callId = stringValue(event.call_id) ?? itemId;
    const toolCall = this.findOrCreateToolCall(outputIndex, itemId, callId);
    if (!toolCall) return;

    toolCall.outputIndex ??= outputIndex;
    toolCall.itemId ??= itemId;
    toolCall.callId ??= callId;

    if (done && typeof event.arguments === "string") {
      toolCall.arguments = event.arguments.slice(0, MAX_STREAM_METADATA_STRING_CHARS);
      toolCall.argumentsTruncated = event.arguments.length > MAX_STREAM_METADATA_STRING_CHARS;
    } else if (typeof event.delta === "string" && event.delta.length > 0) {
      const appended = appendCappedString(toolCall.arguments, toolCall.argumentsTruncated, event.delta);
      toolCall.arguments = appended.value;
      toolCall.argumentsTruncated = appended.truncated;
    }
    this.syncMetadata();
  }

  private recordReasoningSummary(event: Record<string, unknown>, type: string) {
    const part = isRecord(event.part) ? event.part : undefined;
    const outputIndex = integerValue(event.output_index);
    const itemId = stringValue(event.item_id);
    const summaryIndex = integerValue(event.summary_index) ?? integerValue(event.content_index) ?? integerValue(part?.index);
    const summary = this.findOrCreateReasoningSummary(outputIndex, itemId, summaryIndex);
    if (!summary) return;

    summary.outputIndex ??= outputIndex;
    summary.itemId ??= itemId;
    summary.summaryIndex ??= summaryIndex;
    summary.type = stringValue(part?.type) ?? summary.type;
    if (type.endsWith(".added")) pushUnique(summary.lifecycle, "added");
    if (type.endsWith(".done")) pushUnique(summary.lifecycle, "done");

    if (typeof event.text === "string") {
      summary.text = event.text.slice(0, MAX_STREAM_METADATA_STRING_CHARS);
      summary.textTruncated = event.text.length > MAX_STREAM_METADATA_STRING_CHARS;
    } else if (part && typeof part.text === "string") {
      summary.text = part.text.slice(0, MAX_STREAM_METADATA_STRING_CHARS);
      summary.textTruncated = part.text.length > MAX_STREAM_METADATA_STRING_CHARS;
    } else if (typeof event.delta === "string" && event.delta.length > 0) {
      const appended = appendCappedString(summary.text, summary.textTruncated, event.delta);
      summary.text = appended.value;
      summary.textTruncated = appended.truncated;
    }
    this.syncMetadata();
  }

  private recordError(error: Record<string, unknown>) {
    if (this.errors.length >= MAX_STREAM_METADATA_ITEMS) {
      this.metadataTruncated = true;
      this.syncMetadata();
      return;
    }
    this.errors.push(compactObject({
      message: stringValue(error.message),
      type: stringValue(error.type),
      code: stringValue(error.code)
    }));
    this.syncMetadata();
  }

  private findOrCreateOutputItem(outputIndex: number | undefined, itemId: string | undefined) {
    const existing = this.outputItems.find((item) =>
      (itemId !== undefined && item.itemId === itemId) ||
      (outputIndex !== undefined && item.outputIndex === outputIndex)
    );
    if (existing) return existing;
    if (this.outputItems.length >= MAX_STREAM_METADATA_ITEMS) {
      this.metadataTruncated = true;
      return undefined;
    }
    const item: OpenAiOutputItemMetadata = { outputIndex, itemId, lifecycle: [] };
    this.outputItems.push(item);
    return item;
  }

  private findOrCreateToolCall(outputIndex: number | undefined, itemId: string | undefined, callId: string | undefined) {
    const existing = this.toolCalls.find((toolCall) =>
      (callId !== undefined && toolCall.callId === callId) ||
      (itemId !== undefined && toolCall.itemId === itemId) ||
      (outputIndex !== undefined && toolCall.outputIndex === outputIndex)
    );
    if (existing) return existing;
    if (this.toolCalls.length >= MAX_STREAM_METADATA_ITEMS) {
      this.metadataTruncated = true;
      return undefined;
    }
    const toolCall: OpenAiToolCallMetadata = { outputIndex, itemId, callId };
    this.toolCalls.push(toolCall);
    return toolCall;
  }

  private findOrCreateReasoningSummary(
    outputIndex: number | undefined,
    itemId: string | undefined,
    summaryIndex: number | undefined
  ) {
    const existing = this.reasoningSummaries.find((summary) =>
      (itemId !== undefined && summary.itemId === itemId && summary.summaryIndex === summaryIndex) ||
      (itemId === undefined && outputIndex !== undefined && summary.outputIndex === outputIndex && summary.summaryIndex === summaryIndex)
    );
    if (existing) return existing;
    if (this.reasoningSummaries.length >= MAX_STREAM_METADATA_ITEMS) {
      this.metadataTruncated = true;
      return undefined;
    }
    const summary: OpenAiReasoningSummaryMetadata = { outputIndex, itemId, summaryIndex, lifecycle: [] };
    this.reasoningSummaries.push(summary);
    return summary;
  }

  private syncMetadata() {
    const openaiResponses = compactObject({
      outputItems: this.outputItems.length > 0 ? this.outputItems.map(openAiOutputItemMetadataJson) : undefined,
      toolCalls: this.toolCalls.length > 0 ? this.toolCalls.map(openAiToolCallMetadataJson) : undefined,
      reasoningSummaries: this.reasoningSummaries.length > 0
        ? this.reasoningSummaries.map(openAiReasoningSummaryMetadataJson)
        : undefined,
      errors: this.errors.length > 0 ? this.errors : undefined,
      truncated: this.metadataTruncated ? true : undefined
    });
    if (Object.keys(openaiResponses).length > 0) {
      this.observation.streamMetadata = { openaiResponses };
    }
  }
}

class OpenAiChatSseObserver extends DialectSseObserver {
  protected applyEvent(event: Record<string, unknown>) {
    const type = this.eventType(event);
    if (typeof event.id === "string") this.observation.upstreamResponseId = event.id;
    if (isRecord(event.usage)) this.mergeUsage(event.usage);

    if (type === "error" || isRecord(event.error)) {
      this.observation.status = "failed";
      if (isRecord(event.error) && typeof event.error.message === "string") {
        this.observation.error = event.error.message;
      } else if (typeof event.message === "string") {
        this.observation.error = event.message;
      }
    }

    if (!Array.isArray(event.choices)) return;
    for (const choice of event.choices) {
      if (!isRecord(choice)) continue;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null && this.observation.status !== "failed") {
        this.observation.status = "completed";
      }
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      if (delta && typeof delta.content === "string") {
        this.appendOutputText(delta.content);
      }
    }
  }
}

class AnthropicMessagesSseObserver extends DialectSseObserver {
  private readonly blocks = new Map<number, AnthropicBlockMetadata>();
  private readonly errors: JsonObject[] = [];
  private metadataTruncated = false;

  protected applyEvent(event: Record<string, unknown>) {
    const type = this.eventType(event);
    if (!type) {
      this.recordDrift(event, "missing_event_type");
    } else if (!ANTHROPIC_MESSAGES_EVENT_TYPES.has(type)) {
      this.recordDrift(event, "unknown_event_type");
    }

    if (type === "message_stop") this.observation.status = "completed";
    if (type === "error") this.observation.status = "failed";

    // Usage arrives across two frames: message_start carries input/cache
    // tokens (under message.usage), message_delta carries the final output
    // tokens (top-level usage). The shallow merge folds them into one record.
    const message = isRecord(event.message) ? event.message : undefined;
    if (message) {
      if (isRecord(message.usage)) this.mergeUsage(message.usage);
      if (typeof message.id === "string") this.observation.upstreamResponseId = message.id;
    }
    if (type === "message_delta" && isRecord(event.usage)) {
      this.mergeUsage(event.usage);
    }

    if (type === "error" && isRecord(event.error) && typeof event.error.message === "string") {
      this.observation.error = event.error.message;
      this.recordError(event.error);
    }

    if (
      type === "content_block_delta" &&
      isRecord(event.delta) &&
      event.delta.type === "text_delta" &&
      typeof event.delta.text === "string"
    ) {
      this.appendOutputText(event.delta.text);
    }

    if (type === "content_block_start") {
      this.recordBlockStart(event);
    }

    if (type === "content_block_stop") {
      this.recordBlockStop(event);
    }

    if (type === "content_block_delta" && isRecord(event.delta)) {
      this.recordBlockDelta(event, event.delta);
    }
  }

  private recordBlockStart(event: Record<string, unknown>) {
    const index = integerValue(event.index);
    const contentBlock = isRecord(event.content_block) ? event.content_block : undefined;
    if (index === undefined || !contentBlock) return;
    const block = this.findOrCreateBlock(index);
    if (!block) return;

    block.type = stringValue(contentBlock.type) ?? block.type;
    block.id = stringValue(contentBlock.id) ?? block.id;
    block.name = stringValue(contentBlock.name) ?? block.name;
    if (typeof contentBlock.thinking === "string" && contentBlock.thinking.length > 0) {
      const appended = appendCappedString(block.thinking, block.thinkingTruncated, contentBlock.thinking);
      block.thinking = appended.value;
      block.thinkingTruncated = appended.truncated;
    }
    if (typeof contentBlock.signature === "string" && contentBlock.signature.length > 0) {
      const appended = appendCappedString(block.signature, block.signatureTruncated, contentBlock.signature);
      block.signature = appended.value;
      block.signatureTruncated = appended.truncated;
    }
    this.syncMetadata();
  }

  private recordBlockStop(event: Record<string, unknown>) {
    const index = integerValue(event.index);
    if (index === undefined) return;
    const block = this.blocks.get(index);
    if (!block) return;
    block.stopped = true;
    this.syncMetadata();
  }

  private recordBlockDelta(event: Record<string, unknown>, delta: Record<string, unknown>) {
    const deltaType = stringValue(delta.type);
    if (!deltaType) {
      this.recordDrift(event, "missing_delta_type");
      return;
    }
    if (!ANTHROPIC_DELTA_TYPES.has(deltaType)) {
      this.recordDrift(event, "unknown_delta_type");
      return;
    }

    const index = integerValue(event.index);
    if (index === undefined) return;
    const block = this.findOrCreateBlock(index);
    if (!block) return;

    if (deltaType === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json.length > 0) {
      const appended = appendCappedString(block.inputJson, block.inputJsonTruncated, delta.partial_json);
      block.inputJson = appended.value;
      block.inputJsonTruncated = appended.truncated;
    }
    if (deltaType === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
      const appended = appendCappedString(block.thinking, block.thinkingTruncated, delta.thinking);
      block.thinking = appended.value;
      block.thinkingTruncated = appended.truncated;
    }
    if (deltaType === "signature_delta" && typeof delta.signature === "string" && delta.signature.length > 0) {
      const appended = appendCappedString(block.signature, block.signatureTruncated, delta.signature);
      block.signature = appended.value;
      block.signatureTruncated = appended.truncated;
    }
    if (deltaType === "citations_delta") {
      const citation = jsonValue(delta.citation) ?? jsonValue(delta);
      if (citation !== undefined) {
        const citations = block.citations ?? [];
        if (citations.length >= MAX_STREAM_METADATA_ITEMS) {
          this.metadataTruncated = true;
        } else {
          citations.push(citation);
          block.citations = citations;
        }
      }
    }
    this.syncMetadata();
  }

  private recordError(error: Record<string, unknown>) {
    if (this.errors.length >= MAX_STREAM_METADATA_ITEMS) {
      this.metadataTruncated = true;
      this.syncMetadata();
      return;
    }
    this.errors.push(compactObject({
      message: stringValue(error.message),
      type: stringValue(error.type)
    }));
    this.syncMetadata();
  }

  private findOrCreateBlock(index: number) {
    const existing = this.blocks.get(index);
    if (existing) return existing;
    if (this.blocks.size >= MAX_STREAM_METADATA_ITEMS) {
      this.metadataTruncated = true;
      return undefined;
    }
    const block: AnthropicBlockMetadata = { index };
    this.blocks.set(index, block);
    return block;
  }

  private syncMetadata() {
    const blocks = [...this.blocks.values()]
      .filter(anthropicBlockHasReplayMetadata)
      .sort((left, right) => left.index - right.index)
      .map(anthropicBlockMetadataJson);
    const anthropicMessages = compactObject({
      blocks: blocks.length > 0 ? blocks : undefined,
      errors: this.errors.length > 0 ? this.errors : undefined,
      truncated: this.metadataTruncated ? true : undefined
    });
    if (Object.keys(anthropicMessages).length > 0) {
      this.observation.streamMetadata = { anthropicMessages };
    }
  }
}

function openAiOutputItemMetadataJson(item: OpenAiOutputItemMetadata) {
  return compactObject({
    outputIndex: item.outputIndex,
    itemId: item.itemId,
    type: item.type,
    status: item.status,
    role: item.role,
    name: item.name,
    namespace: item.namespace,
    callId: item.callId,
    lifecycle: item.lifecycle.length > 0 ? item.lifecycle : undefined
  });
}

function openAiToolCallMetadataJson(toolCall: OpenAiToolCallMetadata) {
  return compactObject({
    outputIndex: toolCall.outputIndex,
    itemId: toolCall.itemId,
    callId: toolCall.callId,
    name: toolCall.name,
    namespace: toolCall.namespace,
    arguments: toolCall.arguments,
    argumentsTruncated: toolCall.argumentsTruncated ? true : undefined
  });
}

function openAiReasoningSummaryMetadataJson(summary: OpenAiReasoningSummaryMetadata) {
  return compactObject({
    outputIndex: summary.outputIndex,
    itemId: summary.itemId,
    summaryIndex: summary.summaryIndex,
    type: summary.type,
    text: summary.text,
    textTruncated: summary.textTruncated ? true : undefined,
    lifecycle: summary.lifecycle.length > 0 ? summary.lifecycle : undefined
  });
}

function anthropicBlockHasReplayMetadata(block: AnthropicBlockMetadata) {
  return block.type !== undefined && block.type !== "text" ||
    block.inputJson !== undefined ||
    block.thinking !== undefined ||
    block.signature !== undefined ||
    Boolean(block.citations && block.citations.length > 0);
}

function anthropicBlockMetadataJson(block: AnthropicBlockMetadata) {
  return compactObject({
    index: block.index,
    type: block.type,
    id: block.id,
    name: block.name,
    inputJson: block.inputJson,
    inputJsonTruncated: block.inputJsonTruncated ? true : undefined,
    thinking: block.thinking,
    thinkingTruncated: block.thinkingTruncated ? true : undefined,
    signature: block.signature,
    signatureTruncated: block.signatureTruncated ? true : undefined,
    citations: block.citations && block.citations.length > 0 ? block.citations : undefined,
    stopped: block.stopped ? true : undefined
  });
}

function compactObject(values: Record<string, JsonValue | undefined>) {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function appendCappedString(current: string | undefined, truncated: boolean | undefined, delta: string) {
  if (truncated) return { value: current ?? "", truncated: true };
  const value = current ?? "";
  const remaining = MAX_STREAM_METADATA_STRING_CHARS - value.length;
  if (remaining <= 0 || delta.length > remaining) {
    return {
      value: value + delta.slice(0, Math.max(0, remaining)),
      truncated: true
    };
  }
  return { value: value + delta, truncated: false };
}

function integerValue(value: unknown) {
  return Number.isInteger(value) ? value as number : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function pushUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item) ?? null);
  if (!isRecord(value)) return undefined;
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    const converted = jsonValue(child);
    if (converted !== undefined) result[key] = converted;
  }
  return result;
}

function sanitizeStreamMetadata(value: JsonValue, key?: string): JsonValue {
  if (typeof value === "string" && key && STREAM_METADATA_RAW_STRING_KEYS.has(key)) {
    return {
      sha256: sha256(value),
      chars: value.length
    };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeStreamMetadata(item));
  if (!isRecord(value)) return value;
  const result: JsonObject = {};
  for (const [childKey, child] of Object.entries(value)) {
    result[childKey] = sanitizeStreamMetadata(child, childKey);
  }
  return result;
}
