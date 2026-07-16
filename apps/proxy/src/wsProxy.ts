import type { IncomingMessage, Server } from "node:http";
import type { LookupFunction } from "node:net";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { openAIResponsesSurface } from "./adapters.js";
import {
  actorForIdentity,
  contextForIdentity,
  ProxyAuthService,
  scopedIdempotencyKey,
  type RequestIdentity
} from "./auth.js";
import type { AppConfig } from "./config.js";
import {
  type EventService,
  jsonPayload,
  type ProviderAttemptStore,
  type RequestStateStoreLike
} from "./events.js";
import {
  type GatewayExecutionTarget
} from "./gatewayRuntime.js";
import { gatewayProviderAttemptEvidence } from "./gatewayEvidence.js";
import {
  GatewayRequestLifecycle,
  GatewayRequestLifecycleError
} from "./gatewayRequestLifecycle.js";
import { extractResponseText, type PromptArtifactStore } from "./persistence/promptArtifacts.js";
import type {
  ProviderRegistryEndpoint,
  ProviderRegistryEntry
} from "./persistence/providers.js";
import { appendPromptCaptureEvent } from "./promptCaptureEvents.js";
import { providerRequestHeaders } from "./providerAdapters/genericHttp.js";
import {
  providerCompressionTerminalTelemetry,
  requestBodyHash
} from "./toolResultCompression.js";
import {
  TrafficLimitStore,
  type TrafficLimitLease
} from "./trafficLimits.js";
import type { JsonObject, RouteContext, UpstreamCredential } from "./types.js";
import {
  lookupForPinnedAddress,
  providerRequestPinnedAddress,
  providerRequestUrl
} from "./upstream.js";
import { createId, idempotencyFrom, isRecord, lowerHeaders } from "./util.js";

type ActiveRequest = {
  requestId: string;
  idempotencyKey: string;
  providerAttemptId: string;
  identity: RequestIdentity;
  target: GatewayExecutionTarget;
  sessionId?: string;
  harness?: RouteContext["harness"];
  harnessProfileId?: RouteContext["harnessProfileId"];
  transport?: RouteContext["transport"];
  compressionTelemetry: JsonObject;
  requestLimitLease: TrafficLimitLease;
  providerLimitLease: TrafficLimitLease;
  providerRequestForwarded?: boolean;
};

type WsLogger = { warn: (obj: unknown, msg?: string) => void };

export class WebSocketRoutingProxy {
  constructor(
    private readonly config: AppConfig,
    private readonly auth: ProxyAuthService,
    private readonly lifecycle: GatewayRequestLifecycle,
    private readonly events: EventService,
    private readonly attempts: ProviderAttemptStore,
    private readonly requestStates: RequestStateStoreLike,
    private readonly trafficLimits: TrafficLimitStore,
    private readonly promptArtifacts?: PromptArtifactStore,
    private readonly log?: WsLogger
  ) {}

  register(server: Server) {
    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const pathname = new URL(request.url ?? "/", "http://proxy.local").pathname;
    if (pathname !== "/v1/responses") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!this.lifecycle.available) {
      rejectUpgrade(socket, 503, "Gateway Unavailable");
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

    const wss = new WebSocketServer({ noServer: true });
    wss.handleUpgrade(request, socket, head, (client) => {
      this.bridge(client, headers, identity);
    });
  }

