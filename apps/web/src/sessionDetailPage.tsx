import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, FileText, Layers, Shield, Sparkles, User, Wrench } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { ArtifactRole } from "./artifactKinds";
import { MiniBars } from "./charts";
import { compactId, formatCompact, formatDateTime, formatDurationMs, formatMoney, formatTimeOfDay } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { CopyButton } from "./jsonView";
import {
  artifactRole,
  artifactText,
  artifactToolNames,
  conversationTurns,
  dominantRequestRoute,
  dominantRequestStatus,
  sessionUserName,
  sessionWallMs,
  systemSpans,
  transcriptText,
  type ConversationTurn,
  type SessionArtifact
} from "./sessionsPageData";
import { Avatar, GlassCard, PageState, RouteBadge, StatusBadge } from "./ui";

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
        usage {
          inputTokens
          outputTokens
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
          inputTokens
          cachedInputTokens
          outputTokens
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
        tokenEstimate
        metadata
      }
    }
  }
`);

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const query = useQuery({
    queryKey: ["session", sessionId],
    queryFn: async () => (await gqlFetch(SessionDetailViewDocument, { sessionId })).session
  });

  if (query.isLoading) return <PageState title="Session" label="Loading session trace" />;
  if (query.error) return <PageState title="Session" label={query.error.message} />;
  if (!query.data) return <PageState title="Session" label="No session data" />;

  const detail = query.data;
  const session = detail.session;
  const turns = conversationTurns(detail);
  const spans = systemSpans(turns);
  const durationMs = sessionWallMs(turns);
  const hasCapturedText = turns.some((turn) => turn.artifacts.some((artifact) => artifactText(artifact)));
  const transcript = hasCapturedText ? transcriptText(turns) : null;
  return (
    <div className="page page-enter session-detail">
      <div className="session-crumbs">
        <Link to="/sessions" className="btn btn-sm"><ChevronLeft />Sessions</Link>
        <span className="crumb-sep" aria-hidden>/</span>
        <span className="code-pill id-pill">
          {compactId(session.externalSessionId ?? session.sessionId, 12)}
          <CopyButton text={session.externalSessionId ?? session.sessionId} />
        </span>
        {transcript ? <span className="session-crumbs-actions"><CopyButton text={transcript} label="Copy transcript" /></span> : null}
      </div>
      <header className="session-head">
        <div className="row gap-12">
          <h2 className="session-title">{session.surface}</h2>
          <StatusBadge status={dominantRequestStatus(detail.requests)} />
          <RouteBadge route={dominantRequestRoute(detail.requests)} />
        </div>
        <div className="session-byline">
          <Avatar label={sessionUserName(detail)} size={20} />
          <span className="nowrap">{sessionUserName(detail)}</span>
          <span className="faint nowrap">· started {formatDateTime(session.startedAt)}</span>
          {session.sessionIdentity === "request_fallback" ? <span className="faint nowrap">· grouped from requests</span> : null}
        </div>
      </header>
      <GlassCard className="session-stats">
        <SessionStat label="Requests" value={formatCompact(session.requestCount)} />
        <SessionStat label="Input tokens" value={formatCompact(session.usage.inputTokens)} />
        <SessionStat label="Output tokens" value={formatCompact(session.usage.outputTokens)} />
        <SessionStat label="Cost" value={formatMoney(session.cost.selected)} accent />
        <SessionStat label="Duration" value={durationMs != null ? formatDurationMs(durationMs) : "—"} />
        {turns.length >= 2 ? (
          <div className="session-minibars" title="Tokens per request">
            <MiniBars data={turns.map((turn) => turn.request.usage.totalTokens)} height={34} valueFormatter={formatCompact} />
          </div>
        ) : null}
      </GlassCard>
      {turns.map((turn) => <RequestBlock key={turn.request.requestId} turn={turn} spans={spans} />)}
      {turns.length === 0 ? <GlassCard><div className="empty">No requests recorded for this session.</div></GlassCard> : null}
    </div>
  );
}

function RequestBlock({ turn, spans }: { turn: ConversationTurn; spans: Map<string, number> }) {
  const { request, index, gapMs, artifacts, priorMessages, priorTokens } = turn;
  const logArtifactId = artifacts[0]?.artifactId;
  return (
    <section className="req-block">
      <div className="req-head">
        <span className="req-n">Request {String(index + 1).padStart(2, "0")}</span>
        <span className="req-meta">
          <span className="row gap-8"><span className="model-dot" />{request.selectedModel ?? "unknown"}</span>
          <span>{formatCompact(request.usage.inputTokens)} in → {formatCompact(request.usage.outputTokens)} out</span>
          <span>{formatMoney(request.selectedCost)}</span>
          {request.latencyMs != null ? <span>{formatDurationMs(request.latencyMs)}</span> : null}
          {request.createdAt ? <time dateTime={request.createdAt}>{formatTimeOfDay(request.createdAt)}</time> : null}
          {gapMs != null && gapMs >= 1000 ? <span>+{formatDurationMs(gapMs)} idle</span> : null}
        </span>
        <span className="req-side">
          {logArtifactId ? (
            <Link to="/logs/$artifactId" params={{ artifactId: logArtifactId }} className="req-log-link">Open log</Link>
          ) : null}
          <RouteBadge route={request.finalRoute} />
          <StatusBadge status={request.terminalStatus} />
        </span>
      </div>
      <div className="tl">
        {priorMessages > 0 ? (
          <ContextStackItem count={priorMessages} tokens={priorTokens} cachedTokens={request.usage.cachedInputTokens} />
        ) : null}
        {artifacts.map((artifact, position) => (
          <MessageItem
            key={artifact.artifactId}
            artifact={artifact}
            identicalAcross={spans.get(artifact.artifactId)}
            last={position === artifacts.length - 1}
          />
        ))}
        {artifacts.length === 0 ? (
          <TimelineItem tone="context" icon={<Layers />} last>
            <div className="msg"><div className="msg-body msg-missing">No new content captured for this request.</div></div>
          </TimelineItem>
        ) : null}
      </div>
    </section>
  );
}

function TimelineItem({ tone, icon, dashed = false, last = false, children }: {
  tone: ArtifactRole;
  icon: ReactNode;
  dashed?: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`tl-item${last ? " last" : ""}`}>
      <div className="tl-rail"><span className={`tl-node${dashed ? " tl-node-ctx" : ""} msg-tone-${tone}`}>{icon}</span></div>
      {children}
    </div>
  );
}

function ContextStackItem({ count, tokens, cachedTokens }: { count: number; tokens: number; cachedTokens: number }) {
  return (
    <TimelineItem tone="context" icon={<Layers />} dashed>
      <div className="ctx-stack">
        <span>
          {formatCompact(count)} earlier {count === 1 ? "message" : "messages"}
          {tokens > 0 ? ` · ~${formatCompact(tokens)} tok` : ""} replayed from previous requests
        </span>
        {cachedTokens > 0 ? <span className="ctx-cached">{formatCompact(cachedTokens)} tok read from cache</span> : null}
      </div>
    </TimelineItem>
  );
}

const KIND_ICONS: Record<string, ReactNode> = {
  tool_use: <Wrench />,
  tool_result: <FileText />
};

const ROLE_ICONS: Record<ArtifactRole, ReactNode> = {
  system: <Shield />,
  user: <User />,
  assistant: <Sparkles />,
  tool: <Wrench />,
  context: <Layers />
};

// Paired with .msg-body.clamp's 132px max-height: anything that overflows it
// gets collapsed behind the expander.
const CLAMP_CHARS = 280;
const CLAMP_LINES = 5;

function MessageItem({ artifact, identicalAcross, last }: {
  artifact: SessionArtifact;
  identicalAcross?: number;
  last: boolean;
}) {
  const { role, label } = artifactRole(artifact);
  const text = artifactText(artifact);
  const lines = text ? text.split("\n").length : 0;
  const isLong = text != null && (text.length > CLAMP_CHARS || lines > CLAMP_LINES);
  const [open, setOpen] = useState(false);
  const tools = artifactToolNames(artifact);
  const isCode = role === "tool" || role === "system" || role === "context";
  const tokens = artifact.tokenEstimate ?? 0;
  return (
    <TimelineItem tone={role} icon={KIND_ICONS[artifact.kind] ?? ROLE_ICONS[role]} last={last}>
      <div className="msg">
        <div className="msg-head">
          <span className={`role msg-tone-${role}`}>{label}</span>
          {tools.slice(0, 3).map((tool) => <span key={tool} className="code-pill msg-tool-pill">{tool}()</span>)}
          {tools.length > 3 ? <span className="msg-head-extra">+{tools.length - 3} more</span> : null}
          {identicalAcross != null && identicalAcross > 1 ? (
            <span className="badge badge-accent msg-cached">identical across {identicalAcross} requests</span>
          ) : null}
          <span className="msg-head-meta">
            {tokens > 0 ? `~${formatCompact(tokens)} tok` : null}
            {tokens > 0 && isLong ? " · " : null}
            {isLong ? `${formatCompact(lines)} lines` : null}
          </span>
          {text ? <CopyButton text={text} /> : null}
        </div>
        {text
          ? <div className={`msg-body${isCode ? " code" : ""}${isLong && !open ? " clamp" : ""}`}>{text}</div>
          : <div className="msg-body msg-missing">Content not stored.</div>}
        {isLong ? (
          <button type="button" className="expander" onClick={() => setOpen((value) => !value)}>
            {open ? <ChevronDown /> : <ChevronRight />}
            {open
              ? "Collapse"
              : `Expand full ${label.toLowerCase()} · ${formatCompact(lines)} lines${tokens > 0 ? ` · ~${formatCompact(tokens)} tokens` : ""}`}
          </button>
        ) : null}
      </div>
    </TimelineItem>
  );
}

function SessionStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="sess-stat">
      <div className="k">{label}</div>
      <div className={`v${accent ? " accent" : ""}`}>{value}</div>
    </div>
  );
}
