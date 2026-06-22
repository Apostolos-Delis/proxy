import { Kind, type GraphQLResolveInfo, type SelectionNode } from "graphql";

import { CACHE_TTL_DEFAULT_MS, CACHE_TTL_POLICY_LOOKBACK_MS, CACHE_TTL_UPGRADED_MS } from "../cacheWindows.js";
import {
  compressionReceiptPreviewBlock,
  previewCompressionReceipts,
  previewCompressionSample
} from "../compressionPreview.js";
import { aggregateCompressionSavings } from "../persistence/compressionSavings.js";
import { aggregateIdleGaps } from "../persistence/idleGaps.js";
import { aggregateTokenAttribution } from "../persistence/tokenAttributionReport.js";
import { compareModelPricingEntries, staticPricingEntries } from "../pricing.js";
import { readSettingsFile } from "../settings.js";
import { availableCompressionRules } from "../toolResultCompression.js";
import type { Surface } from "../types.js";
import { requireAdminRole } from "./authz.js";
import { builder } from "./builder.js";
import { scopedQueries, viewerPayload } from "./context.js";
import { adminGraphQLError } from "./errors.js";
import type { RequestSummaryShape, UsageReportModel, UsageTimeseriesModel } from "./models.js";
import { settingsResponse } from "./settingsPayload.js";
import {
  ActiveSessionCount,
  CacheBustReport,
  CompressionSavingsReport,
  IdleGapReport,
  Overview,
  OverviewDashboard,
  RouteOutputReport,
  TokenAttributionReport,
  UsageDashboard,
  UsageGroupBy,
  UsageInterval,
  UsageReport,
  UsageTimeseries
} from "./types/analytics.js";
import { CompressionPreviewInput, CompressionPreviewType } from "./types/compression.js";
import { ModelPricingEntry } from "./types/pricing.js";
import { Invitation, PublicInvitation } from "./types/invitations.js";
import { PromptAccessAuditEntry, PromptDetail, PromptPage } from "./types/prompts.js";
import { RequestDetail, RequestSummary } from "./types/requests.js";
import {
  ApiKey,
  ProviderAccount,
  ProviderCredentialOAuthStatus,
  ProviderRegistryEntry,
  RoutingConfigDetail,
  RoutingConfigSummary
} from "./types/routing.js";
import { SearchResult } from "./types/search.js";
import { SessionDetail, SessionSummary } from "./types/sessions.js";
import { CompressionRuleCatalog, Settings } from "./types/settings.js";
import { OrgMember, UserDetail, UserSummary } from "./types/users.js";
import { Viewer } from "./types/viewer.js";

const PROMPT_GRAPHQL_ACCESS_PATH = "/admin/graphql#prompt";

function compressionPreviewSurface(value: string | null | undefined): Surface {
  if (value === "anthropic-messages" || value === "openai-responses" || value === "openai-chat") return value;
  throw adminGraphQLError("compression_preview_surface_required", 400);
}

async function compressionPreviewContentAccess(
  context: Parameters<typeof scopedQueries>[0],
  organizationId: string
) {
  if (!context.persistence) return { allowed: false, reason: "prompt_capture_unavailable" };
  const settings = await context.persistence.promptArtifacts.settings(organizationId);
  if (settings.promptCaptureMode !== "raw_text") {
    return { allowed: false, reason: `prompt_capture_${settings.promptCaptureMode}` };
  }
  return { allowed: true, reason: null };
}

async function compressionPreviewPolicy(
  context: Parameters<typeof scopedQueries>[0],
  organizationId: string
) {
  if (!context.persistence) return undefined;
  return (await context.persistence.organizationSettings.editable(organizationId)).toolResultCompressionPolicy;
}

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
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0
      },
      cost: { selected: 0, baseline: 0, savings: 0, classifier: 0 }
    }
  };
}

function sessionDetailOptions(info: GraphQLResolveInfo) {
  const fields = selectedFieldNames(info);
  const promptArtifactFields = selectedChildFieldNames(info, "promptArtifacts");
  return {
    includePromptArtifacts: fields.has("promptArtifacts"),
    includePromptArtifactContent: promptArtifactFields.has("rawText") ||
      promptArtifactFields.has("redactedText") ||
      promptArtifactFields.has("encryptedBlobRef"),
    includeRouteDecisions: fields.has("routeDecisions"),
    includeProviderAttempts: fields.has("providerAttempts"),
    includeUsageLedger: fields.has("usageLedger"),
    includeEvents: fields.has("events")
  };
}