  private bridge(
    client: WebSocket,
    headers: Record<string, string | undefined>,
    identity: RequestIdentity
  ) {
    let messageIndex = 0;
    const fallbackSessionId = createId("ws-session");
    let activeRequest: ActiveRequest | undefined;
    let upstream: WebSocket | undefined;
    let upstreamTarget: WebSocketUpstreamTarget | undefined;
    let sendQueue = Promise.resolve();

    const attachUpstreamHandlers = (socket: WebSocket) => {
      socket.on("message", (data, isBinary) => {
        const request = activeRequest;
        if (!isBinary && isTerminalWebSocketMessage(String(data))) activeRequest = undefined;
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        if (!isBinary) {
          void this.observeUpstreamMessage(String(data), request);
        }
      });
      socket.once("close", () => {
        const request = activeRequest;
        activeRequest = undefined;
        client.close();
        if (request) {
          void this.finishActiveRequest(request, "failed", undefined, {
            websocket: "upstream_closed"
          });
        }
      });
      socket.once("error", (error) => {
        const request = activeRequest;
        activeRequest = undefined;
        sendError(client, 502, error instanceof Error ? error.message : "upstream_websocket_failed");
        if (request) {
          void this.finishActiveRequest(request, "failed", undefined, {
            error: error instanceof Error ? error.message : "upstream_websocket_failed"
          });
        }
      });
    };

    client.on("message", (data, isBinary) => {
      if (isBinary) {
        sendError(client, 400, "binary_websocket_requests_are_not_supported");
        return;
      }
      messageIndex += 1;
      let routedRequest: ActiveRequest | undefined;
      sendQueue = sendQueue
        .then(async () => {
          if (activeRequest) {
            throw new WebSocketGatewayError(409, "websocket_request_already_active");
          }
          const route = await this.routeWebSocketMessage(
            data,
            headers,
            identity,
            messageIndex,
            fallbackSessionId
          );
          routedRequest = route.activeRequest;
          activeRequest = routedRequest;
          if (
            !upstream ||
            !upstreamTarget ||
            !sameWebSocketTarget(upstreamTarget, route.upstreamTarget) ||
            upstream.readyState !== WebSocket.OPEN
          ) {
            if (upstream) {
              upstream.removeAllListeners();
              upstream.close();
            }
            upstream = await this.connectUpstream(route.upstreamTarget);
            upstreamTarget = route.upstreamTarget;
            attachUpstreamHandlers(upstream);
          }
          await this.appendProviderStreamStarted(route.activeRequest);
          await this.appendProviderRequestForwarded(route.activeRequest, route.body);
          route.activeRequest.providerRequestForwarded = true;
          upstream.send(JSON.stringify(route.body));
        })
        .catch(async (error) => {
          if (routedRequest) {
            await this.finishActiveRequest(routedRequest, "failed", undefined, {
              error: error instanceof Error ? error.message : "websocket_gateway_failed"
            });
            if (activeRequest === routedRequest) activeRequest = undefined;
          }
          sendError(
            client,
            webSocketErrorStatus(error),
            error instanceof Error ? error.message : "websocket_gateway_failed"
          );
        });
    });

    client.once("close", () => {
      if (upstream) {
        upstream.removeAllListeners();
        upstream.close();
      }
      const request = activeRequest;
      activeRequest = undefined;
      if (request) {
        void this.finishActiveRequest(request, "cancelled", undefined, {
          websocket: "client_closed"
        });
      }
    });
  }

