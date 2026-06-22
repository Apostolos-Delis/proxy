import { builder } from "../builder.js";
import type { ProviderAttemptModel, RouteDecisionModel } from "../models.js";
import { RoutingConfigSnapshot } from "./core.js";

export const ProviderAttempt = builder
  .objectRef<ProviderAttemptModel>("ProviderAttempt")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      requestId: t.exposeString("requestId"),
      surface: t.exposeString("surface"),
      provider: t.exposeString("provider"),
      model: t.exposeString("model"),
      upstreamRequestId: t.exposeString("upstreamRequestId", { nullable: true }),
      terminalStatus: t.exposeString("terminalStatus"),
      statusCode: t.exposeInt("statusCode", { nullable: true }),
      error: t.exposeString("error", { nullable: true }),
      usage: t.field({ type: "JSON", resolve: (attempt) => attempt.usage }),
      routeCandidateId: t.exposeString("routeCandidateId", { nullable: true }),
      attemptIndex: t.exposeInt("attemptIndex", { nullable: true }),
      fallbackIndex: t.exposeInt("fallbackIndex", { nullable: true }),
      skipReason: t.exposeString("skipReason", { nullable: true }),
      startedAt: t.exposeString("startedAt"),
      firstByteAt: t.exposeString("firstByteAt", { nullable: true }),
      completedAt: t.exposeString("completedAt", { nullable: true })
    })
  });

export const RouteDecision = builder.objectRef<RouteDecisionModel>("RouteDecision").implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    requestId: t.exposeString("requestId"),
    requestedModel: t.exposeString("requestedModel"),
    classifierRoute: t.exposeString("classifierRoute", { nullable: true }),
    finalRoute: t.exposeString("finalRoute", { nullable: true }),
    selectedProvider: t.exposeString("selectedProvider", { nullable: true }),
    selectedModel: t.exposeString("selectedModel", { nullable: true }),
    reasoningEffort: t.exposeString("reasoningEffort", { nullable: true }),
    verbosity: t.exposeString("verbosity", { nullable: true }),
    routingConfig: t.field({
      type: RoutingConfigSnapshot,
      nullable: true,
      resolve: (decision) => decision.routingConfig
    }),
    classifier: t.field({
      type: "JSON",
      nullable: true,
      resolve: (decision) => decision.classifier ?? null
    }),
    routeExecutionPlan: t.field({
      type: "JSON",
      resolve: (decision) => decision.routeExecutionPlan
    }),
    selectedCandidateId: t.exposeString("selectedCandidateId", { nullable: true }),
    translated: t.exposeBoolean("translated"),
    translatorId: t.exposeString("translatorId", { nullable: true }),
    confidence: t.exposeFloat("confidence", { nullable: true }),
    reasonCodes: t.exposeStringList("reasonCodes"),
    guardrailActions: t.exposeStringList("guardrailActions"),
    budgetChecks: t.field({ type: "JSON", resolve: (decision) => decision.budgetChecks }),
    policyVersion: t.exposeString("policyVersion"),
    createdAt: t.exposeString("createdAt")
  })
});
