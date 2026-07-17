import { performance } from "node:perf_hooks";

import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { AdminAuthService } from "./adminAuth.js";
import { registerAdminEventStream } from "./adminEvents.js";
import {
  anthropicMessagesSurface,
  openAIChatSurface,
  openAIResponsesSurface,
  type SurfaceAdapter
} from "./adapters.js";
import {
  actorForIdentity,
  contextForIdentity,
  ProxyAuthService,
  scopedIdempotencyKey,
  type RequestIdentity
} from "./auth.js";
import { sendGatewayError } from "./apiWireErrors.js";
import { loadConfig, type AppConfig } from "./config.js";
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
import { GatewayRequestLifecycle } from "./gatewayRequestLifecycle.js";
import {
  createMetricsCollector,
  metricErrorClassForStatus,
  metricStatusClassFor,
  metricTerminalStatusFor,
  type MetricsCollector
} from "./metrics.js";
import { AsyncObservabilityEventAppender } from "./observability.js";
import { createPostgresPersistence } from "./persistence/index.js";
import type {
  CompressionRetrievalFailureReason,
  CompressionRetrievalMetadata
} from "./persistence/compressionReceipts.js";
import { appendPromptCaptureEvent } from "./promptCaptureEvents.js";
import { ProjectionService } from "./projections.js";
import { ProviderProxy } from "./proxy.js";
import { RequestTiming, requestBodySizeBytes } from "./requestTiming.js";
import { buildSetupScript } from "./setupScript.js";
import { TrafficLimitStore, type TrafficLimitDenied, type TrafficLimitLease } from "./trafficLimits.js";
import type { RouteContext, Surface } from "./types.js";
import { createId, headerValue, idempotencyFrom, isRecord, lowerHeaders } from "./util.js";
import { WebSocketRoutingProxy } from "./wsProxy.js";
import {
  GatewayRuntime,
  type GatewayExecutionTarget
} from "./gatewayRuntime.js";
import {
  GATEWAY_MODEL_ENDPOINTS,
  type GatewayModelEndpoint,
  type GatewayOperationId
} from "@proxy/schema";

type AppPersistence = ReturnType<typeof createPostgresPersistence>;
type HttpGatewayModelEndpoint = Extract<GatewayModelEndpoint, { transport: "http" }>;

const persistentProviderAttemptMirrorLimit = 10_000;
const modelsEndpoint = httpGatewayModelEndpoint(GATEWAY_MODEL_ENDPOINTS.models);
const responsesEndpoint = httpGatewayModelEndpoint(GATEWAY_MODEL_ENDPOINTS.responsesHttp);
const chatCompletionsEndpoint = httpGatewayModelEndpoint(GATEWAY_MODEL_ENDPOINTS.chatCompletions);
const messagesEndpoint = httpGatewayModelEndpoint(GATEWAY_MODEL_ENDPOINTS.messages);
const countTokensEndpoint = httpGatewayModelEndpoint(GATEWAY_MODEL_ENDPOINTS.countTokens);

