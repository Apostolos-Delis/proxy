import { useQueries } from "@tanstack/react-query";
import { Activity, Coins, Database, Gauge } from "lucide-react";

import { type UsageResponse, fetchUsage } from "./api";
import { Header, Metric, PageState, formatMoney } from "./ui";

const usageGroups = ["route", "provider", "model", "user", "surface", "session"];

export function UsagePage() {
  const queries = useQueries({
    queries: usageGroups.map((groupBy) => ({
      queryKey: ["usage", groupBy],
      queryFn: () => fetchUsage(groupBy)
    }))
  });
  const loading = queries.some((query) => query.isLoading);
  const error = queries.find((query) => query.error)?.error;
  const responses = queries
    .map((query) => query.data)
    .filter((item): item is UsageResponse => Boolean(item));

  if (loading) return <PageState title="Usage" label="Loading usage" />;
  if (error) return <PageState title="Usage" label={error.message} />;
  if (responses.length === 0) return <PageState title="Usage" label="No usage data" />;

  const totals = responses[0].totals;
  return (
    <section>
      <Header eyebrow="Organization" title="Usage" />
      <div className="metrics">
        <Metric icon={<Activity size={20} />} label="Requests" value={totals.requestCount.toLocaleString()} />
        <Metric icon={<Database size={20} />} label="Tokens" value={totals.usage.totalTokens.toLocaleString()} />
        <Metric icon={<Gauge size={20} />} label="Retry rate" value={formatPercent(totals.retryRate)} />
        <Metric icon={<Coins size={20} />} label="Cost" value={formatMoney(totals.cost.selected)} />
      </div>
      <div className="usage-grid">
        {responses.map((response) => (
          <UsageTable key={response.groupBy} response={response} />
        ))}
      </div>
    </section>
  );
}

function UsageTable({ response }: { response: UsageResponse }) {
  return (
    <div className="panel usage-table">
      <h2>{titleForGroup(response.groupBy)}</h2>
      <table>
        <thead>
          <tr>
            <th>{response.groupBy}</th>
            <th>Requests</th>
            <th>Tokens</th>
            <th>Cost</th>
            <th>Retries</th>
            <th>Failures</th>
          </tr>
        </thead>
        <tbody>
          {response.data.map((row) => (
            <tr key={row.key}>
              <td>{row.key}</td>
              <td>{row.requestCount.toLocaleString()}</td>
              <td>{row.usage.totalTokens.toLocaleString()}</td>
              <td>{formatMoney(row.cost.selected)}</td>
              <td>{formatPercent(row.retryRate)}</td>
              <td>{formatPercent(row.failureRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {response.data.length === 0 ? <div className="empty">No {response.groupBy} usage yet.</div> : null}
    </div>
  );
}

function titleForGroup(groupBy: string) {
  if (groupBy === "route") return "Routes";
  if (groupBy === "provider") return "Providers";
  if (groupBy === "model") return "Models";
  if (groupBy === "user") return "Users";
  if (groupBy === "surface") return "Surfaces";
  return "Sessions";
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}
