import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  consoleAgentConversations,
  consoleAgentRuns,
  createTransactionalDatabase,
  events,
  organizations,
  users
} from "@prompt-proxy/db";

import {
  ConsoleAgentStore,
  ConsoleAgentStoreError,
  isActiveRunUniqueViolation
} from "../src/persistence/consoleAgentStore.js";
import { migratedPgliteDb } from "./consoleAgentTestKit.js";

const ORG = "org_agent_store";
const USER = "user_store";

describe("console agent store", () => {
  let fixture: Awaited<ReturnType<typeof migratedPgliteDb>>;
  let store: ConsoleAgentStore;

  beforeAll(async () => {
    fixture = await migratedPgliteDb();
    await fixture.db.insert(organizations).values({ id: ORG, slug: "org-agent-store", name: ORG });
    await fixture.db.insert(users).values({ id: USER });
    store = new ConsoleAgentStore(createTransactionalDatabase(fixture.db), fixture.db);
  });

  afterAll(async () => {
    await fixture.client.close();
  });

  it("creates a conversation with its audit event in one transaction", async () => {
    const conversation = await store.createConversation({
      organizationId: ORG,
      createdByUserId: USER,
      title: "Routing question"
    });

    expect(conversation.organizationId).toBe(ORG);
    const auditRows = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "console_agent.conversation.created"));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.scopeId).toBe(conversation.id);
  });

  it("runs the full lifecycle: message, run, events, finalize with session state", async () => {
    const conversation = await store.createConversation({
      organizationId: ORG,
      createdByUserId: USER
    });
    await store.appendUserMessage({
      organizationId: ORG,
      conversationId: conversation.id,
      content: { text: "Why did request X route hard?" },
      pageScope: { requestId: "req_x" }
    });

    const run = await store.startRun({
      organizationId: ORG,
      conversationId: conversation.id,
      actorUserId: USER,
      model: "stub-model"
    });
    expect(run.status).toBe("running");

    await expect(
      store.startRun({ organizationId: ORG, conversationId: conversation.id, actorUserId: USER })
    ).rejects.toThrow(ConsoleAgentStoreError);

    await store.appendRunEvent({
      organizationId: ORG,
      runId: run.id,
      seq: 1,
      type: "run_started",
      payload: {}
    });
    await store.appendRunEvent({
      organizationId: ORG,
      runId: run.id,
      seq: 2,
      type: "tool_call_finished",
      payload: { toolName: "requests_search_v1", result: { decision: "executed", output: { count: 1 } } }
    });
    await expect(
      store.appendRunEvent({
        organizationId: ORG,
        runId: run.id,
        seq: 2,
        type: "message_finished",
        payload: {}
      })
    ).rejects.toThrow();
    await expect(
      store.appendRunEvent({
        organizationId: ORG,
        runId: run.id,
        seq: 3,
        type: "text_delta",
        payload: { delta: "hi" }
      })
    ).rejects.toThrow(/SSE-only/);

    const finalized = await store.finalizeRun({
      organizationId: ORG,
      runId: run.id,
      actorUserId: USER,
      status: "finished",
      usage: { totalTokens: 42 },
      assistantMessages: [{ text: "It routed hard because of the classifier." }],
      sessionState: [
        { role: "user", content: "Why did request X route hard?", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "..." }], timestamp: 2 }
      ]
    });
    expect(finalized.status).toBe("finished");
    expect(finalized.finishedAt).toBeTruthy();

    await expect(
      store.finalizeRun({
        organizationId: ORG,
        runId: run.id,
        actorUserId: USER,
        status: "cancelled"
      })
    ).rejects.toThrow(/already finalized/);

    const messages = await store.listMessages(ORG, conversation.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.runId).toBe(run.id);

    const [storedConversation] = await fixture.db
      .select()
      .from(consoleAgentConversations)
      .where(eq(consoleAgentConversations.id, conversation.id));
    const sessionState = storedConversation?.sessionState as { messages: unknown[] };
    expect(sessionState.messages).toHaveLength(2);

    const runEvents = await store.listRunEvents(ORG, run.id);
    expect(runEvents.map((event) => event.seq)).toEqual([1, 2]);
    expect(JSON.stringify(runEvents[1]?.payload)).toContain('"count":1');
    const replay = await store.listRunEvents(ORG, run.id, 1);
    expect(replay.map((event) => event.seq)).toEqual([2]);

    const finishAudit = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "console_agent.run.finished"));
    expect(finishAudit).toHaveLength(1);
    expect(finishAudit[0]?.correlationId).toBe(run.id);
  });

  it("finalizes failed runs with errors and allows a new run afterwards", async () => {
    const conversation = await store.createConversation({
      organizationId: ORG,
      createdByUserId: USER
    });
    const run = await store.startRun({
      organizationId: ORG,
      conversationId: conversation.id,
      actorUserId: USER
    });

    const failed = await store.finalizeRun({
      organizationId: ORG,
      runId: run.id,
      actorUserId: USER,
      status: "failed",
      error: "model timeout"
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("model timeout");

    const next = await store.startRun({
      organizationId: ORG,
      conversationId: conversation.id,
      actorUserId: USER
    });
    expect(next.status).toBe("running");
    const fetched = await store.getRun(ORG, next.id);
    expect(fetched?.id).toBe(next.id);
    await store.finalizeRun({
      organizationId: ORG,
      runId: next.id,
      actorUserId: USER,
      status: "awaiting_input"
    });
  });

  it("redacts prompt tool results into references in session state and run events", async () => {
    const conversation = await store.createConversation({
      organizationId: ORG,
      createdByUserId: USER
    });
    const run = await store.startRun({
      organizationId: ORG,
      conversationId: conversation.id,
      actorUserId: USER
    });

    await store.appendRunEvent({
      organizationId: ORG,
      runId: run.id,
      seq: 1,
      type: "tool_call_finished",
      payload: {
        toolName: "prompts_get_v1",
        result: {
          decision: "executed",
          output: { found: true, artifactId: "artifact_1", kind: "latest_user_message", rawText: "the secret prompt" }
        }
      }
    });
    await store.appendRunEvent({
      organizationId: ORG,
      runId: run.id,
      seq: 2,
      type: "message_finished",
      payload: {
        snapshot: {
          toolResults: [
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "prompts_get_v1",
              content: [{ type: "text", text: "the secret prompt" }],
              details: { decision: "executed", output: { artifactId: "artifact_1", rawText: "the secret prompt" } },
              isError: false,
              timestamp: 2
            }
          ]
        }
      }
    });

    await store.finalizeRun({
      organizationId: ORG,
      runId: run.id,
      actorUserId: USER,
      status: "finished",
      sessionState: [
        { role: "user", content: "read prompt artifact_1", timestamp: 1 },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "prompts_get_v1",
          content: [{ type: "text", text: "the secret prompt" }],
          details: {
            decision: "executed",
            output: { found: true, artifactId: "artifact_1", rawText: "the secret prompt" }
          },
          isError: false,
          timestamp: 2
        },
        { role: "assistant", content: [{ type: "text", text: "Summarized." }], timestamp: 3 }
      ]
    });

    const [storedConversation] = await fixture.db
      .select()
      .from(consoleAgentConversations)
      .where(eq(consoleAgentConversations.id, conversation.id));
    const sessionStateJson = JSON.stringify(storedConversation?.sessionState);
    expect(sessionStateJson).not.toContain("the secret prompt");
    expect(sessionStateJson).toContain("artifact_1");
    expect(sessionStateJson).toContain('"redacted":true');

    const runEvents = await store.listRunEvents(ORG, run.id);
    const eventJson = JSON.stringify(runEvents);
    expect(eventJson).not.toContain("the secret prompt");
    expect(eventJson).toContain('"redacted":true');
  });

  it("enforces the single-running-run index and translates the wrapped violation", async () => {
    const conversation = await store.createConversation({
      organizationId: ORG,
      createdByUserId: USER
    });
    await store.startRun({ organizationId: ORG, conversationId: conversation.id, actorUserId: USER });

    let raceError: unknown;
    try {
      await fixture.db.insert(consoleAgentRuns).values({
        id: "run_race",
        organizationId: ORG,
        conversationId: conversation.id
      });
    } catch (error) {
      raceError = error;
    }
    expect(raceError).toBeTruthy();
    expect(isActiveRunUniqueViolation(raceError)).toBe(true);
    expect(isActiveRunUniqueViolation(new Error("unrelated"))).toBe(false);
  });

  it("redacts prompt tool results nested beside a matched toolName key", async () => {
    const conversation = await store.createConversation({
      organizationId: ORG,
      createdByUserId: USER
    });
    const run = await store.startRun({
      organizationId: ORG,
      conversationId: conversation.id,
      actorUserId: USER
    });

    await store.appendRunEvent({
      organizationId: ORG,
      runId: run.id,
      seq: 1,
      type: "tool_call_finished",
      payload: {
        toolName: "prompts_get_v1",
        result: { decision: "executed", output: { artifactId: "artifact_2", rawText: "sibling secret" } },
        snapshot: {
          toolResults: [
            {
              role: "toolResult",
              toolCallId: "call_2",
              toolName: "prompts_get_v1",
              content: [{ type: "text", text: "sibling secret" }],
              details: { decision: "executed", output: { artifactId: "artifact_2", rawText: "sibling secret" } },
              isError: false,
              timestamp: 1
            }
          ]
        }
      }
    });

    const runEvents = await store.listRunEvents(ORG, run.id);
    const eventJson = JSON.stringify(runEvents);
    expect(eventJson).not.toContain("sibling secret");
    expect(eventJson).toContain("artifact_2");
  });

  it("scopes conversations to their creator", async () => {
    await fixture.db.insert(users).values({ id: "user_other" });
    const mine = await store.createConversation({ organizationId: ORG, createdByUserId: "user_other" });

    const mineList = await store.listConversations(ORG, "user_other");
    expect(mineList.map((conversation) => conversation.id)).toEqual([mine.id]);

    const othersList = await store.listConversations(ORG, USER);
    expect(othersList.map((conversation) => conversation.id)).not.toContain(mine.id);
  });
});
