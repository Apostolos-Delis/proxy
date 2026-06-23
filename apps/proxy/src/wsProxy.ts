import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import type { LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import type { ProviderHealthClassification } from "@prompt-proxy/schema";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { openAIResponsesSurface, rewriteSurfaceRequest } from "./adapters.js";
import { appendTokensAttributed } from "./tokenAttribution.js";
import {
  appendCompressionEvidence,
  compressionForwardTelemetry,
  compressForForwardWithResult,
  providerCompressionTerminalTelemetry,
  requestBodyHash
} from "./toolResultCompression.js";
import {
  actorForIdentity,
  contextForIdentity,
  ProxyAuthService,
  requestReceivedPayload,
  scopedIdempotencyKey,
  type RequestIdentity
} from "./auth.js";
import type { AppConfig } from "./config.js";
import { jsonPayload, type EventService, type ProviderAttemptStore, type RequestStateStoreLike } from "./events.js";
import { appendBudgetRejectedEvent, appendBudgetReservedEvent, appendBudgetSignalEvents, appendLimitRejectedEvent } from "./limitEvents.js";
import type { ActiveRequestLimitReservation } from "./persistence/activeRequestLimits.js";
import {
  BudgetReservationRejectedError,
  type BudgetReservationEntry,
  type BudgetReservationRejection,
  type BudgetSignal
} from "./persistence/budgetWindows.js";
import { extractResponseText, type PromptArtifactStore } from "./persistence/promptArtifacts.js";
import {
  ProviderRegistryError,
  providerEndpointForDialect,
  type ProviderRegistryEndpoint,
  type ProviderRegistryEntry,
  type ProviderRegistryResolver
} from "./persistence/providers.js";
import { resolveRoutingSelection, type RoutingConfigResolverLike } from "./persistence/routingConfig.js";
import type { SessionSystemPromptStore } from "./persistence/sessionRoute.js";
import { classifyProviderTerminalHealth } from "./providerHealth.js";
import { appendPromptCaptureEvent } from "./promptCaptureEvents.js";
import { canAuthenticateOrgProvider, providerRequestHeaders } from "./proxy.js";
import type { RoutingService } from "./router.js";
import type { JsonObject, Provider, RouteContext, RouteDecision, RouteName, UpstreamCredential } from "./types.js";
import {
  lookupForPinnedAddress,
  providerRequestPinnedAddress,
  providerRequestUrl
} from "./upstream.js";
import { createId, headerValue, idempotencyFrom, isRecord, lowerHeaders } from "./util.js";

type ActiveRequest = {
  requestId: string;
  idempotencyKey: string;
  providerAttemptId: string;
  providerAccountId?: string;
  provider: Provider;
  decision: RouteDecision;
  identity: RequestIdentity;
  sessionId?: string;
  compressionTelemetry?: JsonObject;
  providerRequestForwarded?: boolean;
  harness?: RouteContext["harness"];
  harnessProfileId?: RouteContext["harnessProfileId"];
  transport?: RouteContext["transport"];
  activeLimit?: Extract<ActiveRequestLimitReservation, { status: "reserved" }>;
};

// Structural subset of the Fastify/pino logger, so the proxy can warn without
// depending on the logger implementation.
type WsLogger = { warn: (obj: unknown, msg?: string) => void };

type ActiveRequestLimiter = {
  reserve(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string;
    requestId: string;
  }): Promise<ActiveRequestLimitReservation>;
};

type BudgetReservationPlanner = {
  planRequestReservation(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string | null;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    at: Date;
  }): Promise<{ estimatedCostMicros: number; entries: BudgetReservationEntry[]; rejection?: BudgetReservationRejection }>;
  pendingSignalsForRequest(input: {
    organizationId: string;
    requestId: string;
    at: Date;
  }): Promise<BudgetSignal[]>;
};

type RequestRateLimiter = {
  check(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string;
  }): Promise<
    | { status: "disabled" }
    | {
        status: "rejected";
        scope: "workspace" | "api_key";
        reason: "request_rate_limit";
        current: number;
        limit: number;
        resetAt: string;
      }
  >;
};

type TokenRateLimiter = {
  check(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string;
    requestId: string;
    estimatedTokens: number;
  }): Promise<
    | { status: "disabled" }
    | {
        status: "rejected";
        scope: "workspace" | "api_key";
        reason: "token_rate_limit";
        current: number;
        limit: number;
        resetAt: string;
      }
  >;
};

type ProviderCredentialResolver = {
  resolveForRequest(input: {
    organizationId: string;
    workspaceId?: string;
    apiKeyId?: string;
    provider: Provider;
  }): Promise<UpstreamCredential | undefined>;
};

