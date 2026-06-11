import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, CircleX, Loader2, ShieldX } from "lucide-react";
import { useState } from "react";

import { useRunStream, type LiveToolCall } from "../../lib/agentStream";
import { cancelAgentRun } from "./consoleAgentData";

export function AgentLiveRun({ runId, onTerminal }: { runId: string; onTerminal: () => void }) {
  const stream = useRunStream(runId, onTerminal);
  const cancelMutation = useMutation({ mutationFn: () => cancelAgentRun(runId) });

  return (
    <div className="agent-live-run">
      {stream.toolCalls.map((toolCall) => (
        <ToolChip key={toolCall.toolCallId} toolCall={toolCall} />
      ))}
      {[...stream.completedTexts, stream.currentText]
        .filter((text) => text.length > 0)
        .map((text, index) => (
          <div className="agent-message assistant" key={`text_${index}`}>
            <div className="agent-message-role">Agent</div>
            <div className="agent-message-text">{text}</div>
          </div>
        ))}
      {cancelFeedback(cancelMutation.isError, cancelMutation.data?.cancelled) ? (
        <div className="agent-error">{cancelFeedback(cancelMutation.isError, cancelMutation.data?.cancelled)}</div>
      ) : null}
      {stream.terminal ? null : (
        <div className="agent-message assistant pending">
          <Loader2 className="spin" />
          <span>Working...</span>
          <button
            className="btn btn-ghost agent-cancel"
            type="button"
            disabled={cancelMutation.isPending}
            onClick={() => cancelMutation.mutate()}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function ToolChip({ toolCall }: { toolCall: LiveToolCall }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`agent-tool ${chipTone(toolCall)}`}>
      <button
        type="button"
        className="agent-tool-chip"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown /> : <ChevronRight />}
        <span className="agent-tool-name">{toolCall.capabilityKey ?? toolCall.toolName}</span>
        {toolCall.durationMs !== null ? (
          <span className="agent-tool-duration">{formatDuration(toolCall.durationMs)}</span>
        ) : null}
        <ToolChipStatus toolCall={toolCall} />
      </button>
      {expanded ? (
        <div className="agent-tool-detail">
          <ToolDetailSection title="Arguments" value={toolCall.args} />
          <ToolDetailSection title="Result" value={toolCall.result} />
        </div>
      ) : null}
    </div>
  );
}

function ToolDetailSection({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="agent-tool-section">
      <div className="agent-message-role">{title}</div>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

function ToolChipStatus({ toolCall }: { toolCall: LiveToolCall }) {
  if (toolCall.status === "running") return <Loader2 className="spin" />;
  if (toolCall.decision === "denied") return <ShieldX />;
  if (toolCall.isError) return <CircleX />;
  return <Check />;
}

function chipTone(toolCall: LiveToolCall) {
  if (toolCall.decision === "denied") return "denied";
  if (toolCall.isError) return "error";
  return "";
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function cancelFeedback(isError: boolean, cancelled: boolean | undefined) {
  if (isError) return "Cancel request failed.";
  if (cancelled === false) return "Couldn't cancel - the run may already be finishing.";
  return null;
}
