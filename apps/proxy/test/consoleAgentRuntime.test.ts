import { describe, expect, it } from "vitest";

import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { assistantText, assistantToolCall, scriptedStream, stubModel } from "./consoleAgentTestKit.js";

const echoTool: AgentTool<ReturnType<typeof echoParameters>> = {
  name: "echo",
  label: "Echo",
  description: "Echo the provided value back to the model.",
  parameters: echoParameters(),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: `echo:${params.value}` }],
    details: { value: params.value }
  })
};

function echoParameters() {
  return Type.Object({ value: Type.String() });
}

function buildAgent(script: AssistantMessage[], messages: AgentMessage[] = []) {
  return new Agent({
    initialState: {
      systemPrompt: "You are a console agent under test.",
      model: stubModel,
      thinkingLevel: "off",
      tools: [echoTool],
      messages
    },
    streamFn: scriptedStream(script)
  });
}

function textOf(message: AgentMessage | undefined) {
  if (!message || (message.role !== "assistant" && message.role !== "toolResult")) {
    throw new Error("expected an assistant or tool message");
  }
  const first = message.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return first.text;
}

describe("pi agent runtime adoption", () => {
  it("drives a two-turn loop with a stub tool and emits the lifecycle event sequence", async () => {
    const agent = buildAgent([
      assistantToolCall("echo", { value: "hello" }),
      assistantText("The echo tool returned hello.")
    ]);
    const events: string[] = [];
    agent.subscribe((event) => {
      events.push(event.type);
    });

    await agent.prompt("Run the echo tool with the value hello.");
    await agent.waitForIdle();

    expect(events[0]).toBe("agent_start");
    expect(events.at(-1)).toBe("agent_end");
    const toolStart = events.indexOf("tool_execution_start");
    const toolEnd = events.indexOf("tool_execution_end");
    expect(toolStart).toBeGreaterThan(0);
    expect(toolEnd).toBeGreaterThan(toolStart);

    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant"
    ]);
    expect(textOf(agent.state.messages[2])).toBe("echo:hello");
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it("round-trips the transcript through JSON for session_state persistence and resumes", async () => {
    const first = buildAgent([
      assistantToolCall("echo", { value: "persist-me" }),
      assistantText("Stored.")
    ]);
    await first.prompt("Echo persist-me.");
    await first.waitForIdle();

    const serialized = JSON.parse(JSON.stringify(first.state.messages)) as AgentMessage[];
    expect(serialized).toHaveLength(4);

    const resumed = buildAgent([assistantText("Resumed with full context.")], serialized);
    await resumed.prompt("Continue the conversation.");
    await resumed.waitForIdle();

    expect(resumed.state.messages).toHaveLength(serialized.length + 2);
    expect(textOf(resumed.state.messages.at(-1))).toBe("Resumed with full context.");
    expect(JSON.parse(JSON.stringify(resumed.state.messages.slice(0, 4)))).toEqual(serialized);
  });

  it("aborts a run cleanly", async () => {
    const hangsUntilAborted: StreamFn = (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const pushAborted = () => {
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...assistantText(""), stopReason: "aborted", errorMessage: "aborted" }
        });
      };
      if (options?.signal?.aborted) {
        queueMicrotask(pushAborted);
      } else {
        options?.signal?.addEventListener("abort", pushAborted);
      }
      return stream;
    };
    const agent = new Agent({
      initialState: {
        systemPrompt: "You are a console agent under test.",
        model: stubModel,
        thinkingLevel: "off",
        tools: [echoTool]
      },
      streamFn: hangsUntilAborted
    });

    const run = agent.prompt("This run will be aborted.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    agent.abort();
    await run;
    await agent.waitForIdle();

    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.errorMessage).toBeTruthy();
  });
});
