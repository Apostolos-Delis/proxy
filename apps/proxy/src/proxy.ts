import type { FastifyReply } from "fastify";

import type { ProviderAdapter, ProviderForwardInput } from "./adapters.js";
import type { AppConfig } from "./config.js";
import {
  jsonPayload,
  type EventService,
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
import { copySelectedHeaders, detectHarness, dialectHeadersFor, identityHeadersFor } from "./harness.js";
import { sseObserverForDialect, type StreamObservation } from "./sseObserver.js";
import { translators, type DialectTranslator } from "./translators/index.js";
import type { JsonObject, Provider, RouteDecision, Surface, UpstreamCredential } from "./types.js";
import {
  fetchWithPinnedAddress,
  providerRequestPinnedAddress,
  providerRequestRedirect,
  providerRequestUrl
} from "./upstream.js";

export class ProviderProxy implements ProviderAdapter {
  constructor(
    private readonly config: AppConfig,
    private readonly events: EventService,
    private readonly attempts: ProviderAttemptStore,
    private readonly requestStates: RequestStateStoreLike,
    private readonly providerRegistry: ProviderRegistryResolver
  ) {}

  async forward(input: ProviderForwardInput) {
    if (!input.decision.selectedModel) {
      input.reply.code(500).send({ error: "Missing selected model." });
      return;
    }
    if (!input.decision.providerSettings) {
      input.reply.code(500).send({ error: "Missing selected provider settings." });
      return;
    }
    const selectedModel = input.decision.selectedModel;
    const targetDialect = input.decision.providerSettings.dialect;

    const { attempt, duplicate } = this.attempts.create({
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      surface: input.surface,
      provider: input.provider,
      model: selectedModel
    });

    if (!attempt || duplicate) {
      input.reply.code(409).send({ error: "Duplicate request is still active." });
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
      return;
    }
    const endpoint = resolvedProvider ? providerEndpointForDialect(resolvedProvider, targetDialect) : undefined;
    if (!resolvedProvider || !resolvedProvider.enabled || !endpoint) {
      const error = !resolvedProvider || !resolvedProvider.enabled
        ? "provider_not_found"
        : "provider_endpoint_not_found";
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      await this.failBeforeFetch(input, attempt.id, error);
      return;
    }
    const responseTranslator = endpoint.dialect === input.surface
      ? undefined
      : translators.get(endpoint.dialect, input.surface);
    if (endpoint.dialect !== input.surface && !responseTranslator) {
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      await this.failBeforeFetch(input, attempt.id, "translator_not_found");
      return;
    }
    if (!canAuthenticateOrgProvider(resolvedProvider, input.credential)) {
      const error = "provider_credential_unresolved";
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);
      await this.failBeforeFetch(input, attempt.id, error);
      return;
    }

    let upstream: Response;
    try {
      upstream = await this.fetchWithRateLimitRetries({
        input,
        providerAttemptId: attempt.id,
        provider: resolvedProvider,
        endpoint,
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
      const upstreamText = await upstream.text();
      const text = upstream.ok && responseTranslator
        ? translateResponseText(upstreamText, responseTranslator)
        : upstreamText;
      const status = upstream.ok ? "completed" : "failed";
      const usage = tryExtractUsage(text);
      const error = upstream.ok ? undefined : errorExcerpt(text);
      streamCompleted = true;
      input.reply.raw.off("close", abortUpstream);

      await this.appendTerminal(input, attempt.id, status, usage, upstream.status, error ? { error } : {});
      this.attempts.update(attempt.id, {
        terminalStatus: status,
        usage: usage === undefined ? undefined : jsonPayload(usage),
        error
      });
      await this.requestStates.finish(input.idempotencyKey, status, {
        providerAttemptId: attempt.id,
        usage: usage === undefined ? undefined : jsonPayload(usage),
        error
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
    const observer = sseObserverForDialect(input.surface);
    let completed = false;

    try {
      let observation: StreamObservation;
      let status: "completed" | "failed";
      try {
        const responseBody = responseTranslator
          ? responseTranslator.sseTransform(upstream.body)
          : upstream.body;
        for await (const chunk of responseBody) {
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
      providerAttemptId,
      error
    });
    input.reply.code(502).send({ error });
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
          body: input.body,
          incoming: input.headers,
          credential: input.credential
        }),
        body: JSON.stringify(input.body),
        redirect: providerRequestRedirect({ provider, credential: input.credential }),
        signal
      }, providerRequestPinnedAddress({ provider, config: this.config, credential: input.credential }));

      if (upstream.status !== 429 || upstreamAttempt === maxAttempts) {
        return upstream;
      }

      const delayMs = rateLimitRetryDelayMs({
        headers: upstream.headers,
        provider: provider.slug,
        attempt: upstreamAttempt,
        baseDelayMs: this.config.providerRateLimitBaseDelayMs,
        maxDelayMs: this.config.providerRateLimitMaxDelayMs
      });
      if (delayMs === undefined) return upstream;

      await discardBody(upstream);
      await this.events.append({
        scopeType: "request",
        scopeId: input.requestId,
        correlationId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        producer: "prompt-proxy.provider",
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

export function providerRequestHeaders(input: {
  config: AppConfig;
  provider: ProviderRegistryEntry;
  endpoint: ProviderRegistryEndpoint;
  surface: Surface;
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
  const chatgptCredential = isOpenAIChatGPTCredential(input.provider, credentialForProvider, input.config)
    ? credentialForProvider
    : undefined;
  const token = chatgptCredential?.token ??
    (credentialForProvider?.authType === "api_key" ? credentialForProvider.token : operatorToken);

  if (input.provider.authStyle === "bearer" && token) {
    headers.authorization = `Bearer ${token}`;
    if (chatgptCredential?.chatgptAccountId) {
      headers["ChatGPT-Account-Id"] = chatgptCredential.chatgptAccountId;
    }
  }
  if (input.provider.authStyle === "x-api-key" && token) {
    if (input.provider.slug === "anthropic" && credentialForProvider?.authType === "oauth") {
      if (input.config.subscriptionOAuthEnabled) {
        headers.authorization = `Bearer ${credentialForProvider.token}`;
      } else if (operatorToken) {
        headers["x-api-key"] = operatorToken;
      }
    } else {
      headers["x-api-key"] = token;
    }
  }

  const profile = detectHarness({ surface: input.surface, body: input.body, headers: input.incoming });
  copySelectedHeaders(input.incoming, headers, dialectHeadersFor(input.endpoint.dialect));

  if (input.endpoint.dialect === "anthropic-messages") {
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
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
  credential: UpstreamCredential | undefined,
  config: AppConfig
) {
  return provider.slug === "openai" &&
    credential?.provider === provider.slug &&
    credential.authType === "oauth" &&
    config.subscriptionOAuthEnabled &&
    Boolean(credential.chatgptAccountId);
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
  const { outputText: _text, outputTextTruncated: _truncated, ...rest } = observation;
  return rest;
}

function onceDrain(stream: NodeJS.WritableStream) {
  return new Promise<void>((resolve) => stream.once("drain", resolve));
}

function rateLimitRetryDelayMs(input: {
  headers: Headers;
  provider: Provider;
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
}) {
  const headerDelay = retryAfterDelayMs(input.headers) ?? providerResetDelayMs(input.headers, input.provider);
  const delayMs = headerDelay ?? fallbackBackoffMs(input.attempt, input.baseDelayMs, input.maxDelayMs);
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

function fallbackBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  if (ceiling <= 0) return 0;
  return Math.ceil(ceiling / 2 + Math.random() * (ceiling / 2));
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
