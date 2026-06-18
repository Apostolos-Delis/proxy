import { graphql } from "./gql";
import type {
  RouteOutputViewQuery,
  UsageDashboardViewQuery,
  UsageLookupsQuery,
  UsageReportViewQuery,
  UsageTimeseriesViewQuery
} from "./gql/graphql";
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

const UsageDashboardViewDocument = graphql(`
  query UsageDashboardView($groupBy: UsageGroupBy!, $interval: UsageInterval, $start: String, $end: String, $limit: Int) {
    usageDashboard(groupBy: $groupBy, interval: $interval, start: $start, end: $end, limit: $limit) {
      usage {
        groupBy
        data {
          ...UsageGroupFields
        }
        totals {
          ...UsageGroupFields
        }
      }
      timeseries {
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

const RouteOutputViewDocument = graphql(`
  query RouteOutputView($start: String, $end: String) {
    routeOutputReport(start: $start, end: $end) {
      routes {
        route
        requests
        outputTokens
        reasoningTokens
        avgOutputTokens
        reasoningShare
        outputCost
      }
      models {
        key
        requests
        outputTokens
        reasoningTokens
        avgOutputTokens
        reasoningShare
        outputCost
      }
      users {
        key
        requests
        outputTokens
        reasoningTokens
        avgOutputTokens
        reasoningShare
        outputCost
      }
      apiKeys {
        key
        requests
        outputTokens
        reasoningTokens
        avgOutputTokens
        reasoningShare
        outputCost
      }
      workspaces {
        key
        requests
        outputTokens
        reasoningTokens
        avgOutputTokens
        reasoningShare
        outputCost
      }
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
export type RouteOutputReport = RouteOutputViewQuery["routeOutputReport"];
export type RouteOutputRow = RouteOutputReport["routes"][number];

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
export type UsageDashboard = {
  usage: UsageDashboardViewQuery["usageDashboard"]["usage"];
  timeseries: UsageTimeseries;
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
  return normalizeTimeseries(raw);
}

export async function fetchUsageDashboard(
  groupBy: UsageDimensionKey,
  filters: UsageRangeFilters & { interval?: "hour" | "day"; limit?: number } = {}
): Promise<UsageDashboard> {
  const raw = (await gqlFetch(UsageDashboardViewDocument, { groupBy, ...filters })).usageDashboard;
  return {
    usage: raw.usage,
    timeseries: normalizeTimeseries(raw.timeseries)
  };
}

function normalizeTimeseries(raw: RawTimeseries): UsageTimeseries {
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

export async function fetchRouteOutputReport(filters: UsageRangeFilters = {}) {
  return (await gqlFetch(RouteOutputViewDocument, filters)).routeOutputReport;
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
