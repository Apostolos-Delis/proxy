import { describe, expect, it } from "vitest";

import { events as eventTable } from "@proxy/db";

import { attributeTokens } from "../src/tokenAttribution.js";
import { captureFixture } from "./promptTestFixture.js";

describe("attributeTokens", () => {
  it("decomposes an Anthropic agentic-loop request into buckets", () => {
    const system = "You are a coding agent.";
    const toolResultOutput = "x".repeat(5000);
    const latestUserText = "also check the lint output";
    const body = {
      model: "coding-auto",
      system,
      tools: [
        { name: "Bash", description: "run commands", input_schema: { type: "object" } },
        { name: "mcp__linear__create_issue", input_schema: { type: "object" } },
        { name: "mcp__linear__list_issues", input_schema: { type: "object" } }
      ],
      messages: [
        { role: "user", content: "fix the failing test" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Running the tests." },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pytest -q" } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: toolResultOutput },
            { type: "text", text: latestUserText }
          ]
        }
      ]
    };

    const attribution = attributeTokens("anthropic-messages", body, "org prompt");

    expect(attribution.requestedModel).toBe("coding-auto");
    expect(attribution.systemPrompt.chars).toBe(system.length);
    expect(attribution.orgSystemPrompt.chars).toBe("org prompt".length);
    expect(attribution.history.messages).toBe(2);
    expect(attribution.history.chars).toBeGreaterThan(0);
    expect(attribution.newToolResults.blocks).toBe(1);
    expect(attribution.newToolResults.chars).toBe(toolResultOutput.length);
    const bashResult = attribution.newToolResultsByTool[0];
    expect(bashResult.tool).toBe("Bash");
    expect(bashResult.chars).toBe(toolResultOutput.length);
    expect(bashResult.blocks).toBe(1);
    expect(bashResult.estimatedTokens).toBeGreaterThan(0);
    expect(attribution.latestUser.chars).toBe(latestUserText.length);
    expect(attribution.toolSchemas.count).toBe(3);
    const schemaNames = attribution.toolSchemasByName.map((entry) => entry.name);
    expect(schemaNames).toContain("Bash");
    expect(schemaNames).toContain("mcp__linear");
    expect(schemaNames).toHaveLength(2);
    const schemaHashes = attribution.toolSchemaHashesByName;
    expect(schemaHashes.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "Bash",
      "mcp__linear__create_issue",
      "mcp__linear__list_issues"
    ]));
    expect(schemaHashes.every((entry) => entry.schemaHash.startsWith("sha256:"))).toBe(true);
    expect(attribution.total.chars).toBe(
      attribution.systemPrompt.chars +
        attribution.orgSystemPrompt.chars +
        attribution.toolSchemas.chars +
        attribution.history.chars +
        attribution.newToolResults.chars +
        attribution.latestUser.chars
    );
  });

  it("attributes the trailing function_call_output run on the OpenAI surface", () => {
    const output = "y".repeat(2000);
    const body = {
      model: "coding-auto",
      instructions: "be terse",
      tools: [{ type: "function", name: "shell" }],
      input: [
        { type: "message", role: "user", content: "run the tests" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Running." }] },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output }
      ]
    };

    const attribution = attributeTokens("openai-responses", body);

    expect(attribution.systemPrompt.chars).toBe("be terse".length);
    expect(attribution.orgSystemPrompt.chars).toBe(0);
    // user + assistant message items, plus the echoed function_call in the tail
    expect(attribution.history.messages).toBe(3);
    expect(attribution.latestUser.chars).toBe(0);
    expect(attribution.newToolResults.blocks).toBe(1);
    expect(attribution.newToolResults.chars).toBe(output.length);
    expect(attribution.newToolResultsByTool[0].tool).toBe("shell");
  });

  it("attributes interleaved parallel call/output pairs in the tail", () => {
    const body = {
      model: "coding-auto",
      input: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "On it." }] },
        { type: "function_call", call_id: "a", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "a", output: "A".repeat(100) },
        { type: "function_call", call_id: "b", name: "mcp__linear__list_issues", arguments: "{}" },
        { type: "function_call_output", call_id: "b", output: "B".repeat(200) }
      ]
    };

    const attribution = attributeTokens("openai-responses", body);

    expect(attribution.newToolResults.blocks).toBe(2);
    expect(attribution.newToolResults.chars).toBe(300);
    const tools = Object.fromEntries(attribution.newToolResultsByTool.map((entry) => [entry.tool, entry.chars]));
    expect(tools).toEqual({ "mcp__linear": 200, shell: 100 });
  });

  it("treats a plain string input as the latest user message", () => {
    const attribution = attributeTokens("openai-responses", { model: "coding-auto", input: "hello" });
    expect(attribution.latestUser.chars).toBe(5);
    expect(attribution.history.messages).toBe(0);
    expect(attribution.newToolResults.blocks).toBe(0);
  });

  it("attributes Cursor-style flat chat tool calls", () => {
    const output = "z".repeat(1200);
    const body = {
      model: "coding-auto",
      tools: [{ name: "run_terminal_cmd", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: "run the command" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", name: "run_terminal_cmd", arguments: { command: "pwd" } }]
        },
        { role: "tool", tool_call_id: "call_1", content: output }
      ]
    };

    const attribution = attributeTokens("openai-chat", body);

    expect(attribution.toolSchemasByName[0]?.name).toBe("run_terminal_cmd");
    expect(attribution.newToolResults.blocks).toBe(1);
    expect(attribution.newToolResults.chars).toBe(output.length);
    expect(attribution.newToolResultsByTool[0]?.tool).toBe("run_terminal_cmd");
  });

  it("counts everything as history when the last message is from the assistant", () => {
    const attribution = attributeTokens("anthropic-messages", {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" }
      ]
    });
    expect(attribution.history.messages).toBe(2);
    expect(attribution.latestUser.chars).toBe(0);
  });
});

describe("tokens.attributed event", () => {
  it("is appended for Anthropic Messages requests", async () => {
    const fixture = await captureFixture("org_token_attribution_anthropic", "hash_only");

    const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fable",
        max_tokens: 256,
        system: "You are a coding agent.",
        tools: [{ name: "Bash", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "fix the failing auth test" }]
      })
    });
    expect(response.status).toBe(200);
    await response.text();

    const events = await fixture.db.select().from(eventTable);
    await fixture.close();

    const attributed = events.find((event: any) => event.eventType === "tokens.attributed");
    expect(attributed).toBeTruthy();
    expect(attributed.payload.surface).toBe("anthropic-messages");
    expect(attributed.payload.latestUser.chars).toBe("fix the failing auth test".length);
    expect(attributed.payload.toolSchemas.count).toBe(1);
    expect(attributed.payload.total.estimatedTokens).toBeGreaterThan(0);
  });

  it("is appended for OpenAI Responses requests with tool outputs", async () => {
    const fixture = await captureFixture("org_token_attribution_openai", "hash_only");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "coding-auto",
        tools: [{ type: "function", name: "shell" }],
        input: [
          { type: "message", role: "user", content: "run the tests" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Running." }] },
          { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "全部通过 all 42 tests passed" }
        ],
        stream: true
      })
    });
    expect(response.status).toBe(200);
    await response.text();

    const events = await fixture.db.select().from(eventTable);
    await fixture.close();

    const attributed = events.find((event: any) => event.eventType === "tokens.attributed");
    expect(attributed).toBeTruthy();
    expect(attributed.payload.surface).toBe("openai-responses");
    expect(attributed.payload.newToolResults.blocks).toBe(1);
    expect(attributed.payload.newToolResultsByTool[0].tool).toBe("shell");
  });
});
