import {
  promptCachePrewarmJobSchema,
  promptCachePrewarmSettingsSchema,
  type PromptCachePrewarmJob,
  type PromptCachePrewarmJobStatus,
  type PromptCachePrewarmSettings,
  type PromptCachePrewarmTriggerSource,
  type ProviderCachingCapabilities
} from "@proxy/schema";

import type { EventAppender } from "./events.js";
import { type MetricsCollector, NoopMetricsCollector } from "./metrics.js";
import type { JsonObject } from "./types.js";
import { createId, sha256 } from "./util.js";

export type PromptCachePrewarmAdapterResult = {
  providerCacheRef?: string;
  actualCostMicros?: number;
  metadata?: JsonObject;
};

export type PromptCachePrewarmAdapter = {
  prewarm(job: PromptCachePrewarmJob, signal: AbortSignal): Promise<PromptCachePrewarmAdapterResult>;
};

export type PromptCachePrewarmCandidate = {
  organizationId: string;
  workspaceId: string;
  provider: string;
  model: string;
  capabilities: Pick<ProviderCachingCapabilities, "prewarm">;
  triggerSource: PromptCachePrewarmTriggerSource;
  prefixDigest: string;
  estimatedInputTokens: number;
  estimatedCostMicros: number;
  currentDailySpendMicros?: number;
  currentHourlyJobs?: number;
  routingConfigVersionId?: string;
  sessionId?: string;
  now?: Date;
  ttlMs?: number;
  expectedFirstUseAt?: Date;
  timeoutMs?: number;
};

export type PromptCachePrewarmOutcome = {
  status: PromptCachePrewarmJobStatus;
  reason?: PromptCachePrewarmCancelReason | "provider_error";
  job: PromptCachePrewarmJob;
};

type PromptCachePrewarmCancelReason =
  | "setting_disabled"
  | "provider_capability_unavailable"
  | "provider_not_allowed"
  | "model_not_allowed"
  | "input_cap_exceeded"
  | "spend_cap_exceeded"
  | "hourly_cap_exceeded"
  | "expires_before_expected_use"
  | "duplicate";

const DEFAULT_PREWARM_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PREWARM_TIMEOUT_MS = 30_000;

export class PromptCachePrewarmService {
  private readonly idempotencyKeys = new Set<string>();

  constructor(
    private readonly events: EventAppender,
    private readonly adapter: PromptCachePrewarmAdapter,
    private readonly metrics: MetricsCollector = new NoopMetricsCollector()
  ) {}

  async prewarm(settingsInput: PromptCachePrewarmSettings, candidate: PromptCachePrewarmCandidate): Promise<PromptCachePrewarmOutcome> {
    const settings = promptCachePrewarmSettingsSchema.parse(settingsInput);
    const job = prewarmJob(settings, candidate);
    const cancellationReason = this.cancellationReason(settings, candidate, job);
    if (cancellationReason) {
      const cancelled = { ...job, status: "cancelled" as const };
      await this.append(cancelled, "prompt_cache.prewarm_cancelled", { reason: cancellationReason });
      this.recordJobMetric(cancelled, "cancelled", cancellationReason);
      return { status: "cancelled", reason: cancellationReason, job: cancelled };
    }

    this.idempotencyKeys.add(job.idempotencyKey);
    const running = { ...job, status: "running" as const };
    await this.append(running, "prompt_cache.prewarm_started");
    this.recordJobMetric(running, "running", "none");

    try {
      const result = await this.runWithTimeout(running, candidate.timeoutMs ?? DEFAULT_PREWARM_TIMEOUT_MS);
      const succeeded = promptCachePrewarmJobSchema.parse({
        ...running,
        status: "succeeded",
        actualCostMicros: result.actualCostMicros ?? running.estimatedCostMicros,
        providerCacheRef: result.providerCacheRef,
        metadata: result.metadata ?? running.metadata
      });
      await this.append(succeeded, "prompt_cache.prewarm_completed");
      this.recordJobMetric(succeeded, "succeeded", "none");
      this.metrics.incrementCounter(
        "proxy_prompt_cache_prewarm_cost_micros_total",
        { provider: succeeded.provider, model: succeeded.model, status: "succeeded" },
        succeeded.actualCostMicros ?? 0
      );
      return { status: "succeeded", job: succeeded };
    } catch {
      const failed = { ...running, status: "failed" as const };
      await this.append(failed, "prompt_cache.prewarm_failed", { reason: "provider_error" });
      this.recordJobMetric(failed, "failed", "provider_error");
      return { status: "failed", reason: "provider_error", job: failed };
    }
  }

  async expireUnused(job: PromptCachePrewarmJob): Promise<PromptCachePrewarmOutcome> {
    const expired = promptCachePrewarmJobSchema.parse({
      ...job,
      status: "expired_unused",
      actualCostMicros: job.actualCostMicros ?? job.estimatedCostMicros
    });
    await this.append(expired, "prompt_cache.prewarm_expired_unused");
    this.recordJobMetric(expired, "expired_unused", "none");
    return { status: "expired_unused", job: expired };
  }

