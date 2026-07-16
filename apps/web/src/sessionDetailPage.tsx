import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, Copy } from "lucide-react";

import { MiniBars } from "./charts";
import { compactId, formatCompact, formatDateTime, formatDurationMs, formatMoney } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { CopyButton, useCopyFeedback } from "./jsonView";
import {
  artifactText,
  conversationTurns,
  type ConversationTurn,
  dominantRequestLogicalModel,
  dominantRequestStatus,
  sessionUserName,
  sessionWallMs,
  systemSpans,
  transcriptText
} from "./sessionsPageData";
import { SessionTimeline } from "./sessionTimeline";
import { Avatar, GlassCard, PageState, RouteBadge, StatusIndicator } from "./ui";

const MAX_SESSION_MINIBARS = 180;

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
        requestedLogicalModel
        resolvedLogicalModelId
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
        chars
        createdAt
        preview
        tokenEstimate
        metadata
      }
    }
  }
`);

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const { isLoading: queryIsLoading, error: queryError, data: queryData } = useQuery({
    queryKey: ["session", sessionId],
    queryFn: async () => (await gqlFetch(SessionDetailViewDocument, { sessionId })).session
  });

  if (queryIsLoading) return <PageState title="Session" label="Loading session trace" />;
  if (queryError) return <PageState title="Session" label={queryError.message} />;
  if (!queryData) return <PageState title="Session" label="No session data" />;

  const detail = queryData;
  const session = detail.session;
  const turns = conversationTurns(detail);
  const spans = systemSpans(turns);
  const durationMs = sessionWallMs(turns);
  const hasCapturedText = turns.some((turn) => turn.artifacts.some((artifact) => artifactText(artifact)));
  const tokenBars = sessionTokenBars(turns.map((turn) => turn.request.usage.totalTokens));
  return (
    <div className="page page-enter session-detail">
      <div className="session-crumbs">
        <Link to="/logs" className="btn btn-sm"><ChevronLeft />Logs</Link>
        <span className="crumb-sep" aria-hidden>/</span>
        <span className="code-pill id-pill">
          {compactId(session.externalSessionId ?? session.sessionId, 12)}
          <CopyButton text={session.externalSessionId ?? session.sessionId} />
        </span>
        {hasCapturedText ? <span className="session-crumbs-actions"><SessionTranscriptCopyButton turns={turns} /></span> : null}
      </div>
      <header className="session-head">
        <div className="row gap-12">
          <h2 className="session-title">{session.surface}</h2>
          <StatusIndicator status={dominantRequestStatus(detail.requests)} />
          <RouteBadge route={dominantRequestLogicalModel(detail.requests)} />
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
            <MiniBars data={tokenBars} height={34} valueFormatter={formatCompact} />
          </div>
        ) : null}
      </GlassCard>
      <SessionTimeline key={session.sessionId} turns={turns} spans={spans} />
    </div>
  );
}

function SessionTranscriptCopyButton({ turns }: { turns: ConversationTurn[] }) {
  const { copied, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      className={`copy-button${copied ? " copied" : ""}`}
      aria-label="Copy preview transcript"
      onClick={() => copy(transcriptText(turns))}
    >
      {copied ? <Check /> : <Copy />}
      <span>{copied ? "Copied" : "Copy preview transcript"}</span>
    </button>
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

function sessionTokenBars(values: number[]) {
  if (values.length <= MAX_SESSION_MINIBARS) return values;
  const bucketSize = Math.ceil(values.length / MAX_SESSION_MINIBARS);
  const buckets: number[] = [];
  for (let index = 0; index < values.length; index += bucketSize) {
    buckets.push(Math.max(...values.slice(index, index + bucketSize)));
  }
  return buckets;
}
