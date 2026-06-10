import cors from "@fastify/cors";
import Fastify, { type FastifyReply } from "fastify";
import type { PromptCaptureMode } from "@prompt-proxy/schema";

import { AdminAuthService } from "./adminAuth.js";
import {
  anthropicMessagesSurface,
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
import { buildModelCatalog } from "./catalog.js";
import { LlmClassifier } from "./classifier.js";
import { EmailService } from "./email.js";
import { EventService, ProviderAttemptStore, RequestStateStore, type RequestStateGate } from "./events.js";
import { BudgetService, SessionRouteStore } from "./policy.js";
import { createPostgresPersistence } from "./persistence/index.js";
import { routingConfigSnapshot } from "./persistence/routingConfig.js";
import { RoutingConfigAdminError } from "./persistence/routingConfigAdmin.js";
import { appendPromptCaptureEvent } from "./promptCaptureEvents.js";
import { ProjectionService } from "./projections.js";
import { ProviderProxy } from "./proxy.js";
import { RoutingService } from "./router.js";
import {
  emptyProxySettings,
  readSettingsFile,
  writeSettingsFile,
  type ProxySettings
} from "./settings.js";
import { registerUserAdminRoutes } from "./userAdminRoutes.js";
import type { Surface } from "./types.js";
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
  const adminAuth = new AdminAuthService(config, persistence?.adminSessions);
  const attempts = new ProviderAttemptStore();
  const requestStates = persistence?.requestStates ?? new RequestStateStore();
  const budget = new BudgetService(config);
  const sessions = new SessionRouteStore();
  const classifier = new LlmClassifier(config);
  const routing = new RoutingService(config, classifier, events, modelCatalog, budget, sessions);
  const proxy = new ProviderProxy(config, events, attempts, requestStates);
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
    persistence?.promptArtifacts,
    persistence?.routingConfigs
  );
  const projections = new ProjectionService(modelCatalog, config);
  const emailService = new EmailService(config, app.log);
  registerUserAdminRoutes(app, { config, adminAuth, emailService, persistence });
  wsProxy.register(app.server);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/api/auth/login", async (request, reply) => {
    const session = await adminAuth.login(request.body);
    reply.header("set-cookie", adminAuth.sessionCookie(session.token, session.expiresAt));
    return {
      user: session.identity,
      organizationId: session.identity.organizationId
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await adminAuth.logout(request.headers);
    reply.header("set-cookie", adminAuth.clearCookie());
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => {
    const identity = await adminAuth.resolve(request.headers);
    return {
      user: identity,
      organizationId: identity.organizationId
    };
  });

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
    await adminAuth.resolve(request.headers);
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
    await adminAuth.resolve(request.headers);
    if (persistence) return persistence.adminQueries.requests();
    return {
      data: [...projections.usage(events.listEvents()).requests].reverse()
    };
  });
  app.get("/admin/api-keys", async (request) => {
    await adminAuth.resolve(request.headers);
    if (!persistence) throw notFound("api_keys_not_found");
    return persistence.adminQueries.apiKeys();
  });
  app.get("/admin/api-keys/:apiKeyId", async (request, reply) => {
    await adminAuth.resolve(request.headers);
    const params = request.params as { apiKeyId?: string };
    const apiKeyId = params.apiKeyId;
    if (!apiKeyId || !persistence) {
      reply.code(404).send({ error: "api_key_not_found" });
      return;
    }
    const detail = await persistence.adminQueries.apiKeyDetail(apiKeyId);
    if (!detail) {
      reply.code(404).send({ error: "api_key_not_found" });
      return;
    }
    return detail;
  });
  app.patch("/admin/api-keys/:apiKeyId/routing-config", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    const params = request.params as { apiKeyId?: string };
    const apiKeyId = params.apiKeyId;
    if (!apiKeyId || !persistence) {
      reply.code(404).send({ error: "api_key_not_found" });
      return;
    }
    try {
      await persistence.routingConfigAdmin.assignApiKeyRoutingConfig({
        organizationId: identity.organizationId,
        actorUserId: identity.userId,
        apiKeyId,
        body: request.body
      });
      return persistence.adminQueries.apiKeyDetail(apiKeyId);
    } catch (error) {
      if (sendRoutingConfigAdminError(error, reply)) return;
      throw error;
    }
  });
  app.get("/admin/routing-configs", async (request) => {
    await adminAuth.resolve(request.headers);
    if (!persistence) return { data: [] };
    return persistence.adminQueries.routingConfigs();
  });
  app.post("/admin/routing-configs", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    if (!persistence) throw notFound("routing_configs_not_found");
    try {
      const created = await persistence.routingConfigAdmin.createConfig({
        organizationId: identity.organizationId,
        actorUserId: identity.userId,
        body: request.body
      });
      reply.code(201);
      return persistence.adminQueries.routingConfigDetail(created.configId);
    } catch (error) {
      if (sendRoutingConfigAdminError(error, reply)) return;
      throw error;
    }
  });
  app.get("/admin/routing-configs/:configId", async (request, reply) => {
    await adminAuth.resolve(request.headers);
    const params = request.params as { configId?: string };
    const configId = params.configId;
    if (!configId || !persistence) {
      reply.code(404).send({ error: "routing_config_not_found" });
      return;
    }
    const detail = await persistence.adminQueries.routingConfigDetail(configId);
    if (!detail) {
      reply.code(404).send({ error: "routing_config_not_found" });
      return;
    }
    return detail;
  });
  app.post("/admin/routing-configs/:configId/versions", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    const params = request.params as { configId?: string };
    const configId = params.configId;
    if (!configId || !persistence) {
      reply.code(404).send({ error: "routing_config_not_found" });
      return;
    }
    try {
      await persistence.routingConfigAdmin.createVersion({
        organizationId: identity.organizationId,
        actorUserId: identity.userId,
        configId,
        body: request.body
      });
      reply.code(201);
      return persistence.adminQueries.routingConfigDetail(configId);
    } catch (error) {
      if (sendRoutingConfigAdminError(error, reply)) return;
      throw error;
    }
  });
  app.post("/admin/routing-configs/:configId/versions/:versionId/activate", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    const params = request.params as { configId?: string; versionId?: string };
    const configId = params.configId;
    const versionId = params.versionId;
    if (!configId || !versionId || !persistence) {
      reply.code(404).send({ error: "routing_config_version_not_found" });
      return;
    }
    try {
      await persistence.routingConfigAdmin.activateVersion({
        organizationId: identity.organizationId,
        actorUserId: identity.userId,
        configId,
        versionId
      });
      return persistence.adminQueries.routingConfigDetail(configId);
    } catch (error) {
      if (sendRoutingConfigAdminError(error, reply)) return;
      throw error;
    }
  });
  app.post("/admin/routing-configs/:configId/archive", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    const params = request.params as { configId?: string };
    const configId = params.configId;
    if (!configId || !persistence) {
      reply.code(404).send({ error: "routing_config_not_found" });
      return;
    }
    try {
      await persistence.routingConfigAdmin.archiveConfig({
        organizationId: identity.organizationId,
        actorUserId: identity.userId,
        configId
      });
      return persistence.adminQueries.routingConfigDetail(configId);
    } catch (error) {
      if (sendRoutingConfigAdminError(error, reply)) return;
      throw error;
    }
  });
  app.get("/admin/requests/:requestId", async (request) => {
    await adminAuth.resolve(request.headers);
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
  app.get("/admin/prompts", async (request) => {
    await adminAuth.resolve(request.headers);
    if (persistence) return persistence.adminQueries.prompts(promptFilters(request.query));
    return { data: [], pagination: { limit: 50, offset: 0, count: 0 } };
  });
  app.get("/admin/prompts/:artifactId", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    const params = request.params as { artifactId?: string };
    const artifactId = params.artifactId;
    if (!artifactId || !persistence) {
      reply.code(404).send({ error: "prompt_artifact_not_found" });
      return;
    }
    const detail = await persistence.adminQueries.promptDetail(artifactId);
    if (!detail) {
      reply.code(404).send({ error: "prompt_artifact_not_found" });
      return;
    }
    await persistence.promptAccessAudit.append({
      organizationId: identity.organizationId,
      artifactId: detail.artifact.artifactId,
      requestId: detail.artifact.requestId,
      userId: identity.userId,
      adminSessionId: identity.sessionId,
      route: detail.request?.finalRoute,
      accessPath: request.url
    });
    return detail;
  });
  app.get("/admin/usage", async (request) => {
    await adminAuth.resolve(request.headers);
    if (persistence) return persistence.adminQueries.usage(usageFilters(request.query));
    return {
      groupBy: "route",
      data: [],
      totals: {
        key: "total",
        requestCount: 0,
        failedRequests: 0,
        retriedRequests: 0,
        failureRate: 0,
        retryRate: 0,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0
        },
        cost: { selected: 0, baseline: 0, savings: 0 }
      }
    };
  });
  app.get("/admin/users", async (request) => {
    await adminAuth.resolve(request.headers);
    if (persistence) return persistence.adminQueries.users();
    return { data: [] };
  });
  app.get("/admin/users/:userId", async (request, reply) => {
    await adminAuth.resolve(request.headers);
    const params = request.params as { userId?: string };
    const userId = params.userId;
    if (!userId || !persistence) {
      reply.code(404).send({ error: "user_not_found" });
      return;
    }
    const detail = await persistence.adminQueries.userDetail(userId);
    if (!detail) {
      reply.code(404).send({ error: "user_not_found" });
      return;
    }
    return detail;
  });
  app.get("/admin/sessions", async (request) => {
    await adminAuth.resolve(request.headers);
    if (persistence) return persistence.adminQueries.sessions();
    return { data: [] };
  });
  app.get("/admin/sessions/:sessionId", async (request, reply) => {
    await adminAuth.resolve(request.headers);
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId;
    if (!sessionId || !persistence) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }
    const detail = await persistence.adminQueries.sessionDetail(sessionId);
    if (!detail) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }
    return detail;
  });
  app.get("/admin/prompt-access-audit", async (request) => {
    const identity = await adminAuth.resolve(request.headers);
    if (!persistence) return { data: [] };
    return persistence.promptAccessAudit.list(identity.organizationId);
  });
  app.patch("/admin/settings/prompt-capture", async (request) => {
    await adminAuth.resolve(request.headers);
    if (!persistence) throw notFound("prompt_capture_settings_not_found");
    return persistence.promptArtifacts.configure({
      organizationId: config.defaultOrganizationId,
      ...promptCaptureSettings(request.body)
    });
  });
  app.get("/admin/settings", async (request) => {
    await adminAuth.resolve(request.headers);
    return settingsResponse(config, await readSettingsFile(config.settingsPath), persistence);
  });
  app.patch("/admin/settings", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    try {
      const settings = await writeSettingsFile(config.settingsPath, request.body);
      if (
        persistence &&
        settings.promptCapture.promptCaptureMode !== undefined &&
        settings.promptCapture.retentionDays !== undefined
      ) {
        await persistence.promptArtifacts.configure({
          organizationId: identity.organizationId,
          promptCaptureMode: settings.promptCapture.promptCaptureMode,
          retentionDays: settings.promptCapture.retentionDays
        });
      }
      return settingsResponse(config, settings, persistence);
    } catch (error) {
      if (error instanceof Error && error.message === "settings_file_invalid_json") {
        reply.code(400).send({ error: "settings_file_invalid_json" });
        return;
      }
      if (error && typeof error === "object" && "issues" in error) {
        reply.code(400).send({ error: "invalid_settings", issues: (error as { issues: unknown }).issues });
        return;
      }
      throw error;
    }
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
      const capturedArtifacts = await persistence?.promptArtifacts.capture({
        organizationId: identity.organizationId,
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

      const decision = await routing.decide({
        requestId,
        context,
        body: request.body,
        idempotencyKey,
        routingConfig: await resolveRoutingConfig(persistence, identity.organizationId, identity.routingConfigId)
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
        body: rewriteSurfaceRequest(request.body, decision),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        onAssistantText: assistantResponseCapture({
          identity,
          requestId,
          idempotencyKey,
          sessionId: context.sessionId,
          surface: openAIResponsesSurface.surface
        })
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
      const capturedArtifacts = await persistence?.promptArtifacts.capture({
        organizationId: identity.organizationId,
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

      const decision = await routing.decide({
        requestId,
        context,
        body: request.body,
        idempotencyKey,
        routingConfig: await resolveRoutingConfig(persistence, identity.organizationId, identity.routingConfigId)
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
        body: rewriteSurfaceRequest(request.body, decision),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        onAssistantText: assistantResponseCapture({
          identity,
          requestId,
          idempotencyKey,
          sessionId: context.sessionId,
          surface: anthropicMessagesSurface.surface
        })
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
      const routingConfig = await resolveRoutingConfig(persistence, identity.organizationId, identity.routingConfigId);
      const decision = routing.tokenCountDecision(context, routingConfig);
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
        body: rewriteTokenCountRequest(request.body, decision),
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

function usageFilters(query: unknown) {
  const record = query && typeof query === "object" && !Array.isArray(query)
    ? query as Record<string, unknown>
    : {};
  return {
    groupBy: stringParam(record.groupBy ?? record.group_by),
    start: stringParam(record.start ?? record.startDate),
    end: stringParam(record.end ?? record.endDate)
  };
}

function promptFilters(query: unknown) {
  const record = query && typeof query === "object" && !Array.isArray(query)
    ? query as Record<string, unknown>
    : {};
  return {
    limit: numberParam(record.limit),
    offset: numberParam(record.offset),
    userId: stringParam(record.userId ?? record.user),
    surface: stringParam(record.surface),
    route: stringParam(record.route),
    model: stringParam(record.model),
    start: stringParam(record.start ?? record.startDate),
    end: stringParam(record.end ?? record.endDate)
  };
}

function stringParam(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberParam(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function promptCaptureSettings(body: unknown) {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const promptCaptureMode = stringParam(record.promptCaptureMode ?? record.prompt_capture_mode);
  const retentionDays = numberParam(record.retentionDays ?? record.retention_days);
  if (
    promptCaptureMode !== "none" &&
    promptCaptureMode !== "hash_only" &&
    promptCaptureMode !== "raw_text" &&
    promptCaptureMode !== "redacted" &&
    promptCaptureMode !== "encrypted_raw"
  ) {
    throw badRequest("invalid_prompt_capture_mode");
  }
  if (retentionDays === undefined || retentionDays < 0) {
    throw badRequest("invalid_retention_days");
  }
  return {
    promptCaptureMode: promptCaptureMode as PromptCaptureMode,
    retentionDays
  };
}

async function resolveRoutingConfig(
  persistence: AppPersistence | undefined,
  organizationId: string,
  routingConfigId: string | null
) {
  const resolved = await persistence?.routingConfigs.resolve({ organizationId, routingConfigId });
  return resolved
    ? {
        snapshot: routingConfigSnapshot(resolved),
        config: resolved.config
      }
    : undefined;
}

async function settingsResponse(
  config: AppConfig,
  fileSettings: ProxySettings,
  persistence: AppPersistence | undefined
) {
  const promptCapture = persistence
    ? await persistence.promptArtifacts.settings(config.defaultOrganizationId)
    : {
        promptCaptureMode: fileSettings.promptCapture.promptCaptureMode ?? "raw_text",
        retentionDays: fileSettings.promptCapture.retentionDays ?? 30
      };
  const settings = {
    schemaVersion: 1,
    classifier: {
      model: fileSettings.classifier.model ?? config.classifierModel,
      timeoutMs: fileSettings.classifier.timeoutMs ?? config.classifierTimeoutMs,
      maxAttempts: fileSettings.classifier.maxAttempts ?? config.classifierMaxAttempts,
      allowRedactedExcerpt: fileSettings.classifier.allowRedactedExcerpt ?? config.classifierAllowRedactedExcerpt
    },
    budgets: {
      warningEstimatedInputTokens: fileSettings.budgets.warningEstimatedInputTokens ?? config.budgetWarningEstimatedInputTokens ?? null,
      maxEstimatedInputTokens: fileSettings.budgets.maxEstimatedInputTokens ?? config.budgetMaxEstimatedInputTokens ?? null,
      maxRoute: fileSettings.budgets.maxRoute ?? config.budgetMaxRoute ?? null
    },
    routeQuality: {
      lowConfidenceThreshold: fileSettings.routeQuality.lowConfidenceThreshold ?? config.routeQualityLowConfidenceThreshold
    },
    promptCapture
  };
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
    budgets: settings.budgets,
    promptCapture,
    storage: {
      format: "json",
      path: config.settingsPath,
      reason: "The repo already uses JSON package/config conventions and has no YAML parser dependency."
    },
    restartRequiredFor: ["classifier", "budgets", "routeQuality"],
    settings,
    runtime: {
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
      }
    },
    file: fileSettings,
    defaults: emptyProxySettings
  };
}

function badRequest(message: string) {
  const error = new Error(message);
  (error as Error & { statusCode: number }).statusCode = 400;
  return error;
}

function sendRoutingConfigAdminError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof RoutingConfigAdminError)) return false;
  reply.code(error.statusCode).send({
    error: error.message,
    issues: error.issues ?? []
  });
  return true;
}

function notFound(message: string) {
  const error = new Error(message);
  (error as Error & { statusCode: number }).statusCode = 404;
  return error;
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
