import type { FastifyReply } from "fastify";
import { performance } from "node:perf_hooks";

import { bufferedStreamResponse, collectStreamResponse } from "./bufferedStreamResponse.js";
import type { AppConfig } from "./config.js";
import {
  GatewayRequestLifecycle,
  GatewayRequestLifecycleError,
  type PreparedGatewayRequest
} from "./gatewayRequestLifecycle.js";
import {
  type EventAppender,
  type ProviderAttemptStore
} from "./events.js";
import {
  type ProviderRegistryEntry
} from "./persistence/providers.js";
import { extractResponseText } from "./persistence/promptArtifacts.js";
import {
  type MetricsCollector,
  NoopMetricsCollector
} from "./metrics.js";
import { canAuthenticateOrgProvider, GenericHttpProviderAdapter } from "./providerAdapters/genericHttp.js";
import { BedrockRuntimeProviderAdapter } from "./providerAdapters/bedrockRuntime.js";
import type {
  ProviderAdapterFailureClassification,
  ProviderForwardInput,
  ProviderForwardResult
} from "./providerAdapters/types.js";
import { ProviderMetrics } from "./providerMetrics.js";
import { sseObserverForDialect, streamObservationEventMetadata, type StreamObservation } from "./sseObserver.js";
import type { RequestIdentity } from "./auth.js";
import type { ProviderAttempt, RouteContext } from "./types.js";
import { isRecord } from "./util.js";

type TerminalAdapterMetadata = {
  adapterKind?: ProviderRegistryEntry["adapterKind"];
  adapterClassification?: ProviderAdapterFailureClassification;
};

type RuntimeProviderAdapter = GenericHttpProviderAdapter | BedrockRuntimeProviderAdapter;

type GatewayProviderForwardInput = Omit<
  ProviderForwardInput,
  "target" | "body"
> & {
  prepared: PreparedGatewayRequest;
  identity: RequestIdentity;
  context: RouteContext;
};

type GatewayProviderAttemptForwardInput = GatewayProviderForwardInput &
  Pick<ProviderForwardInput, "target" | "body">;

export class ProviderProxy {
  private readonly providerMetrics: ProviderMetrics;
  private readonly genericHttp: GenericHttpProviderAdapter;
  private readonly bedrockRuntime: BedrockRuntimeProviderAdapter;

  constructor(
    private readonly config: AppConfig,
    private readonly events: EventAppender,
    attempts: ProviderAttemptStore,
    private readonly lifecycle: GatewayRequestLifecycle,
    private readonly metrics: MetricsCollector = new NoopMetricsCollector(),
    providerAdapters: { bedrockRuntime?: BedrockRuntimeProviderAdapter } = {}
  ) {
    this.providerMetrics = new ProviderMetrics(attempts, metrics);
    this.genericHttp = new GenericHttpProviderAdapter(config, events);
    this.bedrockRuntime = providerAdapters.bedrockRuntime ?? new BedrockRuntimeProviderAdapter(config, events);
  }

  async forward(input: GatewayProviderForwardInput): Promise<ProviderForwardResult> {
    const providerLimitLease = await input.acquireProviderLimit?.(input.prepared.target);
    if (input.acquireProviderLimit && !providerLimitLease) return "rejected";
    try {
      let attempt: ProviderAttempt;
      try {
        attempt = await this.lifecycle.startProviderAttempt({
          identity: input.identity,
          context: input.context,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          surface: input.surface,
          prepared: input.prepared,
          transport: input.context.transport
        });
      } catch (error) {
        if (!(error instanceof GatewayRequestLifecycleError)) throw error;
        input.reply.code(error.statusCode).send({ error: error.message });
        return "rejected";
      }
      await this.forwardProviderAttempt(input, attempt);
      return "forwarded";
    } finally {
      providerLimitLease?.release();
    }
  }

