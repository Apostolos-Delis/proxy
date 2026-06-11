import { builder } from "../builder.js";
import type {
  CacheBustModel,
  CacheBustReportModel,
  LatencySummaryModel,
  OverviewModel,
  RouteQualityModel,
  TokenAttributionBucketModel,
  TokenAttributionOffenderModel,
  TokenAttributionReportModel,
  UsageGroupModel,
  UsageReportModel,
  UsageTimeseriesModel,
  UsageTimeseriesPointModel
} from "../models.js";
import { CostTotals, TokenTotals } from "./core.js";

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

export const TokenAttributionReport = builder
  .objectRef<TokenAttributionReportModel>("TokenAttributionReport")
  .implement({
    fields: (t) => ({
      requestCount: t.exposeFloat("requestCount"),
      sampled: t.exposeBoolean("sampled"),
      buckets: t.expose("buckets", { type: [TokenAttributionBucket] }),
      toolSchemas: t.expose("toolSchemas", { type: [TokenAttributionOffender] }),
      toolResults: t.expose("toolResults", { type: [TokenAttributionOffender] })
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
