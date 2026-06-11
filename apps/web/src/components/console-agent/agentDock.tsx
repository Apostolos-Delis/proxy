import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatches } from "@tanstack/react-router";
import { ChevronLeft, Plus, X } from "lucide-react";
import { useState } from "react";

import { AgentTranscript } from "./agentTranscript";
import { pageScopeFromMatch } from "./pageScope";
import {
  consoleAgentKeys,
  createAgentConversation,
  fetchAgentConversations,
  type ConsoleAgentConversation
} from "./consoleAgentData";

export function AgentDock({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const matches = useMatches();
  const leafMatch = matches.at(-1);
  const pageScope = leafMatch ? pageScopeFromMatch(leafMatch.routeId, leafMatch.params) : undefined;
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const conversationsQuery = useQuery({
    queryKey: consoleAgentKeys.conversations,
    queryFn: fetchAgentConversations
  });
  const createMutation = useMutation({
    mutationFn: () => createAgentConversation(),
    onSuccess: (created) => {
      setActiveConversationId(created.conversation.id);
      void queryClient.invalidateQueries({ queryKey: consoleAgentKeys.conversations });
    }
  });

  const conversations = conversationsQuery.data?.data ?? [];
  const active = conversations.find((conversation) => conversation.id === activeConversationId);

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer agent-dock"
        role="dialog"
        aria-modal="true"
        aria-label="Console agent"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="agent-dock-head">
          {activeConversationId ? (
            <button
              className="btn btn-ghost btn-icon"
              type="button"
              aria-label="Back to conversations"
              onClick={() => setActiveConversationId(null)}
            >
              <ChevronLeft />
            </button>
          ) : null}
          <div className="agent-dock-title">
            <strong>Console agent</strong>
            <span>{active?.title ?? titleForList(activeConversationId)}</span>
          </div>
          <div className="topbar-spacer" />
          <button
            className="btn btn-ghost btn-icon"
            type="button"
            aria-label="New conversation"
            disabled={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            <Plus />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            type="button"
            aria-label="Close console agent"
            autoFocus
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        {createMutation.isError ? (
          <div className="agent-error">Failed to start a conversation. Try again.</div>
        ) : null}
        {activeConversationId ? (
          <AgentTranscript
            key={activeConversationId}
            conversationId={activeConversationId}
            pageScope={pageScope}
          />
        ) : (
          <ConversationList
            conversations={conversations}
            loading={conversationsQuery.isLoading}
            error={conversationsQuery.isError}
            onSelect={setActiveConversationId}
            onCreate={() => createMutation.mutate()}
          />
        )}
      </aside>
    </>
  );
}

function ConversationList({
  conversations,
  loading,
  error,
  onSelect,
  onCreate
}: {
  conversations: ConsoleAgentConversation[];
  loading: boolean;
  error: boolean;
  onSelect: (conversationId: string) => void;
  onCreate: () => void;
}) {
  if (loading) return <div className="empty">Loading conversations...</div>;
  if (error) return <div className="empty">Failed to load conversations.</div>;
  if (conversations.length === 0) {
    return (
      <div className="empty">
        <p>No conversations yet.</p>
        <button className="btn btn-primary" type="button" onClick={onCreate}>
          Start a conversation
        </button>
      </div>
    );
  }
  return (
    <nav className="agent-conversation-list" aria-label="Agent conversations">
      {conversations.map((conversation) => (
        <button
          key={conversation.id}
          type="button"
          className="agent-conversation-item"
          onClick={() => onSelect(conversation.id)}
        >
          <span className="agent-conversation-title">{conversation.title ?? "Untitled conversation"}</span>
          <span className="faint">{new Date(conversation.updatedAt).toLocaleString()}</span>
        </button>
      ))}
    </nav>
  );
}

function titleForList(activeConversationId: string | null) {
  return activeConversationId ? "Conversation" : "Operations copilot";
}
