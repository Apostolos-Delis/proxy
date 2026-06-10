import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";

import { compactCounts, compactId, dominantKey, formatCompact, formatDateTime, formatMoney } from "./format";
import { graphql } from "./gql";
import type { SessionDetailViewQuery, SessionsListQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { CodePill, DataTable, GlassCard, PageState, PageTitle, RouteBadge, StatusBadge } from "./ui";

const SessionsListDocument = graphql(`
  query SessionsList {
    sessions {
      sessionId
      externalSessionId
      userId
      surface
      currentRoute
      modelMix
      routeMix
      terminalStatusSummary
      usage {
        totalTokens
      }
      cost {
        selected
      }
    }
  }
`);

const SessionDetailViewDocument = graphql(`
  query SessionDetailView($sessionId: ID!) {
    session(sessionId: $sessionId) {
      session {
        sessionId
        externalSessionId
        userId
        surface
        sessionIdentity
        requestCount
        startedAt
        recentActivity
        modelMix
        routeMix
        usage {
          totalTokens
        }
        cost {
          selected
        }
      }
      user
      requests {
        requestId
        createdAt
        selectedModel
        finalRoute
        terminalStatus
        selectedCost
        usage {
          totalTokens
        }
      }
      promptArtifacts {
        artifactId
        requestId
        kind
        rawText
        redactedText
        preview
      }
    }
  }
`);

type SessionSummary = SessionsListQuery["sessions"][number];
type SessionDetail = NonNullable<SessionDetailViewQuery["session"]>;
type SessionRequest = SessionDetail["requests"][number];
type SessionArtifact = SessionDetail["promptArtifacts"][number];

type ConversationTurn = {
  request: SessionRequest;
  userArtifact?: SessionArtifact;
  assistantArtifact?: SessionArtifact;
};

function countRecord(value: unknown): Record<string, number> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, number>
    : {};
}

export function SessionsPage() {
  const query = useQuery({ queryKey: ["sessions"], queryFn: () => gqlFetch(SessionsListDocument) });
  const data = query.data?.sessions ?? [];

  if (query.isLoading) return <PageState title="Sessions" label="Loading session index" />;
  if (query.error) return <PageState title="Sessions" label={query.error.message} />;

  return (
    <div className="page page-enter">
      <PageTitle title="Sessions" subtitle="Agent conversations threaded across requests, routes, and spend." />
      <GlassCard className="table-wrap">
        <DataTable>
          <thead><tr><th>Session</th><th>User</th><th>Surface</th><th>Route</th><th>Models</th><th>Status</th><th>Tokens</th><th>Cost</th></tr></thead>
          <tbody>{data.map((session) => <SessionRow key={session.sessionId} session={session} />)}</tbody>
        </DataTable>
        {data.length === 0 ? <div className="empty">No sessions observed yet.</div> : null}
      </GlassCard>
    </div>
  );
}

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const query = useQuery({
    queryKey: ["session", sessionId],
    queryFn: async () => (await gqlFetch(SessionDetailViewDocument, { sessionId })).session
  });

  if (query.isLoading) return <PageState title="Session" label="Loading conversation" />;
  if (query.error) return <PageState title="Session" label={query.error.message} />;
  if (!query.data) return <PageState title="Session" label="No session data" />;

  const detail = query.data;
  const session = detail.session;
  const turns = conversationTurns(detail);
  return (
    <div className="page page-enter">
      <PageTitle
        title="Session"
        subtitle={`${session.surface} · ${compactId(session.externalSessionId ?? session.sessionId, 28)}`}
      />
      <div className="session-layout">
        <GlassCard className="conversation-card">
          <div className="card-head">
            <div className="card-title"><MessagesSquare />Conversation</div>
            <span className="faint mono">{turns.length} {turns.length === 1 ? "turn" : "turns"}</span>
          </div>
          <div className="conversation">
            {turns.map((turn) => <ConversationTurnView key={turn.request.requestId} turn={turn} />)}
            {turns.length === 0 ? <div className="empty">No requests recorded for this session.</div> : null}
          </div>
        </GlassCard>
        <SessionRail session={session} userName={sessionUserName(detail)} />
      </div>
    </div>
  );
}

function SessionRow({ session }: { session: SessionSummary }) {
  return (
    <tr>
      <td>
        <Link to="/sessions/$sessionId" params={{ sessionId: session.sessionId }} className="table-link">
          {compactId(session.externalSessionId ?? session.sessionId)}
        </Link>
      </td>
      <td><CodePill value={session.userId ?? "unknown"} /></td>
      <td>{session.surface}</td>
      <td><RouteBadge route={session.currentRoute ?? dominantKey(countRecord(session.routeMix))} /></td>
      <td>{compactCounts(countRecord(session.modelMix))}</td>
      <td><StatusBadge status={dominantKey(countRecord(session.terminalStatusSummary))} /></td>
      <td className="mono">{formatCompact(session.usage.totalTokens)}</td>
      <td className="mono">{formatMoney(session.cost.selected)}</td>
    </tr>
  );
}

