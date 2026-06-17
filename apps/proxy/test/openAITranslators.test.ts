import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  TRANSLATABLE_DIALECT_PAIRS,
  TRANSLATION_COMPATIBILITY_DIALECTS
} from "@prompt-proxy/schema/translationCompatibility";
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

describe("translation compatibility registry", () => {
  it("keeps the shared compatibility matrix aligned with registered translators", () => {
    const expectedPairs = new Set(TRANSLATABLE_DIALECT_PAIRS.map(([from, to]) => `${from}->${to}`));

    for (const from of TRANSLATION_COMPATIBILITY_DIALECTS) {
      for (const to of TRANSLATION_COMPATIBILITY_DIALECTS) {
        if (from === to) continue;
        expect(translators.canTranslate(from, to), `${from}->${to}`).toBe(expectedPairs.has(`${from}->${to}`));
      }
    }
  });
});

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

describe("Anthropic Messages to OpenAI translators", () => {
  it("maps Messages request history to Chat messages and preserves tool IDs", () => {
    const translator = translators.get("anthropic-messages", "openai-chat");
    const request = translator?.request({
      model: "claude-router-hard",
      system: "Use tools carefully.",
      messages: [
        { role: "user", content: [{ type: "text", text: "list files" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "shell", input: { cmd: "ls" } }]
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]
        }
      ],
      tools: [{ name: "shell", description: "Run shell", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "shell" },
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      metadata: { user_id: "user_1" },
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      mcp_servers: [{ type: "url", url: "https://mcp.example" }],
      top_k: 10,
      max_output_tokens: 123
    }) as any;

    expect(request.messages).toEqual([
      { role: "system", content: "Use tools carefully." },
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "toolu_1",
          type: "function",
          function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" }
        }]
      },
      { role: "tool", tool_call_id: "toolu_1", content: "ok" }
    ]);
    expect(request.tools).toEqual([
      { type: "function", function: { name: "shell", description: "Run shell", parameters: { type: "object" } } }
    ]);
    expect(request.tool_choice).toEqual({ type: "function", function: { name: "shell" } });
    expect(request.max_completion_tokens).toBe(123);
    expect(request.max_output_tokens).toBeUndefined();
    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
    expect(request.metadata).toBeUndefined();
    expect(request.context_management).toBeUndefined();
    expect(request.mcp_servers).toBeUndefined();
    expect(request.top_k).toBeUndefined();
  });

  it("maps Messages tool choice to OpenAI Responses", () => {
    const translator = translators.get("anthropic-messages", "openai-responses");
    const request = translator?.request({
      messages: [{ role: "user", content: "list files" }],
      tools: [{ name: "shell", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "shell" },
      stop_sequences: ["DONE"],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      metadata: { user_id: "user_1" },
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      mcp_servers: [{ type: "url", url: "https://mcp.example" }],
      top_k: 10,
      max_tokens: 123
    }) as any;

    expect(request.tools).toEqual([
      { type: "function", name: "shell", description: undefined, parameters: { type: "object" } }
    ]);
    expect(request.tool_choice).toEqual({ type: "function", name: "shell" });
    expect(request.stop).toEqual(["DONE"]);
    expect(request.stop_sequences).toBeUndefined();
    expect(request.stream).toBe(true);
    expect(request.max_output_tokens).toBe(123);
    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
    expect(request.metadata).toBeUndefined();
    expect(request.context_management).toBeUndefined();
    expect(request.mcp_servers).toBeUndefined();
    expect(request.top_k).toBeUndefined();
  });

  it("transforms Anthropic SSE to Responses SSE", async () => {
    const translator = translators.get("anthropic-messages", "openai-responses");
    const input = [
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 0 } } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } })}`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 2 } })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`
    ].join("\n\n");

    const out = await transform(translator!, `${input}\n\n`);

    expect(out).toContain("event: response.output_text.delta");
    expect(out).toContain("\"delta\":\"done\"");
    expect(out).toContain("event: response.completed");
    expect(out).toContain("\"input_tokens\":5");
    expect(out).toContain("\"output_tokens\":2");
  });
});

