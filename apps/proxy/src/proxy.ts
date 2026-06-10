import type { FastifyReply } from "fastify";

import type { ProviderAdapter, ProviderForwardInput } from "./adapters.js";
import type { AppConfig } from "./config.js";
import {
  jsonPayload,
  type EventService,
  type ProviderAttemptStore,
  type RequestStateStoreLike
} from "./events.js";
import { extractResponseText } from "./persistence/promptArtifacts.js";
import { SseObserver, type StreamObservation } from "./sseObserver.js";
import type { JsonObject, Provider, RouteDecision, Surface } from "./types.js";

export class ProviderProxy implements ProviderAdapter {
  constructor(
    private readonly config: AppConfig,
    private readonly events: EventService,
    private readonly attempts: ProviderAttemptStore,
    private readonly requestStates: RequestStateStoreLike
  ) {}

  async forward(input: ProviderForwardInput) {
    if (!input.decision.selectedModel) {
      input.reply.code(500).send({ error: "Missing selected model." });
      return;
    }
    const selectedModel = input.decision.selectedModel;

    const { attempt, duplicate } = this.attempts.create({
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      surface: input.surface,
      provider: input.provider,
      model: selectedModel
    });

    if (!attempt) {
      input.reply.code(409).send({ error: "Duplicate request is still active." });
      return;
    }

    if (duplicate && attempt.terminalStatus === "pending") {
      input.reply.code(409).send({ error: "Duplicate request is still active." });
      return;
    }

    if (duplicate) {
      input.reply.send({
        duplicate: true,
        provider_attempt: {
          id: attempt.id,
          terminal_status: attempt.terminalStatus,
          usage: attempt.usage ?? null,
          upstream_request_id: attempt.upstreamRequestId ?? null,
          error: attempt.error ?? null
        }
      });
      return;
    }

    await this.events.append({
      scopeType: "request",
      scopeId: input.requestId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      producer: "prompt-proxy.provider",
      eventType: "provider.request_started",
      payload: {
        surface: input.surface,
        provider: input.provider,
        model: selectedModel,
        providerAttemptId: attempt.id
      }
    });
    await this.requestStates.markProviderPending(input.idempotencyKey, attempt.id);

    const abortController = new AbortController();
    let streamCompleted = false;
    const abortUpstream = () => {
      if (!streamCompleted) abortController.abort();
    };
    input.reply.raw.once("close", abortUpstream);

    let upstream: Response;
    try {
      upstream = await fetch(this.urlFor(input.provider, input.path), {
        method: "POST",
        headers: this.headersFor(input.provider, input.headers),
        body: JSON.stringify(input.body),
        signal: abortController.signal
      });
    } catch (error) {
      input.reply.raw.off("close", abortUpstream);
      const aborted = abortController.signal.aborted;
      await this.appendTerminal(input, attempt.id, aborted ? "cancelled" : "failed", undefined, 0, {
        error: error instanceof Error ? error.message : "Provider request failed."
      });
      this.attempts.update(attempt.id, {
        terminalStatus: aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : "Provider request failed."
      });
      await this.requestStates.finish(input.idempotencyKey, aborted ? "cancelled" : "failed", {
        providerAttemptId: attempt.id,
        error: error instanceof Error ? error.message : "Provider request failed."
      });
      throw error;
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const isSse = contentType.includes("text/event-stream");

    copyResponseHeaders(upstream, input.reply);
    input.reply.code(upstream.status);
    input.reply.header("x-prompt-proxy-model", selectedModel);
    input.reply.header("x-prompt-proxy-route", input.decision.finalRoute ?? "");
    if (input.decision.reasoningEffort) {
      input.reply.header("x-prompt-proxy-reasoning-effort", input.decision.reasoningEffort);
    }

    if (!isSse || !upstream.body) {
      const text = await upstream.text();
      const status = upstream.ok ? "completed" : "failed";
      const usage = tryExtractUsage(text);
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);

      await this.appendTerminal(input, attempt.id, status, usage, upstream.status);
      this.attempts.update(attempt.id, {
        terminalStatus: status,
        usage: usage === undefined ? undefined : jsonPayload(usage)
      });
      await this.requestStates.finish(input.idempotencyKey, status, {
        providerAttemptId: attempt.id,
        usage: usage === undefined ? undefined : jsonPayload(usage)
      });
      input.reply.send(text);
      if (status === "completed" && input.onAssistantText) {
        const assistantText = extractResponseText(input.surface, tryParseJson(text));
        if (assistantText) await input.onAssistantText(assistantText, false);
      }
      return;
    }

    await this.events.append({
      scopeType: "request",
      scopeId: input.requestId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      producer: "prompt-proxy.provider",
      eventType: "provider.stream_started",
      payload: {
        provider: input.provider,
        surface: input.surface,
        providerAttemptId: attempt.id
      }
    });

    input.reply.hijack();
    input.reply.raw.statusCode = upstream.status;
    input.reply.raw.setHeader("x-prompt-proxy-model", selectedModel);
    input.reply.raw.setHeader("x-prompt-proxy-route", input.decision.finalRoute ?? "");
    if (input.decision.reasoningEffort) {
      input.reply.raw.setHeader("x-prompt-proxy-reasoning-effort", input.decision.reasoningEffort);
    }
    const observer = new SseObserver();
    let completed = false;

    try {
      let observation: ReturnType<SseObserver["finish"]>;
      let status: "completed" | "failed";
      try {
        for await (const chunk of upstream.body) {
          const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
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
        const aborted = abortController.signal.aborted;
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
        await this.requestStates.finish(input.idempotencyKey, aborted ? "cancelled" : "failed", {
          providerAttemptId: attempt.id,
          usage: observation.usage,
          error: message
        });
        throw error;
      }
      await this.appendTerminal(input, attempt.id, status, observation.usage, upstream.status, withoutOutputText(observation));
      this.attempts.update(attempt.id, {
        terminalStatus: status,
        usage: observation.usage,
        upstreamRequestId: observation.upstreamResponseId,
        error: observation.error
      });
      await this.requestStates.finish(input.idempotencyKey, status, {
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
          producer: "prompt-proxy.provider",
          eventType: "provider.terminal_reconcile_scheduled",
          payload: {
            providerAttemptId: attempt.id
          }
        });
      }
    }
  }

