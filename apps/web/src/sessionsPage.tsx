import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Activity, Coins, Database, GitBranch } from "lucide-react";

import { type SessionDetail, type SessionSummary, fetchSessionDetail, fetchSessions } from "./api";
import { Header, Metric, PageState, formatMoney } from "./ui";

export function SessionsPage() {
  const query = useQuery({ queryKey: ["sessions"], queryFn: fetchSessions });
  const data = query.data?.data ?? [];

  if (query.isLoading) return <PageState title="Sessions" label="Loading sessions" />;
  if (query.error) return <PageState title="Sessions" label={query.error.message} />;

  return (
    <section>
      <Header eyebrow={`${data.length} rows`} title="Sessions" />
      <div className="table-panel">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>User</th>
              <th>Surface</th>
              <th>Route</th>
              <th>Models</th>
              <th>Status</th>
              <th>Tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.map((session) => (
              <SessionRow key={session.sessionId} session={session} />
            ))}
          </tbody>
        </table>
        {data.length === 0 ? <div className="empty">No sessions observed yet.</div> : null}
      </div>
    </section>
  );
}

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const query = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => fetchSessionDetail(sessionId)
  });

  if (query.isLoading) return <PageState title="Session" label="Loading session" />;
  if (query.error) return <PageState title="Session" label={query.error.message} />;
  if (!query.data) return <PageState title="Session" label="No session data" />;

  const detail = query.data;
  const session = detail.session;
  const timelineRows = replayRows(detail);
  return (
    <section>
      <Header eyebrow={session.sessionId} title="Session Replay" />
      <div className="metrics compact">
        <Metric icon={<Activity size={20} />} label="Requests" value={session.requestCount.toLocaleString()} />
        <Metric icon={<GitBranch size={20} />} label="Route changes" value={session.routeChanges.toLocaleString()} />
        <Metric icon={<Database size={20} />} label="Tokens" value={session.usage.totalTokens.toLocaleString()} />
        <Metric icon={<Coins size={20} />} label="Cost" value={formatMoney(session.cost.selected)} />
      </div>
      <div className="detail-grid">
        <div className="panel replay-panel">
          <h2>Timeline</h2>
          <div className="replay-timeline">
            {timelineRows.map((row) => (
              <article key={row.id} className="replay-row">
                <div>
                  <strong>{row.title}</strong>
                  <span>{row.subtitle}</span>
                </div>
                <time>{new Date(row.createdAt).toLocaleString()}</time>
              </article>
            ))}
            {timelineRows.length === 0 ? <div className="empty">No replay rows found for this session.</div> : null}
          </div>
        </div>
        <div className="panel json-panel">
          <h2>Session Context</h2>
          <pre>{JSON.stringify({
            user: detail.user,
            modelMix: session.modelMix,
            routeMix: session.routeMix,
            terminalStatusSummary: session.terminalStatusSummary,
            requests: detail.requests
          }, null, 2)}</pre>
        </div>
      </div>
    </section>
  );
}

function SessionRow({ session }: { session: SessionSummary }) {
  return (
    <tr>
      <td>
        <Link to="/sessions/$sessionId" params={{ sessionId: session.sessionId }} className="table-link">
          {session.externalSessionId ?? session.sessionId}
        </Link>
      </td>
      <td>{session.userId ?? "unknown"}</td>
      <td>{session.surface}</td>
      <td>{session.currentRoute ?? dominantKey(session.routeMix)}</td>
      <td>{compactCounts(session.modelMix)}</td>
      <td>{compactCounts(session.terminalStatusSummary)}</td>
      <td>{session.usage.totalTokens.toLocaleString()}</td>
      <td>{formatMoney(session.cost.selected)}</td>
    </tr>
  );
}

function replayRows(detail: SessionDetail) {
  return [
    ...detail.events.map((event) => ({
      id: `event:${event.eventId}`,
      title: event.eventType,
      subtitle: event.producer,
      createdAt: event.createdAt
    })),
    ...detail.promptArtifacts.map((artifact) => ({
      id: `prompt:${artifact.artifactId}`,
      title: `Prompt ${artifact.kind}`,
      subtitle: artifact.rawText ?? artifact.preview ?? artifact.contentHash,
      createdAt: artifact.createdAt
    })),
    ...detail.routeDecisions.map((decision) => ({
      id: `decision:${decision.id}`,
      title: `Route ${decision.finalRoute ?? "unknown"}`,
      subtitle: decision.selectedModel ?? decision.requestedModel,
      createdAt: decision.createdAt
    })),
    ...detail.providerAttempts.map((attempt) => ({
      id: `attempt:${attempt.id}`,
      title: `Provider ${attempt.terminalStatus}`,
      subtitle: `${attempt.provider} ${attempt.model}`,
      createdAt: attempt.startedAt
    })),
    ...detail.usageLedger.map((usage) => ({
      id: `usage:${usage.id}`,
      title: "Usage recorded",
      subtitle: `${usage.totalTokens.toLocaleString()} tokens, ${formatMoney(usage.totalCostMicros / 1_000_000)}`,
      createdAt: usage.createdAt
    }))
  ].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function compactCounts(counts: Record<string, number>) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function dominantKey(counts: Record<string, number>) {
  return Object.entries(counts).sort((left, right) => right[1] - left[1])[0]?.[0] ?? "unknown";
}
