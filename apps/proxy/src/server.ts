import cors from "@fastify/cors";
import Fastify, { type FastifyReply } from "fastify";

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
import { SessionRouteStore } from "./policy.js";
import { createPostgresPersistence } from "./persistence/index.js";
import { ConfigProviderRegistry } from "./persistence/providers.js";
import { resolveRoutingSelection, type RoutingConfigResolverLike } from "./persistence/routingConfig.js";
import { modelDiscoveryResponse } from "./modelDiscovery.js";
import { appendPromptCaptureEvent } from "./promptCaptureEvents.js";
import { ProjectionService } from "./projections.js";
import { appendTokensAttributed } from "./tokenAttribution.js";
import { compressForForward, compressOrFallback } from "./toolResultCompression.js";
import { ProviderProxy } from "./proxy.js";
import { RoutingService } from "./router.js";
import { buildSetupScript } from "./setupScript.js";
import type { Provider, RouteDecision, Surface } from "./types.js";
import { createId, headerValue, idempotencyFrom, lowerHeaders } from "./util.js";
import { WebSocketRoutingProxy } from "./wsProxy.js";

type AppPersistence = ReturnType<typeof createPostgresPersistence>;

export function buildServer(config: AppConfig = loadConfig(), options: { persistence?: AppPersistence } = {}) {
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
    ? createPostgresPersistence(config.databaseUrl, config)
    : undefined);
  const routingConfigs = persistence?.routingConfigs ?? new DefaultRoutingConfigResolver(config);
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
  const sessions = new SessionRouteStore(persistence?.sessionPins);
  const classifier = new LlmClassifier(config);
  const providerRegistry = persistence?.providerRegistry ?? new ConfigProviderRegistry(config);
  const routing = new RoutingService(
    config,
    classifier,
    events,
    sessions,
    providerRegistry,
    persistence?.providerCredentials
  );
  const proxy = new ProviderProxy(config, events, attempts, requestStates, providerRegistry);
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
        await requestStates.finish(idempotencyKey, "failed", { error: decision.error });
        sendRejectedDecision(decision, reply);
        return;
      }
      await pinSystemPrompt(persistence, identity, openAIResponsesSurface.surface, requestId, context.sessionId, systemPrompt);

      const compressedBody = await compressForForward({
        events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIResponsesSurface.surface,
        body: request.body,
        enabled: resolved.toolResultCompression,
        deduplicateToolResults: resolved.duplicateToolResultReferences,
        profile: harnessProfileByName(context.harness),
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        surface: openAIResponsesSurface.surface,
        provider: routedProvider(decision),
        body: rewriteSurfaceRequest(compressedBody, decision, systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching }),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision)),
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

  app.post("/v1/chat/completions", async (request, reply) => {
    const identity = await auth.resolve(request.headers);
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, identity.workspaceId, idempotencyFrom(
      openAIChatSurface.createOperation,
      request.body,
      request.headers
    ));
    const rawContext = openAIChatSurface.buildContext(request.body, lowerHeaders(request.headers));
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
        await requestStates.finish(idempotencyKey, "failed", { error: decision.error });
        sendRejectedDecision(decision, reply);
        return;
      }

      const compressedBody = await compressForForward({
        events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: openAIChatSurface.surface,
        body: request.body,
        enabled: resolved.toolResultCompression,
        deduplicateToolResults: resolved.duplicateToolResultReferences,
        profile: harnessProfileByName(context.harness),
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        surface: openAIChatSurface.surface,
        provider: routedProvider(decision),
        body: rewriteSurfaceRequest(compressedBody, decision, resolved.systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching }),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision)),
        onAssistantText: assistantResponseCapture({
          identity,
          requestId,
          idempotencyKey,
          sessionId: context.sessionId,
          surface: openAIChatSurface.surface
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
        await requestStates.finish(idempotencyKey, "failed", { error: decision.error });
        sendRejectedDecision(decision, reply);
        return;
      }
      await pinSystemPrompt(persistence, identity, anthropicMessagesSurface.surface, requestId, context.sessionId, systemPrompt);

      const compressedBody = await compressForForward({
        events,
        tenantId: identity.organizationId,
        workspaceId: identity.workspaceId,
        requestId,
        idempotencyKey,
        sessionId: context.sessionId,
        surface: anthropicMessagesSurface.surface,
        body: request.body,
        enabled: resolved.toolResultCompression,
        deduplicateToolResults: resolved.duplicateToolResultReferences,
        profile: harnessProfileByName(context.harness),
        warn: (err, message) => app.log.warn({ err, requestId }, message)
      });
      await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        surface: anthropicMessagesSurface.surface,
        provider: routedProvider(decision),
        body: rewriteSurfaceRequest(compressedBody, decision, systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade, automaticCaching: resolved.automaticCaching }),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision)),
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
        await requestStates.finish(idempotencyKey, "failed", { error: decision.error });
        sendRejectedDecision(decision, reply);
        return;
      }

      // count_tokens applies the identical compression so the harness's token
      // count reflects what it will actually send — through the same guarded
      // path as /v1/messages so a throwing filter degrades identically — but
      // does not emit a compression.recorded event (that would double-count
      // against the paired /v1/messages call).
      const { body: countBody } = compressOrFallback(
        anthropicMessagesSurface.surface,
        request.body,
        resolved.toolResultCompression,
        (err, message) => app.log.warn({ err, requestId }, message),
        {
          deduplicateToolResults: resolved.duplicateToolResultReferences,
          profile: harnessProfileByName(context.harness)
        }
      );
      await proxy.forward({
        requestId,
        idempotencyKey,
        organizationId: identity.organizationId,
        surface: anthropicMessagesSurface.surface,
        provider: routedProvider(decision),
        body: rewriteTokenCountRequest(countBody, decision, systemPrompt, { upgradeCacheTtl: resolved.cacheTtlUpgrade }),
        headers: lowerHeaders(request.headers),
        decision,
        reply,
        path: "/messages/count_tokens",
        credential: await resolveUpstreamCredential(persistence, identity, routedProvider(decision))
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

function routedProvider(decision: { provider?: Provider }) {
  if (!decision.provider) throw new Error("Missing routed provider.");
  return decision.provider;
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const persistence = config.databaseUrl
    ? createPostgresPersistence(config.databaseUrl, config)
    : undefined;
  const app = buildServer(config, { persistence });
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
