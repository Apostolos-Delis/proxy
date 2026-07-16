import { performance } from "node:perf_hooks";

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  accessProfiles,
  agentSessions,
  apiKeys,
  compressionReceipts,
  events,
  invitations,
  modelDeployments,
  organizationMembers,
  organizations,
  promptArtifacts,
  providerAttempts,
  providerConnections,
  requests,
  routeDecisions,
  users as usersTable,
  usageLedger,
  type ProxyDbSession
} from "@proxy/db";

import {
  baselineModelForDialect,
  pricingForProviderModel,
  providerForDialect,
  providerModelPricingKey,
  usageCostMicros,
  type CostBaseline,
  type ModelPricing,
  type ModelPricingTable
} from "../pricing.js";
import type { JsonObject } from "../types.js";
import { searchAdminEntities } from "./adminSearch.js";
import { workspaceScope } from "./scope.js";
import {
  eventSummary,
  invitationSummary,
  providerAttemptSummary,
  routeDecisionSummary,
  usageLedgerSummary
} from "./adminSerializers.js";
import { CACHE_TTL_DEFAULT_MS } from "../cacheWindows.js";
import { CACHE_BUST_SAMPLE_CAP, cacheBustEvidenceByRequest, detectCacheBusts } from "./cacheBusts.js";
import {
  aggregateCompressionReceiptSavings,
  COMPRESSION_SAVINGS_SAMPLE_CAP
} from "./compressionSavings.js";
import { aggregateIdleGaps, IDLE_GAP_SAMPLE_CAP } from "./idleGaps.js";
import { pricingFromRow } from "./modelPricing.js";
import { orgCostBaseline } from "./organizationSettings.js";
import {
  aggregateUsageByRequest,
  attemptCounts,
  classifierCostByRequestId,
  latestAttemptsByRequest,
  usageAggregateForRow,
  type UsageAggregate
} from "./adminRequestUsage.js";
import { aggregateTokenAttribution, TOKEN_ATTRIBUTION_SAMPLE_CAP } from "./tokenAttributionReport.js";
import {
  OTHER_ROLLUP_GROUP_KEY,
  openAICacheAnalyticsRows,
  usageBucketRollupReportRows,
  usageRollupReportRows,
  type OpenAICacheAnalyticsRow,
  type OpenAICacheTrendRow,
  type UsageBucketRollupReport,
  type UsageLatencyRow,
  type UsageLatencyMode,
  type UsageRollupReport,
  type UsageRollupRow,
  type UsageRollupScope
} from "./usageRollups.js";
import { knownSurfaceValue } from "./values.js";
import {
  type MetricsCollector,
  NoopMetricsCollector
} from "../metrics.js";
import { isRecord } from "../util.js";

type DateRangeFilters = {
  start?: string;
  end?: string;
};

const PROMPT_CACHE_PLAN_SAMPLE_CAP = 5_000;
const PROMPT_CACHE_PREWARM_SAMPLE_CAP = 5_000;
const OPENAI_CACHE_ANALYTICS_GROUP_LIMIT = 12;
const PROMPT_CACHE_PREWARM_EVENTS = [
  "prompt_cache.prewarm_started",
  "prompt_cache.prewarm_completed",
  "prompt_cache.prewarm_failed",
  "prompt_cache.prewarm_cancelled",
  "prompt_cache.prewarm_expired_unused"
];

export type PromptListFilters = {
  limit?: number;
  offset?: number;
  userId?: string;
  surface?: string;
  logicalModel?: string;
  model?: string;
  start?: string;
  end?: string;
};

export type RequestListFilters = {
  limit?: number;
  start?: string;
  end?: string;
};

export type UsageAnalyticsFilters = {
  groupBy?: string;
  start?: string;
  end?: string;
};

export type UsageTimeseriesFilters = UsageAnalyticsFilters & {
  interval?: string;
  limit?: number;
};

export type UsageDashboardOptions = {
  includeBaselineCost?: boolean;
  includeUsageLatency?: boolean;
  includeTimeseriesLatency?: boolean;
};

export type SessionDetailOptions = {
  includePromptArtifacts?: boolean;
  includePromptArtifactContent?: boolean;
  includeRouteDecisions?: boolean;
  includeProviderAttempts?: boolean;
  includeUsageLedger?: boolean;
  includeEvents?: boolean;
};

function sessionDetailOptions(options: SessionDetailOptions): Required<SessionDetailOptions> {
  return {
    includePromptArtifacts: options.includePromptArtifacts ?? true,
    includePromptArtifactContent: options.includePromptArtifactContent ?? true,
    includeRouteDecisions: options.includeRouteDecisions ?? true,
    includeProviderAttempts: options.includeProviderAttempts ?? true,
    includeUsageLedger: options.includeUsageLedger ?? true,
    includeEvents: options.includeEvents ?? true
  };
}

export class AdminQueryService {
  // Instances are created per GraphQL request (see graphql/context.ts), so
  // these caches dedupe work across root fields of one document — including
  // concurrent fields, which is why promises are cached rather than values.
  private readonly requestScopedCache = new Map<string, Promise<unknown>>();
  private readonly summaryInputsCache = new WeakMap<object, Promise<SummaryInputs>>();

  constructor(
    private readonly db: ProxyDbSession,
    private readonly organizationId: string,
    private readonly workspaceId: string,
    private readonly metrics: MetricsCollector = new NoopMetricsCollector()
  ) {}

  // All workspace-scoped table reads go through this predicate; new queries
  // must use it rather than hand-rolling org/workspace eq pairs.
  private scopedTo(table: Parameters<typeof workspaceScope>[0]) {
    return workspaceScope(table, this.organizationId, this.workspaceId);
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.requestScopedCache.get(key);
    if (existing) return existing as Promise<T>;
    const pending = load().catch((error: unknown) => {
      // Do not retain failures: a later field in the same request may retry.
      this.requestScopedCache.delete(key);
      throw error;
    });
    this.requestScopedCache.set(key, pending);
    return pending;
  }

  async overview() {
    const [requestRows, eventCount, lowConfidenceCount] = await Promise.all([
      this.requestRows(),
      this.eventCount(),
      this.lowConfidenceDecisionCount()
    ]);
    const requestSummaries = await this.summarizeRequests(requestRows);
    return this.overviewFromSummaries(requestRows.length, requestSummaries, eventCount, lowConfidenceCount);
  }

  async overviewDashboard() {
    const [requestRows, eventCount, lowConfidenceCount] = await Promise.all([
      this.requestRows(),
      this.eventCount(),
      this.lowConfidenceDecisionCount()
    ]);
    const requestSummaries = await this.summarizeRequests(requestRows);
    const aggregateRequestSummaries = await this.summarizeRequests(requestRows, { aggregateUsageByRequest: true });
    return {
      overview: this.overviewFromSummaries(requestRows.length, requestSummaries, eventCount, lowConfidenceCount),
      requests: requestSummaries.slice(0, requestListLimit(undefined)),
      modelUsage: modelUsageReportFromRequests(aggregateRequestSummaries)
    };
  }

  private overviewFromSummaries(
    requestCount: number,
    requestSummaries: RequestSummary[],
    eventCount: number,
    lowConfidenceCount: number
  ) {
    return {
      organizationId: this.organizationId,
      eventCount,
      requestCount,
      totals: requestSummaries.reduce((acc, request) => {
        addUsageTotals(acc, request.usage);
        return acc;
      }, emptyUsage()),
      cost: requestSummaries.reduce((acc, request) => {
        acc.selected += request.selectedCost;
        acc.baseline += request.baselineCost;
        acc.savings += request.savings;
        acc.classifier += request.classifierCost;
        return acc;
      }, { selected: 0, baseline: 0, savings: 0, classifier: 0 }),
      routeQuality: {
        lowConfidenceCount
      }
    };
  }

  async requests(filters: RequestListFilters = {}) {
    return {
      data: await this.summarizeRequests(await this.requestRowsForList(filters))
    };
  }

  async search(query: string) {
    return searchAdminEntities(this.db, this.organizationId, this.workspaceId, query);
  }

  async apiKeys() {
    const rows = await this.apiKeyRows();
    return {
      data: rows.map(apiKeySummary)
    };
  }

  async apiKeyDetail(apiKeyId: string) {
    const [row] = await this.apiKeyRows(apiKeyId);
    if (!row) return null;
    return { apiKey: apiKeySummary(row) };
  }

  async requestDetail(requestId: string) {
    const [requestRow] = await this.db
      .select()
      .from(requests)
      .where(and(
        this.scopedTo(requests),
        eq(requests.id, requestId)
      ))
      .limit(1);
    const [request] = requestRow ? await this.summarizeRequests([requestRow]) : [];
    const routeDecisionSummaries = requestRow
      ? (await this.routeDecisionRowsForRequest(requestId)).map(routeDecisionSummary)
      : [];
    const requestEvents = requestRow ? await this.eventsForRequest(requestId) : [];
    return {
      request: request ?? null,
      routeDecisions: routeDecisionSummaries,
      providerAttempts: requestRow
        ? (await this.providerAttemptRowsForRequest(requestId)).map(providerAttemptSummary)
        : [],
      // Only fetch the timeline once the request passed the workspace check,
      // so foreign request ids cannot expose another workspace's events.
      events: requestEvents,
      compressionReceipts: requestRow ? await this.compressionReceiptsForRequest(requestId) : []
    };
  }

  async prompts(filters: PromptListFilters = {}) {
    const rows = await this.promptRows(filters);
    const requestRows = [...new Map(rows.map((row) => [row.request.id, row.request])).values()];
    const requestSummaries = new Map((await this.summarizeRequests(requestRows)).map((request) => [request.requestId, request]));
    const data = rows.map((row) => promptSummary(row, requestSummaries.get(row.request.id)));
    return {
      data,
      pagination: {
        limit: promptLimit(filters.limit),
        offset: promptOffset(filters.offset),
        count: rows.length
      }
    };
  }

  async usage(filters: UsageAnalyticsFilters = {}) {
    const groupBy = usageGroupBy(filters.groupBy);
    const scope = this.usageRollupScope(filters);
    const [pricing, costBaseline, report] = await Promise.all([
      this.effectivePricing(),
      this.effectiveCostBaseline(),
      this.usageRollupReport(scope, groupBy)
    ]);

    const totals = emptyUsageGroup("total");
    const groups = new Map<string, UsageGroup>();
    for (const row of report.rollups) {
      const group = groups.get(row.groupKey) ?? emptyUsageGroup(row.groupKey);
      this.addUsageRollup(group, row, pricing, costBaseline);
      this.addUsageRollup(totals, row, pricing, costBaseline);
      groups.set(row.groupKey, group);
    }

    let totalsLatency: UsageLatencyRow | undefined;
    const latencyByKey = new Map<string, UsageLatencyRow>();
    for (const row of report.latencies) {
      if (row.groupKey === null) totalsLatency = row;
      else latencyByKey.set(row.groupKey, row);
    }

    const data = [...groups.values()]
      .sort(compareUsageGroups)
      .map((group) => finalizeUsageGroup(group, latencySummaryFromRow(latencyByKey.get(group.key))));
    return {
      groupBy,
      data,
      totals: finalizeUsageGroup(totals, latencySummaryFromRow(totalsLatency))
    };
  }