  private async routeWebSocketMessage(
    data: RawData,
    headers: Record<string, string | undefined>,
    identity: RequestIdentity,
    messageIndex: number,
    fallbackSessionId: string
  ) {
    const body = JSON.parse(String(data));
    const requestId = createId("request");
    const idempotencyKey = scopedIdempotencyKey(
      identity.organizationId,
      identity.workspaceId,
      idempotencyFrom(
        `${openAIResponsesSurface.createOperation}:websocket:${requestId}:${messageIndex}`,
        body,
        headers
      )
    );
    const rawContext = openAIResponsesSurface.buildContext(body, headers, "websocket");
    const context = {
      ...contextForIdentity(rawContext, identity),
      transport: "websocket" as const
    };
    if (!context.sessionId) context.sessionId = fallbackSessionId;
    const trafficLimitInput = {
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      apiKeyId: identity.apiKeyId,
      userId: context.userId,
      accessProfileId: identity.accessProfileId ?? undefined,
      accessProfileLimits: identity.accessProfileLimits,
      estimatedTokens: context.estimatedInputTokens
    };
    const gate = await this.requestStates.begin(idempotencyKey, requestId, context);
    if (gate.duplicate && (
      gate.state.status === "classifying" ||
      gate.state.status === "provider_pending"
    )) {
      throw new Error("duplicate_websocket_request_active");
    }

    let activeRequestForFailure: ActiveRequest | undefined;
    let providerStarted = false;
    let requestTerminalized = false;
    let requestLimitLease: TrafficLimitLease | undefined;
    let providerLimitLease: TrafficLimitLease | undefined;
    try {
      const requestLimit = this.trafficLimits.acquire(trafficLimitInput);
      if (!requestLimit.allowed) {
        requestTerminalized = true;
        await this.requestStates.finish(idempotencyKey, "failed", {
          requestId,
          error: requestLimit.error
        });
        throw new WebSocketGatewayError(429, requestLimit.error);
      }
      requestLimitLease = requestLimit.lease;

      const prepared = await this.lifecycle.prepare({
        identity,
        rawContext,
        context,
        requestId,
        idempotencyKey,
        surface: openAIResponsesSurface,
        operationId: "text.generate",
        body,
        transport: "websocket"
      });
      if (prepared.outcome === "denied") {
        requestTerminalized = true;
        throw new WebSocketGatewayError(prepared.status, prepared.code);
      }
      const target = prepared.target;
      if (
        target.resolution.egressWireId !== openAIResponsesSurface.dialect ||
        target.providerEntry.adapterKind !== "generic-http-json"
      ) {
        throw new WebSocketGatewayError(503, "websocket_native_target_required");
      }

      const providerLimit = this.trafficLimits.acquire({
        ...trafficLimitInput,
        provider: target.provider,
        model: target.upstreamModelId
      }, "provider_model");
      if (!providerLimit.allowed) {
        requestTerminalized = true;
        await this.requestStates.finish(idempotencyKey, "failed", {
          requestId,
          error: providerLimit.error
        });
        throw new WebSocketGatewayError(429, providerLimit.error);
      }
      providerLimitLease = providerLimit.lease;

      const forwardedBody = prepared.body;
      const attempt = await this.lifecycle.startProviderAttempt({
        identity,
        context,
        requestId,
        idempotencyKey,
        surface: openAIResponsesSurface.surface,
        prepared,
        transport: "websocket"
      });
      const activeRequest: ActiveRequest = {
        requestId,
        idempotencyKey,
        providerAttemptId: attempt.id,
        identity,
        target,
        sessionId: context.sessionId,
        harness: context.harness,
        harnessProfileId: context.harnessProfileId,
        transport: context.transport,
        compressionTelemetry: prepared.compressionTelemetry,
        requestLimitLease,
        providerLimitLease
      };
      activeRequestForFailure = activeRequest;
      providerStarted = true;
      const upstreamTarget = this.resolveWebSocketUpstream(
        headers,
        forwardedBody,
        context.harnessProfileId,
        target
      );
      return {
        body: forwardedBody,
        activeRequest,
        upstreamTarget
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "websocket_gateway_failed";
      if (activeRequestForFailure && providerStarted) {
        await this.finishActiveRequest(activeRequestForFailure, "failed", undefined, { error: message });
      } else if (!requestTerminalized) {
        if (activeRequestForFailure) {
          this.attempts.update(activeRequestForFailure.providerAttemptId, {
            terminalStatus: "failed",
            error: message
          });
        }
        await this.requestStates.finish(idempotencyKey, "failed", { requestId, error: message });
      }
      providerLimitLease?.release();
      requestLimitLease?.release();
      throw error;
    }
  }

  private async appendProviderStreamStarted(activeRequest: ActiveRequest) {
    await this.events.append({
      tenantId: activeRequest.identity.organizationId,
      workspaceId: activeRequest.identity.workspaceId,
      scopeType: "request",
      scopeId: activeRequest.requestId,
      sessionId: activeRequest.sessionId,
      correlationId: activeRequest.requestId,
      idempotencyKey: activeRequest.idempotencyKey,
      actor: actorForIdentity(activeRequest.identity),
      producer: "proxy.provider",
      eventType: "provider.stream_started",
      payload: {
        surface: openAIResponsesSurface.surface,
        provider: activeRequest.target.provider,
        transport: "websocket",
        providerAttemptId: activeRequest.providerAttemptId
      }
    });
  }

  private resolveWebSocketUpstream(
    incoming: Record<string, string | undefined>,
    body: unknown,
    harnessProfileId: RouteContext["harnessProfileId"],
    target: GatewayExecutionTarget
  ): WebSocketUpstreamTarget {
    if (!("path" in target.endpoint)) throw new Error("websocket_http_endpoint_required");
    return {
      provider: target.provider,
      ...webSocketTargetUrl(
        target.providerEntry,
        target.endpoint,
        this.config,
        target.credential
      ),
      headers: providerRequestHeaders({
        config: this.config,
        provider: target.providerEntry,
        endpoint: target.endpoint,
        surface: openAIResponsesSurface.surface,
        harnessProfileId,
        body,
        incoming,
        credential: target.credential
      })
    };
  }

  private async appendProviderRequestForwarded(activeRequest: ActiveRequest, body: unknown) {
    await this.events.append({
      tenantId: activeRequest.identity.organizationId,
      workspaceId: activeRequest.identity.workspaceId,
      scopeType: "request",
      scopeId: activeRequest.requestId,
      sessionId: activeRequest.sessionId,
      correlationId: activeRequest.requestId,
      idempotencyKey: `${activeRequest.idempotencyKey}:provider-forwarded`,
      actor: actorForIdentity(activeRequest.identity),
      producer: "proxy.provider",
      eventType: "provider.request_forwarded",
      payload: {
        surface: openAIResponsesSurface.surface,
        provider: activeRequest.target.provider,
        transport: "websocket",
        model: activeRequest.target.upstreamModelId,
        providerAttemptId: activeRequest.providerAttemptId,
        upstreamAttempt: 1,
        preparedRequestHash: requestBodyHash(body),
        forwardedRequestHash: requestBodyHash(body),
        ...activeRequest.compressionTelemetry
      }
    });
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
        workspaceId: activeRequest.identity.workspaceId,
        requestId: activeRequest.requestId,
        surface: openAIResponsesSurface.surface,
        transport: activeRequest.transport,
        harness: activeRequest.harness,
        harnessProfileId: activeRequest.harnessProfileId,
        text
      });
      await appendPromptCaptureEvent({
        events: this.events,
        identity: activeRequest.identity,
        requestId: activeRequest.requestId,
        idempotencyKey: activeRequest.idempotencyKey,
        sessionId: activeRequest.sessionId,
        surface: openAIResponsesSurface.surface,
        transport: activeRequest.transport,
        harness: activeRequest.harness,
        harnessProfileId: activeRequest.harnessProfileId,
        artifacts
      });
    } catch {
      return;
    }
  }

  private async finishActiveRequest(
    activeRequest: ActiveRequest,
    status: "completed" | "failed" | "cancelled",
    usage: unknown,
    metadata: unknown
  ) {
    activeRequest.providerLimitLease.release();
    activeRequest.requestLimitLease.release();
    const metadataPayload = jsonPayload(metadata) as JsonObject;
    const error = status === "completed" ? undefined : terminalError(metadataPayload);
    const payload: JsonObject = {
      surface: openAIResponsesSurface.surface,
      provider: activeRequest.target.provider,
      selectedModel: activeRequest.target.upstreamModelId,
      providerAttemptId: activeRequest.providerAttemptId,
      terminalStatus: status,
      upstreamStatus: status === "completed" ? 200 : 0,
      usage: usage === undefined ? null : jsonPayload(usage),
      ...providerCompressionTerminalTelemetry(
        activeRequest.compressionTelemetry,
        activeRequest.providerRequestForwarded === true
      ),
      ...gatewayProviderAttemptEvidence(activeRequest.target)
    };
    if (error) payload.error = error;

    await this.events.append({
      tenantId: activeRequest.identity.organizationId,
      workspaceId: activeRequest.identity.workspaceId,
      scopeType: "request",
      scopeId: activeRequest.requestId,
      correlationId: activeRequest.requestId,
      idempotencyKey: activeRequest.idempotencyKey,
      actor: actorForIdentity(activeRequest.identity),
      producer: "proxy.provider",
      eventType: terminalEventType(status),
      payload,
      metadata: metadataPayload
    });
    if (usage !== undefined) {
      await this.events.append({
        tenantId: activeRequest.identity.organizationId,
        workspaceId: activeRequest.identity.workspaceId,
        scopeType: "request",
        scopeId: activeRequest.requestId,
        correlationId: activeRequest.requestId,
        idempotencyKey: activeRequest.idempotencyKey,
        actor: actorForIdentity(activeRequest.identity),
        producer: "proxy.usage",
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
      requestId: activeRequest.requestId,
      providerAttemptId: activeRequest.providerAttemptId,
      usage: usage === undefined ? undefined : jsonPayload(usage),
      error
    });
  }

  private connectUpstream(target: WebSocketUpstreamTarget) {
    const upstream = new WebSocket(target.url, {
      headers: target.headers,
      lookup: target.lookup,
      perMessageDeflate: true
    });
    return new Promise<WebSocket>((resolve, reject) => {
      const onOpen = () => {
        upstream.off("error", onError);
        resolve(upstream);
      };
      const onError = (error: Error) => {
        upstream.off("open", onOpen);
        reject(error);
      };
      upstream.once("open", onOpen);
      upstream.once("error", onError);
    });
  }
}

