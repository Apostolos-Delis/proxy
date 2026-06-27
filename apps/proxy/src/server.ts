import { performance } from "node:perf_hooks";

import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { AdminAuthService } from "./adminAuth.js";
import { registerAdminEventStream } from "./adminEvents.js";
import {
  anthropicMessagesSurface,
  openAIChatSurface,
  openAIResponsesSurface,
  type ProviderForwardAttemptInput,
  rewriteSurfaceRequest,
  rewriteTokenCountRequest
} from "./adapters.js";
import {
  actorForIdentity,
  contextForIdentity,
  ProxyAuthService,
  requestReceivedPayload,
  scopedIdempotencyKey,
  type RequestIdentity
} from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import {
  compressionCacheWindowEventPayload,
  noCompressionCacheWindow,
  type CompressionCacheWindow
} from "./compressionCacheWindow.js";
import { DefaultRoutingConfigResolver } from "./defaultRoutingConfig.js";
import { LlmClassifier } from "./classifier.js";
import { EmailService } from "./email.js";
import {
  BoundedEventWriter,
  EventService,
  ProviderAttemptStore,
  RequestStateStore,
  type RequestStateGate,
  type RequestStateStoreLike
} from "./events.js";
import { registerAdminGraphQL } from "./graphql/route.js";
import { harnessProfileByName } from "./harness.js";
import { scheduleDailyModelCatalogRefresh } from "./jobs/modelCatalogRefresh.js";
import {
  createMetricsCollector,
  metricErrorClassForStatus,
  metricStatusClassFor,
  metricTerminalStatusFor,
  type MetricsCollector
} from "./metrics.js";
import { AsyncObservabilityEventAppender } from "./observability.js";
import { SessionRouteStore } from "./policy.js";
import { createPostgresPersistence } from "./persistence/index.js";
import type {
  CompressionRetrievalFailureReason,
  CompressionRetrievalMetadata
} from "./persistence/compressionReceipts.js";
import { ConfigProviderRegistry } from "./persistence/providers.js";
import { resolveRoutingSelection, type RoutingConfigResolverLike } from "./persistence/routingConfig.js";
import { modelDiscoveryResponse } from "./modelDiscovery.js";
import { appendPromptCaptureEvent } from "./promptCaptureEvents.js";
import { computePromptCachePlan } from "./promptCachePlan.js";
import { ProjectionService } from "./projections.js";
import { appendTokensAttributed } from "./tokenAttribution.js";
import {
  appendCompressionEvidence,
  compressionForwardTelemetry,
  compressForForwardWithResult,
  compressOrFallback
} from "./toolResultCompression.js";
import { ProviderProxy } from "./proxy.js";
import { ProviderDeploymentHealthStore } from "./providerDeploymentHealth.js";
import { RequestTiming, requestBodySizeBytes } from "./requestTiming.js";
import { RoutingService } from "./router.js";
import { buildSetupScript } from "./setupScript.js";
import { TrafficLimitStore, type TrafficLimitDenied, type TrafficLimitLease } from "./trafficLimits.js";
import type { Provider, RouteContext, RouteDecision, RouteProviderAttempt, Surface } from "./types.js";
import { createId, headerValue, idempotencyFrom, isRecord, lowerHeaders } from "./util.js";
import { WebSocketRoutingProxy } from "./wsProxy.js";

type AppPersistence = ReturnType<typeof createPostgresPersistence>;

const persistentProviderAttemptMirrorLimit = 10_000;
const persistentSessionMirrorLimit = 10_000;