  async usageDashboard(filters: UsageTimeseriesFilters = {}, options: UsageDashboardOptions = {}) {
    const groupBy = usageGroupBy(filters.groupBy);
    const interval = usageInterval(filters.interval);
    const limit = timeseriesGroupLimit(filters.limit);
    const scope = this.usageRollupScope(filters);
    const step = intervalMs(interval);
    const includeTimeseriesLatency = options.includeTimeseriesLatency === true;
    const includeUsageLatency = options.includeUsageLatency !== false;
    const includeBaselineCost = options.includeBaselineCost !== false;
    let latencyMode: UsageLatencyMode = "none";
    if (includeTimeseriesLatency) {
      latencyMode = "full";
    } else if (includeUsageLatency) {
      latencyMode = "report";
    }
    const [pricing, costBaseline, bucketReport] = await Promise.all([
      includeBaselineCost ? this.effectivePricing() : Promise.resolve({} as ModelPricingTable),
      includeBaselineCost ? this.effectiveCostBaseline() : Promise.resolve({} as CostBaseline),
      this.usageBucketRollupReport(scope, groupBy, step, null, latencyMode, includeBaselineCost)
    ]);
    return this.usageDashboardFromBucket(
      filters,
      groupBy,
      interval,
      limit,
      step,
      scope,
      bucketReport,
      pricing,
      costBaseline,
      includeTimeseriesLatency,
      includeBaselineCost
    );
  }

  async usageTimeseries(filters: UsageTimeseriesFilters = {}) {
    return (await this.usageDashboard(filters, { includeTimeseriesLatency: true })).timeseries;
  }

  async openAICacheAnalytics(filters: UsageTimeseriesFilters = {}) {
    const interval = usageInterval(filters.interval);
    const scope = this.usageRollupScope(filters);
    const step = intervalMs(interval);
    const report = await this.cached(`openai-cache-analytics:${step}:${usageScopeKey(scope)}`, () =>
      this.recordDbQuery("openai_cache_analytics", () => openAICacheAnalyticsRows(this.db, scope, step)));
    const totals = emptyOpenAICacheAggregate();
    for (const row of report.trends) {
      addOpenAICacheAggregate(totals, row);
    }
    return {
      interval,
      totals: finalizeOpenAICacheAggregate(totals),
      groups: report.groups
        .map(finalizeOpenAICacheGroup)
        .sort(compareOpenAICacheGroups)
        .slice(0, OPENAI_CACHE_ANALYTICS_GROUP_LIMIT),
      trends: report.trends
        .sort((left, right) => left.bucketTs - right.bucketTs)
        .map(finalizeOpenAICacheTrend)
    };
  }

  private async usageDashboardFromBucket(
    filters: UsageTimeseriesFilters,
    groupBy: UsageGroupBy,
    interval: UsageInterval,
    limit: number,
    step: number,
    scope: UsageRollupScope,
    bucketReport: UsageBucketRollupReport,
    pricing: ModelPricingTable,
    costBaseline: CostBaseline,
    includeTimeseriesLatency: boolean,
    includeBaselineCost: boolean
  ) {
    const { rollups } = bucketReport;

    const earliestMs = rollups.length > 0
      ? Math.min(...rollups.map((row) => row.earliestCreatedAtMs))
      : undefined;
    const window = timeseriesWindow(earliestMs, filters, interval);

    const groupTotals = new Map<string, UsageGroup>();
    const totals = emptyUsageGroup("total");
    for (const row of rollups) {
      const group = groupTotals.get(row.groupKey) ?? emptyUsageGroup(row.groupKey);
      this.addUsageRollup(group, row, pricing, costBaseline, includeBaselineCost);
      this.addUsageRollup(totals, row, pricing, costBaseline, includeBaselineCost);
      groupTotals.set(row.groupKey, group);
    }
    const ranked = [...groupTotals.values()].sort(compareUsageGroups);
    const keptKeys = new Set(ranked.slice(0, limit).map((group) => group.key));
    const collapseOthers = ranked.length > limit;
    const pointReport = collapseOthers && includeTimeseriesLatency
      ? await this.usageBucketRollupReport(scope, groupBy, step, [...keptKeys], "full", includeBaselineCost)
      : bucketReport;

    const points = new Map<number, { totals: UsageGroup; groups: Map<string, UsageGroup> }>();
    for (let ts = window.start; ts <= window.end; ts += step) {
      points.set(ts, { totals: emptyUsageGroup("total"), groups: new Map() });
    }
    for (const row of pointReport.rollups) {
      const point = points.get(row.bucketTs);
      if (!point) continue;
      const groupKey = collapseOthers && !includeTimeseriesLatency && !keptKeys.has(row.groupKey)
        ? OTHER_ROLLUP_GROUP_KEY
        : row.groupKey;
      const group = point.groups.get(groupKey) ?? emptyUsageGroup(groupKey);
      this.addUsageRollup(point.totals, row, pricing, costBaseline, includeBaselineCost);
      this.addUsageRollup(group, row, pricing, costBaseline, includeBaselineCost);
      point.groups.set(groupKey, group);
    }

    const usageGroupLatency = new Map<string, UsageLatencyRow>();
    let totalsLatency: UsageLatencyRow | undefined;
    for (const row of bucketReport.latencies) {
      if (row.groupKey === null) {
        if (row.bucketTs === null) totalsLatency = row;
      } else if (row.bucketTs === null) {
        usageGroupLatency.set(row.groupKey, row);
      }
    }

    const timeseriesGroupLatency = new Map<string, UsageLatencyRow>();
    const bucketLatency = new Map<number, UsageLatencyRow>();
    const bucketGroupLatency = new Map<string, UsageLatencyRow>();
    if (includeTimeseriesLatency) {
      for (const row of pointReport.latencies) {
        if (row.groupKey === null) {
          if (row.bucketTs !== null) bucketLatency.set(row.bucketTs, row);
        } else if (row.bucketTs === null) {
          timeseriesGroupLatency.set(row.groupKey, row);
        } else {
          bucketGroupLatency.set(`${row.bucketTs}:${row.groupKey}`, row);
        }
      }
    }

    const groups = ranked.slice(0, limit);
    if (collapseOthers) {
      const other = emptyUsageGroup(OTHER_ROLLUP_GROUP_KEY);
      for (const group of ranked.slice(limit)) mergeUsageGroup(other, group);
      groups.push(other);
    }
    return {
      usage: {
        groupBy,
        data: ranked.map((group) =>
          finalizeUsageGroup(group, latencySummaryFromRow(usageGroupLatency.get(group.key)))),
        totals: finalizeUsageGroup(totals, latencySummaryFromRow(totalsLatency))
      },
      timeseries: {
        groupBy,
        interval,
        start: new Date(window.start).toISOString(),
        end: new Date(window.end).toISOString(),
        groups: groups.map((group) =>
          finalizeUsageGroup(group, latencySummaryFromRow(timeseriesGroupLatency.get(group.key)))),
        points: [...points.entries()]
          .sort(([left], [right]) => left - right)
          .map(([ts, point]) => ({
            ts: new Date(ts).toISOString(),
            totals: finalizeUsageGroup(point.totals, latencySummaryFromRow(bucketLatency.get(ts))),
            groups: Object.fromEntries(
              [...point.groups.entries()].map(([key, group]) => [
                key,
                finalizeUsageGroup(group, latencySummaryFromRow(bucketGroupLatency.get(`${ts}:${key}`)))
              ])
            )
          }))
      }
    };
  }

  private usageRollupScope(filters: UsageAnalyticsFilters): UsageRollupScope {
    return {
      organizationId: this.organizationId,
      workspaceId: this.workspaceId,
      start: dateValue(filters.start),
      end: dateValue(filters.end)
    };
  }

  private usageRollupReport(scope: UsageRollupScope, groupBy: UsageGroupBy): Promise<UsageRollupReport> {
    return this.cached(`usage-rollup-report:${groupBy}:${usageScopeKey(scope)}`, () =>
      this.recordDbQuery("usage_rollup", () => usageRollupReportRows(this.db, scope, groupBy)));
  }

  private usageBucketRollupReport(
    scope: UsageRollupScope,
    groupBy: UsageGroupBy,
    step: number,
    keptKeys: string[] | null,
    latencyMode: UsageLatencyMode = "full",
    includePricingDimensions = true
  ): Promise<UsageBucketRollupReport> {
    return this.cached(`usage-bucket-rollup-report:${groupBy}:${step}:${JSON.stringify(keptKeys)}:${latencyMode}:${includePricingDimensions}:${usageScopeKey(scope)}`, () =>
      this.recordDbQuery("usage_bucket_rollup", () => usageBucketRollupReportRows(
        this.db,
        scope,
        groupBy,
        step,
        keptKeys,
        latencyMode,
        includePricingDimensions
      )));
  }

  private async recordDbQuery<T>(operation: string, load: () => Promise<T>) {
    const startedAtMs = performance.now();
    try {
      const result = await load();
      this.metrics.observeHistogram("proxy_db_query_duration_seconds", (performance.now() - startedAtMs) / 1000, {
        operation,
        outcome: "succeeded"
      });
      return result;
    } catch (error) {
      this.metrics.observeHistogram("proxy_db_query_duration_seconds", (performance.now() - startedAtMs) / 1000, {
        operation,
        outcome: "failed"
      });
      this.metrics.incrementCounter("proxy_db_errors_total", {
        operation,
        error_class: "persistence"
      });
      throw error;
    }
  }

  // Baseline spend is priced live from the rollup's (surface, requestedModel)
  // pair; the ledger's frozen per-request costs arrive pre-summed.
  private addUsageRollup(
    group: UsageGroup,
    row: UsageRollupRow,
    pricing: ModelPricingTable,
    costBaseline: CostBaseline,
    includeBaselineCost = true
  ) {
    group.requestCount += row.requestCount;
    group.failedRequests += row.failedRequests;
    group.retriedRequests += row.retriedRequests;
    group.usage.inputTokens += row.inputTokens;
    group.usage.cachedInputTokens += row.cachedInputTokens;
    group.usage.cacheCreationInputTokens += row.cacheCreationInputTokens;
    group.usage.outputTokens += row.outputTokens;
    group.usage.reasoningTokens += row.reasoningTokens;
    group.usage.totalTokens += row.totalTokens;
    const baseline = includeBaselineCost
      ? baselineCostFor(pricing, costBaseline, row.surface, row.selectedProvider, {
          inputTokens: row.uncachedInputTokens + row.cachedInputTokens + row.cacheCreationInputTokens,
          cachedInputTokens: row.cachedInputTokens,
          cacheCreationInputTokens: row.cacheCreationInputTokens,
          outputTokens: row.outputTokens,
          reasoningTokens: row.reasoningTokens,
          totalTokens: row.totalTokens
        })
      : 0;
    const classifier = row.classifierCostMicros / 1_000_000;
    const selected = row.providerCostMicros / 1_000_000 + classifier;
    group.cost.selected += selected;
    group.cost.baseline += baseline;
    group.cost.savings += includeBaselineCost ? baseline - selected : 0;
    group.cost.classifier += classifier;
  }

