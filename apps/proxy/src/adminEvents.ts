import type { OutgoingHttpHeaders } from "node:http";

import type { FastifyInstance } from "fastify";

import type { AdminAuthService } from "./adminAuth.js";
import type { EventService, ProxyEvent } from "./events.js";

// Only request- and session-scoped events feed the live console pages;
// admin/config events never need to wake clients.
const LIVE_SCOPE_TYPES = new Set(["request", "session"]);
const DEFAULT_COALESCE_MS = 2000;
const HEARTBEAT_MS = 25_000;
// Connections re-authenticate when the browser's EventSource reconnects, so
// bounding their lifetime makes revoked/expired admin sessions converge
// instead of streaming ticks forever.
const MAX_CONNECTION_MS = 15 * 60_000;

export type AdminEventSubscriber = {
  write: (chunk: string) => void;
  end: () => void;
};

type ThrottleState = {
  lastSentAt: number;
  timer?: NodeJS.Timeout;
};

export function adminEventScopeKey(organizationId: string, workspaceId: string) {
  return `${organizationId}:${workspaceId}`;
}

/**
 * Fans appended proxy events out to admin SSE subscribers as lightweight
 * invalidation ticks, coalesced per organization:workspace scope so a burst
 * of traffic costs each client at most one refetch per window. The first
 * event after a quiet period ticks immediately (snappy when idle); followers
 * within the window fold into a single trailing tick.
 */
export class AdminEventStream {
  private readonly subscribers = new Map<string, Set<AdminEventSubscriber>>();
  private readonly throttles = new Map<string, ThrottleState>();
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly coalesceMs = DEFAULT_COALESCE_MS) {}

  subscribe(scopeKey: string, subscriber: AdminEventSubscriber) {
    let scoped = this.subscribers.get(scopeKey);
    if (!scoped) {
      scoped = new Set();
      this.subscribers.set(scopeKey, scoped);
    }
    scoped.add(subscriber);
    this.ensureHeartbeat();

    return () => {
      const current = this.subscribers.get(scopeKey);
      if (!current) return;
      current.delete(subscriber);
      if (current.size > 0) return;
      this.subscribers.delete(scopeKey);
      const throttle = this.throttles.get(scopeKey);
      if (throttle?.timer) clearTimeout(throttle.timer);
      this.throttles.delete(scopeKey);
      if (this.subscribers.size === 0) this.stopHeartbeat();
    };
  }

  size() {
    let total = 0;
    for (const scoped of this.subscribers.values()) total += scoped.size;
    return total;
  }

  notify(event: ProxyEvent) {
    if (!LIVE_SCOPE_TYPES.has(event.scopeType)) return;
    const scopeKey = adminEventScopeKey(event.tenantId, event.workspaceId);
    if (!this.subscribers.has(scopeKey)) return;

    let throttle = this.throttles.get(scopeKey);
    if (!throttle) {
      throttle = { lastSentAt: 0 };
      this.throttles.set(scopeKey, throttle);
    }
    if (throttle.timer) return;

    const wait = throttle.lastSentAt + this.coalesceMs - Date.now();
    if (wait <= 0) {
      this.tick(scopeKey, throttle);
      return;
    }
    throttle.timer = setTimeout(() => {
      throttle.timer = undefined;
      this.tick(scopeKey, throttle);
    }, wait);
    throttle.timer.unref?.();
  }

  close() {
    this.stopHeartbeat();
    for (const throttle of this.throttles.values()) {
      if (throttle.timer) clearTimeout(throttle.timer);
    }
    this.throttles.clear();
    for (const scoped of this.subscribers.values()) {
      for (const subscriber of scoped) {
        try {
          subscriber.end();
        } catch {
          // ignore
        }
      }
    }
    this.subscribers.clear();
  }

  private tick(scopeKey: string, throttle: ThrottleState) {
    throttle.lastSentAt = Date.now();
    const scoped = this.subscribers.get(scopeKey);
    if (!scoped) return;
    for (const subscriber of scoped) this.write(subscriber, "data: {}\n\n");
  }

  // One bad subscriber callback must not break fan-out to the others, and
  // ticks fire from timer context where a throw would be uncaught.
  private write(subscriber: AdminEventSubscriber, chunk: string) {
    try {
      subscriber.write(chunk);
    } catch {
      // ignore
    }
  }

  private ensureHeartbeat() {
    if (this.heartbeat) return;
    // Comment frames keep intermediaries from idling out quiet connections
    // and let the runtime notice dead sockets.
    this.heartbeat = setInterval(() => {
      for (const scoped of this.subscribers.values()) {
        for (const subscriber of scoped) this.write(subscriber, ":hb\n\n");
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat() {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

// Server-sent invalidation ticks for the admin console: clients hold one SSE
// connection and refetch their queries when their org/workspace sees traffic.
export function registerAdminEventStream(
  app: FastifyInstance,
  events: EventService,
  adminAuth: AdminAuthService
) {
  const stream = new AdminEventStream();
  const unsubscribeEvents = events.subscribe((event) => stream.notify(event));
  app.addHook("onClose", async () => {
    unsubscribeEvents();
    stream.close();
  });

  app.get("/admin/events", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    reply.hijack();
    // Hijacked replies bypass Fastify's send path, so re-emit the headers
    // already set by hooks (CORS) alongside the SSE ones. x-accel-buffering
    // stops nginx-class ingresses from buffering the stream.
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no"
    });
    reply.raw.write("retry: 5000\n\n");

    const unsubscribe = stream.subscribe(
      adminEventScopeKey(identity.organizationId, identity.workspaceId),
      {
        write: (chunk) => {
          // Writes to a destroyed response fail via an async 'error' emission
          // a try/catch cannot see.
          if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(chunk);
        },
        end: () => {
          reply.raw.end();
        }
      }
    );
    const lifetime = setTimeout(() => reply.raw.end(), MAX_CONNECTION_MS);
    lifetime.unref?.();
    request.raw.on("close", () => {
      clearTimeout(lifetime);
      unsubscribe();
    });
    // The socket may have closed during the auth await, before the close
    // listener existed — that event will never re-fire.
    if (request.raw.destroyed) {
      clearTimeout(lifetime);
      unsubscribe();
    }
  });

  return stream;
}
