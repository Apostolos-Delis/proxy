import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createTransactionalDatabase, organizations, users } from "@prompt-proxy/db";

import {
  ConsoleAgentRuntime,
  ConsoleAgentRuntimeError,
  type ConsoleAgentRunLimits
} from "../src/console-agent/runtime.js";
import { CapabilityRegistry } from "../src/console-agent/registry.js";
import { ConsoleAgentStore } from "../src/persistence/consoleAgentStore.js";
import type { ConsoleAgentEmittedEvent } from "../src/console-agent/runtime.js";
import {
  assistantText,
  assistantToolCall,
  migratedPgliteDb,
  scriptedStream,
  stubModel
} from "./consoleAgentTestKit.js";

const ORG = "org_agent_runtime";
const USER = "user_runtime";

function buildRegistry() {
  return new CapabilityRegistry().register({
    key: "widgets.lookup.v1",
    description: "Look up a widget by id.",
    input: z.object({ id: z.string() }),
    sideEffect: "none",
    handler: async (_context, input) => ({ widget: { id: input.id } })
  });
}

function streamWithTextDeltas(text: string): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = assistantText(text);
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

describe("console agent runtime service", () => {
  let fixture: Awaited<ReturnType<typeof migratedPgliteDb>>;
  let store: ConsoleAgentStore;

  beforeAll(async () => {
    fixture = await migratedPgliteDb();
    await fixture.db.insert(organizations).values({ id: ORG, slug: "org-agent-runtime", name: ORG });
    await fixture.db.insert(users).values({ id: USER });
    store = new ConsoleAgentStore(createTransactionalDatabase(fixture.db), fixture.db);
  });

  afterAll(async () => {
    await fixture.client.close();
  });

  function buildRuntime(
    script: AssistantMessage[] | StreamFn,
    overrides: { store?: ConsoleAgentStore; limits?: ConsoleAgentRunLimits; registry?: CapabilityRegistry } = {}
  ) {
    return new ConsoleAgentRuntime({
      store: overrides.store ?? store,
      registry: overrides.registry ?? buildRegistry(),
      model: stubModel,
      thinkingLevel: "off",
      streamFn: typeof script === "function" ? script : scriptedStream(script),
      limits: overrides.limits
    });
  }

  it("drives a multi-tool turn, persists ordered events, and finalizes the run", async () => {
    const conversation = await store.createConversation({ organizationId: ORG, createdByUserId: USER });
    const runtime = buildRuntime([
      assistantToolCall("widgets_lookup_v1", { id: "w_7" }),
      assistantText("Widget w_7 exists.")
    ]);
    const seen: ConsoleAgentEmittedEvent[] = [];

    const result = await runtime.runTurn({
      organizationId: ORG,
      userId: USER,
      conversationId: conversation.id,
      text: "Does widget w_7 exist?",
      pageScope: { widgetId: "w_7" },
      onEvent: (event) => seen.push(event)
    });

    expect(result.status).toBe("finished");
    expect(result.run.status).toBe("finished");
    expect(seen.map((event) => event.type)).toEqual([
      "run_started",
      "tool_call_started",
      "tool_call_finished",
      "message_finished",
      "run_finished"
    ]);
    expect(seen.every((event) => event.runId === result.run.id)).toBe(true);

    const persisted = await store.listRunEvents(ORG, result.run.id);
    expect(persisted.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(persisted.map((event) => event.type)).toEqual(seen.map((event) => event.type));

    const messages = await store.listMessages(ORG, conversation.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.pageScope).toEqual({ widgetId: "w_7" });
    expect(messages[1]?.content).toEqual({ text: "Widget w_7 exists." });

    const updated = await store.getConversation(ORG, conversation.id);
    const sessionState = updated?.sessionState as { messages: unknown[] };
    expect(sessionState.messages.length).toBeGreaterThanOrEqual(4);
    expect(result.run.usage).toMatchObject({ totalTokens: 4 });
  });

  it("injects the capability manifest and page scope into the system prompt", async () => {
    const conversation = await store.createConversation({ organizationId: ORG, createdByUserId: USER });
    let capturedSystemPrompt: string | undefined;
    const inner = scriptedStream([assistantText("Done.")]);
    const capturing: StreamFn = (model, context, options) => {
      capturedSystemPrompt = context.systemPrompt;
      return inner(model, context, options);
    };
    const runtime = buildRuntime(capturing);

    await runtime.runTurn({
      organizationId: ORG,
      userId: USER,
      conversationId: conversation.id,
      text: "What is this?",
      pageScope: { requestId: "req_scope" }
    });

    expect(capturedSystemPrompt).toContain(`Organization: ${ORG}.`);
    expect(capturedSystemPrompt).toContain("widgets.lookup.v1 (read): Look up a widget by id.");
    expect(capturedSystemPrompt).toContain('"requestId":"req_scope"');
  });

  it("finalizes the run as failed when event persistence breaks", async () => {
    class FailingStore extends ConsoleAgentStore {
      override async appendRunEvent(input: Parameters<ConsoleAgentStore["appendRunEvent"]>[0]) {
        if (input.type === "tool_call_started") throw new Error("db blip");
        return super.appendRunEvent(input);
      }
    }
    const failingStore = new FailingStore(createTransactionalDatabase(fixture.db), fixture.db);
    const conversation = await failingStore.createConversation({ organizationId: ORG, createdByUserId: USER });
    const runtime = buildRuntime(
      [assistantToolCall("widgets_lookup_v1", { id: "w_9" }), assistantText("unreachable")],
      { store: failingStore }
    );

    const result = await runtime.runTurn({
      organizationId: ORG,
      userId: USER,
      conversationId: conversation.id,
      text: "Trigger a persistence failure."
    });

    expect(result.status).toBe("failed");
    expect(result.run.status).toBe("failed");
    expect(result.run.error).toBe("db blip");
    const persisted = await failingStore.listRunEvents(ORG, result.run.id);
    expect(persisted.at(-1)?.type).toBe("run_failed");
  });

  it("resumes a conversation in a fresh runtime with the prior transcript intact", async () => {
    const conversation = await store.createConversation({ organizationId: ORG, createdByUserId: USER });
    const first = buildRuntime([
      assistantToolCall("widgets_lookup_v1", { id: "w_8" }),
      assistantText("Found w_8.")
    ]);
    await first.runTurn({
      organizationId: ORG,
      userId: USER,
      conversationId: conversation.id,
      text: "Look up w_8."
    });
    const afterFirst = await store.getConversation(ORG, conversation.id);
    if (!afterFirst) throw new Error("conversation missing after first turn");
    const firstState = (afterFirst.sessionState as { messages: unknown[] }).messages;

    const second = buildRuntime([assistantText("Yes, as established, w_8 exists.")]);
    const result = await second.runTurn({
      organizationId: ORG,
      userId: USER,
      conversationId: conversation.id,
      text: "Was that widget real?"
    });
    expect(result.status).toBe("finished");

    const afterSecond = await store.getConversation(ORG, conversation.id);
    if (!afterSecond) throw new Error("conversation missing after second turn");
    const secondState = (afterSecond.sessionState as { messages: unknown[] }).messages;
    expect(secondState.slice(0, firstState.length)).toEqual(firstState);
    expect(secondState.length).toBe(firstState.length + 2);
  });

  it("cancels a running turn and finalizes it as cancelled", async () => {
    const conversation = await store.createConversation({ organizationId: ORG, createdByUserId: USER });
    const hangsUntilAborted: StreamFn = (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const pushAborted = () => {
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...assistantText(""), stopReason: "aborted", errorMessage: "aborted" }
        });
      };
      if (options?.signal?.aborted) queueMicrotask(pushAborted);
      else options?.signal?.addEventListener("abort", pushAborted);
      return stream;
    };
    const runtime = buildRuntime(hangsUntilAborted);

    let resolveRunId: (runId: string) => void;
    const runIdSeen = new Promise<string>((resolve) => {
      resolveRunId = resolve;
    });
    const turn = runtime.runTurn({
      organizationId: ORG,
      userId: USER,
      conversationId: conversation.id,
      text: "This will be cancelled.",
      onEvent: (event) => {
        resolveRunId(event.runId);
      }
    });
    expect(runtime.cancel(await runIdSeen)).toBe(true);

    const result = await turn;
    expect(result.status).toBe("cancelled");
    expect(result.run.status).toBe("cancelled");
    const persisted = await store.listRunEvents(ORG, result.run.id);
    expect(persisted.at(-1)?.type).toBe("run_finished");
    expect(persisted.at(-1)?.payload).toEqual({ status: "cancelled" });
    expect(runtime.cancel(result.run.id)).toBe(false);
  });

  it("forwards text deltas to listeners without persisting them", async () => {
    const conversation = await store.createConversation({ organizationId: ORG, createdByUserId: USER });
    const runtime = buildRuntime(streamWithTextDeltas("Streaming answer."));
    const seen: ConsoleAgentEmittedEvent[] = [];

    const result = await runtime.runTurn({
      organizationId: ORG,
      userId: USER,
      conversationId: conversation.id,
      text: "Stream something.",
      onEvent: (event) => seen.push(event)
    });

    const deltas = seen.filter((event) => event.type === "text_delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((event) => event.seq === undefined)).toBe(true);

    const persisted = await store.listRunEvents(ORG, result.run.id);
    expect(persisted.some((event) => event.type === "text_delta")).toBe(false);
  });

  it("rejects turns for unknown conversations", async () => {
    const runtime = buildRuntime([assistantText("unused")]);
    await expect(
      runtime.runTurn({
        organizationId: ORG,
        userId: USER,
        conversationId: "conv_missing",
        text: "hello"
      })
    ).rejects.toThrow(ConsoleAgentRuntimeError);
  });

  it("fails the run when a turn exceeds the tool-call limit", async () => {
    const conversation = await store.createConversation({ organizationId: ORG, createdByUserId: USER });
    const doubleToolCall: AssistantMessage = {
      ...assistantText(""),
      content: [
        { type: "toolCall", id: "call_a", name: "widgets_lookup_v1", arguments: { id: "w_a" } },
        { type: "toolCall", id: "call_b", name: "widgets_lookup_v1", arguments: { id: "w_b" } }
      ],
      stopReason: "toolUse"
    };
    const runtime = buildRuntime([doubleToolCall, assistantText("unreached")], {
      limits: { maxTurns: 16, maxToolCallsPerTurn: 1, timeoutMs: 120_000 }
    });

    const result = await runtime.runTurn({
      organizationId: ORG,
      userId: USER,
      conversationId: conversation.id,
      text: "Look up two widgets."
    });

    expect(result.status).toBe("failed");
    expect(result.run.error).toContain("more than 1 tool calls in a single turn");
  });

  it("fails the run when it exceeds the max-turn limit", async () => {
    const conversation = await store.createConversation({ organizationId: ORG, createdByUserId: USER });
    const runtime = buildRuntime(
      [assistantToolCall("widgets_lookup_v1", { id: "w_1" }), assistantText("unreached")],
      { limits: { maxTurns: 1, maxToolCallsPerTurn: 8, timeoutMs: 120_000 } }
    );

    const result = await runtime.runTurn({
      organizationId: ORG,
      userId: USER,
      conversationId: conversation.id,
      text: "Keep digging."
    });

    expect(result.status).toBe("failed");
    expect(result.run.error).toContain("exceeded the 1-turn limit");
  });

  it("fails the run when it exceeds the wall-clock limit", async () => {
    const conversation = await store.createConversation({ organizationId: ORG, createdByUserId: USER });
    const slowRegistry = new CapabilityRegistry().register({
      key: "widgets.lookup.v1",
      description: "Look up a widget by id, slowly.",
      input: z.object({ id: z.string() }),
      sideEffect: "none",
      handler: async (_context, input) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { widget: { id: input.id } };
      }
    });
    const runtime = buildRuntime(
      [assistantToolCall("widgets_lookup_v1", { id: "w_slow" }), assistantText("unreached")],
      { registry: slowRegistry, limits: { maxTurns: 16, maxToolCallsPerTurn: 8, timeoutMs: 50 } }
    );

    const result = await runtime.runTurn({
      organizationId: ORG,
      userId: USER,
      conversationId: conversation.id,
      text: "Take your time."
    });

    expect(result.status).toBe("failed");
    expect(result.run.error).toContain("wall-clock limit");
  });
});
