import { performance } from "node:perf_hooks";

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import {
  agentSessions,
  apiKeyProviderAccounts,
  apiKeys,
  compressionReceipts,
  events,
  invitations,
  modelCatalog,
  organizationMembers,
  organizations,
  promptArtifacts,
  providers,
  providerAccounts,
  providerAccountHealth,
  providerAttempts,
  providerModelHealth,
  requests,
  routeDecisions,
  routingConfigs,
  routingConfigVersions,
  users as usersTable,
  usageLedger,
  type ProxyDbSession
} from "@proxy/db";

import { explicitAlias } from "../catalog.js";
import {
  applyPricingToEntry,
  baselineModelForDialect,
  compareModelPricingEntries,
  emptyPricingEntry,
  pricingForProviderModel,
  providerForDialect,
  providerModelPricingKey,
  undatedModel,
  usageCostMicros,
  type CostBaseline,
  type ModelPricing,
  type ModelPricingEntry,
  type ModelPricingTable
} from "../pricing.js";
import type { ProviderAccountAuthType } from "@proxy/schema";

import type { JsonObject, RouteName } from "../types.js";
import { searchAdminEntities } from "./adminSearch.js";
import { workspaceScope } from "./scope.js";
import {
  eventSummary,
  invitationSummary,
  providerAttemptSummary,
  routingConfigRoutesSummary,
  routeDecisionSummary,
  routingConfigSummary,
  usageLedgerSummary
} from "./adminSerializers.js";
import { CACHE_TTL_DEFAULT_MS } from "../cacheWindows.js";
import { CACHE_BUST_SAMPLE_CAP, detectCacheBusts } from "./cacheBusts.js";
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
  providerSkipReasonsByRequest,
  usageAggregateForRow,
  type UsageAggregate
} from "./adminRequestUsage.js";
import { aggregateTokenAttribution, TOKEN_ATTRIBUTION_SAMPLE_CAP } from "./tokenAttributionReport.js";
import {
  OTHER_ROLLUP_GROUP_KEY,
  usageBucketRollupReportRows,
  usageRollupReportRows,
  type UsageBucketRollupReport,
  type UsageLatencyRow,
  type UsageRollupReport,
  type UsageRollupRow,
  type UsageRollupScope
} from "./usageRollups.js";
import { knownSurfaceValue, routeValue } from "./values.js";
import {
  type MetricsCollector,
  NoopMetricsCollector
} from "../metrics.js";

type DateRangeFilters = {
  start?: string;
  end?: string;
};

export type AdminQueryConfig = {
  routeQualityLowConfidenceThreshold: number;
  classifierModel: string;
  classifierProvider: string;
};

