import { builder } from "../builder.js";
import type { CompressionReceiptModel, RequestDetailShape, RequestSummaryShape } from "../models.js";
import { hasAdminRole } from "../authz.js";
import { ProxyEvent, TokenTotals } from "./core.js";
import { ProviderAttempt, RouteDecision } from "./routingEvidence.js";

export const RequestSummary = builder.objectRef<RequestSummaryShape>("RequestSummary").implement({
  fields: (t) => ({
    requestId: t.exposeString("requestId"),
    userId: t.exposeString("userId", { nullable: true }),
    sessionId: t.exposeString("sessionId", { nullable: true }),
    apiKeyId: t.exposeString("apiKeyId", { nullable: true }),
    surface: t.exposeString("surface", { nullable: true }),
    requestedModel: t.exposeString("requestedModel", { nullable: true }),
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
    provider: t.exposeString("provider", { nullable: true }),
    selectedModel: t.exposeString("selectedModel", { nullable: true }),
    translated: t.boolean({
      nullable: true,
      resolve: (request, _args, context) => hasAdminRole(context) ? request.translated ?? false : null
    }),
    confidence: t.exposeFloat("confidence", { nullable: true }),
    routerDecisionId: t.exposeString("routerDecisionId", { nullable: true }),
    routerDecision: t.field({
      type: "JSON",
      resolve: (request, _args, context) => hasAdminRole(context) ? request.routerDecision ?? {} : {}
    }),
    terminalStatus: t.exposeString("terminalStatus"),
    inputChars: t.exposeFloat("inputChars", { nullable: true }),
    usage: t.expose("usage", { type: TokenTotals }),
    latencyMs: t.exposeFloat("latencyMs", { nullable: true }),
    timeToFirstByteMs: t.exposeFloat("timeToFirstByteMs", { nullable: true }),
    attemptCount: t.exposeInt("attemptCount", { nullable: true }),
    selectedCost: t.exposeFloat("selectedCost"),
    providerCost: t.exposeFloat("providerCost", { nullable: true }),
    classifierCost: t.exposeFloat("classifierCost", { nullable: true }),
    baselineCost: t.exposeFloat("baselineCost"),
    savings: t.exposeFloat("savings"),
    createdAt: t.exposeString("createdAt", { nullable: true }),
    completedAt: t.exposeString("completedAt", { nullable: true })
  })
});

export const CompressionReceipt = builder.objectRef<CompressionReceiptModel>("CompressionReceipt").implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    organizationId: t.exposeString("organizationId"),
    workspaceId: t.exposeString("workspaceId"),
    requestId: t.exposeString("requestId"),
    apiKeyId: t.exposeString("apiKeyId", { nullable: true }),
    mode: t.exposeString("mode"),
    surface: t.exposeString("surface"),
    blockPath: t.exposeString("blockPath"),
    toolName: t.exposeString("toolName"),
    command: t.exposeString("command", { nullable: true }),
    commandClass: t.exposeString("commandClass", { nullable: true }),
    ruleId: t.exposeString("ruleId"),
    ruleVersion: t.exposeInt("ruleVersion"),
    status: t.exposeString("status"),
    retrievalId: t.exposeString("retrievalId", { nullable: true }),
    retrievalAvailable: t.exposeBoolean("retrievalAvailable"),
    retrievalMarker: t.exposeString("retrievalMarker", { nullable: true }),
    originalChars: t.exposeInt("originalChars"),
    compressedChars: t.exposeInt("compressedChars"),
    savedChars: t.exposeInt("savedChars"),
    originalBytes: t.exposeInt("originalBytes"),
    compressedBytes: t.exposeInt("compressedBytes"),
    savedBytes: t.exposeInt("savedBytes"),
    originalEstimatedTokens: t.exposeInt("originalEstimatedTokens"),
    compressedEstimatedTokens: t.exposeInt("compressedEstimatedTokens"),
    savedEstimatedTokens: t.exposeInt("savedEstimatedTokens"),
    originalTokenEstimate: t.exposeInt("originalTokenEstimate"),
    compressedTokenEstimate: t.exposeInt("compressedTokenEstimate"),
    savedTokens: t.exposeInt("savedTokens"),
    estimateSource: t.exposeString("estimateSource"),
    originalSha256: t.exposeString("originalSha256"),
    compressedSha256: t.exposeString("compressedSha256"),
    originalArtifactId: t.exposeString("originalArtifactId", { nullable: true }),
    compressedArtifactId: t.exposeString("compressedArtifactId", { nullable: true }),
    originalArtifactExpiresAt: t.exposeString("originalArtifactExpiresAt", { nullable: true }),
    compressedArtifactExpiresAt: t.exposeString("compressedArtifactExpiresAt", { nullable: true }),
    skipReason: t.exposeString("skipReason", { nullable: true }),
    eventId: t.exposeString("eventId"),
    createdAt: t.exposeString("createdAt")
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
    }),
    compressionReceipts: t.field({
      type: [CompressionReceipt],
      resolve: (detail, _args, context) => hasAdminRole(context) ? detail.compressionReceipts : []
    }),
    routeDecisions: t.field({
      type: [RouteDecision],
      resolve: (detail, _args, context) => hasAdminRole(context) ? detail.routeDecisions : []
    }),
    providerAttempts: t.field({
      type: [ProviderAttempt],
      resolve: (detail, _args, context) => hasAdminRole(context) ? detail.providerAttempts : []
    })
  })
});