  async users() {
    const requestRows = await this.requestRows();
    const requestSummaries = await this.summarizeRequests(requestRows, { aggregateUsageByRequest: true });
    const sessionRows = await this.sessionRows();
    const userRows = await this.userRowsForOrg();
    const memberRows = await this.memberRowsByUserId();
    const apiKeyCounts = await this.activeApiKeyCountsByUser();
    return {
      data: [...userRows.values()]
        .map((user) => userSummary(user, requestSummaries, sessionRows, memberRows.get(user.id), apiKeyCounts.get(user.id) ?? 0))
        .sort((left, right) => compareRecentActivity(left.recentActivity, right.recentActivity))
    };
  }

  async userDetail(userId: string) {
    const memberRows = await this.memberRowsByUserId();
    const member = memberRows.get(userId);
    if (!member) return null;

    const requestRows = await this.requestRowsForUser(userId);
    const requestSummaries = await this.summarizeRequests(requestRows, { aggregateUsageByRequest: true });
    const sessionRows = await this.sessionRowsForUser(userId, sessionIdsForRequests(requestSummaries));
    const userRows = await this.userRowsForOrg();
    const user = userRows.get(userId);
    if (!user) return null;

    const apiKeyCounts = await this.activeApiKeyCountsByUser();
    const summary = userSummary(user, requestSummaries, sessionRows, member, apiKeyCounts.get(userId) ?? 0);
    return {
      user: summary,
      usage: summary.usage,
      cost: summary.cost,
      sessions: sessionRows.map((session) => sessionSummary(session, requestSummaries)),
      requests: requestSummaries.slice(0, 50)
    };
  }

  memberDirectory() {
    return this.cached("member-directory", () => this.db
      .select({
        userId: organizationMembers.userId,
        name: usersTable.name,
        email: usersTable.email,
        status: organizationMembers.status
      })
      .from(organizationMembers)
      .innerJoin(usersTable, eq(usersTable.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, this.organizationId))
      .orderBy(asc(usersTable.name)));
  }

  async invitations() {
    const rows = await this.invitationRows();
    return {
      data: rows.map((row) => invitationSummary(row.invitation, row.inviter))
    };
  }

  async invitationDetail(invitationId: string) {
    const [row] = await this.invitationRows(invitationId);
    return row ? { invitation: invitationSummary(row.invitation, row.inviter) } : null;
  }