function ConversationTurnView({ turn }: { turn: ConversationTurn }) {
  const { request, userArtifact, assistantArtifact } = turn;
  const logArtifactId = userArtifact?.artifactId ?? assistantArtifact?.artifactId;
  return (
    <article className="convo-turn">
      <header className="convo-meta">
        {request.createdAt ? <time>{formatDateTime(request.createdAt)}</time> : null}
        <span className="row gap-8"><span className="model-dot" /><span className="mono">{request.selectedModel ?? "unknown"}</span></span>
        <RouteBadge route={request.finalRoute} />
        <StatusBadge status={request.terminalStatus} />
        <span className="mono">{formatCompact(request.usage.totalTokens)} tok</span>
        <span className="mono">{formatMoney(request.selectedCost)}</span>
        {logArtifactId ? (
          <Link to="/logs/$artifactId" params={{ artifactId: logArtifactId }} className="convo-log-link">
            Open log
          </Link>
        ) : null}
      </header>
      <ConversationBubble role="user" artifact={userArtifact} missingLabel="Prompt not captured" />
      <ConversationBubble role="assistant" artifact={assistantArtifact} missingLabel="Response not captured" />
    </article>
  );
}

function ConversationBubble({ role, artifact, missingLabel }: {
  role: "user" | "assistant";
  artifact?: SessionArtifact;
  missingLabel: string;
}) {
  const text = artifact ? artifact.rawText ?? artifact.redactedText ?? artifact.preview : null;
  return (
    <div className={`convo-bubble convo-${role}`}>
      <span className="convo-role">{role}</span>
      {text ? <p>{text}</p> : <p className="convo-missing">{missingLabel}</p>}
    </div>
  );
}

function SessionRail({ session, userName }: { session: SessionDetail["session"]; userName: string }) {
  return (
    <GlassCard className="session-rail">
      <div className="card-title">Session context</div>
      <div className="fact-grid">
        <SessionFact label="User"><span>{userName}</span></SessionFact>
        <SessionFact label="Surface"><span className="mono">{session.surface}</span></SessionFact>
        <SessionFact label="Identity"><span className="mono">{session.sessionIdentity ?? "unknown"}</span></SessionFact>
        <SessionFact label="Started"><span>{formatDateTime(session.startedAt)}</span></SessionFact>
        <SessionFact label="Last activity"><span>{session.recentActivity ? formatDateTime(session.recentActivity) : "unknown"}</span></SessionFact>
        <SessionFact label="Requests"><span className="mono">{formatCompact(session.requestCount)}</span></SessionFact>
        <SessionFact label="Tokens"><span className="mono">{formatCompact(session.usage.totalTokens)}</span></SessionFact>
        <SessionFact label="Cost"><span className="mono">{formatMoney(session.cost.selected)}</span></SessionFact>
        <SessionFact label="Models"><span>{compactCounts(countRecord(session.modelMix))}</span></SessionFact>
        <SessionFact label="Routes"><span>{compactCounts(countRecord(session.routeMix))}</span></SessionFact>
      </div>
    </GlassCard>
  );
}

function SessionFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function conversationTurns(detail: SessionDetail): ConversationTurn[] {
  const artifactsByRequest = new Map<string, SessionArtifact[]>();
  for (const artifact of detail.promptArtifacts) {
    const list = artifactsByRequest.get(artifact.requestId) ?? [];
    list.push(artifact);
    artifactsByRequest.set(artifact.requestId, list);
  }
  return [...detail.requests]
    .sort((left, right) => requestTime(left) - requestTime(right))
    .map((request) => {
      const artifacts = artifactsByRequest.get(request.requestId) ?? [];
      return {
        request,
        userArtifact: artifacts.find((artifact) => artifact.kind === "latest_user_message"),
        assistantArtifact: artifacts.find((artifact) => artifact.kind === "assistant_response")
      };
    });
}

function requestTime(request: SessionRequest) {
  return request.createdAt ? new Date(request.createdAt).getTime() : 0;
}

function sessionUser(value: unknown): { name?: string; email?: string } | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as { name?: string; email?: string }
    : null;
}

function sessionUserName(detail: SessionDetail) {
  const user = sessionUser(detail.user);
  return user?.name ?? user?.email ?? detail.session.userId ?? "unknown";
}
