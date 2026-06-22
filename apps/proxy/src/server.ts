import { performance } from "node:perf_hooks";

import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { AdminAuthService } from "./adminAuth.js";
import { registerAdminEventStream } from "./adminEvents.js";
import {
  anthropicMessagesSurface,
  openAIChatSurface,
  openAIResponsesSurface,
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
import { DefaultRoutingConfigResolver } from "./defaultRoutingConfig.js";
import { LlmClassifier } from "./classifier.js";
import { EmailService } from "./email.js";
import { EventService, ProviderAttemptStore, RequestStateStore, type RequestStateGate } from "./events.js";
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
import { SessionRouteStore } from "./policy.js";
import { createPostgresPersistence } from "./persistence/index.js";
import { ConfigProviderRegistry } from "./persistence/providers.js";
import { resolveRoutingSelection, type RoutingConfigResolverLike } from "./persistence/routingConfig.js";
import { modelDiscoveryResponse } from "./modelDiscovery.js";
import { appendPromptCaptureEvent } from "./promptCaptureEvents.js";
import { ProjectionService } from "./projections.js";
import { appendTokensAttributed } from "./tokenAttribution.js";
import {
  appendCompressionEvidence,
  compressionForwardTelemetry,
  compressForForwardWithResult,
  compressOrFallback
} from "./toolResultCompression.js";
import { ProviderProxy } from "./proxy.js";
import { RoutingService } from "./router.js";
import { buildSetupScript } from "./setupScript.js";
import type { Provider, RouteDecision, Surface } from "./types.js";
import { createId, headerValue, idempotencyFrom, isRecord, lowerHeaders } from "./util.js";
import { WebSocketRoutingProxy } from "./wsProxy.js";

type AppPersistence = ReturnType<typeof createPostgresPersistence>;

export function buildServer(config: AppConfig = loadConfig(), options: { persistence?: AppPersistence; metrics?: MetricsCollector } = {}) {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 1024 * 1024 * 50
  });
  const metrics = options.metrics ?? createMetricsCollector(config);
  metrics.setGauge("prompt_proxy_up", 1);
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
    metrics.incrementCounter("prompt_proxy_http_requests_total", {
      route_family: state.routeFamily,
      method: request.method,
      status_class: statusClass,
      error_class: errorClass
    });
    metrics.observeHistogram("prompt_proxy_http_request_duration_seconds", durationSeconds, {
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
  metrics.setGauge("prompt_proxy_persistence_enabled", persistence ? 1 : 0);
  const routingConfigs = persistence?.routingConfigs ?? new DefaultRoutingConfigResolver(config);
  const events = new EventService(
    config.eventStorePath,
    undefined,
    persistence?.eventSink,
    config.defaultOrganizationId,
    metrics
  );
  const auth = new ProxyAuthService(config, persistence?.apiKeys);
  const adminAuth = new AdminAuthService(config, persistence?.adminSessions);
  const attempts = new ProviderAttemptStore();
  const requestStates = persistence?.requestStates ?? new RequestStateStore();
  const sessions = new SessionRouteStore(persistence?.sessionPins);
  const classifier = new LlmClassifier(config, metrics);
  const providerRegistry = persistence?.providerRegistry ?? new ConfigProviderRegistry(config);
  const routing = new RoutingService(
    config,
    classifier,
    events,
    sessions,
    providerRegistry,
    persistence?.providerCredentials,
    metrics
  );
  const proxy = new ProviderProxy(config, events, attempts, requestStates, providerRegistry, metrics);
  const assistantResponseCapture = (input: {
    identity: RequestIdentity;
    requestId: string;
    idempotencyKey: string;
    sessionId?: string;
    surface: Surface;
  }) => {
    if (!persistence) return undefined;
    return async (text: string, truncated: boolean) => {
      try {
        const artifacts = await persistence.promptArtifacts.captureResponse({
          organizationId: input.identity.organizationId,
          workspaceId: input.identity.workspaceId,
          requestId: input.requestId,
          surface: input.surface,
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
    const identity = await auth.resolve(request.headers);
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
      openAIResponsesSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = openAIResponsesSurface.buildContext(request.body, lowerHeaders(request.headers));
    markModelStream(metrics, modelRequestsInFlight, requestMetrics, request, requestWantsStream(request.body));
    const context = contextForIdentity(rawContext, identity);
    const proposedRequestId = createId("request");
    const gate = await requestStates.begin(idempotencyKey, proposedRequestId, context);
    if (sendDuplicateRequest(gate, reply)) return;
    const requestId = gate.state.requestId ?? proposedRequestId;

    try {
      await events.append({
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        scopeType: "request",
        scopeId: requestId,
        correlationId: requestId,
        idempotencyKey,
        actor: actorForIdentity(identity),
        producer: "prompt-proxy.surface.openai-responses",
        eventType: "proxy.request_received",
        payload: requestReceivedPayload("openai-responses", context, rawContext, identity)
      });
      const capturedArtifacts = await persistence?.promptArtifacts.capture({
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        surface: openAIResponsesSurface.surface,
        body: request.body
      }) ?? [];
      await appendPromptCaptureEvent({
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIResponsesSurface.surface,
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
      if (decision.outcome === "reject") {
        await requestStates.finish(idempotencyKey, "failed", { requestId, error: decision.error });
        markModelErrorClass(requestMetrics, request, "routing");
        sendRejectedDecision(decision, reply);
        return;
      }
      await pinSystemPrompt(persistence, identity, openAIResponsesSurface.surface, requestId, context.sessionId, systemPrompt);

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
        profile: harnessProfileByName(context.harness),
        artifactStore: persistence?.promptArtifacts,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const forwardedBody = rewriteSurfaceRequest(compression.body, decision, systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching });
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
      await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        surface: openAIResponsesSurface.surface,
        provider: routedProvider(decision),
        body: forwardedBody,
        responseStream: requestWantsStream(request.body),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision)),
        compressionTelemetry: compressionForwardTelemetry(compression, resolved.toolResultCompressionPolicy),
        onAssistantText: assistantResponseCapture({
          identity,
          requestId,
          idempotencyKey,
          sessionId: context.sessionId,
          surface: openAIResponsesSurface.surface
        }),
        onTerminal: (terminal) => markModelTerminal(metrics, modelRequestsInFlight, requestMetrics, request, terminal.status, terminal.errorClass)
      });
    } catch (error) {
      await requestStates.finish(idempotencyKey, "failed", {
        requestId,
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    }
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const identity = await auth.resolve(request.headers);
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
      openAIChatSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = openAIChatSurface.buildContext(request.body, lowerHeaders(request.headers));
    markModelStream(metrics, modelRequestsInFlight, requestMetrics, request, requestWantsStream(request.body));
    const context = contextForIdentity(rawContext, identity);
    const proposedRequestId = createId("request");
    const gate = await requestStates.begin(idempotencyKey, proposedRequestId, context);
    if (sendDuplicateRequest(gate, reply)) return;
    const requestId = gate.state.requestId ?? proposedRequestId;

    try {
      await events.append({
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        scopeType: "request",
        scopeId: requestId,
        correlationId: requestId,
        idempotencyKey,
        actor: actorForIdentity(identity),
        producer: "prompt-proxy.surface.openai-chat",
        eventType: "proxy.request_received",
        payload: requestReceivedPayload(openAIChatSurface.surface, context, rawContext, identity)
      });
      const capturedArtifacts = await persistence?.promptArtifacts.capture({
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        surface: openAIChatSurface.surface,
        body: request.body
      }) ?? [];
      await appendPromptCaptureEvent({
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIChatSurface.surface,
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
      if (decision.outcome === "reject") {
        await requestStates.finish(idempotencyKey, "failed", { requestId, error: decision.error });
        markModelErrorClass(requestMetrics, request, "routing");
        sendRejectedDecision(decision, reply);
        return;
      }

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
        profile: harnessProfileByName(context.harness),
        artifactStore: persistence?.promptArtifacts,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const forwardedBody = rewriteSurfaceRequest(compression.body, decision, resolved.systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching });
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
      await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        surface: openAIChatSurface.surface,
        provider: routedProvider(decision),
        body: forwardedBody,
        responseStream: requestWantsStream(request.body),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision)),
        compressionTelemetry: compressionForwardTelemetry(compression, resolved.toolResultCompressionPolicy),
        onAssistantText: assistantResponseCapture({
          identity,
          requestId,
          idempotencyKey,
          sessionId: context.sessionId,
          surface: openAIChatSurface.surface
        }),
        onTerminal: (terminal) => markModelTerminal(metrics, modelRequestsInFlight, requestMetrics, request, terminal.status, terminal.errorClass)
      });
    } catch (error) {
      await requestStates.finish(idempotencyKey, "failed", {
        requestId,
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    }
  });

  app.post("/v1/messages", async (request, reply) => {
    const identity = await auth.resolve(request.headers);
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
      anthropicMessagesSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = anthropicMessagesSurface.buildContext(request.body, lowerHeaders(request.headers));
    markModelStream(metrics, modelRequestsInFlight, requestMetrics, request, requestWantsStream(request.body));
    const context = contextForIdentity(rawContext, identity);
    const proposedRequestId = createId("request");
    const gate = await requestStates.begin(idempotencyKey, proposedRequestId, context);
    if (sendDuplicateRequest(gate, reply)) return;
    const requestId = gate.state.requestId ?? proposedRequestId;

    try {
      await events.append({
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        scopeType: "request",
        scopeId: requestId,
        sessionId: context.sessionId,
        correlationId: requestId,
        idempotencyKey,
        actor: actorForIdentity(identity),
        producer: "prompt-proxy.surface.anthropic-messages",
        eventType: "proxy.request_received",
        payload: requestReceivedPayload("anthropic-messages", context, rawContext, identity)
      });
      const capturedArtifacts = await persistence?.promptArtifacts.capture({
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        surface: anthropicMessagesSurface.surface,
        body: request.body
      }) ?? [];
      await appendPromptCaptureEvent({
        events,
        identity,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: anthropicMessagesSurface.surface,
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
      if (decision.outcome === "reject") {
        await requestStates.finish(idempotencyKey, "failed", { requestId, error: decision.error });
        markModelErrorClass(requestMetrics, request, "routing");
        sendRejectedDecision(decision, reply);
        return;
      }
      await pinSystemPrompt(persistence, identity, anthropicMessagesSurface.surface, requestId, context.sessionId, systemPrompt);

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
        profile: harnessProfileByName(context.harness),
        artifactStore: persistence?.promptArtifacts,
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      const forwardedBody = rewriteSurfaceRequest(compression.body, decision, systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching });
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
      await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        surface: anthropicMessagesSurface.surface,
        provider: routedProvider(decision),
        body: forwardedBody,
        responseStream: requestWantsStream(request.body),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision)),
        compressionTelemetry: compressionForwardTelemetry(compression, resolved.toolResultCompressionPolicy),
        onAssistantText: assistantResponseCapture({
          identity,
          requestId,
          idempotencyKey,
          sessionId: context.sessionId,
          surface: anthropicMessagesSurface.surface
        }),
        onTerminal: (terminal) => markModelTerminal(metrics, modelRequestsInFlight, requestMetrics, request, terminal.status, terminal.errorClass)
      });
    } catch (error) {
      await requestStates.finish(idempotencyKey, "failed", {
        requestId,
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    }
  });

  app.post("/v1/messages/count_tokens", async (request, reply) => {
    const identity = await auth.resolve(request.headers);
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
      anthropicMessagesSurface.countTokensOperation ?? anthropicMessagesSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = anthropicMessagesSurface.buildContext(request.body, lowerHeaders(request.headers));
    markModelStream(metrics, modelRequestsInFlight, requestMetrics, request, false);
    const context = contextForIdentity(rawContext, identity);
    const proposedRequestId = createId("request");
    const gate = await requestStates.begin(idempotencyKey, proposedRequestId, context);
    if (sendDuplicateRequest(gate, reply)) return;
    const requestId = gate.state.requestId ?? proposedRequestId;
    try {
      await events.append({
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        scopeType: "request",
        scopeId: requestId,
        sessionId: context.sessionId,
        correlationId: requestId,
        idempotencyKey,
        actor: actorForIdentity(identity),
        producer: "prompt-proxy.surface.anthropic-messages",
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
      await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        surface: anthropicMessagesSurface.surface,
        provider: routedProvider(decision),
        body: forwardedBody,
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        path: "/messages/count_tokens",
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision)),
        compressionTelemetry: compressionForwardTelemetry({
          ...countCompression,
          receiptIds: [],
          eventEmitFailed: false,
          compressionFailed
        }, resolved.toolResultCompressionPolicy),
        onTerminal: (terminal) => markModelTerminal(metrics, modelRequestsInFlight, requestMetrics, request, terminal.status, terminal.errorClass)
      });
    } catch (error) {
      await requestStates.finish(idempotencyKey, "failed", {
        requestId,
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
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

function resolveUpstreamCredential(
  persistence: AppPersistence | undefined,
  identity: RequestIdentity,
  provider: Provider
) {
  if (!persistence) return undefined;
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
  metrics.setGauge("prompt_proxy_model_requests_in_flight", next, labels);
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
  metrics.incrementCounter("prompt_proxy_model_requests_total", {
    surface: state.surface,
    stream: state.stream,
    terminal_status: terminalStatus,
    error_class: errorClass
  });
  metrics.observeHistogram("prompt_proxy_model_request_duration_seconds", durationSeconds, {
    surface: state.surface,
    stream: state.stream,
    terminal_status: terminalStatus
  });
  state.modelRecorded = true;
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