  private async appendTerminal(
    input: {
      requestId: string;
      idempotencyKey: string;
      surface: Surface;
      provider: Provider;
      decision: RouteDecision;
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
    const error = terminalError(metadataPayload);
    if (error) payload.error = error;

    await this.events.append({
      scopeType: "request",
      scopeId: input.requestId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      producer: "prompt-proxy.provider",
      eventType: terminalEventType(status),
      payload,
      metadata: metadataPayload
    });

    if (usage !== undefined) {
      await this.events.append({
        scopeType: "request",
        scopeId: input.requestId,
        correlationId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        producer: "prompt-proxy.usage",
        eventType: "usage.recorded",
        payload: {
          providerAttemptId,
          usage: jsonPayload(usage)
        }
      });
    }
  }

  private urlFor(provider: Provider, path?: string) {
    const base = provider === "openai" ? this.config.openaiBaseUrl : this.config.anthropicBaseUrl;
    return `${base}${path ?? (provider === "openai" ? "/responses" : "/messages")}`;
  }

  private headersFor(provider: Provider, incoming: Record<string, string | undefined>) {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };

    if (provider === "openai") {
      headers.authorization = `Bearer ${this.config.openaiApiKey}`;
      copyIfPresent(incoming, headers, "x-codex-turn-state");
      copyIfPresent(incoming, headers, "x-codex-turn-metadata");
      copyIfPresent(incoming, headers, "x-openai-subagent");
      copyIfPresent(incoming, headers, "x-request-id");
      copyIfPresent(incoming, headers, "traceparent");
      copyIfPresent(incoming, headers, "tracestate");
      return headers;
    }

    headers["x-api-key"] = this.config.anthropicApiKey;
    headers["anthropic-version"] = incoming["anthropic-version"] ?? "2023-06-01";
    copyIfPresent(incoming, headers, "anthropic-beta");
    copyIfPresent(incoming, headers, "x-claude-code-session-id");
    copyIfPresent(incoming, headers, "x-claude-code-agent-id");
    copyIfPresent(incoming, headers, "x-claude-code-parent-agent-id");
    copyIfPresent(incoming, headers, "x-request-id");
    copyIfPresent(incoming, headers, "traceparent");
    copyIfPresent(incoming, headers, "tracestate");
    return headers;
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

function copyResponseHeaders(upstream: Response, reply: FastifyReply) {
  for (const [key, value] of upstream.headers.entries()) {
    if (hopByHopHeaders.has(key.toLowerCase())) continue;
    reply.header(key, value);
    reply.raw.setHeader(key, value);
  }
}

const hopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function copyIfPresent(
  from: Record<string, string | undefined>,
  to: Record<string, string>,
  key: string
) {
  const value = from[key.toLowerCase()] ?? from[key];
  if (value) to[key] = value;
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
  const { outputText, outputTextTruncated, ...rest } = observation;
  return rest;
}

function onceDrain(stream: NodeJS.WritableStream) {
  return new Promise<void>((resolve) => stream.once("drain", resolve));
}
