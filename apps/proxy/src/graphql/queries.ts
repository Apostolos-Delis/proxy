import { readSettingsFile } from "../settings.js";
import { builder } from "./builder.js";
import { scopedQueries, viewerPayload } from "./context.js";
import type { RequestSummaryShape, UsageReportModel, UsageTimeseriesModel } from "./models.js";
import { settingsResponse } from "./settingsPayload.js";
import { Overview, UsageGroupBy, UsageInterval, UsageReport, UsageTimeseries } from "./types/analytics.js";
import { Invitation, PublicInvitation } from "./types/invitations.js";
import { PromptAccessAuditEntry, PromptDetail, PromptPage } from "./types/prompts.js";
import { RequestDetail, RequestSummary } from "./types/requests.js";
import { ApiKey, ProviderAccount, RoutingConfigDetail, RoutingConfigSummary } from "./types/routing.js";
import { SearchResult } from "./types/search.js";
import { SessionDetail, SessionSummary } from "./types/sessions.js";
import { Settings } from "./types/settings.js";
import { OrgMember, UserDetail, UserSummary } from "./types/users.js";
import { Viewer } from "./types/viewer.js";

const PROMPT_GRAPHQL_ACCESS_PATH = "/admin/graphql#prompt";

function emptyUsageReport(): UsageReportModel {
  return {
    groupBy: "route",
    data: [],
    totals: {
      key: "total",
      requestCount: 0,
      failedRequests: 0,
      retriedRequests: 0,
      failureRate: 0,
      retryRate: 0,
      latency: { averageMs: null, p95Ms: null },
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0
      },
      cost: { selected: 0, baseline: 0, savings: 0 }
    }
  };
}

