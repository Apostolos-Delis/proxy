import { useQuery } from "@tanstack/react-query";
import { Coins } from "lucide-react";

import { compactId, formatInteger, formatMoney } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { GlassCard, StatusIndicator } from "./ui";

const DeploymentPricingDocument = graphql(`
  query DeploymentPricingCard {
    gatewayModelDeployments {
      id
      name
      provider
      upstreamModelId
      providerConnectionId
      pricing
      catalogMetadataSource
      catalogPricingSource
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
              <th>Provider</th>
              <th>Input</th>
              <th>Cache read</th>
              <th>Cache write</th>
              <th>Output</th>
              <th>Catalog sources</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((deployment) => {
              const pricing = deploymentPricing(deployment.pricing);
              const metadataSource = catalogSource(deployment.catalogMetadataSource);
              const pricingSource = catalogSource(deployment.catalogPricingSource);
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
                  <td><span className="mono">{deployment.provider}</span></td>
                  <td>{formatRate(pricing?.inputCostPerMtok, pricing?.largeContext?.inputCostPerMtok, pricing?.largeContext?.thresholdInputTokens)}</td>
                  <td>{formatRate(pricing?.cacheReadCostPerMtok, pricing?.largeContext?.cacheReadCostPerMtok, pricing?.largeContext?.thresholdInputTokens)}</td>
                  <td>{formatRate(pricing?.cacheWriteCostPerMtok, pricing?.largeContext?.cacheWriteCostPerMtok, pricing?.largeContext?.thresholdInputTokens)}</td>
                  <td>{formatRate(pricing?.outputCostPerMtok, pricing?.largeContext?.outputCostPerMtok, pricing?.largeContext?.thresholdInputTokens)}</td>
                  <td>
                    <div className="pricing-model catalog-sources">
                      <CatalogSource label="Pricing" source={pricingSource} />
                      <CatalogSource label="Metadata" source={metadataSource} />
                    </div>
                  </td>
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
  largeContext?: {
    thresholdInputTokens: number;
    inputCostPerMtok: number;
    outputCostPerMtok: number;
    cacheReadCostPerMtok?: number;
    cacheWriteCostPerMtok?: number;
  };
};

export type CatalogSourceValue = {
  type: string;
  locator: string;
  verifiedAt?: string;
};

export function deploymentPricing(value: unknown): DeploymentPricing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pricing = value as Record<string, unknown>;
  if (!isRate(pricing.inputCostPerMtok) || !isRate(pricing.outputCostPerMtok)) return null;
  if (pricing.cacheReadCostPerMtok !== undefined && !isRate(pricing.cacheReadCostPerMtok)) return null;
  if (pricing.cacheWriteCostPerMtok !== undefined && !isRate(pricing.cacheWriteCostPerMtok)) return null;
  const largeContext = deploymentPricingTier(pricing.largeContext);
  if (pricing.largeContext !== undefined && !largeContext) return null;
  return {
    inputCostPerMtok: pricing.inputCostPerMtok,
    outputCostPerMtok: pricing.outputCostPerMtok,
    ...(typeof pricing.cacheReadCostPerMtok === "number" ? { cacheReadCostPerMtok: pricing.cacheReadCostPerMtok } : {}),
    ...(typeof pricing.cacheWriteCostPerMtok === "number" ? { cacheWriteCostPerMtok: pricing.cacheWriteCostPerMtok } : {}),
    ...(largeContext ? { largeContext } : {})
  };
}

function deploymentPricingTier(value: unknown): DeploymentPricing["largeContext"] | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pricing = value as Record<string, unknown>;
  if (!Number.isInteger(pricing.thresholdInputTokens) || !isRate(pricing.inputCostPerMtok) || !isRate(pricing.outputCostPerMtok)) return null;
  if (pricing.cacheReadCostPerMtok !== undefined && !isRate(pricing.cacheReadCostPerMtok)) return null;
  if (pricing.cacheWriteCostPerMtok !== undefined && !isRate(pricing.cacheWriteCostPerMtok)) return null;
  return {
    thresholdInputTokens: pricing.thresholdInputTokens as number,
    inputCostPerMtok: pricing.inputCostPerMtok,
    outputCostPerMtok: pricing.outputCostPerMtok,
    ...(typeof pricing.cacheReadCostPerMtok === "number" ? { cacheReadCostPerMtok: pricing.cacheReadCostPerMtok } : {}),
    ...(typeof pricing.cacheWriteCostPerMtok === "number" ? { cacheWriteCostPerMtok: pricing.cacheWriteCostPerMtok } : {})
  };
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function catalogSource(value: unknown): CatalogSourceValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.type !== "string" || typeof source.locator !== "string") return null;
  return {
    type: source.type,
    locator: source.locator,
    ...(typeof source.verifiedAt === "string" ? { verifiedAt: source.verifiedAt } : {})
  };
}

function CatalogSource({ label, source }: { label: string; source: CatalogSourceValue | null }) {
  if (!source) return <span className="faint">{label}: Manual / unverified</span>;
  const sourceLabel = `${label}: ${source.type}`;
  return (
    <span>
      {source.locator.startsWith("http") ? (
        <a href={source.locator} target="_blank" rel="noreferrer">{sourceLabel}</a>
      ) : sourceLabel}
      <span className={source.verifiedAt ? "catalog-verified" : "catalog-unverified"}>
        {source.verifiedAt ? "Verified" : "Unverified"}
      </span>
    </span>
  );
}

function formatRate(value: number | undefined, largeContextValue?: number, thresholdInputTokens?: number) {
  if (value === undefined) return <span className="faint">Unpriced</span>;
  return (
    <div className="pricing-rate">
      <span className="mono">{formatMoney(value)}</span>
      {largeContextValue !== undefined && thresholdInputTokens !== undefined ? (
        <span className="faint">{`>${formatInteger(thresholdInputTokens)}: ${formatMoney(largeContextValue)}`}</span>
      ) : null}
    </div>
  );
}