export function buildServer(config: AppConfig = loadConfig(), options: { persistence?: AppPersistence; metrics?: MetricsCollector } = {}) {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.requestBodyLimitBytes
  });
  app.setErrorHandler((error, _request, reply) => {
    if (isBodyLimitError(error)) {
      reply.code(413).send({
        error: "Request body exceeds proxy limit.",
        limitBytes: config.requestBodyLimitBytes
      });
      return;
    }
    reply.send(error);
  });
  const metrics = options.metrics ?? createMetricsCollector(config);
  metrics.setGauge("proxy_up", 1);
  const modelRequestsInFlight = new Map<string, { labels: Record<string, string>; value: number }>();
  const requestMetrics = new WeakMap<FastifyRequest, RequestMetricsState>();

  app.addHook("onRequest", (request, _reply, done) => {
    const state = requestMetricsState(config, request);
    requestMetrics.set(request, state);
    if (state.surface) adjustModelRequestsInFlight(metrics, modelRequestsInFlight, state, 1);
    done();
  });
  app.addHook("onResponse", async (request, reply) => {
    const state = requestMetrics.get(request);
    if (!state) return;

    const durationSeconds = (performance.now() - state.startedAtMs) / 1000;
    const statusClass = metricStatusClassFor(reply.statusCode);
    const errorClass = state.errorClass ?? metricErrorClassForStatus(reply.statusCode);
    metrics.incrementCounter("proxy_http_requests_total", {
      route_family: state.routeFamily,
      method: request.method,
      status_class: statusClass,
      error_class: errorClass
    });
    metrics.observeHistogram("proxy_http_request_duration_seconds", durationSeconds, {
      route_family: state.routeFamily,
      method: request.method,
      status_class: statusClass
    });

    if (state.surface) {
      finishModelRequestMetrics(
        metrics,
        modelRequestsInFlight,
        state,
        state.terminalStatus ?? (reply.statusCode >= 400 ? "failed" : "succeeded"),
        errorClass
      );
    }
  });
  void app.register(cors, {
    origin: config.adminCorsOrigins,
    credentials: true,
    methods: ["GET", "HEAD", "POST"]
  });
  const persistence = options.persistence ?? (config.databaseUrl
    ? createPostgresPersistence(config.databaseUrl, config, metrics)
    : undefined);
  metrics.setGauge("proxy_persistence_enabled", persistence ? 1 : 0);
  const routingConfigs = persistence?.routingConfigs ?? new DefaultRoutingConfigResolver(config);
  const events = new EventService(
    config.eventStorePath,
    undefined,
    persistence?.eventSink,
    config.defaultOrganizationId,
    metrics,
    {
      mirrorLimit: persistence ? 1_000 : undefined,
      scopeLimit: persistence ? 50_000 : undefined
    }
  );
  const auth = new ProxyAuthService(config, persistence?.apiKeys);
  const adminAuth = new AdminAuthService(config, persistence?.adminSessions);
  const attempts = new ProviderAttemptStore({
    maxAttempts: persistence ? persistentProviderAttemptMirrorLimit : undefined
  });
  const requestStates = persistence?.requestStates ?? new RequestStateStore();
  const sessions = new SessionRouteStore(
    persistence?.sessionPins,
    persistence ? persistentSessionMirrorLimit : Number.POSITIVE_INFINITY
  );
  const classifier = new LlmClassifier(config, metrics);
  const providerRegistry = persistence?.providerRegistry ?? new ConfigProviderRegistry(config);
  const observabilityWriter = new BoundedEventWriter(events, {
    maxEntries: config.eventWriterMaxEntries,
    maxBytes: config.eventWriterMaxBytes,
    batchSize: config.eventWriterBatchSize,
    onDrop: (input, reason) => app.log.warn({ eventType: input.eventType, reason }, "observability event dropped"),
    onFlushFailure: (err, input, attempt) => app.log.warn(
      { err, eventType: input.eventType, attempt },
      "observability event flush failed"
    )
  });
  app.addHook("onClose", async () => {
    const stats = await observabilityWriter.drain(config.eventWriterShutdownTimeoutMs);
    if (stats.depth > 0) {
      app.log.warn({ stats }, "observability event writer shutdown drain timed out");
    }
  });
  const observabilityEvents = new AsyncObservabilityEventAppender(events, observabilityWriter);
  const deploymentHealth = new ProviderDeploymentHealthStore();
  const trafficLimits = new TrafficLimitStore(config.trafficLimits);
  const routing = new RoutingService(
    config,
    classifier,
    observabilityEvents,
    sessions,
    providerRegistry,
    persistence?.providerCredentials,
    persistence?.providerHealth,
    persistence?.modelDiscovery,
    metrics,
    deploymentHealth
  );
  const proxy = new ProviderProxy(config, events, attempts, requestStates, providerRegistry, metrics, deploymentHealth);
  const captureRequestArtifacts = async (input: Parameters<AppPersistence["promptArtifacts"]["capture"]>[0]) => {
    if (!persistence) return [];
    try {
      return await persistence.promptArtifacts.capture(input);
    } catch (error) {
      app.log.warn({ err: error, requestId: input.requestId }, "prompt artifact capture failed");
      return [];
    }
  };
  const assistantResponseCapture = (input: {
    identity: RequestIdentity;
    requestId: string;
    idempotencyKey: string;
    sessionId?: string;
    surface: Surface;
    transport?: RouteContext["transport"];
    harness?: RouteContext["harness"];
    harnessProfileId?: RouteContext["harnessProfileId"];
  }) => {
    if (!persistence) return undefined;
    return async (text: string, truncated: boolean) => {
      try {
        const artifacts = await persistence.promptArtifacts.captureResponse({
          organizationId: input.identity.organizationId,
          workspaceId: input.identity.workspaceId,
          requestId: input.requestId,
          surface: input.surface,
          transport: input.transport,
          harness: input.harness,
          harnessProfileId: input.harnessProfileId,
          text,
          truncated
        });
        await appendPromptCaptureEvent({
          events,
          identity: input.identity,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          sessionId: input.sessionId,
          surface: input.surface,
          transport: input.transport,
          harness: input.harness,
          harnessProfileId: input.harnessProfileId,
          artifacts
        });
      } catch (error) {
        app.log.warn({ err: error, requestId: input.requestId }, "assistant response capture failed");
      }
    };
  };
  const wsProxy = new WebSocketRoutingProxy(
    config,
    auth,
    routing,
    events,
    attempts,
    requestStates,
    providerRegistry,
    persistence?.providerCredentials,
    persistence?.promptArtifacts,
    routingConfigs,
    persistence?.sessionPrompts,
    persistence?.compressionCacheWindows,
    app.log
  );
  const projections = new ProjectionService(config);
  const emailService = new EmailService(config, app.log);
  registerAdminGraphQL(app, { config, adminAuth, emailService, events, projections, persistence });
  registerAdminEventStream(app, events, adminAuth);
  wsProxy.register(app.server);

  app.get("/healthz", async () => ({ status: "ok" }));

  if (config.metricsEnabled && config.metricsExporter === "prometheus") {
    app.get(config.metricsPath, async (request, reply) => {
      if (config.metricsAuthMode === "token") {
        requireAuth(request.headers, config.metricsToken ?? "");
      }
      reply.header("content-type", "application/openmetrics-text; version=1.0.0; charset=utf-8");
      reply.header("cache-control", "no-store");
      return metrics.renderOpenMetrics();
    });
  }

  app.get("/setup.sh", async (request, reply) => {
    const proto = headerValue(request.headers, "x-forwarded-proto")?.split(",")[0].trim() ?? request.protocol;
    const host = headerValue(request.headers, "x-forwarded-host") ?? headerValue(request.headers, "host") ?? `127.0.0.1:${config.port}`;
    // text/plain (not x-shellscript) so the link in the setup guide renders
    // the script in the browser instead of downloading it.
    void reply.header("content-type", "text/plain; charset=utf-8");
    void reply.header("cache-control", "no-store");
    return buildSetupScript(`${proto}://${host}`);
  });

  app.get("/v1/models", async (request) => {
    const identity = await optionalIdentity(auth, request.headers);
    const catalogModels = await persistence?.modelDiscovery.catalogModels(identity?.organizationId) ?? [];
    return modelDiscoveryResponse(catalogModels);
  });

  app.post("/v1/compression/retrieve", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    const identity = await auth.resolve(request.headers);
    if (!identity.apiKeyId) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    if (!persistence?.compressionRetrieval) {
      reply.code(503).send({ error: "compression_retrieval_unavailable" });
      return;
    }

    const parsed = compressionRetrieveBody(request.body);
    if (!parsed.ok) {
      reply.code(400).send({ error: "invalid_request", message: parsed.message });
      return;
    }

    const result = await persistence.compressionRetrieval.resolve({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      apiKeyId: identity.apiKeyId,
      retrievalId: parsed.retrievalId
    });
    if (!result.ok) {
      if (result.metadata) {
        await events.append({
          tenantId: identity.organizationId,
          workspaceId: identity.workspaceId,
          scopeType: "request",
          scopeId: result.metadata.requestId,
          correlationId: result.metadata.requestId,
          actor: actorForIdentity(identity),
          producer: "proxy.compression-retrieval",
          eventType: "compression.retrieval_failed",
          payload: compressionRetrievalEventPayload(result.metadata, "failed", result.reason)
        });
      }
      reply.code(compressionRetrievalFailureStatus(result.reason)).send({
        error: result.reason,
        message: compressionRetrievalFailureMessage(result.reason)
      });
      return;
    }

    await persistence.promptAccessAudit.append({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      artifactId: result.audit.artifactId,
      requestId: result.metadata.requestId,
      userId: identity.userId,
      accessPath: "/v1/compression/retrieve"
    });
    await events.append({
      tenantId: identity.organizationId,
      workspaceId: identity.workspaceId,
      scopeType: "request",
      scopeId: result.metadata.requestId,
      correlationId: result.metadata.requestId,
      actor: actorForIdentity(identity),
      producer: "proxy.compression-retrieval",
      eventType: "compression.retrieved",
      payload: compressionRetrievalEventPayload(result.metadata, "retrieved")
    });

    return {
      retrievalId: result.retrievalId,
      content: result.content,
      queryApplied: false,
      metadata: {
        surface: result.metadata.surface,
        blockPath: result.metadata.blockPath,
        toolName: result.metadata.toolName,
        command: result.metadata.command,
        commandClass: result.metadata.commandClass,
        ruleId: result.metadata.ruleId,
        ruleVersion: result.metadata.ruleVersion,
        originalSha256: result.metadata.originalSha256,
        compressedSha256: result.metadata.compressedSha256,
        createdAt: result.metadata.createdAt
      }
    };
  });

  if (config.debugEndpointsEnabled) {
    app.get("/_debug/events", async (request) => {
      requireAuth(request.headers, config.proxyToken);
      return events.listEvents();
    });
    app.get("/_debug/provider-attempts", async (request) => {
      requireAuth(request.headers, config.proxyToken);
      return attempts.list();
    });
    app.get("/_debug/outbox", async (request) => {
      requireAuth(request.headers, config.proxyToken);
      return events.listOutbox();
    });
    app.get("/_debug/event-writer", async (request) => {
      requireAuth(request.headers, config.proxyToken);
      return observabilityWriter.stats();
    });
    app.get("/_debug/sessions", async (request) => {
      requireAuth(request.headers, config.proxyToken);
      return sessions.list();
    });
    app.get("/_debug/projections", async (request) => {
      requireAuth(request.headers, config.proxyToken);
      return projections.usage(events.listEvents());
    });
    app.get("/_debug/route-quality", async (request) => {
      requireAuth(request.headers, config.proxyToken);
      return projections.routeQuality(events.listEvents());
    });
  }
  app.post("/v1/responses", async (request, reply) => {
    const timing = new RequestTiming(app.log, {
      surface: openAIResponsesSurface.surface,
      requestBodyBytes: requestBodySizeBytes(headerValue(request.headers, "content-length"), request.body)
    });
    timing.sampleEventLoopLag();
    const identity = await timing.measure("auth", () => auth.resolve(request.headers));
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
      openAIResponsesSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = openAIResponsesSurface.buildContext(request.body, lowerHeaders(request.headers));
    markModelStream(metrics, modelRequestsInFlight, requestMetrics, request, requestWantsStream(request.body));
    const context = contextForIdentity(rawContext, identity);
    const proposedRequestId = createId("request");
    const gate = await timing.measure("idempotency_claim", () => requestStates.begin(idempotencyKey, proposedRequestId, context));
    if (sendDuplicateRequest(gate, reply)) {
      timing.log("duplicate");
      return;
    }
    const requestId = gate.state.requestId ?? proposedRequestId;
    timing.addMetadata({
      requestId,
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId
    });

    let requestLimitLease: TrafficLimitLease | undefined;
    try {
      requestLimitLease = await acquireTrafficLimitOrReject({
        trafficLimits,
        requestStates,
        reply,
        idempotencyKey,
        identity,
        context
      });
      if (!requestLimitLease) {
        markModelErrorClass(requestMetrics, request, "traffic_limit");
        return;
      }
      await events.append({
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        scopeType: "request",
        scopeId: requestId,
        correlationId: requestId,
        idempotencyKey,
        actor: actorForIdentity(identity),
        producer: "proxy.surface.openai-responses",
        eventType: "proxy.request_received",
        payload: requestReceivedPayload("openai-responses", context, rawContext, identity)
      });
      const capturedArtifacts = await captureRequestArtifacts({
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        surface: openAIResponsesSurface.surface,
        body: request.body,
        transport: context.transport,
        harness: context.harness,
        harnessProfileId: context.harnessProfileId
      });
      await appendPromptCaptureEvent({
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIResponsesSurface.surface,
        transport: context.transport,
        harness: context.harness,
        harnessProfileId: context.harnessProfileId,
        artifacts: capturedArtifacts
      });

      const resolved = await resolveRoutingConfig(routingConfigs, identity);
      const systemPrompt = await effectiveSystemPrompt(
        persistence,
        identity,
        openAIResponsesSurface.surface,
        context.sessionId,
        resolved.systemPrompt
      );
      await appendTokensAttributed({
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIResponsesSurface.surface,
        body: request.body,
        orgSystemPrompt: systemPrompt,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const decision = await routing.decide({
        requestId,
        context,
        body: request.body,
        idempotencyKey,
        routingConfig: resolved.routingConfig
      });
      timing.recordDecision(decision);
      if (decision.outcome === "reject") {
        await requestStates.finish(idempotencyKey, "failed", { requestId, error: decision.error });
        markModelErrorClass(requestMetrics, request, "routing");
        sendRejectedDecision(decision, reply);
        return;
      }
      await pinSystemPrompt(persistence, identity, openAIResponsesSurface.surface, requestId, context.sessionId, systemPrompt);
      const compressionCacheWindow = await appendCompressionCacheWindowResolved({
        persistence,
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIResponsesSurface.surface,
        provider: routedProvider(decision),
        model: decision.selectedModel ?? "unknown",
        body: request.body,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });

      const compression = await compressForForwardWithResult({
        events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIResponsesSurface.surface,
        body: request.body,
        policy: resolved.toolResultCompressionPolicy,
        deduplicateToolResults: resolved.duplicateToolResultReferences,
        frozenPrefixItems: compressionCacheWindow.frozenPrefixItems,
        profile: harnessProfileByName(context.harness),
        artifactStore: persistence?.promptArtifacts,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const forwardedBody = rewriteSurfaceRequest(compression.body, decision, systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching });
      const providerAttempts = await buildProviderForwardAttempts({
        persistence,
        identity,
        body: compression.body,
        context,
        cacheSettings: { automaticCaching: resolved.automaticCaching, cacheTtlUpgrade: resolved.cacheTtlUpgrade },
        decision,
        rewrite: (attemptDecision) => rewriteSurfaceRequest(
          compression.body,
          attemptDecision,
          systemPrompt,
          { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching }
        )
      });
      await appendCompressionEvidence({
        events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIResponsesSurface.surface,
        policy: resolved.toolResultCompressionPolicy,
        originalBody: request.body,
        compressedBody: compression.body,
        forwardedBody,
        result: compression,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const forwardResult = await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        surface: openAIResponsesSurface.surface,
        provider: routedProvider(decision),
        harnessProfileId: context.harnessProfileId,
        body: forwardedBody,
        responseStream: requestWantsStream(request.body),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        attempts: providerAttempts,
        retryPolicy: decision.retryPolicy,
        acquireProviderLimit: (providerAttempt) => acquireTrafficLimitOrReject({
          trafficLimits,
          requestStates,
          reply,
          idempotencyKey,
          identity,
          context,
          providerAttempt
        }),
        timing,
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision)),
        compressionTelemetry: compressionForwardTelemetry(compression, resolved.toolResultCompressionPolicy),
        onAssistantText: assistantResponseCapture({
          identity,
          requestId,
          idempotencyKey,
          sessionId: context.sessionId,
          surface: openAIResponsesSurface.surface,
          transport: context.transport,
          harness: context.harness,
          harnessProfileId: context.harnessProfileId
        }),
        onTerminal: (terminal) => markModelTerminal(metrics, modelRequestsInFlight, requestMetrics, request, terminal.status, terminal.errorClass)
      });
      if (forwardResult === "rejected") {
        timing.log("rejected");
        return;
      }
      timing.log("completed");
    } catch (error) {
      timing.log("failed", { error: errorMessage(error) });
      await requestStates.finish(idempotencyKey, "failed", {
        requestId,
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    } finally {
      requestLimitLease?.release();
    }
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const timing = new RequestTiming(app.log, {
      surface: openAIChatSurface.surface,
      requestBodyBytes: requestBodySizeBytes(headerValue(request.headers, "content-length"), request.body)
    });
    timing.sampleEventLoopLag();
    const identity = await timing.measure("auth", () => auth.resolve(request.headers));
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
      openAIChatSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = openAIChatSurface.buildContext(request.body, lowerHeaders(request.headers));
    markModelStream(metrics, modelRequestsInFlight, requestMetrics, request, requestWantsStream(request.body));
    const context = contextForIdentity(rawContext, identity);
    const proposedRequestId = createId("request");
    const gate = await timing.measure("idempotency_claim", () => requestStates.begin(idempotencyKey, proposedRequestId, context));
    if (sendDuplicateRequest(gate, reply)) {
      timing.log("duplicate");
      return;
    }
    const requestId = gate.state.requestId ?? proposedRequestId;
    timing.addMetadata({
      requestId,
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId
    });

    let requestLimitLease: TrafficLimitLease | undefined;
    try {
      requestLimitLease = await acquireTrafficLimitOrReject({
        trafficLimits,
        requestStates,
        reply,
        idempotencyKey,
        identity,
        context
      });
      if (!requestLimitLease) {
        markModelErrorClass(requestMetrics, request, "traffic_limit");
        return;
      }
      await events.append({
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        scopeType: "request",
        scopeId: requestId,
        correlationId: requestId,
        idempotencyKey,
        actor: actorForIdentity(identity),
        producer: "proxy.surface.openai-chat",
        eventType: "proxy.request_received",
        payload: requestReceivedPayload(openAIChatSurface.surface, context, rawContext, identity)
      });
      const capturedArtifacts = await captureRequestArtifacts({
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        surface: openAIChatSurface.surface,
        body: request.body,
        transport: context.transport,
        harness: context.harness,
        harnessProfileId: context.harnessProfileId
      });
      await appendPromptCaptureEvent({
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIChatSurface.surface,
        transport: context.transport,
        harness: context.harness,
        harnessProfileId: context.harnessProfileId,
        artifacts: capturedArtifacts
      });

      const resolved = await resolveRoutingConfig(routingConfigs, identity);
      await appendTokensAttributed({
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIChatSurface.surface,
        body: request.body,
        orgSystemPrompt: resolved.systemPrompt,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const decision = await routing.decide({
        requestId,
        context,
        body: request.body,
        idempotencyKey,
        routingConfig: resolved.routingConfig
      });
      timing.recordDecision(decision);
      if (decision.outcome === "reject") {
        await requestStates.finish(idempotencyKey, "failed", { requestId, error: decision.error });
        markModelErrorClass(requestMetrics, request, "routing");
        sendRejectedDecision(decision, reply);
        return;
      }
      const compressionCacheWindow = await appendCompressionCacheWindowResolved({
        persistence,
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIChatSurface.surface,
        provider: routedProvider(decision),
        model: decision.selectedModel ?? "unknown",
        body: request.body,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });

      const compression = await compressForForwardWithResult({
        events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIChatSurface.surface,
        body: request.body,
        policy: resolved.toolResultCompressionPolicy,
        deduplicateToolResults: resolved.duplicateToolResultReferences,
        frozenPrefixItems: compressionCacheWindow.frozenPrefixItems,
        profile: harnessProfileByName(context.harness),
        artifactStore: persistence?.promptArtifacts,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const forwardedBody = rewriteSurfaceRequest(compression.body, decision, resolved.systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching });
      const providerAttempts = await buildProviderForwardAttempts({
        persistence,
        identity,
        body: compression.body,
        context,
        cacheSettings: { automaticCaching: resolved.automaticCaching, cacheTtlUpgrade: resolved.cacheTtlUpgrade },
        decision,
        rewrite: (attemptDecision) => rewriteSurfaceRequest(
          compression.body,
          attemptDecision,
          resolved.systemPrompt,
          { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching }
        )
      });
      await appendCompressionEvidence({
        events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIChatSurface.surface,
        policy: resolved.toolResultCompressionPolicy,
        originalBody: request.body,
        compressedBody: compression.body,
        forwardedBody,
        result: compression,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const forwardResult = await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        surface: openAIChatSurface.surface,
        provider: routedProvider(decision),
        harnessProfileId: context.harnessProfileId,
        body: forwardedBody,
        responseStream: requestWantsStream(request.body),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        attempts: providerAttempts,
        retryPolicy: decision.retryPolicy,
        acquireProviderLimit: (providerAttempt) => acquireTrafficLimitOrReject({
          trafficLimits,
          requestStates,
          reply,
          idempotencyKey,
          identity,
          context,
          providerAttempt
        }),
        timing,
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision)),
        compressionTelemetry: compressionForwardTelemetry(compression, resolved.toolResultCompressionPolicy),
        onAssistantText: assistantResponseCapture({
          identity,
          requestId,
          idempotencyKey,
          sessionId: context.sessionId,
          surface: openAIChatSurface.surface,
          transport: context.transport,
          harness: context.harness,
          harnessProfileId: context.harnessProfileId
        }),
        onTerminal: (terminal) => markModelTerminal(metrics, modelRequestsInFlight, requestMetrics, request, terminal.status, terminal.errorClass)
      });
      if (forwardResult === "rejected") {
        timing.log("rejected");
        return;
      }
      timing.log("completed");
    } catch (error) {
      timing.log("failed", { error: errorMessage(error) });
      await requestStates.finish(idempotencyKey, "failed", {
        requestId,
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    } finally {
      requestLimitLease?.release();
    }
  });

  app.post("/v1/messages", async (request, reply) => {
    const timing = new RequestTiming(app.log, {
      surface: anthropicMessagesSurface.surface,
      requestBodyBytes: requestBodySizeBytes(headerValue(request.headers, "content-length"), request.body)
    });
    timing.sampleEventLoopLag();
    const identity = await timing.measure("auth", () => auth.resolve(request.headers));
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
      anthropicMessagesSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = anthropicMessagesSurface.buildContext(request.body, lowerHeaders(request.headers));
    markModelStream(metrics, modelRequestsInFlight, requestMetrics, request, requestWantsStream(request.body));
    const context = contextForIdentity(rawContext, identity);
    const proposedRequestId = createId("request");
    const gate = await timing.measure("idempotency_claim", () => requestStates.begin(idempotencyKey, proposedRequestId, context));
    if (sendDuplicateRequest(gate, reply)) {
      timing.log("duplicate");
      return;
    }
    const requestId = gate.state.requestId ?? proposedRequestId;
    timing.addMetadata({
      requestId,
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId
    });

    let requestLimitLease: TrafficLimitLease | undefined;
    try {
      requestLimitLease = await acquireTrafficLimitOrReject({
        trafficLimits,
        requestStates,
        reply,
        idempotencyKey,
        identity,
        context
      });
      if (!requestLimitLease) {
        markModelErrorClass(requestMetrics, request, "traffic_limit");
        return;
      }
      await events.append({
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        scopeType: "request",
        scopeId: requestId,
        sessionId: context.sessionId,
        correlationId: requestId,
        idempotencyKey,
        actor: actorForIdentity(identity),
        producer: "proxy.surface.anthropic-messages",
        eventType: "proxy.request_received",
        payload: requestReceivedPayload("anthropic-messages", context, rawContext, identity)
      });
      const capturedArtifacts = await captureRequestArtifacts({
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        surface: anthropicMessagesSurface.surface,
        body: request.body,
        transport: context.transport,
        harness: context.harness,
        harnessProfileId: context.harnessProfileId
      });
      await appendPromptCaptureEvent({
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: anthropicMessagesSurface.surface,
        transport: context.transport,
        harness: context.harness,
        harnessProfileId: context.harnessProfileId,
        artifacts: capturedArtifacts
      });

      const resolved = await resolveRoutingConfig(routingConfigs, identity);
      const systemPrompt = await effectiveSystemPrompt(
        persistence,
        identity,
        anthropicMessagesSurface.surface,
        context.sessionId,
        resolved.systemPrompt
      );
      await appendTokensAttributed({
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: anthropicMessagesSurface.surface,
        body: request.body,
        orgSystemPrompt: systemPrompt,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const decision = await routing.decide({
        requestId,
        context,
        body: request.body,
        idempotencyKey,
        routingConfig: resolved.routingConfig
      });
      timing.recordDecision(decision);
      if (decision.outcome === "reject") {
        await requestStates.finish(idempotencyKey, "failed", { requestId, error: decision.error });
        markModelErrorClass(requestMetrics, request, "routing");
        sendRejectedDecision(decision, reply);
        return;
      }
      await pinSystemPrompt(persistence, identity, anthropicMessagesSurface.surface, requestId, context.sessionId, systemPrompt);
      const compressionCacheWindow = await appendCompressionCacheWindowResolved({
        persistence,
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: anthropicMessagesSurface.surface,
        provider: routedProvider(decision),
        model: decision.selectedModel ?? "unknown",
        body: request.body,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });

      const compression = await compressForForwardWithResult({
        events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: anthropicMessagesSurface.surface,
        body: request.body,
        policy: resolved.toolResultCompressionPolicy,
        deduplicateToolResults: resolved.duplicateToolResultReferences,
        frozenPrefixItems: compressionCacheWindow.frozenPrefixItems,
        profile: harnessProfileByName(context.harness),
        artifactStore: persistence?.promptArtifacts,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const forwardedBody = rewriteSurfaceRequest(compression.body, decision, systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching });
      const providerAttempts = await buildProviderForwardAttempts({
        persistence,
        identity,
        body: compression.body,
        context,
        cacheSettings: { automaticCaching: resolved.automaticCaching, cacheTtlUpgrade: resolved.cacheTtlUpgrade },
        decision,
        rewrite: (attemptDecision) => rewriteSurfaceRequest(
          compression.body,
          attemptDecision,
          systemPrompt,
          { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching }
        )
      });
      await appendCompressionEvidence({
        events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: anthropicMessagesSurface.surface,
        policy: resolved.toolResultCompressionPolicy,
        originalBody: request.body,
        compressedBody: compression.body,
        forwardedBody,
        result: compression,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const forwardResult = await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        surface: anthropicMessagesSurface.surface,
        provider: routedProvider(decision),
        harnessProfileId: context.harnessProfileId,
        body: forwardedBody,
        responseStream: requestWantsStream(request.body),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        attempts: providerAttempts,
        retryPolicy: decision.retryPolicy,
        acquireProviderLimit: (providerAttempt) => acquireTrafficLimitOrReject({
          trafficLimits,
          requestStates,
          reply,
          idempotencyKey,
          identity,
          context,
          providerAttempt
        }),
        timing,
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision)),
        compressionTelemetry: compressionForwardTelemetry(compression, resolved.toolResultCompressionPolicy),
        onAssistantText: assistantResponseCapture({
          identity,
          requestId,
          idempotencyKey,
          sessionId: context.sessionId,
          surface: anthropicMessagesSurface.surface,
          transport: context.transport,
          harness: context.harness,
          harnessProfileId: context.harnessProfileId
        }),
        onTerminal: (terminal) => markModelTerminal(metrics, modelRequestsInFlight, requestMetrics, request, terminal.status, terminal.errorClass)
      });
      if (forwardResult === "rejected") {
        timing.log("rejected");
        return;
      }
      timing.log("completed");
    } catch (error) {
      timing.log("failed", { error: errorMessage(error) });
      await requestStates.finish(idempotencyKey, "failed", {
        requestId,
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    } finally {
      requestLimitLease?.release();
    }
  });

  app.post("/v1/messages/count_tokens", async (request, reply) => {
    const timing = new RequestTiming(app.log, {
      surface: anthropicMessagesSurface.surface,
      requestBodyBytes: requestBodySizeBytes(headerValue(request.headers, "content-length"), request.body)
    });
    timing.sampleEventLoopLag();
    const identity = await timing.measure("auth", () => auth.resolve(request.headers));
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
      anthropicMessagesSurface.countTokensOperation ?? anthropicMessagesSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = anthropicMessagesSurface.buildContext(request.body, lowerHeaders(request.headers));
    markModelStream(metrics, modelRequestsInFlight, requestMetrics, request, false);
    const context = contextForIdentity(rawContext, identity);
    const proposedRequestId = createId("request");
    const gate = await timing.measure("idempotency_claim", () => requestStates.begin(idempotencyKey, proposedRequestId, context));
    if (sendDuplicateRequest(gate, reply)) {
      timing.log("duplicate");
      return;
    }
    const requestId = gate.state.requestId ?? proposedRequestId;
    timing.addMetadata({
      requestId,
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId
    });
    let requestLimitLease: TrafficLimitLease | undefined;
    try {
      requestLimitLease = await acquireTrafficLimitOrReject({
        trafficLimits,
        requestStates,
        reply,
        idempotencyKey,
        identity,
        context
      });
      if (!requestLimitLease) {
        markModelErrorClass(requestMetrics, request, "traffic_limit");
        return;
      }
      await events.append({
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        scopeType: "request",
        scopeId: requestId,
        sessionId: context.sessionId,
        correlationId: requestId,
        idempotencyKey,
        actor: actorForIdentity(identity),
        producer: "proxy.surface.anthropic-messages",
        eventType: "proxy.request_received",
        payload: requestReceivedPayload("anthropic-messages", context, rawContext, identity)
      });
      const resolved = await resolveRoutingConfig(routingConfigs, identity);
      const systemPrompt = await effectiveSystemPrompt(
        persistence,
        identity,
        anthropicMessagesSurface.surface,
        context.sessionId,
        resolved.systemPrompt
      );
      const decision = await routing.tokenCountDecision(context, resolved.routingConfig);
      timing.recordDecision(decision);
      if (decision.outcome === "reject") {
        await requestStates.finish(idempotencyKey, "failed", { requestId, error: decision.error });
        markModelErrorClass(requestMetrics, request, "routing");
        sendRejectedDecision(decision, reply);
        return;
      }

      // count_tokens applies the identical compression so the harness's token
      // count reflects what it will actually send — through the same guarded
      // path as /v1/messages so a throwing filter degrades identically — but
      // does not emit a compression.recorded event (that would double-count
      // against the paired /v1/messages call).
      let compressionFailed = false;
      const countCompression = compressOrFallback(
        anthropicMessagesSurface.surface,
        request.body,
        resolved.toolResultCompressionPolicy,
        (err, message) => {
          if (message === "tool result compression failed") compressionFailed = true;
          app.log.warn({ err, requestId }, message);
        },
        {
          deduplicateToolResults: resolved.duplicateToolResultReferences,
          profile: harnessProfileByName(context.harness)
        }
      );
      const forwardedBody = rewriteTokenCountRequest(countCompression.body, decision, systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade });
      const providerAttempts = await buildProviderForwardAttempts({
        persistence,
        identity,
        body: countCompression.body,
        context,
        cacheSettings: { automaticCaching: false, cacheTtlUpgrade: resolved.cacheTtlUpgrade },
        decision,
        rewrite: (attemptDecision) => rewriteTokenCountRequest(
          countCompression.body,
          attemptDecision,
          systemPrompt,
          { upgradeCacheTtl: resolved.cacheTtlUpgrade }
        )
      });
      await appendCompressionEvidence({
        events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: anthropicMessagesSurface.surface,
        policy: resolved.toolResultCompressionPolicy,
        originalBody: request.body,
        compressedBody: countCompression.body,
        forwardedBody,
        result: {
          ...countCompression,
          receiptIds: [],
          eventEmitFailed: false,
          compressionFailed
        },
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const forwardResult = await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        surface: anthropicMessagesSurface.surface,
        provider: routedProvider(decision),
        harnessProfileId: context.harnessProfileId,
        body: forwardedBody,
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        path: "/messages/count_tokens",
        attempts: providerAttempts,
        retryPolicy: decision.retryPolicy,
        acquireProviderLimit: (providerAttempt) => acquireTrafficLimitOrReject({
          trafficLimits,
          requestStates,
          reply,
          idempotencyKey,
          identity,
          context,
          providerAttempt
        }),
        timing,
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision)),
        compressionTelemetry: compressionForwardTelemetry({
          ...countCompression,
          receiptIds: [],
          eventEmitFailed: false,
          compressionFailed
        }, resolved.toolResultCompressionPolicy),
        onTerminal: (terminal) => markModelTerminal(metrics, modelRequestsInFlight, requestMetrics, request, terminal.status, terminal.errorClass)
      });
      if (forwardResult === "rejected") {
        timing.log("rejected");
        return;
      }
      timing.log("completed");
    } catch (error) {
      timing.log("failed", { error: errorMessage(error) });
      await requestStates.finish(idempotencyKey, "failed", {
        requestId,
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    } finally {
      requestLimitLease?.release();
    }
  });

  return app;
}

function routedProvider(decision: { provider?: Provider }) {
  if (!decision.provider) throw new Error("Missing routed provider.");
  return decision.provider;
}

function requestWantsStream(body: unknown) {
  return isRecord(body) && body.stream === true;
}

async function acquireTrafficLimitOrReject(input: {
  trafficLimits: TrafficLimitStore;
  requestStates: RequestStateStoreLike;
  reply: FastifyReply;
  idempotencyKey: string;
  identity: RequestIdentity;
  context: RouteContext;
  providerAttempt?: ProviderForwardAttemptInput;
}): Promise<TrafficLimitLease | undefined> {
  const stage = input.providerAttempt ? "provider_model" : "request";
  const result = input.trafficLimits.acquire({
    organizationId: input.identity.organizationId,
    workspaceId: input.identity.workspaceId,
    apiKeyId: input.identity.apiKeyId,
    userId: input.context.userId,
    provider: input.providerAttempt?.provider,
    model: input.providerAttempt?.selectedModel,
    estimatedTokens: input.context.estimatedInputTokens
  }, stage);
  if (result.allowed) return result.lease;

  await input.requestStates.finish(input.idempotencyKey, "failed", { error: result.error });
  sendTrafficLimitDenied(input.reply, result);
  return undefined;
}

function sendTrafficLimitDenied(reply: FastifyReply, result: TrafficLimitDenied) {
  if (result.retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(result.retryAfterSeconds));
  }
  reply.code(429).send({
    error: result.error,
    scope: result.scope,
    limit: result.limit,
    current: result.current
  });
}

async function buildProviderForwardAttempts(input: {
  persistence: AppPersistence | undefined;
  identity: RequestIdentity;
  body: unknown;
  context: RouteContext;
  cacheSettings: {
    automaticCaching: boolean;
    cacheTtlUpgrade: boolean;
  };
  decision: RouteDecision;
  rewrite: (decision: RouteDecision) => unknown;
}): Promise<ProviderForwardAttemptInput[]> {
  const maxAttempts = Math.max(1, input.decision.retryPolicy?.maxAttempts ?? 1);
  const attempts: ProviderForwardAttemptInput[] = [];
  let skippedUnavailableAccount = false;

  for (const candidate of candidateProviderAttempts(input.decision)) {
    const credential = await resolveUpstreamCredential(
      input.persistence,
      input.identity,
      candidate.provider,
      candidate.deployment.providerAccountId
    );
    if (candidate.deployment.providerAccountId && !credential) {
      skippedUnavailableAccount = true;
      continue;
    }

    const attemptDecision = decisionForProviderAttempt(input.decision, candidate);
    const promptCachePlan = computePromptCachePlan({
      body: input.body,
      context: input.context,
      decision: attemptDecision,
      capabilities: candidate.providerCachingCapabilities,
      settings: input.cacheSettings
    });
    attempts.push({
      route: candidate.route,
      routeCandidateId: candidate.routeCandidateId,
      selectedModel: candidate.selectedModel,
      provider: candidate.provider,
      adapterKind: candidate.adapterKind,
      deployment: candidate.deployment,
      reasoningEffort: candidate.reasoningEffort,
      body: input.rewrite(attemptDecision),
      credential,
      providerSettings: candidate.providerSettings,
      promptCachePlan
    });
  }

  const scopedAttempts = attempts.some((attempt) => attempt.credential)
    ? attempts.filter((attempt) => attempt.credential)
    : attempts;
  if (attempts.length === 0 && skippedUnavailableAccount) {
    throw new Error("deployment_provider_account_unavailable");
  }
  return scopedAttempts.slice(0, maxAttempts);
}

function candidateProviderAttempts(decision: RouteDecision): RouteProviderAttempt[] {
  if (decision.providerAttempts?.length) return decision.providerAttempts;
  if (
    !decision.finalRoute ||
    !decision.selectedModel ||
    !decision.provider ||
    !decision.deployment ||
    !decision.providerSettings
  ) {
    return [];
  }
  return [{
    route: decision.finalRoute,
    routeCandidateId: decision.routeExecutionPlan?.selected?.candidateId,
    selectedModel: decision.selectedModel,
    provider: decision.provider,
    adapterKind: decision.selectedAdapterKind,
    deployment: decision.deployment,
    reasoningEffort: decision.reasoningEffort,
    verbosity: decision.verbosity,
    providerSettings: decision.providerSettings
  }];
}

function decisionForProviderAttempt(decision: RouteDecision, attempt: RouteProviderAttempt): RouteDecision {
  return {
    ...decision,
    finalRoute: attempt.route,
    selectedModel: attempt.selectedModel,
    provider: attempt.provider,
    deployment: attempt.deployment,
    reasoningEffort: attempt.reasoningEffort,
    verbosity: attempt.verbosity,
    providerSettings: attempt.providerSettings
  };
}

function resolveUpstreamCredential(
  persistence: AppPersistence | undefined,
  identity: RequestIdentity,
  provider: Provider,
  providerAccountId?: string
) {
  if (!persistence) return undefined;
  if (providerAccountId) {
    return persistence.providerCredentials.resolveAccount({
      organizationId: identity.organizationId,
      provider,
      providerAccountId
    });
  }
  return persistence.providerCredentials.resolveForRequest({
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    apiKeyId: identity.apiKeyId,
    provider
  });
}

async function optionalIdentity(
  auth: ProxyAuthService,
  headers: Record<string, unknown>
) {
  try {
    return await auth.resolve(headers);
  } catch {
    return undefined;
  }
}

async function resolveRoutingConfig(
  routingConfigs: RoutingConfigResolverLike,
  identity: RequestIdentity
) {
  return resolveRoutingSelection(routingConfigs, {
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    routingConfigId: identity.routingConfigId
  });
}

async function effectiveSystemPrompt(
  persistence: AppPersistence | undefined,
  identity: RequestIdentity,
  surface: Surface,
  sessionId: string | undefined,
  systemPrompt: string | undefined
) {
  const pinned = await persistence?.sessionPrompts.resolve({
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    surface,
    sessionId
  });
  return pinned?.pinned ? pinned.systemPrompt : systemPrompt;
}

async function pinSystemPrompt(
  persistence: AppPersistence | undefined,
  identity: RequestIdentity,
  surface: Surface,
  requestId: string,
  sessionId: string | undefined,
  systemPrompt: string | undefined
) {
  await persistence?.sessionPrompts.pin({
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    surface,
    requestId,
    sessionId,
    systemPrompt
  });
}

async function appendCompressionCacheWindowResolved(input: {
  persistence: AppPersistence | undefined;
  events: EventService;
  identity: RequestIdentity;
  requestId: string;
  idempotencyKey: string;
  sessionId: string | undefined;
  surface: Surface;
  provider: Provider;
  model: string;
  body: unknown;
  warn: (err: unknown, message: string) => void;
}): Promise<CompressionCacheWindow> {
  let window: CompressionCacheWindow;
  try {
    window = await input.persistence?.compressionCacheWindows.resolve({
      organizationId: input.identity.organizationId,
      workspaceId: input.identity.workspaceId,
      sessionId: input.sessionId,
      surface: input.surface,
      provider: input.provider,
      model: input.model,
      body: input.body
    }) ?? noCompressionCacheWindow();
  } catch (error) {
    input.warn(error, "compression cache window resolution failed");
    return noCompressionCacheWindow();
  }

  try {
    await input.events.append({
      tenantId: input.identity.organizationId,
      workspaceId: input.identity.workspaceId,
      scopeType: "request",
      scopeId: input.requestId,
      sessionId: input.sessionId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      actor: actorForIdentity(input.identity),
      producer: "proxy.compression",
      eventType: "compression.cache_window_resolved",
      payload: {
        surface: input.surface,
        provider: input.provider,
        model: input.model,
        ...compressionCacheWindowEventPayload(window)
      }
    });
  } catch (error) {
    input.warn(error, "compression cache window event emit failed");
  }
  return window;
}

function requireAuth(headers: Record<string, unknown>, token: string) {
  if (!token) {
    const error = new Error("Unauthorized");
    (error as Error & { statusCode: number }).statusCode = 401;
    throw error;
  }
  const auth = headerValue(headers, "authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : auth;
  const apiKey = headerValue(headers, "x-api-key") ?? "";
  if (bearer !== token && apiKey !== token) {
    const error = new Error("Unauthorized");
    (error as Error & { statusCode: number }).statusCode = 401;
    throw error;
  }
}

function compressionRetrieveBody(body: unknown):
  | { ok: true; retrievalId: string; query?: string }
  | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: "Request body must be a JSON object." };
  if (typeof body.retrievalId !== "string" || !/^cmp_[a-f0-9]{32}$/.test(body.retrievalId)) {
    return { ok: false, message: "retrievalId must be a cmp_ retrieval id." };
  }
  if (body.query !== undefined && typeof body.query !== "string") {
    return { ok: false, message: "query must be a string when provided." };
  }
  return body.query === undefined
    ? { ok: true, retrievalId: body.retrievalId }
    : { ok: true, retrievalId: body.retrievalId, query: body.query };
}

function compressionRetrievalFailureStatus(reason: CompressionRetrievalFailureReason) {
  if (reason === "not_found") return 404;
  if (reason === "artifact_expired") return 410;
  return 409;
}

function compressionRetrievalFailureMessage(reason: CompressionRetrievalFailureReason) {
  switch (reason) {
    case "not_found":
      return "Compression retrieval id was not found.";
    case "artifact_missing":
      return "Compression original artifact is missing.";
    case "artifact_expired":
      return "Compression original artifact has expired.";
    case "artifact_unavailable":
      return "Compression original content is unavailable.";
    case "hash_mismatch":
      return "Compression original content failed integrity verification.";
    default:
      return "Compression retrieval failed.";
  }
}

function compressionRetrievalEventPayload(
  metadata: CompressionRetrievalMetadata,
  status: "retrieved" | "failed",
  failureReason?: CompressionRetrievalFailureReason
) {
  return {
    retrievalId: metadata.retrievalId,
    receiptId: metadata.receiptId,
    requestId: metadata.requestId,
    surface: metadata.surface,
    blockPath: metadata.blockPath,
    toolName: metadata.toolName,
    ruleId: metadata.ruleId,
    ruleVersion: metadata.ruleVersion,
    status,
    receiptStatus: metadata.receiptStatus,
    failureReason: failureReason ?? null
  };
}

function sendDuplicateRequest(
  gate: RequestStateGate,
  reply: FastifyReply
) {
  if (!gate.duplicate) return false;

  reply.code(409).send({
    error: "Duplicate request is still active.",
    status: gate.state.status
  });
  return true;
}

function sendRejectedDecision(decision: RouteDecision, reply: FastifyReply) {
  reply.code(decision.errorStatus ?? 400).send({
    error: decision.error,
    message: decision.errorMessage ?? decision.error,
    details: decision.errorDetails ?? undefined
  });
}

type RequestMetricsState = {
  startedAtMs: number;
  routeFamily: string;
  surface?: Surface;
  stream: string;
  inFlightStream: string;
  errorClass?: string;
  terminalStatus?: string;
  inFlightClosed?: boolean;
  modelRecorded?: boolean;
};

function requestMetricsState(config: AppConfig, request: FastifyRequest): RequestMetricsState {
  const path = requestPath(request.url);
  return {
    startedAtMs: performance.now(),
    routeFamily: routeFamilyForPath(config, path),
    surface: modelSurfaceForPath(path),
    stream: "unknown",
    inFlightStream: "unknown"
  };
}

function markModelStream(
  metrics: MetricsCollector,
  inFlight: Map<string, { labels: Record<string, string>; value: number }>,
  requestMetrics: WeakMap<FastifyRequest, RequestMetricsState>,
  request: FastifyRequest,
  stream: boolean
) {
  const state = requestMetrics.get(request);
  if (!state?.surface) return;

  const nextStream = stream ? "true" : "false";
  state.stream = nextStream;
  if (state.inFlightStream === nextStream) return;

  adjustModelRequestsInFlight(metrics, inFlight, state, -1);
  state.inFlightStream = nextStream;
  adjustModelRequestsInFlight(metrics, inFlight, state, 1);
}

function markModelErrorClass(
  requestMetrics: WeakMap<FastifyRequest, RequestMetricsState>,
  request: FastifyRequest,
  errorClass: string
) {
  const state = requestMetrics.get(request);
  if (state?.surface) state.errorClass = errorClass;
}

function markModelTerminal(
  metrics: MetricsCollector,
  inFlight: Map<string, { labels: Record<string, string>; value: number }>,
  requestMetrics: WeakMap<FastifyRequest, RequestMetricsState>,
  request: FastifyRequest,
  status: "completed" | "failed" | "cancelled",
  errorClass: string
) {
  const state = requestMetrics.get(request);
  if (!state?.surface) return;

  const terminalStatus = metricTerminalStatusFor(status);
  state.terminalStatus = terminalStatus;
  state.errorClass = errorClass;
  finishModelRequestMetrics(metrics, inFlight, state, terminalStatus, errorClass);
}

function requestPath(url: string) {
  return url.split("?")[0] || "/";
}

function routeFamilyForPath(config: AppConfig, path: string) {
  if (path === "/healthz") return "health";
  if (path === config.metricsPath) return "metrics";
  if (path === "/admin/graphql") return "graphql";
  if (path.startsWith("/admin") || path.startsWith("/api") || path.startsWith("/_debug") || path === "/setup.sh") return "admin";
  if (path === "/v1/compression/retrieve") return "compression";
  if (path === "/v1/messages" || path === "/v1/messages/count_tokens") return "anthropic";
  if (path.startsWith("/v1/")) return "openai";
  return "unknown";
}

function modelSurfaceForPath(path: string): Surface | undefined {
  if (path === "/v1/responses") return openAIResponsesSurface.surface;
  if (path === "/v1/chat/completions") return openAIChatSurface.surface;
  if (path === "/v1/messages" || path === "/v1/messages/count_tokens") return anthropicMessagesSurface.surface;
  return undefined;
}

function adjustModelRequestsInFlight(
  metrics: MetricsCollector,
  inFlight: Map<string, { labels: Record<string, string>; value: number }>,
  state: RequestMetricsState,
  delta: number
) {
  if (!state.surface) return;
  const labels = { surface: state.surface, stream: state.inFlightStream };
  const key = JSON.stringify(labels);
  const current = inFlight.get(key) ?? { labels, value: 0 };
  const next = Math.max(0, current.value + delta);
  inFlight.set(key, { labels, value: next });
  metrics.setGauge("proxy_model_requests_in_flight", next, labels);
}

function finishModelRequestMetrics(
  metrics: MetricsCollector,
  inFlight: Map<string, { labels: Record<string, string>; value: number }>,
  state: RequestMetricsState,
  terminalStatus: string,
  errorClass: string
) {
  if (!state.surface) return;
  if (!state.inFlightClosed) {
    adjustModelRequestsInFlight(metrics, inFlight, state, -1);
    state.inFlightClosed = true;
  }
  if (state.modelRecorded) return;

  const durationSeconds = (performance.now() - state.startedAtMs) / 1000;
  metrics.incrementCounter("proxy_model_requests_total", {
    surface: state.surface,
    stream: state.stream,
    terminal_status: terminalStatus,
    error_class: errorClass
  });
  metrics.observeHistogram("proxy_model_request_duration_seconds", durationSeconds, {
    surface: state.surface,
    stream: state.stream,
    terminal_status: terminalStatus
  });
  state.modelRecorded = true;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isBodyLimitError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.statusCode === 413 || candidate.code === "FST_ERR_CTP_BODY_TOO_LARGE";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const metrics = createMetricsCollector(config);
  const persistence = config.databaseUrl
    ? createPostgresPersistence(config.databaseUrl, config, metrics)
    : undefined;
  const app = buildServer(config, { persistence, metrics });
  await app.listen({ port: config.port, host: "0.0.0.0" });
  // Heal historical ledger rows: first fold legacy exclusive-shape cache
  // counts into input/total, then reprice rows that booked $0 before their
  // model's rate existed — in that order, so repricing sees healed tokens.
  if (persistence) {
    scheduleDailyModelCatalogRefresh(persistence.modelCatalogRefresh, app.log);
    void persistence
      .normalizeLegacyCachedUsage()
      .then(
        (healed) => {
          if (healed > 0) app.log.info({ healed }, "normalized legacy cached-usage ledger rows");
        },
        (error) => app.log.warn({ err: error }, "legacy cached-usage normalization failed")
      )
      .then(() => persistence.repriceZeroCostUsage())
      .then(
        (repriced) => {
          if (repriced > 0) app.log.info({ repriced }, "repriced zero-cost usage ledger rows");
        },
        (error) => app.log.warn({ err: error }, "zero-cost usage repricing failed")
      );
  }
}
