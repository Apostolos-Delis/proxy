import { graphql } from "./gql";
import type {
  CacheBustsViewQuery,
  CompressionSavingsViewQuery,
  CachePricingRatesQuery,
  IdleGapsViewQuery,
  PromptCachePlansViewQuery,
  TokenAttributionViewQuery
} from "./gql/graphql";
import { gqlFetch } from "./graphql";
import type { UsageGroup, UsageRangeFilters } from "./usageData";

const TokenAttributionViewDocument = graphql(`
  query TokenAttributionView($start: String, $end: String) {
    tokenAttribution(start: $start, end: $end) {
      requestCount
      sampled
      buckets {
        key
        chars
        estimatedTokens
      }
      toolSchemas {
        name
        chars
        estimatedTokens
        blocks
      }
      toolResults {
        name
        chars
        estimatedTokens
        blocks
      }
      schemaChurn {
        name
        estimatedTokens
        requests
        sessions
        schemaHashes
        churningSessions
        status
      }
    }
  }
`);

const IdleGapsViewDocument = graphql(`
  query IdleGapsView($start: String, $end: String) {
    idleGaps(start: $start, end: $end) {
      buckets {
        key
        label
        count
      }
      totalGaps
      overTtl
      recoverableByOneHourTtl
      estimatedRecoverableCacheReadTokens
      recommendationThresholdTokens
      recommendedTtlUpgrade
      sessionsScanned
      sampledRequests
      sampleWindowStart
      sampleWindowEnd
      sampled
    }
  }
`);

const CacheBustsViewDocument = graphql(`
  query CacheBustsView($start: String, $end: String) {
    cacheBusts(start: $start, end: $end) {
      busts {
        sessionId
        requestId
        at
        cause
        droppedCacheReadTokens
        rebuiltTokens
        model
        gapMs
      }
      countsByCause
      sessionsScanned
      sampled
    }
  }
`);

const CompressionSavingsViewDocument = graphql(`
  query CompressionSavingsView($start: String, $end: String) {
    compressionSavings(start: $start, end: $end) {
      eventCount
      sampled
      blocks
      savedChars
      savedEstimatedTokens
      rows {
        rule
        ruleVersion
        tool
        blocks
        savedChars
        savedEstimatedTokens
      }
    }
  }
`);

const PromptCachePlansViewDocument = graphql(`
  query PromptCachePlansView($start: String, $end: String) {
    promptCachePlans(start: $start, end: $end) {
      totalPlans
      sampled
      plans {
        provider
        model
        mode
        count
        appliedControls
        skippedControls
      }
      controls {
        provider
        model
        mode
        control
        status
        reason
        count
      }
    }
  }
`);

const CachePricingRatesDocument = graphql(`
  query CachePricingRates {
    modelPricing {
      model
      inputCostPerMtok
      cacheReadCostPerMtok
      cacheWriteCostPerMtok
    }
  }
`);

export type TokenAttributionReport = TokenAttributionViewQuery["tokenAttribution"];
export type TokenAttributionOffender = TokenAttributionReport["toolSchemas"][number];
export type TokenAttributionSchemaChurn = TokenAttributionReport["schemaChurn"][number];
export type CacheBustReport = CacheBustsViewQuery["cacheBusts"];
export type CacheBust = CacheBustReport["busts"][number];
export type CompressionSavingsReport = CompressionSavingsViewQuery["compressionSavings"];
export type CompressionSavingsRow = CompressionSavingsReport["rows"][number];
export type PromptCachePlanReport = PromptCachePlansViewQuery["promptCachePlans"];
export type PromptCachePlanControl = PromptCachePlanReport["controls"][number];
export type CachePricingRate = CachePricingRatesQuery["modelPricing"][number];

export async function fetchTokenAttribution(filters: UsageRangeFilters = {}) {
  return (await gqlFetch(TokenAttributionViewDocument, { ...filters })).tokenAttribution;
}

export async function fetchCacheBusts(filters: UsageRangeFilters = {}) {
  return (await gqlFetch(CacheBustsViewDocument, { ...filters })).cacheBusts;
}

export async function fetchCompressionSavings(filters: UsageRangeFilters = {}) {
  return (await gqlFetch(CompressionSavingsViewDocument, { ...filters })).compressionSavings;
}

export async function fetchPromptCachePlans(filters: UsageRangeFilters = {}) {
  return (await gqlFetch(PromptCachePlansViewDocument, { ...filters })).promptCachePlans;
}

export function promptCacheControlRows(report: PromptCachePlanReport | undefined, limit = 8) {
  if (!report) return [];
  return [...report.controls]
    .sort((left, right) => right.count - left.count || promptCacheControlKey(left).localeCompare(promptCacheControlKey(right)))
    .slice(0, limit);
}

