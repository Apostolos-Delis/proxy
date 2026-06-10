import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { openAIResponsesSurface, rewriteSurfaceRequest } from "./adapters.js";
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
import { extractResponseText, type PromptArtifactStore } from "./persistence/promptArtifacts.js";
import { routingConfigSnapshot, type RoutingConfigResolver } from "./persistence/routingConfig.js";
import { appendPromptCaptureEvent } from "./promptCaptureEvents.js";
import type { RoutingService } from "./router.js";
import type { JsonObject, RouteDecision, RouteName } from "./types.js";
import { createId, headerValue, idempotencyFrom, isRecord, lowerHeaders } from "./util.js";

type ActiveRequest = {
  requestId: string;
  idempotencyKey: string;
  providerAttemptId: string;
  decision: RouteDecision;
  identity: RequestIdentity;
  sessionId?: string;
};

export class WebSocketRoutingProxy {
  constructor(
    private readonly config: AppConfig,
    private readonly auth: ProxyAuthService,
    private readonly routing: RoutingService,
    private readonly events: EventService,
    private readonly attempts: ProviderAttemptStore,
    private readonly requestStates: RequestStateStoreLike,
    private readonly promptArtifacts?: PromptArtifactStore,
    private readonly routingConfigs?: RoutingConfigResolver
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

    let upstreamHeaders: IncomingHttpHeaders = {};
    const upstream = new WebSocket(this.openAIWebSocketUrl(), {
      headers: this.upstreamHeaders(headers),
      perMessageDeflate: true
    });

    let accepted = false;
    upstream.once("upgrade", (response) => {
      upstreamHeaders = response.headers;
    });
    upstream.once("open", () => {
      accepted = true;
      const wss = new WebSocketServer({ noServer: true });
      wss.on("headers", (responseHeaders) => {
        appendUpgradeHeader(responseHeaders, upstreamHeaders, "x-codex-turn-state");
        appendUpgradeHeader(responseHeaders, upstreamHeaders, "x-models-etag");
        appendUpgradeHeader(responseHeaders, upstreamHeaders, "x-reasoning-included");
        appendUpgradeHeader(responseHeaders, upstreamHeaders, "openai-model");
      });
      wss.handleUpgrade(request, socket, head, (client) => {
        this.bridge(client, upstream, headers, identity);
      });
    });
    upstream.once("error", (error) => {
      if (!accepted) {
        rejectUpgrade(socket, 502, error instanceof Error ? error.message : "Upstream websocket failed");
      }
    });
  }

