import type {
  ProviderHealthClassificationSource,
  ProviderHealthConfidence,
  ProviderHealthErrorType,
  ProviderHealthMetadata,
  ProviderHealthScope
} from "@proxy/schema";

export const PROVIDER_ADAPTER_FAILURE_CATEGORIES = [
  "auth_denied",
  "rate_limited",
  "quota_exceeded",
  "context_too_large",
  "unsupported_request_shape",
  "upstream_timeout",
  "upstream_unavailable",
  "malformed_upstream_response",
  "network_error",
  "unknown"
] as const;

export type ProviderAdapterFailureCategory = typeof PROVIDER_ADAPTER_FAILURE_CATEGORIES[number];

export type ProviderAdapterFailureClassification = {
  category: ProviderAdapterFailureCategory;
  errorType: ProviderHealthErrorType;
  source: ProviderHealthClassificationSource;
  confidence?: ProviderHealthConfidence;
  retryable: boolean;
  fatal: boolean;
  scope: ProviderHealthScope;
  cooldownMs?: number;
  message?: string | null;
  metadata?: ProviderHealthMetadata;
};
