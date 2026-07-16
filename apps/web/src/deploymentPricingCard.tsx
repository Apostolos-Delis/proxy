import { useQuery } from "@tanstack/react-query";
import { Coins } from "lucide-react";

import { compactId, formatMoney } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { GlassCard, StatusIndicator } from "./ui";

const DeploymentPricingDocument = graphql(`
  query DeploymentPricingCard {
    gatewayModelDeployments {
      id
      name
      upstreamModelId
      providerConnectionId
      pricing
      enabled
    }
  }
`);

export function DeploymentPricingCard() {
  const { data, error, isLoading } = useQuery({
    queryKey: ["gateway-deployment-pricing"],
    queryFn: async () => (await gqlFetch(DeploymentPricingDocument)).gatewayModelDeployments
  });
  const deployments = data ?? [];
  return (
    <GlassCard>
      <div className="card-head">
        <div>
          <div className="card-title"><Coins />Deployment pricing</div>
          <div className="stat-sub">USD per million tokens from each physical model deployment.</div>
        </div>
      </div>
      {error ? <div className="action-error">{error.message}</div> : null}
      {isLoading ? <div className="empty compact-empty">Loading deployment pricing...</div> : null}
      {!isLoading && deployments.length === 0 ? <div className="empty compact-empty">No model deployments configured.</div> : null}
      {deployments.length > 0 ? (
        <table className="tbl pricing-tbl">
          <thead>
            <tr>
              <th>Deployment</th>
              <th>Input</th>
              <th>Cache read</th>
              <th>Cache write</th>
              <th>Output</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((deployment) => {
              const pricing = deploymentPricing(deployment.pricing);
              return (
                <tr key={deployment.id}>
                  <td>
                    <div className="pricing-model">
                      <span>{deployment.name}</span>
                      <span className="mono">{deployment.upstreamModelId}</span>
                      <span className="faint" title={deployment.providerConnectionId}>
                        Connection {compactId(deployment.providerConnectionId, 10)}
                      </span>
                    </div>
                  </td>
                  <td>{formatRate(pricing?.inputCostPerMtok)}</td>
                  <td>{formatRate(pricing?.cacheReadCostPerMtok)}</td>
                  <td>{formatRate(pricing?.cacheWriteCostPerMtok)}</td>
                  <td>{formatRate(pricing?.outputCostPerMtok)}</td>
                  <td><StatusIndicator status={deployment.enabled ? "active" : "disabled"} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </GlassCard>
  );
}

type DeploymentPricing = {
  inputCostPerMtok: number;
  outputCostPerMtok: number;
  cacheReadCostPerMtok?: number;
  cacheWriteCostPerMtok?: number;
};

export function deploymentPricing(value: unknown): DeploymentPricing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pricing = value as Record<string, unknown>;
  if (!isRate(pricing.inputCostPerMtok) || !isRate(pricing.outputCostPerMtok)) return null;
  if (pricing.cacheReadCostPerMtok !== undefined && !isRate(pricing.cacheReadCostPerMtok)) return null;
  if (pricing.cacheWriteCostPerMtok !== undefined && !isRate(pricing.cacheWriteCostPerMtok)) return null;
  return {
    inputCostPerMtok: pricing.inputCostPerMtok,
    outputCostPerMtok: pricing.outputCostPerMtok,
    ...(typeof pricing.cacheReadCostPerMtok === "number" ? { cacheReadCostPerMtok: pricing.cacheReadCostPerMtok } : {}),
    ...(typeof pricing.cacheWriteCostPerMtok === "number" ? { cacheWriteCostPerMtok: pricing.cacheWriteCostPerMtok } : {})
  };
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatRate(value: number | undefined) {
  if (value === undefined) return <span className="faint">Unpriced</span>;
  return <span className="mono">{formatMoney(value)}</span>;
}