  private bridge(
    client: WebSocket,
    upstream: WebSocket,
    headers: Record<string, string | undefined>,
    identity: RequestIdentity
  ) {
    let messageIndex = 0;
    let connectionRoute: RouteName | undefined;
    let activeRequest: ActiveRequest | undefined;
    let sendQueue = Promise.resolve();

    client.on("message", (data, isBinary) => {
      if (isBinary) {
        sendError(client, 400, "binary_websocket_requests_are_not_supported");
        return;
      }
      messageIndex += 1;
      sendQueue = sendQueue
        .then(async () => {
          const route = await this.routeWebSocketMessage(data, headers, identity, connectionRoute, messageIndex);
          if (route.decision.finalRoute) connectionRoute = route.decision.finalRoute;
          activeRequest = route.activeRequest;
          upstream.send(JSON.stringify(route.body));
        })
        .catch((error) => {
          sendError(client, 500, error instanceof Error ? error.message : "websocket_routing_failed");
        });
    });

    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      if (!isBinary) {
        void this.observeUpstreamMessage(String(data), activeRequest).then((completed) => {
          if (completed) activeRequest = undefined;
        });
      }
    });

    client.once("close", () => {
      upstream.close();
      if (activeRequest) {
        void this.finishActiveRequest(activeRequest, "cancelled", undefined, { websocket: "client_closed" });
      }
    });
    upstream.once("close", () => {
      client.close();
      if (activeRequest) {
        void this.finishActiveRequest(activeRequest, "failed", undefined, { websocket: "upstream_closed" });
      }
    });
    upstream.once("error", (error) => {
      sendError(client, 502, error instanceof Error ? error.message : "upstream_websocket_failed");
    });
  }

  private async routeWebSocketMessage(
    data: RawData,
    headers: Record<string, string | undefined>,
    identity: RequestIdentity,
    connectionRoute: RouteName | undefined,
    messageIndex: number
  ) {
    const body = JSON.parse(String(data));
    const routeBody = pinnedRouteBody(body, connectionRoute);
    const requestId = createId("request");
    const idempotencyKey = scopedIdempotencyKey(identity.organizationId, idempotencyFrom(
      `${openAIResponsesSurface.createOperation}:websocket:${requestId}:${messageIndex}`,
      routeBody,
      headers
    ));
    const rawContext = openAIResponsesSurface.buildContext(routeBody, headers);
    const context = contextForIdentity(rawContext, identity);
    const gate = await this.requestStates.begin(idempotencyKey, requestId, context);
    if (gate.duplicate && (gate.state.status === "classifying" || gate.state.status === "provider_pending")) {
      throw new Error("duplicate_websocket_request_active");
    }

    await this.events.append({
      tenantId: identity.organizationId,
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
      requestId,
      surface: openAIResponsesSurface.surface,
      body: routeBody
    }) ?? [];
    await appendPromptCaptureEvent({
      events: this.events,
      identity,
      requestId,
      idempotencyKey,
      sessionId: context.sessionId,
      surface: openAIResponsesSurface.surface,
      artifacts: capturedArtifacts
    });

    const decision = await this.routing.decide({
      requestId,
      context,
      body: routeBody,
      idempotencyKey,
      routingConfig: await this.resolveRoutingConfig(identity)
    });
    if (decision.outcome === "reject") {
      await this.requestStates.finish(idempotencyKey, "failed", { error: decision.error });
      throw new Error(decision.error ?? "websocket_request_rejected");
    }

    const { attempt } = this.attempts.create({
      idempotencyKey,
      requestId,
      surface: openAIResponsesSurface.surface,
      provider: openAIResponsesSurface.provider,
      model: decision.selectedModel ?? "unknown"
    });
    if (!attempt) throw new Error("duplicate_websocket_request");

    await this.requestStates.markProviderPending(idempotencyKey, attempt.id);
    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      sessionId: context.sessionId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.provider",
      eventType: "provider.request_started",
      payload: {
        surface: openAIResponsesSurface.surface,
        provider: openAIResponsesSurface.provider,
        transport: "websocket",
        model: decision.selectedModel ?? "unknown",
        providerAttemptId: attempt.id
      }
    });
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
        provider: openAIResponsesSurface.provider,
        transport: "websocket",
        providerAttemptId: attempt.id
      }
    });

    return {
      body: rewriteSurfaceRequest(routeBody, decision),
      decision,
      activeRequest: {
        requestId,
        idempotencyKey,
        providerAttemptId: attempt.id,
        decision,
        identity,
        sessionId: context.sessionId
      }
    };
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
        requestId: activeRequest.requestId,
        surface: openAIResponsesSurface.surface,
        text
      });
      await appendPromptCaptureEvent({
        events: this.events,
        identity: activeRequest.identity,
        requestId: activeRequest.requestId,
        idempotencyKey: activeRequest.idempotencyKey,
        sessionId: activeRequest.sessionId,
        surface: openAIResponsesSurface.surface,
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
    const metadataPayload = jsonPayload(metadata) as JsonObject;
    const error = status === "completed" ? undefined : terminalError(metadataPayload);
    const payload: JsonObject = {
      surface: openAIResponsesSurface.surface,
      provider: openAIResponsesSurface.provider,
      selectedModel: activeRequest.decision.selectedModel ?? "unknown",
      providerAttemptId: activeRequest.providerAttemptId,
      terminalStatus: status,
      upstreamStatus: status === "completed" ? 200 : 0,
      usage: usage === undefined ? null : jsonPayload(usage)
    };
    if (error) payload.error = error;

    await this.events.append({
      scopeType: "request",
      scopeId: activeRequest.requestId,
      correlationId: activeRequest.requestId,
      idempotencyKey: activeRequest.idempotencyKey,
      producer: "prompt-proxy.provider",
      eventType: terminalEventType(status),
      payload,
      metadata: metadataPayload
    });
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
    this.attempts.update(activeRequest.providerAttemptId, {
      terminalStatus: status,
      usage: usage === undefined ? undefined : jsonPayload(usage),
      error
    });
    await this.requestStates.finish(activeRequest.idempotencyKey, status, {
      providerAttemptId: activeRequest.providerAttemptId,
      usage: usage === undefined ? undefined : jsonPayload(usage),
      error
    });
  }

  private openAIWebSocketUrl() {
    const url = new URL(`${this.config.openaiBaseUrl}/responses`);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    return url.toString();
  }

  private upstreamHeaders(incoming: Record<string, string | undefined>) {
    // BYOK does not apply to the realtime WebSocket surface yet; this path always
    // forwards with the company OpenAI key. See README "Provider Keys (BYOK)".
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.openaiApiKey}`
    };
    copyIfPresent(incoming, headers, "openai-beta");
    copyIfPresent(incoming, headers, "x-codex-turn-state");
    copyIfPresent(incoming, headers, "x-codex-turn-metadata");
    copyIfPresent(incoming, headers, "x-openai-subagent");
    copyIfPresent(incoming, headers, "x-request-id");
    copyIfPresent(incoming, headers, "traceparent");
    copyIfPresent(incoming, headers, "tracestate");
    copyIfPresent(incoming, headers, "session_id");
    copyIfPresent(incoming, headers, "x-client-request-id");
    return headers;
  }

  private async resolveRoutingConfig(identity: RequestIdentity) {
    const resolved = await this.routingConfigs?.resolve({
      organizationId: identity.organizationId,
      routingConfigId: identity.routingConfigId
    });
    return resolved
      ? {
          snapshot: routingConfigSnapshot(resolved),
          config: resolved.config
        }
      : undefined;
  }
}

function terminalEventType(status: "completed" | "failed" | "cancelled") {
  if (status === "completed") return "provider.response_completed";
  if (status === "cancelled") return "provider.response_cancelled";
  return "provider.response_failed";
}

function terminalError(metadata: JsonObject) {
  const error = metadata.error;
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return undefined;
  return JSON.stringify(error);
}

function pinnedRouteBody(body: unknown, connectionRoute: RouteName | undefined) {
  if (!connectionRoute || !isRecord(body) || typeof body.previous_response_id !== "string") {
    return body;
  }
  return {
    ...body,
    model: `router-${connectionRoute}`
  };
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

function copyIfPresent(
  from: Record<string, string | undefined>,
  to: Record<string, string>,
  key: string
) {
  const value = from[key.toLowerCase()] ?? from[key];
  if (value) to[key] = value;
}

function appendUpgradeHeader(
  responseHeaders: string[],
  upstreamHeaders: IncomingHttpHeaders,
  key: string
) {
  const value = headerValue(upstreamHeaders as Record<string, unknown>, key);
  if (value) responseHeaders.push(`${key}: ${value}`);
}
