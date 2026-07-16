import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  TRANSLATABLE_DIALECT_PAIRS,
  TRANSLATION_COMPATIBILITY_DIALECTS
} from "@proxy/schema/translationCompatibility";
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
      model: "coding-auto",
      instructions: "Use tools carefully.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] }],
      tools: [{ type: "function", name: "shell", description: "Run shell", parameters: { type: "object" } }],
      reasoning: { effort: "high" },
      max_output_tokens: 123,
      prompt_cache_key: "responses-cache-key",
      prompt_cache_retention: "24h",
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
    expect(request.prompt_cache_key).toBe("responses-cache-key");
    expect(request.prompt_cache_retention).toBe("24h");
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
      model: "coding-auto",
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
      prompt_cache_key: "chat-cache-key",
      prompt_cache_retention: "24h",
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
    expect(request.prompt_cache_key).toBe("chat-cache-key");
    expect(request.prompt_cache_retention).toBe("24h");
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
      model: "fable",
      system: "Use tools carefully.",
      cache_control: { type: "ephemeral" },
      messages: [
        { role: "user", content: [{ type: "text", text: "list files", cache_control: { type: "ephemeral" } }] },
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
    expect(JSON.stringify(request)).not.toContain("cache_control");
  });

  it("maps Messages tool choice to OpenAI Responses", () => {
    const translator = translators.get("anthropic-messages", "openai-responses");
    const request = translator?.request({
      messages: [{ role: "user", content: "list files" }],
      cache_control: { type: "ephemeral" },
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
    expect(JSON.stringify(request)).not.toContain("cache_control");
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

  it("keeps streamed Responses output indexes distinct when Anthropic streams a tool before text", async () => {
    const translator = translators.get("anthropic-messages", "openai-responses");
    const input = [
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: {} } })}`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "shell" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "after tool" } })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`
    ].join("\n\n");

    const out = await transform(translator!, `${input}\n\n`);

    expect(out).toContain("\"output_index\":0,\"item\":{\"id\":\"toolu_1\"");
    expect(out).toContain("\"output_index\":1,\"item\":{\"id\":\"msg_translated\"");
    expect(out).toContain("\"output_index\":1,\"content_index\":0,\"delta\":\"after tool\"");
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
      prompt_cache_key: "chat-cache-key",
      prompt_cache_retention: "24h",
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
    expect(request.prompt_cache_key).toBeUndefined();
    expect(request.prompt_cache_retention).toBeUndefined();
    expect(request.store).toBeUndefined();
  });

  it("maps Responses request items to Messages and preserves function IDs", () => {
    const translator = translators.get("openai-responses", "anthropic-messages");
    const request = translator?.request({
      model: "coding-auto",
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
      prompt_cache_retention: "24h",
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
    expect(request.prompt_cache_retention).toBeUndefined();
    expect(request.client_metadata).toBeUndefined();
    expect(request.store).toBeUndefined();
  });

  it("flattens Codex namespace tools and drops provider-hosted tools", () => {
    const translator = translators.get("openai-responses", "anthropic-messages");
    const request = translator?.request({
      input: [],
      tools: [
        { type: "function", name: "exec_command", description: "run", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "multi_agent_v1",
          description: "agents",
          tools: [
            { type: "function", name: "spawn_agent", description: "spawn", parameters: { type: "object" } }
          ]
        },
        {
          type: "namespace",
          name: "mcp__codex_apps__github",
          description: "github",
          tools: [
            { type: "function", name: "_add_comment_to_issue", description: "comment", parameters: { type: "object" } }
          ]
        },
        { type: "web_search", external_web_access: true },
        { type: "image_generation", output_format: "png" }
      ]
    }) as any;

    expect(request.tools).toEqual([
      { name: "exec_command", description: "run", input_schema: { type: "object" } },
      { name: "ns_14_multi_agent_v1spawn_agent", description: "spawn", input_schema: { type: "object" } },
      { name: "ns_23_mcp__codex_apps__github_add_comment_to_issue", description: "comment", input_schema: { type: "object" } }
    ]);
    for (const tool of request.tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    }
  });

  it("re-encodes namespaced Responses tool choices to flattened Anthropic tool names", () => {
    const translator = translators.get("openai-responses", "anthropic-messages");
    const request = translator?.request({
      input: [],
      tools: [{
        type: "namespace",
        name: "multi_agent_v1",
        tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }]
      }],
      tool_choice: { type: "function", name: "spawn_agent", namespace: "multi_agent_v1" }
    }) as any;

    expect(request.tools).toEqual([
      { name: "ns_14_multi_agent_v1spawn_agent", description: undefined, input_schema: { type: "object" } }
    ]);
    expect(request.tool_choice).toEqual({ type: "tool", name: "ns_14_multi_agent_v1spawn_agent" });
  });

  it("re-encodes namespaced function_call history into matching tool_use names", () => {
    const translator = translators.get("openai-responses", "anthropic-messages");
    const request = translator?.request({
      input: [
        { type: "function_call", call_id: "c1", name: "spawn_agent", namespace: "multi_agent_v1", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "exec_command", arguments: "{}" }
      ]
    }) as any;

    expect(request.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "ns_14_multi_agent_v1spawn_agent", input: {} }]
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c2", name: "exec_command", input: {} }]
      }
    ]);
  });

  it("decodes flattened namespace tool calls back to name + namespace (non-stream)", () => {
    const translator = translators.get("anthropic-messages", "openai-responses");
    const response = translator?.response({
      id: "msg_1",
      content: [
        { type: "tool_use", id: "toolu_1", name: "ns_23_mcp__codex_apps__github_add_comment_to_issue", input: { body: "hi" } },
        { type: "tool_use", id: "toolu_2", name: "exec_command", input: { cmd: "ls" } }
      ]
    }) as any;

    const calls = response.output.filter((o: any) => o.type === "function_call");
    expect(calls[0]).toMatchObject({ name: "_add_comment_to_issue", namespace: "mcp__codex_apps__github", call_id: "toolu_1" });
    expect(calls[1]).toMatchObject({ name: "exec_command", call_id: "toolu_2" });
    expect(calls[1].namespace).toBeUndefined();
  });

  it("decodes flattened namespace tool calls in the streamed response", async () => {
    const translator = translators.get("anthropic-messages", "openai-responses")!;
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{}}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"ns_14_multi_agent_v1spawn_agent"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      ""
    ].join("\n");
    const out = await transform(translator, sse);
    expect(out).toContain('"name":"spawn_agent"');
    expect(out).toContain('"namespace":"multi_agent_v1"');
  });

  it("drops namespaced sub-tools whose encoded name exceeds Anthropic's 128-char cap", () => {
    const translator = translators.get("openai-responses", "anthropic-messages");
    const longName = "x".repeat(130);
    const request = translator?.request({
      input: [],
      tools: [{
        type: "namespace",
        name: "mcp__svc",
        description: "svc",
        tools: [
          { type: "function", name: "ok_tool", description: "ok", parameters: { type: "object" } },
          { type: "function", name: longName, description: "too long", parameters: { type: "object" } }
        ]
      }]
    }) as any;

    expect(request.tools).toEqual([
      { name: "ns_8_mcp__svcok_tool", description: "ok", input_schema: { type: "object" } }
    ]);
    for (const tool of request.tools) {
      expect(tool.name.length).toBeLessThanOrEqual(128);
    }
  });

  it("falls back to the plain name when a function_call history item has no namespace", () => {
    const translator = translators.get("openai-responses", "anthropic-messages");
    const request = translator?.request({
      input: [
        { type: "function_call", call_id: "c1", name: "exec_command", namespace: "", arguments: "{}" }
      ]
    }) as any;

    expect(request.messages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "exec_command", input: {} }] }
    ]);
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

  it("marks streamed Responses function calls as Anthropic tool_use stops", async () => {
    const translator = translators.get("openai-responses", "anthropic-messages");
    const input = [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-source" } })}`,
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "call_1", call_id: "call_1", type: "function_call", name: "spawn_agent", namespace: "multi_agent_v1" }
      })}`,
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: "{\"cmd\":\"ls\"}"
      })}`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } })}`
    ].join("\n\n");

    const out = await transform(translator!, `${input}\n\n`);

    expect(out).toContain("\"type\":\"tool_use\"");
    expect(out).toContain("\"name\":\"ns_14_multi_agent_v1spawn_agent\"");
    expect(out).toContain("\"partial_json\":\"{\\\"cmd\\\":\\\"ls\\\"}\"");
    expect(out).toContain("\"stop_reason\":\"tool_use\"");
  });
});
