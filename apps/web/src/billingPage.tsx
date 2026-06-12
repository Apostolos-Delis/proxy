import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CreditCard } from "lucide-react";

import { formatInteger, formatMoney } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { ModelPricingCard } from "./modelPricingCard";
import { Badge, GlassCard, PageSkeleton, PageState, PageTitle, ProgressMeter, RouteBadge } from "./ui";

const BillingPageDocument = graphql(`
  query BillingPage {
    overview {
      requestCount
      cost {
        selected
        baseline
        savings
      }
    }
    settings {
      budgets {
        warningEstimatedInputTokens
        maxEstimatedInputTokens
        maxRoute
      }
    }
  }
`);

export function BillingPage() {
  const query = useQuery({ queryKey: ["billing-page"], queryFn: () => gqlFetch(BillingPageDocument) });

  if (query.isLoading) return <PageSkeleton blocks={[150, 280, 160]} />;
  if (query.error) return <PageState title="Billing" label={query.error.message} />;

  const overview = query.data?.overview;
  const settings = query.data?.settings;
  if (!overview || !settings) return <PageState title="Billing" label="No billing data" />;

  const comparison = Math.max(overview.cost.baseline, overview.cost.selected);
  const projected = overview.requestCount === 0 ? 0 : overview.cost.selected;
  const budgets = settings.budgets;
  const hasGuardrails = budgets.warningEstimatedInputTokens != null
    || budgets.maxEstimatedInputTokens != null
    || budgets.maxRoute != null;
  return (
    <div className="page page-enter">
      <PageTitle title="Billing" subtitle="Spend, budgets, and invoices for Proxy Labs." />
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
          <div className="stat-value spend-value">{formatInteger(overview.requestCount)}</div>
          <div className="stat-sub">from the usage ledger</div>
        </GlassCard>
      </div>
      <ModelPricingCard />
      <div className="billing-grid">
        <GlassCard>
          <div className="card-title"><CreditCard />Spend controls</div>
          <div className="billing-control-row">
            <div>
              <strong>Budget policy</strong>
              <span>Warning and hard limits on estimated input tokens, enforced by the proxy on every request.</span>
            </div>
            <Link to="/settings" className="card-link">Configure<ArrowUpRight /></Link>
          </div>
          <div className="billing-control-row">
            <div>
              <strong>Invoices</strong>
              <span>Invoice ingestion is not wired to a billing provider yet.</span>
            </div>
            <Badge>Planned</Badge>
          </div>
          <div className="billing-control-row">
            <div>
              <strong>Per-key limits</strong>
              <span>Requires an API key inventory endpoint before limits can be attributed safely.</span>
            </div>
            <Badge>Planned</Badge>
          </div>
        </GlassCard>
        <GlassCard>
          <div className="card-head">
            <div className="card-title">Budget guardrails</div>
            <Link to="/settings" className="card-link">Settings<ArrowUpRight /></Link>
          </div>
          {hasGuardrails ? (
            <div>
              <div className="billing-budget-line">
                <span>Warning input tokens</span>
                {budgets.warningEstimatedInputTokens != null
                  ? <strong className="mono">{formatInteger(budgets.warningEstimatedInputTokens)} tok</strong>
                  : <span className="faint">No limit</span>}
              </div>
              <div className="billing-budget-line">
                <span>Max input tokens</span>
                {budgets.maxEstimatedInputTokens != null
                  ? <strong className="mono">{formatInteger(budgets.maxEstimatedInputTokens)} tok</strong>
                  : <span className="faint">No limit</span>}
              </div>
              <div className="billing-budget-line">
                <span>Max route</span>
                {budgets.maxRoute ? <RouteBadge route={budgets.maxRoute} /> : <span className="faint">Uncapped</span>}
              </div>
            </div>
          ) : (
            <div className="savings-empty">
              <strong>No guardrails set</strong>
              <span>Requests route without budget warnings or hard limits. Set thresholds in Settings.</span>
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
}
