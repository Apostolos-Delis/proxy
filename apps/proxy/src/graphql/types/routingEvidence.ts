import { builder } from "../builder.js";
import type { ProviderAttemptModel, RouteDecisionModel } from "../models.js";

export const ProviderAttempt = builder
  .objectRef<ProviderAttemptModel>("ProviderAttempt")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      requestId: t.exposeString("requestId"),
      surface: t.exposeString("surface"),
      provider: t.exposeString("provider"),
      model: t.exposeString("model"),
      adapterKind: t.exposeString("adapterKind", { nullable: true }),
      adapterClassification: t.field({
        type: "JSON",
        nullable: true,
        resolve: (attempt) => attempt.adapterClassification ?? null
      }),
      deploymentId: t.exposeString("deploymentId", { nullable: true }),
      providerConnectionId: t.exposeString("providerConnectionId", { nullable: true }),
      egressWireId: t.exposeString("egressWireId", { nullable: true }),
      providerAdapterContractVersion: t.exposeString("providerAdapterContractVersion", { nullable: true }),
      upstreamRequestId: t.exposeString("upstreamRequestId", { nullable: true }),
      terminalStatus: t.exposeString("terminalStatus"),
      statusCode: t.exposeInt("statusCode", { nullable: true }),
      error: t.exposeString("error", { nullable: true }),
      usage: t.field({ type: "JSON", resolve: (attempt) => attempt.usage }),
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
    selectedProvider: t.exposeString("selectedProvider", { nullable: true }),
    selectedModel: t.exposeString("selectedModel", { nullable: true }),
    reasoningEffort: t.exposeString("reasoningEffort", { nullable: true }),
    verbosity: t.exposeString("verbosity", { nullable: true }),
    ingressWireId: t.exposeString("ingressWireId", { nullable: true }),
    operationId: t.exposeString("operationId", { nullable: true }),
    requestedLogicalModel: t.exposeString("requestedLogicalModel", { nullable: true }),
    resolvedLogicalModelId: t.exposeString("resolvedLogicalModelId", { nullable: true }),
    accessProfileId: t.exposeString("accessProfileId", { nullable: true }),
    routerKind: t.exposeString("routerKind", { nullable: true }),
    deploymentId: t.exposeString("deploymentId", { nullable: true }),
    providerConnectionId: t.exposeString("providerConnectionId", { nullable: true }),
    egressWireId: t.exposeString("egressWireId", { nullable: true }),
    wireAdapterVersion: t.exposeString("wireAdapterVersion", { nullable: true }),
    confidence: t.exposeFloat("confidence", { nullable: true }),
    reasonCodes: t.exposeStringList("reasonCodes"),
    guardrailActions: t.exposeStringList("guardrailActions"),
    routerDecisionId: t.exposeString("routerDecisionId", { nullable: true }),
    routerDecision: t.field({ type: "JSON", resolve: (decision) => decision.routerDecision }),
    translated: t.exposeBoolean("translated"),
    translatorId: t.exposeString("translatorId", { nullable: true }),
    policyVersion: t.exposeString("policyVersion"),
    createdAt: t.exposeString("createdAt")
  })
});
