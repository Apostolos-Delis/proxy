import {
  PROVIDER_HEALTH_MESSAGE_MAX_CHARS,
  type ProviderHealthClassification,
  type ProviderHealthClassificationSource,
  type ProviderHealthConfidence,
  type ProviderHealthMetadata,
  type ProviderHealthErrorType,
  type ProviderHealthScope
} from "@proxy/schema";

import type { ProviderAdapterFailureClassification } from "./providerAdapters/types.js";
import type { Provider } from "./types.js";

export type ProviderTerminalHealthInput = {
  provider: Provider;
  model: string;
  terminalStatus: "completed" | "failed" | "cancelled";
  statusCode?: number;
  error?: string;
  headers?: Record<string, string | undefined>;
  streamStatus?: "completed" | "failed" | "cancelled";
  adapterClassification?: ProviderAdapterFailureClassification;
  now?: Date;
};

type HealthMatch = {
  errorType: ProviderHealthErrorType;
  source: ProviderHealthClassificationSource;
  retryable: boolean;
  scope: ProviderHealthScope;
  cooldownMs?: number;
};

const minuteMs = 60_000;

export function classifyProviderTerminalHealth(input: ProviderTerminalHealthInput): ProviderHealthClassification | undefined {
  if (input.terminalStatus === "completed") return undefined;

  const now = input.now ?? new Date();
  const statusCode = input.statusCode;
  const message = sanitizedMessage(input.error);
  const lower = message?.toLowerCase() ?? "";

  const adapterClassification = input.adapterClassification;
  if (adapterClassification) {
    return adapterHealthClassification({ ...input, adapterClassification }, now, statusCode, message);
  }

  const match = healthMatch(input, lower);
  const retryHeaderMs = match.retryable && match.scope !== "request_only"
    ? retryWindowMs(input.headers, now)
    : undefined;
  const cooldownMs = retryHeaderMs ?? match.cooldownMs;
  return {
    errorType: match.errorType,
    source: match.source,
    confidence: confidenceFor(match),
    retryable: match.retryable,
    scope: match.scope,
    cooldownUntil: cooldownMs === undefined ? null : new Date(now.getTime() + cooldownMs).toISOString(),
    message,
    metadata: {
      provider: input.provider,
      model: input.model,
      ...(statusCode === undefined ? {} : { statusCode })
    }
  };
}

function adapterHealthClassification(
  input: ProviderTerminalHealthInput & { adapterClassification: ProviderAdapterFailureClassification },
  now: Date,
  statusCode: number | undefined,
  fallbackMessage: string | null
): ProviderHealthClassification {
  const classification = input.adapterClassification;
  const cooldownMs = classification.cooldownMs;
  const metadata: ProviderHealthMetadata = {
    provider: input.provider,
    model: input.model,
    adapterCategory: classification.category,
    fatal: classification.fatal,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...classification.metadata
  };
  return {
    errorType: classification.errorType,
    source: classification.source,
    confidence: classification.confidence ?? confidenceForSource(classification.source),
    retryable: classification.retryable,
    scope: classification.scope,
    cooldownUntil: cooldownMs === undefined ? null : new Date(now.getTime() + cooldownMs).toISOString(),
    message: sanitizedMessage(classification.message ?? undefined) ?? fallbackMessage,
    metadata
  };
}

function healthMatch(input: ProviderTerminalHealthInput, lower: string): HealthMatch {
  if (input.terminalStatus === "cancelled") {
    return requestOnly("stream_disconnected", "stream_observer", false);
  }
  if (input.streamStatus === "failed") {
    return requestOnly("stream_failed", "stream_observer", true);
  }
  if (authExpired(input.statusCode, lower)) {
    return {
      errorType: "auth_expired",
      source: "response_body",
      retryable: true,
      scope: "provider_account",
      cooldownMs: minuteMs
    };
  }
  if (input.statusCode === 401) {
    return {
      errorType: "auth_invalid",
      source: "provider_status",
      retryable: false,
      scope: "provider_account"
    };
  }
  if (modelAccessDenied(lower)) {
    return {
      errorType: "model_access_denied",
      source: "response_body",
      retryable: false,
      scope: "provider_account_model"
    };
  }
  if (quotaExhausted(lower)) {
    return {
      errorType: "quota_exhausted",
      source: "response_body",
      retryable: true,
      scope: "provider_account",
      cooldownMs: 60 * minuteMs
    };
  }
  if (input.statusCode === 429) {
    return {
      errorType: "rate_limited",
      source: "provider_status",
      retryable: true,
      scope: "provider_account",
      cooldownMs: minuteMs
    };
  }
  if (modelUnavailable(input.statusCode, lower)) {
    return {
      errorType: "model_unavailable",
      source: lower ? "response_body" : "provider_status",
      retryable: true,
      scope: "provider_account_model",
      cooldownMs: 10 * minuteMs
    };
  }
  if (contextOverflow(lower)) {
    return requestOnly("context_overflow", "response_body", false);
  }
  if (requestIncompatible(lower)) {
    return requestOnly("request_incompatible", "response_body", false);
  }
  if (providerUnavailable(input.statusCode)) {
    return {
      errorType: "provider_unavailable",
      source: "provider_status",
      retryable: true,
      scope: "provider",
      cooldownMs: 30_000
    };
  }
  if (unknownTransient(input.statusCode)) {
    return {
      errorType: "unknown_transient",
      source: "proxy_policy",
      retryable: true,
      scope: "provider_account",
      cooldownMs: 30_000
    };
  }
  return requestOnly("unknown_terminal", "proxy_policy", false);
}

function requestOnly(
  errorType: ProviderHealthErrorType,
  source: ProviderHealthClassificationSource,
  retryable: boolean
): HealthMatch {
  return {
    errorType,
    source,
    retryable,
    scope: "request_only"
  };
}

function sanitizedMessage(error: string | undefined) {
  const trimmed = error?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, PROVIDER_HEALTH_MESSAGE_MAX_CHARS);
}

function confidenceFor(match: HealthMatch) {
  if (match.errorType === "unknown_terminal" || match.errorType === "unknown_transient") return "unknown";
  if (match.source === "response_body") return "heuristic";
  return "exact";
}

function confidenceForSource(source: ProviderHealthClassificationSource): ProviderHealthConfidence {
  if (source === "response_body") return "heuristic";
  if (source === "proxy_policy") return "unknown";
  return "exact";
}

function authExpired(statusCode: number | undefined, value: string) {
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

function modelUnavailable(statusCode: number | undefined, value: string) {
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

function providerUnavailable(statusCode: number | undefined) {
  return statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504;
}

function unknownTransient(statusCode: number | undefined) {
  return statusCode === undefined ||
    statusCode === 0 ||
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 425;
}

function retryWindowMs(headers: Record<string, string | undefined> | undefined, now: Date) {
  const retryAfter = headerValue(headers, "retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now.getTime());
  return undefined;
}

function headerValue(headers: Record<string, string | undefined> | undefined, name: string) {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}