  organizationName() {
    return this.cached("org-name", async () => {
      const [row] = await this.db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, this.organizationId))
        .limit(1);
      return row?.name ?? this.organizationId;
    });
  }

  async sessions() {
    const sessionRows = await this.sessionRows();
    const requestRows = await this.requestRows();
    const requestSummaries = await this.summarizeRequests(requestRows, { aggregateUsageByRequest: true });
    return {
      data: sessionRows
        .map((session) => sessionSummary(session, requestSummaries))
        .sort((left, right) => compareRecentActivity(left.recentActivity, right.recentActivity))
    };
  }

  async sessionDetail(sessionId: string, options: SessionDetailOptions = {}) {
    const detailOptions = sessionDetailOptions(options);
    const [session] = await this.db
      .select()
      .from(agentSessions)
      .where(and(
        this.scopedTo(agentSessions),
        eq(agentSessions.id, sessionId)
      ))
      .limit(1);
    if (!session) return null;

    const requestRows = await this.requestRowsForSession(sessionId);
    const requestSummaries = await this.summarizeRequests(requestRows, { aggregateUsageByRequest: true });
    const requestSummariesById = new Map(requestSummaries.map((request) => [request.requestId, request]));
    const requestIds = requestRows.map((request) => request.id);
    const userRows = session.userId ? await this.userRowsForOrg() : new Map<string, UserRow>();
    const detailRows = await this.sessionDetailRows(sessionId, requestIds, detailOptions);
    const promptArtifactSummaries = detailRows.prompts.map((row) => promptDetail(row, requestSummariesById.get(row.request.id)));
    const routeDecisionSummaries = detailRows.routeDecisions.map(routeDecisionSummary);
    return {
      session: sessionSummary(session, requestSummaries),
      user: session.userId ? userRows.get(session.userId) ?? null : null,
      requests: requestSummaries,
      promptArtifacts: promptArtifactSummaries,
      routeDecisions: routeDecisionSummaries,
      providerAttempts: detailRows.providerAttempts.map(providerAttemptSummary),
      usageLedger: detailRows.usageLedger.map(usageLedgerSummary),
      events: detailRows.events.map(eventSummary)
    };
  }

  async promptDetail(artifactId: string) {
    const [row] = await this.db
      .select({
        artifact: promptArtifacts,
        request: requests,
        decision: routeDecisions
      })
      .from(promptArtifacts)
      .innerJoin(requests, and(
        eq(requests.id, promptArtifacts.requestId),
        eq(requests.organizationId, promptArtifacts.organizationId)
      ))
      .leftJoin(routeDecisions, and(
        this.scopedTo(routeDecisions),
        eq(routeDecisions.requestId, requests.id),
        eq(routeDecisions.organizationId, requests.organizationId)
      ))
      .where(and(
        this.scopedTo(promptArtifacts),
        this.scopedTo(requests),
        eq(promptArtifacts.id, artifactId)
      ))
      .limit(1);
    if (!row) return null;

    const [request] = await this.summarizeRequests([row.request]);
    const requestEvents = await this.eventsForRequest(row.request.id);
    const compressionReceipts = await this.compressionReceiptsForRequest(row.request.id);
    const artifact = promptDetail(row, request);
    const routeDecisionSummaries = (await this.routeDecisionRowsForRequest(row.request.id)).map(routeDecisionSummary);
    const siblingRows = await this.db
      .select()
      .from(promptArtifacts)
      .where(and(
        this.scopedTo(promptArtifacts),
        eq(promptArtifacts.requestId, row.request.id)
      ))
      .orderBy(asc(promptArtifacts.createdAt));

    return {
      artifact,
      request: request ?? null,
      requestArtifacts: siblingRows.map((sibling) => promptDetail({
        artifact: sibling,
        request: row.request,
        decision: row.decision
      }, request)),
      compressionReceipts,
      routeDecisions: routeDecisionSummaries,
      providerAttempts: (await this.providerAttemptRowsForRequest(row.request.id)).map(providerAttemptSummary),
      events: requestEvents
    };
  }

  private async apiKeyRows(apiKeyId?: string) {
    const conditions = [this.scopedTo(apiKeys)];
    if (apiKeyId) conditions.push(eq(apiKeys.id, apiKeyId));
    return this.db
      .select({
        id: apiKeys.id,
        organizationId: apiKeys.organizationId,
        userId: apiKeys.userId,
        name: apiKeys.name,
        accessProfileId: apiKeys.accessProfileId,
        accessProfileName: accessProfiles.name,
        accessProfileStatus: accessProfiles.status,
        createdAt: apiKeys.createdAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        lastUsedAt: apiKeys.lastUsedAt
      })
      .from(apiKeys)
      .leftJoin(accessProfiles, and(
        eq(accessProfiles.organizationId, apiKeys.organizationId),
        eq(accessProfiles.workspaceId, apiKeys.workspaceId),
        eq(accessProfiles.id, apiKeys.accessProfileId)
      ))
      .where(and(...conditions))
      .orderBy(desc(apiKeys.createdAt));
  }

  private activeApiKeyCountsByUser() {
    return this.cached("active-api-key-counts", async () => {
      const rows = await this.db
        .select({ userId: apiKeys.userId })
        .from(apiKeys)
        .where(and(
          this.scopedTo(apiKeys),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.expiresAt), gte(apiKeys.expiresAt, new Date()))
        ));
      const counts = new Map<string, number>();
      for (const row of rows) {
        if (!row.userId) continue;
        counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
      }
      return counts;
    });
  }

  private requestRows(limit?: number) {
    return this.cached(limit === undefined ? ALL_REQUEST_ROWS_KEY : `requests:${limit}`, async () => {
      // Opportunistic: when a full scan was already registered in this
      // request, a limited read can slice it — rows share the
      // createdAt-descending order. When the limited read registers first it
      // issues its own LIMIT query; both paths return complete,
      // self-consistent row sets.
      if (limit !== undefined) {
        const allRows = this.requestScopedCache.get(ALL_REQUEST_ROWS_KEY) as
          | Promise<RequestRow[]>
          | undefined;
        if (allRows) return (await allRows).slice(0, limit);
      }
      const query = this.db
        .select()
        .from(requests)
        .where(this.scopedTo(requests))
        .orderBy(desc(requests.createdAt));
      return limit === undefined ? query : query.limit(limit);
    });
  }

  private requestRowsForList(filters: RequestListFilters) {
    const start = dateValue(filters.start);
    const end = dateValue(filters.end);
    const limit = requestListLimit(filters.limit);
    // An unfiltered read is the same limited scan the bare list always performed.
    if (!start && !end) return this.requestRows(limit);
    return this.cached(`requests:list:${limit}:${start?.toISOString() ?? ""}:${end?.toISOString() ?? ""}`, () => {
      const conditions = [this.scopedTo(requests)];
      if (start) conditions.push(gte(requests.createdAt, start));
      if (end) conditions.push(lte(requests.createdAt, end));
      return this.db
        .select()
        .from(requests)
        .where(and(...conditions))
        .orderBy(desc(requests.createdAt))
        .limit(limit);
    });
  }

  private async requestRowsForUser(userId: string) {
    return this.db
      .select()
      .from(requests)
      .where(and(
        this.scopedTo(requests),
        eq(requests.userId, userId)
      ))
      .orderBy(desc(requests.createdAt));
  }

  private async requestRowsForSession(sessionId: string) {
    return this.db
      .select()
      .from(requests)
      .where(and(
        this.scopedTo(requests),
        eq(requests.sessionId, sessionId)
      ))
      .orderBy(desc(requests.createdAt));
  }

  private sessionRows() {
    return this.cached("sessions", () => this.db
      .select()
      .from(agentSessions)
      .where(this.scopedTo(agentSessions))
      .orderBy(desc(agentSessions.updatedAt)));
  }

  private async sessionRowsForUser(userId: string, requestSessionIds: string[]) {
    const rows = await this.sessionRows();
    const requestSessionIdsSet = new Set(requestSessionIds);
    return rows.filter((session) =>
      session.userId === userId || requestSessionIdsSet.has(session.id)
    );
  }

  private async userRowsForOrg() {
    const memberRows = await this.cached("member-user-rows", () => this.db
      .select({
        user: usersTable
      })
      .from(organizationMembers)
      .innerJoin(usersTable, eq(usersTable.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, this.organizationId)));
    return new Map(memberRows.map((row) => [row.user.id, row.user]));
  }

  private memberRowsByUserId() {
    return this.cached("members", async () => {
      const rows = await this.db
        .select()
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, this.organizationId));
      return new Map(rows.map((row) => [row.userId, row]));
    });
  }

  private async invitationRows(invitationId?: string) {
    const conditions = [eq(invitations.organizationId, this.organizationId)];
    if (invitationId) conditions.push(eq(invitations.id, invitationId));
    return this.db
      .select({
        invitation: invitations,
        inviter: usersTable
      })
      .from(invitations)
      .leftJoin(usersTable, eq(usersTable.id, invitations.invitedByUserId))
      .where(and(...conditions))
      .orderBy(desc(invitations.createdAt));
  }

  private async sessionDetailRows(sessionId: string, requestIds: string[], options: Required<SessionDetailOptions>) {
    const prompts = options.includePromptArtifacts && requestIds.length > 0
      ? await this.db
          .select({
            artifact: promptArtifactDetailColumns(options.includePromptArtifactContent),
            request: requests
          })
          .from(promptArtifacts)
          .innerJoin(requests, and(
            eq(requests.id, promptArtifacts.requestId),
            eq(requests.organizationId, promptArtifacts.organizationId)
          ))
          .where(and(
            this.scopedTo(promptArtifacts),
            inArray(promptArtifacts.requestId, requestIds)
          ))
          .orderBy(asc(promptArtifacts.createdAt))
      : [];
    const decisions = options.includeRouteDecisions && requestIds.length > 0
      ? await this.db
          .select()
          .from(routeDecisions)
          .where(and(
            this.scopedTo(routeDecisions),
            inArray(routeDecisions.requestId, requestIds)
          ))
          .orderBy(asc(routeDecisions.createdAt))
      : [];
    const attempts = options.includeProviderAttempts && requestIds.length > 0
      ? await this.db
          .select()
          .from(providerAttempts)
          .where(and(
            this.scopedTo(providerAttempts),
            inArray(providerAttempts.requestId, requestIds)
          ))
          .orderBy(asc(providerAttempts.startedAt))
      : [];
    const usageRows = options.includeUsageLedger && requestIds.length > 0
      ? await this.db
          .select()
          .from(usageLedger)
          .where(and(
            this.scopedTo(usageLedger),
            inArray(usageLedger.requestId, requestIds)
          ))
          .orderBy(asc(usageLedger.createdAt))
      : [];
    return {
      prompts,
      routeDecisions: decisions,
      providerAttempts: attempts,
      usageLedger: usageRows,
      events: options.includeEvents ? await this.eventsForSession(sessionId, requestIds) : []
    };
  }

  private effectivePricing(): Promise<ModelPricingTable> {
    return this.cached("model-pricing", async () => {
      const rows = await this.db
        .select({
          provider: providerConnections.provider,
          model: modelDeployments.upstreamModelId,
          pricing: modelDeployments.pricing
        })
        .from(modelDeployments)
        .innerJoin(providerConnections, and(
          eq(providerConnections.organizationId, modelDeployments.organizationId),
          eq(providerConnections.workspaceId, modelDeployments.workspaceId),
          eq(providerConnections.id, modelDeployments.providerConnectionId)
        ))
        .where(this.scopedTo(modelDeployments))
        .orderBy(desc(modelDeployments.updatedAt));
      const table: Record<string, ModelPricing> = {};
      for (const row of rows) {
        const key = providerModelPricingKey(row.provider, row.model);
        if (table[key]) continue;
        const pricing = pricingFromRow(row.pricing);
        if (pricing) table[key] = pricing;
      }
      return Object.freeze(table);
    });
  }

  // Savings counterfactual for this organization: the baseline models from
  // organization settings, defaulting to the harness frontier defaults.
  private effectiveCostBaseline(): Promise<CostBaseline> {
    return this.cached("cost-baseline", () => orgCostBaseline(this.db, this.organizationId));
  }

  private async summarizeRequests(
    requestRows: RequestRow[],
    options: { aggregateUsageByRequest?: boolean } = {}
  ) {
    if (requestRows.length === 0) return [];
    const [pricing, costBaseline] = await Promise.all([
      this.effectivePricing(),
      this.effectiveCostBaseline()
    ]);
    const { decisions, attempts, usageRows, classifierUsageRows } = await this.summaryInputsFor(requestRows);

    const decisionsByRequest = new Map(decisions.map((decision) => [decision.requestId, decision]));
    const attemptsByRequest = latestAttemptsByRequest(attempts);
    const attemptCountsByRequest = attemptCounts(attempts);
    const classifierCostByRequest = classifierCostByRequestId(classifierUsageRows);
    const usageByRequest = options.aggregateUsageByRequest
      ? aggregateUsageByRequest(usageRows)
      : new Map<string, UsageAggregate>();
    const usageByAttempt = options.aggregateUsageByRequest
      ? new Map<string, UsageAggregate>()
      : new Map(usageRows.map((usage) => [usage.providerAttemptId, usageAggregateForRow(usage)]));

    const summaries = requestRows.map((request) => {
      const attempt = attemptsByRequest.get(request.id) ?? null;
      const attemptUsage = attempt ? usageByAttempt.get(attempt.id) ?? null : null;
      const usage = options.aggregateUsageByRequest
        ? usageByRequest.get(request.id) ?? null
        : attemptUsage;
      return requestSummary({
        request,
        decision: decisionsByRequest.get(request.id) ?? null,
        attempt,
        usage,
        classifierCost: classifierCostByRequest.get(request.id) ?? 0,
        attemptCount: attemptCountsByRequest.get(request.id) ?? 0
      }, pricing, costBaseline);
    });
    return summaries;
  }

  // Cached on the row array's identity: memoized row fetches return the same
  // array instance for repeated reads, so plain and aggregated summaries of
  // one row set share these three lookups. Callers with different filters
  // hold different arrays and fetch separately by design.
  private summaryInputsFor(requestRows: RequestRow[]) {
    const existing = this.summaryInputsCache.get(requestRows);
    if (existing) return existing;
    const pending = (async () => {
      const requestIds = requestRows.map((request) => request.id);
      const decisions = await this.db
        .select(requestSummaryDecisionColumns)
        .from(routeDecisions)
        .where(and(
          this.scopedTo(routeDecisions),
          inArray(routeDecisions.requestId, requestIds)
        ));
      const attempts = await this.db
        .select()
        .from(providerAttempts)
        .where(and(
          this.scopedTo(providerAttempts),
          inArray(providerAttempts.requestId, requestIds)
        ));
      const attemptIds = attempts.map((attempt) => attempt.id);
      const usageRows = attemptIds.length > 0
        ? await this.db
            .select()
            .from(usageLedger)
            .where(and(
              this.scopedTo(usageLedger),
              inArray(usageLedger.providerAttemptId, attemptIds)
            ))
        : [];
      // Classifier rows have no provider attempt, so they are keyed by request.
      const classifierUsageRows = requestIds.length > 0
        ? await this.db
            .select()
            .from(usageLedger)
            .where(and(
              this.scopedTo(usageLedger),
              inArray(usageLedger.requestId, requestIds),
              eq(usageLedger.kind, "classifier")
            ))
        : [];
      return { decisions, attempts, usageRows, classifierUsageRows };
    })().catch((error: unknown) => {
      this.summaryInputsCache.delete(requestRows);
      throw error;
    });
    this.summaryInputsCache.set(requestRows, pending);
    return pending;
  }

  private routeDecisionRowsForRequest(requestId: string) {
    return this.db
      .select()
      .from(routeDecisions)
      .where(and(
        this.scopedTo(routeDecisions),
        eq(routeDecisions.requestId, requestId)
      ))
      .orderBy(asc(routeDecisions.createdAt));
  }

  private providerAttemptRowsForRequest(requestId: string) {
    return this.db
      .select()
      .from(providerAttempts)
      .where(and(
        this.scopedTo(providerAttempts),
        eq(providerAttempts.requestId, requestId)
      ))
      .orderBy(asc(providerAttempts.startedAt));
  }


  // Sessions with a request inside the cache-warm window. Admin surfaces use
  // this to size warm traffic without reimplementing provider TTL policy.
  async activeSessionCount(withinMs = CACHE_TTL_DEFAULT_MS) {
    const since = new Date(Date.now() - withinMs);
    const [row] = await this.db
      .select({ count: sql<number>`count(distinct ${requests.sessionId})` })
      .from(requests)
      .where(and(
        this.scopedTo(requests),
        isNotNull(requests.sessionId),
        gte(requests.createdAt, since)
      ));
    return { activeSessions: Number(row?.count ?? 0), windowMs: withinMs };
  }

  async idleGaps(filters: DateRangeFilters = {}) {
    const start = dateValue(filters.start);
    const end = dateValue(filters.end);
    const conditions = [
      this.scopedTo(usageLedger),
      eq(usageLedger.kind, "provider"),
      isNotNull(usageLedger.sessionId)
    ];
    if (start) conditions.push(gte(usageLedger.createdAt, start));
    if (end) conditions.push(lte(usageLedger.createdAt, end));
    const rows = await this.db
      .select({
        sessionId: usageLedger.sessionId,
        requestId: usageLedger.requestId,
        provider: usageLedger.provider,
        inputTokens: usageLedger.inputTokens,
        cachedInputTokens: usageLedger.cachedInputTokens,
        cacheCreationInputTokens: usageLedger.cacheCreationInputTokens,
        createdAt: usageLedger.createdAt
      })
      .from(usageLedger)
      .where(and(...conditions))
      .orderBy(desc(usageLedger.createdAt))
      .limit(IDLE_GAP_SAMPLE_CAP);
    return aggregateIdleGaps(
      rows.map((row) => ({
        sessionId: row.sessionId ?? "",
        requestId: row.requestId,
        provider: row.provider,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheCreationInputTokens: row.cacheCreationInputTokens,
        createdAt: row.createdAt
      })),
      rows.length === IDLE_GAP_SAMPLE_CAP
    );
  }

  async cacheBusts(filters: DateRangeFilters = {}) {
    const start = dateValue(filters.start);
    const end = dateValue(filters.end);
    const conditions = [this.scopedTo(usageLedger), isNotNull(usageLedger.sessionId)];
    if (start) conditions.push(gte(usageLedger.createdAt, start));
    if (end) conditions.push(lte(usageLedger.createdAt, end));
    const rows = await this.db
      .select({
        sessionId: usageLedger.sessionId,
        requestId: usageLedger.requestId,
        provider: usageLedger.provider,
        model: usageLedger.model,
        inputTokens: usageLedger.inputTokens,
        cachedInputTokens: usageLedger.cachedInputTokens,
        cacheCreationInputTokens: usageLedger.cacheCreationInputTokens,
        createdAt: usageLedger.createdAt,
        translatorId: routeDecisions.translatorId,
        decisionLogicalModelId: routeDecisions.resolvedLogicalModelId,
        requestLogicalModelId: requests.resolvedLogicalModelId,
        decisionDeploymentId: routeDecisions.deploymentId,
        requestDeploymentId: requests.deploymentId
      })
      .from(usageLedger)
      .leftJoin(requests, and(
        this.scopedTo(requests),
        eq(requests.id, usageLedger.requestId)
      ))
      .leftJoin(routeDecisions, and(
        this.scopedTo(routeDecisions),
        eq(routeDecisions.requestId, usageLedger.requestId)
      ))
      .where(and(...conditions))
      .orderBy(desc(usageLedger.createdAt))
      .limit(CACHE_BUST_SAMPLE_CAP);
    const evidenceByRequest = await this.loadCacheBustEvidenceByRequest(rows.map((row) => row.requestId));
    const report = detectCacheBusts(rows.map((row) => ({
      ...evidenceByRequest.get(row.requestId),
      sessionId: row.sessionId ?? "",
      requestId: row.requestId,
      provider: row.provider,
      model: row.model,
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      createdAt: row.createdAt,
      translatorId: row.translatorId ?? undefined,
      logicalModelId: row.decisionLogicalModelId ?? row.requestLogicalModelId,
      deploymentId: row.decisionDeploymentId ?? row.requestDeploymentId
    })));
    return { ...report, sampled: rows.length === CACHE_BUST_SAMPLE_CAP };
  }

  private async loadCacheBustEvidenceByRequest(requestIds: string[]) {
    const uniqueRequestIds = [...new Set(requestIds)];
    if (uniqueRequestIds.length === 0) return new Map();
    const evidenceRows = await this.db
      .select({
        requestId: events.scopeId,
        eventType: events.eventType,
        payload: events.payload
      })
      .from(events)
      .where(and(
        this.scopedTo(events),
        eq(events.scopeType, "request"),
        inArray(events.scopeId, uniqueRequestIds),
        inArray(events.eventType, ["tokens.attributed", "routing.compression_evidence_recorded"])
      ))
      .orderBy(asc(events.createdAt));
    return cacheBustEvidenceByRequest(evidenceRows);
  }

  async promptCachePlans(filters: DateRangeFilters = {}) {
    const start = dateValue(filters.start);
    const end = dateValue(filters.end);
    const conditions = [this.scopedTo(events), eq(events.eventType, "prompt_cache.plan_applied")];
    if (start) conditions.push(gte(events.createdAt, start));
    if (end) conditions.push(lte(events.createdAt, end));
    const rows = await this.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.createdAt))
      .limit(PROMPT_CACHE_PLAN_SAMPLE_CAP);
    return aggregatePromptCachePlanReport(
      rows.map((row) => row.payload),
      rows.length === PROMPT_CACHE_PLAN_SAMPLE_CAP
    );
  }

  async promptCachePrewarms(filters: DateRangeFilters = {}) {
    const start = dateValue(filters.start);
    const end = dateValue(filters.end);
    const conditions = [this.scopedTo(events), inArray(events.eventType, PROMPT_CACHE_PREWARM_EVENTS)];
    if (start) conditions.push(gte(events.createdAt, start));
    if (end) conditions.push(lte(events.createdAt, end));
    const rows = await this.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.createdAt))
      .limit(PROMPT_CACHE_PREWARM_SAMPLE_CAP);
    return aggregatePromptCachePrewarmReport(
      rows.map((row) => row.payload),
      rows.length === PROMPT_CACHE_PREWARM_SAMPLE_CAP
    );
  }

  async tokenAttribution(filters: DateRangeFilters = {}) {
    const start = dateValue(filters.start);
    const end = dateValue(filters.end);
    const conditions = [this.scopedTo(events), eq(events.eventType, "tokens.attributed")];
    if (start) conditions.push(gte(events.createdAt, start));
    if (end) conditions.push(lte(events.createdAt, end));
    const rows = await this.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.createdAt))
      .limit(TOKEN_ATTRIBUTION_SAMPLE_CAP);
    return aggregateTokenAttribution(
      rows.map((row) => row.payload),
      rows.length === TOKEN_ATTRIBUTION_SAMPLE_CAP
    );
  }

  async compressionSavings(filters: DateRangeFilters = {}) {
    const start = dateValue(filters.start);
    const end = dateValue(filters.end);
    const conditions = [
      this.scopedTo(compressionReceipts),
      eq(compressionReceipts.status, "applied")
    ];
    if (start) conditions.push(gte(compressionReceipts.createdAt, start));
    if (end) conditions.push(lte(compressionReceipts.createdAt, end));
    const rows = await this.db
      .select()
      .from(compressionReceipts)
      .where(and(...conditions))
      .orderBy(desc(compressionReceipts.createdAt))
      .limit(COMPRESSION_SAVINGS_SAMPLE_CAP);
    return aggregateCompressionReceiptSavings(rows, rows.length === COMPRESSION_SAVINGS_SAMPLE_CAP);
  }

  private eventCount() {
    return this.cached("event-count", async () => {
      const [row] = await this.db
        .select({
          count: sql<number>`count(*)`
        })
        .from(events)
        .where(this.scopedTo(events));
      return Number(row?.count ?? 0);
    });
  }

  private lowConfidenceDecisionCount() {
    return this.cached("low-confidence-count", async () => {
    const threshold = 5_500;
      const [row] = await this.db
        .select({
          count: sql<number>`count(*)`
        })
        .from(routeDecisions)
        .where(and(
          this.scopedTo(routeDecisions),
          sql`${routeDecisions.confidence} is not null`,
          sql`${routeDecisions.confidence} < ${threshold}`
        ));
      return Number(row?.count ?? 0);
    });
  }


  private async promptRows(filters: PromptListFilters) {
    const conditions = promptConditions(this.organizationId, this.workspaceId, filters);
    return this.db
      .select({
        artifact: promptArtifacts,
        request: requests,
        decision: routeDecisions
      })
      .from(promptArtifacts)
      .innerJoin(requests, and(
        eq(requests.id, promptArtifacts.requestId),
        eq(requests.organizationId, promptArtifacts.organizationId)
      ))
      .leftJoin(routeDecisions, and(
        this.scopedTo(routeDecisions),
        eq(routeDecisions.requestId, requests.id),
        eq(routeDecisions.organizationId, requests.organizationId)
      ))
      .where(and(...conditions))
      .orderBy(desc(promptArtifacts.createdAt))
      .limit(promptLimit(filters.limit))
      .offset(promptOffset(filters.offset));
  }

  // Timelines include workspace events plus org-level events (null
  // workspace_id, e.g. membership changes) that reference the same scope.
  private eventWorkspaceScope() {
    return and(
      eq(events.organizationId, this.organizationId),
      or(isNull(events.workspaceId), eq(events.workspaceId, this.workspaceId))
    );
  }

  private async eventsForRequest(requestId: string) {
    const requestEvents = await this.db
      .select()
      .from(events)
      .where(and(
        this.eventWorkspaceScope(),
        eq(events.scopeId, requestId)
      ))
      .orderBy(events.sequence);
    const correlatedEvents = await this.db
      .select()
      .from(events)
      .where(and(
        this.eventWorkspaceScope(),
        eq(events.correlationId, requestId)
      ))
      .orderBy(events.createdAt);
    const seen = new Set<string>();
    return [...requestEvents, ...correlatedEvents]
      .filter((event) => {
        if (seen.has(event.id)) return false;
        seen.add(event.id);
        return true;
      })
      .map(eventSummary);
  }

  private async compressionReceiptsForRequest(requestId: string) {
    const rows = await this.db
      .select()
      .from(compressionReceipts)
      .where(and(
        this.scopedTo(compressionReceipts),
        eq(compressionReceipts.requestId, requestId)
      ))
      .orderBy(asc(compressionReceipts.createdAt), asc(compressionReceipts.blockPath), asc(compressionReceipts.ruleId));
    const artifactIds = [...new Set(rows.flatMap((row) => [
      row.originalArtifactId,
      row.compressedArtifactId
    ]).filter((id): id is string => id !== null))];
    const artifactExpiresAt = new Map<string, string | null>();
    if (artifactIds.length > 0) {
      const artifacts = await this.db
        .select({
          id: promptArtifacts.id,
          expiresAt: promptArtifacts.expiresAt
        })
        .from(promptArtifacts)
        .where(and(
          this.scopedTo(promptArtifacts),
          inArray(promptArtifacts.id, artifactIds)
        ));
      for (const artifact of artifacts) {
        artifactExpiresAt.set(artifact.id, artifact.expiresAt?.toISOString() ?? null);
      }
    }
    return rows.map((row) => compressionReceiptSummary(row, artifactExpiresAt));
  }

  private async eventsForSession(sessionId: string, requestIds: string[]) {
    const scopeConditions = [
      eq(events.sessionId, sessionId),
      eq(events.scopeId, sessionId)
    ];
    if (requestIds.length > 0) {
      scopeConditions.push(inArray(events.scopeId, requestIds));
      scopeConditions.push(inArray(events.correlationId, requestIds));
    }
    return this.db
      .select()
      .from(events)
      .where(and(
        this.eventWorkspaceScope(),
        or(...scopeConditions)
      ))
      .orderBy(asc(events.createdAt));
  }
}

