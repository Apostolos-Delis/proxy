import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Download, Shield, Users } from "lucide-react";

import { downloadJson } from "./dashboard";
import { compactId, formatCompact, formatDateTime, formatMoney } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import {
  activityTime,
  countRecord,
  lastActivity,
  requestCountLabel,
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
import { PageState, RouteBadge, StatusBadge, UserCell } from "./ui";

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
