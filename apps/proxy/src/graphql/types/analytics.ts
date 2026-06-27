import { builder } from "../builder.js";
import type {
  ActiveSessionCountModel,
  CacheBustModel,
  CacheBustReportModel,
  CompressionSavingsReportModel,
  CompressionSavingsRowModel,
  IdleGapBucketModel,
  IdleGapReportModel,
  LatencySummaryModel,
  OpenAICacheAggregateModel,
  OpenAICacheAnalyticsModel,
  OpenAICacheGroupModel,
  OpenAICacheTrendModel,
  OverviewDashboardShape,
  RouteOutputGroupRowModel,
  RouteOutputReportModel,
  RouteOutputRowModel,
  OverviewModel,
  PromptCachePlanControlRowModel,
  PromptCachePlanReportModel,
  PromptCachePlanRowModel,
  PromptCachePrewarmJobRowModel,
  PromptCachePrewarmReportModel,
  RouteQualityModel,
  TokenAttributionBucketModel,
  TokenAttributionOffenderModel,
  TokenAttributionReportModel,
  TokenAttributionSchemaChurnModel,
  UsageDashboardModel,
  UsageGroupModel,
  UsageReportModel,
  UsageTimeseriesModel,
  UsageTimeseriesPointModel
} from "../models.js";
import { CostTotals, TokenTotals } from "./core.js";
import { RequestSummary } from "./requests.js";

export const UsageGroupBy = builder.enumType("UsageGroupBy", {
  values: ["user", "api_key", "provider", "model", "model_effort", "route", "surface", "session"] as const
});

export const UsageInterval = builder.enumType("UsageInterval", {
  values: ["hour", "day"] as const
});

export const LatencySummary = builder.objectRef<LatencySummaryModel>("LatencySummary").implement({
  fields: (t) => ({
    averageMs: t.exposeInt("averageMs", { nullable: true }),
    p95Ms: t.exposeInt("p95Ms", { nullable: true })
  })
});

export const RouteQuality = builder.objectRef<RouteQualityModel>("RouteQuality").implement({
  fields: (t) => ({
    lowConfidenceCount: t.exposeInt("lowConfidenceCount"),
    cheaperLikelyWouldWorkCount: t.exposeInt("cheaperLikelyWouldWorkCount"),
    cheapCausedRetriesOrRepairsCount: t.exposeInt("cheapCausedRetriesOrRepairsCount")
  })
});

export const Overview = builder.objectRef<OverviewModel>("Overview").implement({
  fields: (t) => ({
    organizationId: t.exposeString("organizationId"),
    eventCount: t.exposeFloat("eventCount"),
    requestCount: t.exposeFloat("requestCount"),
    totals: t.expose("totals", { type: TokenTotals }),
    cost: t.expose("cost", { type: CostTotals }),
    routeQuality: t.expose("routeQuality", { type: RouteQuality })
  })
});

export const UsageGroup = builder.objectRef<UsageGroupModel>("UsageGroup").implement({
  fields: (t) => ({
    key: t.exposeString("key"),
    requestCount: t.exposeFloat("requestCount"),
    failedRequests: t.exposeFloat("failedRequests"),
    retriedRequests: t.exposeFloat("retriedRequests"),
    failureRate: t.exposeFloat("failureRate"),
    retryRate: t.exposeFloat("retryRate"),
    latency: t.expose("latency", { type: LatencySummary }),
    usage: t.expose("usage", { type: TokenTotals }),
    cost: t.expose("cost", { type: CostTotals })
  })
});

export const UsageTimeseriesPoint = builder
  .objectRef<UsageTimeseriesPointModel>("UsageTimeseriesPoint")
  .implement({
    fields: (t) => ({
      ts: t.exposeString("ts"),
      totals: t.expose("totals", { type: UsageGroup }),
      groups: t.field({ type: "JSON", resolve: (point) => point.groups })
    })
  });

export const UsageTimeseries = builder
  .objectRef<UsageTimeseriesModel>("UsageTimeseries")
  .implement({
    fields: (t) => ({
      groupBy: t.field({ type: UsageGroupBy, resolve: (series) => series.groupBy }),
      interval: t.field({ type: UsageInterval, resolve: (series) => series.interval }),
      start: t.exposeString("start"),
      end: t.exposeString("end"),
      groups: t.expose("groups", { type: [UsageGroup] }),
      points: t.expose("points", { type: [UsageTimeseriesPoint] })
    })
  });

export const UsageReport = builder.objectRef<UsageReportModel>("UsageReport").implement({
  fields: (t) => ({
    groupBy: t.field({ type: UsageGroupBy, resolve: (report) => report.groupBy }),
    data: t.expose("data", { type: [UsageGroup] }),
    totals: t.expose("totals", { type: UsageGroup })
  })
});

