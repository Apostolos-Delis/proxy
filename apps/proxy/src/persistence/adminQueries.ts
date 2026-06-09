import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";

import {
  agentSessions,
  apiKeys,
  events,
  organizationMembers,
  promptArtifacts,
  providerAttempts,
  requests,
  routeDecisions,
  routingConfigs,
  users as usersTable,
  usageLedger,
  type PromptProxyDbSession
} from "@prompt-proxy/db";

import { explicitAlias, modelForRoute } from "../catalog.js";
import type { ModelCatalog } from "../catalog.js";
import type { JsonObject, RouteName } from "../types.js";
import {
  eventSummary,
  providerAttemptSummary,
  routeDecisionSummary,
  routingConfigSummary,
  usageLedgerSummary
} from "./adminSerializers.js";
import { routeValue, surfaceValue, usageCostMicros } from "./values.js";

export type AdminQueryConfig = {
  defaultOrganizationId: string;
  routeQualityLowConfidenceThreshold: number;
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

export type UsageAnalyticsFilters = {
  groupBy?: string;
  start?: string;
  end?: string;
};

export class AdminQueryService {
  constructor(
    private readonly db: PromptProxyDbSession,
    private readonly catalog: ModelCatalog,
    private readonly config: AdminQueryConfig
  ) {}

  async overview() {
    const requestRows = await this.requestRows();
    const requestSummaries = await this.summarizeRequests(requestRows);
    const eventCount = await this.eventCount();
    const decisions = await this.db
      .select()
      .from(routeDecisions)
      .where(eq(routeDecisions.organizationId, this.config.defaultOrganizationId));

    return {
      organizationId: this.config.defaultOrganizationId,
      eventCount,
      requestCount: requestRows.length,
      totals: requestSummaries.reduce((acc, request) => {
        acc.inputTokens += request.usage.inputTokens;
        acc.cachedInputTokens += request.usage.cachedInputTokens;
        acc.outputTokens += request.usage.outputTokens;
        acc.reasoningTokens += request.usage.reasoningTokens;
        acc.totalTokens += request.usage.totalTokens;
        return acc;
      }, emptyUsage()),
      cost: requestSummaries.reduce((acc, request) => {
        acc.selected += request.selectedCost;
        acc.baseline += request.baselineCost;
        acc.savings += request.savings;
        return acc;
      }, { selected: 0, baseline: 0, savings: 0 }),
      routeQuality: {
        lowConfidenceCount: decisions.filter((decision) =>
          decision.confidence !== null &&
            decision.confidence < Math.round(this.config.routeQualityLowConfidenceThreshold * 10_000)
        ).length,
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

  async requests() {
    return {
      data: await this.summarizeRequests(await this.requestRows(200))
    };
  }

  async apiKeys() {
    const rows = await this.db
      .select({
        id: apiKeys.id,
        organizationId: apiKeys.organizationId,
        userId: apiKeys.userId,
        name: apiKeys.name,
        scopes: apiKeys.scopes,
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
        eq(routingConfigs.id, apiKeys.routingConfigId)
      ))
      .where(eq(apiKeys.organizationId, this.config.defaultOrganizationId))
      .orderBy(desc(apiKeys.createdAt));

    return {
      data: rows.map(apiKeySummary)
    };
  }

  async requestDetail(requestId: string) {
    const [requestRow] = await this.db
      .select()
      .from(requests)
      .where(and(
        eq(requests.organizationId, this.config.defaultOrganizationId),
        eq(requests.id, requestId)
      ))
      .limit(1);
    const [request] = requestRow ? await this.summarizeRequests([requestRow]) : [];
    return {
      request: request ?? null,
      events: await this.eventsForRequest(requestId)
    };
  }

  async prompts(filters: PromptListFilters = {}) {
    const rows = await this.promptRows(filters);
    return {
      data: rows.map((row) => promptSummary(row)),
      pagination: {
        limit: promptLimit(filters.limit),
        offset: promptOffset(filters.offset),
        count: rows.length
      }
    };
  }

  async usage(filters: UsageAnalyticsFilters = {}) {
    const requestRows = await this.requestRowsForUsage(filters);
    const requestSummaries = await this.summarizeRequests(requestRows, { aggregateUsageByRequest: true });
    const groupBy = usageGroupBy(filters.groupBy);
    const groups = new Map<string, UsageGroup>();
    for (const request of requestSummaries) {
      const key = usageGroupKey(request, groupBy);
      const group = groups.get(key) ?? emptyUsageGroup(key);
      addUsageRequest(group, request);
      groups.set(key, group);
    }
    const data = [...groups.values()]
      .map(finalizeUsageGroup)
      .sort((left, right) => right.cost.selected - left.cost.selected);
    return {
      groupBy,
      data,
      totals: finalizeUsageGroup(requestSummaries.reduce((group, request) => {
        addUsageRequest(group, request);
        return group;
      }, emptyUsageGroup("total")))
    };
  }

  async users() {
    const requestRows = await this.requestRows();
    const requestSummaries = await this.summarizeRequests(requestRows, { aggregateUsageByRequest: true });
    const sessionRows = await this.sessionRows();
    const userRows = await this.userRowsForOrg(userIdsForRequestsAndSessions(requestSummaries, sessionRows));
    return {
      data: [...userRows.values()]
        .map((user) => userSummary(user, requestSummaries, sessionRows))
        .sort((left, right) => compareRecentActivity(left.recentActivity, right.recentActivity))
    };
  }

  async userDetail(userId: string) {
    const requestRows = await this.requestRowsForUser(userId);
    const requestSummaries = await this.summarizeRequests(requestRows, { aggregateUsageByRequest: true });
    const sessionRows = await this.sessionRowsForUser(userId, sessionIdsForRequests(requestSummaries));
    const userRows = await this.userRowsForOrg(userIdsForRequestsAndSessions(requestSummaries, sessionRows));
    const user = userRows.get(userId);
    if (!user) return null;

    const summary = userSummary(user, requestSummaries, sessionRows);
    return {
      user: summary,
      usage: summary.usage,
      cost: summary.cost,
      sessions: sessionRows.map((session) => sessionSummary(session, requestSummaries)),
      requests: requestSummaries.slice(0, 50)
    };
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

  async sessionDetail(sessionId: string) {
    const [session] = await this.db
      .select()
      .from(agentSessions)
      .where(and(
        eq(agentSessions.organizationId, this.config.defaultOrganizationId),
        eq(agentSessions.id, sessionId)
      ))
      .limit(1);
    if (!session) return null;

    const requestRows = await this.requestRowsForSession(sessionId);
    const requestSummaries = await this.summarizeRequests(requestRows, { aggregateUsageByRequest: true });
    const requestIds = requestRows.map((request) => request.id);
    const userRows = session.userId ? await this.userRowsForOrg([session.userId]) : new Map<string, UserRow>();
    const detailRows = await this.sessionDetailRows(sessionId, requestIds);
    return {
      session: sessionSummary(session, requestSummaries),
      user: session.userId ? userRows.get(session.userId) ?? null : null,
      requests: requestSummaries,
      promptArtifacts: detailRows.prompts.map((row) => promptDetail(row)),
      routeDecisions: detailRows.routeDecisions.map(routeDecisionSummary),
      providerAttempts: detailRows.providerAttempts.map(providerAttemptSummary),
      usageLedger: detailRows.usageLedger.map(usageLedgerSummary),
      events: detailRows.events.map(eventSummary)
    };
  }

  async promptDetail(artifactId: string) {
    const [row] = await this.db
      .select({
        artifact: promptArtifacts,
        request: requests
      })
      .from(promptArtifacts)
      .innerJoin(requests, eq(requests.id, promptArtifacts.requestId))
      .where(and(
        eq(promptArtifacts.organizationId, this.config.defaultOrganizationId),
        eq(requests.organizationId, this.config.defaultOrganizationId),
        eq(promptArtifacts.id, artifactId)
      ))
      .limit(1);
    if (!row) return null;

    const [request] = await this.summarizeRequests([row.request]);
    const requestEvents = await this.eventsForRequest(row.request.id);

    return {
      artifact: promptDetail(row),
      request: request ?? null,
      events: requestEvents
    };
  }

  private async requestRows(limit?: number) {
    if (limit === undefined) {
      return this.db
        .select()
        .from(requests)
        .where(eq(requests.organizationId, this.config.defaultOrganizationId))
        .orderBy(desc(requests.createdAt));
    }

    return this.db
      .select()
      .from(requests)
      .where(eq(requests.organizationId, this.config.defaultOrganizationId))
      .orderBy(desc(requests.createdAt))
      .limit(limit);
  }

  private async requestRowsForUsage(filters: UsageAnalyticsFilters) {
    const conditions = [eq(requests.organizationId, this.config.defaultOrganizationId)];
    const start = dateValue(filters.start);
    if (start) conditions.push(gte(requests.createdAt, start));
    const end = dateValue(filters.end);
    if (end) conditions.push(lte(requests.createdAt, end));
    return this.db
      .select()
      .from(requests)
      .where(and(...conditions))
      .orderBy(desc(requests.createdAt));
  }

  private async requestRowsForUser(userId: string) {
    return this.db
      .select()
      .from(requests)
      .where(and(
        eq(requests.organizationId, this.config.defaultOrganizationId),
        eq(requests.userId, userId)
      ))
      .orderBy(desc(requests.createdAt));
  }

  private async requestRowsForSession(sessionId: string) {
    return this.db
      .select()
      .from(requests)
      .where(and(
        eq(requests.organizationId, this.config.defaultOrganizationId),
        eq(requests.sessionId, sessionId)
      ))
      .orderBy(desc(requests.createdAt));
  }

  private async sessionRows() {
    return this.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.organizationId, this.config.defaultOrganizationId))
      .orderBy(desc(agentSessions.updatedAt));
  }

  private async sessionRowsForUser(userId: string, requestSessionIds: string[]) {
    const rows = await this.sessionRows();
    const requestSessionIdsSet = new Set(requestSessionIds);
    return rows.filter((session) =>
      session.userId === userId || requestSessionIdsSet.has(session.id)
    );
  }

  private async userRowsForOrg(candidateUserIds: string[]) {
    const memberRows = await this.db
      .select({
        user: usersTable
      })
      .from(organizationMembers)
      .innerJoin(usersTable, eq(usersTable.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, this.config.defaultOrganizationId));
    const usersById = new Map(memberRows.map((row) => [row.user.id, row.user]));
    const missingUserIds = [...new Set(candidateUserIds)]
      .filter((userId) => userId && !usersById.has(userId));
    if (missingUserIds.length > 0) {
      const rows = await this.db
        .select()
        .from(usersTable)
        .where(inArray(usersTable.id, missingUserIds));
      for (const row of rows) usersById.set(row.id, row);
    }
    return usersById;
  }

  private async sessionDetailRows(sessionId: string, requestIds: string[]) {
    const prompts = requestIds.length > 0
      ? await this.db
          .select({
            artifact: promptArtifacts,
            request: requests
          })
          .from(promptArtifacts)
          .innerJoin(requests, and(
            eq(requests.id, promptArtifacts.requestId),
            eq(requests.organizationId, promptArtifacts.organizationId)
          ))
          .where(and(
            eq(promptArtifacts.organizationId, this.config.defaultOrganizationId),
            inArray(promptArtifacts.requestId, requestIds)
          ))
          .orderBy(asc(promptArtifacts.createdAt))
      : [];
    const decisions = requestIds.length > 0
      ? await this.db
          .select()
          .from(routeDecisions)
          .where(and(
            eq(routeDecisions.organizationId, this.config.defaultOrganizationId),
            inArray(routeDecisions.requestId, requestIds)
          ))
          .orderBy(asc(routeDecisions.createdAt))
      : [];
    const attempts = requestIds.length > 0
      ? await this.db
          .select()
          .from(providerAttempts)
          .where(and(
            eq(providerAttempts.organizationId, this.config.defaultOrganizationId),
            inArray(providerAttempts.requestId, requestIds)
          ))
          .orderBy(asc(providerAttempts.startedAt))
      : [];
    const usageRows = requestIds.length > 0
      ? await this.db
          .select()
          .from(usageLedger)
          .where(and(
            eq(usageLedger.organizationId, this.config.defaultOrganizationId),
            inArray(usageLedger.requestId, requestIds)
          ))
          .orderBy(asc(usageLedger.createdAt))
      : [];
    return {
      prompts,
      routeDecisions: decisions,
      providerAttempts: attempts,
      usageLedger: usageRows,
      events: await this.eventsForSession(sessionId, requestIds)
    };
  }

  private async summarizeRequests(
    requestRows: RequestRow[],
    options: { aggregateUsageByRequest?: boolean } = {}
  ) {
    if (requestRows.length === 0) return [];
    const requestIds = requestRows.map((request) => request.id);
    const decisions = await this.db
      .select()
      .from(routeDecisions)
      .where(inArray(routeDecisions.requestId, requestIds));
    const attempts = await this.db
      .select()
      .from(providerAttempts)
      .where(inArray(providerAttempts.requestId, requestIds));
    const attemptIds = attempts.map((attempt) => attempt.id);
    const usageRows = attemptIds.length > 0
      ? await this.db
          .select()
          .from(usageLedger)
          .where(inArray(usageLedger.providerAttemptId, attemptIds))
      : [];

    const decisionsByRequest = new Map(decisions.map((decision) => [decision.requestId, decision]));
    const attemptsByRequest = latestAttemptsByRequest(attempts);
    const attemptCountsByRequest = attemptCounts(attempts);
    const usageByRequest = options.aggregateUsageByRequest
      ? aggregateUsageByRequest(usageRows)
      : new Map<string, UsageAggregate>();
    const usageByAttempt = options.aggregateUsageByRequest
      ? new Map<string, UsageAggregate>()
      : new Map(usageRows.map((usage) => [usage.providerAttemptId, usageAggregateForRow(usage)]));

    return requestRows.map((request) => {
      const attempt = attemptsByRequest.get(request.id) ?? null;
      return requestSummary({
        request,
        decision: decisionsByRequest.get(request.id) ?? null,
        attempt,
        usage: options.aggregateUsageByRequest
          ? usageByRequest.get(request.id) ?? null
          : attempt ? usageByAttempt.get(attempt.id) ?? null : null,
        attemptCount: attemptCountsByRequest.get(request.id) ?? 0
      }, this.catalog);
    });
  }

  private async eventCount() {
    const [row] = await this.db
      .select({
        count: sql<number>`count(*)`
      })
      .from(events)
      .where(eq(events.organizationId, this.config.defaultOrganizationId));
    return Number(row?.count ?? 0);
  }

  private async promptRows(filters: PromptListFilters) {
    const conditions = promptConditions(this.config.defaultOrganizationId, filters);
    return this.db
      .select({
        artifact: promptArtifacts,
        request: requests,
        decision: routeDecisions,
        usage: usageLedger
      })
      .from(promptArtifacts)
      .innerJoin(requests, and(
        eq(requests.id, promptArtifacts.requestId),
        eq(requests.organizationId, promptArtifacts.organizationId)
      ))
      .leftJoin(routeDecisions, eq(routeDecisions.requestId, requests.id))
      .leftJoin(usageLedger, eq(usageLedger.requestId, requests.id))
      .where(and(...conditions))
      .orderBy(desc(promptArtifacts.createdAt))
      .limit(promptLimit(filters.limit))
      .offset(promptOffset(filters.offset));
  }

  private async eventsForRequest(requestId: string) {
    const requestEvents = await this.db
      .select()
      .from(events)
      .where(and(
        eq(events.organizationId, this.config.defaultOrganizationId),
        eq(events.scopeId, requestId)
      ))
      .orderBy(events.sequence);
    const correlatedEvents = await this.db
      .select()
      .from(events)
      .where(and(
        eq(events.organizationId, this.config.defaultOrganizationId),
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
        eq(events.organizationId, this.config.defaultOrganizationId),
        or(...scopeConditions)
      ))
      .orderBy(asc(events.createdAt));
  }
}

type RequestRow = typeof requests.$inferSelect;
type ProviderAttemptRow = typeof providerAttempts.$inferSelect;
type UsageLedgerRow = typeof usageLedger.$inferSelect;
type SessionRow = typeof agentSessions.$inferSelect;
type UserRow = typeof usersTable.$inferSelect;
type ApiKeySummaryRow = {
  id: string;
  organizationId: string;
  userId: string | null;
  name: string;
  scopes: string[];
  routingConfigId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  routingConfigName: string | null;
  routingConfigStatus: string | null;
};
type PromptRow = {
  artifact: typeof promptArtifacts.$inferSelect;
  request: typeof requests.$inferSelect;
  decision: typeof routeDecisions.$inferSelect | null;
  usage: typeof usageLedger.$inferSelect | null;
};

function promptConditions(organizationId: string, filters: PromptListFilters) {
  const conditions = [
    eq(promptArtifacts.organizationId, organizationId),
    eq(requests.organizationId, organizationId)
  ];
  if (filters.userId) conditions.push(eq(requests.userId, filters.userId));
  const surface = surfaceValue(filters.surface);
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

function apiKeySummary(row: ApiKeySummaryRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId ?? null,
    name: row.name,
    scopes: row.scopes,
    routingConfigId: row.routingConfigId ?? null,
    routingConfig: row.routingConfigId
      ? {
          id: row.routingConfigId,
          name: row.routingConfigName ?? null,
          status: row.routingConfigStatus ?? null
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null
  };
}

function promptSummary(row: PromptRow) {
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
    provider: row.decision?.selectedProvider ?? row.usage?.provider ?? undefined,
    selectedModel: row.decision?.selectedModel ?? undefined,
    routingConfig: routingConfigSummary(row.decision ?? row.request),
    cost: {
      selected: (row.usage?.totalCostMicros ?? 0) / 1_000_000
    },
    createdAt: row.artifact.createdAt.toISOString()
  };
}

function promptDetail(row: Pick<PromptRow, "artifact" | "request">) {
  return {
    ...promptSummary({
      artifact: row.artifact,
      request: row.request,
      decision: null,
      usage: null
    }),
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

function numberFromMetadata(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function requestSummary(row: {
  request: RequestRow;
  decision: typeof routeDecisions.$inferSelect | null;
  attempt: ProviderAttemptRow | null;
  usage: UsageAggregate | null;
  attemptCount: number;
}, catalog: ModelCatalog) {
  const usage = row.usage
    ? {
        inputTokens: row.usage.inputTokens,
        cachedInputTokens: row.usage.cachedInputTokens,
        outputTokens: row.usage.outputTokens,
        reasoningTokens: row.usage.reasoningTokens,
        totalTokens: row.usage.totalTokens
      }
    : emptyUsage();
  const selectedModel = row.decision?.selectedModel ?? row.attempt?.model ?? undefined;
  const selectedCost = (row.usage?.totalCostMicros ?? 0) / 1_000_000;
  const baselineCost = baselineCostFor(catalog, row.request.surface, row.request.requestedModel, usage);
  return {
    requestId: row.request.id,
    userId: row.request.userId ?? undefined,
    sessionId: row.request.sessionId ?? undefined,
    surface: row.request.surface,
    requestedModel: row.request.requestedModel,
    finalRoute: row.decision?.finalRoute ?? undefined,
    provider: row.decision?.selectedProvider ?? row.attempt?.provider ?? undefined,
    selectedModel,
    routingConfig: routingConfigSummary(row.decision ?? row.request),
    terminalStatus: row.attempt?.terminalStatus ?? row.request.status,
    inputChars: row.request.inputChars,
    usage,
    latencyMs: elapsedMs(row.attempt?.startedAt, row.attempt?.completedAt),
    timeToFirstByteMs: elapsedMs(row.attempt?.startedAt, row.attempt?.firstByteAt),
    attemptCount: row.attemptCount,
    selectedCost,
    baselineCost,
    savings: baselineCost - selectedCost,
    createdAt: row.request.createdAt.toISOString(),
    completedAt: row.request.completedAt?.toISOString() ?? undefined
  };
}

type RequestSummary = ReturnType<typeof requestSummary>;
type UsageGroupBy = "user" | "provider" | "model" | "route" | "surface" | "session";
type UsageAggregate = ReturnType<typeof emptyUsageAggregate>;
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
  };
};

function userIdsForRequestsAndSessions(requests: RequestSummary[], sessions: SessionRow[]) {
  return [
    ...requests.flatMap((request) => request.userId ? [request.userId] : []),
    ...sessions.flatMap((session) => session.userId ? [session.userId] : [])
  ];
}

function sessionIdsForRequests(requests: RequestSummary[]) {
  return requests.flatMap((request) => request.sessionId ? [request.sessionId] : []);
}

function userSummary(
  user: UserRow,
  allRequests: RequestSummary[],
  allSessions: SessionRow[]
) {
  const requests = allRequests.filter((request) => request.userId === user.id);
  const requestSessionIds = new Set(sessionIdsForRequests(requests));
  const sessions = allSessions.filter((session) =>
    session.userId === user.id || requestSessionIds.has(session.id)
  );
  return {
    userId: user.id,
    email: user.email ?? undefined,
    name: user.name ?? undefined,
    externalId: user.externalId ?? undefined,
    requestCount: requests.length,
    sessionCount: sessions.length,
    usage: usageTotals(requests),
    cost: costTotals(requests),
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
    modelMix: countBy(requests, (request) => request.selectedModel ?? "unknown"),
    routeMix: countBy(requests, (request) => request.finalRoute ?? "unknown"),
    terminalStatusSummary: countBy(requests, (request) => request.terminalStatus),
    usage: usageTotals(requests),
    cost: costTotals(requests),
    recentActivity: recentActivity(requests, [session]),
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? undefined,
    updatedAt: session.updatedAt.toISOString()
  };
}

function usageTotals(requests: RequestSummary[]) {
  return requests.reduce((acc, request) => {
    acc.inputTokens += request.usage.inputTokens;
    acc.cachedInputTokens += request.usage.cachedInputTokens;
    acc.outputTokens += request.usage.outputTokens;
    acc.reasoningTokens += request.usage.reasoningTokens;
    acc.totalTokens += request.usage.totalTokens;
    return acc;
  }, emptyUsage());
}

function costTotals(requests: RequestSummary[]) {
  return requests.reduce((acc, request) => {
    acc.selected += request.selectedCost;
    acc.baseline += request.baselineCost;
    acc.savings += request.savings;
    return acc;
  }, { selected: 0, baseline: 0, savings: 0 });
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
    value === "provider" ||
    value === "model" ||
    value === "route" ||
    value === "surface" ||
    value === "session"
  ) {
    return value;
  }
  return "route";
}

function usageGroupKey(request: RequestSummary, groupBy: UsageGroupBy) {
  if (groupBy === "user") return request.userId ?? "unknown";
  if (groupBy === "provider") return request.provider ?? "unknown";
  if (groupBy === "model") return request.selectedModel ?? "unknown";
  if (groupBy === "route") return request.finalRoute ?? "unknown";
  if (groupBy === "surface") return request.surface ?? "unknown";
  return request.sessionId ?? "unknown";
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
      savings: 0
    }
  };
}

function addUsageRequest(group: UsageGroup, request: RequestSummary) {
  group.requestCount += 1;
  if (request.terminalStatus === "failed") group.failedRequests += 1;
  if (request.attemptCount > 1) group.retriedRequests += 1;
  group.usage.inputTokens += request.usage.inputTokens;
  group.usage.cachedInputTokens += request.usage.cachedInputTokens;
  group.usage.outputTokens += request.usage.outputTokens;
  group.usage.reasoningTokens += request.usage.reasoningTokens;
  group.usage.totalTokens += request.usage.totalTokens;
  group.cost.selected += request.selectedCost;
  group.cost.baseline += request.baselineCost;
  group.cost.savings += request.savings;
}

function finalizeUsageGroup(group: UsageGroup) {
  return {
    key: group.key,
    requestCount: group.requestCount,
    failedRequests: group.failedRequests,
    retriedRequests: group.retriedRequests,
    failureRate: group.requestCount === 0 ? 0 : group.failedRequests / group.requestCount,
    retryRate: group.requestCount === 0 ? 0 : group.retriedRequests / group.requestCount,
    usage: group.usage,
    cost: group.cost
  };
}

function latestAttemptsByRequest(attempts: ProviderAttemptRow[]) {
  const latest = new Map<string, ProviderAttemptRow>();
  const sorted = [...attempts].sort((left, right) =>
    timestamp(right.startedAt) - timestamp(left.startedAt)
  );
  for (const attempt of sorted) {
    if (!latest.has(attempt.requestId)) latest.set(attempt.requestId, attempt);
  }
  return latest;
}

function attemptCounts(attempts: ProviderAttemptRow[]) {
  const counts = new Map<string, number>();
  for (const attempt of attempts) {
    counts.set(attempt.requestId, (counts.get(attempt.requestId) ?? 0) + 1);
  }
  return counts;
}

function aggregateUsageByRequest(usageRows: UsageLedgerRow[]) {
  const byRequest = new Map<string, UsageAggregate>();
  for (const row of usageRows) {
    const usage = byRequest.get(row.requestId) ?? emptyUsageAggregate();
    addUsageRow(usage, row);
    byRequest.set(row.requestId, usage);
  }
  return byRequest;
}

function usageAggregateForRow(row: UsageLedgerRow) {
  const usage = emptyUsageAggregate();
  addUsageRow(usage, row);
  return usage;
}

function addUsageRow(usage: UsageAggregate, row: UsageLedgerRow) {
  usage.inputTokens += row.inputTokens;
  usage.cachedInputTokens += row.cachedInputTokens;
  usage.outputTokens += row.outputTokens;
  usage.reasoningTokens += row.reasoningTokens;
  usage.totalTokens += row.totalTokens;
  usage.totalCostMicros += row.totalCostMicros;
}

function timestamp(value: Date | null | undefined) {
  return value?.getTime() ?? 0;
}

function baselineCostFor(
  catalog: ModelCatalog,
  surface: string,
  requestedModel: string,
  usage: ReturnType<typeof emptyUsage>
) {
  const compatibleSurface = surfaceValue(surface);
  if (!compatibleSurface) return 0;
  const route = explicitAlias(compatibleSurface, requestedModel) ?? "balanced";
  const model = modelForRoute(catalog, route, compatibleSurface).upstreamModel;
  return usageCostMicros(catalog, model, usage).totalCostMicros / 1_000_000;
}

function elapsedMs(start: Date | null | undefined, end: Date | null | undefined) {
  if (!start || !end) return undefined;
  return end.getTime() - start.getTime();
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
}

function emptyUsageAggregate() {
  return {
    ...emptyUsage(),
    totalCostMicros: 0
  };
}

function routeIndex(route: RouteName | undefined) {
  if (route === "fast") return 0;
  if (route === "balanced") return 1;
  if (route === "hard") return 2;
  if (route === "deep") return 3;
  return -1;
}
