import type { ProviderAdapterFailureClassification } from "./types.js";
import type { ProviderHealthMetadata } from "@proxy/schema";
import { isRecord } from "../util.js";

export const BEDROCK_ERROR_KINDS = [
  "auth_missing",
  "auth_denied",
  "model_access_denied",
  "region_unavailable",
  "model_unavailable",
  "rate_limited",
  "quota_exceeded",
  "context_too_large",
  "unsupported_request_shape",
  "guardrail_intervention",
  "upstream_timeout",
  "transport_failure",
  "stream_permission_denied",
  "unknown"
] as const;

export type BedrockErrorKind = typeof BEDROCK_ERROR_KINDS[number];

export type BedrockErrorClassificationInput = {
  error?: unknown;
  status?: number;
  message?: string | null;
  timedOut?: boolean;
  region?: string;
  model?: string;
  operation?: "Converse" | "ConverseStream";
};

type BedrockClassificationRule = {
  kind: BedrockErrorKind;
  category: ProviderAdapterFailureClassification["category"];
  errorType: ProviderAdapterFailureClassification["errorType"];
  source: ProviderAdapterFailureClassification["source"];
  retryable: boolean;
  fatal: boolean;
  scope: ProviderAdapterFailureClassification["scope"];
  cooldownMs?: number;
};

const minuteMs = 60_000;

export function classifyBedrockError(input: BedrockErrorClassificationInput): ProviderAdapterFailureClassification {
  const normalized = normalizeBedrockError(input);
  const rule = bedrockClassificationRule(normalized);
  return {
    category: rule.category,
    errorType: rule.errorType,
    source: rule.source,
    confidence: rule.source === "response_body" ? "heuristic" : "exact",
    retryable: rule.retryable,
    fatal: rule.fatal,
    scope: rule.scope,
    ...(rule.cooldownMs !== undefined ? { cooldownMs: rule.cooldownMs } : {}),
    ...(normalized.message ? { message: normalized.message } : {}),
    metadata: compactMetadata({
      bedrockErrorKind: rule.kind,
      bedrockErrorName: normalized.name,
      bedrockOperation: input.operation,
      region: input.region,
      model: input.model,
      statusCode: input.status
    })
  };
}

export function parseBedrockErrorBody(text: string | undefined) {
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { message: text };
  }
  if (!isRecord(parsed)) return { message: text };
  if (isRecord(parsed.error)) {
    return {
      name: stringValue(parsed.error.code) ?? stringValue(parsed.error.type),
      message: stringValue(parsed.error.message)
    };
  }
  return {
    name: stringValue(parsed.code) ?? stringValue(parsed.name) ?? stringValue(parsed.__type),
    message: stringValue(parsed.message)
  };
}

function normalizeBedrockError(input: BedrockErrorClassificationInput) {
  const fromBody = isRecord(input.error) ? input.error : {};
  const name = stringValue(fromBody.name) ??
    stringValue(fromBody.code) ??
    stringValue(fromBody.__type);
  const message = sanitizedMessage(input.message) ??
    sanitizedMessage(stringValue(fromBody.message)) ??
    sanitizedMessage(input.error instanceof Error ? input.error.message : undefined);
  return {
    name,
    message,
    lowerName: name?.toLowerCase() ?? "",
    lowerMessage: message?.toLowerCase() ?? "",
    status: input.status,
    timedOut: input.timedOut === true,
    operation: input.operation
  };
}

function bedrockClassificationRule(input: ReturnType<typeof normalizeBedrockError>): BedrockClassificationRule {
  if (input.timedOut || input.lowerName.includes("timeout")) {
    return rule("upstream_timeout", "upstream_timeout", "unknown_transient", "proxy_policy", true, false, "provider_account", 30_000);
  }
  if (streamPermissionDenied(input)) {
    return rule("stream_permission_denied", "auth_denied", "model_access_denied", "response_body", false, true, "provider_account_model");
  }
  if (modelAccessDenied(input)) {
    return rule("model_access_denied", "auth_denied", "model_access_denied", "response_body", false, true, "provider_account_model");
  }
  if (authMissing(input)) {
    return rule("auth_missing", "auth_denied", "auth_invalid", "proxy_policy", false, true, "provider_account");
  }
  if (authDenied(input)) {
    return rule("auth_denied", "auth_denied", "auth_invalid", "provider_status", false, true, "provider_account");
  }
  if (quotaExceeded(input)) {
    return rule("quota_exceeded", "quota_exceeded", "quota_exhausted", "response_body", true, false, "provider_account", 5 * minuteMs);
  }
  if (rateLimited(input)) {
    return rule("rate_limited", "rate_limited", "rate_limited", "provider_status", true, false, "provider_account", minuteMs);
  }
  if (contextTooLarge(input)) {
    return rule("context_too_large", "context_too_large", "context_overflow", "response_body", false, true, "request_only");
  }
  if (guardrailIntervention(input)) {
    return rule("guardrail_intervention", "unsupported_request_shape", "request_incompatible", "response_body", false, true, "request_only");
  }
  if (unsupportedRequest(input)) {
    return rule("unsupported_request_shape", "unsupported_request_shape", "request_incompatible", "response_body", false, true, "request_only");
  }
  if (regionUnavailable(input)) {
    return rule("region_unavailable", "upstream_unavailable", "provider_unavailable", "response_body", true, false, "provider_account", 10 * minuteMs);
  }
  if (modelUnavailable(input)) {
    return rule("model_unavailable", "upstream_unavailable", "model_unavailable", "response_body", true, false, "provider_account_model", 10 * minuteMs);
  }
  if (providerUnavailable(input)) {
    return rule("transport_failure", "upstream_unavailable", "provider_unavailable", "provider_status", true, false, "provider", 30_000);
  }
  if (input.status !== undefined && input.status >= 500) {
    return rule("transport_failure", "network_error", "unknown_transient", "provider_status", true, false, "provider_account", 30_000);
  }
  return rule("unknown", "unknown", "unknown_terminal", "proxy_policy", false, true, "request_only");
}