export const OverviewDashboard = builder.objectRef<OverviewDashboardShape>("OverviewDashboard").implement({
  fields: (t) => ({
    overview: t.expose("overview", { type: Overview }),
    requests: t.expose("requests", { type: [RequestSummary] }),
    modelUsage: t.expose("modelUsage", { type: UsageReport })
  })
});

export const UsageDashboard = builder.objectRef<UsageDashboardModel>("UsageDashboard").implement({
  fields: (t) => ({
    usage: t.expose("usage", { type: UsageReport }),
    timeseries: t.expose("timeseries", { type: UsageTimeseries })
  })
});

export const TokenAttributionBucket = builder
  .objectRef<TokenAttributionBucketModel>("TokenAttributionBucket")
  .implement({
    fields: (t) => ({
      key: t.exposeString("key"),
      chars: t.exposeFloat("chars"),
      estimatedTokens: t.exposeFloat("estimatedTokens")
    })
  });

export const TokenAttributionOffender = builder
  .objectRef<TokenAttributionOffenderModel>("TokenAttributionOffender")
  .implement({
    fields: (t) => ({
      name: t.exposeString("name"),
      chars: t.exposeFloat("chars"),
      estimatedTokens: t.exposeFloat("estimatedTokens"),
      blocks: t.exposeFloat("blocks", { nullable: true })
    })
  });

export const TokenAttributionSchemaChurn = builder
  .objectRef<TokenAttributionSchemaChurnModel>("TokenAttributionSchemaChurn")
  .implement({
    fields: (t) => ({
      name: t.exposeString("name"),
      chars: t.exposeFloat("chars"),
      estimatedTokens: t.exposeFloat("estimatedTokens"),
      requests: t.exposeFloat("requests"),
      sessions: t.exposeFloat("sessions"),
      schemaHashes: t.exposeFloat("schemaHashes"),
      churningSessions: t.exposeFloat("churningSessions"),
      status: t.exposeString("status")
    })
  });

export const TokenAttributionReport = builder
  .objectRef<TokenAttributionReportModel>("TokenAttributionReport")
  .implement({
    fields: (t) => ({
      requestCount: t.exposeFloat("requestCount"),
      sampled: t.exposeBoolean("sampled"),
      buckets: t.expose("buckets", { type: [TokenAttributionBucket] }),
      toolSchemas: t.expose("toolSchemas", { type: [TokenAttributionOffender] }),
      toolResults: t.expose("toolResults", { type: [TokenAttributionOffender] }),
      schemaChurn: t.expose("schemaChurn", { type: [TokenAttributionSchemaChurn] })
    })
  });

export const CompressionSavingsRow = builder
  .objectRef<CompressionSavingsRowModel>("CompressionSavingsRow")
  .implement({
    fields: (t) => ({
      rule: t.exposeString("rule"),
      ruleVersion: t.exposeFloat("ruleVersion"),
      tool: t.exposeString("tool"),
      commandClass: t.exposeString("commandClass"),
      blocks: t.exposeFloat("blocks"),
      beforeChars: t.exposeFloat("beforeChars"),
      afterChars: t.exposeFloat("afterChars"),
      savedChars: t.exposeFloat("savedChars"),
      beforeEstimatedTokens: t.exposeFloat("beforeEstimatedTokens"),
      afterEstimatedTokens: t.exposeFloat("afterEstimatedTokens"),
      savedEstimatedTokens: t.exposeFloat("savedEstimatedTokens"),
      estimateSource: t.exposeString("estimateSource")
    })
  });

export const CompressionSavingsReport = builder
  .objectRef<CompressionSavingsReportModel>("CompressionSavingsReport")
  .implement({
    fields: (t) => ({
      eventCount: t.exposeFloat("eventCount"),
      sampled: t.exposeBoolean("sampled"),
      blocks: t.exposeFloat("blocks"),
      beforeChars: t.exposeFloat("beforeChars"),
      afterChars: t.exposeFloat("afterChars"),
      savedChars: t.exposeFloat("savedChars"),
      beforeEstimatedTokens: t.exposeFloat("beforeEstimatedTokens"),
      afterEstimatedTokens: t.exposeFloat("afterEstimatedTokens"),
      savedEstimatedTokens: t.exposeFloat("savedEstimatedTokens"),
      estimateSource: t.exposeString("estimateSource"),
      rows: t.expose("rows", { type: [CompressionSavingsRow] })
    })
  });

export const ActiveSessionCount = builder
  .objectRef<ActiveSessionCountModel>("ActiveSessionCount")
  .implement({
    fields: (t) => ({
      activeSessions: t.exposeFloat("activeSessions"),
      windowMs: t.exposeFloat("windowMs")
    })
  });