type RequestRow = typeof requests.$inferSelect;
type ProviderAttemptRow = typeof providerAttempts.$inferSelect;
type SessionRow = typeof agentSessions.$inferSelect;
type UserRow = typeof usersTable.$inferSelect;
type MemberRow = typeof organizationMembers.$inferSelect;
type ApiKeySummaryRow = {
  id: string;
  organizationId: string;
  userId: string | null;
  name: string;
  accessProfileId: string | null;
  accessProfileName: string | null;
  accessProfileStatus: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

function compressionReceiptSummary(
  row: typeof compressionReceipts.$inferSelect,
  artifactExpiresAt: ReadonlyMap<string, string | null> = new Map()
) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    requestId: row.requestId,
    apiKeyId: row.apiKeyId,
    mode: row.mode,
    surface: row.surface,
    blockPath: row.blockPath,
    toolName: row.toolName,
    command: row.command,
    commandClass: row.commandClass,
    ruleId: row.ruleId,
    ruleVersion: row.ruleVersion,
    status: row.status,
    retrievalId: row.retrievalId,
    retrievalAvailable: row.retrievalAvailable,
    retrievalMarker: row.retrievalMarker,
    originalChars: row.originalChars,
    compressedChars: row.compressedChars,
    savedChars: row.savedChars,
    originalBytes: row.originalBytes,
    compressedBytes: row.compressedBytes,
    savedBytes: row.originalBytes - row.compressedBytes,
    originalEstimatedTokens: row.originalEstimatedTokens,
    compressedEstimatedTokens: row.compressedEstimatedTokens,
    savedEstimatedTokens: row.savedEstimatedTokens,
    originalTokenEstimate: row.originalEstimatedTokens,
    compressedTokenEstimate: row.compressedEstimatedTokens,
    savedTokens: row.savedEstimatedTokens,
    estimateSource: row.estimateSource,
    originalSha256: row.originalSha256,
    compressedSha256: row.compressedSha256,
    originalArtifactId: row.originalArtifactId,
    compressedArtifactId: row.compressedArtifactId,
    originalArtifactExpiresAt: row.originalArtifactId ? artifactExpiresAt.get(row.originalArtifactId) ?? null : null,
    compressedArtifactExpiresAt: row.compressedArtifactId ? artifactExpiresAt.get(row.compressedArtifactId) ?? null : null,
    skipReason: row.skipReason,
    eventId: row.eventId,
    createdAt: row.createdAt.toISOString()
  };
}

