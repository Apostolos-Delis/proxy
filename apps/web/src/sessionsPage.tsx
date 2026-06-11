import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Download, MessagesSquare, Shield, Users } from "lucide-react";
import type { ReactNode } from "react";

import { ARTIFACT_KIND_ROLES, artifactPosition } from "./artifactKinds";
import { displayUser } from "./consoleData";
import { downloadJson } from "./dashboard";
import { compactId, dominantKey, formatCompact, formatDateTime, formatDateTimeSeconds, formatDurationMs, formatMoney, formatTimeOfDay } from "./format";
import { graphql } from "./gql";
import type { SessionDetailViewQuery, SessionsPageQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { CopyButton } from "./jsonView";
import { ConsoleTable, optionItems, uniqueOptionItems, type ConsoleTableAdvancedField, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { GlassCard, PageState, PageTitle, RouteBadge, StatusBadge, UserCell } from "./ui";

const SessionsPageDocument = graphql(`
  query SessionsPage {
    sessions {
      sessionId
      externalSessionId
      userId
      surface
      currentRoute
      requestCount
      startedAt
      recentActivity
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
    users {
      userId
      name
      email
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

type SessionSummary = SessionsPageQuery["sessions"][number];
type SessionDetail = NonNullable<SessionDetailViewQuery["session"]>;
type SessionRequest = SessionDetail["requests"][number];
type SessionArtifact = SessionDetail["promptArtifacts"][number];

type SessionLogRow = {
  session: SessionSummary;
  userName: string;
  userDetail?: string;
};

type ConversationTurn = {
  index: number;
  gapMs: number | null;
  request: SessionRequest;
  artifacts: SessionArtifact[];
};

function countRecord(value: unknown): Record<string, number> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, number>
    : {};
}

export function SessionsPage() {
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["sessions-page"], queryFn: () => gqlFetch(SessionsPageDocument) });

  if (query.isLoading) return <PageState title="Sessions" label="Loading sessions" />;
  if (query.error) return <PageState title="Sessions" label={query.error.message} />;

  const rows = sessionRows(query.data?.sessions ?? [], query.data?.users ?? []);
  const openSession = (row: SessionLogRow) =>
    void navigate({ to: "/sessions/$sessionId", params: { sessionId: row.session.sessionId } });
  return (
    <div className="page page-enter">
      <ConsoleTable
        className="logs-table-card"
        urlState
        data={rows}
        columns={sessionColumns}
        search={{ placeholder: "Search sessions, users, models...", getValue: sessionSearchValue }}
        filters={sessionFilters(rows)}
        advancedFields={sessionAdvancedFields}
        emptyLabel="No sessions match these filters."
        actions={({ visibleData }) => (
          <button className="btn" type="button" onClick={() => downloadJson("proxy-sessions.json", visibleData)}>
            <Download />Export
          </button>
        )}
        getRowProps={(row) => ({
          className: "selectable-row",
          tabIndex: 0,
          role: "link",
          onClick: () => openSession(row),
          onKeyDown: (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openSession(row);
          }
        })}
      />
    </div>
  );
}

const sessionColumns: ConsoleTableColumn<SessionLogRow>[] = [
  { id: "session", header: "Session", size: 280, accessorFn: (row) => row.session.externalSessionId ?? row.session.sessionId, cell: ({ row }) => <SessionCell row={row.original} /> },
  { id: "user", header: "User", size: 200, accessorFn: (row) => row.userName, cell: ({ row }) => <UserCell name={row.original.userName} detail={row.original.userDetail} size={24} /> },
  { id: "models", header: "Models", size: 220, accessorFn: (row) => sessionModels(row.session).join(" "), cell: ({ row }) => <ModelsCell session={row.original.session} /> },
  { id: "route", header: "Route", size: 110, accessorFn: (row) => sessionRoute(row.session), cell: ({ row }) => <RouteBadge route={sessionRoute(row.original.session)} /> },
  { id: "status", header: "Status", size: 140, accessorFn: (row) => sessionStatus(row.session), cell: ({ row }) => <SessionStatusCell session={row.original.session} /> },
  { id: "tokens", header: "Tokens", size: 96, accessorFn: (row) => row.session.usage.totalTokens, cell: ({ row }) => <span className="mono">{formatCompact(row.original.session.usage.totalTokens)}</span> },
  { id: "cost", header: "Cost", size: 96, accessorFn: (row) => row.session.cost.selected, cell: ({ row }) => <span className="mono">{formatMoney(row.original.session.cost.selected)}</span> },
  { id: "activity", header: "Last activity", size: 150, accessorFn: (row) => activityTime(row.session), cell: ({ row }) => <span className="mono faint">{formatDateTime(lastActivity(row.original.session))}</span> }
];

const sessionAdvancedFields: ConsoleTableAdvancedField<SessionLogRow>[] = [
  { id: "sessionId", label: "Session ID", getValue: (row) => [row.session.sessionId, row.session.externalSessionId ?? ""] },
  { id: "user", label: "User", getValue: (row) => [row.userName, row.session.userId ?? ""] },
  { id: "surface", label: "Surface", getValue: (row) => row.session.surface },
  { id: "route", label: "Route", getValue: (row) => Object.keys(countRecord(row.session.routeMix)) },
  { id: "model", label: "Model", getValue: (row) => sessionModels(row.session) },
  { id: "status", label: "Status", getValue: (row) => sessionStatuses(row.session) },
  { id: "requests", label: "Requests", getValue: (row) => row.session.requestCount }
];

function SessionCell({ row }: { row: SessionLogRow }) {
  const session = row.session;
  return (
    <div className="prompt-cell">
      <Link to="/sessions/$sessionId" params={{ sessionId: session.sessionId }} className="table-link mono">
        {compactId(session.externalSessionId ?? session.sessionId)}
      </Link>
      <div className="mono faint">{requestCountLabel(session.requestCount)} · {session.surface}</div>
    </div>
  );
}

function ModelsCell({ session }: { session: SessionSummary }) {
  const models = sortedCounts(countRecord(session.modelMix));
  if (models.length === 0) return <span className="faint">—</span>;
  const [primary, ...rest] = models;
  return (
    <>
      <span className="row gap-8"><span className="model-dot" /><span className="mono">{primary[0]}</span></span>
      {rest.length > 0 ? <div className="mono faint">+{rest.length} more</div> : null}
    </>
  );
}

function SessionStatusCell({ session }: { session: SessionSummary }) {
  const statuses = sortedCounts(countRecord(session.terminalStatusSummary));
  const rest = statuses.slice(1);
  return (
    <>
      <StatusBadge status={statuses[0]?.[0] ?? "unknown"} />
      {rest.length > 0 ? <div className="mono faint">{rest.map(([status, count]) => `${count} ${status}`).join(" · ")}</div> : null}
    </>
  );
}

function sessionFilters(rows: SessionLogRow[]): ConsoleTableFilter<SessionLogRow>[] {
  return [
    { id: "user", label: "User", allLabel: "All users", icon: <Users />, options: uniqueOptionItems(rows.map((row) => ({ value: row.session.userId ?? "unknown", label: row.userName }))), getValue: (row) => row.session.userId ?? "unknown" },
    { id: "model", label: "Model", allLabel: "All models", icon: <Boxes />, options: optionItems(rows.flatMap((row) => sessionModels(row.session))), getValue: (row) => sessionModels(row.session) },
    { id: "status", label: "Status", allLabel: "All statuses", icon: <Shield />, options: optionItems(rows.flatMap((row) => sessionStatuses(row.session))), getValue: (row) => sessionStatuses(row.session) }
  ];
}

function sessionSearchValue(row: SessionLogRow) {
  const session = row.session;
  return [
    session.sessionId,
    session.externalSessionId,
    row.userName,
    session.userId,
    session.surface,
    sessionRoute(session),
    ...sessionModels(session),
    ...sessionStatuses(session)
  ].filter((value): value is string => Boolean(value));
}

function sessionRows(sessions: SessionSummary[], users: SessionsPageQuery["users"]): SessionLogRow[] {
  const usersById = new Map(users.map((user) => [user.userId, user]));
  return sessions.map((session) => {
    const user = session.userId ? usersById.get(session.userId) : undefined;
    const userName = user ? displayUser(user) : session.userId ?? "unknown";
    const email = user?.email;
    return { session, userName, userDetail: email && email !== userName ? email : undefined };
  });
}

function sortedCounts(counts: Record<string, number>) {
  return Object.entries(counts).sort((left, right) => right[1] - left[1]);
}

function sessionModels(session: SessionSummary) {
  return Object.keys(countRecord(session.modelMix));
}

function sessionStatuses(session: SessionSummary) {
  return Object.keys(countRecord(session.terminalStatusSummary));
}

function sessionRoute(session: SessionSummary) {
  return session.currentRoute ?? dominantKey(countRecord(session.routeMix));
}

function sessionStatus(session: SessionSummary) {
  return dominantKey(countRecord(session.terminalStatusSummary));
}

function lastActivity(session: SessionSummary) {
  return session.recentActivity ?? session.startedAt;
}

function activityTime(session: SessionSummary) {
  return new Date(lastActivity(session)).getTime();
}

function requestCountLabel(count: number) {
  return `${formatCompact(count)} ${count === 1 ? "request" : "requests"}`;
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

function conversationTurns(detail: SessionDetail): ConversationTurn[] {
  const artifactsByRequest = new Map<string, SessionArtifact[]>();
  // Capture dedupes per session, but concurrent requests can race it;
  // drop any repeated (kind, content) pair so messages render once.
  const seen = new Set<string>();
  const chronological = [...detail.promptArtifacts]
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  for (const artifact of chronological) {
    if (!ARTIFACT_KIND_ROLES[artifact.kind]) continue;
    const key = `${artifact.kind}:${artifact.contentHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = artifactsByRequest.get(artifact.requestId) ?? [];
    list.push(artifact);
    artifactsByRequest.set(artifact.requestId, list);
  }
  const ordered = [...detail.requests].sort((left, right) => requestTime(left) - requestTime(right));
  return ordered.map((request, index) => {
    const artifacts = [...(artifactsByRequest.get(request.requestId) ?? [])].sort(compareArtifacts);
    const previous = index > 0 ? ordered[index - 1] : null;
    // Idle time before this turn: previous turn's latency is not "waiting".
    const gapMs = request.createdAt && previous?.createdAt
      ? Math.max(0, new Date(request.createdAt).getTime() - new Date(previous.createdAt).getTime() - (previous.latencyMs ?? 0))
      : null;
    return { index, gapMs, request, artifacts };
  });
}

function compareArtifacts(left: SessionArtifact, right: SessionArtifact) {
  const byIndex = artifactPosition(left) - artifactPosition(right);
  if (byIndex !== 0) return byIndex;
  return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
}

function artifactRole(artifact: SessionArtifact) {
  return ARTIFACT_KIND_ROLES[artifact.kind] ?? { role: "user" as const, label: artifact.kind };
}

function conversationSpan(turns: ConversationTurn[]) {
  if (turns.length < 2) return null;
  const first = turns[0].request.createdAt;
  const last = turns[turns.length - 1].request.createdAt;
  return first && last ? new Date(last).getTime() - new Date(first).getTime() : null;
}

function artifactText(artifact?: SessionArtifact) {
  return artifact ? artifact.rawText ?? artifact.redactedText ?? artifact.preview : null;
}

function transcriptText(turns: ConversationTurn[]) {
  return turns
    .map((turn) => {
      const lines = turn.artifacts
        .map((artifact) => {
          const text = artifactText(artifact);
          if (!text) return null;
          const stamp = artifact.createdAt ?? turn.request.createdAt;
          return `${stamp ? `[${formatDateTimeSeconds(stamp)}] ` : ""}${artifactRole(artifact).label}: ${text}`;
        })
        .filter(Boolean);
      if (lines.length > 0) return lines.join("\n");
      const stamp = turn.request.createdAt ? `[${formatDateTimeSeconds(turn.request.createdAt)}] ` : "";
      return `${stamp}(turn ${turn.index + 1}: content not captured)`;
    })
    .join("\n\n");
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
