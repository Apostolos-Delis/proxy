import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { type SessionDetail, type SessionSummary, fetchSessionDetail, fetchSessions } from "./api";
import { compactCounts, compactId, dominantKey, formatCompact, formatDateTime, formatMoney } from "./format";
import { routingDecisionSubtitle } from "./routingSnapshot";
import { CodePill, DataTable, GlassCard, JsonPanel, PageState, PageTitle, RouteBadge, StatusBadge } from "./ui";

type ReplayRow = {
  id: string;
  title: string;
  subtitle: string;
  kind: string;
  createdAt: string;
};

export function SessionsPage() {
  const query = useQuery({ queryKey: ["sessions"], queryFn: fetchSessions });
  const data = query.data?.data ?? [];

  if (query.isLoading) return <PageState title="Sessions" label="Loading session index" />;
  if (query.error) return <PageState title="Sessions" label={query.error.message} />;

  return (
    <div className="page page-enter">
      <PageTitle title="Session replay" subtitle="Reconstruct agent runs from prompts, route decisions, provider attempts, and usage rows." />
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
    queryFn: () => fetchSessionDetail(sessionId)
  });

  if (query.isLoading) return <PageState title="Session" label="Loading session replay" />;
  if (query.error) return <PageState title="Session" label={query.error.message} />;
  if (!query.data) return <PageState title="Session" label="No session data" />;

  const detail = query.data;
  const session = detail.session;
  const rows = replayRows(detail);
  return (
    <div className="page page-enter">
      <PageTitle title="Session replay" subtitle={compactId(session.sessionId, 18)} />
      <div className="detail-grid">
        <GlassCard>
          <div className="card-title">{rows.length} records</div>
          <div className="replay-timeline">
            {rows.map((row) => <ReplayItem key={row.id} row={row} />)}
            {rows.length === 0 ? <div className="empty">No replay rows found for this session.</div> : null}
          </div>
        </GlassCard>
        <JsonPanel title="Session context" value={{
          user: detail.user,
          modelMix: session.modelMix,
          routeMix: session.routeMix,
          terminalStatusSummary: session.terminalStatusSummary,
          requests: detail.requests
        }} />
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
      <td><RouteBadge route={session.currentRoute ?? dominantKey(session.routeMix)} /></td>
      <td>{compactCounts(session.modelMix)}</td>
      <td><StatusBadge status={dominantKey(session.terminalStatusSummary)} /></td>
      <td className="mono">{formatCompact(session.usage.totalTokens)}</td>
      <td className="mono">{formatMoney(session.cost.selected)}</td>
    </tr>
  );
}

function ReplayItem({ row }: { row: ReplayRow }) {
  return (
    <article className="replay-row">
      <div className="replay-kind">{row.kind}</div>
      <div>
        <strong>{row.title}</strong>
        <span>{row.subtitle}</span>
      </div>
      <time>{formatDateTime(row.createdAt)}</time>
    </article>
  );
}

function replayRows(detail: SessionDetail) {
  const rows: ReplayRow[] = [
    ...detail.promptArtifacts
      .filter((artifact) => artifact.kind !== "tool_schema_metadata" && artifact.kind !== "request_input")
      .map((artifact) => ({
        id: `prompt:${artifact.artifactId}`,
        kind: "prompt",
        title: `Prompt ${artifact.kind}`,
        subtitle: artifact.preview ?? "Prompt text was not stored.",
        createdAt: artifact.createdAt
      })),
    ...detail.routeDecisions.map((decision) => ({
      id: `decision:${decision.id}`,
      kind: "route",
      title: `Route ${decision.finalRoute ?? "unknown"}`,
      subtitle: routingDecisionSubtitle(decision),
      createdAt: decision.createdAt
    })),
    ...detail.providerAttempts.map((attempt) => ({
      id: `attempt:${attempt.id}`,
      kind: "provider",
      title: `${attempt.provider} ${attempt.terminalStatus}`,
      subtitle: attempt.model,
      createdAt: attempt.startedAt
    })),
    ...detail.usageLedger.map((usage) => ({
      id: `usage:${usage.id}`,
      kind: "usage",
      title: `${formatCompact(usage.totalTokens)} tokens`,
      subtitle: formatMoney(usage.totalCostMicros / 1_000_000),
      createdAt: usage.createdAt
    })),
    ...detail.events.map((event) => ({
      id: `event:${event.eventId}`,
      kind: "event",
      title: event.eventType,
      subtitle: event.producer,
      createdAt: event.createdAt
    }))
  ];
  return rows.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}