export type PromptListFilters = {
  limit?: number;
  offset?: number;
  userId?: string;
  surface?: string;
  route?: string;
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
    private readonly config: AdminQueryConfig,
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
        lowConfidenceCount,
        cheaperLikelyWouldWorkCount: requestSummaries.filter((request) =>
          routeIndex(routeValue(request.finalRoute)) > routeIndex("fast") &&
          request.usage.totalTokens < 1000
        ).length,
        cheapCausedRetriesOrRepairsCount: requestSummaries.filter((request) =>
          (request.finalRoute === "fast" || request.finalRoute === "balanced") &&
          request.terminalStatus === "failed"
        ).length
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
    const bindings = await this.apiKeyProviderBindings(rows.map((row) => row.id));
    return {
      data: rows.map((row) => apiKeySummary(row, bindings.get(row.id) ?? []))
    };
  }

  async apiKeyDetail(apiKeyId: string) {
    const [row] = await this.apiKeyRows(apiKeyId);
    if (!row) return null;
    const bindings = await this.apiKeyProviderBindings([apiKeyId]);
    return { apiKey: apiKeySummary(row, bindings.get(apiKeyId) ?? []) };
  }

  async providerAccounts() {
    const rows = await this.db
      .select({
        id: providerAccounts.id,
        organizationId: providerAccounts.organizationId,
        providerId: providerAccounts.providerId,
        provider: providers.slug,
        name: providerAccounts.name,
        baseUrl: providerAccounts.baseUrl,
        authType: providerAccounts.authType,
        status: providerAccounts.status,
        secretHint: providerAccounts.secretHint,
        createdByUserId: providerAccounts.createdByUserId,
        createdAt: providerAccounts.createdAt,
        lastUsedAt: providerAccounts.lastUsedAt
      })
      .from(providerAccounts)
      .innerJoin(providers, eq(providers.id, providerAccounts.providerId))
      .where(and(
        eq(providerAccounts.organizationId, this.organizationId),
        isNotNull(providerAccounts.secretCiphertext)
      ))
      .orderBy(desc(providerAccounts.createdAt));

    const providerAccountIds = rows.map((row) => row.id);
    const boundCounts = await this.providerAccountBoundKeyCounts(providerAccountIds);
    const accountHealth = await this.providerAccountHealthRows(providerAccountIds);
    const modelHealth = await this.providerModelHealthRows(providerAccountIds);
    return {
      data: rows.map((row) => providerAccountSummary(
        row,
        boundCounts.get(row.id) ?? 0,
        accountHealth.get(row.id) ?? null,
        modelHealth.get(row.id) ?? []
      ))
    };
  }

  async providers() {
    const rows = await this.db
      .select({
        id: providers.id,
        organizationId: providers.organizationId,
        slug: providers.slug,
        displayName: providers.displayName,
        baseUrl: providers.baseUrl,
        authStyle: providers.authStyle,
        endpoints: providers.endpoints,
        defaultHeaders: providers.defaultHeaders,
        capabilities: providers.capabilities,
        forwardHarnessHeaders: providers.forwardHarnessHeaders,
        enabled: providers.enabled
      })
      .from(providers)
      .where(or(
        isNull(providers.organizationId),
        eq(providers.organizationId, this.organizationId)
      ))
      .orderBy(asc(providers.slug), asc(providers.organizationId));

    const bySlug = new Map<string, ReturnType<typeof providerRegistrySummary>>();
    for (const row of rows) {
      const summary = providerRegistrySummary(row);
      const existing = bySlug.get(row.slug);
      if (!existing || row.organizationId === this.organizationId) bySlug.set(row.slug, summary);
    }
    return {
      data: [...bySlug.values()].sort((left, right) => left.slug.localeCompare(right.slug))
    };
  }

  private async apiKeyProviderBindings(apiKeyIds: string[]) {
    const bindings = new Map<string, ProviderBindingSummary[]>();
    if (apiKeyIds.length === 0) return bindings;
    const rows = await this.db
      .select({
        apiKeyId: apiKeyProviderAccounts.apiKeyId,
        provider: providers.slug,
        providerId: apiKeyProviderAccounts.providerId,
        providerAccountId: apiKeyProviderAccounts.providerAccountId,
        providerAccountName: providerAccounts.name,
        providerAccountStatus: providerAccounts.status
      })
      .from(apiKeyProviderAccounts)
      .innerJoin(providers, eq(providers.id, apiKeyProviderAccounts.providerId))
      .leftJoin(providerAccounts, and(
        eq(providerAccounts.organizationId, apiKeyProviderAccounts.organizationId),
        eq(providerAccounts.id, apiKeyProviderAccounts.providerAccountId)
      ))
      .where(and(
        this.scopedTo(apiKeyProviderAccounts),
        inArray(apiKeyProviderAccounts.apiKeyId, apiKeyIds)
      ));
    for (const row of rows) {
      const list = bindings.get(row.apiKeyId) ?? [];
      list.push({
        provider: row.provider,
        providerId: row.providerId,
        providerAccountId: row.providerAccountId,
        name: row.providerAccountName ?? null,
        status: row.providerAccountStatus ?? null
      });
      bindings.set(row.apiKeyId, list);
    }
    return bindings;
  }

  private async providerAccountBoundKeyCounts(providerAccountIds: string[]) {
    const counts = new Map<string, number>();
    if (providerAccountIds.length === 0) return counts;
    // Deliberately org-wide (no workspaceScope): provider accounts are an
    // org-level screen, so the bound-key count covers every workspace.
    const rows = await this.db
      .select({
        providerAccountId: apiKeyProviderAccounts.providerAccountId,
        count: sql<number>`count(*)`
      })
      .from(apiKeyProviderAccounts)
      .where(and(
        eq(apiKeyProviderAccounts.organizationId, this.organizationId),
        inArray(apiKeyProviderAccounts.providerAccountId, providerAccountIds)
      ))
      .groupBy(apiKeyProviderAccounts.providerAccountId);
    for (const row of rows) counts.set(row.providerAccountId, Number(row.count));
    return counts;
  }

  private async providerAccountHealthRows(providerAccountIds: string[]) {
    const rowsByAccount = new Map<string, ProviderAccountHealthRow>();
    if (providerAccountIds.length === 0) return rowsByAccount;
    const rows = await this.db
      .select({
        providerAccountId: providerAccountHealth.providerAccountId,
        status: providerAccountHealth.status,
        lastErrorType: providerAccountHealth.lastErrorType,
        lastErrorAt: providerAccountHealth.lastErrorAt,
        cooldownUntil: providerAccountHealth.cooldownUntil,
        consecutiveFailures: providerAccountHealth.consecutiveFailures,
        lastSuccessAt: providerAccountHealth.lastSuccessAt,
        lastCheckedAt: providerAccountHealth.lastCheckedAt
      })
      .from(providerAccountHealth)
      .where(and(
        eq(providerAccountHealth.organizationId, this.organizationId),
        inArray(providerAccountHealth.providerAccountId, providerAccountIds)
      ));
    for (const row of rows) rowsByAccount.set(row.providerAccountId, row);
    return rowsByAccount;
  }

  private async providerModelHealthRows(providerAccountIds: string[]) {
    const rowsByAccount = new Map<string, ProviderModelHealthRow[]>();
    if (providerAccountIds.length === 0) return rowsByAccount;
    const rows = await this.db
      .select({
        providerId: providerModelHealth.providerId,
        providerAccountId: providerModelHealth.providerAccountId,
        model: providerModelHealth.model,
        status: providerModelHealth.status,
        lastErrorType: providerModelHealth.lastErrorType,
        lastErrorAt: providerModelHealth.lastErrorAt,
        lockoutUntil: providerModelHealth.lockoutUntil,
        consecutiveFailures: providerModelHealth.consecutiveFailures,
        lastSuccessAt: providerModelHealth.lastSuccessAt
      })
      .from(providerModelHealth)
      .where(and(
        eq(providerModelHealth.organizationId, this.organizationId),
        inArray(providerModelHealth.providerAccountId, providerAccountIds)
      ))
      .orderBy(asc(providerModelHealth.model));
    for (const row of rows) {
      const list = rowsByAccount.get(row.providerAccountId) ?? [];
      list.push(row);
      rowsByAccount.set(row.providerAccountId, list);
    }
    return rowsByAccount;
  }

  private async providerSummariesBySlug() {
    const { data } = await this.providers();
    return new Map(data.map((provider) => [
      provider.slug,
      {
        capabilities: provider.capabilities,
        endpoints: provider.endpoints
      }
    ]));
  }

  async routingConfigs() {
    const configRows = await this.db
      .select()
      .from(routingConfigs)
      .where(this.scopedTo(routingConfigs))
      .orderBy(desc(routingConfigs.updatedAt));
    const activeVersions = await this.activeRoutingConfigVersions(configRows);
    const assignedKeyCounts = await this.routingConfigApiKeyCounts(configRows.map((row) => row.id));
    const trafficShares = await this.routingConfigTrafficShares();
    const providersBySlug = await this.providerSummariesBySlug();

    return {
      data: configRows.map((row) =>
        routingConfigListSummary(
          row,
          activeVersions.get(row.activeVersionId ?? ""),
          assignedKeyCounts.get(row.id) ?? 0,
          trafficShares.get(row.id) ?? 0,
          providersBySlug
        )
      )
    };
  }

  async routingConfigDetail(configId: string) {
    const [config] = await this.db
      .select()
      .from(routingConfigs)
      .where(and(
        this.scopedTo(routingConfigs),
        eq(routingConfigs.id, configId)
      ))
      .limit(1);
    if (!config) return null;

    const versions = await this.db
      .select()
      .from(routingConfigVersions)
      .where(and(
        this.scopedTo(routingConfigVersions),
        eq(routingConfigVersions.routingConfigId, config.id)
      ))
      .orderBy(desc(routingConfigVersions.version));
    const activeVersion = versions.find((version) => version.id === config.activeVersionId);
    const assignedKeyCounts = await this.routingConfigApiKeyCounts([config.id]);
    const trafficShares = await this.routingConfigTrafficShares();
    const providersBySlug = await this.providerSummariesBySlug();

    return {
      config: routingConfigListSummary(
        config,
        activeVersion,
        assignedKeyCounts.get(config.id) ?? 0,
        trafficShares.get(config.id) ?? 0,
        providersBySlug
      ),
      versions: versions.map((version) => routingConfigVersionDetail(version, version.id === config.activeVersionId))
    };
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
    await this.addRoutingConfigNames(routeDecisionSummaries);
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
      compressionReceipts: requestRow ? await this.compressionReceiptsForRequest(requestId) : [],
      healthSkips: healthSkipsFromEvents(requestEvents)
    };
  }

  async prompts(filters: PromptListFilters = {}) {
    const rows = await this.promptRows(filters);
    const requestRows = [...new Map(rows.map((row) => [row.request.id, row.request])).values()];
    const requestSummaries = new Map((await this.summarizeRequests(requestRows)).map((request) => [request.requestId, request]));
    const data = await this.addRoutingConfigNames(rows.map((row) => promptSummary(row, requestSummaries.get(row.request.id))));
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

  async usageDashboard(filters: UsageTimeseriesFilters = {}) {
    const groupBy = usageGroupBy(filters.groupBy);
    const interval = usageInterval(filters.interval);
    const limit = timeseriesGroupLimit(filters.limit);
    const scope = this.usageRollupScope(filters);
    const step = intervalMs(interval);
    const [pricing, costBaseline, bucketReport] = await Promise.all([
      this.effectivePricing(),
      this.effectiveCostBaseline(),
      this.usageBucketRollupReport(scope, groupBy, step, null)
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
      costBaseline
    );
  }

  async usageTimeseries(filters: UsageTimeseriesFilters = {}) {
    return (await this.usageDashboard(filters)).timeseries;
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
    costBaseline: CostBaseline
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
      this.addUsageRollup(group, row, pricing, costBaseline);
      this.addUsageRollup(totals, row, pricing, costBaseline);
      groupTotals.set(row.groupKey, group);
    }
    const ranked = [...groupTotals.values()].sort(compareUsageGroups);
    const keptKeys = new Set(ranked.slice(0, limit).map((group) => group.key));
    const collapseOthers = ranked.length > limit;
    const pointReport = collapseOthers
      ? await this.usageBucketRollupReport(scope, groupBy, step, [...keptKeys])
      : bucketReport;

    const points = new Map<number, { totals: UsageGroup; groups: Map<string, UsageGroup> }>();
    for (let ts = window.start; ts <= window.end; ts += step) {
      points.set(ts, { totals: emptyUsageGroup("total"), groups: new Map() });
    }
    for (const row of pointReport.rollups) {
      const point = points.get(row.bucketTs);
      if (!point) continue;
      const group = point.groups.get(row.groupKey) ?? emptyUsageGroup(row.groupKey);
      this.addUsageRollup(point.totals, row, pricing, costBaseline);
      this.addUsageRollup(group, row, pricing, costBaseline);
      point.groups.set(row.groupKey, group);
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
    for (const row of pointReport.latencies) {
      if (row.groupKey === null) {
        if (row.bucketTs !== null) bucketLatency.set(row.bucketTs, row);
      } else if (row.bucketTs === null) {
        timeseriesGroupLatency.set(row.groupKey, row);
      } else {
        bucketGroupLatency.set(`${row.bucketTs}:${row.groupKey}`, row);
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
    keptKeys: string[] | null
  ): Promise<UsageBucketRollupReport> {
    return this.cached(`usage-bucket-rollup-report:${groupBy}:${step}:${JSON.stringify(keptKeys)}:${usageScopeKey(scope)}`, () =>
      this.recordDbQuery("usage_bucket_rollup", () => usageBucketRollupReportRows(this.db, scope, groupBy, step, keptKeys)));
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
    costBaseline: CostBaseline
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
    const baseline = baselineCostFor(pricing, costBaseline, row.surface, row.requestedModel, row.selectedProvider, row.selectedModel, {
      inputTokens: row.uncachedInputTokens + row.cachedInputTokens + row.cacheCreationInputTokens,
      cachedInputTokens: row.cachedInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      totalTokens: row.totalTokens
    });
    const classifier = row.classifierCostMicros / 1_000_000;
    const selected = row.providerCostMicros / 1_000_000 + classifier;
    group.cost.selected += selected;
    group.cost.baseline += baseline;
    group.cost.savings += baseline - selected;
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
    await this.addRoutingConfigNames([...promptArtifactSummaries, ...routeDecisionSummaries]);
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
    const [artifact] = await this.addRoutingConfigNames([promptDetail(row, request)]);
    const routeDecisionSummaries = (await this.routeDecisionRowsForRequest(row.request.id)).map(routeDecisionSummary);
    await this.addRoutingConfigNames(routeDecisionSummaries);
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
        routingConfigId: apiKeys.routingConfigId,
        createdAt: apiKeys.createdAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        lastUsedAt: apiKeys.lastUsedAt,
        routingConfigName: routingConfigs.name,
        routingConfigStatus: routingConfigs.status
      })
      .from(apiKeys)
      .leftJoin(routingConfigs, and(
        eq(routingConfigs.organizationId, apiKeys.organizationId),
        eq(routingConfigs.workspaceId, apiKeys.workspaceId),
        eq(routingConfigs.id, apiKeys.routingConfigId)
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
          organizationId: modelCatalog.organizationId,
          provider: providers.slug,
          model: modelCatalog.model,
          pricing: modelCatalog.pricing
        })
        .from(modelCatalog)
        .innerJoin(providers, eq(providers.id, modelCatalog.providerId))
        .where(or(
          isNull(modelCatalog.organizationId),
          eq(modelCatalog.organizationId, this.organizationId)
        ));
      const table: Record<string, ModelPricing> = {};
      for (const row of rows.filter((row) => row.organizationId === null)) {
        const pricing = pricingFromRow(row.pricing);
        if (pricing) table[providerModelPricingKey(row.provider, row.model)] = pricing;
      }
      for (const row of rows.filter((row) => row.organizationId !== null)) {
        const pricing = pricingFromRow(row.pricing);
        if (pricing) table[providerModelPricingKey(row.provider, row.model)] = pricing;
      }
      return Object.freeze(table);
    });
  }

  // Savings counterfactual for this organization: the baseline models from
  // organization settings, defaulting to the harness frontier defaults.
  private effectiveCostBaseline(): Promise<CostBaseline> {
    return this.cached("cost-baseline", () => orgCostBaseline(this.db, this.organizationId));
  }

  // Pricing mutations re-read through the same request-scoped service; drop
  // the memoized override rows so the re-read reflects the write.
  invalidateModelPricing() {
    this.requestScopedCache.delete("model-pricing");
  }

  async modelPricing() {
    const pricing = await this.effectivePricing();
    // Deliberately org-wide (no workspaceScope): pricing is an org-level
    // resource, so unpriced traffic in any workspace is actionable here.
    const ledgerModels = await this.db
      .selectDistinct({
        provider: usageLedger.provider,
        model: usageLedger.model
      })
      .from(usageLedger)
      .where(eq(usageLedger.organizationId, this.organizationId));
    const catalogModels = await this.db
      .select({
        organizationId: modelCatalog.organizationId,
        provider: providers.slug,
        model: modelCatalog.model,
        pricing: modelCatalog.pricing,
        updatedAt: modelCatalog.updatedAt
      })
      .from(modelCatalog)
      .innerJoin(providers, eq(providers.id, modelCatalog.providerId))
      .where(or(
        isNull(modelCatalog.organizationId),
        eq(modelCatalog.organizationId, this.organizationId)
      ));

    const entries = new Map<string, ModelPricingEntry>();
    const upsert = (model: string, provider: string | null) => {
      const key = providerModelPricingKey(provider ?? "unknown", model);
      const existing = entries.get(key);
      if (existing) {
        existing.provider ??= provider;
        return existing;
      }
      const entry = emptyPricingEntry(model, provider);
      entries.set(key, entry);
      return entry;
    };

    for (const catalogEntry of catalogModels.filter((entry) => entry.organizationId === null)) {
      const row = upsert(catalogEntry.model, catalogEntry.provider);
      const rowPricing = pricingFromRow(catalogEntry.pricing);
      if (rowPricing) applyPricingToEntry(row, rowPricing, "default");
    }
    for (const catalogEntry of catalogModels.filter((entry) => entry.organizationId !== null)) {
      const row = upsert(catalogEntry.model, catalogEntry.provider);
      const rowPricing = pricingFromRow(catalogEntry.pricing);
      if (!rowPricing) continue;
      applyPricingToEntry(row, rowPricing, "custom");
      row.updatedAt = catalogEntry.updatedAt.toISOString();
    }
    // The routing classifier bills its own model on every request, so list it
    // even before traffic — operators must be able to confirm it is priced.
    this.seedClassifierPricingRow(upsert, pricing);
    for (const ledgerModel of ledgerModels) {
      const row = upsert(ledgerModel.model, ledgerModel.provider);
      row.seenInTraffic = true;
      if (row.source !== "unpriced") continue;
      // Dated identifiers (claude-sonnet-4-5-20250929) price through their
      // undated entry — including org overrides; reflect that in the listing.
      const undated = undatedModel(ledgerModel.model);
      const exactRow = entries.get(providerModelPricingKey(ledgerModel.provider, ledgerModel.model));
      const undatedRow = entries.get(providerModelPricingKey(ledgerModel.provider, undated));
      const pricedRow = exactRow && exactRow.source !== "unpriced" ? exactRow : undatedRow;
      if (pricedRow && pricedRow.source !== "unpriced") {
        const modelPricing = pricingForProviderModel(pricing, ledgerModel.provider, ledgerModel.model);
        if (modelPricing) {
          applyPricingToEntry(row, modelPricing, pricedRow.source);
          row.updatedAt = pricedRow.updatedAt;
        }
      }
    }

    return [...entries.values()].sort(compareModelPricingEntries);
  }

  // Adds the configured classifier model to the pricing listing if traffic has
  // not surfaced it yet, resolving its rate through the static table (including
  // the undated fallback) so it shows as priced rather than missing.
  private seedClassifierPricingRow(
    upsert: (model: string, provider: string | null) => ModelPricingEntry,
    pricing: ModelPricingTable
  ) {
    const model = this.config.classifierModel;
    if (!model) return;
    const provider = this.config.classifierProvider;
    const row = upsert(model, provider);
    if (row.source !== "unpriced") return;
    const modelPricing = pricingForProviderModel(pricing, provider, model);
    if (modelPricing) applyPricingToEntry(row, modelPricing, "default");
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
    const skipReasonsByRequest = providerSkipReasonsByRequest(attempts);
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
        attemptCount: attemptCountsByRequest.get(request.id) ?? 0,
        routeSkipReasons: skipReasonsByRequest.get(request.id) ?? []
      }, pricing, costBaseline);
    });
    return this.addRoutingConfigNames(summaries);
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

  private async addRoutingConfigNames<T extends { routingConfig: ReturnType<typeof routingConfigSummary> }>(summaries: T[]) {
    if (!summaries.some((summary) => summary.routingConfig)) return summaries;

    // Organizations hold a handful of configs, so one org-wide name map
    // serves every lookup in the request regardless of which subset of
    // config ids each caller references.
    const names = await this.cached("config-names", async () => {
      const rows = await this.db
        .select({
          id: routingConfigs.id,
          name: routingConfigs.name
        })
        .from(routingConfigs)
        .where(this.scopedTo(routingConfigs));
      return new Map(rows.map((row) => [row.id, row.name]));
    });
    for (const summary of summaries) {
      if (summary.routingConfig) {
        summary.routingConfig.configName = names.get(summary.routingConfig.configId) ?? null;
      }
    }
    return summaries;
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

  // Output tokens per route — the lever for effort/verbosity tuning. Output is
  // 5x input price, so a route with high average output is the first place to
  // dial effort down. Reasoning share flags routes spending output on thinking.
  async routeOutputReport(filters: DateRangeFilters = {}) {
    const start = dateValue(filters.start);
    const end = dateValue(filters.end);
    const conditions = [this.scopedTo(usageLedger), eq(usageLedger.kind, "provider")];
    if (start) conditions.push(gte(usageLedger.createdAt, start));
    if (end) conditions.push(lte(usageLedger.createdAt, end));
    const [routeRows, modelRows, userRows, apiKeyRows, workspaceRows] = await Promise.all([
      this.db
        .select({
          route: usageLedger.route,
          requests: sql<number>`count(*)`,
          outputTokens: sql<number>`coalesce(sum(${usageLedger.outputTokens}), 0)`,
          reasoningTokens: sql<number>`coalesce(sum(${usageLedger.reasoningTokens}), 0)`,
          outputCostMicros: sql<number>`coalesce(sum(${usageLedger.outputCostMicros}), 0)`
        })
        .from(usageLedger)
        .where(and(...conditions, isNotNull(usageLedger.route)))
        .groupBy(usageLedger.route),
      this.db
        .select({
          key: usageLedger.model,
          requests: sql<number>`count(*)`,
          outputTokens: sql<number>`coalesce(sum(${usageLedger.outputTokens}), 0)`,
          reasoningTokens: sql<number>`coalesce(sum(${usageLedger.reasoningTokens}), 0)`,
          outputCostMicros: sql<number>`coalesce(sum(${usageLedger.outputCostMicros}), 0)`
        })
        .from(usageLedger)
        .where(and(...conditions))
        .groupBy(usageLedger.model),
      this.db
        .select({
          key: usageLedger.userId,
          requests: sql<number>`count(*)`,
          outputTokens: sql<number>`coalesce(sum(${usageLedger.outputTokens}), 0)`,
          reasoningTokens: sql<number>`coalesce(sum(${usageLedger.reasoningTokens}), 0)`,
          outputCostMicros: sql<number>`coalesce(sum(${usageLedger.outputCostMicros}), 0)`
        })
        .from(usageLedger)
        .where(and(...conditions, isNotNull(usageLedger.userId)))
        .groupBy(usageLedger.userId),
      this.db
        .select({
          key: requests.apiKeyId,
          requests: sql<number>`count(*)`,
          outputTokens: sql<number>`coalesce(sum(${usageLedger.outputTokens}), 0)`,
          reasoningTokens: sql<number>`coalesce(sum(${usageLedger.reasoningTokens}), 0)`,
          outputCostMicros: sql<number>`coalesce(sum(${usageLedger.outputCostMicros}), 0)`
        })
        .from(usageLedger)
        .innerJoin(requests, and(
          eq(requests.organizationId, usageLedger.organizationId),
          eq(requests.workspaceId, usageLedger.workspaceId),
          eq(requests.id, usageLedger.requestId)
        ))
        .where(and(...conditions, isNotNull(requests.apiKeyId)))
        .groupBy(requests.apiKeyId),
      this.db
        .select({
          key: usageLedger.workspaceId,
          requests: sql<number>`count(*)`,
          outputTokens: sql<number>`coalesce(sum(${usageLedger.outputTokens}), 0)`,
          reasoningTokens: sql<number>`coalesce(sum(${usageLedger.reasoningTokens}), 0)`,
          outputCostMicros: sql<number>`coalesce(sum(${usageLedger.outputCostMicros}), 0)`
        })
        .from(usageLedger)
        .where(and(...conditions))
        .groupBy(usageLedger.workspaceId)
    ]);

    const routes = routeRows.map((row) => {
      const requests = Number(row.requests);
      const outputTokens = Number(row.outputTokens);
      const reasoningTokens = Number(row.reasoningTokens);
      return {
        route: row.route ?? "unknown",
        requests,
        outputTokens,
        reasoningTokens,
        avgOutputTokens: requests > 0 ? outputTokens / requests : 0,
        reasoningShare: outputTokens > 0 ? reasoningTokens / outputTokens : 0,
        outputCost: Number(row.outputCostMicros) / 1_000_000
      };
    });
    routes.sort((left, right) => routeIndex(routeValue(left.route)) - routeIndex(routeValue(right.route)));
    return {
      routes,
      models: outputGroups(modelRows),
      users: outputGroups(userRows),
      apiKeys: outputGroups(apiKeyRows),
      workspaces: outputGroups(workspaceRows)
    };
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
        createdAt: usageLedger.createdAt
      })
      .from(usageLedger)
      .where(and(...conditions))
      .orderBy(desc(usageLedger.createdAt))
      .limit(CACHE_BUST_SAMPLE_CAP);
    const report = detectCacheBusts(rows.map((row) => ({
      sessionId: row.sessionId ?? "",
      requestId: row.requestId,
      provider: row.provider,
      model: row.model,
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      createdAt: row.createdAt
    })));
    return { ...report, sampled: rows.length === CACHE_BUST_SAMPLE_CAP };
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
      const threshold = Math.round(this.config.routeQualityLowConfidenceThreshold * 10_000);
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

  private async activeRoutingConfigVersions(configRows: RoutingConfigRow[]) {
    const versionIds = configRows.flatMap((row) => row.activeVersionId ? [row.activeVersionId] : []);
    if (versionIds.length === 0) return new Map<string, RoutingConfigVersionRow>();

    const rows = await this.db
      .select()
      .from(routingConfigVersions)
      .where(and(
        this.scopedTo(routingConfigVersions),
        inArray(routingConfigVersions.id, versionIds)
      ));
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async routingConfigApiKeyCounts(configIds: string[]) {
    if (configIds.length === 0) return new Map<string, number>();

    const rows = await this.db
      .select({ routingConfigId: apiKeys.routingConfigId })
      .from(apiKeys)
      .where(and(
        this.scopedTo(apiKeys),
        inArray(apiKeys.routingConfigId, configIds)
      ));
    return rows.reduce((counts, row) => {
      if (!row.routingConfigId) return counts;
      counts.set(row.routingConfigId, (counts.get(row.routingConfigId) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
  }

  // Share of routed requests per config over the trailing seven days. The
  // window keeps the number current without scanning full request history.
  private async routingConfigTrafficShares() {
    return this.cached("routing-config-traffic-shares", async () => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const rows = await this.db
        .select({
          routingConfigId: requests.routingConfigId,
          count: sql<number>`count(*)`
        })
        .from(requests)
        .where(and(
          this.scopedTo(requests),
          isNotNull(requests.routingConfigId),
          gte(requests.createdAt, since)
        ))
        .groupBy(requests.routingConfigId);
      const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
      const shares = new Map<string, number>();
      if (total === 0) return shares;
      for (const row of rows) {
        if (row.routingConfigId) shares.set(row.routingConfigId, Number(row.count) / total);
      }
      return shares;
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
type RoutingConfigRow = typeof routingConfigs.$inferSelect;
type RoutingConfigVersionRow = typeof routingConfigVersions.$inferSelect;
type ApiKeySummaryRow = {
  id: string;
  organizationId: string;
  userId: string | null;
  name: string;
  routingConfigId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  routingConfigName: string | null;
  routingConfigStatus: string | null;
};

type ProviderBindingSummary = {
  provider: string;
  providerId: string;
  providerAccountId: string;
  name: string | null;
  status: string | null;
};

type ProviderAccountSummaryRow = {
  id: string;
  organizationId: string;
  providerId: string;
  provider: string;
  name: string;
  baseUrl: string | null;
  authType: ProviderAccountAuthType;
  status: string;
  secretHint: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
};

type ProviderAccountHealthRow = {
  providerAccountId: string;
  status: string;
  lastErrorType: string | null;
  lastErrorAt: Date | null;
  cooldownUntil: Date | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastCheckedAt: Date | null;
};

type ProviderModelHealthRow = {
  providerId: string;
  providerAccountId: string;
  model: string;
  status: string;
  lastErrorType: string | null;
  lastErrorAt: Date | null;
  lockoutUntil: Date | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
};

type ProviderRegistryRow = {
  id: string;
  organizationId: string | null;
  slug: string;
  displayName: string;
  baseUrl: string;
  authStyle: "bearer" | "x-api-key" | "none";
  endpoints: { dialect: string; path: string }[];
  defaultHeaders: Record<string, string>;
  capabilities: Record<string, unknown>;
  forwardHarnessHeaders: boolean;
  enabled: boolean;
};
type RoutingConfigProviderSummary = {
  capabilities: Record<string, unknown>;
  endpoints: { dialect: string }[];
};

function routingConfigListSummary(
  row: RoutingConfigRow,
  activeVersion: RoutingConfigVersionRow | undefined,
  assignedApiKeyCount: number,
  trafficShare: number,
  providersBySlug: Map<string, RoutingConfigProviderSummary>
) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    status: row.status,
    activeVersionId: row.activeVersionId ?? null,
    activeVersion: activeVersion ? routingConfigVersionSummary(activeVersion, true) : null,
    routes: activeVersion ? routingConfigRoutesSummary(activeVersion.config, providersBySlug) : [],
    assignedApiKeyCount,
    trafficShare,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function routingConfigVersionSummary(row: RoutingConfigVersionRow, active: boolean) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    routingConfigId: row.routingConfigId,
    version: row.version,
    configHash: row.configHash,
    status: row.status,
    active,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null
  };
}

function routingConfigVersionDetail(row: RoutingConfigVersionRow, active: boolean) {
  return {
    ...routingConfigVersionSummary(row, active),
    config: row.config
  };
}

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
  const route = routeValue(filters.route);
  if (route) conditions.push(eq(routeDecisions.finalRoute, route));
  if (filters.model) conditions.push(eq(routeDecisions.selectedModel, filters.model));
  const start = dateValue(filters.start);
  if (start) conditions.push(gte(promptArtifacts.createdAt, start));
  const end = dateValue(filters.end);
  if (end) conditions.push(lte(promptArtifacts.createdAt, end));
  return conditions;
}

function apiKeySummary(row: ApiKeySummaryRow, providerBindings: ProviderBindingSummary[] = []) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId ?? null,
    name: row.name,
    routingConfigId: row.routingConfigId ?? null,
    routingConfig: row.routingConfigId
      ? {
          id: row.routingConfigId,
          name: row.routingConfigName ?? null,
          status: row.routingConfigStatus ?? null
        }
      : null,
    providerCredentials: providerBindings,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null
  };
}

function providerAccountSummary(
  row: ProviderAccountSummaryRow,
  boundKeyCount: number,
  health: ProviderAccountHealthRow | null,
  modelHealth: ProviderModelHealthRow[]
) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    providerId: row.providerId,
    provider: row.provider,
    name: row.name,
    baseUrl: row.baseUrl,
    authType: row.authType,
    status: row.status,
    secretHint: row.secretHint ?? null,
    ownerUserId: row.createdByUserId ?? null,
    boundKeyCount,
    health: providerAccountHealthSummary(health, modelHealth),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null
  };
}

