import { useQueries } from "@tanstack/react-query";
import { AlertTriangle, CreditCard, Settings } from "lucide-react";
import { useState } from "react";

import { fetchOverview, fetchSettings } from "./api";
import { InspectorPanel, type InspectorRow } from "./dashboard";
import { formatMoney } from "./format";
import { GlassCard, JsonPanel, PageSkeleton, PageState, PageTitle, ProgressMeter } from "./ui";

type BillingSelection = {
  title: string;
  subtitle: string;
  rows: InspectorRow[];
};

export function BillingPage() {
  const [selection, setSelection] = useState<BillingSelection | null>(null);
  const [overviewQuery, settingsQuery] = useQueries({
    queries: [
      { queryKey: ["overview"], queryFn: fetchOverview },
      { queryKey: ["settings"], queryFn: fetchSettings }
    ]
  });
  const loading = overviewQuery.isLoading || settingsQuery.isLoading;
  const error = overviewQuery.error ?? settingsQuery.error;

  if (loading) return <PageSkeleton blocks={[150, 280, 160]} />;
  if (error) return <PageState title="Billing" label={error.message} />;

  const overview = overviewQuery.data;
  const settings = settingsQuery.data;
  if (!overview || !settings) return <PageState title="Billing" label="No billing data" />;

  const comparison = Math.max(overview.cost.baseline, overview.cost.selected);
  const projected = overview.requestCount === 0 ? 0 : overview.cost.selected;
  const activeSelection = selection ?? {
    title: "Spend controls",
    subtitle: "Select a billing control to inspect its current source of truth.",
    rows: [
      { label: "Selected spend", value: formatMoney(overview.cost.selected) },
      { label: "Baseline", value: formatMoney(overview.cost.baseline) },
      { label: "Savings", value: formatMoney(overview.cost.savings) }
    ]
  };
  return (
    <div className="page page-enter">
      <PageTitle
        title="Billing"
        subtitle="Spend, budgets, and invoices for Proxy Labs."
        actions={<button className="btn" type="button" onClick={() => setSelection(paymentSelection())}><CreditCard />Payment method</button>}
      />
      <div className="billing-kpis">
        <GlassCard>
          <div className="card-title">Current selected spend</div>
          <div className="stat-value spend-value">{formatMoney(overview.cost.selected)}</div>
          <ProgressMeter value={overview.cost.selected} max={comparison} />
          <div className="row budget-row">
            <span className="faint">Baseline {formatMoney(overview.cost.baseline)}</span>
            <span className="badge badge-accent">{formatMoney(overview.cost.savings)} saved</span>
          </div>
        </GlassCard>
        <GlassCard>
          <div className="card-title">Observed run rate</div>
          <div className="stat-value spend-value">{formatMoney(projected)}</div>
          <div className="stat-sub">based on captured proxy ledger rows</div>
        </GlassCard>
        <GlassCard>
          <div className="card-title">Requests billed</div>
          <div className="stat-value spend-value">{overview.requestCount}</div>
          <div className="stat-sub">from the usage ledger</div>
        </GlassCard>
      </div>
      <div className="billing-grid">
        <GlassCard>
          <div className="card-title"><AlertTriangle />Spend controls</div>
          <button className="billing-alert-row billing-alert-button" type="button" onClick={() => setSelection(policySelection("Budget policy", settings.budgets))}>
            <div><strong>Budget policy</strong><span>Configured in organization settings and enforced by the proxy.</span></div>
            <Settings />
          </button>
          <button className="billing-alert-row billing-alert-button" type="button" onClick={() => setSelection(policySelection("Invoices", { implemented: false }))}>
            <div><strong>Invoices</strong><span>Invoice ingestion is not implemented yet, so no invoice rows are rendered.</span></div>
            <Settings />
          </button>
          <button className="billing-alert-row billing-alert-button" type="button" onClick={() => setSelection(policySelection("Per-key limits", { implemented: false }))}>
            <div><strong>Per-key limits</strong><span>Requires an API key inventory endpoint before limits can be attributed safely.</span></div>
            <Settings />
          </button>
        </GlassCard>
        <JsonPanel title="Budget settings" value={settings.budgets} />
      </div>
      <InspectorPanel title={activeSelection.title} subtitle={activeSelection.subtitle} rows={activeSelection.rows} />
    </div>
  );
}

function paymentSelection(): BillingSelection {
  return {
    title: "Payment method",
    subtitle: "Payment method management is not wired to a billing provider yet.",
    rows: [
      { label: "Status", value: "Not implemented" },
      { label: "Next backend", value: "Billing provider adapter" }
    ]
  };
}

function policySelection(title: string, value: unknown): BillingSelection {
  return {
    title,
    subtitle: "Current configuration source",
    rows: [
      { label: "Source", value: "organization settings" },
      { label: "Value", value: <span className="mono">{JSON.stringify(value)}</span> }
    ]
  };
}