describe("OpenAI to Anthropic Messages translators", () => {
  it("maps Chat request fields to Messages and removes OpenAI-only fields", () => {
    const translator = translators.get("openai-chat", "anthropic-messages");
    const request = translator?.request({
      messages: [
        { role: "system", content: "Use tools carefully." },
        { role: "user", content: "list files" }
      ],
      tools: [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "shell" } },
      max_completion_tokens: 123,
      parallel_tool_calls: true,
      response_format: { type: "json_object" },
      stream_options: { include_usage: true },
      store: true
    }) as any;

    expect(request.system).toEqual([{ type: "text", text: "Use tools carefully." }]);
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "list files" }] }
    ]);
    expect(request.tools).toEqual([
      { name: "shell", description: undefined, input_schema: { type: "object" } }
    ]);
    expect(request.tool_choice).toEqual({ type: "tool", name: "shell" });
    expect(request.max_tokens).toBe(123);
    expect(request.parallel_tool_calls).toBeUndefined();
    expect(request.response_format).toBeUndefined();
    expect(request.stream_options).toBeUndefined();
    expect(request.store).toBeUndefined();
  });

  it("maps Responses request items to Messages and preserves function IDs", () => {
    const translator = translators.get("openai-responses", "anthropic-messages");
    const request = translator?.request({
      model: "router-hard",
      instructions: "Use tools carefully.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
        { id: "call_1", type: "function_call", call_id: "call_1", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" }
      ],
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "shell" },
      include: ["reasoning.encrypted_content"],
      parallel_tool_calls: true,
      prompt_cache_key: "cache-key",
      client_metadata: { session: "codex" },
      store: true,
      stop: "DONE",
      max_output_tokens: 456
    }) as any;

    expect(request.system).toEqual([{ type: "text", text: "Use tools carefully." }]);
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "list files" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "shell", input: { cmd: "ls" } }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }]
      }
    ]);
    expect(request.tools).toEqual([
      { name: "shell", description: undefined, input_schema: { type: "object" } }
    ]);
    expect(request.tool_choice).toEqual({ type: "tool", name: "shell" });
    expect(request.stop_sequences).toEqual(["DONE"]);
    expect(request.stop).toBeUndefined();
    expect(request.max_tokens).toBe(456);
    expect(request.include).toBeUndefined();
    expect(request.parallel_tool_calls).toBeUndefined();
    expect(request.prompt_cache_key).toBeUndefined();
    expect(request.client_metadata).toBeUndefined();
    expect(request.store).toBeUndefined();
  });

  it("maps Responses string image URLs to Anthropic image blocks", () => {
    const translator = translators.get("openai-responses", "anthropic-messages");
    const request = translator?.request({
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "inspect this" },
          { type: "input_image", image_url: "data:image/png;base64,abc123" }
        ]
      }]
    }) as any;

    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } }
        ]
      }
    ]);
  });

  it("transforms Chat SSE to Anthropic Messages SSE once usage arrives", async () => {
    const translator = translators.get("openai-chat", "anthropic-messages");
    const input = [
      `data: ${JSON.stringify({ id: "chatcmpl_1", choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }], usage: null })}`,
      `data: ${JSON.stringify({ id: "chatcmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null })}`,
      `data: ${JSON.stringify({ id: "chatcmpl_1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}`,
      "data: [DONE]"
    ].join("\n\n");

    const out = await transform(translator!, `${input}\n\n`);

    expect(out.match(/event: message_stop/g)).toHaveLength(1);
    expect(out).toContain("event: content_block_delta");
    expect(out).toContain("event: content_block_stop");
    expect(out).toContain("\"text\":\"done\"");
    expect(out).toContain("\"input_tokens\":5");
    expect(out).toContain("\"output_tokens\":2");
  });

  it("transforms Responses SSE to Anthropic Messages SSE with closed content blocks", async () => {
    const translator = translators.get("openai-responses", "anthropic-messages");
    const input = [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-source" } })}`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "done" })}`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } })}`
    ].join("\n\n");

    const out = await transform(translator!, `${input}\n\n`);

    expect(out).toContain("event: content_block_delta");
    expect(out).toContain("event: content_block_stop");
    expect(out.indexOf("event: content_block_stop")).toBeLessThan(out.indexOf("event: message_delta"));
    expect(out).toContain("\"text\":\"done\"");
    expect(out).toContain("\"input_tokens\":5");
    expect(out).toContain("\"output_tokens\":2");
  });
});
