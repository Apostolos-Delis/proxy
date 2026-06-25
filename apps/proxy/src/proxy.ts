import type { FastifyReply } from "fastify";
import { performance } from "node:perf_hooks";
import type { ProviderHealthClassification } from "@proxy/schema";

import type { ProviderAdapter, ProviderForwardAttemptInput, ProviderForwardInput, ProviderForwardResult } from "./adapters.js";
import { bufferedStreamResponse, collectStreamResponse } from "./bufferedStreamResponse.js";
import type { AppConfig } from "./config.js";
import {
  type EventAppender,
  jsonPayload,
  type ProviderAttemptStore,
  type RequestStateStoreLike
} from "./events.js";
import {
  operatorTokenForProvider,
  ProviderRegistryError,
  providerEndpointForDialect,
  type ProviderRegistryEndpoint,
  type ProviderRegistryEntry,
  type ProviderRegistryResolver
} from "./persistence/providers.js";
import { extractResponseText } from "./persistence/promptArtifacts.js";
import {
  copySelectedHeaders,
  detectHarnessSurfaceProfile,
  dialectHeadersFor,
  harnessSurfaceProfileById,
  identityHeadersFor
} from "./harness.js";
import {
  type MetricsCollector,
  NoopMetricsCollector
} from "./metrics.js";
import { ProviderMetrics } from "./providerMetrics.js";
import { ProviderDeploymentHealthStore, type ProviderDeploymentFailureReason } from "./providerDeploymentHealth.js";
import { classifyProviderTerminalHealth } from "./providerHealth.js";
import { sseObserverForDialect, streamObservationEventMetadata, type StreamObservation } from "./sseObserver.js";
import { providerCompressionTerminalTelemetry, requestBodyHash } from "./toolResultCompression.js";
import { translators, type DialectTranslator } from "./translators/index.js";
import type { JsonObject, Provider, RouteDecision, RouteProviderAttempt, Surface, UpstreamCredential } from "./types.js";
import {
  fetchWithPinnedAddress,
  providerRequestPinnedAddress,
  providerRequestRedirect,
  providerRequestUrl
} from "./upstream.js";
import { isRecord } from "./util.js";

export class ProviderProxy implements ProviderAdapter {
  private readonly providerMetrics: ProviderMetrics;

  constructor(
    private readonly config: AppConfig,
    private readonly events: EventAppender,
    private readonly attempts: ProviderAttemptStore,
    private readonly requestStates: RequestStateStoreLike,
    private readonly providerRegistry: ProviderRegistryResolver,
    metrics: MetricsCollector = new NoopMetricsCollector(),
    private readonly deploymentHealth = new ProviderDeploymentHealthStore()
  ) {
    this.providerMetrics = new ProviderMetrics(config, attempts, metrics);
  }

  async forward(input: ProviderForwardInput): Promise<ProviderForwardResult> {
    const attempts = providerForwardAttempts(input);
    if (attempts.length === 0) {
      input.reply.code(500).send({ error: "Missing selected model." });
      return "rejected";
    }

    const maxAttempts = Math.max(1, Math.min(input.retryPolicy?.maxAttempts ?? 1, attempts.length));
    let lastError: unknown;
    for (let index = 0; index < maxAttempts; index += 1) {
      const selected = attempts[index];
      const providerLimitLease = await input.acquireProviderLimit?.(selected);
      if (input.acquireProviderLimit && !providerLimitLease) return "rejected";
      try {
        const result = await this.forwardProviderAttempt(input, selected, index, maxAttempts, index + 1 < maxAttempts);
        if (result.retry) {
          lastError = result.error;
          continue;
        }
        return "forwarded";
      } finally {
        providerLimitLease?.release();
      }
    }
    if (lastError) throw lastError;
    return "forwarded";
  }