type PromptRow = {
  artifact: typeof promptArtifacts.$inferSelect;
  request: typeof requests.$inferSelect;
  decision: typeof routeDecisions.$inferSelect | null;
};

function promptConditions(organizationId: string, workspaceId: string, filters: PromptListFilters) {
  const conditions = [
    workspaceScope(promptArtifacts, organizationId, workspaceId),
    workspaceScope(requests, organizationId, workspaceId)
  ];
  if (filters.userId) conditions.push(eq(requests.userId, filters.userId));
  const surface = knownSurfaceValue(filters.surface);
  if (surface) conditions.push(eq(requests.surface, surface));
  if (filters.logicalModel) {
    conditions.push(eq(routeDecisions.resolvedLogicalModelId, filters.logicalModel));
  }
  if (filters.model) conditions.push(eq(routeDecisions.selectedModel, filters.model));
  const start = dateValue(filters.start);
  if (start) conditions.push(gte(promptArtifacts.createdAt, start));
  const end = dateValue(filters.end);
  if (end) conditions.push(lte(promptArtifacts.createdAt, end));
  return conditions;
}

function apiKeySummary(row: ApiKeySummaryRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId ?? null,
    name: row.name,
    accessProfileId: row.accessProfileId ?? null,
    accessProfile: row.accessProfileId
      ? {
          id: row.accessProfileId,
          name: row.accessProfileName ?? null,
          status: row.accessProfileStatus ?? null
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null
  };
}



function promptSummary(row: PromptRow, request?: RequestSummary | null) {
  return {
    artifactId: row.artifact.id,
    organizationId: row.artifact.organizationId,
    requestId: row.artifact.requestId,
    sessionId: row.request.sessionId ?? undefined,
    userId: row.request.userId ?? undefined,
    surface: row.request.surface,
    kind: row.artifact.kind,
    storageMode: row.artifact.storageMode,
    contentHash: row.artifact.contentHash,
    sourceRole: row.artifact.sourceRole ?? undefined,
    sourceIndex: row.artifact.sourceIndex ?? undefined,
    chars: numberFromMetadata(row.artifact.metadata, "chars"),
    tokenEstimate: row.artifact.tokenEstimate ?? undefined,
    preview: promptPreview(row.artifact.rawText ?? row.artifact.redactedText),
    requestedLogicalModel: row.decision?.requestedLogicalModel ?? row.request.requestedLogicalModel ?? undefined,
    resolvedLogicalModelId: row.decision?.resolvedLogicalModelId ?? row.request.resolvedLogicalModelId ?? undefined,
    accessProfileId: row.decision?.accessProfileId ?? row.request.accessProfileId ?? undefined,
    deploymentId: row.decision?.deploymentId ?? row.request.deploymentId ?? undefined,
    providerConnectionId: row.decision?.providerConnectionId ?? row.request.providerConnectionId ?? undefined,
    provider: row.decision?.selectedProvider ?? request?.provider ?? undefined,
    selectedModel: row.decision?.selectedModel ?? request?.selectedModel ?? undefined,
    routerDecision: row.decision?.routerDecision ?? undefined,
    cost: {
      selected: request?.selectedCost ?? 0
    },
    createdAt: row.artifact.createdAt.toISOString()
  };
}

function promptDetail(row: Pick<PromptRow, "artifact" | "request"> & Partial<Pick<PromptRow, "decision">>, request?: RequestSummary | null) {
  return {
    ...promptSummary({
      artifact: row.artifact,
      request: row.request,
      decision: row.decision ?? null
    }, request),
    rawText: row.artifact.rawText ?? null,
    redactedText: row.artifact.redactedText ?? null,
    encryptedBlobRef: row.artifact.encryptedBlobRef ?? null,
    metadata: row.artifact.metadata as JsonObject,
    expiresAt: row.artifact.expiresAt?.toISOString() ?? null
  };
}

