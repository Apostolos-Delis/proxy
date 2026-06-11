import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";

import { compactId, formatCompact, formatDateTime, formatDateTimeSeconds, formatDurationMs, formatMoney, formatTimeOfDay } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { CopyButton } from "./jsonView";
import {
  artifactRole,
  artifactText,
  conversationSpan,
  conversationTurns,
  countRecord,
  sessionUserName,
  sortedCounts,
  transcriptText,
  type ConversationTurn,
  type SessionArtifact,
  type SessionDetail
} from "./sessionsPageData";
import { GlassCard, PageState, PageTitle, RouteBadge, StatusBadge } from "./ui";

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
        latencyMs
        selectedCost
        usage {
          totalTokens
        }
      }
      promptArtifacts {
        artifactId
        requestId
        kind
        sourceIndex
        contentHash
        createdAt
        rawText
        redactedText
        preview
      }
    }
  }
`);

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
  const spanMs = conversationSpan(turns);
  const hasCapturedText = turns.some((turn) => turn.artifacts.some((artifact) => artifactText(artifact)));
  const transcript = hasCapturedText ? transcriptText(turns) : null;
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
            <div className="row gap-8">
              <span className="faint mono">
                {turns.length} {turns.length === 1 ? "turn" : "turns"}
                {spanMs != null && spanMs >= 1000 ? ` · ${formatDurationMs(spanMs)}` : ""}
              </span>
              {transcript ? <CopyButton text={transcript} label="Copy transcript" /> : null}
            </div>
          </div>
          {turns.length > 0 ? (
            <div className="conversation convo-timeline">
              {turns.map((turn) => <ConversationTurnView key={turn.request.requestId} turn={turn} />)}
            </div>
          ) : (
            <div className="empty">No requests recorded for this session.</div>
          )}
        </GlassCard>
        <SessionRail session={session} userName={sessionUserName(detail)} />
      </div>
    </div>
  );
}

function ConversationTurnView({ turn }: { turn: ConversationTurn }) {
  const { request, index, gapMs, artifacts } = turn;
  const logArtifactId = artifacts[0]?.artifactId;
  return (
    <article className="convo-turn">
      <span className="turn-node" aria-hidden>{index + 1}</span>
      <header className="convo-meta">
        {request.createdAt ? <time dateTime={request.createdAt}>{formatDateTimeSeconds(request.createdAt)}</time> : null}
        {gapMs != null && gapMs >= 1000 ? <span className="convo-gap">+{formatDurationMs(gapMs)}</span> : null}
        <span className="row gap-8"><span className="model-dot" /><span className="mono">{request.selectedModel ?? "unknown"}</span></span>
        <RouteBadge route={request.finalRoute} />
        <StatusBadge status={request.terminalStatus} />
        <span className="convo-stats">
          <span>{formatCompact(request.usage.totalTokens)} tok</span>
          <span>{formatMoney(request.selectedCost)}</span>
          {request.latencyMs != null ? <span>{formatDurationMs(request.latencyMs)}</span> : null}
        </span>
        {logArtifactId ? (
          <Link to="/logs/$artifactId" params={{ artifactId: logArtifactId }} className="convo-log-link">
            Open log
          </Link>
        ) : null}
      </header>
      {artifacts.map((artifact) => <ConversationBubble key={artifact.artifactId} artifact={artifact} />)}
      {artifacts.length === 0 ? (
        <div className="convo-bubble">
          <p className="convo-missing">No new content captured for this request.</p>
        </div>
      ) : null}
    </article>
  );
}

function ConversationBubble({ artifact }: { artifact: SessionArtifact }) {
  const { role, label } = artifactRole(artifact);
  const text = artifactText(artifact);
  return (
    <div className={`convo-bubble convo-${role}`}>
      <div className="convo-bubble-head">
        <span className="convo-role">{label}</span>
        <span className="convo-bubble-actions">
          {artifact.createdAt ? <time dateTime={artifact.createdAt} className="convo-bubble-meta mono">{formatTimeOfDay(artifact.createdAt)}</time> : null}
          {text ? <CopyButton text={text} /> : null}
        </span>
      </div>
      {text ? <p>{text}</p> : <p className="convo-missing">Content not stored.</p>}
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
      </div>
      <div className="rail-stats">
        <SessionFact label="Requests"><span className="mono">{formatCompact(session.requestCount)}</span></SessionFact>
        <SessionFact label="Tokens"><span className="mono">{formatCompact(session.usage.totalTokens)}</span></SessionFact>
        <SessionFact label="Cost"><span className="mono">{formatMoney(session.cost.selected)}</span></SessionFact>
      </div>
      <MixList label="Models" kind="model" counts={countRecord(session.modelMix)} />
      <MixList label="Routes" kind="route" counts={countRecord(session.routeMix)} />
    </GlassCard>
  );
}

function MixList({ label, kind, counts }: { label: string; kind: "model" | "route"; counts: Record<string, number> }) {
  const entries = sortedCounts(counts);
  if (entries.length === 0) return null;
  return (
    <div className="mix-section">
      <span className="mix-label">{label}</span>
      {entries.map(([key, count]) => (
        <div key={key} className="mix-row">
          {kind === "model"
            ? <span className="row gap-8"><span className="model-dot" /><span className="mono">{key}</span></span>
            : <RouteBadge route={key} />}
          <span className="mono faint">×{formatCompact(count)}</span>
        </div>
      ))}
    </div>
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
