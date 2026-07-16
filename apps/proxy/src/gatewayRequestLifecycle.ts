import {
  defaultCompressionPolicy,
  type CompressionPolicy,
  type GatewayOperationId
} from "@proxy/schema";

import { applyPromptCachePlan, type SurfaceAdapter } from "./adapters.js";
import {
  actorForIdentity,
  requestReceivedPayload,
  type RequestIdentity
} from "./auth.js";
import {
  type EventAppender,
  jsonPayload,
  type ProviderAttemptStore,
  type RequestStateStoreLike
} from "./events.js";
import {
  gatewayAdmissionEvidence,
  gatewayProviderAttemptEvidence,
  gatewayResolvedEvidence
} from "./gatewayEvidence.js";
import {
  type GatewayExecutionTarget,
  GatewayRuntime,
  gatewayDenialStatus,
  gatewayRequestBody,
  gatewayRouteDecision
} from "./gatewayRuntime.js";
import {
  compressionCacheWindowEventPayload,
  noCompressionCacheWindow,
  type CompressionCacheWindow,
  type CompressionCacheWindowResolver
} from "./compressionCacheWindow.js";
import { applyGatewaySystemPrompt } from "./gatewayRequestConfig.js";
import { harnessProfileByName } from "./harness.js";
import type { MetricsCollector } from "./metrics.js";
import type { OrganizationSettingsStore } from "./persistence/organizationSettings.js";
import type {
  ModelResolutionDenial,
  ResolvedModelTarget
} from "./persistence/modelResolution.js";
import { type PromptArtifactStore } from "./persistence/promptArtifacts.js";
import type { SessionSystemPromptStore } from "./persistence/sessionRoute.js";
import { appendPromptCaptureEvent } from "./promptCaptureEvents.js";
import { observePromptCachePlan } from "./promptCacheObservability.js";
import { computePromptCachePlan } from "./promptCachePlan.js";
import type { PromptCachePlan } from "./promptCachePlan.js";
import { appendTokensAttributed } from "./tokenAttribution.js";
import {
  appendCompressionEvidence,
  compressForForwardWithResult,
  compressionForwardTelemetry,
  compressOrFallback,
  requestBodyHash,
  type CompressionForwardResult
} from "./toolResultCompression.js";
import type { JsonObject, ProviderAttempt, RouteContext, RouteDecision, Surface } from "./types.js";

export type PreparedGatewayRequest = {
  outcome: "resolved";
  target: GatewayExecutionTarget;
  body: Record<string, unknown>;
  decision: RouteDecision;
  promptCachePlan: PromptCachePlan;
  compressionTelemetry: JsonObject;
};

export type DeniedGatewayRequest = {
  outcome: "denied";
  code: string;
  status: number;
};

type GatewayRequestInput = {
  identity: RequestIdentity;
  rawContext: RouteContext;
  context: RouteContext;
  requestId: string;
  idempotencyKey: string;
  surface: SurfaceAdapter;
  operationId: GatewayOperationId;
  body: unknown;
  transport?: "http" | "websocket";
};

type GatewayProviderAttemptInput = {
  identity: RequestIdentity;
  context: RouteContext;
  requestId: string;
  idempotencyKey: string;
  surface: Surface;
  prepared: PreparedGatewayRequest;
  transport?: "http" | "websocket";
};

type GatewayRequestLifecycleOptions = {
  promptArtifacts?: PromptArtifactStore;
  organizationSettings?: Pick<OrganizationSettingsStore, "editable">;
  sessionPrompts?: Pick<SessionSystemPromptStore, "resolve" | "pin">;
  compressionCacheWindows?: Pick<CompressionCacheWindowResolver, "resolve">;
  warn?: (error: unknown, message: string) => void;
};

type GatewayRequestPolicy = {
  systemPrompt?: string;
  cacheTtlUpgrade: boolean;
  automaticCaching: boolean;
  compressionPolicy: CompressionPolicy;
  duplicateToolResultReferences: boolean;
};

