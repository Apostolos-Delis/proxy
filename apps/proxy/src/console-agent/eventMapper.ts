import type { AgentEvent } from "@earendil-works/pi-agent-core";

import { isRecord } from "../util.js";

export const CONSOLE_AGENT_EVENT_TYPES = [
  "run_started",
  "text_delta",
  "tool_call_started",
  "tool_call_finished",
  "message_finished",
  "question_asked",
  "proposal_created",
  "run_finished",
  "run_failed"
] as const;

export type ConsoleAgentEventType = typeof CONSOLE_AGENT_EVENT_TYPES[number];

export type ConsoleAgentEvent = {
  type: ConsoleAgentEventType;
  payload: Record<string, unknown>;
};

export function terminalEventFor(status: string, error?: string | null): ConsoleAgentEvent {
  if (status === "failed") {
    return { type: "run_failed", payload: { status, error: error ?? null } };
  }
  return { type: "run_finished", payload: { status } };
}

export function mapPiEvent(event: AgentEvent): ConsoleAgentEvent | null {
  switch (event.type) {
    case "agent_start":
      return { type: "run_started", payload: {} };
    case "message_update": {
      const delta = event.assistantMessageEvent;
      if (delta.type !== "text_delta") return null;
      return { type: "text_delta", payload: { delta: delta.delta } };
    }
    case "message_end": {
      const text = joinedAssistantText(event.message);
      if (text === undefined) return null;
      return { type: "message_finished", payload: { text } };
    }
    case "tool_execution_start":
      return {
        type: "tool_call_started",
        payload: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args ?? {} }
      };
    case "tool_execution_end":
      return {
        type: "tool_call_finished",
        payload: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          result: toolResultDetails(event.result)
        }
      };
    default:
      return null;
  }
}

export function joinedAssistantText(message: unknown) {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  const text = message.content
    .filter((entry): entry is { type: "text"; text: string } =>
      isRecord(entry) && entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("");
  return text.length > 0 ? text : undefined;
}

function toolResultDetails(result: unknown) {
  if (isRecord(result) && "details" in result) return result.details;
  return result ?? null;
}
