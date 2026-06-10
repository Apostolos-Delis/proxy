import type { AdminQueryService } from "../persistence/adminQueries.js";
import type { PromptAccessAuditStore } from "../persistence/promptAccessAudit.js";
import type { AdminSessionStore } from "../persistence/adminSessions.js";

type Q = AdminQueryService;

export type OverviewModel = Awaited<ReturnType<Q["overview"]>>;
export type RouteQualityModel = OverviewModel["routeQuality"];
export type TokenTotalsModel = OverviewModel["totals"];
export type CostTotalsModel = OverviewModel["cost"];

export type RequestSummaryModel = Awaited<ReturnType<Q["requests"]>>["data"][number];
export type RoutingConfigSnapshotModel = NonNullable<RequestSummaryModel["routingConfig"]>;
export type RequestDetailModel = Awaited<ReturnType<Q["requestDetail"]>>;
export type ProxyEventModel = RequestDetailModel["events"][number];

// Satisfied by both the database event serializer and the in-memory event
// store's zod-derived ProxyEvent (which keeps sessionId/correlationId optional).
export type ProxyEventShape = {
  eventId: string;
  sequence: number;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  sessionId?: string;
  correlationId?: string;
  eventType: string;
  producer: string;
  payload: unknown;
  metadata: unknown;
  createdAt: string;
};

// Widened request shape that both the database-backed summaries and the
// in-memory projection fallback (no DATABASE_URL) can satisfy. terminalStatus
// is widened to string because the projection derives it from event payloads.
export type RequestSummaryShape = Omit<Partial<RequestSummaryModel>, "terminalStatus"> &
  Pick<RequestSummaryModel, "requestId" | "usage" | "selectedCost" | "baselineCost" | "savings"> & {
    terminalStatus: string;
  };

export type RequestDetailShape = {
  request: RequestSummaryShape | null;
  events: ProxyEventShape[];
};

export type ApiKeyModel = Awaited<ReturnType<Q["apiKeys"]>>["data"][number];
export type ApiKeyRoutingConfigRefModel = NonNullable<ApiKeyModel["routingConfig"]>;

export type RoutingConfigSummaryModel = Awaited<ReturnType<Q["routingConfigs"]>>["data"][number];
export type RoutingConfigVersionModel = NonNullable<RoutingConfigSummaryModel["activeVersion"]>;
export type RouteMatrixRowModel = RoutingConfigSummaryModel["routeMatrix"][number];
export type RoutingConfigDetailModel = NonNullable<Awaited<ReturnType<Q["routingConfigDetail"]>>>;
export type RoutingConfigVersionDetailModel = RoutingConfigDetailModel["versions"][number];

export type PromptPageModel = Awaited<ReturnType<Q["prompts"]>>;
export type PromptSummaryModel = PromptPageModel["data"][number];
export type PromptPaginationModel = PromptPageModel["pagination"];
export type PromptDetailModel = NonNullable<Awaited<ReturnType<Q["promptDetail"]>>>;
export type PromptArtifactDetailModel = PromptDetailModel["artifact"];

export type UsageReportModel = Awaited<ReturnType<Q["usage"]>>;
export type UsageGroupModel = UsageReportModel["totals"];
export type LatencySummaryModel = UsageGroupModel["latency"];
export type UsageTimeseriesModel = Awaited<ReturnType<Q["usageTimeseries"]>>;
export type UsageTimeseriesPointModel = UsageTimeseriesModel["points"][number];

export type UserSummaryModel = Awaited<ReturnType<Q["users"]>>["data"][number];
export type UserMembershipModel = NonNullable<UserSummaryModel["membership"]>;
export type UserDetailModel = NonNullable<Awaited<ReturnType<Q["userDetail"]>>>;
export type MemberDirectoryEntryModel = Awaited<ReturnType<Q["memberDirectory"]>>[number];

export type SessionSummaryModel = Awaited<ReturnType<Q["sessions"]>>["data"][number];
export type SessionDetailModel = NonNullable<Awaited<ReturnType<Q["sessionDetail"]>>>;
export type ProviderAttemptModel = SessionDetailModel["providerAttempts"][number];
export type UsageLedgerRowModel = SessionDetailModel["usageLedger"][number];
export type RouteDecisionModel = SessionDetailModel["routeDecisions"][number];

export type InvitationModel = Awaited<ReturnType<Q["invitations"]>>["data"][number];
export type InvitationInviterModel = NonNullable<InvitationModel["invitedBy"]>;

export type PromptAccessAuditEntryModel = Awaited<
  ReturnType<PromptAccessAuditStore["list"]>
>["data"][number];

export type SearchResultModel = Awaited<ReturnType<Q["search"]>>;
export type SearchHitModel = SearchResultModel["results"][number];

export type OrganizationSummaryModel = Awaited<
  ReturnType<AdminSessionStore["organizationsForUser"]>
>[number];
