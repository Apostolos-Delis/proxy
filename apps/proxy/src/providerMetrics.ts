import { performance } from "node:perf_hooks";

import type { AppConfig } from "./config.js";
import type { ProviderAttemptStore } from "./events.js";
import {
  metricErrorClassForStatus,
  type MetricsCollector,
  metricStatusClassFor,
  metricTerminalStatusFor
} from "./metrics.js";
import { normalizeUsage } from "./persistence/values.js";
import { pricingForProviderModel, usageCostMicros } from "./pricing.js";
import type { JsonObject, Provider, RouteDecision, Surface } from "./types.js";
import { isRecord } from "./util.js";

type ProviderMetricLabels = {
  surface: Surface;
  provider: Provider;
  model: string;
};

export class ProviderMetrics {
  private readonly providerAttemptStartedAtMs = new Map<string, number>();
  private readonly providerAttemptStream = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly attempts: ProviderAttemptStore,
    private readonly metrics: MetricsCollector
  ) {}

  startAttempt(input: {
    providerAttemptId: string;
    surface: Surface;
    provider: Provider;
    stream: boolean;
  }) {
    this.providerAttemptStartedAtMs.set(input.providerAttemptId, performance.now());
    this.providerAttemptStream.set(input.providerAttemptId, input.stream ? "true" : "false");
    this.recordTerminalPendingAttempts(input.surface, input.provider);
  }

  clearAttempt(providerAttemptId: string) {
    this.providerAttemptStartedAtMs.delete(providerAttemptId);
    this.providerAttemptStream.delete(providerAttemptId);
  }

  recordTimeToFirstByte(input: ProviderMetricLabels & { stream: boolean; seconds: number }) {
    this.metrics.observeHistogram("prompt_proxy_provider_time_to_first_byte_seconds", input.seconds, {
      surface: input.surface,
      provider: input.provider,
      model: input.model,
      stream: input.stream ? "true" : "false"
    });
  }

  recordProtocolMismatch(input: ProviderMetricLabels & { stream: boolean }) {
    this.metrics.incrementCounter("prompt_proxy_provider_protocol_mismatches_total", {
      surface: input.surface,
      provider: input.provider,
      model: input.model,
      stream: input.stream ? "true" : "false"
    });
  }

  recordStreamBytes(input: ProviderMetricLabels & {
    status: "completed" | "failed" | "cancelled";
    bytes: number;
  }) {
    if (input.bytes <= 0) return;
    this.metrics.incrementCounter("prompt_proxy_provider_stream_bytes_total", {
      surface: input.surface,
      provider: input.provider,
      model: input.model,
      terminal_status: metricTerminalStatusFor(input.status)
    }, input.bytes);
  }

  recordClientCancellation(input: {
    surface: Surface;
    stream: boolean;
    stage: "before_provider" | "after_headers" | "after_bytes" | "unknown";
  }) {
    this.metrics.incrementCounter("prompt_proxy_client_cancellations_total", {
      surface: input.surface,
      stream: input.stream ? "true" : "false",
      stage: input.stage
    });
  }

  recordTerminal(input: {
    surface: Surface;
    provider: Provider;
    decision: RouteDecision;
    providerAttemptId: string;
    status: "completed" | "failed" | "cancelled";
    usage: unknown;
    upstreamStatus: number;
    metadata: JsonObject;
  }) {
    const model = input.decision.selectedModel ?? "unknown";
    const terminalStatus = metricTerminalStatusFor(input.status);
    const errorClass = providerTerminalErrorClass(input.status, input.upstreamStatus);
    const startedAtMs = this.providerAttemptStartedAtMs.get(input.providerAttemptId);
    const stream = this.providerAttemptStream.get(input.providerAttemptId) ?? "unknown";

    this.metrics.incrementCounter("prompt_proxy_provider_attempts_total", {
      surface: input.surface,
      provider: input.provider,
      model,
      stream,
      terminal_status: terminalStatus,
      status_class: metricStatusClassFor(input.upstreamStatus),
      error_class: errorClass
    });
    if (startedAtMs !== undefined) {
      this.metrics.observeHistogram("prompt_proxy_provider_attempt_duration_seconds", (performance.now() - startedAtMs) / 1000, {
        surface: input.surface,
        provider: input.provider,
        model,
        stream,
        terminal_status: terminalStatus
      });
    }
    if (typeof input.metadata.observerError === "string") {
      this.metrics.incrementCounter("prompt_proxy_sse_observer_parse_failures_total", {
        surface: input.surface,
        provider: input.provider,
        model,
        error_class: "unknown"
      });
    }
    if (input.status === "cancelled") {
      this.metrics.incrementCounter("prompt_proxy_provider_stream_disconnects_total", {
        surface: input.surface,
        provider: input.provider,
        model,
        error_class: "client_cancelled"
      });
    }
    if (input.status === "completed" && input.usage === undefined) {
      this.metrics.incrementCounter("prompt_proxy_missing_usage_total", {
        surface: input.surface,
        provider: input.provider,
        model,
        reason: "provider_omitted"
      });
    }
    this.recordTerminalPendingAttempts(input.surface, input.provider, input.providerAttemptId);
    this.recordUsage(input, model);
    return errorClass;
  }

  private recordUsage(input: {
    surface: Surface;
    provider: Provider;
    usage: unknown;
  }, model: string) {
    if (!isRecord(input.usage)) return;

    const normalized = normalizeUsage(input.usage);
    const usageLabels = {
      surface: input.surface,
      provider: input.provider,
      model
    };
    this.metrics.incrementCounter("prompt_proxy_usage_tokens_total", { ...usageLabels, usage_kind: "input" }, normalized.inputTokens);
    this.metrics.incrementCounter("prompt_proxy_usage_tokens_total", { ...usageLabels, usage_kind: "cached_input" }, normalized.cachedInputTokens);
    this.metrics.incrementCounter("prompt_proxy_usage_tokens_total", { ...usageLabels, usage_kind: "cache_creation_input" }, normalized.cacheCreationInputTokens);
    this.metrics.incrementCounter("prompt_proxy_usage_tokens_total", { ...usageLabels, usage_kind: "output" }, normalized.outputTokens);
    this.metrics.incrementCounter("prompt_proxy_usage_tokens_total", { ...usageLabels, usage_kind: "reasoning" }, normalized.reasoningTokens);
    this.metrics.incrementCounter("prompt_proxy_usage_tokens_total", { ...usageLabels, usage_kind: "total" }, normalized.totalTokens);
    const cost = usageCostMicros(pricingForProviderModel(this.config.modelCosts, input.provider, model), normalized);
    this.metrics.incrementCounter("prompt_proxy_cost_usd_total", {
      ...usageLabels,
      cost_kind: "provider"
    }, cost.totalCostMicros / 1_000_000);
  }

  private recordTerminalPendingAttempts(surface: Surface, provider: Provider, excludeAttemptId?: string) {
    const count = this.attempts.list().filter((attempt) =>
      attempt.id !== excludeAttemptId &&
      attempt.surface === surface &&
      attempt.provider === provider &&
      attempt.terminalStatus === "pending"
    ).length;
    this.metrics.setGauge("prompt_proxy_terminal_pending_provider_attempts", count, { surface, provider });
  }
}

function providerTerminalErrorClass(
  status: "completed" | "failed" | "cancelled",
  upstreamStatus: number
) {
  if (status === "cancelled") return "client_cancelled";
  const statusErrorClass = metricErrorClassForStatus(upstreamStatus);
  if (status === "completed") return statusErrorClass;
  return statusErrorClass === "none" || statusErrorClass === "unknown" ? "provider" : statusErrorClass;
}
