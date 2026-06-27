import { describe, expect, it } from "vitest";

import { EventService } from "../src/events.js";
import { InMemoryMetricsCollector } from "../src/metrics.js";
import {
  PromptCachePrewarmService,
  type PromptCachePrewarmAdapter,
  type PromptCachePrewarmCandidate
} from "../src/promptCachePrewarm.js";

const settings = {
  enabled: true,
  maxDailySpendMicros: 100000,
  maxHourlyJobs: 5,
  maxInputTokensPerJob: 32000,
  providerAllowlist: ["google-gemini-openai"],
  modelAllowlist: ["gemini-2.5-pro"]
};

const candidate: PromptCachePrewarmCandidate = {
  organizationId: "org_prewarm",
  workspaceId: "ws_prewarm",
  provider: "google-gemini-openai",
  model: "gemini-2.5-pro",
  capabilities: { prewarm: true },
  triggerSource: "route_config_publish",
  prefixDigest: "sha256:prefix",
  estimatedInputTokens: 12000,
  estimatedCostMicros: 25000,
  routingConfigVersionId: "version_1",
  now: new Date("2026-06-27T12:00:00.000Z")
};

describe("PromptCachePrewarmService", () => {
  it("runs provider prewarm through the adapter and emits bounded accounting events", async () => {
    const events = new EventService(undefined, undefined, undefined, "org_prewarm");
    const metrics = new InMemoryMetricsCollector();
    const adapterCalls: string[] = [];
    const adapter: PromptCachePrewarmAdapter = {
      async prewarm(job, signal) {
        adapterCalls.push(job.id);
        expect(signal.aborted).toBe(false);
        return {
          providerCacheRef: "cache_ref_1",
          actualCostMicros: 22000,
          metadata: { providerStatus: "created" }
        };
      }
    };
    const service = new PromptCachePrewarmService(events, adapter, metrics);

    const outcome = await service.prewarm(settings, candidate);

    expect(outcome.status).toBe("succeeded");
    expect(adapterCalls).toHaveLength(1);
    const rows = events.listEvents();
    expect(rows.map((event) => event.eventType)).toEqual([
      "prompt_cache.prewarm_started",
      "prompt_cache.prewarm_completed"
    ]);
    expect(rows[0]?.workspaceId).toBe("ws_prewarm");
    expect(rows[1]?.payload).toEqual(expect.objectContaining({
      provider: "google-gemini-openai",
      model: "gemini-2.5-pro",
      status: "succeeded",
      prefixDigest: "sha256:prefix",
      actualCostMicros: 22000,
      providerCacheRef: "cache_ref_1"
    }));
    expect(JSON.stringify(rows)).not.toContain("large shared prefix");
    expect(metrics.snapshot().counters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "proxy_prompt_cache_prewarm_jobs_total",
        labels: expect.objectContaining({ status: "succeeded", reason: "none" }),
        value: 1
      }),
      expect.objectContaining({
        name: "proxy_prompt_cache_prewarm_cost_micros_total",
        labels: expect.objectContaining({ status: "succeeded" }),
        value: 22000
      })
    ]));

    await expect(service.expireUnused(outcome.job)).resolves.toMatchObject({ status: "expired_unused" });
    expect(events.listEvents().map((event) => event.eventType)).toEqual([
      "prompt_cache.prewarm_started",
      "prompt_cache.prewarm_completed",
      "prompt_cache.prewarm_expired_unused"
    ]);
  });

  it("does not call the adapter when disabled or over spend cap", async () => {
    const events = new EventService(undefined, undefined, undefined, "org_prewarm");
    const adapter: PromptCachePrewarmAdapter = {
      async prewarm() {
        throw new Error("adapter should not run");
      }
    };
    const service = new PromptCachePrewarmService(events, adapter);

    await expect(service.prewarm({ ...settings, enabled: false }, candidate))
      .resolves.toMatchObject({ status: "cancelled", reason: "setting_disabled" });
    await expect(service.prewarm(settings, {
      ...candidate,
      currentDailySpendMicros: 90000,
      estimatedCostMicros: 20000
    })).resolves.toMatchObject({ status: "cancelled", reason: "spend_cap_exceeded" });

    expect(events.listEvents().map((event) => event.eventType)).toEqual([
      "prompt_cache.prewarm_cancelled",
      "prompt_cache.prewarm_cancelled"
    ]);
  });

  it("deduplicates jobs in the same TTL bucket", async () => {
    const events = new EventService(undefined, undefined, undefined, "org_prewarm");
    let adapterCalls = 0;
    const adapter: PromptCachePrewarmAdapter = {
      async prewarm() {
        adapterCalls += 1;
        return { actualCostMicros: 1000 };
      }
    };
    const service = new PromptCachePrewarmService(events, adapter);

    await expect(service.prewarm(settings, candidate)).resolves.toMatchObject({ status: "succeeded" });
    await expect(service.prewarm(settings, {
      ...candidate,
      now: new Date("2026-06-27T12:01:00.000Z")
    })).resolves.toMatchObject({ status: "cancelled", reason: "duplicate" });

    expect(adapterCalls).toBe(1);
  });

  it("fails provider work that exceeds the timeout", async () => {
    const events = new EventService(undefined, undefined, undefined, "org_prewarm");
    const adapter: PromptCachePrewarmAdapter = {
      async prewarm() {
        return new Promise<never>(() => {});
      }
    };
    const service = new PromptCachePrewarmService(events, adapter);

    await expect(service.prewarm(settings, {
      ...candidate,
      timeoutMs: 1
    })).resolves.toMatchObject({ status: "failed", reason: "provider_error" });

    expect(events.listEvents().map((event) => event.eventType)).toEqual([
      "prompt_cache.prewarm_started",
      "prompt_cache.prewarm_failed"
    ]);
  });
});