type WebSocketUpstreamTarget = {
  provider: string;
  url: string;
  headers: Record<string, string>;
  lookup?: LookupFunction;
};

function webSocketTargetUrl(
  provider: ProviderRegistryEntry,
  endpoint: ProviderRegistryEndpoint,
  config: AppConfig,
  credential?: UpstreamCredential
) {
  const pinnedAddress = providerRequestPinnedAddress({ provider, config, credential });
  const url = new URL(providerRequestUrl({ provider, endpoint, config, credential }));
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return {
    url: url.toString(),
    lookup: pinnedAddress ? lookupForPinnedAddress(pinnedAddress) : undefined
  };
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
      code: "proxy_error",
      message
    }
  }));
}

class WebSocketGatewayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function webSocketErrorStatus(error: unknown) {
  if (error instanceof WebSocketGatewayError) return error.status;
  if (error instanceof GatewayRequestLifecycleError) return error.statusCode;
  if (error instanceof SyntaxError) return 400;
  return 502;
}

function sameWebSocketTarget(left: WebSocketUpstreamTarget, right: WebSocketUpstreamTarget) {
  if (left.provider !== right.provider || left.url !== right.url) return false;
  const leftEntries = Object.entries(left.headers)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right.headers)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function isTerminalWebSocketMessage(text: string) {
  try {
    const event = JSON.parse(text);
    return isRecord(event) && (
      event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed" ||
      event.type === "error"
    );
  } catch {
    return false;
  }
}
