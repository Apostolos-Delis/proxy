import { describe, expect, it } from "vitest";

import { TrafficLimitStore } from "../src/trafficLimits.js";

const baseInput = {
  organizationId: "org_limits",
  workspaceId: "workspace_limits",
  apiKeyId: "api_key_limits",
  userId: "user_limits",
  provider: "openai" as const,
  model: "gpt-limits",
  estimatedTokens: 10
};

describe("TrafficLimitStore", () => {
  it("rejects concurrent requests until the lease is released", () => {
    const store = new TrafficLimitStore({ windowMs: 60_000, globalConcurrent: 1 });
    const first = store.acquire(baseInput);
    const second = store.acquire(baseInput);

    expect(first.allowed).toBe(true);
    expect(second).toMatchObject({
      allowed: false,
      error: "traffic_limit_exceeded:global:concurrency",
      scope: "global",
      limit: 1,
      current: 1
    });
    if (first.allowed) {
      first.lease.release();
      first.lease.release();
    }
    expect(store.acquire(baseInput).allowed).toBe(true);
  });

  it("applies scoped rpm and retry-after windows", () => {
    let now = 1000;
    const store = new TrafficLimitStore({ windowMs: 60_000, apiKeyRpm: 1 }, () => now);

    expect(store.acquire(baseInput).allowed).toBe(true);
    const second = store.acquire(baseInput);
    expect(second).toMatchObject({
      allowed: false,
      error: "traffic_limit_exceeded:api_key:rpm",
      retryAfterSeconds: 60
    });

    now += 60_000;
    expect(store.acquire(baseInput).allowed).toBe(true);
  });

  it("applies token-per-minute limits to provider/model scope", () => {
    const store = new TrafficLimitStore({ windowMs: 60_000, providerModelTpm: 15 });

    expect(store.acquire(baseInput, "provider_model").allowed).toBe(true);
    expect(store.acquire({ ...baseInput, estimatedTokens: 6 }, "provider_model")).toMatchObject({
      allowed: false,
      error: "traffic_limit_exceeded:provider_model:tpm",
      scope: "provider_model",
      limit: 15,
      current: 10
    });
    expect(store.acquire({ ...baseInput, model: "gpt-other", estimatedTokens: 6 }, "provider_model").allowed).toBe(true);
  });

  it("keeps request-stage and provider-stage limits independent", () => {
    const store = new TrafficLimitStore({
      windowMs: 60_000,
      globalConcurrent: 1,
      providerModelConcurrent: 1
    });
    const request = store.acquire(baseInput);
    const provider = store.acquire(baseInput, "provider_model");

    expect(request.allowed).toBe(true);
    expect(provider.allowed).toBe(true);
    expect(store.acquire(baseInput)).toMatchObject({
      allowed: false,
      error: "traffic_limit_exceeded:global:concurrency"
    });
    expect(store.acquire(baseInput, "provider_model")).toMatchObject({
      allowed: false,
      error: "traffic_limit_exceeded:provider_model:concurrency"
    });
  });
});
