import { type SseObserver, type StreamObservation } from "./sseObserver.js";
import type { Surface } from "./types.js";
import { isRecord } from "./util.js";

export async function collectStreamResponse(
  chunks: AsyncIterable<Uint8Array>,
  observer: SseObserver,
  surface: Surface
) {
  const decoder = new TextDecoder();
  let sseText = "";
  for await (const chunk of chunks) {
    const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    observer.observe(bytes);
    sseText += decoder.decode(bytes, { stream: true });
  }
  sseText += decoder.decode();
  const observation = observer.finish();
  const content = surface === "anthropic-messages" ? anthropicContentFromSse(sseText) : undefined;
  return {
    observation,
    outputText: outputTextFromSse(surface, sseText) || observation.outputText || "",
    content
  };
}

export function bufferedStreamResponse(
  surface: Surface,
  model: string,
  status: "completed" | "failed",
  observation: StreamObservation,
  outputText: string,
  content?: Record<string, unknown>[]
) {
  if (surface === "anthropic-messages") {
    return {
      id: observation.upstreamResponseId ?? "msg_translated",
      type: "message",
      role: "assistant",
      model,
      content: content && content.length > 0 ? content : [{ type: "text", text: outputText }],
      stop_reason: status === "completed" ? "end_turn" : null,
      stop_sequence: null,
      usage: observation.usage
    };
  }
  if (surface === "openai-chat") {
    return {
      id: observation.upstreamResponseId ?? "chatcmpl_translated",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: outputText || null },
        finish_reason: status === "completed" ? "stop" : null
      }],
      usage: observation.usage
    };
  }
  return {
    id: observation.upstreamResponseId ?? "resp_translated",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output: [{
      id: "msg_translated",
      type: "message",
      status,
      role: "assistant",
      content: [{ type: "output_text", text: outputText }]
    }],
    output_text: outputText,
    usage: observation.usage
  };
}

function outputTextFromSse(surface: Surface, text: string) {
  const parts: string[] = [];
  for (const event of sseEvents(text)) {
    if (surface === "anthropic-messages") {
      if (
        event.type === "content_block_delta" &&
        isRecord(event.delta) &&
        event.delta.type === "text_delta" &&
        typeof event.delta.text === "string"
      ) {
        parts.push(event.delta.text);
      }
      continue;
    }
    if (surface === "openai-responses") {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") parts.push(event.delta);
      continue;
    }
    if (!Array.isArray(event.choices)) continue;
    for (const choice of event.choices) {
      if (!isRecord(choice) || !isRecord(choice.delta) || typeof choice.delta.content !== "string") continue;
      parts.push(choice.delta.content);
    }
  }
  return parts.join("");
}

function anthropicContentFromSse(text: string) {
  const blocks = new Map<number, Record<string, unknown>>();
  const partials = new Map<number, string>();
  for (const event of sseEvents(text)) {
    const index = typeof event.index === "number" ? event.index : undefined;
    if (index === undefined) continue;
    if (event.type === "content_block_start" && isRecord(event.content_block)) {
      if (event.content_block.type === "tool_use") {
        blocks.set(index, {
          type: "tool_use",
          id: event.content_block.id,
          name: event.content_block.name,
          input: isRecord(event.content_block.input) ? event.content_block.input : {}
        });
      } else if (event.content_block.type === "text") {
        blocks.set(index, { type: "text", text: "" });
      }
      continue;
    }
    if (event.type !== "content_block_delta" || !isRecord(event.delta)) continue;
    const block = blocks.get(index);
    if (!block) continue;
    if (event.delta.type === "text_delta" && typeof event.delta.text === "string" && block.type === "text") {
      block.text = `${typeof block.text === "string" ? block.text : ""}${event.delta.text}`;
    }
    if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string" && block.type === "tool_use") {
      partials.set(index, `${partials.get(index) ?? ""}${event.delta.partial_json}`);
    }
  }
  for (const [index, partialJson] of partials) {
    const block = blocks.get(index);
    if (block?.type === "tool_use") block.input = parseBufferedJson(partialJson);
  }
  return [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block)
    .filter((block) => block.type !== "text" || block.text !== "");
}

function parseBufferedJson(value: string) {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sseEvents(text: string) {
  const events: Record<string, unknown>[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      continue;
    }
  }
  return events;
}