export class GatewayRequestLifecycle {
  constructor(
    private readonly gateway: GatewayRuntime | undefined,
    private readonly events: EventAppender,
    private readonly attempts: ProviderAttemptStore,
    private readonly requestStates: RequestStateStoreLike,
    private readonly metrics: MetricsCollector,
    private readonly options: GatewayRequestLifecycleOptions = {}
  ) {}

  get available() {
    return Boolean(this.gateway);
  }

  async prepare(input: GatewayRequestInput): Promise<PreparedGatewayRequest | DeniedGatewayRequest> {
    const admissionEvidence = gatewayAdmissionEvidence({
      ingressWireId: input.surface.dialect,
      operationId: input.operationId,
      requestedLogicalModel: input.context.requestedModel
    });
    await this.events.append({
      tenantId: input.identity.organizationId,
      workspaceId: input.identity.workspaceId,
      scopeType: "request",
      scopeId: input.requestId,
      sessionId: input.context.sessionId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      actor: actorForIdentity(input.identity),
      producer: `proxy.surface.${input.surface.surface}${input.transport === "websocket" ? ".websocket" : ""}`,
      eventType: "proxy.request_received",
      payload: requestReceivedPayload(
        input.surface.surface,
        input.context,
        input.rawContext,
        input.identity,
        admissionEvidence
      )
    });
    const artifacts = await this.captureArtifacts(input);
    await appendPromptCaptureEvent({
      events: this.events,
      identity: input.identity,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.context.sessionId,
      surface: input.surface.surface,
      transport: input.context.transport,
      harness: input.context.harness,
      harnessProfileId: input.context.harnessProfileId,
      artifacts
    });
    const policy = await this.resolveRequestPolicy(input);
    if (input.operationId === "text.generate") {
      await appendTokensAttributed({
        events: this.events,
        identity: input.identity,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.context.sessionId,
        surface: input.surface.surface,
        body: input.body,
        orgSystemPrompt: policy.systemPrompt,
        warn: this.warn
      });
    }
    if (!this.gateway) {
      return this.deny(input, "gateway_runtime_unavailable", 503);
    }

    const resolution = await this.gateway.resolve({
      identity: input.identity,
      context: input.context,
      ingressWireId: input.surface.dialect,
      operationId: input.operationId,
      body: input.body,
      transport: input.transport
    });
    await this.appendClassificationRecorded(input, resolution);
    if (resolution.outcome === "denied") {
      await this.events.append({
        tenantId: input.identity.organizationId,
        workspaceId: input.identity.workspaceId,
        scopeType: "request",
        scopeId: input.requestId,
        sessionId: input.context.sessionId,
        correlationId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        actor: actorForIdentity(input.identity),
        producer: "proxy.gateway-resolution",
        eventType: "routing.decision_recorded",
        payload: {
          outcome: "reject",
          surface: input.surface.surface,
          requestedModel: input.context.requestedModel,
          error: resolution.code,
          policyVersion: "gateway-v1",
          guardrailActions: [],
          reasonCodes: [resolution.code],
          ...admissionEvidence
        }
      });
      return this.deny(input, resolution.code, gatewayDenialStatus(resolution.code));
    }

    const target = await this.gateway.materialize(input.identity, resolution);
    const decision = gatewayRouteDecision(input.surface.surface, target);
    await this.events.append({
      tenantId: input.identity.organizationId,
      workspaceId: input.identity.workspaceId,
      scopeType: "request",
      scopeId: input.requestId,
      sessionId: input.context.sessionId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      actor: actorForIdentity(input.identity),
      producer: "proxy.gateway-resolution",
      eventType: "routing.decision_recorded",
      payload: {
        outcome: "route",
        surface: input.surface.surface,
        requestedModel: input.context.requestedModel,
        selectedModel: target.upstreamModelId,
        provider: target.provider,
        policyVersion: "gateway-v1",
        guardrailActions: [],
        reasonCodes: target.resolution.routerDecision?.reasonCodes ?? [],
        routerDecisionId: target.resolution.routerDecisionId,
        routerDecision: target.resolution.routerDecision,
        translated: target.resolution.wireAdapterId !== null,
        translatorId: target.resolution.wireAdapterId,
        compressionPolicy: policy.compressionPolicy as unknown as JsonObject,
        ...gatewayResolvedEvidence(admissionEvidence, target)
      }
    });
    const prepared = await this.prepareResolvedBody(input, target, decision, policy);
    await this.options.sessionPrompts?.pin({
      organizationId: input.identity.organizationId,
      workspaceId: input.identity.workspaceId,
      surface: input.surface.surface,
      requestId: input.requestId,
      sessionId: input.context.sessionId,
      systemPrompt: policy.systemPrompt
    });
    return {
      outcome: "resolved",
      target,
      decision,
      ...prepared
    };
  }

