import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { BoundedEventWriter, EventService, ProviderAttemptStore, type AppendEventInput } from "../src/events.js";
import { SessionRouteStore } from "../src/policy.js";

describe("config and events", () => {
  it("ignores legacy route policy JSON keys", () => {
    const config = loadConfig({
      ROUTE_POLICY_SOURCE: "repo",
      ROUTE_POLICY_JSON: JSON.stringify({ budgetMaxRoute: "deep" }),
      TRUSTED_REPO_POLICY_HASH: "sha256:legacy"
    });

    expect("routePolicyTrust" in config).toBe(false);
  });

  it("parses database pool limits", () => {
    expect(loadConfig({}).dbPoolMax).toBe(5);
    expect(loadConfig({ DB_POOL_MAX: "12" }).dbPoolMax).toBe(12);
    expect(() => loadConfig({ DB_POOL_MAX: "0" })).toThrow();
    expect(() => loadConfig({ DB_POOL_MAX: "1.5" })).toThrow();
  });

  it("parses request body limits", () => {
    expect(loadConfig({}).requestBodyLimitBytes).toBe(1024 * 1024 * 50);
    expect(loadConfig({ NODE_ENV: "production" }).requestBodyLimitBytes).toBe(1024 * 1024 * 15);
    expect(loadConfig({ REQUEST_BODY_LIMIT_BYTES: "1024" }).requestBodyLimitBytes).toBe(1024);
    expect(() => loadConfig({ REQUEST_BODY_LIMIT_BYTES: "0" })).toThrow();
  });

  it("parses gateway traffic limits", () => {
    const config = loadConfig({
      GATEWAY_LIMIT_WINDOW_MS: "30000",
      GATEWAY_GLOBAL_CONCURRENCY_LIMIT: "20",
      GATEWAY_API_KEY_RPM_LIMIT: "100",
      GATEWAY_PROVIDER_MODEL_TPM_LIMIT: "100000"
    });

    expect(config.trafficLimits).toMatchObject({
      windowMs: 30000,
      globalConcurrent: 20,
      apiKeyRpm: 100,
      providerModelTpm: 100000
    });
    expect(loadConfig({}).trafficLimits.globalConcurrent).toBeUndefined();
    expect(() => loadConfig({ GATEWAY_GLOBAL_CONCURRENCY_LIMIT: "0" })).toThrow();
    expect(() => loadConfig({ GATEWAY_API_KEY_RPM_LIMIT: "1.5" })).toThrow();
  });

  it("parses event writer limits", () => {
    expect(loadConfig({}).eventWriterMaxEntries).toBe(10_000);
    expect(loadConfig({ EVENT_WRITER_MAX_ENTRIES: "12" }).eventWriterMaxEntries).toBe(12);
    expect(loadConfig({ EVENT_WRITER_MAX_BYTES: "2048" }).eventWriterMaxBytes).toBe(2048);
    expect(loadConfig({ EVENT_WRITER_BATCH_SIZE: "3" }).eventWriterBatchSize).toBe(3);
    expect(loadConfig({ EVENT_WRITER_SHUTDOWN_TIMEOUT_MS: "250" }).eventWriterShutdownTimeoutMs).toBe(250);
    expect(() => loadConfig({ EVENT_WRITER_MAX_ENTRIES: "0" })).toThrow();
    expect(() => loadConfig({ EVENT_WRITER_MAX_BYTES: "0" })).toThrow();
  });

  it("tracks outbox processing states only after real handlers run", async () => {
    const events = new EventService();
    const successEvents = new EventService(undefined, async () => {});
    const missingEventOutbox = new EventService();

    await events.append({
      scopeType: "request",
      scopeId: "request-1",
      producer: "test",
      eventType: "test.event"
    });
    await successEvents.append({
      scopeType: "request",
      scopeId: "request-2",
      producer: "test",
      eventType: "test.event"
    });
    await missingEventOutbox.append({
      scopeType: "request",
      scopeId: "request-3",
      producer: "test",
      eventType: "test.event"
    });
    (missingEventOutbox as unknown as { events: unknown[] }).events.length = 0;
    await events.processOutbox(async () => {
      throw new Error("fanout failed");
    });
    await missingEventOutbox.processOutbox(async () => {});

    expect(events.listOutbox()[0].status).toBe("failed");
    expect(successEvents.listOutbox()[0].status).toBe("succeeded");
    expect(missingEventOutbox.listOutbox()[0].status).toBe("failed");
  });

  it("bounds persistent event mirrors without changing no-db debug mirrors", async () => {
    const persisted = new EventService(undefined, undefined, { append: async () => {} }, "org_mirror", {
      mirrorLimit: 2
    });
    const local = new EventService();

    for (const scopeId of ["request-1", "request-2", "request-3"]) {
      await persisted.append({
        scopeType: "request",
        scopeId,
        producer: "test",
        eventType: "test.event",
        payload: { scopeId }
      });
      await local.append({
        scopeType: "request",
        scopeId,
        producer: "test",
        eventType: "test.event"
      });
    }

    expect(persisted.mirrorIsBounded()).toBe(true);
    expect(persisted.listEvents().map((event) => event.scopeId)).toEqual(["request-2", "request-3"]);
    expect(persisted.listOutbox()).toHaveLength(2);
    expect(local.mirrorIsBounded()).toBe(false);
    expect(local.listEvents()).toHaveLength(3);
  });

  it("uses persistent sequences when scope state is evicted", async () => {
    const sequences = new Map<string, number>();
    const events = new EventService(undefined, undefined, {
      append: async (event) => {
        const key = `${event.tenantId}:${event.scopeType}:${event.scopeId}`;
        const sequence = (sequences.get(key) ?? 0) + 1;
        sequences.set(key, sequence);
        return { sequence };
      }
    }, "org_mirror", { scopeLimit: 1 });

    await events.append({
      scopeType: "request",
      scopeId: "request-a",
      producer: "test",
      eventType: "test.event"
    });
    await events.append({
      scopeType: "request",
      scopeId: "request-b",
      producer: "test",
      eventType: "test.event"
    });
    const event = await events.append({
      scopeType: "request",
      scopeId: "request-a",
      producer: "test",
      eventType: "test.event"
    });

    expect(event.sequence).toBe(2);
    expect(events.listEvents().map((item) => [item.scopeId, item.sequence])).toEqual([
      ["request-a", 1],
      ["request-b", 1],
      ["request-a", 2]
    ]);
  });

  it("drops queued events deterministically at entry capacity", async () => {
    const appended: string[] = [];
    const drops: string[] = [];
    const writer = new BoundedEventWriter({
      async append(input) {
        appended.push(input.scopeId);
      }
    }, {
      maxEntries: 2,
      maxBytes: 10_000,
      onDrop: (input, reason) => drops.push(`${input.scopeId}:${reason}`)
    });

    expect(writer.enqueue(eventInput("request-1"))).toBe("queued");
    expect(writer.enqueue(eventInput("request-2"))).toBe("queued");
    expect(writer.enqueue(eventInput("request-3"))).toBe("dropped");

    expect(writer.stats()).toMatchObject({
      depth: 2,
      dropped: 1
    });
    await writer.drain(100);

    expect(appended).toEqual(["request-1", "request-2"]);
    expect(drops).toEqual(["request-3:capacity"]);
    expect(writer.stats().depth).toBe(0);
  });

  it("drops queued events deterministically at byte capacity", () => {
    const drops: string[] = [];
    const writer = new BoundedEventWriter({
      async append() {}
    }, {
      maxEntries: 2,
      maxBytes: 1,
      onDrop: (input, reason) => drops.push(`${input.scopeId}:${reason}`)
    });

    expect(writer.enqueue(eventInput("request-large"))).toBe("dropped");
    expect(writer.stats()).toMatchObject({
      depth: 0,
      dropped: 1,
      queuedBytes: 0
    });
    expect(drops).toEqual(["request-large:capacity"]);
  });

  it("retries failed queued event flushes", async () => {
    let attempts = 0;
    const appended: string[] = [];
    const failures: string[] = [];
    const writer = new BoundedEventWriter({
      async append(input) {
        attempts += 1;
        if (attempts === 1) throw new Error("db_busy");
        appended.push(input.scopeId);
      }
    }, {
      maxEntries: 2,
      maxBytes: 10_000,
      retryDelayMs: 1,
      onFlushFailure: (_error, input, attempt) => failures.push(`${input.scopeId}:${attempt}`)
    });

    writer.enqueue(eventInput("request-retry"));
    const stats = await writer.drain(100);

    expect(appended).toEqual(["request-retry"]);
    expect(failures).toEqual(["request-retry:1"]);
    expect(stats).toMatchObject({
      depth: 0,
      dropped: 0,
      flushFailures: 1
    });
  });

  it("drains queued events before shutdown timeout", async () => {
    const appended: string[] = [];
    const writer = new BoundedEventWriter({
      async append(input) {
        appended.push(input.scopeId);
      }
    }, {
      maxEntries: 2,
      maxBytes: 10_000
    });

    writer.enqueue(eventInput("request-drain-1"));
    writer.enqueue(eventInput("request-drain-2"));
    const stats = await writer.drain(100);

    expect(appended).toEqual(["request-drain-1", "request-drain-2"]);
    expect(stats).toMatchObject({
      depth: 0,
      queuedBytes: 0
    });
  });

  it("bounds provider attempt mirrors", () => {
    const attempts = new ProviderAttemptStore({ maxAttempts: 2 });

    attempts.create({
      idempotencyKey: "idem-1",
      requestId: "request-1",
      surface: "openai-responses",
      provider: "openai",
      model: "gpt-test"
    });
    attempts.create({
      idempotencyKey: "idem-2",
      requestId: "request-2",
      surface: "openai-responses",
      provider: "openai",
      model: "gpt-test"
    });
    attempts.create({
      idempotencyKey: "idem-3",
      requestId: "request-3",
      surface: "openai-responses",
      provider: "openai",
      model: "gpt-test"
    });

    expect(attempts.list().map((attempt) => attempt.requestId)).toEqual(["request-2", "request-3"]);
  });

  function eventInput(scopeId: string): AppendEventInput {
    return {
      scopeType: "request",
      scopeId,
      producer: "test",
      eventType: "test.event",
      payload: { scopeId }
    };
  }

  it("bounds session route debug state", () => {
    const sessions = new SessionRouteStore(undefined, 2);

    for (const sessionId of ["session-1", "session-2", "session-3"]) {
      sessions.commit({
        sessionKey: sessionId,
        sessionId,
        currentRoute: "fast",
        selectedRoute: "fast",
        action: "stored"
      });
    }

    expect(sessions.list().map((session) => session.sessionId)).toEqual(["session-2", "session-3"]);
  });
});
