import type { PromptProxyTransaction } from "@prompt-proxy/db";

import { appendAdminAuditEvent } from "./adminAudit.js";

export const CONSOLE_AGENT_PRODUCER = "prompt-proxy.console-agent";

export async function appendConsoleAgentAuditEvent(
  tx: PromptProxyTransaction,
  input: {
    organizationId: string;
    conversationId: string;
    runId?: string;
    actorUserId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }
) {
  await appendAdminAuditEvent(tx, {
    organizationId: input.organizationId,
    scopeType: "console_agent_conversation",
    scopeId: input.conversationId,
    correlationId: input.runId,
    actorUserId: input.actorUserId,
    producer: CONSOLE_AGENT_PRODUCER,
    eventType: input.eventType,
    payload: input.payload
  });
}