  private async forwardProviderAttempt(
    baseInput: GatewayProviderForwardInput,
    attempt: ProviderAttempt
  ): Promise<void> {
    const prepared = baseInput.prepared;
    const selectedModel = prepared.target.upstreamModelId;
    const input: GatewayProviderAttemptForwardInput = {
      ...baseInput,
      target: prepared.target,
      body: prepared.body,
      compressionTelemetry: prepared.compressionTelemetry,
    };
    const providerStream = isRecord(input.body) && input.body.stream === true;
    const responseStream = input.responseStream ?? providerStream;

    this.providerMetrics.startAttempt({
      providerAttemptId: attempt.id,
      surface: input.surface,
      provider: input.target.provider,
      stream: responseStream
    });
    const abortController = new AbortController();
    let streamCompleted = false;
    let clientClosed = false;
    const abortUpstream = () => {
      clientClosed = true;
      if (!streamCompleted) abortController.abort();
    };
    const clientGone = () =>
      clientClosed ||
      abortController.signal.aborted ||
      input.reply.raw.destroyed ||
      (input.reply.raw as { closed?: boolean }).closed === true;
    input.reply.raw.once("close", abortUpstream);

    const resolvedProvider = input.target.providerEntry;
    const endpoint = input.target.endpoint;
    if (!resolvedProvider || !resolvedProvider.enabled || !endpoint) {
      const error = !resolvedProvider || !resolvedProvider.enabled
        ? "provider_not_found"
        : "provider_endpoint_not_found";
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      await this.failBeforeFetch(input, attempt.id, error, {
        adapterKind: resolvedProvider?.adapterKind ?? input.target.resolution.providerAdapterKind
      });
      return;
    }
    const providerAdapter = this.providerAdapterFor(resolvedProvider);
    if (!providerAdapter) {
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      await this.failBeforeFetch(input, attempt.id, "provider_adapter_not_supported", { adapterKind: resolvedProvider.adapterKind });
      return;
    }
    const responseTranslation = providerAdapter.responseTranslation({ endpoint, surface: input.surface });
    if (responseTranslation.kind === "unsupported") {
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      await this.failBeforeFetch(input, attempt.id, "translator_not_found", { adapterKind: resolvedProvider.adapterKind });
      return;
    }
    if (
      resolvedProvider.adapterKind !== "aws-bedrock-converse" &&
      !canAuthenticateOrgProvider(resolvedProvider, input.target.credential)
    ) {
      const error = "provider_credential_unresolved";
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      await this.failBeforeFetch(input, attempt.id, error, { adapterKind: resolvedProvider.adapterKind });
      return;
    }

    let upstream: Response;
    let providerTimedOut = false;
    const timeout = setTimeout(() => {
      providerTimedOut = true;
      abortController.abort();
    }, input.target.timeoutMs ?? 60_000);
    const fetchStartedAtMs = performance.now();
    try {
      input.timing?.markProviderFetchStart();
      upstream = await providerAdapter.fetchWithRateLimitRetries({
        input,
        providerAttemptId: attempt.id,
        provider: resolvedProvider,
        endpoint,
        signal: abortController.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      input.reply.raw.off("close", abortUpstream);
      const aborted = !providerTimedOut && clientGone();
      if (aborted) {
        this.providerMetrics.recordClientCancellation({
          surface: input.surface,
          stream: responseStream,
          stage: "before_provider"
        });
      }
      const adapterClassification = aborted
        ? undefined
        : providerAdapter.classifyFetchError({ error, timedOut: providerTimedOut });
      const adapterMetadata = {
        adapterKind: resolvedProvider.adapterKind,
        adapterClassification
      };
      await this.appendTerminal(input, attempt.id, aborted ? "cancelled" : "failed", undefined, 0, {
        error: error instanceof Error ? error.message : "Provider request failed."
      }, adapterMetadata);
      throw error;
    }
    clearTimeout(timeout);
    input.timing?.markFirstByte();
    this.providerMetrics.recordTimeToFirstByte({
      surface: input.surface,
      provider: input.target.provider,
      model: selectedModel,
      stream: responseStream,
      seconds: (performance.now() - fetchStartedAtMs) / 1000
    });

    const contentType = upstream.headers.get("content-type") ?? "";
    const isJson = contentType.includes("application/json");
    const isSse = contentType.includes("text/event-stream") || (
      upstream.ok &&
      providerStream &&
      !isJson
    );

    copyResponseHeaders(upstream, input.reply);
    input.reply.code(upstream.status);
    input.reply.header("x-proxy-model", selectedModel);
    input.reply.header("x-proxy-deployment", input.target.deploymentId);

    if (!isSse || !upstream.body) {
      if (providerStream) {
        this.providerMetrics.recordProtocolMismatch({
          surface: input.surface,
          provider: input.target.provider,
          model: selectedModel,
          stream: responseStream
        });
      }
      const upstreamText = await upstream.text();
      const text = upstream.ok
        ? providerAdapter.translateResponseText(upstreamText, responseTranslation)
        : upstreamText;
      const status = upstream.ok ? "completed" : "failed";
      const usage = tryExtractUsage(text);
      const error = upstream.ok ? undefined : errorExcerpt(text);
      const adapterClassification = status === "failed"
        ? providerAdapter.classifyResponse({
            status: upstream.status,
            headers: upstream.headers,
            bodyText: upstreamText,
            response: upstream
          })
        : undefined;
      const adapterMetadata = {
        adapterKind: resolvedProvider.adapterKind,
        adapterClassification
      };
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);

      await this.appendTerminal(input, attempt.id, status, usage, upstream.status, error ? { error } : {}, adapterMetadata);
      input.reply.send(text);
      if (status === "completed" && input.onAssistantText) {
        const assistantText = extractResponseText(input.surface, tryParseJson(text));
        if (assistantText) await input.onAssistantText(assistantText, false);
      }
      return;
    }

    await this.events.append({
      tenantId: input.organizationId,
      workspaceId: input.workspaceId,
      scopeType: "request",
      scopeId: input.requestId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      producer: "proxy.provider",
      eventType: "provider.stream_started",
      payload: {
        provider: input.target.provider,
        surface: input.surface,
        providerAttemptId: attempt.id
      }
    });

    const observer = sseObserverForDialect(input.surface);
    let completed = false;

    if (!responseStream) {
      try {
        const responseBody = providerAdapter.transformResponseStream(upstream.body, responseTranslation);
        const collected = await collectStreamResponse(responseBody, observer, input.surface);
        completed = true;
        const observation = collected.observation;
        const status = observation.status === "failed" ? "failed" : "completed";
        const adapterClassification = status === "failed"
          ? streamAdapterClassification(providerAdapter, upstream, observation)
          : undefined;
        const adapterMetadata = {
          adapterKind: resolvedProvider.adapterKind,
          adapterClassification
        };
        streamCompleted = true;
        input.reply.raw.off("close", abortUpstream);

        input.timing?.markStreamCompletion();
        await this.appendTerminal(input, attempt.id, status, observation.usage, upstream.status, withoutOutputText(observation), adapterMetadata);
        if (status === "completed" && collected.outputText && input.onAssistantText) {
          await input.onAssistantText(collected.outputText, false);
        }
        input.reply.header("content-type", "application/json; charset=utf-8");
        input.reply.send(bufferedStreamResponse(input.surface, selectedModel, status, observation, collected.outputText, collected.content));
      } catch (error) {
        const observation = observer.finish("cancelled");
        const message = error instanceof Error ? error.message : "Stream failed.";
        const aborted = clientGone();
        if (aborted) {
          this.providerMetrics.recordClientCancellation({
            surface: input.surface,
            stream: responseStream,
            stage: "after_headers"
          });
        }
        const adapterClassification = aborted
          ? undefined
          : providerAdapter.classifyMalformedResponse({ message, response: upstream });
        const adapterMetadata = {
          adapterKind: resolvedProvider.adapterKind,
          adapterClassification
        };
        await this.appendTerminal(
          input,
          attempt.id,
          aborted ? "cancelled" : "failed",
          observation.usage,
          upstream.status,
          {
            ...withoutOutputText(observation),
            error: message
          },
          adapterMetadata
        );
        throw error;
      } finally {
        input.reply.raw.off("close", abortUpstream);
        if (!completed && !abortController.signal.aborted) {
          await this.events.append({
            tenantId: input.organizationId,
            workspaceId: input.workspaceId,
            scopeType: "request",
            scopeId: input.requestId,
            correlationId: input.requestId,
            idempotencyKey: input.idempotencyKey,
            producer: "proxy.provider",
            eventType: "provider.terminal_reconcile_scheduled",
            payload: {
              providerAttemptId: attempt.id
            }
          });
        }
      }
      return;
    }

    input.reply.hijack();
    input.reply.raw.statusCode = upstream.status;
    input.reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    input.reply.raw.setHeader("x-proxy-model", selectedModel);
    input.reply.raw.setHeader("x-proxy-deployment", input.target.deploymentId);
    try {
      let observation: StreamObservation;
      let status: "completed" | "failed";
      let forwardedBytes = 0;
      try {
        const responseBody = providerAdapter.transformResponseStream(upstream.body, responseTranslation);
        for await (const chunk of responseBody) {
          const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
          forwardedBytes += bytes.byteLength;
          observer.observe(bytes);
          if (!input.reply.raw.write(bytes)) {
            await onceDrain(input.reply.raw);
          }
        }
        completed = true;
        observation = observer.finish();
        status = observation.status === "failed" ? "failed" : "completed";
        streamCompleted = true;
        input.reply.raw.off("close", abortUpstream);
      } catch (error) {
        const observation = observer.finish("cancelled");
        const message = error instanceof Error ? error.message : "Stream failed.";
        const aborted = clientGone();
        const status = aborted ? "cancelled" : "failed";
        input.timing?.markStreamCompletion();
        this.providerMetrics.recordStreamBytes({
          surface: input.surface,
          provider: input.target.provider,
          model: selectedModel,
          status,
          bytes: forwardedBytes
        });
        if (aborted) {
          this.providerMetrics.recordClientCancellation({
            surface: input.surface,
            stream: responseStream,
            stage: forwardedBytes > 0 ? "after_bytes" : "after_headers"
          });
        }
        const adapterClassification = aborted
          ? undefined
          : providerAdapter.classifyMalformedResponse({ message, response: upstream });
        const adapterMetadata = {
          adapterKind: resolvedProvider.adapterKind,
          adapterClassification
        };
        await this.appendTerminal(
          input,
          attempt.id,
          status,
          observation.usage,
          upstream.status,
          {
            ...withoutOutputText(observation),
            error: message
          },
          adapterMetadata
        );
        throw error;
      }
      this.providerMetrics.recordStreamBytes({
        surface: input.surface,
        provider: input.target.provider,
        model: selectedModel,
        status,
        bytes: forwardedBytes
      });
      input.timing?.markStreamCompletion();
      const adapterClassification = status === "failed"
        ? streamAdapterClassification(providerAdapter, upstream, observation)
        : undefined;
      const adapterMetadata = {
        adapterKind: resolvedProvider.adapterKind,
        adapterClassification
      };
      await this.appendTerminal(input, attempt.id, status, observation.usage, upstream.status, withoutOutputText(observation), adapterMetadata);
      if (status === "completed" && observation.outputText && input.onAssistantText) {
        await input.onAssistantText(observation.outputText, observation.outputTextTruncated ?? false);
      }
    } finally {
      input.reply.raw.off("close", abortUpstream);
      input.reply.raw.end();
      if (!completed && !abortController.signal.aborted) {
        await this.events.append({
          tenantId: input.organizationId,
          workspaceId: input.workspaceId,
          scopeType: "request",
          scopeId: input.requestId,
          correlationId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          producer: "proxy.provider",
          eventType: "provider.terminal_reconcile_scheduled",
          payload: {
            providerAttemptId: attempt.id
          }
        });
      }
    }
  }

  private async appendTerminal(
    input: GatewayProviderAttemptForwardInput,
    providerAttemptId: string,
    status: "completed" | "failed" | "cancelled",
    usage: unknown,
    upstreamStatus: number,
    metadata: unknown = {},
    adapterMetadata: TerminalAdapterMetadata = {}
  ) {
    try {
      const terminal = await this.lifecycle.finishProviderAttempt({
        identity: input.identity,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        surface: input.surface,
        target: input.target,
        providerAttemptId,
        status,
        usage,
        upstreamStatus,
        stream: isRecord(input.body) && input.body.stream === true,
        providerRequestForwarded: upstreamStatus > 0,
        metadata,
        compressionTelemetry: input.compressionTelemetry,
        ...adapterMetadata
      });

      const errorClass = this.providerMetrics.recordTerminal({
        surface: input.surface,
        provider: input.target.provider,
        model: input.target.upstreamModelId,
        providerAttemptId,
        status,
        usage,
        upstreamStatus,
        metadata: terminal.metadata
      });
      input.onTerminal?.({ status, errorClass });
    } finally {
      this.providerMetrics.clearAttempt(providerAttemptId);
    }
  }

  private async failBeforeFetch(
    input: GatewayProviderAttemptForwardInput,
    providerAttemptId: string,
    error: string,
    adapterMetadata: TerminalAdapterMetadata = {}
  ) {
    await this.appendTerminal(input, providerAttemptId, "failed", undefined, 0, { error }, adapterMetadata);
    input.reply.code(502).send({ error });
  }

  private providerAdapterFor(provider: ProviderRegistryEntry) {
    if (provider.adapterKind === "generic-http-json") return this.genericHttp;
    if (provider.adapterKind === "aws-bedrock-converse") return this.bedrockRuntime;
    return undefined;
  }
}

function copyResponseHeaders(upstream: Response, reply: FastifyReply) {
  for (const [key, value] of upstream.headers.entries()) {
    if (blockedResponseHeaders.has(key.toLowerCase())) continue;
    reply.header(key, value);
    reply.raw.setHeader(key, value);
  }
}

const blockedResponseHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "set-cookie2",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function streamAdapterClassification(
  adapter: RuntimeProviderAdapter,
  upstream: Response,
  observation: StreamObservation
) {
  if (observation.observerError) {
    return adapter.classifyMalformedResponse({ message: observation.observerError, response: upstream });
  }
  if (
    observation.status === "failed" &&
    observation.error &&
    "classifyStreamError" in adapter &&
    typeof adapter.classifyStreamError === "function"
  ) {
    return adapter.classifyStreamError({ message: observation.error, response: upstream });
  }
  if (upstream.status >= 400) {
    return adapter.classifyResponse({
      status: upstream.status,
      headers: upstream.headers,
      bodyText: observation.error,
      response: upstream
    });
  }
  return undefined;
}

// Prefer the provider's structured error message over the raw body so event
// payloads stay small and free of incidental request content.
function errorExcerpt(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = tryParseJson(trimmed);
  if (parsed && typeof parsed === "object") {
    const error = (parsed as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.slice(0, 500);
    }
    if (typeof error === "string" && error.trim()) return error.slice(0, 500);
  }
  return trimmed.slice(0, 500);
}

function tryExtractUsage(text: string) {
  const parsed = tryParseJson(text);
  if (parsed && typeof parsed === "object" && "usage" in parsed) {
    return (parsed as { usage: unknown }).usage;
  }
  return undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function withoutOutputText(observation: StreamObservation) {
  return streamObservationEventMetadata(observation);
}

function onceDrain(stream: NodeJS.WritableStream) {
  return new Promise<void>((resolve) => stream.once("drain", resolve));
}