function rule(
  kind: BedrockErrorKind,
  category: BedrockClassificationRule["category"],
  errorType: BedrockClassificationRule["errorType"],
  source: BedrockClassificationRule["source"],
  retryable: boolean,
  fatal: boolean,
  scope: BedrockClassificationRule["scope"],
  cooldownMs?: number
): BedrockClassificationRule {
  return { kind, category, errorType, source, retryable, fatal, scope, cooldownMs };
}

function streamPermissionDenied(input: ReturnType<typeof normalizeBedrockError>) {
  return input.operation === "ConverseStream" &&
    (input.lowerMessage.includes("invokemodelwithresponsestream") ||
      input.lowerMessage.includes("responsestream") ||
      input.lowerMessage.includes("conversestream"));
}

function modelAccessDenied(input: ReturnType<typeof normalizeBedrockError>) {
  return input.lowerMessage.includes("model access") ||
    input.lowerMessage.includes("not authorized to invoke") ||
    input.lowerMessage.includes("access to the model") ||
    input.lowerMessage.includes("model is not enabled");
}

function authMissing(input: ReturnType<typeof normalizeBedrockError>) {
  return input.lowerName.includes("credential") ||
    input.lowerMessage.includes("credential") ||
    input.lowerMessage.includes("no identity") ||
    input.lowerMessage.includes("missing authentication");
}

function authDenied(input: ReturnType<typeof normalizeBedrockError>) {
  return input.status === 401 ||
    input.status === 403 ||
    input.lowerName.includes("accessdenied") ||
    input.lowerName.includes("unauthorized") ||
    input.lowerName.includes("unrecognizedclient") ||
    input.lowerName.includes("expiredtoken") ||
    input.lowerMessage.includes("access denied") ||
    input.lowerMessage.includes("not authorized");
}

function quotaExceeded(input: ReturnType<typeof normalizeBedrockError>) {
  return input.lowerName.includes("quota") ||
    input.lowerMessage.includes("quota") ||
    input.lowerMessage.includes("service quota");
}

function rateLimited(input: ReturnType<typeof normalizeBedrockError>) {
  return input.status === 429 ||
    input.lowerName.includes("throttl") ||
    input.lowerName.includes("toomanyrequests") ||
    input.lowerMessage.includes("rate exceeded") ||
    input.lowerMessage.includes("too many requests");
}

function contextTooLarge(input: ReturnType<typeof normalizeBedrockError>) {
  return (
    input.lowerMessage.includes("context") && (
      input.lowerMessage.includes("too long") ||
      input.lowerMessage.includes("too large") ||
      input.lowerMessage.includes("maximum") ||
      input.lowerMessage.includes("exceed")
    )
  ) || input.lowerMessage.includes("input is too long");
}

function guardrailIntervention(input: ReturnType<typeof normalizeBedrockError>) {
  return input.lowerMessage.includes("guardrail") &&
    (input.lowerMessage.includes("interven") || input.lowerMessage.includes("blocked"));
}

function unsupportedRequest(input: ReturnType<typeof normalizeBedrockError>) {
  return input.lowerName.includes("validation") ||
    input.lowerMessage.includes("unsupported") ||
    input.lowerMessage.includes("invalid request") ||
    input.lowerMessage.includes("malformed");
}

function regionUnavailable(input: ReturnType<typeof normalizeBedrockError>) {
  return input.lowerMessage.includes("region") &&
    (input.lowerMessage.includes("not supported") ||
      input.lowerMessage.includes("unavailable") ||
      input.lowerMessage.includes("unknown endpoint"));
}

function modelUnavailable(input: ReturnType<typeof normalizeBedrockError>) {
  return input.lowerName.includes("resourcenotfound") ||
    input.lowerName.includes("modelnotready") ||
    (input.lowerMessage.includes("model") && (
      input.lowerMessage.includes("not found") ||
      input.lowerMessage.includes("not ready") ||
      input.lowerMessage.includes("unavailable") ||
      input.lowerMessage.includes("not supported")
    ));
}

function providerUnavailable(input: ReturnType<typeof normalizeBedrockError>) {
  return input.status === 503 ||
    input.lowerName.includes("serviceunavailable") ||
    input.lowerName.includes("internalserver") ||
    input.lowerMessage.includes("service unavailable");
}

function sanitizedMessage(value: string | undefined | null) {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compactMetadata(input: Record<string, unknown>): ProviderHealthMetadata {
  const out: ProviderHealthMetadata = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    }
  }
  return out;
}