export class WebSocketRoutingProxy {
  constructor(
    private readonly config: AppConfig,
    private readonly auth: ProxyAuthService,
    private readonly routing: RoutingService,
    private readonly events: EventService,
    private readonly attempts: ProviderAttemptStore,
    private readonly requestStates: RequestStateStoreLike,
    private readonly providerRegistry: ProviderRegistryResolver,
    private readonly credentials?: ProviderCredentialResolver,
    private readonly promptArtifacts?: PromptArtifactStore,
    private readonly routingConfigs?: RoutingConfigResolverLike,
    private readonly sessionPrompts?: SessionSystemPromptStore,
    private readonly budgetWindows?: BudgetReservationPlanner,
    private readonly activeRequestLimits?: ActiveRequestLimiter,
    private readonly requestRateLimits?: RequestRateLimiter,
    private readonly tokenRateLimits?: TokenRateLimiter,
    private readonly log?: WsLogger
  ) {}

  register(server: Server) {
    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const pathname = new URL(request.url ?? "/", "http://prompt-proxy.local").pathname;
    if (pathname !== "/v1/responses") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const headers = lowerHeaders(request.headers as Record<string, unknown>);
    let identity: RequestIdentity;
    try {
      identity = await this.auth.resolve(headers);
    } catch {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const initialUpstream = await this.connectInitialOpenAIUpstream(identity, headers);
    const wss = new WebSocketServer({ noServer: true });
    if (initialUpstream) {
      wss.on("headers", (responseHeaders) => {
        appendUpgradeHeader(responseHeaders, initialUpstream.headers, "x-codex-turn-state");
        appendUpgradeHeader(responseHeaders, initialUpstream.headers, "x-models-etag");
        appendUpgradeHeader(responseHeaders, initialUpstream.headers, "x-reasoning-included");
        appendUpgradeHeader(responseHeaders, initialUpstream.headers, "openai-model");
      });
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      this.bridge(client, headers, identity, initialUpstream?.socket, initialUpstream?.target);
    });
  }

