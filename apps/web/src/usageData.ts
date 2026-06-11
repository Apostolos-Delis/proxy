import { graphql } from "./gql";
import type { UsageLookupsQuery, UsageReportViewQuery, UsageTimeseriesViewQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";

graphql(`
  fragment UsageGroupFields on UsageGroup {
    key
    requestCount
    failedRequests
    retriedRequests
    failureRate
    retryRate
    latency {
      averageMs
      p95Ms
    }
    usage {
      inputTokens
      cachedInputTokens
      cacheCreationInputTokens
      outputTokens
      reasoningTokens
      totalTokens
    }
    cost {
      selected
      baseline
      savings
      classifier
    }
  }
`);

const UsageReportViewDocument = graphql(`
  query UsageReportView($groupBy: UsageGroupBy!, $start: String, $end: String) {
    usage(groupBy: $groupBy, start: $start, end: $end) {
      groupBy
      data {
        ...UsageGroupFields
      }
      totals {
        ...UsageGroupFields
      }
    }
  }
`);

const UsageTimeseriesViewDocument = graphql(`
  query UsageTimeseriesView($groupBy: UsageGroupBy!, $interval: UsageInterval, $start: String, $end: String, $limit: Int) {
    usageTimeseries(groupBy: $groupBy, interval: $interval, start: $start, end: $end, limit: $limit) {
      groupBy
      interval
      start
      end
      groups {
        ...UsageGroupFields
      }
      points {
        ts
        totals {
          ...UsageGroupFields
        }
        groups
      }
    }
  }
`);

const UsageLookupsDocument = graphql(`
  query UsageLookups {
    members {
      userId
      name
      email
    }
    apiKeys {
      id
      name
      revokedAt
    }
  }
`);

const UnpricedModelsDocument = graphql(`
  query UnpricedModels {
    modelPricing {
      model
      provider
      source
      seenInTraffic
    }
  }
`);

export type UsageResponse = UsageReportViewQuery["usage"];
export type UsageGroup = UsageResponse["totals"];
export type UsageLookupUser = UsageLookupsQuery["members"][number];
export type UsageLookupApiKey = UsageLookupsQuery["apiKeys"][number];

export type UsageRangeFilters = {
  start?: string;
  end?: string;
};

type RawTimeseries = UsageTimeseriesViewQuery["usageTimeseries"];
export type UsageTimeseriesPoint = Omit<RawTimeseries["points"][number], "groups"> & {
  groups: Record<string, UsageGroup>;
};
export type UsageTimeseries = Omit<RawTimeseries, "points"> & {
  points: UsageTimeseriesPoint[];
};

export type UsageDimensionKey = UsageResponse["groupBy"];

export async function fetchUsageReport(groupBy: UsageDimensionKey, filters: UsageRangeFilters = {}) {
  return (await gqlFetch(UsageReportViewDocument, { groupBy, ...filters })).usage;
}

export async function fetchUsageTimeseries(
  groupBy: UsageDimensionKey,
  filters: UsageRangeFilters & { interval?: "hour" | "day"; limit?: number } = {}
): Promise<UsageTimeseries> {
  const raw = (await gqlFetch(UsageTimeseriesViewDocument, { groupBy, ...filters })).usageTimeseries;
  // Per-point group maps travel as a JSON scalar; narrow them once here.
  return {
    ...raw,
    points: raw.points.map((point) => ({
      ...point,
      groups: (point.groups ?? {}) as Record<string, UsageGroup>
    }))
  };
}

export async function fetchUsageLookups() {
  return gqlFetch(UsageLookupsDocument);
}

export type UnpricedModel = { model: string; provider: string | null };

// Models that carried traffic but have no rate, so their spend books as $0 and
// silently understates total cost. The "unknown" attempt model can never be
// priced, so it always belongs here when present.
export async function fetchUnpricedModels(): Promise<UnpricedModel[]> {
  const rows = (await gqlFetch(UnpricedModelsDocument)).modelPricing;
  return rows
    .filter((row) => row.seenInTraffic && (row.source === "unpriced" || row.model === "unknown"))
    .map((row) => ({ model: row.model, provider: row.provider ?? null }));
}
