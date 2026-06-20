import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { bufferedStreamResponse, collectStreamResponse } from "../src/bufferedStreamResponse.js";
import { sseObserverForDialect } from "../src/sseObserver.js";

async function fixtureBytes(name: string) {
  const path = fileURLToPath(new URL(`./fixtures/sse/${name}`, import.meta.url));
  return new Uint8Array(await readFile(path));
}

describe("buffered stream response", () => {
  it("preserves Anthropic text and tool_use blocks when buffering SSE", async () => {
    const encoder = new TextEncoder();
    const input = [
      ["message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "checking" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "shell", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"cmd\":\"ls\"}" } }],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } }],
      ["message_stop", { type: "message_stop" }]
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

    const collected = await collectStreamResponse(
      [encoder.encode(input)],
      sseObserverForDialect("anthropic-messages"),
      "anthropic-messages"
    );
    const response = bufferedStreamResponse(
      "anthropic-messages",
      "gpt-routed",
      "completed",
      collected.observation,
      collected.outputText,
      collected.content
    ) as any;

    expect(response.content).toEqual([
      { type: "text", text: "checking" },
      { type: "tool_use", id: "toolu_1", name: "shell", input: { cmd: "ls" } }
    ]);
    expect(response.usage).toEqual({ input_tokens: 5, output_tokens: 4 });
  });

  it("preserves split tool argument deltas and ignores empty deltas", async () => {
    const bytes = await fixtureBytes("anthropic-messages-split-tool-args-empty-deltas.sse");
    const chunks = [
      bytes.subarray(0, 17),
      bytes.subarray(17, 91),
      bytes.subarray(91)
    ];
    const collected = await collectStreamResponse(
      chunks,
      sseObserverForDialect("anthropic-messages"),
      "anthropic-messages"
    );
    const response = bufferedStreamResponse(
      "anthropic-messages",
      "claude-routed",
      "completed",
      collected.observation,
      collected.outputText,
      collected.content
    ) as any;

    expect(collected.outputText).toBe("checking ");
    expect(response.content).toEqual([
      { type: "text", text: "checking " },
      { type: "tool_use", id: "toolu_split", name: "shell", input: { cmd: "ls", cwd: "/tmp" } }
    ]);
    expect(response.usage).toEqual({ input_tokens: 7, output_tokens: 5 });
  });
});
