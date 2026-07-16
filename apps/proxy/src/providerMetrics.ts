import { performance } from "node:perf_hooks";

import type { ProviderAttemptStore } from "./events.js";
import {
  metricErrorClassForStatus,
  type MetricsCollector,
  metricStatusClassFor,
  metricTerminalStatusFor
} from "./metrics.js";
import { normalizeUsage } from "./persistence/values.js";
import { promptCacheControlLabel, type PromptCachePlan, promptCacheSkipReasonLabel } from "./promptCachePlan.js";
import type { JsonObject, Provider, Surface } from "./types.js";
import { isRecord } from "./util.js";

export type ProviderMetricLabels = {
  surface: Surface;
  provider: Provider;
  model: string;
};

export class ProviderMetrics {
  private readonly providerAttemptStartedAtMs = new Map<string, number>();
  private readonly providerAttemptStream = new Map<string, string>();

  constructor(
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
    this.metrics.observeHistogram("proxy_provider_time_to_first_byte_seconds", input.seconds, {
      surface: input.surface,
      provider: input.provider,
      model: input.model,
      stream: input.stream ? "true" : "false"
    });
  }

  recordProtocolMismatch(input: ProviderMetricLabels & { stream: boolean }) {
    this.metrics.incrementCounter("proxy_provider_protocol_mismatches_total", {
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
    this.metrics.incrementCounter("proxy_provider_stream_bytes_total", {
      surface: input.surface,
      provider: input.provider,
      model: input.model,
      terminal_status: metricTerminalStatusFor(input.status)
    }, input.bytes);
  }

  recordPromptCachePlan(input: ProviderMetricLabels & { plan: PromptCachePlan }) {
    recordPromptCachePlanMetrics(this.metrics, input);
  }

  recordClientCancellation(input: {
    surface: Surface;
    stream: boolean;
    stage: "before_provider" | "after_headers" | "after_bytes" | "unknown";
  }) {
    this.metrics.incrementCounter("proxy_client_cancellations_total", {
      surface: input.surface,
      stream: input.stream ? "true" : "false",
      stage: input.stage
    });
  }

  recordTerminal(input: {
    surface: Surface;
    provider: Provider;
    model: string;
    providerAttemptId: string;
    status: "completed" | "failed" | "cancelled";
    usage: unknown;
    upstreamStatus: number;
    metadata: JsonObject;
  }) {
    const model = input.model;
    const terminalStatus = metricTerminalStatusFor(input.status);
    const errorClass = providerTerminalErrorClass(input.status, input.upstreamStatus);
    const startedAtMs = this.providerAttemptStartedAtMs.get(input.providerAttemptId);
    const stream = this.providerAttemptStream.get(input.providerAttemptId) ?? "unknown";

    this.metrics.incrementCounter("proxy_provider_attempts_total", {
      surface: input.surface,
      provider: input.provider,
      model,
      stream,
      terminal_status: terminalStatus,
      status_class: metricStatusClassFor(input.upstreamStatus),
      error_class: errorClass
    });
    if (startedAtMs !== undefined) {
      this.metrics.observeHistogram("proxy_provider_attempt_duration_seconds", (performance.now() - startedAtMs) / 1000, {
        surface: input.surface,
        provider: input.provider,
        model,
        stream,
        terminal_status: terminalStatus
      });
    }
    if (typeof input.metadata.observerError === "string") {
      this.metrics.incrementCounter("proxy_sse_observer_parse_failures_total", {
        surface: input.surface,
        provider: input.provider,
        model,
        error_class: "unknown"
      });
    }
    if (input.status === "cancelled") {
      this.metrics.incrementCounter("proxy_provider_stream_disconnects_total", {
        surface: input.surface,
        provider: input.provider,
        model,
        error_class: "client_cancelled"
      });
    }
    if (input.status === "completed" && input.usage === undefined) {
      this.metrics.incrementCounter("proxy_missing_usage_total", {
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
    this.metrics.incrementCounter("proxy_usage_tokens_total", { ...usageLabels, usage_kind: "input" }, normalized.inputTokens);
    this.metrics.incrementCounter("proxy_usage_tokens_total", { ...usageLabels, usage_kind: "cached_input" }, normalized.cachedInputTokens);
    this.metrics.incrementCounter("proxy_usage_tokens_total", { ...usageLabels, usage_kind: "cache_creation_input" }, normalized.cacheCreationInputTokens);
    this.metrics.incrementCounter("proxy_usage_tokens_total", { ...usageLabels, usage_kind: "output" }, normalized.outputTokens);
    this.metrics.incrementCounter("proxy_usage_tokens_total", { ...usageLabels, usage_kind: "reasoning" }, normalized.reasoningTokens);
    this.metrics.incrementCounter("proxy_usage_tokens_total", { ...usageLabels, usage_kind: "total" }, normalized.totalTokens);
  }

  private recordTerminalPendingAttempts(surface: Surface, provider: Provider, excludeAttemptId?: string) {
    const count = this.attempts.list().filter((attempt) =>
      attempt.id !== excludeAttemptId &&
      attempt.surface === surface &&
      attempt.provider === provider &&
      attempt.terminalStatus === "pending"
    ).length;
    this.metrics.setGauge("proxy_terminal_pending_provider_attempts", count, { surface, provider });
  }
}

export function recordPromptCachePlanMetrics(
  metrics: MetricsCollector,
  input: ProviderMetricLabels & { plan: PromptCachePlan }
) {
  const labels = {
    surface: input.surface,
    provider: input.provider,
    model: input.model,
    mode: input.plan.mode
  };
  metrics.incrementCounter("proxy_prompt_cache_plans_total", labels);
  for (const control of input.plan.appliedControls) {
    metrics.incrementCounter("proxy_prompt_cache_plan_controls_total", {
      ...labels,
      control: promptCacheControlLabel(control),
      status: "applied",
      reason: "none"
    });
  }
  for (const skipped of input.plan.skippedControls) {
    metrics.incrementCounter("proxy_prompt_cache_plan_controls_total", {
      ...labels,
      control: promptCacheControlLabel(skipped.control),
      status: "skipped",
      reason: promptCacheSkipReasonLabel(skipped.reason)
    });
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