function selectedFieldNames(info: GraphQLResolveInfo) {
  const fields = new Set<string>();
  const seenFragments = new Set<string>();
  for (const node of info.fieldNodes) {
    if (node.selectionSet) collectFieldNames(info, node.selectionSet.selections, fields, seenFragments);
  }
  return fields;
}

function selectedChildFieldNames(info: GraphQLResolveInfo, parentField: string) {
  const fields = new Set<string>();
  const seenFragments = new Set<string>();
  for (const node of info.fieldNodes) {
    if (node.selectionSet) {
      collectChildFieldNames(info, node.selectionSet.selections, parentField, fields, seenFragments, false);
    }
  }
  return fields;
}

function collectFieldNames(
  info: GraphQLResolveInfo,
  selections: readonly SelectionNode[],
  fields: Set<string>,
  seenFragments: Set<string>
) {
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD) {
      fields.add(selection.name.value);
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      collectFieldNames(info, selection.selectionSet.selections, fields, seenFragments);
      continue;
    }
    const fragment = info.fragments[selection.name.value];
    if (!fragment || seenFragments.has(selection.name.value)) continue;
    seenFragments.add(selection.name.value);
    collectFieldNames(info, fragment.selectionSet.selections, fields, seenFragments);
  }
}

function collectChildFieldNames(
  info: GraphQLResolveInfo,
  selections: readonly SelectionNode[],
  parentField: string,
  fields: Set<string>,
  seenFragments: Set<string>,
  insideParent: boolean
) {
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD) {
      if (insideParent) fields.add(selection.name.value);
      if (!insideParent && selection.name.value === parentField && selection.selectionSet) {
        collectChildFieldNames(info, selection.selectionSet.selections, parentField, fields, seenFragments, true);
      }
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      collectChildFieldNames(info, selection.selectionSet.selections, parentField, fields, seenFragments, insideParent);
      continue;
    }
    const fragmentKey = `${selection.name.value}:${insideParent}`;
    const fragment = info.fragments[selection.name.value];
    if (!fragment || seenFragments.has(fragmentKey)) continue;
    seenFragments.add(fragmentKey);
    collectChildFieldNames(info, fragment.selectionSet.selections, parentField, fields, seenFragments, insideParent);
  }
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

  overviewDashboard: t.field({
    type: OverviewDashboard,
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      if (queries) return queries.overviewDashboard();
      const allEvents = context.events.listEvents();
      const usage = context.projections.usage(allEvents);
      const routeQuality = context.projections.routeQuality(allEvents);
      const modelUsage = emptyUsageReport();
      modelUsage.groupBy = "model";
      return {
        overview: {
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
        },
        requests: [...usage.requests].reverse(),
        modelUsage
      };
    }
  }),

  requests: t.field({
    type: [RequestSummary],
    args: {
      limit: t.arg.int(),
      start: t.arg.string(),
      end: t.arg.string()
    },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (queries) {
        return (await queries.requests({
          limit: args.limit ?? undefined,
          start: args.start ?? undefined,
          end: args.end ?? undefined
        })).data;
      }
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
        routeDecisions: [],
        providerAttempts: [],
        events: allEvents.filter(
          (event) => event.scopeId === requestId || event.correlationId === requestId
        ),
        compressionReceipts: []
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

  usageDashboard: t.field({
    type: UsageDashboard,
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
        return queries.usageDashboard({
          groupBy: args.groupBy ?? undefined,
          interval: args.interval ?? undefined,
          start: args.start ?? undefined,
          end: args.end ?? undefined,
          limit: args.limit ?? undefined
        });
      }
      return {
        usage: emptyUsageReport(),
        timeseries: {
          groupBy: args.groupBy ?? "route",
          interval: args.interval ?? "day",
          start: args.start ?? new Date().toISOString(),
          end: args.end ?? new Date().toISOString(),
          groups: [],
          points: []
        }
      };
    }
  }),

  routeOutputReport: t.field({
    type: RouteOutputReport,
    args: {
      start: t.arg.string(),
      end: t.arg.string()
    },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (queries) {
        return queries.routeOutputReport({
          start: args.start ?? undefined,
          end: args.end ?? undefined
        });
      }
      return { routes: [], models: [], users: [], apiKeys: [], workspaces: [] };
    }
  }),

  activeSessionCount: t.field({
    type: ActiveSessionCount,
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      if (!queries) return { activeSessions: 0, windowMs: CACHE_TTL_DEFAULT_MS };
      const upgraded = await context.persistence?.organizationSettings
        .cacheTtlUpgrade(context.identity().organizationId);
      const idleGaps = upgraded
        ? await queries.idleGaps({ start: new Date(Date.now() - CACHE_TTL_POLICY_LOOKBACK_MS).toISOString() })
        : undefined;
      const windowMs = idleGaps && idleGaps.recoverableByOneHourTtl > 0
        ? CACHE_TTL_UPGRADED_MS
        : CACHE_TTL_DEFAULT_MS;
      return queries.activeSessionCount(windowMs);
    }
  }),

  idleGaps: t.field({
    type: IdleGapReport,
    args: {
      start: t.arg.string(),
      end: t.arg.string()
    },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (queries) {
        return queries.idleGaps({
          start: args.start ?? undefined,
          end: args.end ?? undefined
        });
      }
      return aggregateIdleGaps([], false);
    }
  }),

  cacheBusts: t.field({
    type: CacheBustReport,
    args: {
      start: t.arg.string(),
      end: t.arg.string()
    },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (queries) {
        return queries.cacheBusts({
          start: args.start ?? undefined,
          end: args.end ?? undefined
        });
      }
      return {
        busts: [],
        countsByCause: { ttl_expiry: 0, model_switch: 0, provider_switch: 0, unknown: 0 },
        sessionsScanned: 0,
        sampled: false
      };
    }
  }),

  tokenAttribution: t.field({
    type: TokenAttributionReport,
    args: {
      start: t.arg.string(),
      end: t.arg.string()
    },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (queries) {
        return queries.tokenAttribution({
          start: args.start ?? undefined,
          end: args.end ?? undefined
        });
      }
      const payloads = context.events
        .listEvents()
        .filter((event) => event.eventType === "tokens.attributed")
        .map((event) => event.payload);
      return aggregateTokenAttribution(payloads, false);
    }
  }),

  compressionSavings: t.field({
    type: CompressionSavingsReport,
    args: {
      start: t.arg.string(),
      end: t.arg.string()
    },
    resolve: async (_root, args, context) => {
      const queries = scopedQueries(context);
      if (queries) {
        return queries.compressionSavings({
          start: args.start ?? undefined,
          end: args.end ?? undefined
        });
      }
      const payloads = context.events
        .listEvents()
        .filter((event) => event.eventType === "compression.recorded")
        .map((event) => event.payload);
      return aggregateCompressionSavings(payloads, false);
    }
  }),

  compressionRules: t.field({
    type: [CompressionRuleCatalog],
    resolve: (_root, _args, context) => {
      requireAdminRole(context);
      return availableCompressionRules();
    }
  }),

  compressionPreview: t.field({
    type: CompressionPreviewType,
    args: {
      input: t.arg({ type: CompressionPreviewInput, required: true })
    },
    resolve: async (_root, args, context) => {
      const identity = requireAdminRole(context);
      const hasRequestId = args.input.requestId !== undefined && args.input.requestId !== null;
      const hasBody = args.input.body !== undefined && args.input.body !== null;
      if (hasRequestId === hasBody) throw adminGraphQLError("compression_preview_requires_request_id_or_body", 400);

      if (hasRequestId) {
        const queries = scopedQueries(context);
        if (!queries) {
          return previewCompressionReceipts({
            blocks: [],
            contentRedactionReason: "database_unavailable"
          });
        }
        const detail = await queries.requestDetail(String(args.input.requestId));
        return previewCompressionReceipts({
          blocks: detail.compressionReceipts.map(compressionReceiptPreviewBlock),
          contentRedactionReason: "request_preview_uses_receipts_only"
        });
      }

      const surface = compressionPreviewSurface(args.input.surface);
      const contentAccess = await compressionPreviewContentAccess(context, identity.organizationId);
      const policy = args.input.policy ?? (await compressionPreviewPolicy(context, identity.organizationId));
      return previewCompressionSample({
        surface,
        body: args.input.body,
        policy,
        contentAllowed: contentAccess.allowed,
        contentRedactionReason: contentAccess.reason
      });
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
      requireAdminRole(context);
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
      const identity = requireAdminRole(context);
      const queries = scopedQueries(context);
      if (!queries || !context.persistence) return null;
      const detail = await queries.promptDetail(String(args.artifactId));
      if (!detail) return null;
      await context.persistence.promptAccessAudit.append({
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        artifactId: detail.artifact.artifactId,
        requestId: detail.artifact.requestId,
        userId: identity.userId,
        adminSessionId: identity.sessionId,
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
      const identity = requireAdminRole(context);
      if (!context.persistence) return [];
      const audit = await context.persistence.promptAccessAudit.list(
        identity.organizationId
      );
      return audit.data;
    }
  }),

  members: t.field({
    type: [OrgMember],
    resolve: async (_root, _args, context) => {
      requireAdminRole(context);
      const queries = scopedQueries(context);
      return queries ? queries.memberDirectory() : [];
    }
  }),

  users: t.field({
    type: [UserSummary],
    resolve: async (_root, _args, context) => {
      requireAdminRole(context);
      const queries = scopedQueries(context);
      return queries ? (await queries.users()).data : [];
    }
  }),

  user: t.field({
    type: UserDetail,
    nullable: true,
    args: { userId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      requireAdminRole(context);
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
    resolve: async (_root, args, context, info) => {
      requireAdminRole(context);
      const queries = scopedQueries(context);
      return queries ? queries.sessionDetail(String(args.sessionId), sessionDetailOptions(info)) : null;
    }
  }),

  apiKeys: t.field({
    type: [ApiKey],
    resolve: async (_root, _args, context) => {
      requireAdminRole(context);
      const queries = scopedQueries(context);
      return queries ? (await queries.apiKeys()).data : [];
    }
  }),

  apiKey: t.field({
    type: ApiKey,
    nullable: true,
    args: { apiKeyId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      requireAdminRole(context);
      const queries = scopedQueries(context);
      if (!queries) return null;
      const detail = await queries.apiKeyDetail(String(args.apiKeyId));
      return detail?.apiKey ?? null;
    }
  }),

  providerAccounts: t.field({
    type: [ProviderAccount],
    resolve: async (_root, _args, context) => {
      requireAdminRole(context);
      const queries = scopedQueries(context);
      return queries ? (await queries.providerAccounts()).data : [];
    }
  }),

  providerCredentialOAuthStatus: t.field({
    type: ProviderCredentialOAuthStatus,
    nullable: true,
    args: { loginId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const identity = requireAdminRole(context);
      return context.persistence?.providerCredentialOAuth.status(String(args.loginId), {
        organizationId: identity.organizationId,
        actorUserId: identity.userId
      }) ?? null;
    }
  }),

  providers: t.field({
    type: [ProviderRegistryEntry],
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      return queries ? (await queries.providers()).data : [];
    }
  }),

  routingConfigs: t.field({
    type: [RoutingConfigSummary],
    resolve: async (_root, _args, context) => {
      const identity = requireAdminRole(context);
      const queries = scopedQueries(context);
      if (!queries) return [];
      // Backfill the default config for workspaces created before
      // provisioning-on-creation. Best-effort: a provisioning failure must not
      // break the Routing page, which would otherwise render as it does today.
      try {
        await context.persistence?.routingConfigAdmin.ensureWorkspaceDefaultConfig({
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          actorUserId: identity.userId
        });
      } catch {
        // ignore — fall through to listing whatever configs exist
      }
      return (await queries.routingConfigs()).data;
    }
  }),

  routingConfig: t.field({
    type: RoutingConfigDetail,
    nullable: true,
    args: { configId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      requireAdminRole(context);
      const queries = scopedQueries(context);
      return queries ? queries.routingConfigDetail(String(args.configId)) : null;
    }
  }),

  invitations: t.field({
    type: [Invitation],
    resolve: async (_root, _args, context) => {
      requireAdminRole(context);
      const queries = scopedQueries(context);
      return queries ? (await queries.invitations()).data : [];
    }
  }),

  search: t.field({
    type: SearchResult,
    args: { query: t.arg.string({ required: true }) },
    resolve: async (_root, args, context) => {
      requireAdminRole(context);
      const queries = scopedQueries(context);
      if (!queries) return { query: args.query, results: [] };
      return queries.search(args.query);
    }
  }),

  modelPricing: t.field({
    type: [ModelPricingEntry],
    resolve: async (_root, _args, context) => {
      const queries = scopedQueries(context);
      if (queries) return queries.modelPricing();
      return staticPricingEntries(
        context.config.modelCosts,
        context.config.modelCostsFromEnv
      ).sort(compareModelPricingEntries);
    }
  }),

  settings: t.field({
    type: Settings,
    resolve: async (_root, _args, context) => {
      const identity = requireAdminRole(context);
      return settingsResponse(
        context.config,
        identity.organizationId,
        await readSettingsFile(context.config.settingsPath),
        context.persistence
      );
    }
  })
}));
