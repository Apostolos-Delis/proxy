import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { askUserQuestionTool } from "../src/console-agent/questions.js";
import { assistantText, assistantToolCall, scriptedStream } from "./consoleAgentTestKit.js";
import {
  adminGet,
  adminPost,
  captureFixture,
  waitFor,
  type PromptTestFixture
} from "./promptTestFixture.js";

const ORG = "org_agent_questions";

describe("ask_user_question tool validation", () => {
  it("terminates the turn and reports questions on valid input", async () => {
    let asked: unknown;
    const tool = askUserQuestionTool((questions) => {
      asked = questions;
    });
    const result = await tool.execute("call_1", { questions: QUESTIONS });
    expect(result.terminate).toBe(true);
    expect(asked).toEqual(QUESTIONS);
  });

  it("rejects invalid input without terminating so the model can retry", async () => {
    let asked: unknown;
    const tool = askUserQuestionTool((questions) => {
      asked = questions;
    });
    for (const invalid of [
      { questions: [] },
      { questions: [{ question: "Pick one", options: ["only"] }] },
      { questions: [{ question: "Pick one", options: ["dup", "dup"] }] },
      { questions: [{ question: "", options: ["a", "b"] }] }
    ]) {
      const result = await tool.execute("call_1", invalid);
      expect(result.terminate).toBe(false);
      expect(result.content[0]?.text).toContain("Invalid ask_user_question input");
    }
    expect(asked).toBeUndefined();
  });
});

const QUESTIONS = [
  { question: "Which route tier should move to the new model?", options: ["hard", "deep"] }
];

// The agent asks a structured question, the run parks awaiting_input, and the
// user's answer resumes the conversation with the question still in context.
describe("console agent ask_user_question", () => {
  let fixture: PromptTestFixture;

  beforeAll(async () => {
    fixture = await captureFixture(ORG, "raw_text", false, {
      consoleAgentStreamFn: scriptedStream([
        assistantToolCall("ask_user_question", { questions: QUESTIONS }),
        assistantText("Moving the hard tier as requested.")
      ])
    });
  }, 60_000);

  afterAll(async () => {
    await fixture.close();
  });

  it("parks the run awaiting input and resumes with the answer", async () => {
    const created = await adminPost(fixture, "/admin/console-agent/conversations", {});
    const { conversation } = await created.json();

    const message = await adminPost(
      fixture,
      `/admin/console-agent/conversations/${conversation.id}/messages`,
      { text: "Upgrade one of the route tiers." }
    );
    expect(message.status).toBe(202);

    await waitFor(async () => {
      const detail = await adminGet(fixture, `/admin/console-agent/conversations/${conversation.id}`);
      return detail.lastRun?.status === "awaiting_input";
    });

    const parked = await adminGet(fixture, `/admin/console-agent/conversations/${conversation.id}`);
    const questionMessage = parked.messages.at(-1);
    expect(questionMessage.role).toBe("assistant");
    expect(questionMessage.content.questions).toEqual(QUESTIONS);

    const answer = await adminPost(
      fixture,
      `/admin/console-agent/conversations/${conversation.id}/messages`,
      { text: "hard" }
    );
    expect(answer.status).toBe(202);

    await waitFor(async () => {
      const detail = await adminGet(fixture, `/admin/console-agent/conversations/${conversation.id}`);
      return detail.lastRun?.status === "finished";
    });

    const resumed = await adminGet(fixture, `/admin/console-agent/conversations/${conversation.id}`);
    const texts = resumed.messages.map(
      (entry: { role: string; content: Record<string, unknown> }) => entry.content.text ?? entry.content.questions
    );
    expect(texts).toEqual([
      "Upgrade one of the route tiers.",
      QUESTIONS,
      "hard",
      "Moving the hard tier as requested."
    ]);
  });
});
