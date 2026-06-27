import { afterEach, describe, expect, it } from "vitest";

import { defaultWorkspaceId, events } from "@proxy/db";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

let activeFixture: PromptTestFixture | undefined;

afterEach(async () => {
  await activeFixture?.close();
  activeFixture = undefined;
});

describe("promptCachePrewarms admin query", () => {
  it("reports prewarm cost, unused expiry, and cache-read lift", async () => {
    const organizationId = "org_prompt_cache_prewarm_report";
    const workspaceId = defaultWorkspaceId(organizationId);
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(events).values([
      prewarmEvent("event_completed", organizationId, workspaceId, "prompt_cache.prewarm_completed", {
        jobId: "job_completed",
        status: "succeeded",
        provider: "google-gemini-openai",
        model: "gemini-2.5-pro",
        estimatedCostMicros: 25000,
        actualCostMicros: 22000,
        cacheReadLiftTokens: 120000
      }, new Date("2026-06-27T12:05:00.000Z"), 2),
      prewarmEvent("event_started_old", organizationId, workspaceId, "prompt_cache.prewarm_started", {
        jobId: "job_completed",
        status: "running",
        provider: "google-gemini-openai",
        model: "gemini-2.5-pro",
        estimatedCostMicros: 25000
      }, new Date("2026-06-27T12:00:00.000Z"), 1),
      prewarmEvent("event_cancelled", organizationId, workspaceId, "prompt_cache.prewarm_cancelled", {
        jobId: "job_cancelled",
        status: "cancelled",
        provider: "google-gemini-openai",
        model: "gemini-2.5-pro",
        estimatedCostMicros: 15000
      }, new Date("2026-06-27T12:01:00.000Z"), 1),
      prewarmEvent("event_expired", organizationId, workspaceId, "prompt_cache.prewarm_expired_unused", {
        jobId: "job_expired",
        status: "expired_unused",
        provider: "anthropic",
        model: "claude-opus-4-8",
        estimatedCostMicros: 40000,
        actualCostMicros: 38000
      }, new Date("2026-06-27T12:02:00.000Z"), 1)
    ]);

    const result = (await adminGql(
      activeFixture.proxyUrl,
      activeFixture.adminHeaders,
      `query {
        promptCachePrewarms {
          totalJobs
          sampled
          estimatedCostMicros
          actualCostMicros
          expiredUnusedCostMicros
          cacheReadLiftTokens
          jobs { provider model status count estimatedCostMicros actualCostMicros expiredUnusedCostMicros cacheReadLiftTokens }
        }
      }`
    )).data?.promptCachePrewarms;

    expect(result).toMatchObject({
      totalJobs: 3,
      sampled: false,
      estimatedCostMicros: 80000,
      actualCostMicros: 60000,
      expiredUnusedCostMicros: 38000,
      cacheReadLiftTokens: 120000
    });
    expect(result.jobs).toContainEqual({
      provider: "google-gemini-openai",
      model: "gemini-2.5-pro",
      status: "succeeded",
      count: 1,
      estimatedCostMicros: 25000,
      actualCostMicros: 22000,
      expiredUnusedCostMicros: 0,
      cacheReadLiftTokens: 120000
    });
    expect(result.jobs).toContainEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      status: "expired_unused",
      count: 1,
      estimatedCostMicros: 40000,
      actualCostMicros: 38000,
      expiredUnusedCostMicros: 38000,
      cacheReadLiftTokens: 0
    });
  });
});

function prewarmEvent(
  id: string,
  organizationId: string,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
  createdAt: Date,
  sequence: number
) {
  return {
    id,
    sequence,
    schemaVersion: 1,
    organizationId,
    workspaceId,
    scopeType: "prompt_cache_prewarm",
    scopeId: String(payload.jobId),
    correlationId: String(payload.jobId),
    actorType: "proxy",
    actorId: "proxy",
    producer: "proxy.prompt-cache",
    eventType,
    payloadHash: `sha256:${id}`,
    sensitivity: "internal",
    redactionState: "redacted",
    payload,
    metadata: {},
    createdAt
  };
}