  async startProviderAttempt(input: GatewayProviderAttemptInput): Promise<ProviderAttempt> {
    const target = input.prepared.target;
    const { attempt, duplicate } = this.attempts.create({
      idempotencyKey: `${input.idempotencyKey}:provider-attempt`,
      requestId: input.requestId,
      surface: input.surface,
      provider: target.provider,
      model: target.upstreamModelId,
      adapterKind: target.resolution.providerAdapterKind,
      providerConnectionId: target.providerConnectionId,
      deploymentId: target.deploymentId
    });
    if (!attempt || duplicate) {
      throw new GatewayRequestLifecycleError(409, "duplicate_gateway_provider_attempt");
    }

    try {
      const promptCachePlan = input.prepared.promptCachePlan;
      observePromptCachePlan({
        events: this.events,
        metrics: this.metrics,
        warn: this.warn,
        tenantId: input.identity.organizationId,
        workspaceId: input.identity.workspaceId,
        scopeId: input.requestId,
        correlationId: input.requestId,
        idempotencyKey: `${input.idempotencyKey}:prompt-cache-plan`,
        sessionId: input.context.sessionId,
        actor: actorForIdentity(input.identity),
        surface: input.surface,
        provider: target.provider,
        model: target.upstreamModelId,
        plan: promptCachePlan
      });
      await this.events.append({
        tenantId: input.identity.organizationId,
        workspaceId: input.identity.workspaceId,
        scopeType: "request",
        scopeId: input.requestId,
        sessionId: input.context.sessionId,
        correlationId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        actor: actorForIdentity(input.identity),
        producer: "proxy.provider",
        eventType: "provider.request_started",
        payload: {
          surface: input.surface,
          provider: target.provider,
          transport: input.transport ?? input.context.transport ?? "http",
          model: target.upstreamModelId,
          providerAttemptId: attempt.id,
          preparedRequestHash: requestBodyHash(input.prepared.body),
          attemptIndex: 0,
          fallbackIndex: 0,
          adapterKind: target.resolution.providerAdapterKind,
          ...gatewayProviderAttemptEvidence(target)
        }
      });
    } catch (error) {
      await this.recordProviderAttemptStartFailure(input, attempt, error);
      throw error;
    }
    try {
      await this.requestStates.markProviderPending(input.idempotencyKey, attempt.id, input.requestId);
    } catch (error) {
      this.warn(error, "provider attempt in-memory pending mirror failed");
    }
    return attempt;
  }

  private async recordProviderAttemptStartFailure(
    input: GatewayProviderAttemptInput,
    attempt: ProviderAttempt,
    error: unknown
  ) {
    const message = error instanceof Error ? error.message : "provider_attempt_start_failed";
    this.attempts.update(attempt.id, { terminalStatus: "failed", error: message });
    try {
      await this.events.append({
        tenantId: input.identity.organizationId,
        workspaceId: input.identity.workspaceId,
        scopeType: "request",
        scopeId: input.requestId,
        sessionId: input.context.sessionId,
        correlationId: input.requestId,
        idempotencyKey: `${input.idempotencyKey}:provider-start-failed`,
        actor: actorForIdentity(input.identity),
        producer: "proxy.provider",
        eventType: "provider.request_start_failed",
        payload: {
          surface: input.surface,
          provider: input.prepared.target.provider,
          selectedModel: input.prepared.target.upstreamModelId,
          providerAttemptId: attempt.id,
          terminalStatus: "failed",
          error: message,
          ...gatewayProviderAttemptEvidence(input.prepared.target)
        }
      });
      await this.requestStates.finish(input.idempotencyKey, "failed", {
        requestId: input.requestId,
        error: message
      });
    } catch (compensationError) {
      this.warn(compensationError, "provider attempt start compensation event failed");
    }
  }

