import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { translators } from "../src/translators/index.js";

async function fixture(name: string) {
  const path = fileURLToPath(new URL(`./fixtures/translators/${name}`, import.meta.url));
  return readFile(path, "utf8");
}

async function transform(translator: NonNullable<ReturnType<typeof translators.get>>, text: string) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const chunks = [
    encoder.encode(text.slice(0, Math.floor(text.length / 2))),
    encoder.encode(text.slice(Math.floor(text.length / 2)))
  ];
  let out = "";
  for await (const chunk of translator.sseTransform(chunks)) {
    out += decoder.decode(chunk, { stream: true });
  }
  return out + decoder.decode();
}

function normalizedSse(text: string) {
  return `${text.trimEnd()}\n\n`;
}

describe("OpenAI Responses to Chat translator", () => {
  const translator = translators.get("openai-responses", "openai-chat");

  it("maps request fields to chat names", () => {
    const request = translator?.request({
      model: "router-hard",
      instructions: "Use tools carefully.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] }],
      tools: [{ type: "function", name: "shell", description: "Run shell", parameters: { type: "object" } }],
      reasoning: { effort: "high" },
      max_output_tokens: 123,
      stream: true
    }) as any;

    expect(request.messages).toEqual([
      { role: "system", content: "Use tools carefully." },
      { role: "user", content: [{ type: "text", text: "list files" }] }
    ]);
    expect(request.tools).toEqual([
      { type: "function", function: { name: "shell", description: "Run shell", parameters: { type: "object" } } }
    ]);
    expect(request.reasoning_effort).toBe("high");
    expect(request.max_completion_tokens).toBe(123);
    expect(request.input).toBeUndefined();
    expect(request.max_output_tokens).toBeUndefined();
  });

  it("maps non-streaming responses to chat completions", () => {
    const response = translator?.response({
      id: "resp_fixture",
      model: "gpt-source",
      output: [
        { type: "message", content: [{ type: "output_text", text: "done" }] },
        { id: "call_1", type: "function_call", name: "shell", arguments: "{\"cmd\":\"ls\"}" }
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 6,
        total_tokens: 16
      }
    }) as any;

    expect(response.choices[0].message).toEqual({
      role: "assistant",
      content: "done",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" }
      }]
    });
    expect(response.usage).toEqual({
      prompt_tokens: 10,
      prompt_tokens_details: undefined,
      completion_tokens: 6,
      completion_tokens_details: undefined,
      total_tokens: 16
    });
  });

  it("transforms golden streaming frames", async () => {
    expect(normalizedSse(await transform(
      translator!,
      await fixture("openai-responses-to-chat.input.sse")
    ))).toBe(normalizedSse(await fixture("openai-responses-to-chat.expected.sse")));
  });
});

describe("OpenAI Chat to Responses translator", () => {
  const translator = translators.get("openai-chat", "openai-responses");

  it("maps request fields to responses names", () => {
    const request = translator?.request({
      model: "router-hard",
      messages: [
        { role: "system", content: "Use tools carefully." },
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }]
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" }
      ],
      tools: [{ type: "function", function: { name: "shell", description: "Run shell", parameters: { type: "object" } } }],
      reasoning_effort: "high",
      max_completion_tokens: 123,
      stream_options: { include_usage: true }
    }) as any;

    expect(request.instructions).toBe("Use tools carefully.");
    expect(request.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
      { id: "call_1", type: "function_call", call_id: "call_1", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" }
    ]);
    expect(request.tools).toEqual([
      { type: "function", name: "shell", description: "Run shell", parameters: { type: "object" } }
    ]);
    expect(request.reasoning).toEqual({ effort: "high" });
    expect(request.max_output_tokens).toBe(123);
    expect(request.messages).toBeUndefined();
    expect(request.stream_options).toBeUndefined();
  });

  it("maps non-streaming responses to Responses shape", () => {
    const response = translator?.response({
      id: "chatcmpl_fixture",
      model: "gpt-source",
      choices: [{
        message: {
          role: "assistant",
          content: "done",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }]
        }
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 6,
        total_tokens: 16
      }
    }) as any;

    expect(response.output).toEqual([
      { id: "msg_translated", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { id: "call_1", type: "function_call", call_id: "call_1", name: "shell", arguments: "{\"cmd\":\"ls\"}" }
    ]);
    expect(response.usage).toEqual({
      input_tokens: 10,
      input_tokens_details: undefined,
      output_tokens: 6,
      output_tokens_details: undefined,
      total_tokens: 16
    });
  });

  it("transforms golden streaming frames", async () => {
    expect(normalizedSse(await transform(
      translator!,
      await fixture("openai-chat-to-responses.input.sse")
    ))).toBe(normalizedSse(await fixture("openai-chat-to-responses.expected.sse")));
  });
});
