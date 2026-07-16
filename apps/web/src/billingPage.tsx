import { useQuery } from "@tanstack/react-query";

import { DeploymentPricingCard } from "./deploymentPricingCard";
import { ModelCatalogCard } from "./modelCatalogCard";
import { formatInteger, formatMoney } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { GlassCard, PageSkeleton, PageState, PageTitle, ProgressMeter } from "./ui";

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
  }
`);

export function BillingPage() {
  const { isLoading: queryIsLoading, error: queryError, data: queryData } = useQuery({ queryKey: ["billing-page"], queryFn: () => gqlFetch(BillingPageDocument) });

  if (queryIsLoading) return <PageSkeleton blocks={[150, 280]} />;
  if (queryError) return <PageState title="Billing" label={queryError.message} />;

  const overview = queryData?.overview;
  if (!overview) return <PageState title="Billing" label="No billing data" />;

  const comparison = Math.max(overview.cost.baseline, overview.cost.selected);
  const projected = overview.requestCount === 0 ? 0 : overview.cost.selected;
  return (
    <div className="page page-enter">
      <PageTitle title="Billing" subtitle="Spend and model pricing for Proxy Labs." />
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
      <DeploymentPricingCard />
      <ModelCatalogCard />
    </div>
  );
}
