import { useQuery } from "@tanstack/react-query";
import { Activity, Gauge, ShieldAlert, WalletCards } from "lucide-react";

import { compactId, formatDateTime, formatInteger, formatMoney } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import {
  apiKeyPolicyRows,
  peakBudgetWindow,
  policyLimits,
  rejectionSummary,
  windowCommitted,
  workspacePolicyRows,
  type BudgetWindow,
  type LimitsDashboard,
  type PolicyRow,
  type RejectionEvent
} from "./limitsPageData";
import { Badge, DataTable, GlassCard, PageSkeleton, PageState, PageTitle, ProgressMeter, StatCard } from "./ui";

const LimitsDashboardViewDocument = graphql(`
  query LimitsDashboardView {
    limitsDashboard {
      workspacePolicies {
        id
        workspaceId
        policy
        updatedAt
      }
      apiKeyPolicies {
        id
        apiKeyId
        apiKeyName
        policy
        updatedAt
      }
      activeRequests {
        id
        requestId
        workspaceId
        apiKeyId
        apiKeyName
        providerAccountName
        expiresAt
      }
      budgetWindows {
        id
        scopeType
        scopeId
        windowType
        periodEndAt
        limitUsd
        reservedUsd
        actualUsd
      }
      rejectionEvents {
        eventId
        eventType
        scopeId
        payload
        createdAt
      }
    }
  }
`);

export function LimitsPage() {
  const { isLoading: queryIsLoading, error: queryError, data: queryData } = useQuery({
    queryKey: ["limits-dashboard"],
    queryFn: async () => (await gqlFetch(LimitsDashboardViewDocument)).limitsDashboard
  });

  if (queryIsLoading) return <PageSkeleton blocks={[120, 320, 260]} />;
  if (queryError) return <PageState title="Limits" label={queryError.message} />;
  if (!queryData) return <PageState title="Limits" label="No limits data" />;

  return (
    <div className="page page-enter limits-page">
      <PageTitle title="Limits" subtitle="Budgets, rate caps, active requests, and rejection evidence" />
      <LimitsSummary dashboard={queryData} />
      <div className="limits-grid">
        <BudgetWindowsCard windows={queryData.budgetWindows} />
        <ActiveRequestsCard dashboard={queryData} />
      </div>
      <div className="limits-grid">
        <PoliciesCard title="Workspace policies" rows={workspacePolicyRows(queryData)} />
        <PoliciesCard title="API key policies" rows={apiKeyPolicyRows(queryData)} />
      </div>
      <RejectionTimelineCard events={queryData.rejectionEvents} />
    </div>
  );
}

function LimitsSummary({ dashboard }: { dashboard: LimitsDashboard }) {
  const peakWindow = peakBudgetWindow(dashboard.budgetWindows);
  const peakCommitted = peakWindow ? windowCommitted(peakWindow) : 0;
  const peakDetail = peakWindow ? `${peakWindow.windowType} ${peakWindow.scopeType.replaceAll("_", " ")}` : "No budget windows";
  const policyCount = dashboard.workspacePolicies.length + dashboard.apiKeyPolicies.length;
  return (
    <div className="limits-kpi-grid">
      <StatCard metric={{ label: "Budget windows", value: formatInteger(dashboard.budgetWindows.length), icon: <WalletCards /> }} />
      <StatCard metric={{ label: "Peak window spend", value: formatMoney(peakCommitted), detail: peakDetail, icon: <Gauge /> }} />
      <StatCard metric={{ label: "Active requests", value: formatInteger(dashboard.activeRequests.length), icon: <Activity /> }} />
      <StatCard metric={{ label: "Rejections", value: formatInteger(dashboard.rejectionEvents.length), detail: `${formatInteger(policyCount)} policies`, icon: <ShieldAlert /> }} />
    </div>
  );
}

function BudgetWindowsCard({ windows }: { windows: BudgetWindow[] }) {
  return (
    <GlassCard className="limits-card table-wrap">
      <div className="card-head">
        <div className="card-title">Budget windows</div>
        <span className="faint mono">{windows.length}</span>
      </div>
      <DataTable>
        <thead>
          <tr><th>Scope</th><th>Window</th><th>Spend</th><th>Ends</th></tr>
        </thead>
        <tbody>
          {windows.map((window) => <BudgetWindowRow key={window.id} window={window} />)}
          {windows.length === 0 ? <EmptyTableRow colSpan={4} label="No budget windows recorded." /> : null}
        </tbody>
      </DataTable>
    </GlassCard>
  );
}

