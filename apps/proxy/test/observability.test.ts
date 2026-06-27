import { defaultWorkspaceId, events as eventRows } from "@proxy/db";
import { afterEach, describe, expect, it } from "vitest";

import { BoundedEventWriter } from "../src/events.js";
import { AsyncObservabilityEventAppender } from "../src/observability.js";
import type { AppendEventInput, EventAppender } from "../src/events.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const baseEvent: AppendEventInput = {
  tenantId: "org_test",
  workspaceId: "workspace_test",
  scopeType: "request",
  scopeId: "request_test",
  producer: "test",
  eventType: "routing.classification_recorded",
  redactionState: "not_applicable",
  payload: {}
};

describe("AsyncObservabilityEventAppender", () => {
  it("swallows async observability append failures", async () => {
    const appended: string[] = [];
    const drops: string[] = [];
    const failures: string[] = [];
    const events: EventAppender = {
      async append(input) {
        appended.push(input.eventType);
        throw new Error("append_failed");
      }
    };
    const writer = new BoundedEventWriter(events, {
      maxEntries: 10,
      maxBytes: 10_000,
      maxAttempts: 0,
      retryDelayMs: 1,
      onDrop: (input, reason) => drops.push(`${input.eventType}:${reason}`),
      onFlushFailure: (_error, input, attempt) => failures.push(`${input.eventType}:${attempt}`)
    });
    const appender = new AsyncObservabilityEventAppender(events, writer);

    await expect(appender.append(baseEvent)).resolves.toBeUndefined();
    await expect(appender.append({
      ...baseEvent,
      eventType: "prompt_cache.plan_applied"
    })).resolves.toBeUndefined();
    await writer.drain(100);

    expect(appended).toEqual(["routing.classification_recorded", "prompt_cache.plan_applied"]);
    expect(failures).toEqual(["routing.classification_recorded:1", "prompt_cache.plan_applied:1"]);
    expect(drops).toEqual(["routing.classification_recorded:retries_exhausted", "prompt_cache.plan_applied:retries_exhausted"]);
  });

  it("preserves synchronous failures for correctness events", async () => {
    const drops: string[] = [];
    const events: EventAppender = {
      async append() {
        throw new Error("append_failed");
      }
    };
    const writer = new BoundedEventWriter(events, {
      maxEntries: 10,
      maxBytes: 10_000,
      onDrop: (input, reason) => drops.push(`${input.eventType}:${reason}`)
    });
    const appender = new AsyncObservabilityEventAppender(events, writer);

    await expect(appender.append({
      ...baseEvent,
      eventType: "routing.decision_recorded"
    })).rejects.toThrow("append_failed");
    expect(drops).toEqual([]);
  });
});

describe("prompt cache plan observability", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("persists scoped plan events without raw request content or cache keys", async () => {
    const organizationId = "org_prompt_cache_plan_observability";
    const rawPromptText = "raw prompt text that must stay out of plan events";
    const rawCacheKey = "tenant:user:secret-cache-key";
    fixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { responsesJsonProvider: true }
    });

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: [{ role: "user", content: [{ type: "input_text", text: rawPromptText }] }],
        prompt_cache_key: rawCacheKey,
        prompt_cache_retention: "24h"
      })
    });
    await response.text();

    expect(response.status).toBe(200);
    const plan = await persistedPromptCachePlan(fixture);

    expect(plan?.organizationId).toBe(organizationId);
    expect(plan?.workspaceId).toBe(defaultWorkspaceId(organizationId));
    expect(plan?.eventType).toBe("prompt_cache.plan_applied");
    expect(plan?.redactionState).toBe("not_applicable");
    expect(plan?.payload).toMatchObject({
      surface: "openai-responses",
      provider: "openai",
      model: expect.any(String),
      mode: "implicit",
      dialect: "openai-responses",
      cacheKey: "provided",
      retention: "24h",
      appliedControls: expect.arrayContaining([
        "implicit_prefix_caching",
        "cache_key_preserved",
        "retention_preserved"
      ])
    });
    expect(plan?.payload).not.toHaveProperty("providerAttemptId");
    const payloadText = JSON.stringify(plan?.payload);
    expect(payloadText).not.toContain(rawPromptText);
    expect(payloadText).not.toContain(rawCacheKey);
  });
});

async function persistedPromptCachePlan(fixture: PromptTestFixture) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await fixture.db.select().from(eventRows);
    const plan = rows.find((event) => event.eventType === "prompt_cache.plan_applied");
    if (plan) return plan;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}
