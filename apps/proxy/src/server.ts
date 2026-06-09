import cors from "@fastify/cors";
import Fastify, { type FastifyReply } from "fastify";

import { anthropicMessagesSurface, openAIResponsesSurface } from "./adapters.js";
import {
  actorForIdentity,
  contextForIdentity,
  ProxyAuthService,
  requestReceivedPayload,
  scopedIdempotencyKey
} from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { buildModelCatalog } from "./catalog.js";
import { LlmClassifier } from "./classifier.js";
import { EventService, ProviderAttemptStore, RequestStateStore, type RequestStateGate } from "./events.js";
import { BudgetService, SessionRouteStore } from "./policy.js";
import { createPostgresPersistence } from "./persistence/index.js";
import { ProjectionService } from "./projections.js";
import { ProviderProxy } from "./proxy.js";
import { RoutingService } from "./router.js";
import { createId, headerValue, idempotencyFrom, lowerHeaders } from "./util.js";
import { WebSocketRoutingProxy } from "./wsProxy.js";

type AppPersistence = ReturnType<typeof createPostgresPersistence>;

export function buildServer(config: AppConfig = loadConfig(), options: { persistence?: AppPersistence } = {}) {
  const modelCatalog = buildModelCatalog(config);
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 1024 * 1024 * 50
  });
  void app.register(cors, {
    origin: config.adminCorsOrigins,
    credentials: true
  });
  const persistence = options.persistence ?? (config.databaseUrl
    ? createPostgresPersistence(config.databaseUrl, modelCatalog, config)
    : undefined);
  const events = new EventService(
    config.eventStorePath,
    undefined,
    persistence?.eventSink,
    config.defaultOrganizationId
  );
  const auth = new ProxyAuthService(config, persistence?.apiKeys);
  const attempts = new ProviderAttemptStore();
  const requestStates = persistence?.requestStates ?? new RequestStateStore();
  const budget = new BudgetService(config);
  const sessions = new SessionRouteStore();
  const classifier = new LlmClassifier(config);
  const routing = new RoutingService(config, classifier, events, modelCatalog, budget, sessions);
  const proxy = new ProviderProxy(config, events, attempts, requestStates);
  const wsProxy = new WebSocketRoutingProxy(
    config,
    auth,
    routing,
    events,
    attempts,
    requestStates,
    persistence?.promptArtifacts
  );
  const projections = new ProjectionService(modelCatalog, config);
  wsProxy.register(app.server);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/v1/models", async () => ({
    object: "list",
    data: [
      { id: "router-auto", object: "model", owned_by: "prompt-proxy" },
      { id: "router-fast", object: "model", owned_by: "prompt-proxy" },
      { id: "router-balanced", object: "model", owned_by: "prompt-proxy" },
      { id: "router-hard", object: "model", owned_by: "prompt-proxy" },
      { id: "router-deep", object: "model", owned_by: "prompt-proxy" },
      { id: "claude-router-auto", type: "model", display_name: "Claude Router: Auto" },
      { id: "claude-router-fast", type: "model", display_name: "Claude Router: Fast" },
      { id: "claude-router-balanced", type: "model", display_name: "Claude Router: Balanced" },
      { id: "claude-router-hard", type: "model", display_name: "Claude Router: Hard" },
      { id: "claude-router-deep", type: "model", display_name: "Claude Router: Deep" }
    ]
  }));

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
  app.get("/admin/overview", async (request) => {
    requireAuth(request.headers, config.proxyToken);
    if (persistence) return persistence.adminQueries.overview();
    const allEvents = events.listEvents();
    const usage = projections.usage(allEvents);
    const routeQuality = projections.routeQuality(allEvents);
    return {
      organizationId: config.defaultOrganizationId,
      eventCount: allEvents.length,
      requestCount: usage.requests.length,
      totals: usage.totals,
      cost: usage.cost,
      routeQuality: {
        lowConfidenceCount: routeQuality.lowConfidence.length,
        cheaperLikelyWouldWorkCount: routeQuality.cheaperLikelyWouldWork.length,
        cheapCausedRetriesOrRepairsCount: routeQuality.cheapCausedRetriesOrRepairs.length
      }
    };
  });
  app.get("/admin/requests", async (request) => {
    requireAuth(request.headers, config.proxyToken);
    if (persistence) return persistence.adminQueries.requests();
    return {
      data: [...projections.usage(events.listEvents()).requests].reverse()
    };
  });
  app.get("/admin/requests/:requestId", async (request) => {
    requireAuth(request.headers, config.proxyToken);
    const params = request.params as { requestId?: string };
    const requestId = params.requestId;
    if (!requestId) return { request: null, events: [] };
    if (persistence) return persistence.adminQueries.requestDetail(requestId);
    const allEvents = events.listEvents();
    const requestSummary = projections.usage(allEvents).requests.find((item) => item.requestId === requestId);
    return {
      request: requestSummary ?? null,
      events: allEvents.filter((event) => event.scopeId === requestId || event.correlationId === requestId)
    };
  });
  app.get("/admin/settings", async (request) => {
    requireAuth(request.headers, config.proxyToken);
    return {
      organizationId: config.defaultOrganizationId,
      databaseEnabled: Boolean(config.databaseUrl),
      classifier: {
        provider: config.classifierProvider,
        model: config.classifierModel,
        timeoutMs: config.classifierTimeoutMs,
        maxAttempts: config.classifierMaxAttempts,
        contentMode: config.classifierAllowRedactedExcerpt ? "redacted_excerpt" : "features_only"
      },
      budgets: {
        maxEstimatedInputTokens: config.budgetMaxEstimatedInputTokens ?? null,
        warningEstimatedInputTokens: config.budgetWarningEstimatedInputTokens ?? null,
        maxRoute: config.budgetMaxRoute ?? null
      },
      routePolicyTrust: config.routePolicyTrust
    };
  });

  app.post("/v1/responses", async (request, reply) => {
    const identity = await auth.resolve(request.headers);
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, idempotencyFrom(
      openAIResponsesSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = openAIResponsesSurface.buildContext(request.body, lowerHeaders(request.headers));
    const context = contextForIdentity(rawContext, identity);
    const proposedRequestId = createId("request");
    const gate = await requestStates.begin(idempotencyKey, proposedRequestId, context);
    if (sendDuplicateRequest(gate, reply)) return;
    const requestId = gate.state.requestId ?? proposedRequestId;

    try {
      await events.append({
        tenantId: identity.organizationId,
        scopeType: "request",
        scopeId: requestId,
        correlationId: requestId,
        idempotencyKey,
        actor: actorForIdentity(identity),
        producer: "prompt-proxy.surface.openai-responses",
        eventType: "proxy.request_received",
        payload: requestReceivedPayload("openai-responses", context, rawContext, identity)
      });
      await persistence?.promptArtifacts.capture({
        organizationId: identity.organizationId,
        requestId,
        surface: openAIResponsesSurface.surface,
        body: request.body
      });

      const decision = await routing.decide({
        requestId,
        context,
        body: request.body,
        idempotencyKey
      });
      if (decision.outcome === "reject") {
        await requestStates.finish(idempotencyKey, "failed", { error: decision.error });
        reply.code(decision.errorStatus ?? 400).send({ error: decision.error });
        return;
      }

      await proxy.forward({
        requestId,
        idempotencyKey,
        surface: openAIResponsesSurface.surface,
        provider: openAIResponsesSurface.provider,
        body: routing.rewrite(request.body, decision),
        headers: lowerHeaders(request.headers),
        decision,
        reply
      });
    } catch (error) {
      await requestStates.finish(idempotencyKey, "failed", {
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    }
  });

  app.post("/v1/messages", async (request, reply) => {
    const identity = await auth.resolve(request.headers);
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, idempotencyFrom(
      anthropicMessagesSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = anthropicMessagesSurface.buildContext(request.body, lowerHeaders(request.headers));
    const context = contextForIdentity(rawContext, identity);
    const proposedRequestId = createId("request");
    const gate = await requestStates.begin(idempotencyKey, proposedRequestId, context);
    if (sendDuplicateRequest(gate, reply)) return;
    const requestId = gate.state.requestId ?? proposedRequestId;

    try {
      await events.append({
        tenantId: identity.organizationId,
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
      await persistence?.promptArtifacts.capture({
        organizationId: identity.organizationId,
        requestId,
        surface: anthropicMessagesSurface.surface,
        body: request.body
      });

      const decision = await routing.decide({
        requestId,
        context,
        body: request.body,
        idempotencyKey
      });
      if (decision.outcome === "reject") {
        await requestStates.finish(idempotencyKey, "failed", { error: decision.error });
        reply.code(decision.errorStatus ?? 400).send({ error: decision.error });
        return;
      }

      await proxy.forward({
        requestId,
        idempotencyKey,
        surface: anthropicMessagesSurface.surface,
        provider: anthropicMessagesSurface.provider,
        body: routing.rewrite(request.body, decision),
        headers: lowerHeaders(request.headers),
        decision,
        reply
      });
    } catch (error) {
      await requestStates.finish(idempotencyKey, "failed", {
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    }
  });

  app.post("/v1/messages/count_tokens", async (request, reply) => {
    const identity = await auth.resolve(request.headers);
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, idempotencyFrom(
      anthropicMessagesSurface.countTokensOperation ?? anthropicMessagesSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = anthropicMessagesSurface.buildContext(request.body, lowerHeaders(request.headers));
    const context = contextForIdentity(rawContext, identity);
    const proposedRequestId = createId("request");
    const gate = await requestStates.begin(idempotencyKey, proposedRequestId, context);
    if (sendDuplicateRequest(gate, reply)) return;
    const requestId = gate.state.requestId ?? proposedRequestId;
    try {
      await events.append({
        tenantId: identity.organizationId,
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
      const decision = routing.tokenCountDecision(context);
      if (decision.outcome === "reject") {
        await requestStates.finish(idempotencyKey, "failed", { error: decision.error });
        reply.code(decision.errorStatus ?? 400).send({ error: decision.error });
        return;
      }

      await proxy.forward({
        requestId,
        idempotencyKey,
        surface: anthropicMessagesSurface.surface,
        provider: anthropicMessagesSurface.provider,
        body: routing.rewriteTokenCount(request.body, decision),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        path: "/messages/count_tokens"
      });
    } catch (error) {
      await requestStates.finish(idempotencyKey, "failed", {
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    }
  });

  return app;
}

function requireAuth(headers: Record<string, unknown>, token: string) {
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

  if (gate.state.status === "classifying" || gate.state.status === "provider_pending") {
    reply.code(409).send({
      error: "Duplicate request is still active.",
      status: gate.state.status
    });
    return true;
  }

  reply.send({
    duplicate: true,
    status: gate.state.status,
    provider_attempt_id: gate.state.providerAttemptId ?? null,
    usage: gate.state.usage ?? null,
    upstream_request_id: gate.state.upstreamRequestId ?? null,
    error: gate.state.error ?? null
  });
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = buildServer(config);
  await app.listen({ port: config.port, host: "0.0.0.0" });
}
