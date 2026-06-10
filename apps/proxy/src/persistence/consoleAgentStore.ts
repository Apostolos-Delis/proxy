import { and, desc, eq, gt } from "drizzle-orm";

import {
  consoleAgentConversations,
  consoleAgentMessages,
  consoleAgentRunEvents,
  consoleAgentRuns,
  type PromptProxyDbSession,
  type PromptProxyTransaction,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";
import type { ConsoleAgentRunStatus } from "@prompt-proxy/schema";

import { redactRunEventPayload, redactSessionState } from "../console-agent/redaction.js";
import { createId } from "../util.js";
import { appendConsoleAgentAuditEvent } from "./consoleAgentAudit.js";

export type ConsoleAgentRunFinalStatus = Exclude<ConsoleAgentRunStatus, "running">;

export type ConsoleAgentStoreErrorCode =
  | "run_already_active"
  | "run_not_active"
  | "write_failed"
  | "invalid_event";

export class ConsoleAgentStoreError extends Error {
  constructor(readonly code: ConsoleAgentStoreErrorCode, message: string) {
    super(message);
    this.name = "ConsoleAgentStoreError";
  }
}

export class ConsoleAgentStore {
  constructor(
    private readonly transactional: PromptProxyTransactionalDatabase,
    private readonly db: PromptProxyDbSession
  ) {}

  async createConversation(input: {
    organizationId: string;
    createdByUserId: string;
    title?: string;
  }) {
    return this.transactional.transaction(async (tx) => {
      const [conversation] = await tx
        .insert(consoleAgentConversations)
        .values({
          id: createId("console_agent_conversation"),
          organizationId: input.organizationId,
          createdByUserId: input.createdByUserId,
          title: input.title
        })
        .returning();
      if (!conversation) throw new ConsoleAgentStoreError("write_failed", "Failed to create conversation.");
      await appendConsoleAgentAuditEvent(tx, {
        organizationId: input.organizationId,
        conversationId: conversation.id,
        actorUserId: input.createdByUserId,
        eventType: "console_agent.conversation.created",
        payload: { conversationId: conversation.id }
      });
      return conversation;
    });
  }

  async getConversation(organizationId: string, conversationId: string) {
    const [conversation] = await this.db
      .select()
      .from(consoleAgentConversations)
      .where(and(
        eq(consoleAgentConversations.organizationId, organizationId),
        eq(consoleAgentConversations.id, conversationId)
      ))
      .limit(1);
    return conversation ?? null;
  }

  async listConversations(organizationId: string, createdByUserId: string) {
    return this.db
      .select()
      .from(consoleAgentConversations)
      .where(and(
        eq(consoleAgentConversations.organizationId, organizationId),
        eq(consoleAgentConversations.createdByUserId, createdByUserId)
      ))
      .orderBy(desc(consoleAgentConversations.updatedAt));
  }

  async listMessages(organizationId: string, conversationId: string) {
    return this.db
      .select()
      .from(consoleAgentMessages)
      .where(and(
        eq(consoleAgentMessages.organizationId, organizationId),
        eq(consoleAgentMessages.conversationId, conversationId)
      ))
      .orderBy(consoleAgentMessages.createdAt);
  }

  async appendUserMessage(input: {
    organizationId: string;
    conversationId: string;
    content: Record<string, unknown>;
    pageScope?: Record<string, unknown>;
  }) {
    return this.transactional.transaction(async (tx) => {
      const [message] = await tx
        .insert(consoleAgentMessages)
        .values({
          id: createId("console_agent_message"),
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          role: "user",
          content: input.content,
          pageScope: input.pageScope
        })
        .returning();
      if (!message) throw new ConsoleAgentStoreError("write_failed", "Failed to append user message.");
      await touchConversation(tx, input.organizationId, input.conversationId);
      return message;
    });
  }

  async startRun(input: {
    organizationId: string;
    conversationId: string;
    actorUserId: string;
    model?: string;
  }) {
    return this.transactional.transaction(async (tx) => {
      const active = await tx
        .select({ id: consoleAgentRuns.id })
        .from(consoleAgentRuns)
        .where(and(
          eq(consoleAgentRuns.organizationId, input.organizationId),
          eq(consoleAgentRuns.conversationId, input.conversationId),
          eq(consoleAgentRuns.status, "running")
        ))
        .limit(1);
      if (active.length > 0) {
        throw new ConsoleAgentStoreError(
          "run_already_active",
          `Conversation ${input.conversationId} already has a running run.`
        );
      }
      const [run] = await insertRunGuarded(tx, input);
      if (!run) throw new ConsoleAgentStoreError("write_failed", "Failed to start run.");
      await appendConsoleAgentAuditEvent(tx, {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        runId: run.id,
        actorUserId: input.actorUserId,
        eventType: "console_agent.run.started",
        payload: { runId: run.id, conversationId: input.conversationId }
      });
      return run;
    });
  }

  async appendRunEvent(input: {
    organizationId: string;
    runId: string;
    seq: number;
    type: string;
    payload: Record<string, unknown>;
  }) {
    if (input.type === "text_delta") {
      throw new ConsoleAgentStoreError("invalid_event", "text_delta events are SSE-only and must not be persisted.");
    }
    const [event] = await this.db
      .insert(consoleAgentRunEvents)
      .values({
        id: createId("console_agent_run_event"),
        organizationId: input.organizationId,
        runId: input.runId,
        seq: input.seq,
        type: input.type,
        payload: redactRunEventPayload(input.payload)
      })
      .returning();
    if (!event) throw new ConsoleAgentStoreError("write_failed", "Failed to append run event.");
    return event;
  }

  async listRunEvents(organizationId: string, runId: string, afterSeq?: number) {
    const conditions = [
      eq(consoleAgentRunEvents.organizationId, organizationId),
      eq(consoleAgentRunEvents.runId, runId)
    ];
    if (afterSeq !== undefined) conditions.push(gt(consoleAgentRunEvents.seq, afterSeq));
    return this.db
      .select()
      .from(consoleAgentRunEvents)
      .where(and(...conditions))
      .orderBy(consoleAgentRunEvents.seq);
  }

  async auditCapabilityExecuted(
    context: { organizationId: string; userId: string; conversationId: string; runId: string },
    capabilityKey: string
  ) {
    await this.transactional.transaction(async (tx) => {
      await appendConsoleAgentAuditEvent(tx, {
        organizationId: context.organizationId,
        conversationId: context.conversationId,
        runId: context.runId,
        actorUserId: context.userId,
        eventType: "console_agent.capability.executed",
        payload: {
          capabilityKey,
          conversationId: context.conversationId,
          runId: context.runId
        }
      });
    });
  }

  async getLatestRun(organizationId: string, conversationId: string) {
    const [run] = await this.db
      .select()
      .from(consoleAgentRuns)
      .where(and(
        eq(consoleAgentRuns.organizationId, organizationId),
        eq(consoleAgentRuns.conversationId, conversationId)
      ))
      .orderBy(desc(consoleAgentRuns.startedAt))
      .limit(1);
    return run ?? null;
  }

  async getRun(organizationId: string, runId: string) {
    const [run] = await this.db
      .select()
      .from(consoleAgentRuns)
      .where(and(
        eq(consoleAgentRuns.organizationId, organizationId),
        eq(consoleAgentRuns.id, runId)
      ))
      .limit(1);
    return run ?? null;
  }

  async finalizeRun(input: {
    organizationId: string;
    runId: string;
    actorUserId: string;
    status: ConsoleAgentRunFinalStatus;
    usage?: Record<string, unknown>;
    error?: string;
    assistantMessages?: Array<Record<string, unknown>>;
    sessionState?: unknown[];
    terminalEvent?: { seq: number; type: string; payload: Record<string, unknown> };
  }) {
    return this.transactional.transaction(async (tx) => {
      const [run] = await tx
        .update(consoleAgentRuns)
        .set({
          status: input.status,
          usage: input.usage ?? {},
          error: input.error,
          finishedAt: new Date()
        })
        .where(and(
          eq(consoleAgentRuns.organizationId, input.organizationId),
          eq(consoleAgentRuns.id, input.runId),
          eq(consoleAgentRuns.status, "running")
        ))
        .returning();
      if (!run) {
        throw new ConsoleAgentStoreError("run_not_active", `Run ${input.runId} not found or already finalized.`);
      }

      const assistantRows = (input.assistantMessages ?? []).map((content) => ({
        id: createId("console_agent_message"),
        organizationId: input.organizationId,
        conversationId: run.conversationId,
        role: "assistant" as const,
        content,
        runId: input.runId
      }));
      if (assistantRows.length > 0) {
        await tx.insert(consoleAgentMessages).values(assistantRows);
      }

      const conversationUpdate: Partial<typeof consoleAgentConversations.$inferInsert> = {
        updatedAt: new Date()
      };
      if (input.sessionState) {
        conversationUpdate.sessionState = redactSessionState(input.sessionState);
      }
      await tx
        .update(consoleAgentConversations)
        .set(conversationUpdate)
        .where(and(
          eq(consoleAgentConversations.organizationId, input.organizationId),
          eq(consoleAgentConversations.id, run.conversationId)
        ));

      if (input.terminalEvent) {
        await tx.insert(consoleAgentRunEvents).values({
          id: createId("console_agent_run_event"),
          organizationId: input.organizationId,
          runId: input.runId,
          seq: input.terminalEvent.seq,
          type: input.terminalEvent.type,
          payload: redactRunEventPayload(input.terminalEvent.payload)
        });
      }

      await appendConsoleAgentAuditEvent(tx, {
        organizationId: input.organizationId,
        conversationId: run.conversationId,
        runId: input.runId,
        actorUserId: input.actorUserId,
        eventType: "console_agent.run.finished",
        payload: {
          runId: input.runId,
          conversationId: run.conversationId,
          status: input.status
        }
      });
      return run;
    });
  }
}

async function insertRunGuarded(
  tx: PromptProxyTransaction,
  input: { organizationId: string; conversationId: string; model?: string }
) {
  try {
    return await tx
      .insert(consoleAgentRuns)
      .values({
        id: createId("console_agent_run"),
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        model: input.model
      })
      .returning();
  } catch (error) {
    if (isActiveRunUniqueViolation(error)) {
      throw new ConsoleAgentStoreError(
        "run_already_active",
        `Conversation ${input.conversationId} already has a running run.`
      );
    }
    throw error;
  }
}

export function isActiveRunUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (String(code) === "23505" || error.message.includes("console_agent_runs_active_idx")) {
    return true;
  }
  return isActiveRunUniqueViolation(error.cause);
}

async function touchConversation(
  tx: PromptProxyTransaction,
  organizationId: string,
  conversationId: string
) {
  await tx
    .update(consoleAgentConversations)
    .set({ updatedAt: new Date() })
    .where(and(
      eq(consoleAgentConversations.organizationId, organizationId),
      eq(consoleAgentConversations.id, conversationId)
    ));
}