export function buildServer(config: AppConfig = loadConfig(), options: { persistence?: AppPersistence; metrics?: MetricsCollector } = {}) {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.requestBodyLimitBytes
  });
  app.setErrorHandler((error, request, reply) => {
    const surface = modelSurfaceForPath(requestPath(request.url));
    if (surface) {
      const bodyLimit = isBodyLimitError(error);
      const status = bodyLimit ? 413 : errorStatusCode(error);
      sendGatewayError(
        surface,
        reply,
        status,
        gatewayTransportErrorCode(status, bodyLimit),
        gatewayTransportErrorMessage(error, status, bodyLimit),
        bodyLimit ? { limitBytes: config.requestBodyLimitBytes } : undefined
      );
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
  const gatewayRuntime = persistence
    ? new GatewayRuntime(persistence.modelResolution, persistence.providerConnectionRuntimeTargets)
    : undefined;
  metrics.setGauge("proxy_persistence_enabled", persistence ? 1 : 0);
  const events = persistence?.eventService ?? new EventService(
    config.eventStorePath,
    undefined,
    undefined,
    config.defaultOrganizationId,
    metrics
  );
  const auth = new ProxyAuthService(config, persistence?.apiKeys);
  const adminAuth = new AdminAuthService(config, persistence?.adminSessions);
  const attempts = new ProviderAttemptStore({
    maxAttempts: persistence ? persistentProviderAttemptMirrorLimit : undefined
  });
  const requestStates = persistence?.requestStates ?? new RequestStateStore();
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
  const observabilityEvents = new AsyncObservabilityEventAppender(events, observabilityWriter);
  const gatewayLifecycle = new GatewayRequestLifecycle(
    gatewayRuntime,
    observabilityEvents,
    attempts,
    requestStates,
    metrics,
    {
      promptArtifacts: persistence?.promptArtifacts,
      organizationSettings: persistence?.organizationSettings,
      sessionPrompts: persistence?.sessionPrompts,
      compressionCacheWindows: persistence?.compressionCacheWindows,
      warn: (error, message) => app.log.warn({ err: error }, message)
    }
  );
  app.addHook("onClose", async () => {
    const stats = await observabilityWriter.drain(config.eventWriterShutdownTimeoutMs);
    if (stats.depth > 0) {
      app.log.warn({ stats }, "observability event writer shutdown drain timed out");
    }
  });
  const trafficLimits = new TrafficLimitStore(config.trafficLimits);
  const proxy = new ProviderProxy(
    config,
    observabilityEvents,
    attempts,
    gatewayLifecycle,
    metrics
  );
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
    auth,
    gatewayLifecycle,
    events,
    requestStates,
    trafficLimits,
    persistence?.promptArtifacts
  );
  const projections = new ProjectionService();
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

  app.route({
    method: modelsEndpoint.method,
    url: modelsEndpoint.path,
    handler: async (request, reply) => {
      const identity = await auth.resolve(request.headers);
      if (!gatewayRuntime) {
        reply.code(503).send({ error: "gateway_runtime_unavailable" });
        return;
      }
      const models = await gatewayRuntime.listModels(identity);
      return {
        object: "list",
        data: models.map((model) => ({
          id: model.slug,
          object: "model",
          created: Math.floor(model.createdAt.getTime() / 1000),
          owned_by: "proxy",
          display_name: model.name,
          description: model.description
        }))
      };
    }
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
    app.get("/_debug/projections", async (request) => {
      requireAuth(request.headers, config.proxyToken);
      return projections.usage(events.listEvents());
    });
    app.get("/_debug/route-quality", async (request) => {
      requireAuth(request.headers, config.proxyToken);
      return projections.routeQuality(events.listEvents());
    });
  }
  const handleGatewayTextRequest = async (input: {
    request: FastifyRequest;
    reply: FastifyReply;
    surface: SurfaceAdapter;
    operationId: GatewayOperationId;
    upstreamPath?: string;
  }) => {
    const timing = new RequestTiming(app.log, {
      surface: input.surface.surface,
      requestBodyBytes: requestBodySizeBytes(
        headerValue(input.request.headers, "content-length"),
        input.request.body
      )
    });
    timing.sampleEventLoopLag();
    const identity = await timing.measure("auth", () => auth.resolve(input.request.headers));
    const rawContext = input.surface.buildContext(
      input.request.body,
      lowerHeaders(input.request.headers)
    );
    const context = contextForIdentity(rawContext, identity);
    const idempotencyKey = scopedIdempotencyKey(
      identity.organizationId,
      identity.workspaceId,
      idempotencyFrom(
        input.operationId === "text.count_tokens"
          ? input.surface.countTokensOperation ?? input.surface.createOperation
          : input.surface.createOperation,
        input.request.body,
        input.request.headers
      )
    );
    markModelStream(
      metrics,
      modelRequestsInFlight,
      requestMetrics,
      input.request,
      input.operationId === "text.generate" && requestWantsStream(input.request.body)
    );
    const proposedRequestId = createId("request");
    const gate = await timing.measure(
      "idempotency_claim",
      () => requestStates.begin(idempotencyKey, proposedRequestId, context)
    );
    if (sendDuplicateRequest(gate, input.reply, input.surface.surface)) {
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
        reply: input.reply,
        surface: input.surface.surface,
        idempotencyKey,
        identity,
        context
      });
      if (!requestLimitLease) {
        markModelErrorClass(requestMetrics, input.request, "traffic_limit");
        return;
      }
      const prepared = await timing.measure("gateway_prepare", () => gatewayLifecycle.prepare({
        identity,
        rawContext,
        context,
        requestId,
        idempotencyKey,
        surface: input.surface,
        operationId: input.operationId,
        body: input.request.body
      }));
      if (prepared.outcome === "denied") {
        markModelErrorClass(requestMetrics, input.request, "model_resolution");
        sendGatewayError(
          input.surface.surface,
          input.reply,
          prepared.status,
          prepared.code
        );
        timing.log("rejected");
        return;
      }

      const { decision } = prepared;
      timing.recordDecision(decision);
      const forwardResult = await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        sessionId: context.sessionId,
        surface: input.surface.surface,
        harnessProfileId: context.harnessProfileId,
        responseStream: input.operationId === "text.generate" &&
          requestWantsStream(input.request.body),
        headers: lowerHeaders(input.request.headers),
        reply: input.reply,
        path: input.upstreamPath,
        prepared,
        identity,
        context,
        acquireProviderLimit: (providerTarget) => acquireTrafficLimitOrReject({
          trafficLimits,
          requestStates,
          reply: input.reply,
          surface: input.surface.surface,
          idempotencyKey,
          identity,
          context,
          providerTarget
        }),
        onAssistantText: input.operationId === "text.generate"
          ? assistantResponseCapture({
              identity,
              requestId,
              idempotencyKey,
              sessionId: context.sessionId,
              surface: input.surface.surface,
              transport: context.transport,
              harness: context.harness,
              harnessProfileId: context.harnessProfileId
            })
          : undefined,
        timing,
        onTerminal: (terminal) => markModelTerminal(
          metrics,
          modelRequestsInFlight,
          requestMetrics,
          input.request,
          terminal.status,
          terminal.errorClass
        )
      });
      timing.log(forwardResult === "rejected" ? "rejected" : "completed");
    } catch (error) {
      timing.log("failed", { error: errorMessage(error) });
      await requestStates.finish(idempotencyKey, "failed", {
        requestId,
        error: error instanceof Error ? error.message : "Request failed."
      });
      if (!input.reply.sent) {
        markModelErrorClass(requestMetrics, input.request, "gateway");
        sendGatewayError(
          input.surface.surface,
          input.reply,
          502,
          error instanceof Error ? error.message : "gateway_request_failed"
        );
      }
    } finally {
      requestLimitLease?.release();
    }
  };

  app.route({
    method: responsesEndpoint.method,
    url: responsesEndpoint.path,
    handler: (request, reply) => handleGatewayTextRequest({
      request,
      reply,
      surface: openAIResponsesSurface,
      operationId: responsesEndpoint.operationId
    })
  });

  app.route({
    method: chatCompletionsEndpoint.method,
    url: chatCompletionsEndpoint.path,
    handler: (request, reply) => handleGatewayTextRequest({
      request,
      reply,
      surface: openAIChatSurface,
      operationId: chatCompletionsEndpoint.operationId
    })
  });

  app.route({
    method: messagesEndpoint.method,
    url: messagesEndpoint.path,
    handler: (request, reply) => handleGatewayTextRequest({
      request,
      reply,
      surface: anthropicMessagesSurface,
      operationId: messagesEndpoint.operationId
    })
  });

  app.route({
    method: countTokensEndpoint.method,
    url: countTokensEndpoint.path,
    handler: (request, reply) => handleGatewayTextRequest({
      request,
      reply,
      surface: anthropicMessagesSurface,
      operationId: countTokensEndpoint.operationId,
      upstreamPath: "/messages/count_tokens"
    })
  });

  return app;
}