function promptLimit(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

function requestListLimit(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return 200;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

function promptOffset(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function dateValue(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function promptPreview(value: string | null | undefined) {
  if (!value) return null;
  return value.length > 160 ? `${value.slice(0, 160)}...` : value;
}

function promptArtifactDetailColumns(includeContent: boolean) {
  return {
    id: promptArtifacts.id,
    organizationId: promptArtifacts.organizationId,
	    workspaceId: promptArtifacts.workspaceId,
	    requestId: promptArtifacts.requestId,
	    sessionId: promptArtifacts.sessionId,
	    kind: promptArtifacts.kind,
    storageMode: promptArtifacts.storageMode,
    contentHash: promptArtifacts.contentHash,
    rawText: includeContent ? promptArtifacts.rawText : promptArtifactPreviewColumn(promptArtifacts.rawText),
    tokenEstimate: promptArtifacts.tokenEstimate,
    sourceRole: promptArtifacts.sourceRole,
    sourceIndex: promptArtifacts.sourceIndex,
    redactedText: includeContent ? promptArtifacts.redactedText : promptArtifactPreviewColumn(promptArtifacts.redactedText),
    encryptedBlobRef: includeContent ? promptArtifacts.encryptedBlobRef : sql<string | null>`null`,
    metadata: promptArtifacts.metadata,
    expiresAt: promptArtifacts.expiresAt,
    createdAt: promptArtifacts.createdAt
  };
}

function promptArtifactPreviewColumn(column: typeof promptArtifacts.rawText | typeof promptArtifacts.redactedText) {
  return sql<string | null>`case when ${column} is null then null else substring(${column} from 1 for 161) end`;
}

function numberFromMetadata(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

const requestSummaryDecisionColumns = {
  requestId: routeDecisions.requestId,
  selectedProvider: routeDecisions.selectedProvider,
  selectedModel: routeDecisions.selectedModel,
  translated: routeDecisions.translated,
  reasoningEffort: routeDecisions.reasoningEffort,
  ingressWireId: routeDecisions.ingressWireId,
  operationId: routeDecisions.operationId,
  requestedLogicalModel: routeDecisions.requestedLogicalModel,
  resolvedLogicalModelId: routeDecisions.resolvedLogicalModelId,
  accessProfileId: routeDecisions.accessProfileId,
  routerKind: routeDecisions.routerKind,
  deploymentId: routeDecisions.deploymentId,
  providerConnectionId: routeDecisions.providerConnectionId,
  egressWireId: routeDecisions.egressWireId,
  wireAdapterVersion: routeDecisions.wireAdapterVersion,
  confidence: routeDecisions.confidence,
  routerDecisionId: routeDecisions.routerDecisionId,
  routerDecision: routeDecisions.routerDecision
};

type RequestSummaryDecisionRow = Pick<
  typeof routeDecisions.$inferSelect,
  | "requestId"
  | "selectedProvider"
  | "selectedModel"
  | "translated"
  | "reasoningEffort"
  | "ingressWireId"
  | "operationId"
  | "requestedLogicalModel"
  | "resolvedLogicalModelId"
  | "accessProfileId"
  | "routerKind"
  | "deploymentId"
  | "providerConnectionId"
  | "egressWireId"
  | "wireAdapterVersion"
  | "confidence"
  | "routerDecisionId"
  | "routerDecision"
>;

function requestSummary(row: {
  request: RequestRow;
  decision: RequestSummaryDecisionRow | null;
  attempt: ProviderAttemptRow | null;
  usage: UsageAggregate | null;
  classifierCost: number;
  attemptCount: number;
}, pricing: ModelPricingTable, costBaseline: CostBaseline) {
  const usage = row.usage
    ? {
        inputTokens: row.usage.inputTokens,
        cachedInputTokens: row.usage.cachedInputTokens,
        cacheCreationInputTokens: row.usage.cacheCreationInputTokens,
        outputTokens: row.usage.outputTokens,
        reasoningTokens: row.usage.reasoningTokens,
        totalTokens: row.usage.totalTokens
      }
    : emptyUsage();
  const selectedModel = row.decision?.selectedModel ?? row.attempt?.model ?? undefined;
  const selectedProvider = row.decision?.selectedProvider ?? row.attempt?.provider ?? undefined;
  // A decision row without a model means the router rejected the request
  // before selecting one (budget/compatibility); no decision at all means the
  // request died before routing finished.
  const rejected = !selectedModel && row.decision !== null;
  const providerCost = (row.usage?.totalCostMicros ?? 0) / 1_000_000;
  // Selected spend is what we actually pay: the provider response plus the
  // routing classifier's own call. Baseline is the no-routing counterfactual,
  // so the classifier (which only exists because we route) is excluded from it
  // — savings therefore absorb the routing overhead honestly.
  const classifierCost = row.classifierCost;
  const selectedCost = providerCost + classifierCost;
  const baselineCost = baselineCostFor(
    pricing,
    costBaseline,
    row.request.surface,
    selectedProvider,
    usage
  );
  return {
    requestId: row.request.id,
    userId: row.request.userId ?? undefined,
    sessionId: row.request.sessionId ?? undefined,
    apiKeyId: row.request.apiKeyId ?? undefined,
    surface: row.request.surface,
    requestedModel: row.request.requestedModel,
    ingressWireId: row.decision?.ingressWireId ?? row.request.ingressWireId ?? undefined,
    operationId: row.decision?.operationId ?? row.request.operationId ?? undefined,
    requestedLogicalModel: row.decision?.requestedLogicalModel ?? row.request.requestedLogicalModel ?? undefined,
    resolvedLogicalModelId: row.decision?.resolvedLogicalModelId ?? row.request.resolvedLogicalModelId ?? undefined,
    accessProfileId: row.decision?.accessProfileId ?? row.request.accessProfileId ?? undefined,
    routerKind: row.decision?.routerKind ?? row.request.routerKind ?? undefined,
    deploymentId: row.decision?.deploymentId ?? row.request.deploymentId ?? undefined,
    providerConnectionId: row.decision?.providerConnectionId ?? row.request.providerConnectionId ?? undefined,
    egressWireId: row.decision?.egressWireId ?? row.request.egressWireId ?? undefined,
    wireAdapterVersion: row.decision?.wireAdapterVersion ?? row.request.wireAdapterVersion ?? undefined,
    reasoningEffort: row.decision?.reasoningEffort ?? undefined,
    provider: row.decision?.selectedProvider ?? row.attempt?.provider ?? undefined,
    selectedModel,
    translated: row.decision?.translated ?? false,
    rejected,
    confidence: row.decision?.confidence ?? null,
    routerDecisionId: row.decision?.routerDecisionId ?? undefined,
    routerDecision: row.decision?.routerDecision ?? {},
    terminalStatus: row.attempt?.terminalStatus ?? row.request.status,
    inputChars: row.request.inputChars,
    usage,
    latencyMs: elapsedMs(row.attempt?.startedAt, row.attempt?.completedAt),
    timeToFirstByteMs: elapsedMs(row.attempt?.startedAt, row.attempt?.firstByteAt),
    attemptCount: row.attemptCount,
    selectedCost,
    providerCost,
    classifierCost,
    baselineCost,
    savings: baselineCost - selectedCost,
    createdAt: row.request.createdAt.toISOString(),
    completedAt: row.request.completedAt?.toISOString() ?? undefined
  };
}

type RequestSummary = ReturnType<typeof requestSummary>;
type SummaryInputs = {
  decisions: RequestSummaryDecisionRow[];
  attempts: ProviderAttemptRow[];
  usageRows: (typeof usageLedger.$inferSelect)[];
  classifierUsageRows: (typeof usageLedger.$inferSelect)[];
};
type UsageGroupBy =
  | "user"
  | "api_key"
  | "provider"
  | "model"
  | "model_effort"
  | "logical_model"
  | "deployment"
  | "surface"
  | "session";
type UsageInterval = "hour" | "day";
type UsageGroup = {
  key: string;
  requestCount: number;
  failedRequests: number;
  retriedRequests: number;
  usage: ReturnType<typeof emptyUsage>;
  cost: {
    selected: number;
    baseline: number;
    savings: number;
    classifier: number;
  };
};

type OpenAICacheAggregate = {
  requestCount: number;
  cachedRequests: number;
  inputTokens: number;
  cachedInputTokens: number;
};

const ALL_REQUEST_ROWS_KEY = "requests:all";

function sessionIdsForRequests(requests: RequestSummary[]) {
  return requests.flatMap((request) => request.sessionId ? [request.sessionId] : []);
}

const USER_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function userSummary(
  user: UserRow,
  allRequests: RequestSummary[],
  allSessions: SessionRow[],
  member?: MemberRow,
  apiKeyCount = 0
) {
  const requests = allRequests.filter((request) => request.userId === user.id);
  const requestSessionIds = new Set(sessionIdsForRequests(requests));
  const sessions = allSessions.filter((session) =>
    session.userId === user.id || requestSessionIds.has(session.id)
  );
  const windowStart = Date.now() - USER_USAGE_WINDOW_MS;
  const recentRequests = requests.filter((request) => timestampFromIso(request.createdAt) >= windowStart);
  return {
    userId: user.id,
    email: user.email ?? undefined,
    name: user.name ?? undefined,
    externalId: user.externalId ?? undefined,
    membership: member ? { role: member.role, status: member.status } : null,
    apiKeyCount,
    requestCount: requests.length,
    sessionCount: sessions.length,
    usage: usageTotals(requests),
    cost: costTotals(requests),
    usage30d: usageTotals(recentRequests),
    cost30d: costTotals(recentRequests),
    recentActivity: recentActivity(requests, sessions),
    createdAt: user.createdAt.toISOString()
  };
}

function sessionSummary(session: SessionRow, allRequests: RequestSummary[]) {
  const requests = allRequests.filter((request) => request.sessionId === session.id);
  return {
    sessionId: session.id,
    organizationId: session.organizationId,
    userId: session.userId ?? undefined,
    surface: session.surface,
    externalSessionId: session.externalSessionId ?? undefined,
    sessionIdentity: stringFromMetadata(session.metadata, "sessionIdentity"),
    requestCount: requests.length,
    logicalModelChanges: logicalModelChangeCount(requests),
    modelMix: countBy(requests, (request) => request.selectedModel ?? (request.rejected ? "rejected" : "unknown")),
    logicalModelMix: countBy(requests, (request) => request.requestedLogicalModel ?? "unknown"),
    deploymentMix: countBy(requests, (request) => request.deploymentId ?? "unknown"),
    terminalStatusSummary: countBy(requests, (request) => request.terminalStatus),
    usage: usageTotals(requests),
    cacheHitRate: cacheHitRate(requests),
    cost: costTotals(requests),
    recentActivity: recentActivity(requests, [session]),
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? undefined,
    updatedAt: session.updatedAt.toISOString()
  };
}

function usageTotals(requests: RequestSummary[]) {
  return requests.reduce((acc, request) => {
    addUsageTotals(acc, request.usage);
    return acc;
  }, emptyUsage());
}

function addUsageTotals(target: ReturnType<typeof emptyUsage>, usage: ReturnType<typeof emptyUsage>) {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.totalTokens += usage.totalTokens;
}

// Hit rate over total prompt input. Usage is stored under the normalized
// convention (see normalizeUsage): inputTokens is the TOTAL prompt input with
// cache reads/writes as billed-differently subsets, for every provider.
function cacheHitRate(requests: RequestSummary[]) {
  let hits = 0;
  let total = 0;
  for (const request of requests) {
    hits += request.usage.cachedInputTokens;
    total += request.usage.inputTokens;
  }
  return total > 0 ? hits / total : null;
}

function costTotals(requests: RequestSummary[]) {
  return requests.reduce((acc, request) => {
    acc.selected += request.selectedCost;
    acc.baseline += request.baselineCost;
    acc.savings += request.savings;
    acc.classifier += request.classifierCost;
    return acc;
  }, { selected: 0, baseline: 0, savings: 0, classifier: 0 });
}

function recentActivity(requests: RequestSummary[], sessions: SessionRow[]) {
  const times = [
    ...requests.map((request) => new Date(request.createdAt).getTime()),
    ...sessions.map((session) => session.updatedAt.getTime())
  ].filter((time) => Number.isFinite(time));
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

function compareRecentActivity(left: string | null, right: string | null) {
  return timestampFromIso(right) - timestampFromIso(left);
}

function timestampFromIso(value: string | null) {
  return value ? new Date(value).getTime() : 0;
}

function logicalModelChangeCount(requests: RequestSummary[]) {
  let previousModel: string | undefined;
  let changes = 0;
  for (const request of [...requests].sort((left, right) =>
    timestampFromIso(left.createdAt) - timestampFromIso(right.createdAt)
  )) {
    if (!request.requestedLogicalModel) continue;
    if (previousModel && previousModel !== request.requestedLogicalModel) changes += 1;
    previousModel = request.requestedLogicalModel;
  }
  return changes;
}

function countBy<T>(items: T[], keyFor: (item: T) => string) {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFor(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function stringFromMetadata(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function usageGroupBy(value: string | undefined): UsageGroupBy {
  if (
    value === "user" ||
    value === "api_key" ||
    value === "provider" ||
    value === "model" ||
    value === "model_effort" ||
    value === "logical_model" ||
    value === "deployment" ||
    value === "surface" ||
    value === "session"
  ) {
    return value;
  }
  return "model";
}

function emptyUsageGroup(key: string): UsageGroup {
  return {
    key,
    requestCount: 0,
    failedRequests: 0,
    retriedRequests: 0,
    usage: emptyUsage(),
    cost: {
      selected: 0,
      baseline: 0,
      savings: 0,
      classifier: 0
    }
  };
}

function mergeUsageGroup(target: UsageGroup, source: UsageGroup) {
  target.requestCount += source.requestCount;
  target.failedRequests += source.failedRequests;
  target.retriedRequests += source.retriedRequests;
  addUsageTotals(target.usage, source.usage);
  target.cost.selected += source.cost.selected;
  target.cost.baseline += source.cost.baseline;
  target.cost.savings += source.cost.savings;
  target.cost.classifier += source.cost.classifier;
}

function emptyOpenAICacheAggregate(): OpenAICacheAggregate {
  return {
    requestCount: 0,
    cachedRequests: 0,
    inputTokens: 0,
    cachedInputTokens: 0
  };
}

function addOpenAICacheAggregate(target: OpenAICacheAggregate, source: OpenAICacheAnalyticsRow | OpenAICacheTrendRow) {
  target.requestCount += source.requestCount;
  target.cachedRequests += source.cachedRequests;
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
}

function finalizeOpenAICacheAggregate(aggregate: OpenAICacheAggregate) {
  return {
    requestCount: aggregate.requestCount,
    cachedRequests: aggregate.cachedRequests,
    inputTokens: aggregate.inputTokens,
    cachedInputTokens: aggregate.cachedInputTokens,
    cacheHitRate: tokenHitRate(aggregate),
    requestHitRate: requestHitRate(aggregate)
  };
}

function finalizeOpenAICacheGroup(row: OpenAICacheAnalyticsRow) {
  return {
    surface: row.surface,
    provider: row.provider,
    model: row.model,
    logicalModel: row.logicalModel,
    cacheGroupSource: row.cacheGroupSource,
    cacheGroupKey: row.cacheGroupKey,
    ...finalizeOpenAICacheAggregate(row)
  };
}

function finalizeOpenAICacheTrend(row: OpenAICacheTrendRow) {
  return {
    ts: new Date(row.bucketTs).toISOString(),
    ...finalizeOpenAICacheAggregate(row)
  };
}

function tokenHitRate(row: Pick<OpenAICacheAggregate, "inputTokens" | "cachedInputTokens">) {
  return row.inputTokens > 0 ? row.cachedInputTokens / row.inputTokens : 0;
}

function requestHitRate(row: Pick<OpenAICacheAggregate, "requestCount" | "cachedRequests">) {
  return row.requestCount > 0 ? row.cachedRequests / row.requestCount : 0;
}

function compareOpenAICacheGroups(
  left: ReturnType<typeof finalizeOpenAICacheGroup>,
  right: ReturnType<typeof finalizeOpenAICacheGroup>
) {
  return (right.cachedInputTokens - left.cachedInputTokens) ||
    (right.requestCount - left.requestCount) ||
    left.provider.localeCompare(right.provider) ||
    left.model.localeCompare(right.model) ||
    left.logicalModel.localeCompare(right.logicalModel) ||
    left.cacheGroupSource.localeCompare(right.cacheGroupSource) ||
    left.cacheGroupKey.localeCompare(right.cacheGroupKey);
}

function modelUsageReportFromRequests(requests: RequestSummary[]) {
  const totals = emptyUsageGroup("total");
  const groups = new Map<string, UsageGroup>();
  for (const request of requests) {
    const key = request.selectedModel ?? "unknown";
    const group = groups.get(key) ?? emptyUsageGroup(key);
    addRequestToUsageGroup(group, request);
    addRequestToUsageGroup(totals, request);
    groups.set(key, group);
  }
  return {
    groupBy: "model" as const,
    data: [...groups.values()]
      .sort(compareUsageGroups)
      .map((group) => finalizeUsageGroup(group, { averageMs: null, p95Ms: null })),
    totals: finalizeUsageGroup(totals, { averageMs: null, p95Ms: null })
  };
}

function addRequestToUsageGroup(group: UsageGroup, request: RequestSummary) {
  group.requestCount += 1;
  if (request.terminalStatus === "failed") group.failedRequests += 1;
  if ((request.attemptCount ?? 0) > 1) group.retriedRequests += 1;
  addUsageTotals(group.usage, request.usage);
  group.cost.selected += request.selectedCost;
  group.cost.baseline += request.baselineCost;
  group.cost.savings += request.savings;
  group.cost.classifier += request.classifierCost;
}

function finalizeUsageGroup(group: UsageGroup, latency: ReturnType<typeof latencySummaryFromRow>) {
  return {
    key: group.key,
    requestCount: group.requestCount,
    failedRequests: group.failedRequests,
    retriedRequests: group.retriedRequests,
    failureRate: group.requestCount === 0 ? 0 : group.failedRequests / group.requestCount,
    retryRate: group.requestCount === 0 ? 0 : group.retriedRequests / group.requestCount,
    latency,
    usage: group.usage,
    cost: {
      selected: costAmount(group.cost.selected),
      baseline: costAmount(group.cost.baseline),
      savings: costAmount(group.cost.savings),
      classifier: costAmount(group.cost.classifier)
    }
  };
}

function costAmount(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function latencySummaryFromRow(row: UsageLatencyRow | undefined) {
  if (!row || row.averageMs === null || row.p95Ms === null) {
    return { averageMs: null as number | null, p95Ms: null as number | null };
  }
  return { averageMs: Math.round(row.averageMs), p95Ms: Math.round(row.p95Ms) };
}

function usageScopeKey(scope: UsageRollupScope) {
  return `${scope.start?.toISOString() ?? ""}:${scope.end?.toISOString() ?? ""}`;
}

type PromptCachePlanAggregateRow = {
  provider: string;
  model: string;
  mode: string;
  count: number;
  appliedControls: number;
  skippedControls: number;
};

type PromptCacheControlAggregateRow = {
  provider: string;
  model: string;
  mode: string;
  control: string;
  status: string;
  reason: string;
  count: number;
};

type PromptCachePrewarmAggregateRow = {
  provider: string;
  model: string;
  status: string;
  count: number;
  estimatedCostMicros: number;
  actualCostMicros: number;
  expiredUnusedCostMicros: number;
  cacheReadLiftTokens: number;
};

function aggregatePromptCachePlanReport(payloads: unknown[], sampled: boolean) {
  const plans = new Map<string, PromptCachePlanAggregateRow>();
  const controls = new Map<string, PromptCacheControlAggregateRow>();
  let totalPlans = 0;

  for (const payload of payloads) {
    if (!isRecord(payload)) continue;
    totalPlans += 1;
    const provider = boundedPlanValue(payload.provider, "unknown");
    const model = boundedPlanValue(payload.model, "unknown");
    const mode = boundedPlanValue(payload.mode, "unknown");
    const planKey = promptCachePlanKey(provider, model, mode);
    const plan = plans.get(planKey) ?? {
      provider,
      model,
      mode,
      count: 0,
      appliedControls: 0,
      skippedControls: 0
    };
    plan.count += 1;

    const appliedControls = Array.isArray(payload.appliedControls)
      ? payload.appliedControls.filter((control): control is string => typeof control === "string")
      : [];
    for (const control of appliedControls) {
      plan.appliedControls += 1;
      incrementPromptCacheControl(controls, {
        provider,
        model,
        mode,
        control: boundedPlanValue(control, "unknown"),
        status: "applied",
        reason: "none"
      });
    }

    const skippedControls = Array.isArray(payload.skippedControls) ? payload.skippedControls : [];
    for (const skipped of skippedControls) {
      if (!isRecord(skipped)) continue;
      plan.skippedControls += 1;
      incrementPromptCacheControl(controls, {
        provider,
        model,
        mode,
        control: boundedPlanValue(skipped.control, "unknown"),
        status: "skipped",
        reason: boundedPlanValue(skipped.reason, "unknown")
      });
    }

    plans.set(planKey, plan);
  }

  return {
    totalPlans,
    sampled,
    plans: [...plans.values()].sort(comparePromptCachePlans),
    controls: [...controls.values()].sort(comparePromptCacheControls)
  };
}

function aggregatePromptCachePrewarmReport(payloads: unknown[], sampled: boolean) {
  const latestByJobId = new Map<string, Record<string, unknown>>();
  for (const payload of payloads) {
    if (!isRecord(payload)) continue;
    const jobId = boundedPlanValue(payload.jobId, "");
    if (!jobId || latestByJobId.has(jobId)) continue;
    latestByJobId.set(jobId, payload);
  }

  const jobs = new Map<string, PromptCachePrewarmAggregateRow>();
  const totals = {
    totalJobs: latestByJobId.size,
    estimatedCostMicros: 0,
    actualCostMicros: 0,
    expiredUnusedCostMicros: 0,
    cacheReadLiftTokens: 0
  };

  for (const payload of latestByJobId.values()) {
    const provider = boundedPlanValue(payload.provider, "unknown");
    const model = boundedPlanValue(payload.model, "unknown");
    const status = boundedPlanValue(payload.status, "unknown");
    const estimatedCostMicros = finiteNumber(payload.estimatedCostMicros);
    const actualCostMicros = finiteNumber(payload.actualCostMicros);
    const cacheReadLiftTokens = finiteNumber(payload.cacheReadLiftTokens);
    const expiredUnusedCostMicros = status === "expired_unused"
      ? actualCostMicros || estimatedCostMicros
      : 0;
    const key = [provider, model, status].join("\0");
    const row = jobs.get(key) ?? {
      provider,
      model,
      status,
      count: 0,
      estimatedCostMicros: 0,
      actualCostMicros: 0,
      expiredUnusedCostMicros: 0,
      cacheReadLiftTokens: 0
    };
    row.count += 1;
    row.estimatedCostMicros += estimatedCostMicros;
    row.actualCostMicros += actualCostMicros;
    row.expiredUnusedCostMicros += expiredUnusedCostMicros;
    row.cacheReadLiftTokens += cacheReadLiftTokens;
    jobs.set(key, row);

    totals.estimatedCostMicros += estimatedCostMicros;
    totals.actualCostMicros += actualCostMicros;
    totals.expiredUnusedCostMicros += expiredUnusedCostMicros;
    totals.cacheReadLiftTokens += cacheReadLiftTokens;
  }

  return {
    ...totals,
    sampled,
    jobs: [...jobs.values()].sort(comparePromptCachePrewarmJobs)
  };
}

function incrementPromptCacheControl(
  controls: Map<string, PromptCacheControlAggregateRow>,
  input: Omit<PromptCacheControlAggregateRow, "count">
) {
  const key = [
    input.provider,
    input.model,
    input.mode,
    input.control,
    input.status,
    input.reason
  ].join("\0");
  const row = controls.get(key) ?? { ...input, count: 0 };
  row.count += 1;
  controls.set(key, row);
}

function promptCachePlanKey(provider: string, model: string, mode: string) {
  return `${provider}\0${model}\0${mode}`;
}

function boundedPlanValue(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function comparePromptCachePlans(
  left: PromptCachePlanAggregateRow,
  right: PromptCachePlanAggregateRow
) {
  return right.count - left.count ||
    left.provider.localeCompare(right.provider) ||
    left.model.localeCompare(right.model) ||
    left.mode.localeCompare(right.mode);
}

function comparePromptCacheControls(
  left: PromptCacheControlAggregateRow,
  right: PromptCacheControlAggregateRow
) {
  return right.count - left.count ||
    left.provider.localeCompare(right.provider) ||
    left.model.localeCompare(right.model) ||
    left.mode.localeCompare(right.mode) ||
    left.control.localeCompare(right.control) ||
    left.status.localeCompare(right.status) ||
    left.reason.localeCompare(right.reason);
}

function comparePromptCachePrewarmJobs(
  left: PromptCachePrewarmAggregateRow,
  right: PromptCachePrewarmAggregateRow
) {
  return right.count - left.count ||
    left.provider.localeCompare(right.provider) ||
    left.model.localeCompare(right.model) ||
    left.status.localeCompare(right.status);
}

/**
 * Spend ranks groups; tokens and request counts break ties while pricing is
 * unset. The key tiebreak keeps fully tied groups in a stable order — SQL
 * rollup row order is not deterministic.
 */
function compareUsageGroups(
  left: { key: string; requestCount: number; usage: { totalTokens: number }; cost: { selected: number } },
  right: { key: string; requestCount: number; usage: { totalTokens: number }; cost: { selected: number } }
) {
  return (right.cost.selected - left.cost.selected) ||
    (right.usage.totalTokens - left.usage.totalTokens) ||
    (right.requestCount - left.requestCount) ||
    left.key.localeCompare(right.key);
}

function usageInterval(value: string | undefined): UsageInterval {
  return value === "hour" ? "hour" : "day";
}

function intervalMs(interval: UsageInterval) {
  return interval === "hour" ? 3_600_000 : 86_400_000;
}

/** UTC bucket floor; hour and day intervals both align with the epoch. */
function bucketStart(ts: number, interval: UsageInterval) {
  const step = intervalMs(interval);
  return ts - (ts % step);
}

const MAX_TIMESERIES_BUCKETS = 400;

function timeseriesWindow(earliestMs: number | undefined, filters: UsageTimeseriesFilters, interval: UsageInterval) {
  const end = bucketStart(dateValue(filters.end)?.getTime() ?? Date.now(), interval);
  const start = bucketStart(dateValue(filters.start)?.getTime() ?? earliestMs ?? end, interval);
  const step = intervalMs(interval);
  const clampedStart = Math.max(Math.min(start, end), end - (MAX_TIMESERIES_BUCKETS - 1) * step);
  return { start: clampedStart, end };
}

function timeseriesGroupLimit(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(25, Math.floor(value)));
}
function baselineCostFor(
  pricing: ModelPricingTable,
  costBaseline: CostBaseline,
  surface: string,
  selectedProvider: string | undefined,
  usage: ReturnType<typeof emptyUsage>
) {
  const compatibleSurface = knownSurfaceValue(surface);
  if (!compatibleSurface) return 0;
  const provider = selectedProvider ?? providerForDialect(compatibleSurface);
  const model = baselineModelForDialect(costBaseline, compatibleSurface);
  if (!provider) return 0;
  if (!model) return 0;
  return usageCostMicros(pricingForProviderModel(pricing, provider, model), usage).totalCostMicros / 1_000_000;
}

function elapsedMs(start: Date | null | undefined, end: Date | null | undefined) {
  if (!start || !end) return undefined;
  return end.getTime() - start.getTime();
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
}