function providerAccountHealthSummary(
  health: ProviderAccountHealthRow | null,
  modelHealth: ProviderModelHealthRow[]
) {
  if (!health && modelHealth.length === 0) return null;
  return {
    status: health?.status ?? null,
    lastErrorType: health?.lastErrorType ?? null,
    lastErrorAt: health?.lastErrorAt?.toISOString() ?? null,
    cooldownUntil: health?.cooldownUntil?.toISOString() ?? null,
    consecutiveFailures: health?.consecutiveFailures ?? 0,
    lastSuccessAt: health?.lastSuccessAt?.toISOString() ?? null,
    lastCheckedAt: health?.lastCheckedAt?.toISOString() ?? null,
    modelHealth: modelHealth.map((row) => ({
      providerId: row.providerId,
      providerAccountId: row.providerAccountId,
      model: row.model,
      status: row.status,
      lastErrorType: row.lastErrorType ?? null,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      lockoutUntil: row.lockoutUntil?.toISOString() ?? null,
      consecutiveFailures: row.consecutiveFailures,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null
    }))
  };
}

function healthSkipsFromEvents(events: { eventType: string; payload: unknown }[]) {
  const skips: JsonObject[] = [];
  for (const event of events) {
    if (event.eventType !== "routing.decision_recorded") continue;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) continue;
    const healthSkips = (event.payload as Record<string, unknown>).healthSkips;
    if (!Array.isArray(healthSkips)) continue;
    for (const skip of healthSkips) {
      if (!skip || typeof skip !== "object" || Array.isArray(skip)) continue;
      const record = skip as Record<string, unknown>;
      skips.push({
        scope: stringOrNull(record.scope),
        provider: stringOrNull(record.provider),
        providerId: stringOrNull(record.providerId),
        providerAccountId: stringOrNull(record.providerAccountId),
        model: stringOrNull(record.model),
        healthStatus: stringOrNull(record.healthStatus),
        errorType: stringOrNull(record.errorType),
        expiresAt: stringOrNull(record.expiresAt)
      });
    }
  }
  return skips;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function providerRegistrySummary(row: ProviderRegistryRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    authStyle: row.authStyle,
    endpoints: row.endpoints,
    defaultHeaders: row.defaultHeaders,
    capabilities: row.capabilities,
    forwardHarnessHeaders: row.forwardHarnessHeaders,
    enabled: row.enabled,
    builtin: row.organizationId === null
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
    finalRoute: row.decision?.finalRoute ?? undefined,
    provider: row.decision?.selectedProvider ?? request?.provider ?? undefined,
    selectedModel: row.decision?.selectedModel ?? request?.selectedModel ?? undefined,
    routingConfig: routingConfigSummary(row.decision ?? row.request),
    classifier: row.decision?.classifier ?? undefined,
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
  finalRoute: routeDecisions.finalRoute,
  selectedProvider: routeDecisions.selectedProvider,
  selectedModel: routeDecisions.selectedModel,
  selectedCandidateId: routeDecisions.selectedCandidateId,
  translated: routeDecisions.translated,
  reasoningEffort: routeDecisions.reasoningEffort,
  routingConfigId: routeDecisions.routingConfigId,
  routingConfigVersionId: routeDecisions.routingConfigVersionId,
  routingConfigVersion: routeDecisions.routingConfigVersion,
  routingConfigHash: routeDecisions.routingConfigHash,
  classifier: routeDecisions.classifier
};

