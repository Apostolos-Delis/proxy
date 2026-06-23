import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MAX_OUTPUT_TEXT_CHARS, sseObserverForDialect, streamObservationEventMetadata } from "../src/sseObserver.js";
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
        streamMetadata: {
          openaiResponses: {
            outputItems: [{
              outputIndex: 0,
              itemId: "msg_item_1",
              type: "message",
              role: "assistant",
              lifecycle: ["added"]
            }]
          }
        },
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
    expect(observation.streamMetadata).toEqual({
      openaiResponses: {
        errors: [{
          message: "The server had an error while processing your request.",
          type: "error",
          code: "server_error"
        }]
      }
    });
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
    expect(observation.streamMetadata).toEqual({
      openaiResponses: {
        errors: [{ message: "The model hit a provider-side failure." }]
      }
    });
  });

  it("completes streams that omit terminal usage", async () => {
    const bytes = await fixtureBytes("openai-responses-missing-usage.sse");
    const observation = observeInChunks("openai-responses", bytes, 11);

    expect(observation.status).toBe("completed");
    expect(observation.usage).toBeUndefined();
    expect(observation.upstreamResponseId).toBe("resp_no_usage");
    expect(observation.outputText).toBe("No usage, still done.");
  });

  it("tracks replay-relevant output items, tool args, reasoning summaries, and drift", async () => {
    const bytes = await fixtureBytes("openai-responses-replay-deltas.sse");
    const observation = observeInChunks("openai-responses", bytes, 3);

    expect(observation.status).toBe("completed");
    expect(observation.usage).toEqual({ input_tokens: 11, output_tokens: 7, total_tokens: 18 });
    expect(observation.upstreamResponseId).toBe("resp_replay");
    expect(observation.streamMetadata).toEqual({
      openaiResponses: {
        outputItems: [
          {
            outputIndex: 0,
            itemId: "fc_1",
            type: "function_call",
            status: "completed",
            name: "lookup",
            namespace: "tools",
            callId: "call_1",
            lifecycle: ["added", "done"]
          },
          {
            outputIndex: 1,
            itemId: "rs_1",
            type: "reasoning",
            status: "in_progress",
            lifecycle: ["added"]
          }
        ],
        toolCalls: [{
          outputIndex: 0,
          itemId: "fc_1",
          callId: "call_1",
          name: "lookup",
          namespace: "tools",
          arguments: "{\"query\":\"café\"}"
        }],
        reasoningSummaries: [{
          outputIndex: 1,
          itemId: "rs_1",
          summaryIndex: 0,
          type: "summary_text",
          text: "plan döne",
          lifecycle: ["added", "done"]
        }]
      }
    });
    expect(observation.observerDrift).toEqual([{
      reason: "unknown_event_type",
      eventType: "response.future_delta",
      keys: ["extra", "type"]
    }]);

    const eventMetadata = streamObservationEventMetadata(observation);
    expect(JSON.stringify(eventMetadata)).not.toContain("café");
    expect((eventMetadata.streamMetadata as any).openaiResponses.toolCalls[0].arguments).toEqual({
      sha256: expect.stringMatching(/^sha256:/),
      chars: 16
    });
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
    expect(observation.streamMetadata).toEqual({
      anthropicMessages: {
        errors: [{ message: "Overloaded", type: "overloaded_error" }]
      }
    });
  });

  it("tracks thinking, signatures, input JSON, citations, block indexes, and drift", async () => {
    const bytes = await fixtureBytes("anthropic-messages-replay-deltas.sse");
    const observation = observeInChunks("anthropic-messages", bytes, 3);

    expect(observation.status).toBe("completed");
    expect(observation.usage).toEqual({ input_tokens: 7, output_tokens: 5 });
    expect(observation.upstreamResponseId).toBe("msg_replay");
    expect(observation.streamMetadata).toEqual({
      anthropicMessages: {
        blocks: [
          {
            index: 0,
            type: "thinking",
            thinking: "first thøught",
            signature: "sig_1",
            stopped: true
          },
          {
            index: 1,
            type: "tool_use",
            id: "toolu_1",
            name: "shell",
            inputJson: "{\"cmd\":\"ls\"}",
            stopped: true
          },
          {
            index: 2,
            type: "text",
            citations: [{
              type: "webpage_location",
              url: "https://example.com",
              cited_text: "source"
            }],
            stopped: true
          }
        ]
      }
    });
    expect(observation.observerDrift).toEqual([{
      reason: "unknown_delta_type",
      eventType: "content_block_delta",
      deltaType: "future_delta",
      keys: ["delta", "index", "type"]
    }]);

    const eventMetadata = streamObservationEventMetadata(observation);
    const eventMetadataText = JSON.stringify(eventMetadata);
    expect(eventMetadataText).not.toContain("thøught");
    expect(eventMetadataText).not.toContain("sig_1");
    expect(eventMetadataText).not.toContain("{\"cmd\":\"ls\"}");
    expect((eventMetadata.streamMetadata as any).anthropicMessages.blocks[0].thinking).toEqual({
      sha256: expect.stringMatching(/^sha256:/),
      chars: 13
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