function promptCacheControlKey(row: PromptCachePlanControl) {
  return `${row.provider}:${row.model}:${row.mode}:${row.control}:${row.status}:${row.reason}`;
}

export type IdleGapReport = IdleGapsViewQuery["idleGaps"];

export async function fetchIdleGaps(filters: UsageRangeFilters = {}) {
  return (await gqlFetch(IdleGapsViewDocument, { ...filters })).idleGaps;
}

export async function fetchCachePricingRates() {
  return (await gqlFetch(CachePricingRatesDocument)).modelPricing;
}

export const bustCauseLabels: Record<string, string> = {
  ttl_expiry: "TTL expiry",
  model_switch: "Model switch",
  provider_switch: "Provider switch",
  unknown: "Unknown"
};

// Cool analogous palette per the design; unknown stays neutral slate so an
// unclassified bust never reads as a categorized one.
export const bustCauses = [
  { key: "ttl_expiry", label: bustCauseLabels.ttl_expiry, color: "#14b8a6" },
  { key: "model_switch", label: bustCauseLabels.model_switch, color: "#38bdf8" },
  { key: "provider_switch", label: bustCauseLabels.provider_switch, color: "#34d399" },
  { key: "unknown", label: bustCauseLabels.unknown, color: "#64748b" }
] as const;

export type ModelBustRow = {
  model: string;
  busts: number;
  droppedTokens: number;
  tokensByCause: Record<string, number>;
};

/** Busts rolled up per model, largest token loss first — the miss table rows. */
export function bustsByModel(busts: Pick<CacheBust, "model" | "cause" | "droppedCacheReadTokens">[]): ModelBustRow[] {
  const byModel = new Map<string, ModelBustRow>();
  for (const bust of busts) {
    const row = byModel.get(bust.model) ?? { model: bust.model, busts: 0, droppedTokens: 0, tokensByCause: {} };
    row.busts += 1;
    row.droppedTokens += bust.droppedCacheReadTokens;
    row.tokensByCause[bust.cause] = (row.tokensByCause[bust.cause] ?? 0) + bust.droppedCacheReadTokens;
    byModel.set(bust.model, row);
  }
  return [...byModel.values()].sort((left, right) => right.droppedTokens - left.droppedTokens);
}

export type CacheSavings = {
  gross: number;
  writePremium: number;
  net: number;
  unpricedCachedTokens: number;
};

// Fallback multipliers when a priced model has no explicit cache rates,
// mirroring the server-side defaults in pricing.ts (0.1x read / 1.25x write).
const DEFAULT_READ_MULTIPLIER = 0.1;
const DEFAULT_WRITE_MULTIPLIER = 1.25;

/**
 * What caching saved versus paying full input price for every prompt token:
 * gross = reads billed at the read rate instead of the input rate, premium =
 * the surcharge writes carry over the input rate. Models without a priced
 * input rate cannot be valued; their cached reads are reported so the card
 * can disclose the gap instead of silently booking $0.
 */
export function cacheSavings(
  modelGroups: Pick<UsageGroup, "key" | "usage">[],
  rates: Pick<CachePricingRate, "model" | "inputCostPerMtok" | "cacheReadCostPerMtok" | "cacheWriteCostPerMtok">[]
): CacheSavings {
  const ratesByModel = new Map(rates.map((rate) => [rate.model, rate]));
  let gross = 0;
  let writePremium = 0;
  let unpricedCachedTokens = 0;
  for (const group of modelGroups) {
    const { cachedInputTokens, cacheCreationInputTokens } = group.usage;
    const rate = ratesByModel.get(group.key);
    if (rate?.inputCostPerMtok === null || rate?.inputCostPerMtok === undefined) {
      unpricedCachedTokens += cachedInputTokens;
      continue;
    }
    const inputRate = rate.inputCostPerMtok;
    const readRate = rate.cacheReadCostPerMtok ?? inputRate * DEFAULT_READ_MULTIPLIER;
    const writeRate = rate.cacheWriteCostPerMtok ?? inputRate * DEFAULT_WRITE_MULTIPLIER;
    gross += (cachedInputTokens * (inputRate - readRate)) / 1_000_000;
    writePremium += (cacheCreationInputTokens * (writeRate - inputRate)) / 1_000_000;
  }
  return { gross, writePremium, net: gross - writePremium, unpricedCachedTokens };
}

export const bucketLabels: Record<string, string> = {
  systemPrompt: "System prompt",
  orgSystemPrompt: "Org prompt (injected)",
  toolSchemas: "Tool schemas",
  history: "Replayed history",
  newToolResults: "New tool results",
  latestUser: "User messages"
};