export const RouteOutputRow = builder.objectRef<RouteOutputRowModel>("RouteOutputRow").implement({
  fields: (t) => ({
    route: t.exposeString("route"),
    requests: t.exposeFloat("requests"),
    outputTokens: t.exposeFloat("outputTokens"),
    reasoningTokens: t.exposeFloat("reasoningTokens"),
    avgOutputTokens: t.exposeFloat("avgOutputTokens"),
    reasoningShare: t.exposeFloat("reasoningShare"),
    outputCost: t.exposeFloat("outputCost")
  })
});

export const RouteOutputGroupRow = builder
  .objectRef<RouteOutputGroupRowModel>("RouteOutputGroupRow")
  .implement({
    fields: (t) => ({
      key: t.exposeString("key"),
      requests: t.exposeFloat("requests"),
      outputTokens: t.exposeFloat("outputTokens"),
      reasoningTokens: t.exposeFloat("reasoningTokens"),
      avgOutputTokens: t.exposeFloat("avgOutputTokens"),
      reasoningShare: t.exposeFloat("reasoningShare"),
      outputCost: t.exposeFloat("outputCost")
    })
  });

export const RouteOutputReport = builder.objectRef<RouteOutputReportModel>("RouteOutputReport").implement({
  fields: (t) => ({
    routes: t.expose("routes", { type: [RouteOutputRow] }),
    models: t.expose("models", { type: [RouteOutputGroupRow] }),
    users: t.expose("users", { type: [RouteOutputGroupRow] }),
    apiKeys: t.expose("apiKeys", { type: [RouteOutputGroupRow] }),
    workspaces: t.expose("workspaces", { type: [RouteOutputGroupRow] })
  })
});

export const IdleGapBucket = builder.objectRef<IdleGapBucketModel>("IdleGapBucket").implement({
  fields: (t) => ({
    key: t.exposeString("key"),
    label: t.exposeString("label"),
    count: t.exposeFloat("count")
  })
});

export const IdleGapReport = builder.objectRef<IdleGapReportModel>("IdleGapReport").implement({
  fields: (t) => ({
    buckets: t.expose("buckets", { type: [IdleGapBucket] }),
    totalGaps: t.exposeFloat("totalGaps"),
    overTtl: t.exposeFloat("overTtl"),
    recoverableByOneHourTtl: t.exposeFloat("recoverableByOneHourTtl"),
    estimatedRecoverableCacheReadTokens: t.exposeFloat("estimatedRecoverableCacheReadTokens"),
    recommendationThresholdTokens: t.exposeFloat("recommendationThresholdTokens"),
    recommendedTtlUpgrade: t.exposeBoolean("recommendedTtlUpgrade"),
    sessionsScanned: t.exposeFloat("sessionsScanned"),
    sampledRequests: t.exposeFloat("sampledRequests"),
    sampleWindowStart: t.exposeString("sampleWindowStart", { nullable: true }),
    sampleWindowEnd: t.exposeString("sampleWindowEnd", { nullable: true }),
    sampled: t.exposeBoolean("sampled")
  })
});

export const CacheBust = builder.objectRef<CacheBustModel>("CacheBust").implement({
  fields: (t) => ({
    sessionId: t.exposeString("sessionId"),
    requestId: t.exposeString("requestId"),
    at: t.exposeString("at"),
    cause: t.exposeString("cause"),
    droppedCacheReadTokens: t.exposeFloat("droppedCacheReadTokens"),
    rebuiltTokens: t.exposeFloat("rebuiltTokens"),
    model: t.exposeString("model"),
    previousModel: t.exposeString("previousModel"),
    gapMs: t.exposeFloat("gapMs")
  })
});

export const CacheBustReport = builder.objectRef<CacheBustReportModel>("CacheBustReport").implement({
  fields: (t) => ({
    busts: t.expose("busts", { type: [CacheBust] }),
    countsByCause: t.field({ type: "JSON", resolve: (report) => report.countsByCause }),
    sessionsScanned: t.exposeFloat("sessionsScanned"),
    sampled: t.exposeBoolean("sampled")
  })
});

export const PromptCachePlanRow = builder
  .objectRef<PromptCachePlanRowModel>("PromptCachePlanRow")
  .implement({
    fields: (t) => ({
      provider: t.exposeString("provider"),
      model: t.exposeString("model"),
      mode: t.exposeString("mode"),
      count: t.exposeFloat("count"),
      appliedControls: t.exposeFloat("appliedControls"),
      skippedControls: t.exposeFloat("skippedControls")
    })
  });