  private cancellationReason(
    settings: PromptCachePrewarmSettings,
    candidate: PromptCachePrewarmCandidate,
    job: PromptCachePrewarmJob
  ): PromptCachePrewarmCancelReason | undefined {
    if (!settings.enabled) return "setting_disabled";
    if (!candidate.capabilities.prewarm) return "provider_capability_unavailable";
    if (!settings.providerAllowlist.includes(candidate.provider)) return "provider_not_allowed";
    if (!settings.modelAllowlist.includes(candidate.model)) return "model_not_allowed";
    if (candidate.estimatedInputTokens > settings.maxInputTokensPerJob) return "input_cap_exceeded";
    if ((candidate.currentDailySpendMicros ?? 0) + candidate.estimatedCostMicros > settings.maxDailySpendMicros) {
      return "spend_cap_exceeded";
    }
    if ((candidate.currentHourlyJobs ?? 0) >= settings.maxHourlyJobs) return "hourly_cap_exceeded";
    if (candidate.expectedFirstUseAt && Date.parse(job.expiresAt) <= candidate.expectedFirstUseAt.getTime()) {
      return "expires_before_expected_use";
    }
    if (this.idempotencyKeys.has(job.idempotencyKey)) return "duplicate";
    return undefined;
  }

  private async runWithTimeout(job: PromptCachePrewarmJob, timeoutMs: number) {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("prewarm_timeout"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.adapter.prewarm(job, controller.signal),
        timeoutPromise
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async append(job: PromptCachePrewarmJob, eventType: string, extra: JsonObject = {}) {
    await this.events.append({
      tenantId: job.organizationId,
      workspaceId: job.workspaceId,
      scopeType: "prompt_cache_prewarm",
      scopeId: job.id,
      correlationId: job.id,
      idempotencyKey: job.idempotencyKey,
      producer: "proxy.prompt-cache",
      eventType,
      payload: prewarmEventPayload(job, extra)
    });
  }

  private recordJobMetric(job: PromptCachePrewarmJob, status: string, reason: string) {
    this.metrics.incrementCounter("proxy_prompt_cache_prewarm_jobs_total", {
      provider: job.provider,
      model: job.model,
      status,
      reason
    });
  }
}

function prewarmJob(settings: PromptCachePrewarmSettings, candidate: PromptCachePrewarmCandidate): PromptCachePrewarmJob {
  const now = candidate.now ?? new Date();
  const ttlMs = candidate.ttlMs ?? DEFAULT_PREWARM_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const ttlBucket = Math.floor(now.getTime() / ttlMs);
  const idempotencyKey = [
    candidate.organizationId,
    candidate.workspaceId,
    candidate.provider,
    candidate.model,
    candidate.triggerSource,
    candidate.routingConfigVersionId ?? candidate.sessionId ?? "none",
    candidate.prefixDigest,
    ttlBucket
  ].join(":");

  return promptCachePrewarmJobSchema.parse({
    id: createId("prewarm"),
    organizationId: candidate.organizationId,
    workspaceId: candidate.workspaceId,
    provider: candidate.provider,
    model: candidate.model,
    triggerSource: candidate.triggerSource,
    status: settings.enabled ? "queued" : "planned",
    idempotencyKey: sha256(idempotencyKey),
    prefixDigest: candidate.prefixDigest,
    routingConfigVersionId: candidate.routingConfigVersionId,
    sessionId: candidate.sessionId,
    scheduledFor: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    estimatedInputTokens: candidate.estimatedInputTokens,
    spendCapMicros: settings.maxDailySpendMicros,
    estimatedCostMicros: candidate.estimatedCostMicros
  });
}

function prewarmEventPayload(job: PromptCachePrewarmJob, extra: JsonObject): JsonObject {
  const payload: JsonObject = {
    jobId: job.id,
    status: job.status,
    provider: job.provider,
    model: job.model,
    triggerSource: job.triggerSource,
    prefixDigest: job.prefixDigest,
    scheduledFor: job.scheduledFor,
    expiresAt: job.expiresAt,
    estimatedInputTokens: job.estimatedInputTokens,
    spendCapMicros: job.spendCapMicros,
    estimatedCostMicros: job.estimatedCostMicros,
  };
  if (job.routingConfigVersionId !== undefined) payload.routingConfigVersionId = job.routingConfigVersionId;
  if (job.sessionId !== undefined) payload.sessionId = job.sessionId;
  if (job.actualCostMicros !== undefined) payload.actualCostMicros = job.actualCostMicros;
  if (job.providerCacheRef !== undefined) payload.providerCacheRef = job.providerCacheRef;
  return { ...payload, ...extra };
}
