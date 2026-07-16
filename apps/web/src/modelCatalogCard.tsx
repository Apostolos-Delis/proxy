import { useQuery } from "@tanstack/react-query";
import { LibraryBig } from "lucide-react";

import { catalogSource, deploymentPricing } from "./deploymentPricingCard";
import { formatInteger, formatMoney } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { GlassCard, StatusIndicator } from "./ui";

const ModelCatalogDocument = graphql(`
  query ModelCatalogCard {
    gatewayModelCatalogEntries {
      id
      provider
      upstreamModelId
      canonicalName
      canonicalKey
      region
      canonicalCapabilities
      pricing
      metadataSource
      pricingSource
      enabled
    }
  }
`);

export function ModelCatalogCard() {
  const { data, error, isLoading } = useQuery({
    queryKey: ["gateway-model-catalog"],
    queryFn: async () => (await gqlFetch(ModelCatalogDocument)).gatewayModelCatalogEntries
  });
  const entries = data ?? [];
  return (
    <GlassCard>
      <div className="card-head">
        <div>
          <div className="card-title"><LibraryBig />Provider model catalog</div>
          <div className="stat-sub">Sourced provider IDs, limits, and USD rates per million tokens.</div>
        </div>
      </div>
      {error ? <div className="action-error">{error.message}</div> : null}
      {isLoading ? <div className="empty compact-empty">Loading model catalog...</div> : null}
      {!isLoading && entries.length === 0 ? <div className="empty compact-empty">No catalog entries available.</div> : null}
      {entries.length > 0 ? (
        <table className="tbl pricing-tbl">
          <thead>
            <tr>
              <th>Model</th>
              <th>Provider</th>
              <th>Upstream ID</th>
              <th>Context</th>
              <th>Max output</th>
              <th>Input</th>
              <th>Output</th>
              <th>Sources</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const limits = modelLimits(entry.canonicalCapabilities);
              const pricing = deploymentPricing(entry.pricing);
              const metadataSource = catalogSource(entry.metadataSource);
              const pricingSource = catalogSource(entry.pricingSource);
              return (
                <tr key={entry.id}>
                  <td>
                    <div className="pricing-model">
                      <span>{entry.canonicalName}</span>
                      <span className="mono">{entry.canonicalKey}</span>
                    </div>
                  </td>
                  <td><span className="mono">{entry.provider}</span></td>
                  <td>
                    <div className="pricing-model">
                      <span className="mono">{entry.upstreamModelId}</span>
                      {entry.region ? <span className="faint">{entry.region}</span> : null}
                    </div>
                  </td>
                  <td className="mono">{formatTokens(limits.contextWindow)}</td>
                  <td className="mono">{formatTokens(limits.maxOutputTokens)}</td>
                  <td>{formatPrice(
                    pricing?.inputCostPerMtok,
                    pricing?.largeContext?.inputCostPerMtok,
                    pricing?.largeContext?.thresholdInputTokens
                  )}</td>
                  <td>{formatPrice(
                    pricing?.outputCostPerMtok,
                    pricing?.largeContext?.outputCostPerMtok,
                    pricing?.largeContext?.thresholdInputTokens
                  )}</td>
                  <td>
                    <div className="pricing-model catalog-source-cell">
                      {sourceCell("Metadata", metadataSource)}
                      {sourceCell("Pricing", pricingSource)}
                    </div>
                  </td>
                  <td><StatusIndicator status={entry.enabled ? "active" : "disabled"} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </GlassCard>
  );
}

function modelLimits(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const capabilities = value as Record<string, unknown>;
  return {
    ...(typeof capabilities.contextWindow === "number" ? { contextWindow: capabilities.contextWindow } : {}),
    ...(typeof capabilities.maxOutputTokens === "number" ? { maxOutputTokens: capabilities.maxOutputTokens } : {})
  };
}

function sourceCell(label: string, source: ReturnType<typeof catalogSource>) {
  if (!source) return <span className="catalog-unverified">{label}: Manual / unverified</span>;
  const sourceLabel = <span>{`${label}: ${source.type}`}</span>;
  return (
    <span>
      {source.locator.startsWith("http") ? <a href={source.locator} target="_blank" rel="noreferrer">{sourceLabel}</a> : sourceLabel}
      <span className={source.verifiedAt ? "catalog-verified" : "catalog-unverified"}>
        {source.verifiedAt ? "Verified" : "Unverified"}
      </span>
    </span>
  );
}

function formatTokens(value: number | undefined) {
  return value === undefined ? "Unknown" : formatInteger(value);
}

function formatPrice(value: number | undefined, largeContextValue?: number, thresholdInputTokens?: number) {
  if (value === undefined) return "Unpriced";
  return (
    <div className="pricing-rate">
      <span className="mono">{formatMoney(value)}</span>
      {largeContextValue !== undefined && thresholdInputTokens !== undefined ? (
        <span className="faint">{`>${formatInteger(thresholdInputTokens)}: ${formatMoney(largeContextValue)}`}</span>
      ) : null}
    </div>
  );
}
