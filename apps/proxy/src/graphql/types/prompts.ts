import { builder } from "../builder.js";
import type {
  PromptAccessAuditEntryModel,
  PromptArtifactDetailModel,
  PromptDetailModel,
  PromptPageModel,
  PromptPaginationModel,
  PromptSummaryModel
} from "../models.js";
import { hasAdminRole } from "../authz.js";
import { PreflightDecision, ProxyEvent, RoutingConfigSnapshot } from "./core.js";
import { CompressionReceipt, RequestSummary } from "./requests.js";
import { ProviderAttempt, RouteDecision } from "./routingEvidence.js";

export const PromptCost = builder.objectRef<PromptSummaryModel["cost"]>("PromptCost").implement({
  fields: (t) => ({
    selected: t.exposeFloat("selected")
  })
});

// Shared field set for prompt artifacts; PromptSummary and PromptArtifactDetail
// inherit these so list and detail shapes cannot drift apart.
const PromptArtifactBase = builder.interfaceRef<PromptSummaryModel>("PromptArtifactBase").implement({
  fields: (t) => ({
    artifactId: t.exposeString("artifactId"),
    organizationId: t.exposeString("organizationId"),
    requestId: t.exposeString("requestId"),
    sessionId: t.exposeString("sessionId", { nullable: true }),
    userId: t.exposeString("userId", { nullable: true }),
    surface: t.exposeString("surface"),
    kind: t.exposeString("kind"),
    storageMode: t.exposeString("storageMode"),
    contentHash: t.exposeString("contentHash"),
    sourceRole: t.exposeString("sourceRole", { nullable: true }),
    sourceIndex: t.exposeInt("sourceIndex", { nullable: true }),
    chars: t.exposeFloat("chars", { nullable: true }),
    tokenEstimate: t.exposeFloat("tokenEstimate", { nullable: true }),
    preview: t.exposeString("preview", { nullable: true }),
    finalRoute: t.exposeString("finalRoute", { nullable: true }),
    provider: t.exposeString("provider", { nullable: true }),
    selectedModel: t.exposeString("selectedModel", { nullable: true }),
    routingConfig: t.field({
      type: RoutingConfigSnapshot,
      nullable: true,
      resolve: (prompt) => prompt.routingConfig
    }),
    classifier: t.field({
      type: "JSON",
      nullable: true,
      resolve: (prompt) => prompt.classifier ?? null
    }),
    cost: t.expose("cost", { type: PromptCost }),
    createdAt: t.exposeString("createdAt")
  })
});

export const PromptSummary = builder.objectRef<PromptSummaryModel>("PromptSummary").implement({
  interfaces: [PromptArtifactBase]
});

export const PromptArtifactDetail = builder
  .objectRef<PromptArtifactDetailModel>("PromptArtifactDetail")
  .implement({
    interfaces: [PromptArtifactBase],
    fields: (t) => ({
      rawText: t.exposeString("rawText", { nullable: true }),
      redactedText: t.exposeString("redactedText", { nullable: true }),
      encryptedBlobRef: t.exposeString("encryptedBlobRef", { nullable: true }),
      metadata: t.field({ type: "JSON", resolve: (artifact) => artifact.metadata }),
      expiresAt: t.exposeString("expiresAt", { nullable: true })
    })
  });

export const PromptPagination = builder
  .objectRef<PromptPaginationModel>("PromptPagination")
  .implement({
    fields: (t) => ({
      limit: t.exposeInt("limit"),
      offset: t.exposeInt("offset"),
      count: t.exposeInt("count")
    })
  });

export const PromptPage = builder.objectRef<PromptPageModel>("PromptPage").implement({
  fields: (t) => ({
    data: t.expose("data", { type: [PromptSummary] }),
    pagination: t.expose("pagination", { type: PromptPagination })
  })
});

export const PromptDetail = builder.objectRef<PromptDetailModel>("PromptDetail").implement({
  fields: (t) => ({
    artifact: t.expose("artifact", { type: PromptArtifactDetail }),
    request: t.field({
      type: RequestSummary,
      nullable: true,
      resolve: (detail) => detail.request
    }),
    requestArtifacts: t.expose("requestArtifacts", { type: [PromptArtifactDetail] }),
    compressionReceipts: t.expose("compressionReceipts", { type: [CompressionReceipt] }),
    routeDecisions: t.expose("routeDecisions", { type: [RouteDecision] }),
    providerAttempts: t.expose("providerAttempts", { type: [ProviderAttempt] }),
    events: t.expose("events", { type: [ProxyEvent] }),
    preflightDecisions: t.field({
      type: [PreflightDecision],
      resolve: (detail, _args, context) => hasAdminRole(context) ? detail.preflightDecisions : []
    })
  })
});

export const PromptAccessAuditEntry = builder
  .objectRef<PromptAccessAuditEntryModel>("PromptAccessAuditEntry")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      organizationId: t.exposeString("organizationId"),
      artifactId: t.exposeString("artifactId"),
      requestId: t.exposeString("requestId"),
      userId: t.exposeString("userId", { nullable: true }),
      adminSessionId: t.exposeString("adminSessionId", { nullable: true }),
      route: t.exposeString("route", { nullable: true }),
      accessPath: t.exposeString("accessPath"),
      createdAt: t.exposeString("createdAt")
    })
  });
