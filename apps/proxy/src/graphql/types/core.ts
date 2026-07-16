import { builder } from "../builder.js";
import type {
  CostTotalsModel,
  ProxyEventShape,
  TokenTotalsModel
} from "../models.js";

export const MemberRole = builder.enumType("MemberRole", {
  values: ["owner", "admin", "member", "viewer"] as const
});

export const TokenTotals = builder.objectRef<TokenTotalsModel>("TokenTotals").implement({
  fields: (t) => ({
    inputTokens: t.exposeFloat("inputTokens"),
    cachedInputTokens: t.exposeFloat("cachedInputTokens"),
    cacheCreationInputTokens: t.exposeFloat("cacheCreationInputTokens"),
    outputTokens: t.exposeFloat("outputTokens"),
    reasoningTokens: t.exposeFloat("reasoningTokens"),
    totalTokens: t.exposeFloat("totalTokens")
  })
});

export const CostTotals = builder.objectRef<CostTotalsModel>("CostTotals").implement({
  fields: (t) => ({
    selected: t.exposeFloat("selected"),
    baseline: t.exposeFloat("baseline"),
    savings: t.exposeFloat("savings"),
    classifier: t.exposeFloat("classifier")
  })
});

export const ProxyEvent = builder.objectRef<ProxyEventShape>("ProxyEvent").implement({
  fields: (t) => ({
    eventId: t.exposeString("eventId"),
    sequence: t.exposeFloat("sequence"),
    tenantId: t.exposeString("tenantId"),
    scopeType: t.exposeString("scopeType"),
    scopeId: t.exposeString("scopeId"),
    sessionId: t.exposeString("sessionId", { nullable: true }),
    correlationId: t.exposeString("correlationId", { nullable: true }),
    eventType: t.exposeString("eventType"),
    producer: t.exposeString("producer"),
    payload: t.field({ type: "JSON", resolve: (event) => event.payload }),
    metadata: t.field({ type: "JSON", resolve: (event) => event.metadata }),
    createdAt: t.exposeString("createdAt")
  })
});
