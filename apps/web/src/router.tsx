import { Link, Outlet, createRootRouteWithContext, createRoute, createRouter, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable
} from "@tanstack/react-table";
import { Activity, Coins, Database, Gauge, GitBranch, KeyRound, ListFilter, Settings as SettingsIcon } from "lucide-react";

import {
  type RequestSummary,
  fetchOverview,
  fetchRequestDetail,
  fetchRequests,
  fetchSettings
} from "./api";
import { LoginPage, LogoutButton, requireAuth, type RouterContext } from "./auth";
import { Header, JsonPanel, Metric, PageState, Quality, Timeline, formatMoney } from "./ui";

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireAuth,
  component: OverviewPage
});

const requestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/requests",
  beforeLoad: requireAuth,
  component: RequestsPage
});

const requestDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/requests/$requestId",
  beforeLoad: requireAuth,
  component: RequestDetailPage
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: requireAuth,
  component: SettingsPage
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  requestsRoute,
  requestDetailRoute,
  settingsRoute
]);

export const router = createRouter({
  routeTree,
  context: undefined!,
  scrollRestoration: true
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function AppShell() {
  const location = useLocation();
  if (location.pathname === "/login") {
    return (
      <main className="login-shell">
        <Outlet />
      </main>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <GitBranch size={20} />
          <span>Prompt Proxy</span>
        </div>
        <nav>
          <Link to="/" activeProps={{ className: "active" }}>
            <Gauge size={18} />
            Overview
          </Link>
          <Link to="/requests" activeProps={{ className: "active" }}>
            <ListFilter size={18} />
            Requests
          </Link>
          <Link to="/settings" activeProps={{ className: "active" }}>
            <SettingsIcon size={18} />
            Settings
          </Link>
        </nav>
        <LogoutButton />
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function OverviewPage() {
  const query = useQuery({ queryKey: ["overview"], queryFn: fetchOverview });

  if (query.isLoading) return <PageState title="Overview" label="Loading overview" />;
  if (query.error) return <PageState title="Overview" label={query.error.message} />;
  if (!query.data) return <PageState title="Overview" label="No overview data" />;

  const overview = query.data;
  return (
    <section>
      <Header eyebrow={overview.organizationId} title="Routing Overview" />
      <div className="metrics">
        <Metric icon={<Activity size={20} />} label="Requests" value={overview.requestCount.toLocaleString()} />
        <Metric icon={<Database size={20} />} label="Events" value={overview.eventCount.toLocaleString()} />
        <Metric icon={<Coins size={20} />} label="Tokens" value={overview.totals.totalTokens.toLocaleString()} />
        <Metric icon={<Gauge size={20} />} label="Savings" value={formatMoney(overview.cost.savings)} />
      </div>
      <div className="panel">
        <h2>Route Quality</h2>
        <div className="quality-grid">
          <Quality label="Low confidence" value={overview.routeQuality.lowConfidenceCount} />
          <Quality label="Cheaper likely worked" value={overview.routeQuality.cheaperLikelyWouldWorkCount} />
          <Quality label="Cheap retries or repairs" value={overview.routeQuality.cheapCausedRetriesOrRepairsCount} />
        </div>
      </div>
    </section>
  );
}

const requestColumns: ColumnDef<RequestSummary>[] = [
  {
    accessorKey: "requestId",
    header: "Request",
    cell: ({ row }) => (
      <Link to="/requests/$requestId" params={{ requestId: row.original.requestId }} className="table-link">
        {row.original.requestId}
      </Link>
    )
  },
  {
    accessorKey: "surface",
    header: "Surface"
  },
  {
    accessorKey: "finalRoute",
    header: "Route",
    cell: ({ row }) => <span className={`route route-${row.original.finalRoute ?? "unknown"}`}>{row.original.finalRoute ?? "unknown"}</span>
  },
  {
    accessorKey: "selectedModel",
    header: "Selected Model"
  },
  {
    accessorKey: "terminalStatus",
    header: "Status"
  },
  {
    id: "tokens",
    header: "Tokens",
    cell: ({ row }) => row.original.usage.totalTokens.toLocaleString()
  },
  {
    id: "latency",
    header: "Latency",
    cell: ({ row }) => row.original.latencyMs === undefined ? "" : `${row.original.latencyMs}ms`
  }
];

function RequestsPage() {
  const query = useQuery({ queryKey: ["requests"], queryFn: fetchRequests });
  const data = query.data?.data ?? [];
  const table = useReactTable({
    data,
    columns: requestColumns,
    getCoreRowModel: getCoreRowModel()
  });

  if (query.isLoading) return <PageState title="Requests" label="Loading requests" />;
  if (query.error) return <PageState title="Requests" label={query.error.message} />;

  return (
    <section>
      <Header eyebrow={`${data.length} rows`} title="Requests" />
      <div className="table-panel">
        <table>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {data.length === 0 ? <div className="empty">No routed requests yet.</div> : null}
      </div>
    </section>
  );
}

function RequestDetailPage() {
  const { requestId } = requestDetailRoute.useParams();
  const query = useQuery({
    queryKey: ["request", requestId],
    queryFn: () => fetchRequestDetail(requestId)
  });

  if (query.isLoading) return <PageState title="Request" label="Loading request" />;
  if (query.error) return <PageState title="Request" label={query.error.message} />;
  if (!query.data) return <PageState title="Request" label="No request data" />;

  const request = query.data.request;
  return (
    <section>
      <Header eyebrow={requestId} title="Request Detail" />
      {request ? (
        <div className="metrics compact">
          <Metric icon={<Gauge size={20} />} label="Route" value={request.finalRoute ?? "unknown"} />
          <Metric icon={<Database size={20} />} label="Model" value={request.selectedModel ?? "unknown"} />
          <Metric icon={<Coins size={20} />} label="Tokens" value={request.usage.totalTokens.toLocaleString()} />
          <Metric icon={<Activity size={20} />} label="Status" value={request.terminalStatus} />
        </div>
      ) : (
        <div className="empty">No terminal request summary yet.</div>
      )}
      <Timeline events={query.data.events} />
    </section>
  );
}

function SettingsPage() {
  const query = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });

  if (query.isLoading) return <PageState title="Settings" label="Loading settings" />;
  if (query.error) return <PageState title="Settings" label={query.error.message} />;
  if (!query.data) return <PageState title="Settings" label="No settings data" />;

  return (
    <section>
      <Header eyebrow={query.data.organizationId} title="Settings" />
      <div className="settings-grid">
        <JsonPanel icon={<Database size={18} />} title="Persistence" value={{ databaseEnabled: query.data.databaseEnabled }} />
        <JsonPanel icon={<Gauge size={18} />} title="Classifier" value={query.data.classifier} />
        <JsonPanel icon={<Coins size={18} />} title="Budgets" value={query.data.budgets} />
        <JsonPanel icon={<KeyRound size={18} />} title="Policy Trust" value={query.data.routePolicyTrust} />
      </div>
    </section>
  );
}
