import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Coins, Download, KeyRound, Send, Sparkles, Zap } from "lucide-react";
import { useState } from "react";

import { isAdminRole } from "./access";
import { type AuthMe, fetchMe } from "./session";
import { AreaChart, MiniBars, Sparkline } from "./charts";
import { modelRowsFromUsage, periodDelta, seriesFromRequests } from "./consoleData";
import { downloadJson, InteractiveStatCard } from "./dashboard";
import { formatCompact, formatInteger, formatMoney, formatPercent } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { BarListRow, ConsoleButton, GlassCard, PageSkeleton, PageState, ProgressMeter, Segmented } from "./ui";

const OverviewPageDocument = graphql(`
  query OverviewPage {
    overviewDashboard {
      overview {
        requestCount
        totals {
          totalTokens
        }
        cost {
          selected
          baseline
          savings
        }
        routeQuality {
          lowConfidenceCount
        }
      }
      requests {
        createdAt
        selectedCost
        baselineCost
        usage {
          totalTokens
        }
      }
      modelUsage {
        data {
          key
          usage {
            totalTokens
          }
          cost {
            selected
          }
        }
      }
    }
  }
`);

const rangeOptions = [
  { value: "1", label: "24h" },
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" }
] as const;

export function OverviewPage() {
  const [rangeDays, setRangeDays] = useState<"1" | "7" | "30" | "90">("7");
  const { isLoading: queryIsLoading, error: queryError, data: queryData } = useQuery({ queryKey: ["overview-page"], queryFn: () => gqlFetch(OverviewPageDocument) });
  const { data: meQueryData } = useQuery({ queryKey: ["me"], queryFn: fetchMe });

  if (queryIsLoading) return <PageSkeleton blocks={[186, 380, 150]} />;
  if (queryError) return <PageState title="Overview" label={queryError.message} />;
  if (!queryData) return <PageState title="Overview" label="No overview data" />;

  const overview = queryData.overviewDashboard.overview;
  const requests = queryData.overviewDashboard.requests;
  const days = Number(rangeDays);
  const spendSeries = seriesFromRequests(requests, "cost", days);
  const tokenSeries = seriesFromRequests(requests, "tokens", days);
  const requestSeries = seriesFromRequests(requests, "requests", days);
  const requestsInRange = requestSeries.reduce((sum, point) => sum + point.value, 0);
  // Deltas compare the last 7 days against the 7 days before, independent of the selected range.
  const tokenDelta = periodDelta(seriesFromRequests(requests, "tokens", 14));
  const requestDelta = periodDelta(seriesFromRequests(requests, "requests", 14));
  const spendDelta = periodDelta(seriesFromRequests(requests, "cost", 14));
  const modelRows = modelRowsFromUsage(queryData.overviewDashboard.modelUsage.data);
  const quality = overview.routeQuality;
  const exportOverview = () => downloadJson("proxy-overview.json", { overview, requests, rangeDays, modelRows });
  const isAdmin = isAdminRole(meQueryData?.user.role);

  return (
    <div className="page page-enter">
      <div className="row gap-12 page-hero-row">
        <div>
          <div className="hero-greeting">{greetingFor(meQueryData?.user)}</div>
          <div className="muted">Here's what's happening across {organizationName(meQueryData) ?? "your workspace"}.</div>
        </div>
        <div className="row gap-8">
          {isAdmin ? (
            <>
              <Link to="/api-keys" className="btn"><KeyRound />Get API key</Link>
              <Link to="/settings" className="btn btn-primary"><Sparkles />Runtime settings</Link>
            </>
          ) : null}
          <ConsoleButton variant="ghost" onClick={exportOverview}><Download />Export</ConsoleButton>
        </div>
      </div>

      <div className="overview-kpis">
        <InteractiveStatCard
          metric={{ label: "Total tokens", value: formatCompact(overview.totals.totalTokens), icon: <Zap />, delta: tokenDelta }}
          chart={<Sparkline data={tokenSeries.slice(-7)} valueFormatter={formatInteger} />}
          to="/usage"
        />
        <InteractiveStatCard
          metric={{ label: "Requests", value: formatInteger(overview.requestCount), icon: <Send />, delta: requestDelta }}
          chart={<MiniBars data={requestSeries.slice(-7)} valueFormatter={formatInteger} />}
          to={isAdmin ? "/logs" : "/usage"}
        />
        <InteractiveStatCard
          metric={{ label: "Spend", value: formatMoney(overview.cost.selected, 0), icon: <Coins />, delta: spendDelta, deltaPositiveIsGood: false }}
          chart={<Sparkline data={spendSeries.slice(-7)} valueFormatter={formatMoney} />}
          to={isAdmin ? "/billing" : "/cost"}
        />
      </div>

      <div className="overview-main-grid">
        <GlassCard>
          <div className="card-head">
            <div className="card-title">Request volume</div>
            <div className="row gap-12">
              <span className="muted mono">{formatInteger(requestsInRange)} in range</span>
              <Segmented options={rangeOptions} value={rangeDays} onChange={setRangeDays} />
            </div>
          </div>
          <AreaChart data={requestSeries} height={330} valueFormatter={formatInteger} />
        </GlassCard>

        <GlassCard>
          <SavingsSummary cost={overview.cost} />
          <div className="sep" />
          <div className="card-head">
            <div className="card-title">Top models</div>
            <Link to="/usage" className="card-link">Usage<ArrowUpRight /></Link>
          </div>
          <div className="barlist">
            {modelRows.slice(0, 5).map((row) => (
              <BarListRow
                key={row.label}
                label={row.label}
                value={`${formatCompact(row.tokens)} tok`}
                width={(row.tokens / Math.max(modelRows[0]?.tokens ?? 1, 1)) * 100}
                color={row.color}
                mono
              />
            ))}
            {modelRows.length === 0 ? <div className="empty compact-empty">No model usage yet.</div> : null}
          </div>
        </GlassCard>
      </div>

      <GlassCard>
        <div className="card-head">
          <div className="card-title">Gateway quality</div>
          {isAdmin ? <Link to="/logs" className="btn btn-sm"><ArrowUpRight />Open logs</Link> : null}
        </div>
        <div className="quality-grid">
          <QualitySignal
            label="Low confidence"
            count={quality.lowConfidenceCount}
            caption="flagged gateway decisions"
            tone="warn-text"
            title="Gateway decisions recorded with lower confidence."
          />
        </div>
      </GlassCard>
    </div>
  );
}

