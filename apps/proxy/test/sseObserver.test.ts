import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MAX_OUTPUT_TEXT_CHARS, sseObserverForDialect } from "../src/sseObserver.js";
import type { Dialect } from "../src/types.js";

const CHUNK_SIZES = [3, 16, Number.MAX_SAFE_INTEGER];

async function fixtureBytes(name: string) {
  const path = fileURLToPath(new URL(`./fixtures/sse/${name}`, import.meta.url));
  return new Uint8Array(await readFile(path));
}

function observeInChunks(dialect: Dialect, bytes: Uint8Array, chunkSize: number, cancel = false) {
  const observer = sseObserverForDialect(dialect);
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    observer.observe(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return observer.finish(cancel ? "cancelled" : undefined);
}

describe("openai-responses observer", () => {
  it("extracts status, usage, response id, and output text from the golden stream", async () => {
    const bytes = await fixtureBytes("openai-responses-completed.sse");
    for (const chunkSize of CHUNK_SIZES) {
      expect(observeInChunks("openai-responses", bytes, chunkSize)).toEqual({
        bytes: bytes.byteLength,
        status: "completed",
        usage: {
          input_tokens: 1200,
          input_tokens_details: { cached_tokens: 800 },
          output_tokens: 45,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 1245
        },
        upstreamResponseId: "resp_abc123",
        outputText: "Hello, wörld!"
      });
    }
  });

  it("marks error events failed and captures the message", async () => {
    const bytes = await fixtureBytes("openai-responses-error.sse");
    const observation = observeInChunks("openai-responses", bytes, 16);

    expect(observation.status).toBe("failed");
    expect(observation.error).toBe("The server had an error while processing your request.");
    expect(observation.upstreamResponseId).toBe("resp_err1");
  });

  it("captures nested response failure messages", () => {
    const observer = sseObserverForDialect("openai-responses");
    const frame = JSON.stringify({
      type: "response.failed",
      response: {
        id: "resp_failed1",
        error: { message: "The model hit a provider-side failure." }
      }
    });
    observer.observe(new TextEncoder().encode(`data: ${frame}\n\n`));
    const observation = observer.finish();

    expect(observation.status).toBe("failed");
    expect(observation.error).toBe("The model hit a provider-side failure.");
    expect(observation.upstreamResponseId).toBe("resp_failed1");
  });
});

describe("openai-chat observer", () => {
  it("extracts status, usage, response id, and output text from the golden stream", async () => {
    const bytes = await fixtureBytes("openai-chat-completed.sse");
    for (const chunkSize of CHUNK_SIZES) {
      expect(observeInChunks("openai-chat", bytes, chunkSize)).toEqual({
        bytes: bytes.byteLength,
        status: "completed",
        usage: {
          prompt_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 700 },
          completion_tokens: 35,
          completion_tokens_details: { reasoning_tokens: 9 },
          total_tokens: 1035
        },
        upstreamResponseId: "chatcmpl_abc123",
        outputText: "Hello, chat!"
      });
    }
  });

  it("marks streamed error chunks failed and captures the message", () => {
    const observer = sseObserverForDialect("openai-chat");
    observer.observe(new TextEncoder().encode('data: {"error":{"message":"chat failed"}}\n\n'));
    const observation = observer.finish();

    expect(observation.status).toBe("failed");
    expect(observation.error).toBe("chat failed");
  });
});

describe("anthropic-messages observer", () => {
  it("merges usage across message_start and message_delta frames", async () => {
    const bytes = await fixtureBytes("anthropic-messages-completed.sse");
    for (const chunkSize of CHUNK_SIZES) {
      expect(observeInChunks("anthropic-messages", bytes, chunkSize)).toEqual({
        bytes: bytes.byteLength,
        status: "completed",
        usage: {
          input_tokens: 2400,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 1800,
          output_tokens: 31
        },
        upstreamResponseId: "msg_01ABC",
        outputText: "Hej världen"
      });
    }
  });

  it("marks error events failed, keeps the message_start usage, and captures the message", async () => {
    const bytes = await fixtureBytes("anthropic-messages-error.sse");
    const observation = observeInChunks("anthropic-messages", bytes, 16);

    expect(observation.status).toBe("failed");
    expect(observation.error).toBe("Overloaded");
    expect(observation.usage).toEqual({
      input_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1
    });
  });
});

describe("shared observer plumbing", () => {
  it("keeps cancelled status set by finish", async () => {
    const bytes = await fixtureBytes("anthropic-messages-completed.sse");
    const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));
    const observation = observeInChunks("anthropic-messages", truncated, 16, true);

    expect(observation.status).toBe("cancelled");
  });

  it("records an observer error for unparseable event data without dying", () => {
    const observer = sseObserverForDialect("openai-responses");
    observer.observe(new TextEncoder().encode("data: {not json}\n\n"));
    const observation = observer.finish();

    expect(observation.observerError).toBe("SSE observer could not parse event data.");
  });

  it("caps captured output text and flags truncation", () => {
    const observer = sseObserverForDialect("openai-responses");
    const delta = "x".repeat(60_000);
    for (let i = 0; i < 5; i += 1) {
      const frame = JSON.stringify({ type: "response.output_text.delta", delta });
      observer.observe(new TextEncoder().encode(`data: ${frame}\n\n`));
    }
    const observation = observer.finish();

    expect(observation.outputText?.length).toBe(MAX_OUTPUT_TEXT_CHARS);
    expect(observation.outputTextTruncated).toBe(true);
  });

  it("handles CRLF-delimited frames", () => {
    const observer = sseObserverForDialect("anthropic-messages");
    const frame = 'data: {"type":"message_stop"}\r\n\r\n';
    observer.observe(new TextEncoder().encode(frame));
    const observation = observer.finish();

    expect(observation.status).toBe("completed");
  });
});