  private async forwardProviderAttempt(
    input: ProviderForwardInput,
    selected: ProviderForwardAttemptInput,
    attemptIndex: number,
    maxAttempts: number,
    retryAvailable: boolean
  ): Promise<{ retry: boolean; error?: unknown }> {
    const providerSettings = selected.providerSettings ?? input.decision.providerSettings;
    if (!providerSettings) {
      input.reply.code(500).send({ error: "Missing selected provider settings." });
      return { retry: false };
    }
    const selectedModel = selected.selectedModel;
    input = {
      ...input,
      provider: selected.provider,
      body: selected.body,
      credential: selected.credential ?? input.credential,
      decision: {
        ...input.decision,
        finalRoute: selected.route ?? input.decision.finalRoute,
        selectedModel,
        provider: selected.provider,
        deployment: selected.deployment ?? input.decision.deployment,
        reasoningEffort: selected.reasoningEffort ?? input.decision.reasoningEffort,
        providerSettings
      }
    };
    const targetDialect = providerSettings.dialect;
    const providerStream = isRecord(input.body) && input.body.stream === true;
    const responseStream = input.responseStream ?? providerStream;
    const providerAccountId = input.credential?.providerAccountId;

    const { attempt, duplicate } = this.attempts.create({
      idempotencyKey: `${input.idempotencyKey}:provider-attempt:${attemptIndex}`,
      requestId: input.requestId,
      surface: input.surface,
      provider: input.provider,
      model: selectedModel,
      providerAccountId
    });

    if (!attempt || duplicate) {
      input.reply.code(409).send({ error: "Duplicate request is still active." });
      return { retry: false };
    }
    this.providerMetrics.startAttempt({
      providerAttemptId: attempt.id,
      surface: input.surface,
      provider: input.provider,
      stream: responseStream
    });

    const routeCandidateId = input.decision.routeExecutionPlan?.selected?.candidateId;
    const providerRequestStartedPayload: JsonObject = {
      surface: input.surface,
      provider: input.provider,
      model: selectedModel,
      providerAttemptId: attempt.id,
      preparedRequestHash: requestBodyHash(input.body),
      attemptIndex: 0,
      fallbackIndex: attemptIndex,
      retryAttempt: attemptIndex + 1,
      retryMaxAttempts: maxAttempts,
      route: selected.route ?? input.decision.finalRoute ?? null,
      deployment: selected.deployment ? jsonPayload(selected.deployment) : null
    };
    if (routeCandidateId !== undefined) providerRequestStartedPayload.routeCandidateId = routeCandidateId;
    if (providerAccountId) providerRequestStartedPayload.providerAccountId = providerAccountId;

    await this.events.append({
      scopeType: "request",
      scopeId: input.requestId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      producer: "proxy.provider",
      eventType: "provider.request_started",
      payload: providerRequestStartedPayload
    });
    await this.requestStates.markProviderPending(input.idempotencyKey, attempt.id, input.requestId);

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

    let resolvedProvider: ProviderRegistryEntry | undefined;
    try {
      resolvedProvider = await this.providerRegistry.resolve({
        organizationId: input.organizationId,
        provider: input.provider
      });
    } catch (error) {
      const message = error instanceof ProviderRegistryError ? error.code : "provider_registry_resolution_failed";
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      await this.failBeforeFetch(input, attempt.id, message);
      return { retry: false };
    }
    const endpoint = resolvedProvider ? providerEndpointForDialect(resolvedProvider, targetDialect) : undefined;
    if (!resolvedProvider || !resolvedProvider.enabled || !endpoint) {
      const error = !resolvedProvider || !resolvedProvider.enabled
        ? "provider_not_found"
        : "provider_endpoint_not_found";
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      await this.failBeforeFetch(input, attempt.id, error);
      return { retry: false };
    }
    const responseTranslator = endpoint.dialect === input.surface
      ? undefined
      : translators.get(endpoint.dialect, input.surface);
    if (endpoint.dialect !== input.surface && !responseTranslator) {
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      await this.failBeforeFetch(input, attempt.id, "translator_not_found");
      return { retry: false };
    }
    if (!canAuthenticateOrgProvider(resolvedProvider, input.credential)) {
      const error = "provider_credential_unresolved";
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      await this.failBeforeFetch(input, attempt.id, error);
      return { retry: false };
    }

    let upstream: Response;
    let providerTimedOut = false;
    const timeout = selected.deployment?.timeoutMs
      ? setTimeout(() => {
          providerTimedOut = true;
          abortController.abort();
        }, selected.deployment.timeoutMs)
      : undefined;
    const fetchStartedAtMs = performance.now();
    try {
      input.timing?.markProviderFetchStart();
      const requestProvider = providerForDeployment(resolvedProvider, selected.deployment);
      upstream = await this.fetchWithRateLimitRetries({
        input,
        providerAttemptId: attempt.id,
        provider: requestProvider,
        endpoint,
        signal: abortController.signal
      });
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      input.reply.raw.off("close", abortUpstream);
      const aborted = !providerTimedOut && clientGone();
      const failureReason = transportFailureReason(providerTimedOut, aborted);
      if (failureReason) this.deploymentHealth.recordFailure(selected.deployment, failureReason);
      if (aborted) {
        this.providerMetrics.recordClientCancellation({
          surface: input.surface,
          stream: responseStream,
          stage: "before_provider"
        });
      }
      await this.appendTerminal(input, attempt.id, aborted ? "cancelled" : "failed", undefined, 0, {
        error: error instanceof Error ? error.message : "Provider request failed."
      });
      this.attempts.update(attempt.id, {
        terminalStatus: aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : "Provider request failed."
      });
      if (retryAvailable && failureReason) return { retry: true, error };
      await this.requestStates.finish(input.idempotencyKey, aborted ? "cancelled" : "failed", {
        requestId: input.requestId,
        providerAttemptId: attempt.id,
        error: error instanceof Error ? error.message : "Provider request failed."
      });
      throw error;
    }
    if (timeout) clearTimeout(timeout);
    input.timing?.markFirstByte();
    this.providerMetrics.recordTimeToFirstByte({
      surface: input.surface,
      provider: input.provider,
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
    input.reply.header("x-proxy-route", input.decision.finalRoute ?? "");
    if (selected.deployment) {
      input.reply.header("x-proxy-deployment", selected.deployment.key);
    }
    if (input.decision.reasoningEffort) {
      input.reply.header("x-proxy-reasoning-effort", input.decision.reasoningEffort);
    }

    if (!isSse || !upstream.body) {
      if (providerStream) {
        this.providerMetrics.recordProtocolMismatch({
          surface: input.surface,
          provider: input.provider,
          model: selectedModel,
          stream: responseStream
        });
      }
      const upstreamText = await upstream.text();
      const text = upstream.ok && responseTranslator
        ? translateResponseText(upstreamText, responseTranslator)
        : upstreamText;
      const status = upstream.ok ? "completed" : "failed";
      const canRetryStatus = retryableStatus(upstream.status, input.retryPolicy?.retryableStatusCodes);
      const usage = tryExtractUsage(text);
      const error = upstream.ok ? undefined : errorExcerpt(text);
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);

      this.recordDeploymentStatus(selected, status, upstream.status, canRetryStatus);
      await this.appendTerminal(input, attempt.id, status, usage, upstream.status, error ? { error } : {});
      this.attempts.update(attempt.id, {
        terminalStatus: status,
        usage: usage === undefined ? undefined : jsonPayload(usage),
        error
      });
      if (status === "failed" && retryAvailable && canRetryStatus) return { retry: true };
      await this.requestStates.finish(input.idempotencyKey, status, {
        requestId: input.requestId,
        providerAttemptId: attempt.id,
        usage: usage === undefined ? undefined : jsonPayload(usage),
        error
      });
      input.reply.send(text);
      if (status === "completed" && input.onAssistantText) {
        const assistantText = extractResponseText(input.surface, tryParseJson(text));
        if (assistantText) await input.onAssistantText(assistantText, false);
      }
      return { retry: false };
    }

    await this.events.append({
      scopeType: "request",
      scopeId: input.requestId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      producer: "proxy.provider",
      eventType: "provider.stream_started",
      payload: {
        provider: input.provider,
        surface: input.surface,
        providerAttemptId: attempt.id
      }
    });

    const observer = sseObserverForDialect(input.surface);
    let completed = false;

    if (!responseStream) {
      try {
        const responseBody = responseTranslator
          ? responseTranslator.sseTransform(upstream.body)
          : upstream.body;
        const collected = await collectStreamResponse(responseBody, observer, input.surface);
        completed = true;
        const observation = collected.observation;
        const status = observation.status === "failed" ? "failed" : "completed";
        const canRetryStatus = retryableStatus(upstream.status, input.retryPolicy?.retryableStatusCodes);
        streamCompleted = true;
        input.reply.raw.off("close", abortUpstream);

        input.timing?.markStreamCompletion();
        this.recordDeploymentStatus(selected, status, upstream.status, canRetryStatus);
        await this.appendTerminal(input, attempt.id, status, observation.usage, upstream.status, withoutOutputText(observation));
        this.attempts.update(attempt.id, {
          terminalStatus: status,
          usage: observation.usage,
          upstreamRequestId: observation.upstreamResponseId,
          error: observation.error
        });
        if (status === "failed" && retryAvailable && canRetryStatus) return { retry: true };
        await this.requestStates.finish(input.idempotencyKey, status, {
          requestId: input.requestId,
          providerAttemptId: attempt.id,
          usage: observation.usage,
          upstreamRequestId: observation.upstreamResponseId,
          error: observation.error
        });
        if (status === "completed" && collected.outputText && input.onAssistantText) {
          await input.onAssistantText(collected.outputText, false);
        }
        input.reply.header("content-type", "application/json; charset=utf-8");
        input.reply.send(bufferedStreamResponse(input.surface, selectedModel, status, observation, collected.outputText, collected.content));
      } catch (error) {
        const observation = observer.finish("cancelled");
        const message = error instanceof Error ? error.message : "Stream failed.";
        const aborted = clientGone();
        const failureReason = transportFailureReason(false, aborted);
        if (failureReason) this.deploymentHealth.recordFailure(selected.deployment, failureReason);
        if (aborted) {
          this.providerMetrics.recordClientCancellation({
            surface: input.surface,
            stream: responseStream,
            stage: "after_headers"
          });
        }
        await this.appendTerminal(
          input,
          attempt.id,
          aborted ? "cancelled" : "failed",
          observation.usage,
          upstream.status,
          {
            ...withoutOutputText(observation),
            error: message
          }
        );
        this.attempts.update(attempt.id, {
          terminalStatus: aborted ? "cancelled" : "failed",
          usage: observation.usage,
          error: message
        });
        if (retryAvailable && failureReason) return { retry: true, error };
        await this.requestStates.finish(input.idempotencyKey, aborted ? "cancelled" : "failed", {
          requestId: input.requestId,
          providerAttemptId: attempt.id,
          usage: observation.usage,
          error: message
        });
        throw error;
      } finally {
        input.reply.raw.off("close", abortUpstream);
        if (!completed && !abortController.signal.aborted) {
          await this.events.append({
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
      return { retry: false };
    }

    input.reply.hijack();
    input.reply.raw.statusCode = upstream.status;
    input.reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    input.reply.raw.setHeader("x-proxy-model", selectedModel);
    input.reply.raw.setHeader("x-proxy-route", input.decision.finalRoute ?? "");
    if (selected.deployment) {
      input.reply.raw.setHeader("x-proxy-deployment", selected.deployment.key);
    }
    if (input.decision.reasoningEffort) {
      input.reply.raw.setHeader("x-proxy-reasoning-effort", input.decision.reasoningEffort);
    }
    try {
      let observation: StreamObservation;
      let status: "completed" | "failed";
      let forwardedBytes = 0;
      try {
        const responseBody = responseTranslator
          ? responseTranslator.sseTransform(upstream.body)
          : upstream.body;
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
        const failureReason = transportFailureReason(false, aborted);
        if (failureReason) this.deploymentHealth.recordFailure(selected.deployment, failureReason);
        input.timing?.markStreamCompletion();
        this.providerMetrics.recordStreamBytes({
          surface: input.surface,
          provider: input.provider,
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
        await this.appendTerminal(
          input,
          attempt.id,
          status,
          observation.usage,
          upstream.status,
          {
            ...withoutOutputText(observation),
            error: message
          }
        );
        this.attempts.update(attempt.id, {
          terminalStatus: status,
          usage: observation.usage,
          error: message
        });
        await this.requestStates.finish(input.idempotencyKey, status, {
          requestId: input.requestId,
          providerAttemptId: attempt.id,
          usage: observation.usage,
          error: message
        });
        throw error;
      }
      this.providerMetrics.recordStreamBytes({
        surface: input.surface,
        provider: input.provider,
        model: selectedModel,
        status,
        bytes: forwardedBytes
      });
      input.timing?.markStreamCompletion();
      this.recordDeploymentStatus(selected, status, upstream.status, retryableStatus(upstream.status, input.retryPolicy?.retryableStatusCodes));
      await this.appendTerminal(input, attempt.id, status, observation.usage, upstream.status, withoutOutputText(observation));
      this.attempts.update(attempt.id, {
        terminalStatus: status,
        usage: observation.usage,
        upstreamRequestId: observation.upstreamResponseId,
        error: observation.error
      });
      await this.requestStates.finish(input.idempotencyKey, status, {
        requestId: input.requestId,
        providerAttemptId: attempt.id,
        usage: observation.usage,
        upstreamRequestId: observation.upstreamResponseId,
        error: observation.error
      });
      if (status === "completed" && observation.outputText && input.onAssistantText) {
        await input.onAssistantText(observation.outputText, observation.outputTextTruncated ?? false);
      }
    } finally {
      input.reply.raw.off("close", abortUpstream);
      input.reply.raw.end();
      if (!completed && !abortController.signal.aborted) {
        await this.events.append({
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
    return { retry: false };
  }

  private async appendTerminal(
    input: {
      requestId: string;
      idempotencyKey: string;
      organizationId: string;
      workspaceId: string;
      surface: Surface;
      provider: Provider;
      decision: RouteDecision;
      compressionTelemetry?: JsonObject;
      onTerminal?: ProviderForwardInput["onTerminal"];
      credential?: UpstreamCredential;
    },
    providerAttemptId: string,
    status: "completed" | "failed" | "cancelled",
    usage: unknown,
    upstreamStatus: number,
    metadata: unknown = {}
  ) {
    const metadataPayload = jsonPayload(metadata) as JsonObject;
    const payload: JsonObject = {
      provider: input.provider,
      surface: input.surface,
      selectedModel: input.decision.selectedModel ?? "unknown",
      providerAttemptId,
      terminalStatus: status,
      upstreamStatus,
      usage: usage === undefined ? null : jsonPayload(usage)
    };
    Object.assign(payload, providerCompressionTerminalTelemetry(input.compressionTelemetry, upstreamStatus > 0));
    if (input.credential?.providerAccountId) payload.providerAccountId = input.credential.providerAccountId;
    const error = terminalError(metadataPayload);
    if (error) payload.error = error;
    const healthClassification = classifyProviderTerminalHealth({
      provider: input.provider,
      model: input.decision.selectedModel ?? "unknown",
      terminalStatus: status,
      statusCode: upstreamStatus,
      error,
      now: new Date()
    });
    if (healthClassification) payload.healthClassification = jsonPayload(healthClassification);

    try {
      await this.events.append({
        scopeType: "request",
        scopeId: input.requestId,
        correlationId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        producer: "proxy.provider",
        eventType: terminalEventType(status),
        payload,
        metadata: metadataPayload
      });
      await this.appendHealthEvent(input, providerAttemptId, healthClassification);

      if (usage !== undefined) {
        await this.events.append({
          scopeType: "request",
          scopeId: input.requestId,
          correlationId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          producer: "proxy.usage",
          eventType: "usage.recorded",
          payload: {
            providerAttemptId,
            usage: jsonPayload(usage)
          }
        });
      }

      const errorClass = this.providerMetrics.recordTerminal({
        surface: input.surface,
        provider: input.provider,
        decision: input.decision,
        providerAttemptId,
        status,
        usage,
        upstreamStatus,
        metadata: metadataPayload
      });
      input.onTerminal?.({ status, errorClass });
    } finally {
      this.providerMetrics.clearAttempt(providerAttemptId);
    }
  }

  private async appendHealthEvent(
    input: {
      requestId: string;
      idempotencyKey: string;
      organizationId: string;
      workspaceId: string;
      provider: Provider;
      decision: RouteDecision;
      credential?: UpstreamCredential;
    },
    providerAttemptId: string,
    classification: ProviderHealthClassification | undefined
  ) {
    const providerAccountId = input.credential?.providerAccountId;
    if (!providerAccountId || !classification) return;
    if (classification.scope === "request_only" || classification.scope === "provider") return;

    const selectedModel = input.decision.selectedModel ?? "unknown";
    const eventType = healthEventType(classification);
    if (!eventType) return;

    await this.events.append({
      tenantId: input.organizationId,
      workspaceId: input.workspaceId,
      scopeType: classification.scope === "provider_account" ? "provider_account" : "provider_model",
      scopeId: classification.scope === "provider_account" ? providerAccountId : `${providerAccountId}:${selectedModel}`,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      producer: "proxy.provider-health",
      eventType,
      payload: {
        provider: input.provider,
        providerAccountId,
        model: selectedModel,
        providerAttemptId,
        classification: jsonPayload(classification)
      }
    });
  }

  private async failBeforeFetch(
    input: ProviderForwardInput,
    providerAttemptId: string,
    error: string
  ) {
    await this.appendTerminal(input, providerAttemptId, "failed", undefined, 0, { error });
    this.attempts.update(providerAttemptId, {
      terminalStatus: "failed",
      error
    });
    await this.requestStates.finish(input.idempotencyKey, "failed", {
      requestId: input.requestId,
      providerAttemptId,
      error
    });
    input.reply.code(502).send({ error });
  }

  private recordDeploymentStatus(
    selected: ProviderForwardAttemptInput,
    status: "completed" | "failed" | "cancelled",
    upstreamStatus: number,
    retryable: boolean
  ) {
    if (status === "completed") {
      this.deploymentHealth.recordSuccess(selected.deployment);
      return;
    }
    const failureReason = deploymentFailureReason(upstreamStatus, retryable);
    if (failureReason) this.deploymentHealth.recordFailure(selected.deployment, failureReason);
  }

  private async fetchWithRateLimitRetries({
    input,
    providerAttemptId,
    provider,
    endpoint,
    signal
  }: {
    input: ProviderForwardInput;
    providerAttemptId: string;
    provider: ProviderRegistryEntry;
    endpoint: ProviderRegistryEndpoint;
    signal: AbortSignal;
  }) {
    const maxAttempts = this.config.providerRateLimitMaxAttempts;

    for (let upstreamAttempt = 1; upstreamAttempt <= maxAttempts; upstreamAttempt += 1) {
      const body = providerRequestBody({
        provider,
        body: input.body,
        credential: input.credential
      });
      await this.events.append({
        scopeType: "request",
        scopeId: input.requestId,
        correlationId: input.requestId,
        idempotencyKey: `${input.idempotencyKey}:provider-forwarded:${upstreamAttempt}`,
        producer: "proxy.provider",
        eventType: "provider.request_forwarded",
        payload: {
          surface: input.surface,
          provider: input.provider,
          model: input.decision.selectedModel ?? "unknown",
          providerAttemptId,
          upstreamAttempt,
          preparedRequestHash: requestBodyHash(input.body),
          forwardedRequestHash: requestBodyHash(body),
          ...input.compressionTelemetry
        }
      });
      const upstream = await fetchWithPinnedAddress(providerRequestUrl({
        provider,
        endpoint,
        path: input.path,
        config: this.config,
        credential: input.credential
      }), {
        method: "POST",
        headers: providerRequestHeaders({
          config: this.config,
          provider,
          endpoint,
          surface: input.surface,
          harnessProfileId: input.harnessProfileId,
          body,
          incoming: input.headers,
          credential: input.credential
        }),
        body: JSON.stringify(body),
        redirect: providerRequestRedirect({ provider, credential: input.credential }),
        signal
      }, providerRequestPinnedAddress({ provider, config: this.config, credential: input.credential }));

      if (upstream.status !== 429 || upstreamAttempt === maxAttempts) {
        return upstream;
      }

      const delayMs = rateLimitRetryDelayMs({
        headers: upstream.headers,
        provider: provider.slug,
        maxDelayMs: this.config.providerRateLimitMaxDelayMs
      });
      if (delayMs === undefined) return upstream;

      await discardBody(upstream);
      await this.events.append({
        scopeType: "request",
        scopeId: input.requestId,
        correlationId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        producer: "proxy.provider",
        eventType: "provider.rate_limit_retry_scheduled",
        payload: {
          surface: input.surface,
          provider: input.provider,
          model: input.decision.selectedModel ?? "unknown",
          providerAttemptId,
          upstreamAttempt,
          maxAttempts,
          upstreamStatus: upstream.status,
          retryDelayMs: delayMs,
          rateLimit: jsonPayload(rateLimitHeaders(upstream.headers))
        }
      });
      await sleep(delayMs, signal);
    }

    throw new Error("Provider rate-limit retry loop exhausted.");
  }
}

export function providerRequestBody(input: {
  provider: ProviderRegistryEntry;
  body: unknown;
  credential?: UpstreamCredential;
}) {
  const credentialForProvider = input.credential && input.credential.provider === input.provider.slug
    ? input.credential
    : undefined;
  if (!isOpenAIChatGPTCredential(input.provider, credentialForProvider)) return input.body;
  if (!isRecord(input.body)) return input.body;
  const body = { ...input.body };
  if (body.prompt_cache_retention !== undefined) delete body.prompt_cache_retention;
  if (body.max_output_tokens !== undefined) delete body.max_output_tokens;
  return body;
}

// Claude Code sends this beta flag natively, but translated harnesses (Codex, etc.) do
// not — and Anthropic rejects OAuth /v1/messages requests without it — so inject it
// wherever the proxy forwards an Anthropic subscription OAuth bearer.
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

function mergeBetaTokens(existing: string | undefined, value: string) {
  const tokens = (existing ?? "").split(",").map((token) => token.trim()).filter(Boolean);
  if (!tokens.includes(value)) tokens.push(value);
  return tokens.join(",");
}

export function providerRequestHeaders(input: {
  config: AppConfig;
  provider: ProviderRegistryEntry;
  endpoint: ProviderRegistryEndpoint;
  surface: Surface;
  harnessProfileId?: ProviderForwardInput["harnessProfileId"];
  body: unknown;
  incoming: Record<string, string | undefined>;
  credential?: UpstreamCredential;
}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...input.provider.defaultHeaders
  };
  const credentialForProvider = input.credential && input.credential.provider === input.provider.slug
    ? input.credential
    : undefined;
  const operatorToken = input.provider.builtin ? operatorTokenForProvider(input.provider.slug, input.config) : undefined;
  const chatgptCredential = isOpenAIChatGPTCredential(input.provider, credentialForProvider)
    ? credentialForProvider
    : undefined;
  const token = chatgptCredential?.token ??
    (credentialForProvider?.authType === "api_key" ? credentialForProvider.token : operatorToken);
  let usesAnthropicOAuthBearer = false;

  if (
    input.provider.slug === "anthropic" &&
    credentialForProvider?.authType === "oauth" &&
    input.config.subscriptionOAuthEnabled
  ) {
    // Subscription OAuth authenticates with the credential's own bearer token, so it
    // works without an operator API key configured for the provider. (When the flag is
    // off, `token` falls back to the operator key and is sent as x-api-key below.)
    headers.authorization = `Bearer ${credentialForProvider.token}`;
    usesAnthropicOAuthBearer = true;
  } else if (input.provider.authStyle === "bearer" && token) {
    headers.authorization = `Bearer ${token}`;
    if (chatgptCredential?.chatgptAccountId) {
      headers["ChatGPT-Account-Id"] = chatgptCredential.chatgptAccountId;
    }
  } else if (input.provider.authStyle === "x-api-key" && token) {
    headers["x-api-key"] = token;
  }

  const profile = input.harnessProfileId
    ? harnessSurfaceProfileById(input.harnessProfileId)
    : detectHarnessSurfaceProfile({ surface: input.surface, body: input.body, headers: input.incoming });
  copySelectedHeaders(input.incoming, headers, dialectHeadersFor(input.endpoint.dialect));

  if (input.endpoint.dialect === "anthropic-messages") {
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
  }
  if (usesAnthropicOAuthBearer) {
    headers["anthropic-beta"] = mergeBetaTokens(headers["anthropic-beta"], ANTHROPIC_OAUTH_BETA);
  }
  if (input.provider.builtin || input.provider.forwardHarnessHeaders) {
    copySelectedHeaders(input.incoming, headers, identityHeadersFor(profile));
  }

  return headers;
}

export function canAuthenticateOrgProvider(provider: ProviderRegistryEntry, credential?: UpstreamCredential) {
  if (provider.builtin || provider.authStyle === "none") return true;
  return credential?.provider === provider.slug;
}

function isOpenAIChatGPTCredential(
  provider: ProviderRegistryEntry,
  credential: UpstreamCredential | undefined
) {
  return provider.slug === "openai" &&
    credential?.provider === provider.slug &&
    credential.authType === "oauth" &&
    Boolean(credential.chatgptAccountId);
}

function terminalEventType(status: "completed" | "failed" | "cancelled") {
  if (status === "completed") return "provider.response_completed";
  if (status === "cancelled") return "provider.response_cancelled";
  return "provider.response_failed";
}

function healthEventType(classification: ProviderHealthClassification) {
  if (classification.scope === "provider_account") {
    return classification.cooldownUntil ? "provider_account.cooldown_started" : "provider_account.health_changed";
  }
  if (classification.scope === "provider_account_model" && classification.cooldownUntil) {
    return "provider_model.lockout_started";
  }
  return undefined;
}

function deploymentFailureReason(status: number, retryable: boolean): ProviderDeploymentFailureReason | undefined {
  if (status === 429) return "rate_limited";
  if (retryable && status >= 500 && status < 600) return "server_error";
  return undefined;
}

function transportFailureReason(providerTimedOut: boolean, clientAborted: boolean): ProviderDeploymentFailureReason | undefined {
  if (clientAborted) return undefined;
  if (providerTimedOut) return "timeout";
  return "connection_error";
}

function terminalError(metadata: JsonObject) {
  const error = metadata.error;
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return undefined;
  return JSON.stringify(error);
}

function copyResponseHeaders(upstream: Response, reply: FastifyReply) {
  for (const [key, value] of upstream.headers.entries()) {
    if (blockedResponseHeaders.has(key.toLowerCase())) continue;
    reply.header(key, value);
    reply.raw.setHeader(key, value);
  }
}

function providerForDeployment(
  provider: ProviderRegistryEntry,
  deployment: ProviderForwardAttemptInput["deployment"]
): ProviderRegistryEntry {
  if (!deployment?.baseUrl) return provider;
  return {
    ...provider,
    baseUrl: deployment.baseUrl.replace(/\/+$/, ""),
    pinnedAddress: undefined
  };
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

function retryableStatus(status: number, retryableStatuses: readonly number[] | undefined) {
  return (retryableStatuses ?? []).includes(status);
}

function providerForwardAttempts(input: ProviderForwardInput): ProviderForwardAttemptInput[] {
  if (input.attempts?.length) return input.attempts;
  if (input.decision.providerAttempts?.length) {
    return input.decision.providerAttempts.map((attempt) => providerForwardAttempt(input, attempt));
  }
  if (
    !input.decision.finalRoute ||
    !input.decision.selectedModel ||
    !input.decision.provider ||
    !input.decision.providerSettings
  ) {
    return [];
  }
  return [{
    route: input.decision.finalRoute,
    selectedModel: input.decision.selectedModel,
    provider: input.decision.provider,
    deployment: input.decision.deployment,
    reasoningEffort: input.decision.reasoningEffort,
    body: input.body,
    credential: input.credential,
    providerSettings: input.decision.providerSettings
  }];
}

function providerForwardAttempt(input: ProviderForwardInput, attempt: RouteProviderAttempt): ProviderForwardAttemptInput {
  return {
    route: attempt.route,
    selectedModel: attempt.selectedModel,
    provider: attempt.provider,
    deployment: attempt.deployment,
    reasoningEffort: attempt.reasoningEffort,
    body: input.body,
    credential: input.credential,
    providerSettings: attempt.providerSettings
  };
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

function translateResponseText(text: string, translator: DialectTranslator) {
  const parsed = tryParseJson(text);
  if (parsed === undefined) return text;
  return JSON.stringify(translator.response(parsed));
}

function withoutOutputText(observation: StreamObservation) {
  return streamObservationEventMetadata(observation);
}

function onceDrain(stream: NodeJS.WritableStream) {
  return new Promise<void>((resolve) => stream.once("drain", resolve));
}

function rateLimitRetryDelayMs(input: {
  headers: Headers;
  provider: Provider;
  maxDelayMs: number;
}) {
  const headerDelay = retryAfterDelayMs(input.headers) ?? providerResetDelayMs(input.headers, input.provider);
  if (headerDelay === undefined) return undefined;
  const delayMs = headerDelay;
  if (delayMs > input.maxDelayMs) return undefined;
  return delayMs;
}

function retryAfterDelayMs(headers: Headers) {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function providerResetDelayMs(headers: Headers, provider: Provider) {
  const values = provider === "openai"
    ? [
        delayWithRemaining(headers, "x-ratelimit-reset-requests", "x-ratelimit-remaining-requests"),
        delayWithRemaining(headers, "x-ratelimit-reset-tokens", "x-ratelimit-remaining-tokens")
      ]
    : [
        delayWithRemaining(headers, "anthropic-ratelimit-requests-reset", "anthropic-ratelimit-requests-remaining"),
        delayWithRemaining(headers, "anthropic-ratelimit-tokens-reset", "anthropic-ratelimit-tokens-remaining"),
        delayWithRemaining(headers, "anthropic-ratelimit-input-tokens-reset", "anthropic-ratelimit-input-tokens-remaining"),
        delayWithRemaining(headers, "anthropic-ratelimit-output-tokens-reset", "anthropic-ratelimit-output-tokens-remaining"),
        delayWithRemaining(headers, "anthropic-priority-input-tokens-reset", "anthropic-priority-input-tokens-remaining"),
        delayWithRemaining(headers, "anthropic-priority-output-tokens-reset", "anthropic-priority-output-tokens-remaining")
      ];
  const exhausted = values.filter((value) => value.delayMs !== undefined && value.exhausted);
  if (exhausted.length > 0) return Math.max(...exhausted.map((value) => value.delayMs ?? 0));
  const candidates = values.map((value) => value.delayMs).filter((value) => value !== undefined);
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

function delayWithRemaining(headers: Headers, resetHeader: string, remainingHeader: string) {
  const reset = headers.get(resetHeader);
  const remaining = headers.get(remainingHeader);
  return {
    delayMs: reset ? parseResetDelayMs(reset) : undefined,
    exhausted: remaining !== null && Number(remaining) <= 0
  };
}

function parseResetDelayMs(value: string) {
  const duration = parseDurationMs(value);
  if (duration !== undefined) return duration;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function parseDurationMs(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const matches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (matches.length === 0) return undefined;
  const consumed = matches.map((match) => match[0]).join("");
  if (consumed !== trimmed) return undefined;
  return Math.ceil(matches.reduce((total, match) => {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return total;
    if (match[2] === "ms") return total + amount;
    if (match[2] === "s") return total + amount * 1000;
    if (match[2] === "m") return total + amount * 60_000;
    return total + amount * 3_600_000;
  }, 0));
}

function rateLimitHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (
      key === "retry-after" ||
      key.startsWith("x-ratelimit-") ||
      key.startsWith("anthropic-ratelimit-") ||
      key.startsWith("anthropic-priority-") ||
      key.startsWith("anthropic-fast-")
    ) {
      result[key] = value;
    }
  }
  return result;
}

async function discardBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    await response.text().catch(() => undefined);
  }
}

function sleep(delayMs: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error("Provider request cancelled.");
  error.name = "AbortError";
  return error;
}
