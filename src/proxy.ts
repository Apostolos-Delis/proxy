import type { FastifyReply } from "fastify";

import type { ProviderAdapter, ProviderForwardInput } from "./adapters.js";
import type { AppConfig } from "./config.js";
import {
  jsonPayload,
  type EventService,
  type ProviderAttemptStore,
  type RequestStateStore
} from "./events.js";
import { SseObserver } from "./sseObserver.js";
import type { JsonObject, Provider, RouteDecision, Surface } from "./types.js";

export class ProviderProxy implements ProviderAdapter {
  constructor(
    private readonly config: AppConfig,
    private readonly events: EventService,
    private readonly attempts: ProviderAttemptStore,
    private readonly requestStates: RequestStateStore
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
        provider: input.provider,
        model: selectedModel,
        providerAttemptId: attempt.id
      }
    });
    this.requestStates.markProviderPending(input.idempotencyKey, attempt.id);

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
      this.attempts.update(attempt.id, {
        terminalStatus: aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : "Provider request failed."
      });
      this.requestStates.finish(input.idempotencyKey, aborted ? "cancelled" : "failed", {
        providerAttemptId: attempt.id,
        error: error instanceof Error ? error.message : "Provider request failed."
      });
      await this.events.append({
        scopeType: "request",
        scopeId: input.requestId,
        correlationId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        producer: "prompt-proxy.provider",
        eventType: aborted ? "provider.stream_cancelled" : "provider.response_failed",
        payload: {
          provider: input.provider,
          providerAttemptId: attempt.id,
          error: error instanceof Error ? error.message : "Provider request failed."
        }
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

      this.attempts.update(attempt.id, {
        terminalStatus: status,
        usage: usage === undefined ? undefined : jsonPayload(usage)
      });
      this.requestStates.finish(input.idempotencyKey, status, {
        providerAttemptId: attempt.id,
        usage: usage === undefined ? undefined : jsonPayload(usage)
      });
      await this.appendTerminal(input, attempt.id, status, usage, upstream.status);
      input.reply.send(text);
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
      for await (const chunk of upstream.body) {
        const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
        observer.observe(bytes);
        if (!input.reply.raw.write(bytes)) {
          await onceDrain(input.reply.raw);
        }
      }
      completed = true;
      const observation = observer.finish();
      const status = observation.status === "failed" ? "failed" : "completed";
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      this.attempts.update(attempt.id, {
        terminalStatus: status,
        usage: observation.usage,
        upstreamRequestId: observation.upstreamResponseId,
        error: observation.error
      });
      this.requestStates.finish(input.idempotencyKey, status, {
        providerAttemptId: attempt.id,
        usage: observation.usage,
        upstreamRequestId: observation.upstreamResponseId,
        error: observation.error
      });
      await this.appendTerminal(input, attempt.id, status, observation.usage, upstream.status, observation);
    } catch (error) {
      const observation = observer.finish("cancelled");
      const message = error instanceof Error ? error.message : "Stream failed.";
      const aborted = abortController.signal.aborted;
      this.attempts.update(attempt.id, {
        terminalStatus: aborted ? "cancelled" : "failed",
        usage: observation.usage,
        error: message
      });
      this.requestStates.finish(input.idempotencyKey, aborted ? "cancelled" : "failed", {
        providerAttemptId: attempt.id,
        usage: observation.usage,
        error: message
      });
      await this.appendTerminal(
        input,
        attempt.id,
        aborted ? "cancelled" : "failed",
        observation.usage,
        upstream.status,
        {
          ...observation,
          error: message
        }
      );
      throw error;
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
      provider: Provider;
      decision: RouteDecision;
    },
    providerAttemptId: string,
    status: "completed" | "failed" | "cancelled",
    usage: unknown,
    upstreamStatus: number,
    metadata: unknown = {}
  ) {
    await this.events.append({
      scopeType: "request",
      scopeId: input.requestId,
      correlationId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      producer: "prompt-proxy.provider",
      eventType: status === "completed" ? "provider.response_completed" : "provider.response_failed",
      payload: {
        provider: input.provider,
        selectedModel: input.decision.selectedModel ?? "unknown",
        providerAttemptId,
        upstreamStatus,
        usage: usage === undefined ? null : jsonPayload(usage)
      },
      metadata: jsonPayload(metadata) as JsonObject
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
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "usage" in parsed) {
      return (parsed as { usage: unknown }).usage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function onceDrain(stream: NodeJS.WritableStream) {
  return new Promise<void>((resolve) => stream.once("drain", resolve));
}
