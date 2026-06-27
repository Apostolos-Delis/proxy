import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Download, Shield, Users } from "lucide-react";

import { downloadJson } from "./dashboard";
import { compactId, formatCompact, formatDateTime, formatDurationMs, formatMoney } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import {
  countRecord,
  sessionDurationMs,
  sessionModels,
  sessionRoute,
  sessionRows,
  sessionSearchValue,
  sessionStatus,
  sessionStatuses,
  sortedCounts,
  type SessionLogRow,
  type SessionSummary
} from "./sessionsPageData";
import { ConsoleTable, optionItems, uniqueOptionItems, type ConsoleTableAdvancedField, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { TierGauge } from "./routing/tierViz";
import { GlassCard, StatusIndicator, UserCell } from "./ui";

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
      endedAt
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

export function SessionLogsTable() {
  const navigate = useNavigate();
  const { isLoading: queryIsLoading, error: queryError, data: queryData } = useQuery({ queryKey: ["sessions-page"], queryFn: () => gqlFetch(SessionsPageDocument) });

  if (queryIsLoading) return <SessionLogsState label="Loading sessions" />;
  if (queryError) return <SessionLogsState label={queryError.message} />;

  const rows = sessionRows(queryData?.sessions ?? [], queryData?.users ?? []);
  const openSession = (row: SessionLogRow) =>
    void navigate({ to: "/sessions/$sessionId", params: { sessionId: row.session.sessionId } });
  return (
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
  );
}

function SessionLogsState({ label }: { label: string }) {
  return (
    <GlassCard className="empty-state">
      <strong>{label}</strong>
      <span>Run traffic through the proxy and this surface will populate automatically.</span>
    </GlassCard>
  );
}

const sessionColumns: ConsoleTableColumn<SessionLogRow>[] = [
  { id: "session", header: "Session", size: 240, accessorFn: (row) => row.session.externalSessionId ?? row.session.sessionId, cell: ({ row }) => <SessionCell row={row.original} /> },
  { id: "user", header: "User", size: 170, accessorFn: (row) => row.userName, cell: ({ row }) => <UserCell name={row.original.userName} detail={row.original.userDetail} size={24} /> },
  { id: "models", header: "Models", size: 190, accessorFn: (row) => sessionModels(row.session).join(" "), cell: ({ row }) => <ModelsCell session={row.original.session} /> },
  { id: "route", header: "Route", size: 116, accessorFn: (row) => sessionRoute(row.session), cell: ({ row }) => <TierGauge route={sessionRoute(row.original.session)} /> },
  { id: "status", header: "Status", size: 120, accessorFn: (row) => sessionStatus(row.session), cell: ({ row }) => <SessionStatusCell session={row.original.session} /> },
  { id: "requests", header: "Reqs", size: 60, minSize: 60, accessorFn: (row) => row.session.requestCount, cell: ({ row }) => <span className="mono muted">{formatCompact(row.original.session.requestCount)}</span> },
  { id: "tokens", header: "Tokens", size: 84, minSize: 84, accessorFn: (row) => row.session.usage.totalTokens, cell: ({ row }) => <span className="mono">{formatCompact(row.original.session.usage.totalTokens)}</span> },
  { id: "cost", header: "Cost", size: 84, minSize: 84, accessorFn: (row) => row.session.cost.selected, cell: ({ row }) => <span className="mono">{formatMoney(row.original.session.cost.selected)}</span> },
  { id: "started", header: "Started", size: 122, accessorFn: (row) => new Date(row.session.startedAt).getTime(), cell: ({ row }) => <span className="mono faint nowrap">{formatDateTime(row.original.session.startedAt)}</span> },
  { id: "duration", header: "Duration", size: 92, minSize: 92, accessorFn: (row) => sessionDurationMs(row.session) ?? 0, cell: ({ row }) => <DurationCell session={row.original.session} /> }
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
      <div className="mono faint">{session.surface}</div>
    </div>
  );
}

function ModelsCell({ session }: { session: SessionSummary }) {
  const models = sortedCounts(countRecord(session.modelMix));
  if (models.length === 0) return <span className="faint">—</span>;
  const shown = models.slice(0, 2);
  const rest = models.length - shown.length;
  return (
    <div className="models-cell">
      {shown.map(([model]) => (
        <span key={model} className="row gap-8"><span className="mono">{model}</span></span>
      ))}
      {rest > 0 ? <div className="mono faint">+{rest} more</div> : null}
    </div>
  );
}

function DurationCell({ session }: { session: SessionSummary }) {
  const durationMs = sessionDurationMs(session);
  return <span className="mono faint">{durationMs != null ? formatDurationMs(durationMs) : "—"}</span>;
}

function SessionStatusCell({ session }: { session: SessionSummary }) {
  const statuses = sortedCounts(countRecord(session.terminalStatusSummary));
  const rest = statuses.slice(1);
  const breakdown = statuses.map(([status, count]) => `${count} ${status}`).join(" · ");
  return (
    <div className="status-cell">
      <StatusIndicator status={statuses[0]?.[0] ?? "unknown"} />
      {rest.length > 0 ? (
        <span className="status-extra mono faint" tabIndex={0}>
          +{rest.length}
          <span className="info-hint-bubble" role="tooltip">{breakdown}</span>
        </span>
      ) : null}
    </div>
  );
}

function sessionFilters(rows: SessionLogRow[]): ConsoleTableFilter<SessionLogRow>[] {
  return [
    { id: "user", label: "User", allLabel: "All users", icon: <Users />, options: uniqueOptionItems(rows.map((row) => ({ value: row.session.userId ?? "unknown", label: row.userName }))), getValue: (row) => row.session.userId ?? "unknown" },
    { id: "model", label: "Model", allLabel: "All models", icon: <Boxes />, options: optionItems(rows.flatMap((row) => sessionModels(row.session))), getValue: (row) => sessionModels(row.session) },
    { id: "status", label: "Status", allLabel: "All statuses", icon: <Shield />, options: optionItems(rows.flatMap((row) => sessionStatuses(row.session))), getValue: (row) => sessionStatuses(row.session) }
  ];
}