function httpGatewayModelEndpoint(endpoint: GatewayModelEndpoint): HttpGatewayModelEndpoint {
  if (endpoint.transport !== "http" || !["GET", "POST"].includes(endpoint.method)) {
    throw new Error(`invalid_http_gateway_model_endpoint:${endpoint.id}`);
  }
  return endpoint;
}


function requestWantsStream(body: unknown) {
  return isRecord(body) && body.stream === true;
}

async function acquireTrafficLimitOrReject(input: {
  trafficLimits: TrafficLimitStore;
  requestStates: RequestStateStoreLike;
  reply: FastifyReply;
  surface: Surface;
  idempotencyKey: string;
  identity: RequestIdentity;
  context: RouteContext;
  providerTarget?: GatewayExecutionTarget;
}): Promise<TrafficLimitLease | undefined> {
  const stage = input.providerTarget ? "provider_model" : "request";
  const result = input.trafficLimits.acquire({
    organizationId: input.identity.organizationId,
    workspaceId: input.identity.workspaceId,
    apiKeyId: input.identity.apiKeyId,
    userId: input.context.userId,
    accessProfileId: input.identity.accessProfileId ?? undefined,
    accessProfileLimits: input.identity.accessProfileLimits,
    provider: input.providerTarget?.provider,
    model: input.providerTarget?.upstreamModelId,
    estimatedTokens: input.context.estimatedInputTokens
  }, stage);
  if (result.allowed) return result.lease;

  await input.requestStates.finish(input.idempotencyKey, "failed", { error: result.error });
  sendTrafficLimitDenied(input.reply, input.surface, result);
  return undefined;
}

