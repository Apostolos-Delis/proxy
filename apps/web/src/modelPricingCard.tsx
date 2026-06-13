import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Plus } from "lucide-react";
import { useState } from "react";

import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import {
  PricingEditRow,
  PricingViewRow,
  pricingRowKey,
  type PricingInput,
  type PricingRow
} from "./modelPricingRows";
import { GlassCard } from "./ui";

const ModelPricingDocument = graphql(`
  query ModelPricingCard {
    modelPricing {
      model
      provider
      source
      seenInTraffic
      inputCostPerMtok
      outputCostPerMtok
      cacheReadCostPerMtok
      cacheWriteCostPerMtok
      updatedAt
    }
  }
`);

const SetModelPricingDocument = graphql(`
  mutation SetModelPricing($input: SetModelPricingInput!) {
    setModelPricing(input: $input) {
      model
      provider
      source
      seenInTraffic
      inputCostPerMtok
      outputCostPerMtok
      cacheReadCostPerMtok
      cacheWriteCostPerMtok
      updatedAt
    }
  }
`);

const ClearModelPricingDocument = graphql(`
  mutation ClearModelPricing($provider: String!, $model: String!) {
    clearModelPricing(provider: $provider, model: $model) {
      model
      provider
      source
      seenInTraffic
      inputCostPerMtok
      outputCostPerMtok
      cacheReadCostPerMtok
      cacheWriteCostPerMtok
      updatedAt
    }
  }
`);

const QUERY_KEY = ["model-pricing"];

export function ModelPricingCard() {
  const queryClient = useQueryClient();
  const { data: queryData, error: queryError, isLoading: queryIsLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await gqlFetch(ModelPricingDocument)).modelPricing
  });
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const closeEditors = (rows: PricingRow[]) => {
    queryClient.setQueryData(QUERY_KEY, rows);
    setEditingKey(null);
    setAdding(false);
  };
  const setPricing = useMutation({
    mutationFn: async (input: PricingInput) =>
      (await gqlFetch(SetModelPricingDocument, { input })).setModelPricing,
    onSuccess: (rows: PricingRow[]) => {
      clearPricing.reset();
      closeEditors(rows);
    }
  });
  const clearPricing = useMutation({
    mutationFn: async (target: { provider: string; model: string }) =>
      (await gqlFetch(ClearModelPricingDocument, target)).clearModelPricing,
    onSuccess: (rows: PricingRow[]) => {
      setPricing.reset();
      closeEditors(rows);
    }
  });
  const mutationError = setPricing.error ?? clearPricing.error;
  const rows = queryData ?? [];

  return (
    <GlassCard>
      <div className="card-head">
        <div>
          <div className="card-title"><Coins />Model pricing</div>
          <div className="stat-sub">USD per million tokens. These rates produce every spend and savings number on this console.</div>
        </div>
        <button className="btn" type="button" disabled={adding} onClick={() => setAdding(true)}>
          <Plus />Price a model
        </button>
      </div>
      {queryError ? <div className="action-error">{queryError.message}</div> : null}
      {mutationError ? <div className="action-error">{mutationError.message}</div> : null}
      {queryIsLoading ? <div className="empty compact-empty">Loading model pricing…</div> : null}
      {!queryIsLoading && rows.length === 0 && !adding
        ? <div className="empty compact-empty">No models to price yet — defaults appear once the proxy is configured.</div>
        : null}
      {rows.length > 0 || adding ? (
        <table className="tbl pricing-tbl">
          <thead>
            <tr>
              <th>Model</th>
              <th>Input</th>
              <th>Cache read</th>
              <th>Cache write</th>
              <th>Output</th>
              <th>Source</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {adding ? (
              <PricingEditRow
                saving={setPricing.isPending}
                onCancel={() => setAdding(false)}
                onSave={(input) => setPricing.mutate(input)}
              />
            ) : null}
            {rows.map((row) => {
              const key = pricingRowKey(row);
              if (editingKey === key) {
                return (
                  <PricingEditRow
                    key={key}
                    row={row}
                    saving={setPricing.isPending}
                    onCancel={() => setEditingKey(null)}
                    onSave={(input) => setPricing.mutate(input)}
                  />
                );
              }
              const provider = row.provider;
              return (
                <PricingViewRow
                  key={key}
                  row={row}
                  reverting={clearPricing.isPending}
                  onEdit={() => {
                    setAdding(false);
                    setEditingKey(key);
                  }}
                  onRevert={row.source === "custom" && provider
                    ? () => clearPricing.mutate({ provider, model: row.model })
                    : undefined}
                />
              );
            })}
          </tbody>
        </table>
      ) : null}
    </GlassCard>
  );
}