export const PromptCachePlanControlRow = builder
  .objectRef<PromptCachePlanControlRowModel>("PromptCachePlanControlRow")
  .implement({
    fields: (t) => ({
      provider: t.exposeString("provider"),
      model: t.exposeString("model"),
      mode: t.exposeString("mode"),
      control: t.exposeString("control"),
      status: t.exposeString("status"),
      reason: t.exposeString("reason"),
      count: t.exposeFloat("count")
    })
  });

export const PromptCachePlanReport = builder
  .objectRef<PromptCachePlanReportModel>("PromptCachePlanReport")
  .implement({
    fields: (t) => ({
      totalPlans: t.exposeFloat("totalPlans"),
      sampled: t.exposeBoolean("sampled"),
      plans: t.expose("plans", { type: [PromptCachePlanRow] }),
      controls: t.expose("controls", { type: [PromptCachePlanControlRow] })
    })
  });

export const PromptCachePrewarmJobRow = builder
  .objectRef<PromptCachePrewarmJobRowModel>("PromptCachePrewarmJobRow")
  .implement({
    fields: (t) => ({
      provider: t.exposeString("provider"),
      model: t.exposeString("model"),
      status: t.exposeString("status"),
      count: t.exposeFloat("count"),
      estimatedCostMicros: t.exposeFloat("estimatedCostMicros"),
      actualCostMicros: t.exposeFloat("actualCostMicros"),
      expiredUnusedCostMicros: t.exposeFloat("expiredUnusedCostMicros"),
      cacheReadLiftTokens: t.exposeFloat("cacheReadLiftTokens")
    })
  });

export const PromptCachePrewarmReport = builder
  .objectRef<PromptCachePrewarmReportModel>("PromptCachePrewarmReport")
  .implement({
    fields: (t) => ({
      totalJobs: t.exposeFloat("totalJobs"),
      sampled: t.exposeBoolean("sampled"),
      estimatedCostMicros: t.exposeFloat("estimatedCostMicros"),
      actualCostMicros: t.exposeFloat("actualCostMicros"),
      expiredUnusedCostMicros: t.exposeFloat("expiredUnusedCostMicros"),
      cacheReadLiftTokens: t.exposeFloat("cacheReadLiftTokens"),
      jobs: t.expose("jobs", { type: [PromptCachePrewarmJobRow] })
    })
  });

export const OpenAICacheAggregate = builder
  .objectRef<OpenAICacheAggregateModel>("OpenAICacheAggregate")
  .implement({
    fields: (t) => ({
      requestCount: t.exposeFloat("requestCount"),
      cachedRequests: t.exposeFloat("cachedRequests"),
      inputTokens: t.exposeFloat("inputTokens"),
      cachedInputTokens: t.exposeFloat("cachedInputTokens"),
      cacheHitRate: t.exposeFloat("cacheHitRate"),
      requestHitRate: t.exposeFloat("requestHitRate")
    })
  });

export const OpenAICacheGroup = builder
  .objectRef<OpenAICacheGroupModel>("OpenAICacheGroup")
  .implement({
    fields: (t) => ({
      surface: t.exposeString("surface"),
      provider: t.exposeString("provider"),
      model: t.exposeString("model"),
      route: t.exposeString("route"),
      cacheGroupSource: t.exposeString("cacheGroupSource"),
      cacheGroupKey: t.exposeString("cacheGroupKey"),
      requestCount: t.exposeFloat("requestCount"),
      cachedRequests: t.exposeFloat("cachedRequests"),
      inputTokens: t.exposeFloat("inputTokens"),
      cachedInputTokens: t.exposeFloat("cachedInputTokens"),
      cacheHitRate: t.exposeFloat("cacheHitRate"),
      requestHitRate: t.exposeFloat("requestHitRate")
    })
  });

export const OpenAICacheTrend = builder
  .objectRef<OpenAICacheTrendModel>("OpenAICacheTrend")
  .implement({
    fields: (t) => ({
      ts: t.exposeString("ts"),
      requestCount: t.exposeFloat("requestCount"),
      cachedRequests: t.exposeFloat("cachedRequests"),
      inputTokens: t.exposeFloat("inputTokens"),
      cachedInputTokens: t.exposeFloat("cachedInputTokens"),
      cacheHitRate: t.exposeFloat("cacheHitRate"),
      requestHitRate: t.exposeFloat("requestHitRate")
    })
  });

export const OpenAICacheAnalytics = builder
  .objectRef<OpenAICacheAnalyticsModel>("OpenAICacheAnalytics")
  .implement({
    fields: (t) => ({
      interval: t.field({ type: UsageInterval, resolve: (report) => report.interval }),
      totals: t.expose("totals", { type: OpenAICacheAggregate }),
      groups: t.expose("groups", { type: [OpenAICacheGroup] }),
      trends: t.expose("trends", { type: [OpenAICacheTrend] })
    })
  });