function BudgetWindowRow({ window }: { window: BudgetWindow }) {
  const committed = windowCommitted(window);
  const overLimit = committed > window.limitUsd;
  return (
    <tr>
      <td>
        <div className="limits-scope">
          <span>{window.scopeType.replaceAll("_", " ")}</span>
          <span className="mono faint">{compactId(window.scopeId, 10)}</span>
        </div>
      </td>
      <td><Badge variant={overLimit ? "danger" : "accent"}>{window.windowType}</Badge></td>
      <td>
        <div className="limits-window-meter">
          <span className="mono">{formatMoney(committed)} / {formatMoney(window.limitUsd)}</span>
          <ProgressMeter value={committed} max={window.limitUsd} tone={overLimit ? "danger" : "accent"} />
          <span className="faint">{formatMoney(window.actualUsd)} actual · {formatMoney(window.reservedUsd)} reserved</span>
        </div>
      </td>
      <td><span className="faint nowrap">{formatDateTime(window.periodEndAt)}</span></td>
    </tr>
  );
}

function ActiveRequestsCard({ dashboard }: { dashboard: LimitsDashboard }) {
  return (
    <GlassCard className="limits-card table-wrap">
      <div className="card-head">
        <div className="card-title">Active requests</div>
        <span className="faint mono">{dashboard.activeRequests.length}</span>
      </div>
      <DataTable>
        <thead>
          <tr><th>API key</th><th>Request</th><th>Provider</th><th>Expires</th></tr>
        </thead>
        <tbody>
          {dashboard.activeRequests.map((request) => (
            <tr key={request.id}>
              <td>
                <div className="limits-scope">
                  <span>{request.apiKeyName ?? "Workspace cap"}</span>
                  <span className="mono faint">{compactId(request.apiKeyId ?? request.workspaceId, 10)}</span>
                </div>
              </td>
              <td><span className="mono">{compactId(request.requestId, 12)}</span></td>
              <td><span className="faint">{request.providerAccountName ?? "none"}</span></td>
              <td><span className="faint nowrap">{formatDateTime(request.expiresAt)}</span></td>
            </tr>
          ))}
          {dashboard.activeRequests.length === 0 ? <EmptyTableRow colSpan={4} label="No active request caps reserved." /> : null}
        </tbody>
      </DataTable>
    </GlassCard>
  );
}

function PoliciesCard({ title, rows }: { title: string; rows: PolicyRow[] }) {
  return (
    <GlassCard className="limits-card">
      <div className="card-head">
        <div className="card-title">{title}</div>
        <span className="faint mono">{rows.length}</span>
      </div>
      <div className="limit-policy-list">
        {rows.map((row) => (
          <div key={row.id} className="limit-policy-item">
            <div>
              <strong>{row.subject}</strong>
              <span className="mono faint">{compactId(row.subjectId, 11)}</span>
            </div>
            <div className="limit-policy-values">
              {policyLimits(row.policy).map((label) => <Badge key={label}>{label}</Badge>)}
            </div>
            <span className="faint nowrap">Updated {formatDateTime(row.updatedAt)}</span>
          </div>
        ))}
        {rows.length === 0 ? <div className="empty compact-empty">No policies configured.</div> : null}
      </div>
    </GlassCard>
  );
}

function RejectionTimelineCard({ events }: { events: RejectionEvent[] }) {
  return (
    <GlassCard className="limits-card table-wrap">
      <div className="card-head">
        <div className="card-title">Rejection timeline</div>
        <span className="faint mono">{events.length}</span>
      </div>
      <DataTable>
        <thead>
          <tr><th>Event</th><th>Request</th><th>Decision</th><th>Time</th></tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.eventId}>
              <td><span className="mono">{event.eventType}</span></td>
              <td><span className="mono">{compactId(event.scopeId, 12)}</span></td>
              <td><span>{rejectionSummary(event)}</span></td>
              <td><span className="faint nowrap">{formatDateTime(event.createdAt)}</span></td>
            </tr>
          ))}
          {events.length === 0 ? <EmptyTableRow colSpan={4} label="No limit or budget rejections recorded." /> : null}
        </tbody>
      </DataTable>
    </GlassCard>
  );
}

function EmptyTableRow({ colSpan, label }: { colSpan: number; label: string }) {
  return <tr><td colSpan={colSpan}><span className="faint">{label}</span></td></tr>;
}
