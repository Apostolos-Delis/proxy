import type { AppConfig } from "../config.js";
import {
  type EventAppender,
  jsonPayload
} from "../events.js";
import {
  copySelectedHeaders,
  detectHarnessSurfaceProfile,
  dialectHeadersFor,
  harnessSurfaceProfileById,
  identityHeadersFor
} from "../harness.js";
import {
  assertSafeDefaultHeaders,
  type ProviderRegistryEntry,
  type ProviderRegistryEndpoint,
  type ProviderRegistryHttpEndpoint
} from "../persistence/providers.js";
import { requestBodyHash } from "../toolResultCompression.js";
import { translators } from "../translators/index.js";
import type {
  ProviderAdapterFailureClassification,
  ProviderForwardInput
} from "./types.js";
import type { Provider, Surface, UpstreamCredential } from "../types.js";
import {
  fetchWithPinnedAddress,
  providerRequestPinnedAddress,
  providerRequestRedirect,
  providerRequestUrl
} from "../upstream.js";
import { isRecord } from "../util.js";

export type GenericHttpFetchInput = {
  input: ProviderForwardInput;
  providerAttemptId: string;
  provider: ProviderRegistryEntry;
  endpoint: ProviderRegistryEndpoint;
  signal: AbortSignal;
};

export type GenericHttpResponseTranslation =
  | { kind: "native" }
  | {
      kind: "translated";
      sourceDialect: ProviderRegistryHttpEndpoint["dialect"];
      response(body: unknown): unknown;
      sseTransform(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
    }
  | { kind: "unsupported" };

export type GenericHttpProviderAdapterContract = {
  fetchWithRateLimitRetries(input: GenericHttpFetchInput): Promise<Response>;
  responseTranslation(input: { endpoint: ProviderRegistryEndpoint; surface: Surface }): GenericHttpResponseTranslation;
  translateResponseText(text: string, translation: GenericHttpResponseTranslation): string;
  transformResponseStream(
    body: AsyncIterable<Uint8Array>,
    translation: GenericHttpResponseTranslation
  ): AsyncIterable<Uint8Array>;
  classifyResponse(input: { status: number; headers: Headers; bodyText?: string; response?: Response }): ProviderAdapterFailureClassification | undefined;
  classifyFetchError(input: { error: unknown; timedOut: boolean }): ProviderAdapterFailureClassification;
  classifyMalformedResponse(input: { message?: string; response?: Response }): ProviderAdapterFailureClassification;
};

export class GenericHttpProviderAdapter implements GenericHttpProviderAdapterContract {
  constructor(
    private readonly config: AppConfig,
    private readonly events: EventAppender
  ) {}

  async fetchWithRateLimitRetries({
    input,
    providerAttemptId,
    provider,
    endpoint,
    signal
  }: GenericHttpFetchInput) {
    assertHttpEndpoint(endpoint);
    const maxAttempts = this.config.providerRateLimitMaxAttempts;

    for (let upstreamAttempt = 1; upstreamAttempt <= maxAttempts; upstreamAttempt += 1) {
      const body = input.body;
      await this.events.append({
        tenantId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: "request",
        scopeId: input.requestId,
        correlationId: input.requestId,
        idempotencyKey: `${input.idempotencyKey}:provider-forwarded:${upstreamAttempt}`,
        producer: "proxy.provider",
        eventType: "provider.request_forwarded",
        payload: {
          surface: input.surface,
          provider: input.target.provider,
          adapterKind: provider.adapterKind,
          model: input.target.upstreamModelId,
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
        credential: input.target.credential
      }), {
        method: "POST",
        headers: providerRequestHeaders({
          provider,
          endpoint,
          surface: input.surface,
          harnessProfileId: input.harnessProfileId,
          body,
          incoming: input.headers,
          credential: input.target.credential
        }),
        body: JSON.stringify(body),
        redirect: providerRequestRedirect(),
        signal
      }, providerRequestPinnedAddress({
        provider,
        credential: input.target.credential
      }));

      if (upstream.status !== 429 || upstreamAttempt === maxAttempts) {
        return upstream;
      }

      const delayMs = rateLimitRetryDelayMs({
        headers: upstream.headers,
        provider: provider.provider,
        maxDelayMs: this.config.providerRateLimitMaxDelayMs
      });
      if (delayMs === undefined) return upstream;

      await discardBody(upstream);
      await this.events.append({
        tenantId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: "request",
        scopeId: input.requestId,
        correlationId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        producer: "proxy.provider",
        eventType: "provider.rate_limit_retry_scheduled",
        payload: {
          surface: input.surface,
          provider: input.target.provider,
          model: input.target.upstreamModelId,
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

  responseTranslation(input: { endpoint: ProviderRegistryEndpoint; surface: Surface }): GenericHttpResponseTranslation {
    if (!("path" in input.endpoint)) return { kind: "unsupported" };
    if (input.endpoint.dialect === input.surface) return { kind: "native" };
    const translator = translators.get(input.endpoint.dialect, input.surface);
    if (!translator) return { kind: "unsupported" };
    return {
      kind: "translated",
      sourceDialect: input.endpoint.dialect,
      response: translator.response,
      sseTransform: translator.sseTransform
    };
  }

  translateResponseText(text: string, translation: GenericHttpResponseTranslation) {
    if (translation.kind !== "translated") return text;
    const parsed = tryParseJson(text);
    assertProviderResponseEnvelope(translation.sourceDialect, parsed);
    const translated = translation.response(parsed);
    if (!isRecord(translated)) throw new Error("Translated provider response is not a JSON object.");
    return JSON.stringify(translated);
  }

  transformResponseStream(body: AsyncIterable<Uint8Array>, translation: GenericHttpResponseTranslation) {
    if (translation.kind !== "translated") return body;
    return translation.sseTransform(body);
  }

  classifyResponse(input: { status: number; headers: Headers; bodyText?: string }) {
    return classifyGenericHttpResponse(input);
  }

  classifyFetchError(input: { error: unknown; timedOut: boolean }) {
    return classifyGenericHttpFetchError(input);
  }

  classifyMalformedResponse(input: { message?: string }) {
    return classifyGenericHttpMalformedResponse(input);
  }
}

function assertProviderResponseEnvelope(
  dialect: ProviderRegistryHttpEndpoint["dialect"],
  body: unknown
): asserts body is Record<string, unknown> {
  if (!isRecord(body)) throw new Error(`Malformed ${dialect} provider response.`);
  let valid: boolean;
  if (dialect === "anthropic-messages") valid = Array.isArray(body.content);
  else if (dialect === "openai-chat") valid = Array.isArray(body.choices);
  else valid = Array.isArray(body.output);
  if (!valid) throw new Error(`Malformed ${dialect} provider response.`);
}

export function classifyGenericHttpResponse(input: {
  status: number;
  headers: Headers;
  bodyText?: string;
}): ProviderAdapterFailureClassification | undefined {
  if (input.status < 400) return undefined;
  const message = errorMessage(input.bodyText);
  const lower = message?.toLowerCase() ?? "";
  const cooldownMs = retryAfterDelayMs(input.headers);

  if (authExpired(input.status, lower)) {
    return adapterClassification("auth_denied", "auth_expired", "response_body", true, false, "provider_connection", message, cooldownMs);
  }
  if (input.status === 401) {
    return adapterClassification("auth_denied", "auth_invalid", "provider_status", false, true, "provider_connection", message);
  }
  if (modelAccessDenied(lower)) {
    return adapterClassification("auth_denied", "model_access_denied", "response_body", false, true, "deployment", message);
  }
  if (input.status === 403) {
    return adapterClassification("auth_denied", "auth_invalid", "provider_status", false, true, "provider_connection", message);
  }
  if (quotaExhausted(lower)) {
    return adapterClassification("quota_exceeded", "quota_exhausted", "response_body", true, false, "provider_connection", message, cooldownMs ?? 60 * minuteMs);
  }
  if (input.status === 429) {
    return adapterClassification("rate_limited", "rate_limited", "provider_status", true, false, "provider_connection", message, cooldownMs ?? minuteMs);
  }
  if (modelUnavailable(input.status, lower)) {
    return adapterClassification(
      "upstream_unavailable",
      "model_unavailable",
      lower ? "response_body" : "provider_status",
      true,
      false,
      "deployment",
      message,
      10 * minuteMs
    );
  }
  if (contextOverflow(lower)) {
    return adapterClassification("context_too_large", "context_overflow", "response_body", false, true, "request_only", message);
  }
  if (requestIncompatible(lower)) {
    return adapterClassification("unsupported_request_shape", "request_incompatible", "response_body", false, true, "request_only", message);
  }
  if (providerUnavailable(input.status)) {
    return adapterClassification("upstream_unavailable", "provider_unavailable", "provider_status", true, false, "provider_connection", message, 30_000);
  }
  if (unknownTransient(input.status)) {
    return adapterClassification("network_error", "unknown_transient", "proxy_policy", true, false, "provider_connection", message, 30_000);
  }
  return adapterClassification("unknown", "unknown_terminal", "proxy_policy", false, true, "request_only", message);
}

export function classifyGenericHttpFetchError(input: {
  error: unknown;
  timedOut: boolean;
}): ProviderAdapterFailureClassification {
  const message = input.error instanceof Error ? input.error.message : "Provider request failed.";
  return input.timedOut
    ? adapterClassification("upstream_timeout", "unknown_transient", "proxy_policy", true, false, "provider_connection", message, 30_000)
    : adapterClassification("network_error", "unknown_transient", "proxy_policy", true, false, "provider_connection", message, 30_000);
}

function assertHttpEndpoint(endpoint: ProviderRegistryEndpoint): asserts endpoint is ProviderRegistryHttpEndpoint {
  if (!("path" in endpoint)) {
    throw new Error("Generic HTTP adapter requires a path endpoint.");
  }
}

export function classifyGenericHttpMalformedResponse(input: {
  message?: string;
}): ProviderAdapterFailureClassification {
  return adapterClassification(
    "malformed_upstream_response",
    "stream_failed",
    "stream_observer",
    true,
    false,
    "request_only",
    input.message ?? "Malformed upstream response."
  );
}

const minuteMs = 60_000;

function adapterClassification(
  category: ProviderAdapterFailureClassification["category"],
  errorType: ProviderAdapterFailureClassification["errorType"],
  source: ProviderAdapterFailureClassification["source"],
  retryable: boolean,
  fatal: boolean,
  scope: ProviderAdapterFailureClassification["scope"],
  message?: string | null,
  cooldownMs?: number
): ProviderAdapterFailureClassification {
  return {
    category,
    errorType,
    source,
    confidence: source === "response_body" ? "heuristic" : "exact",
    retryable,
    fatal,
    scope,
    cooldownMs,
    message,
    metadata: {
      adapterCategory: category,
      fatal
    }
  };
}

function errorMessage(text: string | undefined) {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = tryParseJson(trimmed);
  if (isRecord(parsed)) {
    const error = parsed.error;
    if (isRecord(error) && typeof error.message === "string") return error.message;
    if (typeof error === "string") return error;
    if (typeof parsed.message === "string") return parsed.message;
  }
  return trimmed.slice(0, 500);
}

function authExpired(statusCode: number, value: string) {
  return (statusCode === 401 || statusCode === 403) &&
    (/\bexpired\b/.test(value) || value.includes("token_expired"));
}

function quotaExhausted(value: string) {
  return value.includes("insufficient_quota") ||
    value.includes("quota exceeded") ||
    value.includes("quota_exceeded") ||
    value.includes("billing hard limit");
}

function modelAccessDenied(value: string) {
  return value.includes("model_access_denied") ||
    value.includes("does not have access to model") ||
    value.includes("not have access to the model") ||
    value.includes("model is not enabled") ||
    value.includes("permission to access model");
}

function modelUnavailable(statusCode: number, value: string) {
  if (value.includes("model_not_found") || value.includes("model unavailable")) return true;
  if (value.includes("model") && (value.includes("does not exist") || value.includes("not found"))) return true;
  return statusCode === 404 && value.includes("model");
}

function contextOverflow(value: string) {
  return value.includes("context_length_exceeded") ||
    value.includes("maximum context") ||
    value.includes("context window") ||
    value.includes("too many tokens") ||
    value.includes("input is too long");
}

function requestIncompatible(value: string) {
  return value.includes("unsupported_parameter") ||
    value.includes("unsupported parameter") ||
    value.includes("not supported") ||
    value.includes("invalid_request_error") ||
    value.includes("unknown parameter");
}

function providerUnavailable(statusCode: number) {
  return statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504;
}

function unknownTransient(statusCode: number) {
  return statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 425;
}

export function providerRequestHeaders(input: {
  provider: ProviderRegistryEntry;
  endpoint: ProviderRegistryHttpEndpoint;
  surface: Surface;
  harnessProfileId?: ProviderForwardInput["harnessProfileId"];
  body: unknown;
  incoming: Record<string, string | undefined>;
  credential?: UpstreamCredential;
}) {
  assertSafeDefaultHeaders(input.provider.defaultHeaders);
  const headers: Record<string, string> = {
    ...input.provider.defaultHeaders,
    "content-type": "application/json"
  };
  const credentialForProvider = input.credential && input.credential.provider === input.provider.slug
    ? input.credential
    : undefined;
  if (input.provider.authStyle === "bearer" && credentialForProvider?.token) {
    headers.authorization = `Bearer ${credentialForProvider.token}`;
  } else if (input.provider.authStyle === "x-api-key" && credentialForProvider?.token) {
    headers["x-api-key"] = credentialForProvider.token;
  }

  const profile = input.harnessProfileId
    ? harnessSurfaceProfileById(input.harnessProfileId)
    : detectHarnessSurfaceProfile({ surface: input.surface, body: input.body, headers: input.incoming });
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
  if (provider.authStyle === "none") return true;
  return credential?.provider === provider.slug;
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

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