  private bridge(
    client: WebSocket,
    headers: Record<string, string | undefined>,
    identity: RequestIdentity,
    initialUpstream?: WebSocket,
    initialUpstreamTarget?: WebSocketUpstreamTarget
  ) {
    let messageIndex = 0;
    const fallbackSessionId = createId("ws-session");
    let connectionRoute: RouteName | undefined;
    let activeRequest: ActiveRequest | undefined;
    let upstream = initialUpstream;
    let upstreamTarget = initialUpstreamTarget;
    let sendQueue = Promise.resolve();

    const attachUpstreamHandlers = (socket: WebSocket) => {
      socket.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        if (!isBinary) {
          void this.observeUpstreamMessage(String(data), activeRequest).then((completed) => {
            if (completed) activeRequest = undefined;
          });
        }
      });
      socket.once("close", () => {
        const request = activeRequest;
        activeRequest = undefined;
        client.close();
        if (request) {
          void this.finishActiveRequest(request, "failed", undefined, { websocket: "upstream_closed" });
        }
      });
      socket.once("error", (error) => {
        sendError(client, 502, error instanceof Error ? error.message : "upstream_websocket_failed");
      });
    };

    if (upstream) attachUpstreamHandlers(upstream);

    client.on("message", (data, isBinary) => {
      if (isBinary) {
        sendError(client, 400, "binary_websocket_requests_are_not_supported");
        return;
      }
      messageIndex += 1;
      let routedRequest: ActiveRequest | undefined;
      sendQueue = sendQueue
        .then(async () => {
          const route = await this.routeWebSocketMessage(data, headers, identity, connectionRoute, messageIndex, fallbackSessionId);
          if (route.decision.finalRoute) connectionRoute = route.decision.finalRoute;
          routedRequest = route.activeRequest;
          activeRequest = routedRequest;
          if (!upstream || !upstreamTarget || !sameWebSocketTarget(upstreamTarget, route.upstreamTarget) || upstream.readyState !== WebSocket.OPEN) {
            if (upstream) {
              upstream.removeAllListeners();
              upstream.close();
            }
            upstream = await this.connectUpstream(route.upstreamTarget);
            upstreamTarget = route.upstreamTarget;
            attachUpstreamHandlers(upstream);
          }
          await this.appendProviderRequestForwarded(route.activeRequest, route.body);
          route.activeRequest.providerRequestForwarded = true;
          upstream.send(JSON.stringify(route.body));
        })
        .catch(async (error) => {
          if (routedRequest) {
            await this.finishActiveRequest(routedRequest, "failed", undefined, {
              error: error instanceof Error ? error.message : "websocket_routing_failed"
            });
            if (activeRequest === routedRequest) activeRequest = undefined;
          }
          sendError(client, websocketErrorStatus(error), error instanceof Error ? error.message : "websocket_routing_failed");
        });
    });

    client.once("close", () => {
      if (upstream) {
        upstream.removeAllListeners();
        upstream.close();
      }
      const request = activeRequest;
      activeRequest = undefined;
      if (request) {
        void this.finishActiveRequest(request, "cancelled", undefined, { websocket: "client_closed" });
      }
    });

  }

  private async routeWebSocketMessage(
    data: RawData,
    headers: Record<string, string | undefined>,
    identity: RequestIdentity,
    connectionRoute: RouteName | undefined,
    messageIndex: number,
    fallbackSessionId: string
  ) {
    const body = JSON.parse(String(data));
    const routeBody = pinnedRouteBody(body, connectionRoute);
    const requestId = createId("request");
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
      `${openAIResponsesSurface.createOperation}:websocket:${requestId}:${messageIndex}`,
      routeBody,
      headers
    ));
    const rawContext = openAIResponsesSurface.buildContext(routeBody, headers, "websocket");
    const context = {
      ...contextForIdentity(rawContext, identity),
      transport: "websocket" as const
    };
    if (!context.sessionId) context.sessionId = fallbackSessionId;
    const gate = await this.requestStates.begin(idempotencyKey, requestId, context);
    if (gate.duplicate && (gate.state.status === "classifying" || gate.state.status === "provider_pending")) {
      throw new Error("duplicate_websocket_request_active");
    }

    const activeLimit = await this.reserveActiveRequestLimit(identity, requestId);
    if (activeLimit.status === "rejected") {
      await this.requestStates.finish(idempotencyKey, "failed", { requestId, error: activeLimit.reason });
      await appendLimitRejectedEvent({
        events: this.events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        rejection: activeLimit
      });
      throw websocketError(activeLimit.reason, 429);
    }
    const requestRateLimit = await this.checkRequestRateLimit(identity);
    if (requestRateLimit.status === "rejected") {
      await this.requestStates.finish(idempotencyKey, "failed", { requestId, error: requestRateLimit.reason });
      await appendLimitRejectedEvent({
        events: this.events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        rejection: requestRateLimit
      });
      throw websocketError(requestRateLimit.reason, 429);
    }
    const activeLimitLease = activeLimit.status === "reserved" ? activeLimit : undefined;
    let handedOff = false;

    try {
    await this.events.append({
      tenantId: identity.organizationId,
      workspaceId: identity.workspaceId,
      scopeType: "request",
      scopeId: requestId,
      sessionId: context.sessionId,
      correlationId: requestId,
      idempotencyKey,
      actor: actorForIdentity(identity),
      producer: "prompt-proxy.surface.openai-responses.websocket",
      eventType: "proxy.request_received",
      payload: requestReceivedPayload("openai-responses", context, rawContext, identity, {
        transport: "websocket"
      })
    });
    const capturedArtifacts = await this.promptArtifacts?.capture({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      requestId,
      surface: openAIResponsesSurface.surface,
      body: routeBody,
      harness: context.harness,
      harnessProfileId: context.harnessProfileId,
      transport: context.transport
    }) ?? [];
    await appendPromptCaptureEvent({
      events: this.events,
      identity,
      requestId,
      idempotencyKey,
      sessionId: context.sessionId,
      surface: openAIResponsesSurface.surface,
      artifacts: capturedArtifacts,
      harness: context.harness,
      harnessProfileId: context.harnessProfileId,
      transport: context.transport
    });

    const resolved = await this.resolveRoutingConfig(identity);
    const systemPrompt = await this.effectiveSystemPrompt(identity, context.sessionId, resolved.systemPrompt);
    await appendTokensAttributed({
      events: this.events,
      identity,
      requestId,
      idempotencyKey,
      sessionId: context.sessionId,
      surface: openAIResponsesSurface.surface,
      body: routeBody,
      orgSystemPrompt: systemPrompt,
      warn: (err, message) => this.log?.warn({ err, requestId }, message)
    });
    const decision = await this.routing.decide({
      requestId,
      context,
      body: routeBody,
      idempotencyKey,
      routingConfig: resolved.routingConfig
    });
    if (decision.outcome === "reject") {
      await this.requestStates.finish(idempotencyKey, "failed", { requestId, error: decision.error });
      throw new Error(decision.error ?? "websocket_request_rejected");
    }
    const tokenRateLimit = await this.checkTokenRateLimit(
      identity,
      requestId,
      context.estimatedInputTokens,
      selectedOutputTokenCap(routeBody, decision)
    );
    if (tokenRateLimit.status === "rejected") {
      await this.requestStates.finish(idempotencyKey, "failed", { requestId, error: tokenRateLimit.reason });
      await appendLimitRejectedEvent({
        events: this.events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        rejection: tokenRateLimit
      });
      throw websocketError(tokenRateLimit.reason, 429);
    }
    await this.pinSystemPrompt(identity, requestId, context.sessionId, systemPrompt);
    const provider = routedProvider(decision);
    const credential = await this.resolveUpstreamCredential(identity, provider);
    const providerAccountId = credential?.providerAccountId;
    const budgetReservation = await this.reserveBudget({
      identity,
      requestId,
      idempotencyKey,
      sessionId: context.sessionId,
      inputTokens: context.estimatedInputTokens,
      decision,
      body: routeBody
    });
    if (budgetReservation.status === "rejected") {
      await this.requestStates.finish(idempotencyKey, "failed", { requestId, error: budgetReservation.rejection.reason });
      throw websocketError(budgetReservation.rejection.reason, 429);
    }

    const { attempt } = this.attempts.create({
      idempotencyKey,
      requestId,
      surface: openAIResponsesSurface.surface,
      provider,
      model: decision.selectedModel ?? "unknown",
      providerAccountId
    });
    if (!attempt) throw new Error("duplicate_websocket_request");

    await this.requestStates.markProviderPending(idempotencyKey, attempt.id, requestId);
    const activeRequest: ActiveRequest = {
      requestId,
      idempotencyKey,
      providerAttemptId: attempt.id,
      providerAccountId,
      provider,
      decision,
      identity,
      sessionId: context.sessionId,
      harness: context.harness,
      harnessProfileId: context.harnessProfileId,
      transport: context.transport,
      activeLimit: activeLimitLease
    };

    let forwardedBody: unknown;
    let upstreamTarget: WebSocketUpstreamTarget;
    try {
      const compression = await compressForForwardWithResult({
        events: this.events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIResponsesSurface.surface,
        body: routeBody,
        policy: resolved.toolResultCompressionPolicy,
        deduplicateToolResults: resolved.duplicateToolResultReferences,
        artifactStore: this.promptArtifacts,
        warn: (err, message) => this.log?.warn({ err, requestId }, message)
      });
      activeRequest.compressionTelemetry = compressionForwardTelemetry(compression, resolved.toolResultCompressionPolicy);
      forwardedBody = rewriteSurfaceRequest(compression.body, decision, systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching });
      await appendCompressionEvidence({
        events: this.events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIResponsesSurface.surface,
        policy: resolved.toolResultCompressionPolicy,
        originalBody: routeBody,
        compressedBody: compression.body,
        forwardedBody,
        result: compression,
        warn: (err, message) => this.log?.warn({ err, requestId }, message)
      });

      const routeCandidateId = decision.routeExecutionPlan?.selected?.candidateId;
      const providerRequestStartedPayload: JsonObject = {
        surface: openAIResponsesSurface.surface,
        provider,
        transport: "websocket",
        model: decision.selectedModel ?? "unknown",
        providerAttemptId: attempt.id,
        preparedRequestHash: requestBodyHash(forwardedBody),
        attemptIndex: 0,
        fallbackIndex: 0
      };
      if (routeCandidateId !== undefined) providerRequestStartedPayload.routeCandidateId = routeCandidateId;
      if (providerAccountId) providerRequestStartedPayload.providerAccountId = providerAccountId;
      await this.events.append({
        scopeType: "request",
        scopeId: requestId,
        sessionId: context.sessionId,
        correlationId: requestId,
        idempotencyKey,
        producer: "prompt-proxy.provider",
        eventType: "provider.request_started",
        payload: providerRequestStartedPayload
      });
      upstreamTarget = await this.resolveWebSocketUpstream(
        identity,
        headers,
        forwardedBody,
        context.harnessProfileId,
        decision,
        credential
      );
    } catch (error) {
      await this.finishActiveRequest(activeRequest, "failed", undefined, {
        error: error instanceof Error ? error.message : "websocket_request_failed"
      });
      throw error;
    }
    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      sessionId: context.sessionId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.provider",
      eventType: "provider.stream_started",
      payload: {
        surface: openAIResponsesSurface.surface,
        provider,
        transport: "websocket",
        providerAttemptId: attempt.id
      }
    });
    handedOff = true;
    return {
      body: forwardedBody,
      decision,
      activeRequest,
      upstreamTarget
    };
    } finally {
      if (!handedOff) await this.releaseActiveRequestLimit(activeLimitLease, requestId);
    }
  }

  private async appendProviderRequestForwarded(activeRequest: ActiveRequest, body: unknown) {
    await this.events.append({
      scopeType: "request",
      scopeId: activeRequest.requestId,
      sessionId: activeRequest.sessionId,
      correlationId: activeRequest.requestId,
      idempotencyKey: `${activeRequest.idempotencyKey}:provider-forwarded`,
      producer: "prompt-proxy.provider",
      eventType: "provider.request_forwarded",
      payload: {
        surface: openAIResponsesSurface.surface,
        provider: activeRequest.provider,
        transport: "websocket",
        model: activeRequest.decision.selectedModel ?? "unknown",
        providerAttemptId: activeRequest.providerAttemptId,
        preparedRequestHash: requestBodyHash(body),
        forwardedRequestHash: requestBodyHash(body),
        ...activeRequest.compressionTelemetry
      }
    });
  }

  private async observeUpstreamMessage(text: string, activeRequest: ActiveRequest | undefined) {
    if (!activeRequest) return false;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      return false;
    }
    if (!isRecord(event)) return false;
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      const response = isRecord(event.response) ? event.response : {};
      await this.finishActiveRequest(activeRequest, "completed", response.usage, {
        upstreamResponseId: typeof response.id === "string" ? response.id : undefined,
        upstreamResponseStatus: typeof response.status === "string" ? response.status : undefined
      });
      await this.captureAssistantResponse(activeRequest, response);
      return true;
    }
    if (event.type === "response.failed" || event.type === "error") {
      await this.finishActiveRequest(activeRequest, "failed", undefined, {
        error: jsonPayload(event)
      });
      return true;
    }
    return false;
  }

  private async captureAssistantResponse(activeRequest: ActiveRequest, response: Record<string, unknown>) {
    if (!this.promptArtifacts) return;
    try {
      const text = extractResponseText(openAIResponsesSurface.surface, response);
      if (!text) return;
      const artifacts = await this.promptArtifacts.captureResponse({
        organizationId: activeRequest.identity.organizationId,
        workspaceId: activeRequest.identity.workspaceId,
        requestId: activeRequest.requestId,
        surface: openAIResponsesSurface.surface,
        transport: activeRequest.transport,
        harness: activeRequest.harness,
        harnessProfileId: activeRequest.harnessProfileId,
        text
      });
      await appendPromptCaptureEvent({
        events: this.events,
        identity: activeRequest.identity,
        requestId: activeRequest.requestId,
        idempotencyKey: activeRequest.idempotencyKey,
        sessionId: activeRequest.sessionId,
        surface: openAIResponsesSurface.surface,
        transport: activeRequest.transport,
        harness: activeRequest.harness,
        harnessProfileId: activeRequest.harnessProfileId,
        artifacts
      });
    } catch {
      // Response capture must never break the websocket bridge.
    }
  }

  private async finishActiveRequest(
    activeRequest: ActiveRequest,
    status: "completed" | "failed" | "cancelled",
    usage: unknown,
    metadata: unknown
  ) {
    try {
      const metadataPayload = jsonPayload(metadata) as JsonObject;
      const error = status === "completed" ? undefined : terminalError(metadataPayload);
      const payload: JsonObject = {
        surface: openAIResponsesSurface.surface,
        provider: activeRequest.provider,
        selectedModel: activeRequest.decision.selectedModel ?? "unknown",
        providerAttemptId: activeRequest.providerAttemptId,
        terminalStatus: status,
        upstreamStatus: status === "completed" ? 200 : 0,
        usage: usage === undefined ? null : jsonPayload(usage)
      };
      Object.assign(
        payload,
        providerCompressionTerminalTelemetry(
          activeRequest.compressionTelemetry,
          activeRequest.providerRequestForwarded === true
        )
      );
      if (error) payload.error = error;
      if (activeRequest.providerAccountId) payload.providerAccountId = activeRequest.providerAccountId;
      const healthClassification = classifyProviderTerminalHealth({
        provider: activeRequest.provider,
        model: activeRequest.decision.selectedModel ?? "unknown",
        terminalStatus: status,
        statusCode: status === "completed" ? 200 : 0,
        error,
        now: new Date()
      });
      if (healthClassification) payload.healthClassification = jsonPayload(healthClassification);

      const terminalEvent = await this.events.append({
        scopeType: "request",
        scopeId: activeRequest.requestId,
        correlationId: activeRequest.requestId,
        idempotencyKey: activeRequest.idempotencyKey,
        producer: "prompt-proxy.provider",
        eventType: terminalEventType(status),
        payload,
        metadata: metadataPayload
      });
      await this.appendHealthEvent(activeRequest, healthClassification);
      if (usage !== undefined) {
        await this.events.append({
          scopeType: "request",
          scopeId: activeRequest.requestId,
          correlationId: activeRequest.requestId,
          idempotencyKey: activeRequest.idempotencyKey,
          producer: "prompt-proxy.usage",
          eventType: "usage.recorded",
          payload: {
            providerAttemptId: activeRequest.providerAttemptId,
            usage: jsonPayload(usage)
          }
        });
      }
      await this.appendBudgetSignals(activeRequest, new Date(terminalEvent.createdAt));
      this.attempts.update(activeRequest.providerAttemptId, {
        terminalStatus: status,
        usage: usage === undefined ? undefined : jsonPayload(usage),
        error
      });
      await this.requestStates.finish(activeRequest.idempotencyKey, status, {
        requestId: activeRequest.requestId,
        providerAttemptId: activeRequest.providerAttemptId,
        usage: usage === undefined ? undefined : jsonPayload(usage),
        error
      });
    } finally {
      await this.releaseActiveRequestLimit(activeRequest.activeLimit, activeRequest.requestId);
    }
  }

  private async appendBudgetSignals(activeRequest: ActiveRequest, at: Date) {
    if (!this.budgetWindows) return;
    const signals = await this.budgetWindows.pendingSignalsForRequest({
      organizationId: activeRequest.identity.organizationId,
      requestId: activeRequest.requestId,
      at
    });
    if (signals.length === 0) return;
    await appendBudgetSignalEvents({
      events: this.events,
      organizationId: activeRequest.identity.organizationId,
      requestId: activeRequest.requestId,
      idempotencyKey: activeRequest.idempotencyKey,
      sessionId: activeRequest.sessionId,
      signals
    });
  }

  private async appendHealthEvent(
    activeRequest: ActiveRequest,
    classification: ProviderHealthClassification | undefined
  ) {
    if (!activeRequest.providerAccountId || !classification) return;
    if (classification.scope === "request_only" || classification.scope === "provider") return;

    const selectedModel = activeRequest.decision.selectedModel ?? "unknown";
    const eventType = healthEventType(classification);
    if (!eventType) return;

    await this.events.append({
      tenantId: activeRequest.identity.organizationId,
      workspaceId: activeRequest.identity.workspaceId,
      scopeType: classification.scope === "provider_account" ? "provider_account" : "provider_model",
      scopeId: classification.scope === "provider_account"
        ? activeRequest.providerAccountId
        : `${activeRequest.providerAccountId}:${selectedModel}`,
      correlationId: activeRequest.requestId,
      idempotencyKey: activeRequest.idempotencyKey,
      producer: "prompt-proxy.provider-health",
      eventType,
      payload: {
        provider: activeRequest.provider,
        providerAccountId: activeRequest.providerAccountId,
        model: selectedModel,
        providerAttemptId: activeRequest.providerAttemptId,
        classification: jsonPayload(classification)
      }
    });
  }

  private async resolveWebSocketUpstream(
    identity: RequestIdentity,
    incoming: Record<string, string | undefined>,
    body: unknown,
    harnessProfileId: RouteContext["harnessProfileId"],
    decision: RouteDecision,
    credential?: UpstreamCredential
  ): Promise<WebSocketUpstreamTarget> {
    if (!decision.providerSettings) throw new Error("websocket_provider_settings_missing");
    if (decision.providerSettings.dialect !== openAIResponsesSurface.dialect) {
      throw new Error("websocket_dialect_unavailable");
    }
    const selectedProvider = routedProvider(decision);
    let provider;
    try {
      provider = await this.providerRegistry.resolve({
        organizationId: identity.organizationId,
        provider: selectedProvider
      });
    } catch (error) {
      throw new Error(error instanceof ProviderRegistryError ? error.code : "provider_registry_resolution_failed");
    }
    if (!provider) throw new Error("provider_not_found");
    if (!provider.enabled) throw new Error("provider_disabled");
    const endpoint = providerEndpointForDialect(provider, decision.providerSettings.dialect);
    if (!endpoint) throw new Error("provider_endpoint_not_found");
    if (!canAuthenticateOrgProvider(provider, credential)) throw new Error("provider_credential_unresolved");
    return {
      provider: provider.slug,
      ...webSocketTargetUrl(provider, endpoint, this.config, credential),
      headers: providerRequestHeaders({
        config: this.config,
        provider,
        endpoint,
        surface: openAIResponsesSurface.surface,
        harnessProfileId,
        body,
        incoming,
        credential
      })
    };
  }

  private resolveUpstreamCredential(identity: RequestIdentity, provider: Provider) {
    return this.credentials?.resolveForRequest({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      apiKeyId: identity.apiKeyId,
      provider
    });
  }

  private async connectInitialOpenAIUpstream(
    identity: RequestIdentity,
    incoming: Record<string, string | undefined>
  ) {
    try {
      if (!await this.canPreconnectOpenAI(identity)) return undefined;
      const credential = await this.resolveUpstreamCredential(identity, "openai");
      const provider = await this.providerRegistry.resolve({
        organizationId: identity.organizationId,
        provider: "openai"
      });
      if (!provider || !provider.enabled) return undefined;
      const endpoint = providerEndpointForDialect(provider, openAIResponsesSurface.dialect);
      if (!endpoint || !canAuthenticateOrgProvider(provider, credential)) return undefined;
      const target = {
        provider: provider.slug,
        ...webSocketTargetUrl(provider, endpoint, this.config, credential),
        headers: providerRequestHeaders({
          config: this.config,
          provider,
          endpoint,
          surface: openAIResponsesSurface.surface,
          harnessProfileId: "codex-responses-websocket",
          body: {},
          incoming,
          credential
        })
      };
      const { socket, headers } = await this.connectUpstreamWithUpgradeHeaders(target);
      return { socket, target, headers };
    } catch (error) {
      this.log?.warn({ err: error }, "initial websocket upstream preconnect failed");
      return undefined;
    }
  }

  private async canPreconnectOpenAI(identity: RequestIdentity) {
    const resolved = await this.resolveRoutingConfig(identity);
    const config = resolved.routingConfig?.config;
    if (!config) return true;
    const providerIds = new Set(
      Object.values(config.routes).flatMap((route) => route.targets.map((target) => target.providerId))
    );
    for (const providerId of providerIds) {
      if (providerId === "openai") continue;
      const provider = await this.providerRegistry.resolve({
        organizationId: identity.organizationId,
        provider: providerId
      });
      if (provider?.enabled && providerEndpointForDialect(provider, openAIResponsesSurface.dialect)) {
        return false;
      }
    }
    return true;
  }

  private connectUpstream(target: WebSocketUpstreamTarget) {
    return this.connectUpstreamWithUpgradeHeaders(target).then((connection) => connection.socket);
  }

  private connectUpstreamWithUpgradeHeaders(target: WebSocketUpstreamTarget) {
    const upstream = new WebSocket(target.url, {
      headers: target.headers,
      lookup: target.lookup,
      perMessageDeflate: true
    });
    let upgradeHeaders: IncomingHttpHeaders = {};
    return new Promise<{ socket: WebSocket; headers: IncomingHttpHeaders }>((resolve, reject) => {
      let opened = false;
      let upgraded = false;
      const maybeResolve = () => {
        if (!opened || !upgraded) return;
        upstream.off("error", onError);
        resolve({ socket: upstream, headers: upgradeHeaders });
      };
      const onOpen = () => {
        opened = true;
        maybeResolve();
      };
      const onError = (error: Error) => {
        upstream.off("open", onOpen);
        upstream.off("upgrade", onUpgrade);
        reject(error);
      };
      const onUpgrade = (response: IncomingMessage) => {
        upgradeHeaders = response.headers;
        upgraded = true;
        maybeResolve();
      };
      upstream.once("open", onOpen);
      upstream.once("upgrade", onUpgrade);
      upstream.once("error", onError);
    });
  }

  private async resolveRoutingConfig(identity: RequestIdentity) {
    return resolveRoutingSelection(this.routingConfigs, {
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      routingConfigId: identity.routingConfigId
    });
  }

  private async effectiveSystemPrompt(
    identity: RequestIdentity,
    sessionId: string | undefined,
    systemPrompt: string | undefined
  ) {
    const pinned = await this.sessionPrompts?.resolve({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      surface: openAIResponsesSurface.surface,
      sessionId
    });
    return pinned?.pinned ? pinned.systemPrompt : systemPrompt;
  }

  private async pinSystemPrompt(
    identity: RequestIdentity,
    requestId: string,
    sessionId: string | undefined,
    systemPrompt: string | undefined
  ) {
    await this.sessionPrompts?.pin({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      surface: openAIResponsesSurface.surface,
      requestId,
      sessionId,
      systemPrompt
    });
  }

  private reserveActiveRequestLimit(
    identity: RequestIdentity,
    requestId: string
  ) {
    if (!this.activeRequestLimits) return Promise.resolve({ status: "disabled" as const });
    return this.activeRequestLimits.reserve({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      apiKeyId: identity.apiKeyId,
      requestId
    });
  }

  private checkRequestRateLimit(identity: RequestIdentity) {
    if (!this.requestRateLimits) return Promise.resolve({ status: "disabled" as const });
    return this.requestRateLimits.check({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      apiKeyId: identity.apiKeyId
    });
  }

  private checkTokenRateLimit(
    identity: RequestIdentity,
    requestId: string,
    inputTokens: number,
    outputTokens: number
  ) {
    if (!this.tokenRateLimits) return Promise.resolve({ status: "disabled" as const });
    return this.tokenRateLimits.check({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      apiKeyId: identity.apiKeyId,
      requestId,
      estimatedTokens: inputTokens + outputTokens
    });
  }

  private async reserveBudget(input: {
    identity: RequestIdentity;
    requestId: string;
    idempotencyKey: string;
    sessionId?: string;
    inputTokens: number;
    decision: RouteDecision;
    body: unknown;
  }): Promise<
    | { status: "disabled" }
    | { status: "reserved" }
    | { status: "rejected"; rejection: BudgetReservationRejection; estimatedCostMicros: number }
  > {
    if (!this.budgetWindows || !input.decision.provider || !input.decision.selectedModel) {
      return { status: "disabled" };
    }
    const plan = await this.budgetWindows.planRequestReservation({
      organizationId: input.identity.organizationId,
      workspaceId: input.identity.workspaceId,
      apiKeyId: input.identity.apiKeyId,
      provider: input.decision.provider,
      model: input.decision.selectedModel,
      inputTokens: input.inputTokens,
      outputTokens: selectedOutputTokenCap(input.body, input.decision),
      at: new Date()
    });
    if (plan.rejection) {
      await appendBudgetRejectedEvent({
        events: this.events,
        identity: input.identity,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        rejection: plan.rejection,
        estimatedCostMicros: plan.estimatedCostMicros
      });
      return { status: "rejected", rejection: plan.rejection, estimatedCostMicros: plan.estimatedCostMicros };
    }
    if (plan.entries.length === 0) return { status: "disabled" };
    try {
      await appendBudgetReservedEvent({
        events: this.events,
        identity: input.identity,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        entries: plan.entries,
        estimatedCostMicros: plan.estimatedCostMicros
      });
    } catch (error) {
      if (!(error instanceof BudgetReservationRejectedError)) throw error;
      await appendBudgetRejectedEvent({
        events: this.events,
        identity: input.identity,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        rejection: error.rejection,
        estimatedCostMicros: plan.estimatedCostMicros
      });
      return { status: "rejected", rejection: error.rejection, estimatedCostMicros: plan.estimatedCostMicros };
    }
    return { status: "reserved" };
  }

  private async releaseActiveRequestLimit(
    activeLimit: Extract<ActiveRequestLimitReservation, { status: "reserved" }> | undefined,
    requestId: string
  ) {
    if (!activeLimit) return;
    try {
      await activeLimit.release();
    } catch (error) {
      this.log?.warn({ err: error, requestId }, "active request limit release failed");
    }
  }
}

