import { graphql } from "./gql";
import type {
  UsageCostDashboardViewQuery,
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

graphql(`
  fragment UsageGroupCostFields on UsageGroup {
    key
    requestCount
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

graphql(`
  fragment UsageGroupDashboardFields on UsageGroup {
    key
    requestCount
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
    }
  }
`);

graphql(`
  fragment UsageGroupChartFields on UsageGroup {
    key
    requestCount
    usage {
      inputTokens
      cachedInputTokens
      totalTokens
    }
    cost {
      selected
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
          ...UsageGroupDashboardFields
        }
        totals {
          ...UsageGroupDashboardFields
        }
      }
      timeseries {
        groupBy
        interval
        start
        end
        groups {
          ...UsageGroupChartFields
        }
        points {
          ts
          totals {
            ...UsageGroupChartFields
          }
          groups
        }
      }
    }
  }
`);

const UsageCostDashboardViewDocument = graphql(`
  query UsageCostDashboardView($groupBy: UsageGroupBy!, $interval: UsageInterval, $start: String, $end: String, $limit: Int) {
    usageDashboard(groupBy: $groupBy, interval: $interval, start: $start, end: $end, limit: $limit) {
      usage {
        groupBy
        data {
          ...UsageGroupCostFields
        }
        totals {
          ...UsageGroupCostFields
        }
      }
      timeseries {
        groupBy
        interval
        start
        end
        groups {
          ...UsageGroupChartFields
        }
        points {
          ts
          totals {
            ...UsageGroupChartFields
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

const UnpricedDeploymentsDocument = graphql(`
  query UnpricedDeployments {
    usage(groupBy: deployment) {
      data {
        key
        requestCount
      }
    }
    gatewayModelDeployments {
      id
      upstreamModelId
      providerConnectionId
      pricing
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
type RawDashboardUsage = UsageDashboardViewQuery["usageDashboard"]["usage"];
type RawDashboardGroup = RawDashboardUsage["totals"];
type RawCostDashboardUsage = UsageCostDashboardViewQuery["usageDashboard"]["usage"];
type RawCostDashboardGroup = RawCostDashboardUsage["totals"];
export type UsageChartGroup = Pick<UsageGroup, "key" | "requestCount"> & {
  usage: Pick<UsageGroup["usage"], "inputTokens" | "cachedInputTokens" | "totalTokens">;
  cost: Pick<UsageGroup["cost"], "selected">;
};
type RawTimeseriesLike = Pick<RawTimeseries, "groupBy" | "interval" | "start" | "end"> & {
  groups: UsageChartGroup[];
  points: Array<{
    ts: string;
    totals: UsageChartGroup;
    groups: unknown;
  }>;
};
export type UsageTimeseriesPoint = {
  ts: string;
  totals: UsageChartGroup;
  groups: Record<string, UsageGroup>;
};
export type UsageTimeseries = Omit<RawTimeseries, "groups" | "points"> & {
  groups: UsageChartGroup[];
  points: UsageTimeseriesPoint[];
};
export type UsageDashboard = {
  usage: UsageResponse;
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
    usage: normalizeDashboardUsage(raw.usage),
    timeseries: normalizeTimeseries(raw.timeseries)
  };
}

export async function fetchUsageDashboardWithBaseline(
  groupBy: UsageDimensionKey,
  filters: UsageRangeFilters & { interval?: "hour" | "day"; limit?: number } = {}
): Promise<UsageDashboard> {
  const raw = (await gqlFetch(UsageCostDashboardViewDocument, { groupBy, ...filters })).usageDashboard;
  return {
    usage: normalizeCostDashboardUsage(raw.usage),
    timeseries: normalizeTimeseries(raw.timeseries)
  };
}

function normalizeDashboardUsage(raw: RawDashboardUsage): UsageResponse {
  return {
    ...raw,
    data: raw.data.map(normalizeDashboardGroup),
    totals: normalizeDashboardGroup(raw.totals)
  };
}

function normalizeDashboardGroup(raw: RawDashboardGroup): UsageGroup {
  return {
    ...raw,
    failedRequests: 0,
    retriedRequests: 0,
    failureRate: 0,
    retryRate: 0,
    latency: { averageMs: null, p95Ms: null },
    cost: { ...raw.cost, baseline: 0, savings: 0, classifier: 0 }
  };
}

function normalizeCostDashboardUsage(raw: RawCostDashboardUsage): UsageResponse {
  return {
    ...raw,
    data: raw.data.map(normalizeCostDashboardGroup),
    totals: normalizeCostDashboardGroup(raw.totals)
  };
}

function normalizeCostDashboardGroup(raw: RawCostDashboardGroup): UsageGroup {
  return {
    ...raw,
    failedRequests: 0,
    retriedRequests: 0,
    failureRate: 0,
    retryRate: 0,
    latency: { averageMs: null, p95Ms: null }
  };
}

function normalizeTimeseries(raw: RawTimeseriesLike): UsageTimeseries {
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

export type UnpricedModel = {
  deploymentId: string;
  model: string;
  providerConnectionId: string | null;
};

// Models that carried traffic but have no rate, so their spend books as $0 and
// silently understates total cost. The "unknown" attempt model can never be
// priced, so it always belongs here when present.
export async function fetchUnpricedModels(): Promise<UnpricedModel[]> {
  const data = await gqlFetch(UnpricedDeploymentsDocument);
  const deployments = new Map(data.gatewayModelDeployments.map((deployment) => [deployment.id, deployment]));
  return data.usage.data.flatMap((group): UnpricedModel[] => {
    if (group.requestCount <= 0) return [];
    const deployment = deployments.get(group.key);
    if (!deployment) {
      return [{ deploymentId: group.key, model: "unknown", providerConnectionId: null }];
    }
    const pricing = deployment.pricing;
    const priced = pricing && typeof pricing === "object" && !Array.isArray(pricing) &&
      typeof (pricing as Record<string, unknown>).inputCostPerMtok === "number" &&
      typeof (pricing as Record<string, unknown>).outputCostPerMtok === "number";
    if (priced) return [];
    return [{
      deploymentId: deployment.id,
      model: deployment.upstreamModelId,
      providerConnectionId: deployment.providerConnectionId
    }];
  });
}