  private async captureArtifacts(input: GatewayRequestInput) {
    if (!this.options.promptArtifacts) return [];
    try {
      return await this.options.promptArtifacts.capture({
        organizationId: input.identity.organizationId,
        workspaceId: input.identity.workspaceId,
        requestId: input.requestId,
        surface: input.surface.surface,
        body: input.body,
        transport: input.context.transport,
        harness: input.context.harness,
        harnessProfileId: input.context.harnessProfileId
      });
    } catch (error) {
      this.warn(error, "prompt artifact capture failed");
      return [];
    }
  }

  private async appendClassificationRecorded(
    input: GatewayRequestInput,
    resolution: ResolvedModelTarget | ModelResolutionDenial
  ) {
    const classifierCall = resolution.classifierCall;
    if (!classifierCall) return;
    const decision = resolution.outcome === "resolved" ? resolution.routerDecision : null;
    await this.events.append({
      tenantId: input.identity.organizationId,
      workspaceId: input.identity.workspaceId,
      scopeType: "request",
      scopeId: input.requestId,
      sessionId: input.context.sessionId,
      correlationId: input.requestId,
      idempotencyKey: `${input.idempotencyKey}:classification`,
      actor: actorForIdentity(input.identity),
      producer: "proxy.classifier",
      eventType: "routing.classification_recorded",
      payload: {
        model: classifierCall.model,
        provider: classifierCall.provider,
        attempts: classifierCall.attempts,
        cached: false,
        outcome: classifierCall.outcome,
        classifierDeploymentId: classifierCall.deploymentId,
        requestedLogicalModel: resolution.outcome === "resolved"
          ? resolution.logicalModelSlug
          : resolution.requestedModel,
        ...(classifierCall.usage ? { usage: jsonPayload(classifierCall.usage) } : {}),
        ...(classifierCall.error ? { error: classifierCall.error } : {}),
        ...(decision ? {
          confidence: decision.confidence,
          selectedTargetId: decision.selectedTargetId,
          reasonCodes: decision.reasonCodes
        } : {})
      }
    });
  }

  private async deny(input: GatewayRequestInput, code: string, status: number): Promise<DeniedGatewayRequest> {
    await this.requestStates.finish(input.idempotencyKey, "failed", {
      requestId: input.requestId,
      error: code
    });
    return { outcome: "denied", code, status };
  }

  private async resolveRequestPolicy(input: GatewayRequestInput): Promise<GatewayRequestPolicy> {
    const settings = await this.options.organizationSettings?.editable(input.identity.organizationId);
    const pinned = await this.options.sessionPrompts?.resolve({
      organizationId: input.identity.organizationId,
      workspaceId: input.identity.workspaceId,
      surface: input.surface.surface,
      sessionId: input.context.sessionId
    });
    return {
      systemPrompt: pinned?.pinned ? pinned.systemPrompt : settings?.systemPrompt ?? undefined,
      cacheTtlUpgrade: settings?.cacheTtlUpgrade ?? false,
      automaticCaching: settings?.automaticCaching ?? false,
      compressionPolicy: settings?.toolResultCompressionPolicy ?? defaultCompressionPolicy(),
      duplicateToolResultReferences: settings?.duplicateToolResultReferences ?? false
    };
  }

