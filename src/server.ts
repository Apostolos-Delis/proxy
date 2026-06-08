import Fastify, { type FastifyReply } from "fastify";

import { anthropicMessagesSurface, openAIResponsesSurface } from "./adapters.js";
import { loadConfig, type AppConfig } from "./config.js";
import { buildModelCatalog } from "./catalog.js";
import { LlmClassifier } from "./classifier.js";
import { EventService, ProviderAttemptStore, RequestStateStore } from "./events.js";
import { BudgetService, SessionRouteStore } from "./policy.js";
import { ProjectionService } from "./projections.js";
import { ProviderProxy } from "./proxy.js";
import { RoutingService } from "./router.js";
import { createId, sha256, stableJson } from "./util.js";

export function buildServer(config: AppConfig = loadConfig()) {
  const modelCatalog = buildModelCatalog(config);
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 1024 * 1024 * 50
  });
  const events = new EventService(config.eventStorePath);
  const attempts = new ProviderAttemptStore();
  const requestStates = new RequestStateStore();
  const budget = new BudgetService(config);
  const sessions = new SessionRouteStore();
  const classifier = new LlmClassifier(config);
  const routing = new RoutingService(config, classifier, events, modelCatalog, budget, sessions);
  const proxy = new ProviderProxy(config, events, attempts, requestStates);
  const projections = new ProjectionService(modelCatalog, config);

  app.decorate("events", events);
  app.decorate("attempts", attempts);
  app.decorate("requestStates", requestStates);
  app.decorate("sessions", sessions);

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

  app.post("/v1/responses", async (request, reply) => {
    requireAuth(request.headers, config.proxyToken);
    const requestId = createId("request");
    const idempotencyKey = idempotencyFrom(
      openAIResponsesSurface.createOperation,
      request.body,
      request.headers
    );
    if (sendDuplicateRequest(requestStates, idempotencyKey, reply)) return;
    const context = openAIResponsesSurface.buildContext(request.body, lowerHeaders(request.headers));

    try {
      await events.append({
        scopeType: "request",
        scopeId: requestId,
        correlationId: requestId,
        idempotencyKey,
        producer: "prompt-proxy.surface.openai-responses",
        eventType: "proxy.request_received",
        payload: {
          surface: "openai-responses",
          requestedModel: context.requestedModel,
          inputHash: context.inputHash,
          inputChars: context.inputChars
        }
      });

      const decision = await routing.decide({
        requestId,
        context,
        body: request.body,
        idempotencyKey
      });
      if (decision.outcome === "reject") {
        requestStates.finish(idempotencyKey, "failed", { error: decision.error });
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
      requestStates.finish(idempotencyKey, "failed", {
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    }
  });

  app.post("/v1/messages", async (request, reply) => {
    requireAuth(request.headers, config.proxyToken);
    const requestId = createId("request");
    const idempotencyKey = idempotencyFrom(
      anthropicMessagesSurface.createOperation,
      request.body,
      request.headers
    );
    if (sendDuplicateRequest(requestStates, idempotencyKey, reply)) return;
    const context = anthropicMessagesSurface.buildContext(request.body, lowerHeaders(request.headers));

    try {
      await events.append({
        scopeType: "request",
        scopeId: requestId,
        sessionId: context.sessionId,
        correlationId: requestId,
        idempotencyKey,
        producer: "prompt-proxy.surface.anthropic-messages",
        eventType: "proxy.request_received",
        payload: {
          surface: "anthropic-messages",
          requestedModel: context.requestedModel,
          inputHash: context.inputHash,
          inputChars: context.inputChars
        }
      });

      const decision = await routing.decide({
        requestId,
        context,
        body: request.body,
        idempotencyKey
      });
      if (decision.outcome === "reject") {
        requestStates.finish(idempotencyKey, "failed", { error: decision.error });
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
      requestStates.finish(idempotencyKey, "failed", {
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    }
  });

  app.post("/v1/messages/count_tokens", async (request, reply) => {
    requireAuth(request.headers, config.proxyToken);
    const requestId = createId("request");
    const idempotencyKey = idempotencyFrom(
      anthropicMessagesSurface.countTokensOperation ?? anthropicMessagesSurface.createOperation,
      request.body,
      request.headers
    );
    if (sendDuplicateRequest(requestStates, idempotencyKey, reply)) return;
    const context = anthropicMessagesSurface.buildContext(request.body, lowerHeaders(request.headers));
    try {
      const decision = routing.tokenCountDecision(context);
      if (decision.outcome === "reject") {
        requestStates.finish(idempotencyKey, "failed", { error: decision.error });
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
      requestStates.finish(idempotencyKey, "failed", {
        error: error instanceof Error ? error.message : "Request failed."
      });
      throw error;
    }
  });

  return app;
}

function requireAuth(headers: Record<string, unknown>, token: string) {
  const auth = String(headers.authorization ?? "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : auth;
  const apiKey = String(headers["x-api-key"] ?? "");
  if (bearer !== token && apiKey !== token) {
    const error = new Error("Unauthorized");
    (error as Error & { statusCode: number }).statusCode = 401;
    throw error;
  }
}

function lowerHeaders(headers: Record<string, unknown>) {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key.toLowerCase()] = value;
  }
  return result;
}

function sendDuplicateRequest(
  requestStates: RequestStateStore,
  idempotencyKey: string,
  reply: FastifyReply
) {
  const gate = requestStates.begin(idempotencyKey);
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

function idempotencyFrom(
  surface: string,
  body: unknown,
  headers: Record<string, unknown>
) {
  const explicit =
    headers["idempotency-key"] ??
    headers["x-request-id"] ??
    headers["X-Request-Id"];

  if (typeof explicit === "string" && explicit.length > 0) {
    return sha256(`${surface}:explicit:${explicit}`);
  }
  const stableHeader = [
    headers["x-codex-turn-state"],
    headers["x-claude-code-session-id"],
    headers["x-claude-code-agent-id"]
  ]
    .filter((value): value is string => typeof value === "string")
    .join(":");
  return sha256(`${surface}:${stableHeader}:${stableJson(body)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = buildServer(config);
  await app.listen({ port: config.port, host: "0.0.0.0" });
}
