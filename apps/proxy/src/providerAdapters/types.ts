import type {
  HarnessCompatibilityProfileId,
  ProviderHealthClassificationSource,
  ProviderHealthConfidence,
  ProviderHealthErrorType,
  ProviderHealthMetadata,
  ProviderHealthScope
} from "@proxy/schema";
import type { FastifyReply } from "fastify";

import type { GatewayExecutionTarget } from "../gatewayRuntime.js";
import type { RequestTiming } from "../requestTiming.js";
import type { JsonObject, Surface } from "../types.js";

export type ProviderForwardLease = {
  release: () => void;
};

export type ProviderForwardResult = "forwarded" | "rejected";

export type ProviderForwardInput = {
  requestId: string;
  idempotencyKey: string;
  organizationId: string;
  workspaceId: string;
  sessionId?: string;
  surface: Surface;
  harnessProfileId?: HarnessCompatibilityProfileId;
  target: GatewayExecutionTarget;
  body: unknown;
  responseStream?: boolean;
  headers: Record<string, string | undefined>;
  reply: FastifyReply;
  path?: string;
  acquireProviderLimit?: (
    target: GatewayExecutionTarget
  ) => Promise<ProviderForwardLease | undefined>;
  onAssistantText?: (text: string, truncated: boolean) => Promise<void>;
  compressionTelemetry?: JsonObject;
  onTerminal?: (terminal: {
    status: "completed" | "failed" | "cancelled";
    errorClass: string;
  }) => void;
  timing?: RequestTiming;
};

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
