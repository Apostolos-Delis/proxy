import { builder } from "../builder.js";
import type { RequestDetailShape, RequestSummaryShape } from "../models.js";
import { hasAdminRole } from "../authz.js";
import { ProxyEvent, RoutingConfigSnapshot, TokenTotals } from "./core.js";

export const RequestSummary = builder.objectRef<RequestSummaryShape>("RequestSummary").implement({
  fields: (t) => ({
    requestId: t.exposeString("requestId"),
    userId: t.exposeString("userId", { nullable: true }),
    sessionId: t.exposeString("sessionId", { nullable: true }),
    apiKeyId: t.exposeString("apiKeyId", { nullable: true }),
    surface: t.exposeString("surface", { nullable: true }),
    requestedModel: t.exposeString("requestedModel", { nullable: true }),
    finalRoute: t.exposeString("finalRoute", { nullable: true }),
    provider: t.exposeString("provider", { nullable: true }),
    selectedModel: t.exposeString("selectedModel", { nullable: true }),
    routingConfig: t.field({
      type: RoutingConfigSnapshot,
      nullable: true,
      resolve: (request, _args, context) => hasAdminRole(context) ? request.routingConfig ?? null : null
    }),
    classifier: t.field({
      type: "JSON",
      nullable: true,
      resolve: (request, _args, context) => hasAdminRole(context) ? request.classifier ?? null : null
    }),
    terminalStatus: t.exposeString("terminalStatus"),
    inputChars: t.exposeFloat("inputChars", { nullable: true }),
    usage: t.expose("usage", { type: TokenTotals }),
    latencyMs: t.exposeFloat("latencyMs", { nullable: true }),
    timeToFirstByteMs: t.exposeFloat("timeToFirstByteMs", { nullable: true }),
    attemptCount: t.exposeInt("attemptCount", { nullable: true }),
    selectedCost: t.exposeFloat("selectedCost"),
    baselineCost: t.exposeFloat("baselineCost"),
    savings: t.exposeFloat("savings"),
    createdAt: t.exposeString("createdAt", { nullable: true }),
    completedAt: t.exposeString("completedAt", { nullable: true })
  })
});

export const RequestDetail = builder.objectRef<RequestDetailShape>("RequestDetail").implement({
  fields: (t) => ({
    request: t.field({
      type: RequestSummary,
      nullable: true,
      resolve: (detail) => detail.request
    }),
    events: t.field({
      type: [ProxyEvent],
      resolve: (detail, _args, context) => hasAdminRole(context) ? detail.events : []
    })
  })
});