type RequestSummaryDecisionRow = Pick<
  typeof routeDecisions.$inferSelect,
  | "requestId"
  | "finalRoute"
  | "selectedProvider"
  | "selectedModel"
  | "selectedCandidateId"
  | "translated"
  | "reasoningEffort"
  | "routingConfigId"
  | "routingConfigVersionId"
  | "routingConfigVersion"
  | "routingConfigHash"
  | "classifier"
>;

function requestSummary(row: {
  request: RequestRow;
  decision: RequestSummaryDecisionRow | null;
  attempt: ProviderAttemptRow | null;
  usage: UsageAggregate | null;
  classifierCost: number;
  attemptCount: number;
  routeSkipReasons: string[];
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
    row.request.requestedModel,
    selectedProvider,
    selectedModel,
    usage
  );
  return {
    requestId: row.request.id,
    userId: row.request.userId ?? undefined,
    sessionId: row.request.sessionId ?? undefined,
    apiKeyId: row.request.apiKeyId ?? undefined,
    surface: row.request.surface,
    requestedModel: row.request.requestedModel,
    finalRoute: row.decision?.finalRoute ?? undefined,
    reasoningEffort: row.decision?.reasoningEffort ?? undefined,
    provider: row.decision?.selectedProvider ?? row.attempt?.provider ?? undefined,
    selectedModel,
    selectedCandidateId: row.decision?.selectedCandidateId ?? undefined,
    translated: row.decision?.translated ?? false,
    routeSkipReasons: row.routeSkipReasons,
    rejected,
    routingConfig: routingConfigSummary(row.decision ?? row.request),
    classifier: row.decision?.classifier ?? undefined,
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
type UsageGroupBy = "user" | "api_key" | "provider" | "model" | "model_effort" | "route" | "surface" | "session";
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
    currentRoute: session.currentRoute ?? undefined,
    sessionIdentity: stringFromMetadata(session.metadata, "sessionIdentity"),
    requestCount: requests.length,
    routeChanges: routeChangeCount(requests),
    modelMix: countBy(requests, (request) => request.selectedModel ?? (request.rejected ? "rejected" : "unknown")),
    routeMix: countBy(requests, (request) => request.finalRoute ?? "unknown"),
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

function routeChangeCount(requests: RequestSummary[]) {
  let previousRoute: string | undefined;
  let changes = 0;
  for (const request of [...requests].sort((left, right) =>
    timestampFromIso(left.createdAt) - timestampFromIso(right.createdAt)
  )) {
    if (!request.finalRoute) continue;
    if (previousRoute && previousRoute !== request.finalRoute) changes += 1;
    previousRoute = request.finalRoute;
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
    value === "route" ||
    value === "surface" ||
    value === "session"
  ) {
    return value;
  }
  return "route";
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

type OutputGroupAggregateRow = {
  key: string | null;
  requests: number;
  outputTokens: number;
  reasoningTokens: number;
  outputCostMicros: number;
};

function outputGroups(rows: OutputGroupAggregateRow[]) {
  return rows
    .map((row) => {
      const requests = Number(row.requests);
      const outputTokens = Number(row.outputTokens);
      const reasoningTokens = Number(row.reasoningTokens);
      return {
        key: row.key ?? "unknown",
        requests,
        outputTokens,
        reasoningTokens,
        avgOutputTokens: requests > 0 ? outputTokens / requests : 0,
        reasoningShare: outputTokens > 0 ? reasoningTokens / outputTokens : 0,
        outputCost: Number(row.outputCostMicros) / 1_000_000
      };
    })
    .sort((left, right) => right.outputTokens - left.outputTokens || left.key.localeCompare(right.key));
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
  requestedModel: string,
  selectedProvider: string | undefined,
  selectedModel: string | undefined,
  usage: ReturnType<typeof emptyUsage>
) {
  const compatibleSurface = knownSurfaceValue(surface);
  if (!compatibleSurface) return 0;
  const route = explicitAlias(compatibleSurface, requestedModel);
  const provider = route
    ? selectedProvider
    : providerForDialect(compatibleSurface);
  const model = route ? selectedModel : baselineModelForDialect(costBaseline, compatibleSurface);
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

function routeIndex(route: RouteName | undefined) {
  if (route === "fast") return 0;
  if (route === "balanced") return 1;
  if (route === "hard") return 2;
  if (route === "deep") return 3;
  return -1;
}