function sendTrafficLimitDenied(reply: FastifyReply, surface: Surface, result: TrafficLimitDenied) {
  if (result.retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(result.retryAfterSeconds));
  }
  sendGatewayError(surface, reply, 429, result.error, result.error, {
    scope: result.scope,
    limit: result.limit,
    current: result.current
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
  reply: FastifyReply,
  surface: Surface
) {
  if (!gate.duplicate) return false;

  sendGatewayError(
    surface,
    reply,
    409,
    "duplicate_request_active",
    "Duplicate request is still active.",
    { status: gate.state.status }
  );
  return true;
}

function errorStatusCode(error: unknown) {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 500;
}

function gatewayTransportErrorCode(status: number, bodyLimit: boolean) {
  if (bodyLimit) return "request_body_too_large";
  if (status === 401) return "unauthorized";
  if (status >= 500) return "gateway_request_failed";
  return "invalid_request";
}

function gatewayTransportErrorMessage(error: unknown, status: number, bodyLimit: boolean) {
  if (bodyLimit) return "Request body exceeds gateway limit.";
  if (status >= 500) return "Gateway request failed.";
  return error instanceof Error && error.message
    ? error.message
    : gatewayTransportErrorCode(status, bodyLimit);
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
  if (path === GATEWAY_MODEL_ENDPOINTS.messages.path || path === GATEWAY_MODEL_ENDPOINTS.countTokens.path) {
    return "anthropic";
  }
  if (path.startsWith("/v1/")) return "openai";
  return "unknown";
}

function modelSurfaceForPath(path: string): Surface | undefined {
  if (path === GATEWAY_MODEL_ENDPOINTS.responsesHttp.path) return openAIResponsesSurface.surface;
  if (path === GATEWAY_MODEL_ENDPOINTS.chatCompletions.path) return openAIChatSurface.surface;
  if (path === GATEWAY_MODEL_ENDPOINTS.messages.path || path === GATEWAY_MODEL_ENDPOINTS.countTokens.path) {
    return anthropicMessagesSurface.surface;
  }
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
}
