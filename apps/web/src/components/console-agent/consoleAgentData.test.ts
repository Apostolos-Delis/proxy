import { describe, expect, it } from "vitest";

import {
  messageQuestions,
  messageText,
  proposalDisplayStatus,
  runFailureText,
  runInProgress,
  transcriptTimeline,
  type ConsoleAgentMessage,
  type ConsoleAgentProposal
} from "./consoleAgentData";

describe("console agent data helpers", () => {
  it("extracts message text and falls back to JSON for unknown shapes", () => {
    expect(messageText({ text: "hello" })).toBe("hello");
    expect(messageText({ blocks: [1] })).toBe('{"blocks":[1]}');
  });

  it("treats only running runs as in progress", () => {
    expect(runInProgress(null)).toBe(false);
    expect(runInProgress({ id: "r", status: "running", error: null })).toBe(true);
    expect(runInProgress({ id: "r", status: "failed", error: "x" })).toBe(false);
    expect(runInProgress({ id: "r", status: "awaiting_input", error: null })).toBe(false);
  });

  it("describes failed and cancelled runs", () => {
    expect(runFailureText(null)).toBeNull();
    expect(runFailureText({ id: "r", status: "finished", error: null })).toBeNull();
    expect(runFailureText({ id: "r", status: "failed", error: "model timeout" })).toBe("model timeout");
    expect(runFailureText({ id: "r", status: "failed", error: null })).toBe("The agent run failed.");
    expect(runFailureText({ id: "r", status: "cancelled", error: null })).toBe("The run was cancelled.");
  });

  it("extracts only well-formed question entries from message content", () => {
    const valid = { question: "Which tier?", options: ["hard", "deep"] };
    expect(messageQuestions({ questions: [valid] })).toEqual([valid]);
    expect(messageQuestions({ text: "plain" })).toBeNull();
    expect(messageQuestions({ questions: [] })).toBeNull();
    expect(messageQuestions({ questions: "not-an-array" })).toBeNull();
    expect(
      messageQuestions({
        questions: [valid, null, { question: 7, options: ["a"] }, { question: "ok", options: [1] }]
      })
    ).toEqual([valid]);
  });

  it("derives expired display status only for pending proposals past expiry", () => {
    const now = Date.parse("2026-06-10T12:00:00.000Z");
    const base = proposalStub({ expiresAt: "2026-06-10T11:59:59.000Z" });
    expect(proposalDisplayStatus(base, now)).toBe("expired");
    expect(proposalDisplayStatus({ ...base, expiresAt: "2026-06-10T12:00:01.000Z" }, now)).toBe("pending");
    expect(proposalDisplayStatus({ ...base, status: "approved" }, now)).toBe("approved");
    expect(proposalDisplayStatus({ ...base, status: "stale" }, now)).toBe("stale");
  });

  it("merges messages and proposals into one chronological timeline", () => {
    const messages = [
      messageStub("m1", "2026-06-10T10:00:00.000Z"),
      messageStub("m2", "2026-06-10T10:02:00.000Z")
    ];
    const proposals = [proposalStub({ id: "p1", createdAt: "2026-06-10T10:01:00.000Z" })];
    expect(transcriptTimeline(messages, proposals).map((entry) => entry.kind)).toEqual([
      "message",
      "proposal",
      "message"
    ]);
    expect(transcriptTimeline([], [])).toEqual([]);
  });
});

function messageStub(id: string, createdAt: string): ConsoleAgentMessage {
  return { id, role: "user", content: { text: id }, pageScope: null, runId: null, createdAt };
}

function proposalStub(overrides: Partial<ConsoleAgentProposal>): ConsoleAgentProposal {
  return {
    id: "p",
    conversationId: "c",
    runId: "r",
    capabilityKey: "routing_configs.create.v1",
    preview: {},
    status: "pending",
    proposedByUserId: null,
    resolvedByUserId: null,
    resolvedAt: null,
    expiresAt: "2026-06-10T12:00:00.000Z",
    createdAt: "2026-06-10T10:00:00.000Z",
    ...overrides
  };
}
