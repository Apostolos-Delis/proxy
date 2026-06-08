import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { openAIResponsesSurface } from "./adapters.js";
import type { AppConfig } from "./config.js";
import { jsonPayload, type EventService, type ProviderAttemptStore, type RequestStateStore } from "./events.js";
import type { RoutingService } from "./router.js";
import type { JsonObject, RouteDecision, RouteName } from "./types.js";
import { createId, headerValue, idempotencyFrom, isRecord, lowerHeaders } from "./util.js";

type ActiveRequest = {
  requestId: string;
  idempotencyKey: string;
  providerAttemptId: string;
  decision: RouteDecision;
};

export class WebSocketRoutingProxy {
  constructor(
    private readonly config: AppConfig,
    private readonly routing: RoutingService,
    private readonly events: EventService,
    private readonly attempts: ProviderAttemptStore,
    private readonly requestStates: RequestStateStore
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
    if (!authorized(headers, this.config.proxyToken)) {
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
        this.bridge(client, upstream, headers);
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
    headers: Record<string, string | undefined>
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
          const route = await this.routeWebSocketMessage(data, headers, connectionRoute, messageIndex);
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
    connectionRoute: RouteName | undefined,
    messageIndex: number
  ) {
    const body = JSON.parse(String(data));
    const routeBody = pinnedRouteBody(body, connectionRoute);
    const requestId = createId("request");
    const idempotencyKey = idempotencyFrom(
      `${openAIResponsesSurface.createOperation}:websocket:${requestId}:${messageIndex}`,
      routeBody,
      headers
    );
    this.requestStates.begin(idempotencyKey);
    const context = openAIResponsesSurface.buildContext(routeBody, headers);

    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      sessionId: context.sessionId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.surface.openai-responses.websocket",
      eventType: "proxy.request_received",
      payload: {
        surface: "openai-responses",
        transport: "websocket",
        requestedModel: context.requestedModel,
        inputHash: context.inputHash,
        inputChars: context.inputChars
      }
    });

    const decision = await this.routing.decide({
      requestId,
      context,
      body: routeBody,
      idempotencyKey
    });
    if (decision.outcome === "reject") {
      this.requestStates.finish(idempotencyKey, "failed", { error: decision.error });
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

    this.requestStates.markProviderPending(idempotencyKey, attempt.id);
    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      sessionId: context.sessionId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.provider",
      eventType: "provider.request_started",
      payload: {
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
        provider: openAIResponsesSurface.provider,
        transport: "websocket",
        providerAttemptId: attempt.id
      }
    });

    return {
      body: this.routing.rewrite(routeBody, decision),
      decision,
      activeRequest: {
        requestId,
        idempotencyKey,
        providerAttemptId: attempt.id,
        decision
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
    if (event.type === "response.completed") {
      const response = isRecord(event.response) ? event.response : {};
      await this.finishActiveRequest(activeRequest, "completed", response.usage, {
        upstreamResponseId: typeof response.id === "string" ? response.id : undefined
      });
      return true;
    }
    if (event.type === "error") {
      await this.finishActiveRequest(activeRequest, "failed", undefined, {
        error: jsonPayload(event)
      });
      return true;
    }
    return false;
  }

  private async finishActiveRequest(
    activeRequest: ActiveRequest,
    status: "completed" | "failed" | "cancelled",
    usage: unknown,
    metadata: unknown
  ) {
    this.attempts.update(activeRequest.providerAttemptId, {
      terminalStatus: status,
      usage: usage === undefined ? undefined : jsonPayload(usage),
      error: status === "completed" ? undefined : JSON.stringify(metadata)
    });
    this.requestStates.finish(activeRequest.idempotencyKey, status, {
      providerAttemptId: activeRequest.providerAttemptId,
      usage: usage === undefined ? undefined : jsonPayload(usage),
      error: status === "completed" ? undefined : JSON.stringify(metadata)
    });
    await this.events.append({
      scopeType: "request",
      scopeId: activeRequest.requestId,
      correlationId: activeRequest.requestId,
      idempotencyKey: activeRequest.idempotencyKey,
      producer: "prompt-proxy.provider",
      eventType: status === "completed" ? "provider.response_completed" : "provider.response_failed",
      payload: {
        provider: openAIResponsesSurface.provider,
        selectedModel: activeRequest.decision.selectedModel ?? "unknown",
        providerAttemptId: activeRequest.providerAttemptId,
        upstreamStatus: status === "completed" ? 200 : 0,
        usage: usage === undefined ? null : jsonPayload(usage)
      },
      metadata: jsonPayload(metadata) as JsonObject
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
  }

  private openAIWebSocketUrl() {
    const url = new URL(`${this.config.openaiBaseUrl}/responses`);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    return url.toString();
  }

  private upstreamHeaders(incoming: Record<string, string | undefined>) {
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

function authorized(headers: Record<string, string | undefined>, token: string) {
  const auth = headers.authorization ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : auth;
  return bearer === token || headers["x-api-key"] === token;
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
