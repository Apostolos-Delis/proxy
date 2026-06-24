import { request as httpRequest, type IncomingMessage } from "node:http";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminAuthService } from "../src/adminAuth.js";
import { AdminEventStream, registerAdminEventStream } from "../src/adminEvents.js";
import { EventService, type ProxyEvent } from "../src/events.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

function liveEvent(overrides: Partial<ProxyEvent> = {}): ProxyEvent {
  return {
    eventId: "event_1",
    sequence: 1,
    schemaVersion: 1,
    tenantId: "org_a",
    workspaceId: "ws_a",
    scopeType: "request",
    scopeId: "request_1",
    actor: { type: "proxy", id: "proxy" },
    producer: "test",
    eventType: "proxy.request_received",
    payloadHash: "sha256:test",
    sensitivity: "internal",
    redactionState: "redacted",
    payload: {},
    metadata: {},
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function dataFrames(writes: string[]) {
  return writes.filter((chunk) => chunk.startsWith("data:")).length;
}

function openAdminEvents(url: string) {
  return new Promise<{ response: IncomingMessage; close: () => void }>((resolve, reject) => {
    const request = httpRequest(`${url}/admin/events`, { method: "GET" }, (response) => {
      response.resume();
      response.on("error", () => {});
      resolve({
        response,
        close: () => {
          response.destroy();
          request.destroy();
        }
      });
    });
    request.once("error", reject);
    request.end();
  });
}

describe("AdminEventStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks immediately when idle and coalesces bursts into one trailing tick", () => {
    vi.useFakeTimers();
    const stream = new AdminEventStream(2000);
    const writes: string[] = [];
    stream.subscribe("org_a:ws_a", { write: (chunk) => writes.push(chunk), end: () => {} });

    stream.notify(liveEvent());
    expect(dataFrames(writes)).toBe(1);

    stream.notify(liveEvent());
    stream.notify(liveEvent());
    stream.notify(liveEvent());
    expect(dataFrames(writes)).toBe(1);

    vi.advanceTimersByTime(2000);
    expect(dataFrames(writes)).toBe(2);

    vi.advanceTimersByTime(5000);
    stream.notify(liveEvent());
    expect(dataFrames(writes)).toBe(3);
  });

  it("only ticks subscribers of the event's org and workspace", () => {
    vi.useFakeTimers();
    const stream = new AdminEventStream(2000);
    const writes: string[] = [];
    stream.subscribe("org_a:ws_a", { write: (chunk) => writes.push(chunk), end: () => {} });

    stream.notify(liveEvent({ workspaceId: "ws_b" }));
    stream.notify(liveEvent({ tenantId: "org_b" }));
    vi.advanceTimersByTime(5000);
    expect(dataFrames(writes)).toBe(0);
  });

  it("ignores events outside request and session scopes", () => {
    vi.useFakeTimers();
    const stream = new AdminEventStream(2000);
    const writes: string[] = [];
    stream.subscribe("org_a:ws_a", { write: (chunk) => writes.push(chunk), end: () => {} });

    stream.notify(liveEvent({ scopeType: "admin" }));
    vi.advanceTimersByTime(5000);
    expect(dataFrames(writes)).toBe(0);

    stream.notify(liveEvent({ scopeType: "session", scopeId: "session_1" }));
    expect(dataFrames(writes)).toBe(1);
  });

  it("stops ticking after unsubscribe and ends subscribers on close", () => {
    vi.useFakeTimers();
    const stream = new AdminEventStream(2000);
    const writes: string[] = [];
    const unsubscribe = stream.subscribe("org_a:ws_a", { write: (chunk) => writes.push(chunk), end: () => {} });
    unsubscribe();
    stream.notify(liveEvent());
    vi.advanceTimersByTime(5000);
    expect(dataFrames(writes)).toBe(0);

    let ended = false;
    stream.subscribe("org_a:ws_a", { write: () => {}, end: () => { ended = true; } });
    stream.close();
    expect(ended).toBe(true);
    stream.notify(liveEvent());
    expect(dataFrames(writes)).toBe(0);
  });

  it("emits heartbeat comments while subscribers are connected and stops after the last leaves", () => {
    vi.useFakeTimers();
    const stream = new AdminEventStream(2000);
    const writes: string[] = [];
    const unsubscribe = stream.subscribe("org_a:ws_a", { write: (chunk) => writes.push(chunk), end: () => {} });

    vi.advanceTimersByTime(25_000);
    expect(writes).toContain(":hb\n\n");

    unsubscribe();
    const heartbeats = writes.length;
    vi.advanceTimersByTime(60_000);
    expect(writes.length).toBe(heartbeats);
  });
});

describe("registerAdminEventStream connection lifecycle", () => {
  function streamApp(resolve: AdminAuthService["resolve"]) {
    const app = Fastify();
    const stream = registerAdminEventStream(
      app,
      new EventService(),
      { resolve } as unknown as AdminAuthService
    );
    return { app, stream };
  }

  function identity() {
    return Promise.resolve({
      sessionId: "session_1",
      organizationId: "org_a",
      workspaceId: "ws_a",
      userId: "user_1",
      role: "owner"
    });
  }

  it("removes the subscriber when an established client disconnects", async () => {
    const { app, stream } = streamApp(() => identity());
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    let client: Awaited<ReturnType<typeof openAdminEvents>> | undefined;
    try {
      client = await openAdminEvents(url);
      expect(client.response.statusCode).toBe(200);
      await vi.waitFor(() => expect(stream.size()).toBe(1));

      client.close();
      await vi.waitFor(() => expect(stream.size()).toBe(0));
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("does not retain a subscriber when the client disconnects during auth", async () => {
    let entered!: () => void;
    const enteredAuth = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, stream } = streamApp(async () => {
      entered();
      await gate;
      return identity();
    });
    const subscribed = vi.spyOn(stream, "subscribe");
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const controller = new AbortController();
      const pending = fetch(`${url}/admin/events`, { signal: controller.signal });
      await enteredAuth;
      controller.abort();
      await expect(pending).rejects.toThrow();
      release();
      // The handler resumes after release; the subscription must not outlive
      // the already-closed socket.
      await vi.waitFor(() => expect(subscribed).toHaveBeenCalled());
      await vi.waitFor(() => expect(stream.size()).toBe(0));
    } finally {
      await app.close();
    }
  });
});

describe("GET /admin/events", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("rejects callers without an admin session", async () => {
    const fixture = await captureFixture("org_admin_events_auth");
    activeFixture = fixture;

    const response = await fetch(`${fixture.proxyUrl}/admin/events`);
    expect(response.status).toBe(401);
  });

  it("streams an invalidation tick when proxied traffic lands", async () => {
    const fixture = await captureFixture("org_admin_events_tick");
    activeFixture = fixture;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${fixture.proxyUrl}/admin/events`, {
        headers: fixture.adminHeaders,
        signal: controller.signal
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");

      const reader = response.body!.getReader();
      const proxied = await fetch(`${fixture.proxyUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ model: "router-auto", input: "Hello there.", stream: true })
      });
      await proxied.text();

      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("data: {}")) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
      expect(received).toContain("retry: 5000");
      expect(received).toContain("data: {}");
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }, 20_000);
});
