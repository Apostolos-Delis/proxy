import { describe, expect, it } from "vitest";

import { applyStreamEvent, emptyRunStream, parsePayload, type RunStreamState } from "./agentStream";

function play(events: Array<[string, Record<string, unknown>]>): RunStreamState {
  return events.reduce(
    (state, [type, payload]) => applyStreamEvent(state, type, payload, 1_000),
    emptyRunStream
  );
}

describe("agent stream reducer", () => {
  it("keeps every assistant message across multi-round turns", () => {
    const state = play([
      ["text_delta", { delta: "Let me " }],
      ["text_delta", { delta: "check." }],
      ["message_finished", { text: "Let me check." }],
      ["text_delta", { delta: "Found it" }],
      ["message_finished", { text: "Found it." }]
    ]);
    expect(state.completedTexts).toEqual(["Let me check.", "Found it."]);
    expect(state.currentText).toBe("");
  });

  it("ignores text deltas without a delta string", () => {
    expect(play([["text_delta", {}]]).currentText).toBe("");
  });

  it("tracks tool call lifecycle with decisions, errors, and durations", () => {
    const started = applyStreamEvent(
      emptyRunStream,
      "tool_call_started",
      { toolCallId: "c1", toolName: "requests_search_v1", capabilityKey: "requests.search.v1", args: { limit: 5 } },
      1_000
    );
    const finished = applyStreamEvent(
      started,
      "tool_call_finished",
      { toolCallId: "c1", toolName: "requests_search_v1", isError: false, result: { decision: "executed", output: {} } },
      2_500
    );
    expect(finished.toolCalls[0]).toMatchObject({
      capabilityKey: "requests.search.v1",
      status: "done",
      decision: "executed",
      durationMs: 1500,
      args: { limit: 5 }
    });

    const denied = play([
      ["tool_call_started", { toolCallId: "c2", toolName: "widgets_x_v1" }],
      ["tool_call_finished", { toolCallId: "c2", toolName: "widgets_x_v1", isError: false, result: { decision: "denied", reason: "Unknown capability" } }]
    ]);
    expect(denied.toolCalls[0]?.decision).toBe("denied");
  });

  it("is idempotent for re-delivered tool_call_started events", () => {
    const state = play([
      ["tool_call_started", { toolCallId: "c1", toolName: "t" }],
      ["tool_call_started", { toolCallId: "c1", toolName: "t" }]
    ]);
    expect(state.toolCalls).toHaveLength(1);
  });

  it("ignores tool_call_finished for unknown tool calls", () => {
    const state = play([["tool_call_finished", { toolCallId: "ghost", result: {} }]]);
    expect(state.toolCalls).toEqual([]);
  });

  it("marks in-flight tool calls done and records terminal state on run end", () => {
    const state = play([
      ["tool_call_started", { toolCallId: "c1", toolName: "t" }],
      ["run_failed", { status: "failed", error: "boom" }]
    ]);
    expect(state.toolCalls[0]?.status).toBe("done");
    expect(state.terminal).toEqual({ type: "run_failed", status: "failed", error: "boom" });
  });
});

describe("parsePayload", () => {
  it("parses object payloads and rejects everything else", () => {
    expect(parsePayload('{"a":1}')).toEqual({ a: 1 });
    expect(parsePayload("[1,2]")).toEqual({});
    expect(parsePayload("not json")).toEqual({});
    expect(parsePayload(undefined)).toEqual({});
  });
});
