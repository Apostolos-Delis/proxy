import type { Dialect, JsonValue } from "./types.js";
import { isRecord } from "./util.js";

export type StreamObservation = {
  bytes: number;
  status?: "completed" | "failed" | "cancelled";
  usage?: JsonValue;
  upstreamResponseId?: string;
  error?: string;
  observerError?: string;
  outputText?: string;
  outputTextTruncated?: boolean;
};

export const MAX_OUTPUT_TEXT_CHARS = 200_000;

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
  protected applyEvent(event: Record<string, unknown>) {
    const type = this.eventType(event);
    if (type === "response.completed") this.observation.status = "completed";
    if (type === "response.failed" || type === "error") this.observation.status = "failed";

    const response = isRecord(event.response) ? event.response : undefined;
    if (response) {
      if (isRecord(response.usage)) this.mergeUsage(response.usage);
      if (typeof response.id === "string") this.observation.upstreamResponseId = response.id;
      if (isRecord(response.error) && typeof response.error.message === "string") {
        this.observation.error = response.error.message;
      }
    }

    if (type === "error") {
      if (typeof event.message === "string") {
        this.observation.error = event.message;
      } else if (isRecord(event.error) && typeof event.error.message === "string") {
        this.observation.error = event.error.message;
      }
    }

    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      this.appendOutputText(event.delta);
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
  protected applyEvent(event: Record<string, unknown>) {
    const type = this.eventType(event);
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
    }

    if (
      type === "content_block_delta" &&
      isRecord(event.delta) &&
      event.delta.type === "text_delta" &&
      typeof event.delta.text === "string"
    ) {
      this.appendOutputText(event.delta.text);
    }
  }
}
