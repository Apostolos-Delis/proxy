import cors from "@fastify/cors";
import Fastify, { type FastifyReply } from "fastify";

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
import { registerAdminGraphQL } from "./graphql/route.js";
import { BudgetService, SessionRouteStore } from "./policy.js";
import { createPostgresPersistence } from "./persistence/index.js";
import { resolveRoutingSelection } from "./persistence/routingConfig.js";
import { appendPromptCaptureEvent } from "./promptCaptureEvents.js";
import { ProjectionService } from "./projections.js";
import { ProviderProxy } from "./proxy.js";
import { RoutingService } from "./router.js";
import { buildSetupScript } from "./setupScript.js";
import type { Provider, Surface } from "./types.js";
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
    credentials: true,
    methods: ["GET", "HEAD", "POST"]
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
  const sessions = new SessionRouteStore(persistence?.sessionPins);
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
    persistence?.promptArtifacts,
    persistence?.routingConfigs
  );
  const projections = new ProjectionService(modelCatalog, config);
  const emailService = new EmailService(config, app.log);
  registerAdminGraphQL(app, { config, adminAuth, emailService, events, projections, persistence });
  wsProxy.register(app.server);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/setup.sh", async (request, reply) => {
    const proto = headerValue(request.headers, "x-forwarded-proto")?.split(",")[0].trim() ?? request.protocol;
    const host = headerValue(request.headers, "x-forwarded-host") ?? headerValue(request.headers, "host") ?? `127.0.0.1:${config.port}`;
    // text/plain (not x-shellscript) so the link in the setup guide renders
    // the script in the browser instead of downloading it.
    void reply.header("content-type", "text/plain; charset=utf-8");
    void reply.header("cache-control", "no-store");
    return buildSetupScript(`${proto}://${host}`);
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
  app.post("/v1/responses", async (request, reply) => {
    const identity = await auth.resolve(request.headers);
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
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

      const resolved = await resolveRoutingConfig(persistence, identity, identity.routingConfigId);
      const decision = await routing.decide({
        requestId,
        context,
        body: request.body,
        idempotencyKey,
        routingConfig: resolved.routingConfig
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
        body: rewriteSurfaceRequest(request.body, decision, resolved.systemPrompt),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        credential: await resolveUpstreamCredential(persistence, identity, openAIResponsesSurface.provider),
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
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
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

      const resolved = await resolveRoutingConfig(persistence, identity, identity.routingConfigId);
      const decision = await routing.decide({
        requestId,
        context,
        body: request.body,
        idempotencyKey,
        routingConfig: resolved.routingConfig
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
        body: rewriteSurfaceRequest(request.body, decision, resolved.systemPrompt),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        credential: await resolveUpstreamCredential(persistence, identity, anthropicMessagesSurface.provider),
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
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
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
      const resolved = await resolveRoutingConfig(persistence, identity, identity.routingConfigId);
      const decision = routing.tokenCountDecision(context, resolved.routingConfig);
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
        body: rewriteTokenCountRequest(request.body, decision, resolved.systemPrompt),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        path: "/messages/count_tokens",
        credential: await resolveUpstreamCredential(persistence, identity, anthropicMessagesSurface.provider)
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

function resolveUpstreamCredential(
  persistence: AppPersistence | undefined,
  identity: RequestIdentity,
  provider: Provider
) {
  if (!persistence) return undefined;
  return persistence.providerCredentials.resolveForRequest({
    organizationId: identity.organizationId,
    apiKeyId: identity.apiKeyId,
    provider
  });
}

async function resolveRoutingConfig(
  persistence: AppPersistence | undefined,
  identity: RequestIdentity,
  routingConfigId: string | null
) {
  return resolveRoutingSelection(persistence?.routingConfigs, {
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    routingConfigId
  });
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

  reply.code(409).send({
    error: "Duplicate request is still active.",
    status: gate.state.status
  });
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const persistence = config.databaseUrl
    ? createPostgresPersistence(config.databaseUrl, buildModelCatalog(config), config)
    : undefined;
  const app = buildServer(config, { persistence });
  await app.listen({ port: config.port, host: "0.0.0.0" });
  // Heal usage rows that booked $0 before their model's rate existed — e.g.
  // traffic served before a default-pricing-table addition shipped.
  if (persistence) {
    void persistence.repriceZeroCostUsage().then(
      (repriced) => {
        if (repriced > 0) app.log.info({ repriced }, "repriced zero-cost usage ledger rows");
      },
      (error) => app.log.warn({ err: error }, "zero-cost usage repricing failed")
    );
  }
}