  private async prepareResolvedBody(
    input: GatewayRequestInput,
    target: GatewayExecutionTarget,
    decision: RouteDecision,
    policy: GatewayRequestPolicy
  ) {
    const cacheWindow = await this.resolveCompressionCacheWindow(input, target);
    const compression = input.operationId === "text.count_tokens"
      ? this.compressTokenCount(input, policy, cacheWindow.frozenPrefixItems)
      : await compressForForwardWithResult({
          events: this.events,
          tenantId: input.identity.organizationId,
          workspaceId: input.identity.workspaceId,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          sessionId: input.context.sessionId,
          surface: input.surface.surface,
          body: input.body,
          policy: policy.compressionPolicy,
          deduplicateToolResults: policy.duplicateToolResultReferences,
          frozenPrefixItems: cacheWindow.frozenPrefixItems,
          profile: harnessProfileByName(input.context.harness),
          artifactStore: this.options.promptArtifacts,
          warn: this.warn
        });
    const body = gatewayRequestBody({
      body: compression.body,
      ingressWireId: input.surface.dialect,
      operationId: input.operationId,
      target
    });
    applyGatewaySystemPrompt(body, target.resolution.egressWireId, policy.systemPrompt);
    const promptCachePlan = computePromptCachePlan({
      body,
      bodyDialect: target.resolution.egressWireId,
      sourceBody: compression.body,
      context: input.context,
      decision,
      capabilities: target.providerEntry.capabilities.promptCaching,
      settings: {
        automaticCaching: input.operationId === "text.generate" && policy.automaticCaching,
        cacheTtlUpgrade: policy.cacheTtlUpgrade
      }
    });
    applyPromptCachePlan(body, promptCachePlan, input.operationId === "text.generate");
    await appendCompressionEvidence({
      events: this.events,
      tenantId: input.identity.organizationId,
      workspaceId: input.identity.workspaceId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.context.sessionId,
      surface: input.surface.surface,
      policy: policy.compressionPolicy,
      originalBody: input.body,
      compressedBody: compression.body,
      forwardedBody: body,
      result: compression,
      warn: this.warn
    });
    return {
      body,
      promptCachePlan,
      compressionTelemetry: compressionForwardTelemetry(compression, policy.compressionPolicy)
    };
  }

  private compressTokenCount(
    input: GatewayRequestInput,
    policy: GatewayRequestPolicy,
    frozenPrefixItems: number
  ): CompressionForwardResult {
    let compressionFailed = false;
    const compression = compressOrFallback(
      input.surface.surface,
      input.body,
      policy.compressionPolicy,
      (error, message) => {
        if (message === "tool result compression failed") compressionFailed = true;
        this.warn(error, message);
      },
      {
        deduplicateToolResults: policy.duplicateToolResultReferences,
        frozenPrefixItems,
        profile: harnessProfileByName(input.context.harness)
      }
    );
    return {
      ...compression,
      receiptIds: [],
      eventEmitFailed: false,
      compressionFailed
    };
  }

  private async resolveCompressionCacheWindow(
    input: GatewayRequestInput,
    target: GatewayExecutionTarget
  ): Promise<CompressionCacheWindow> {
    let window: CompressionCacheWindow;
    try {
      window = await this.options.compressionCacheWindows?.resolve({
        organizationId: input.identity.organizationId,
        workspaceId: input.identity.workspaceId,
        sessionId: input.context.sessionId,
        surface: input.surface.surface,
        provider: target.provider,
        model: target.upstreamModelId,
        body: input.body
      }) ?? noCompressionCacheWindow();
    } catch (error) {
      this.warn(error, "compression cache window resolution failed");
      return noCompressionCacheWindow();
    }
    try {
      await this.events.append({
        tenantId: input.identity.organizationId,
        workspaceId: input.identity.workspaceId,
        scopeType: "request",
        scopeId: input.requestId,
        sessionId: input.context.sessionId,
        correlationId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        actor: actorForIdentity(input.identity),
        producer: "proxy.compression",
        eventType: "compression.cache_window_resolved",
        payload: {
          surface: input.surface.surface,
          provider: target.provider,
          model: target.upstreamModelId,
          ...compressionCacheWindowEventPayload(window)
        }
      });
    } catch (error) {
      this.warn(error, "compression cache window event emit failed");
    }
    return window;
  }

  private get warn() {
    return this.options.warn ?? (() => {});
  }
}

export class GatewayRequestLifecycleError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}
