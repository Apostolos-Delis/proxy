import { useEffect, useRef, useState } from "react";

import { apiBase } from "../graphql";

export type LiveToolCall = {
  toolCallId: string;
  toolName: string;
  capabilityKey: string | null;
  args: Record<string, unknown> | null;
  result: unknown;
  status: "running" | "done";
  decision: "executed" | "denied" | null;
  isError: boolean;
  startedAtMs: number;
  durationMs: number | null;
};

export type RunStreamState = {
  completedTexts: string[];
  currentText: string;
  toolCalls: LiveToolCall[];
  terminal: { type: "run_finished" | "run_failed"; status: string; error: string | null } | null;
};

export const emptyRunStream: RunStreamState = {
  completedTexts: [],
  currentText: "",
  toolCalls: [],
  terminal: null
};

export function applyStreamEvent(
  state: RunStreamState,
  type: string,
  payload: Record<string, unknown>,
  nowMs = Date.now()
): RunStreamState {
  if (type === "text_delta") {
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    return { ...state, currentText: state.currentText + delta };
  }
  if (type === "message_finished") {
    const text = typeof payload.text === "string" ? payload.text : state.currentText;
    return { ...state, completedTexts: [...state.completedTexts, text], currentText: "" };
  }
  if (type === "tool_call_started") {
    if (state.toolCalls.some((toolCall) => toolCall.toolCallId === payload.toolCallId)) {
      return state;
    }
    return {
      ...state,
      toolCalls: [
        ...state.toolCalls,
        {
          toolCallId: String(payload.toolCallId ?? ""),
          toolName: String(payload.toolName ?? "tool"),
          capabilityKey: typeof payload.capabilityKey === "string" ? payload.capabilityKey : null,
          args: recordOrNull(payload.args),
          result: null,
          status: "running",
          decision: null,
          isError: false,
          startedAtMs: nowMs,
          durationMs: null
        }
      ]
    };
  }
  if (type === "tool_call_finished") {
    return {
      ...state,
      toolCalls: state.toolCalls.map((toolCall) =>
        toolCall.toolCallId === payload.toolCallId
          ? {
              ...toolCall,
              status: "done",
              isError: payload.isError === true,
              decision: decisionOf(payload.result),
              result: payload.result ?? null,
              durationMs: toolCall.durationMs ?? nowMs - toolCall.startedAtMs
            }
          : toolCall
      )
    };
  }
  if (type === "run_finished" || type === "run_failed") {
    return {
      ...state,
      toolCalls: state.toolCalls.map((toolCall) =>
        toolCall.status === "running"
          ? { ...toolCall, status: "done", durationMs: nowMs - toolCall.startedAtMs }
          : toolCall
      ),
      terminal: {
        type,
        status: typeof payload.status === "string" ? payload.status : "finished",
        error: typeof payload.error === "string" ? payload.error : null
      }
    };
  }
  return state;
}

function decisionOf(result: unknown): "executed" | "denied" | null {
  const record = recordOrNull(result);
  if (record?.decision === "executed") return "executed";
  if (record?.decision === "denied") return "denied";
  return null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parsePayload(data: unknown): Record<string, unknown> {
  if (typeof data !== "string") return {};
  try {
    const parsed = JSON.parse(data) as unknown;
    return recordOrNull(parsed) ?? {};
  } catch {
    return {};
  }
}

// Deliberate subset of the proxy's CONSOLE_AGENT_EVENT_TYPES (eventMapper.ts):
// only events the live-run view renders. Questions and proposals reach the UI
// through the conversation detail refetch after the run parks, not via SSE.
// Keep the names in sync when the SSE vocabulary changes.
const STREAMED_EVENT_TYPES = [
  "text_delta",
  "message_finished",
  "tool_call_started",
  "tool_call_finished",
  "run_finished",
  "run_failed"
] as const;

const RECONNECT_DELAY_MS = 2000;

// EventSource lifecycle is external synchronization that cannot be expressed
// as derived render state, so this named hook owns the one allowed effect
// (per docs/frontend-guidelines.md). Network drops use the browser's native
// Last-Event-ID replay; fatal connection failures (which the EventSource spec
// never retries) are resubscribed manually with the last persisted seq.
export function useRunStream(runId: string | null, onTerminal?: () => void): RunStreamState {
  const [state, setState] = useState<RunStreamState>(emptyRunStream);
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  useEffect(() => {
    if (!runId) return;
    setState(emptyRunStream);
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let lastEventId: string | null = null;
    let done = false;

    const connect = () => {
      const query = lastEventId ? `?lastEventId=${encodeURIComponent(lastEventId)}` : "";
      source = new EventSource(
        `${apiBase}/admin/console-agent/runs/${encodeURIComponent(runId)}/events${query}`,
        { withCredentials: true }
      );
      for (const type of STREAMED_EVENT_TYPES) {
        source.addEventListener(type, (event) => {
          const message = event as MessageEvent;
          if (message.lastEventId) lastEventId = message.lastEventId;
          setState((current) => applyStreamEvent(current, type, parsePayload(message.data)));
          if (type === "run_finished" || type === "run_failed") {
            done = true;
            source?.close();
            onTerminalRef.current?.();
          }
        });
      }
      source.addEventListener("error", () => {
        if (done || source?.readyState !== EventSource.CLOSED) return;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });
    };
    connect();

    return () => {
      done = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [runId]);

  return state;
}
