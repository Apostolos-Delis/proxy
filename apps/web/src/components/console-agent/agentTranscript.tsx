import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CornerDownLeft, Loader2 } from "lucide-react";
import { useState } from "react";

import { AgentLiveRun } from "./agentLiveRun";
import { AgentProposalCard } from "./agentProposalCard";
import { AgentQuestionCard } from "./agentQuestionCard";
import { pageScopeLabel, type PageScope } from "./pageScope";
import {
  consoleAgentKeys,
  fetchAgentConversation,
  messageQuestions,
  messageText,
  runFailureText,
  runInProgress,
  sendAgentMessage,
  transcriptTimeline,
  type ConsoleAgentMessage,
  type ConsoleAgentRunSummary
} from "./consoleAgentData";

export function AgentTranscript({
  conversationId,
  pageScope
}: {
  conversationId: string;
  pageScope?: PageScope;
}) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: consoleAgentKeys.conversation(conversationId),
    queryFn: () => fetchAgentConversation(conversationId),
    refetchInterval: (query) =>
      runInProgress(query.state.data?.lastRun ?? null) ? 4000 : false
  });
  const [draft, setDraft] = useState("");
  const sendMutation = useMutation({
    mutationFn: (text: string) => sendAgentMessage(conversationId, { text, pageScope }),
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: consoleAgentKeys.all });
    }
  });

  const messages = detailQuery.data?.messages ?? [];
  const proposals = detailQuery.data?.proposals ?? [];
  const timeline = transcriptTimeline(messages, proposals);
  const lastRun = detailQuery.data?.lastRun ?? null;
  const working = runInProgress(lastRun) || sendMutation.isPending;
  const failureText = runFailureText(lastRun);
  const canSend = draft.trim().length > 0 && !working;

  const scopeLabel = pageScopeLabel(pageScope);
  const submit = () => {
    if (canSend) sendMutation.mutate(draft.trim());
  };

  return (
    <div className="agent-transcript">
      <div className="agent-messages">
        {detailQuery.isLoading ? <div className="empty">Loading conversation...</div> : null}
        {detailQuery.isError ? (
          <div className="empty">Failed to load the conversation. Close and reopen the dock to retry.</div>
        ) : null}
        {detailQuery.isSuccess && messages.length === 0 ? (
          <div className="empty">Ask about requests, routing configs, usage, or sessions.</div>
        ) : null}
        {timeline.map((entry, index) =>
          entry.kind === "message" ? (
            <AgentMessageRow
              key={entry.message.id}
              message={entry.message}
              anchor={index === timeline.length - 1}
              lastRun={lastRun}
              busy={working}
              onAnswer={(text) => sendMutation.mutate(text)}
            />
          ) : (
            <div
              key={entry.proposal.id}
              ref={index === timeline.length - 1 ? scrollToEnd : undefined}
            >
              <AgentProposalCard proposal={entry.proposal} />
            </div>
          )
        )}
        {lastRun && runInProgress(lastRun) ? (
          <AgentLiveRun
            key={lastRun.id}
            runId={lastRun.id}
            onTerminal={() => {
              void queryClient.invalidateQueries({ queryKey: consoleAgentKeys.all });
            }}
          />
        ) : null}
        {sendMutation.isPending && !runInProgress(lastRun) ? (
          <div className="agent-message assistant pending">
            <Loader2 className="spin" />
            <span>Working...</span>
          </div>
        ) : null}
        {!working && failureText ? <div className="agent-error">{failureText}</div> : null}
      </div>
      {scopeLabel ? <div className="agent-scope-line">Viewing {scopeLabel}</div> : null}
      <div className="agent-composer">
        <textarea
          value={draft}
          rows={2}
          placeholder="Ask the console agent..."
          aria-label="Message the console agent"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button className="btn btn-primary btn-icon" type="button" aria-label="Send" disabled={!canSend} onClick={submit}>
          <CornerDownLeft />
        </button>
      </div>
      {sendMutation.isError ? (
        <div className="agent-error">{sendErrorText(sendMutation.error)}</div>
      ) : null}
    </div>
  );
}

function scrollToEnd(node: HTMLElement | null) {
  node?.scrollIntoView({ block: "end" });
}

function AgentMessageRow({
  message,
  anchor,
  lastRun,
  busy,
  onAnswer
}: {
  message: ConsoleAgentMessage;
  anchor: boolean;
  lastRun: ConsoleAgentRunSummary | null;
  busy: boolean;
  onAnswer: (text: string) => void;
}) {
  const questions = message.role === "assistant" ? messageQuestions(message.content) : null;
  if (questions) {
    const active =
      lastRun?.status === "awaiting_input" && message.runId !== null && message.runId === lastRun.id;
    return (
      <div className="agent-message assistant" ref={anchor ? scrollToEnd : undefined}>
        <AgentQuestionCard questions={questions} active={active} busy={busy} onAnswer={onAnswer} />
      </div>
    );
  }
  return (
    <div className={`agent-message ${message.role}`} ref={anchor ? scrollToEnd : undefined}>
      <div className="agent-message-role">{message.role === "user" ? "You" : "Agent"}</div>
      <div className="agent-message-text">{messageText(message.content)}</div>
    </div>
  );
}

function sendErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to send message.";
  if (message.includes("run_already_active")) return "The agent is still working on the previous message.";
  return message;
}
