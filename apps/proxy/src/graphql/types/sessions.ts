import { builder } from "../builder.js";
import type {
  SessionDetailModel,
  SessionSummaryModel,
  UsageLedgerRowModel
} from "../models.js";
import { CostTotals, ProxyEvent, TokenTotals } from "./core.js";
import { PromptArtifactDetail } from "./prompts.js";
import { RequestSummary } from "./requests.js";
import { ProviderAttempt, RouteDecision } from "./routingEvidence.js";

export const SessionSummary = builder.objectRef<SessionSummaryModel>("SessionSummary").implement({
  fields: (t) => ({
    sessionId: t.exposeString("sessionId"),
    organizationId: t.exposeString("organizationId"),
    userId: t.exposeString("userId", { nullable: true }),
    surface: t.exposeString("surface"),
    externalSessionId: t.exposeString("externalSessionId", { nullable: true }),
    currentRoute: t.exposeString("currentRoute", { nullable: true }),
    sessionIdentity: t.exposeString("sessionIdentity", { nullable: true }),
    requestCount: t.exposeFloat("requestCount"),
    routeChanges: t.exposeFloat("routeChanges"),
    modelMix: t.field({ type: "JSON", resolve: (session) => session.modelMix }),
    routeMix: t.field({ type: "JSON", resolve: (session) => session.routeMix }),
    terminalStatusSummary: t.field({
      type: "JSON",
      resolve: (session) => session.terminalStatusSummary
    }),
    usage: t.expose("usage", { type: TokenTotals }),
    cacheHitRate: t.exposeFloat("cacheHitRate", { nullable: true }),
    cost: t.expose("cost", { type: CostTotals }),
    recentActivity: t.exposeString("recentActivity", { nullable: true }),
    startedAt: t.exposeString("startedAt"),
    endedAt: t.exposeString("endedAt", { nullable: true }),
    updatedAt: t.exposeString("updatedAt")
  })
});

export const UsageLedgerRow = builder.objectRef<UsageLedgerRowModel>("UsageLedgerRow").implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    requestId: t.exposeString("requestId"),
    providerAttemptId: t.exposeString("providerAttemptId", { nullable: true }),
    kind: t.exposeString("kind"),
    userId: t.exposeString("userId", { nullable: true }),
    sessionId: t.exposeString("sessionId", { nullable: true }),
    provider: t.exposeString("provider"),
    model: t.exposeString("model"),
    route: t.exposeString("route", { nullable: true }),
    inputTokens: t.exposeFloat("inputTokens"),
    cachedInputTokens: t.exposeFloat("cachedInputTokens"),
    cacheCreationInputTokens: t.exposeFloat("cacheCreationInputTokens"),
    outputTokens: t.exposeFloat("outputTokens"),
    reasoningTokens: t.exposeFloat("reasoningTokens"),
    totalTokens: t.exposeFloat("totalTokens"),
    inputCostMicros: t.exposeFloat("inputCostMicros"),
    outputCostMicros: t.exposeFloat("outputCostMicros"),
    totalCostMicros: t.exposeFloat("totalCostMicros"),
    usage: t.field({ type: "JSON", resolve: (row) => row.usage }),
    createdAt: t.exposeString("createdAt")
  })
});

export const SessionDetail = builder.objectRef<SessionDetailModel>("SessionDetail").implement({
  fields: (t) => ({
    session: t.expose("session", { type: SessionSummary }),
    user: t.field({ type: "JSON", nullable: true, resolve: (detail) => detail.user }),
    requests: t.expose("requests", { type: [RequestSummary] }),
    promptArtifacts: t.expose("promptArtifacts", { type: [PromptArtifactDetail] }),
    routeDecisions: t.expose("routeDecisions", { type: [RouteDecision] }),
    providerAttempts: t.expose("providerAttempts", { type: [ProviderAttempt] }),
    usageLedger: t.expose("usageLedger", { type: [UsageLedgerRow] }),
    events: t.expose("events", { type: [ProxyEvent] })
  })
});