function SavingsSummary({ cost }: { cost: { selected: number; baseline: number; savings: number } }) {
  const comparison = Math.max(cost.baseline, cost.selected);
  if (comparison <= 0) {
    return (
      <>
        <div className="card-title">Gateway savings</div>
        <div className="savings-empty">
          <strong>No priced traffic yet</strong>
          <span>Savings appear once model deployments have pricing.</span>
        </div>
      </>
    );
  }
  const rate = cost.baseline > 0 ? cost.savings / cost.baseline : 0;
  return (
    <>
      <div className="card-title">Gateway savings<span className="usage-scope-note">all time</span></div>
      <div className={`stat-value spend-value${cost.savings > 0 ? " accent-text" : ""}`}>{formatMoney(cost.savings)}</div>
      <div className="stat-sub">{formatPercent(Math.abs(rate))} {cost.savings < 0 ? "above" : "below"} baseline</div>
      <div className="savings-meter">
        <ProgressMeter value={cost.selected} max={comparison} />
        <div className="row budget-row">
          <span className="faint">{formatMoney(cost.selected)} spent</span>
          <span className="faint">{formatMoney(cost.baseline)} baseline</span>
        </div>
      </div>
    </>
  );
}

function QualitySignal({ label, count, caption, tone, title }: {
  label: string;
  count: number;
  caption: string;
  tone: "warn-text" | "accent-text" | "danger-text";
  title: string;
}) {
  return (
    <div title={title}>
      <span>{label}</span>
      <strong className={count > 0 ? tone : undefined}>{formatInteger(count)}</strong>
      <em>{caption}</em>
    </div>
  );
}

function organizationName(me?: AuthMe) {
  if (!me) return undefined;
  return me.organizations.find((organization) => organization.id === me.organizationId)?.name;
}

function greetingFor(user?: { name?: string | null; email?: string | null }) {
  const hour = new Date().getHours();
  let timeOfDay = "evening";
  if (hour < 12) timeOfDay = "morning";
  else if (hour < 18) timeOfDay = "afternoon";
  const name = user?.name ?? user?.email?.split("@")[0];
  return name ? `Good ${timeOfDay}, ${name.split(/\s+/)[0]}` : `Good ${timeOfDay}`;
}