type WebSocketUpstreamTarget = {
  provider: Provider;
  url: string;
  headers: Record<string, string>;
  lookup?: LookupFunction;
};

function webSocketTargetUrl(
  provider: ProviderRegistryEntry,
  endpoint: ProviderRegistryEndpoint,
  config: AppConfig,
  credential?: UpstreamCredential
) {
  const pinnedAddress = providerRequestPinnedAddress({ provider, config, credential });
  const url = new URL(providerRequestUrl({ provider, endpoint, config, credential }));
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return {
    url: url.toString(),
    lookup: pinnedAddress ? lookupForPinnedAddress(pinnedAddress) : undefined
  };
}

function terminalEventType(status: "completed" | "failed" | "cancelled") {
  if (status === "completed") return "provider.response_completed";
  if (status === "cancelled") return "provider.response_cancelled";
  return "provider.response_failed";
}

function healthEventType(classification: ProviderHealthClassification) {
  if (classification.scope === "provider_account") {
    return classification.cooldownUntil ? "provider_account.cooldown_started" : "provider_account.health_changed";
  }
  if (classification.scope === "provider_account_model" && classification.cooldownUntil) {
    return "provider_model.lockout_started";
  }
  return undefined;
}

function terminalError(metadata: JsonObject) {
  const error = metadata.error;
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return undefined;
  return JSON.stringify(error);
}

