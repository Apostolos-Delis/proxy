import type { JsonValue } from "./types.js";
import { isRecord } from "./util.js";

export type StreamObservation = {
  bytes: number;
  status?: "completed" | "failed" | "cancelled";
  usage?: JsonValue;
  upstreamResponseId?: string;
  error?: string;
  observerError?: string;
};

export class SseObserver {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private readonly observation: StreamObservation = { bytes: 0 };

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
      this.applyEvent(parsed);
    } catch {
      this.observation.observerError = "SSE observer could not parse event data.";
    }
  }

  private applyEvent(event: unknown) {
    if (!isRecord(event)) return;

    const type = typeof event.type === "string" ? event.type : undefined;
    if (type?.includes("completed") || type === "message_stop") {
      this.observation.status = "completed";
    }
    if (type?.includes("failed") || type === "error") {
      this.observation.status = "failed";
    }

    const usage = findUsage(event);
    if (usage !== undefined) {
      this.observation.usage = mergeUsage(this.observation.usage, usage);
    }

    const id = findId(event);
    if (id) this.observation.upstreamResponseId = id;

    const error = findError(event);
    if (error) this.observation.error = error;
  }
}

function mergeUsage(current: JsonValue | undefined, next: JsonValue): JsonValue {
  if (!isRecord(current) || !isRecord(next)) return next;

  return {
    ...current,
    ...next
  } as JsonValue;
}

function findUsage(value: unknown): JsonValue | undefined {
  if (isRecord(value) && isRecord(value.usage)) return value.usage as JsonValue;
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      const found = findUsage(item);
      if (found !== undefined) return found;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsage(item);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findId(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.id === "string") return value.id;
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      const found = findId(item);
      if (found) return found;
    }
  }
  return undefined;
}

function findError(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.message === "string") return value.message;
  if (isRecord(value) && isRecord(value.error)) return findError(value.error);
  return undefined;
}