builder.queryFields((t) => ({
  viewer: t.field({
    type: Viewer,
    resolve: (_root, _args, context) => viewerPayload(context.identity(), context.persistence)
  }),

  overview: t.field({
    type: Overview,
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      if (queries) return queries.overview();
      const allEvents = context.events.listEvents();
      const usage = context.projections.usage(allEvents);
      const routeQuality = context.projections.routeQuality(allEvents);
      return {
        organizationId: context.config.defaultOrganizationId,
        eventCount: allEvents.length,
        requestCount: usage.requests.length,
        totals: usage.totals,
        cost: usage.cost,
        routeQuality: {
          lowConfidenceCount: routeQuality.lowConfidence.length,
          cheaperLikelyWouldWorkCount: routeQuality.cheaperLikelyWouldWork.length,
          cheapCausedRetriesOrRepairsCount: routeQuality.cheapCausedRetriesOrRepairs.length
        }
      };
    }
  }),

  requests: t.field({
    type: [RequestSummary],
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      if (queries) return (await queries.requests()).data;
      return [...context.projections.usage(context.events.listEvents()).requests].reverse();
    }
  }),

  request: t.field({
    type: RequestDetail,
    args: { requestId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const requestId = String(args.requestId);
      const queries = scopedQueries(context);
      if (queries) return queries.requestDetail(requestId);
      const allEvents = context.events.listEvents();
      const requestSummary: RequestSummaryShape | undefined = context.projections
        .usage(allEvents)
        .requests.find((item) => item.requestId === requestId);
      return {
        request: requestSummary ?? null,
        events: allEvents.filter(
          (event) => event.scopeId === requestId || event.correlationId === requestId
        )
      };
    }
  }),

  usage: t.field({
    type: UsageReport,
    args: {
      groupBy: t.arg({ type: UsageGroupBy }),
      start: t.arg.string(),
      end: t.arg.string()
    },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (!queries) return emptyUsageReport();
      return queries.usage({
        groupBy: args.groupBy ?? undefined,
        start: args.start ?? undefined,
        end: args.end ?? undefined
      });
    }
  }),

  usageTimeseries: t.field({
    type: UsageTimeseries,
    args: {
      groupBy: t.arg({ type: UsageGroupBy }),
      interval: t.arg({ type: UsageInterval }),
      start: t.arg.string(),
      end: t.arg.string(),
      limit: t.arg.int()
    },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (queries) {
        return queries.usageTimeseries({
          groupBy: args.groupBy ?? undefined,
          interval: args.interval ?? undefined,
          start: args.start ?? undefined,
          end: args.end ?? undefined,
          limit: args.limit ?? undefined
        });
      }
      const now = new Date().toISOString();
      const empty: UsageTimeseriesModel = {
        groupBy: args.groupBy ?? "route",
        interval: args.interval ?? "day",
        start: args.start ?? now,
        end: args.end ?? now,
        groups: [],
        points: []
      };
      return empty;
    }
  }),

  prompts: t.field({
    type: PromptPage,
    args: {
      limit: t.arg.int(),
      offset: t.arg.int(),
      userId: t.arg.string(),
      surface: t.arg.string(),
      route: t.arg.string(),
      model: t.arg.string(),
      start: t.arg.string(),
      end: t.arg.string()
    },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (!queries) return { data: [], pagination: { limit: 50, offset: 0, count: 0 } };
      return queries.prompts({
        limit: args.limit ?? undefined,
        offset: args.offset ?? undefined,
        userId: args.userId ?? undefined,
        surface: args.surface ?? undefined,
        route: args.route ?? undefined,
        model: args.model ?? undefined,
        start: args.start ?? undefined,
        end: args.end ?? undefined
      });
    }
  }),

  prompt: t.field({
    type: PromptDetail,
    nullable: true,
    args: { artifactId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (!queries || !context.persistence) return null;
      const detail = await queries.promptDetail(String(args.artifactId));
      if (!detail) return null;
      await context.persistence.promptAccessAudit.append({
        organizationId: context.identity().organizationId,
        workspaceId: context.identity().workspaceId,
        artifactId: detail.artifact.artifactId,
        requestId: detail.artifact.requestId,
        userId: context.identity().userId,
        adminSessionId: context.identity().sessionId,
        route: detail.request?.finalRoute,
        accessPath: PROMPT_GRAPHQL_ACCESS_PATH
      });
      return detail;
    }
  }),

  publicInvitation: t.field({
    type: PublicInvitation,
    nullable: true,
    args: { token: t.arg.string({ required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.persistence) return null;
      const token = args.token.trim();
      if (!token) return null;
      return context.persistence.userAdmin.resolveInvitation(token);
    }
  }),

  promptAccessAudit: t.field({
    type: [PromptAccessAuditEntry],
    resolve: async (_root, _args, context) => {
      if (!context.persistence) return [];
      const audit = await context.persistence.promptAccessAudit.list(
        context.identity().organizationId
      );
      return audit.data;
    }
  }),

  members: t.field({
    type: [OrgMember],
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      return queries ? queries.memberDirectory() : [];
    }
  }),

  users: t.field({
    type: [UserSummary],
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      return queries ? (await queries.users()).data : [];
    }
  }),

  user: t.field({
    type: UserDetail,
    nullable: true,
    args: { userId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      return queries ? queries.userDetail(String(args.userId)) : null;
    }
  }),

  sessions: t.field({
    type: [SessionSummary],
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      return queries ? (await queries.sessions()).data : [];
    }
  }),

  session: t.field({
    type: SessionDetail,
    nullable: true,
    args: { sessionId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      return queries ? queries.sessionDetail(String(args.sessionId)) : null;
    }
  }),

  apiKeys: t.field({
    type: [ApiKey],
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      return queries ? (await queries.apiKeys()).data : [];
    }
  }),

  apiKey: t.field({
    type: ApiKey,
    nullable: true,
    args: { apiKeyId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (!queries) return null;
      const detail = await queries.apiKeyDetail(String(args.apiKeyId));
      return detail?.apiKey ?? null;
    }
  }),

  providerAccounts: t.field({
    type: [ProviderAccount],
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      return queries ? (await queries.providerAccounts()).data : [];
    }
  }),

  routingConfigs: t.field({
    type: [RoutingConfigSummary],
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      return queries ? (await queries.routingConfigs()).data : [];
    }
  }),

  routingConfig: t.field({
    type: RoutingConfigDetail,
    nullable: true,
    args: { configId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      return queries ? queries.routingConfigDetail(String(args.configId)) : null;
    }
  }),

  invitations: t.field({
    type: [Invitation],
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      return queries ? (await queries.invitations()).data : [];
    }
  }),

  search: t.field({
    type: SearchResult,
    args: { query: t.arg.string({ required: true }) },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (!queries) return { query: args.query, results: [] };
      return queries.search(args.query);
    }
  }),

  settings: t.field({
    type: Settings,
    resolve: async (_root, _args, context) =>
      settingsResponse(
        context.config,
        context.identity().organizationId,
        await readSettingsFile(context.config.settingsPath),
        context.persistence
      )
  })
}));