function routedProvider(decision: { provider?: Provider }) {
  if (!decision.provider) throw new Error("Missing routed provider.");
  return decision.provider;
}

function pinnedRouteBody(body: unknown, connectionRoute: RouteName | undefined) {
  if (!connectionRoute || !isRecord(body) || typeof body.previous_response_id !== "string") {
    return body;
  }
  if (typeof body.model === "string" && body.model.startsWith("router-")) {
    return body;
  }
  return {
    ...body,
    model: `router-${connectionRoute}`
  };
}

function outputTokenCap(body: unknown) {
  if (!isRecord(body)) return 4096;
  for (const key of ["max_output_tokens", "max_tokens", "max_completion_tokens"]) {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.ceil(value);
    }
  }
  return 4096;
}

function selectedOutputTokenCap(body: unknown, decision: RouteDecision) {
  return decision.providerSettings?.maxOutputTokens ?? outputTokenCap(body);
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
  socket.destroy();
}

function sendError(client: WebSocket, status: number, message: string) {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(JSON.stringify({
    type: "error",
    status,
    error: {
      code: "prompt_proxy_error",
      message
    }
  }));
}

function websocketError(message: string, statusCode: number) {
  const error = new Error(message);
  (error as Error & { statusCode: number }).statusCode = statusCode;
  return error;
}

function websocketErrorStatus(error: unknown) {
  const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode;
  return typeof statusCode === "number" ? statusCode : 500;
}

function appendUpgradeHeader(
  responseHeaders: string[],
  upstreamHeaders: IncomingHttpHeaders,
  key: string
) {
  const value = headerValue(upstreamHeaders as Record<string, unknown>, key);
  if (value) responseHeaders.push(`${key}: ${value}`);
}

function sameWebSocketTarget(left: WebSocketUpstreamTarget, right: WebSocketUpstreamTarget) {
  if (left.provider !== right.provider || left.url !== right.url) return false;
  const leftEntries = Object.entries(left.headers).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right.headers).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}
