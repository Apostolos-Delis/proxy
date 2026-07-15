import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { defaultWorkspaceId, type ProxyTransaction } from "@proxy/db";
import { z } from "zod";

import {
  type MetricsCollector,
  NoopMetricsCollector
} from "./metrics.js";
import type { JsonObject, JsonValue, ProviderAttempt, Surface } from "./types.js";
import { createId, sha256, stableJson } from "./util.js";

const eventSchema = z.object({
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
  scopeType: z.string().min(1),
  scopeId: z.string().min(1),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  parentEventId: z.string().optional(),
  causationId: z.string().optional(),
  correlationId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  actor: z.object({
    type: z.enum(["user", "system", "proxy", "provider"]),
    id: z.string().min(1)
  }),
  producer: z.string().min(1),
  eventType: z.string().min(1),
  payloadHash: z.string().min(1),
  sensitivity: z.enum(["public", "internal", "confidential"]),
  redactionState: z.enum(["not_redacted", "redacted", "not_applicable"]),
  payload: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1)
});

export type ProxyEvent = z.infer<typeof eventSchema>;

export type OutboxItem = {
  outboxId: string;
  eventId: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  queuedAt: string;
  error?: string;
};

type PersistentEventAppendResult = {
  sequence: number;
};

export type PersistentEventSink = {
  append(event: ProxyEvent, outbox: OutboxItem): Promise<PersistentEventAppendResult | void>;
  appendInTransaction?(
    transaction: ProxyTransaction,
    event: ProxyEvent,
    outbox: OutboxItem
  ): Promise<PersistentEventAppendResult | void>;
  afterTransactionCommit?(committed: readonly CommittedTransactionEvent[]): Promise<void>;
};

export type CommittedTransactionEvent = {
  event: ProxyEvent;
  outbox: OutboxItem;
};

export type AppendEventInput = {
  tenantId?: string;
  workspaceId?: string;
  scopeType: string;
  scopeId: string;
  sessionId?: string;
  turnId?: string;
  parentEventId?: string;
  causationId?: string;
  correlationId?: string;
  idempotencyKey?: string;
  actor?: ProxyEvent["actor"];
  producer: string;
  eventType: string;
  sensitivity?: ProxyEvent["sensitivity"];
  redactionState?: ProxyEvent["redactionState"];
  payload?: JsonObject;
  metadata?: JsonObject;
  createdAt?: string;
};

export type EventAppender = {
  append(input: AppendEventInput): Promise<unknown>;
};

export type EventWriterDropReason = "capacity" | "retries_exhausted";

export type BoundedEventWriterStats = {
  maxEntries: number;
  maxBytes: number;
  depth: number;
  queuedBytes: number;
  dropped: number;
  flushFailures: number;
  lastFlushLatencyMs: number | null;
  oldestEventAgeMs: number;
  flushing: boolean;
};

type BoundedEventWriterOptions = {
  maxEntries: number;
  maxBytes: number;
  batchSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  onDrop?: (input: AppendEventInput, reason: EventWriterDropReason) => void;
  onFlushFailure?: (error: unknown, input: AppendEventInput, attempt: number) => void;
};

type QueuedEvent = {
  input: AppendEventInput;
  bytes: number;
  enqueuedAt: number;
  attempts: number;
};

const defaultEventWriterBatchSize = 25;
const defaultEventWriterMaxAttempts = 3;
const defaultEventWriterRetryDelayMs = 100;

export class BoundedEventWriter implements EventAppender {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly onDrop?: (input: AppendEventInput, reason: EventWriterDropReason) => void;
  private readonly onFlushFailure?: (error: unknown, input: AppendEventInput, attempt: number) => void;
  private readonly queue: QueuedEvent[] = [];
  private queuedBytes = 0;
  private dropped = 0;
  private flushFailures = 0;
  private lastFlushLatencyMs: number | null = null;
  private flushing = false;
  private flushScheduled = false;

  constructor(
    private readonly events: EventAppender,
    options: BoundedEventWriterOptions
  ) {
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
    this.batchSize = options.batchSize ?? defaultEventWriterBatchSize;
    this.maxAttempts = options.maxAttempts ?? defaultEventWriterMaxAttempts;
    this.retryDelayMs = options.retryDelayMs ?? defaultEventWriterRetryDelayMs;
    this.onDrop = options.onDrop;
    this.onFlushFailure = options.onFlushFailure;
  }

  async append(input: AppendEventInput) {
    this.enqueue(input);
  }

  enqueue(input: AppendEventInput) {
    const bytes = eventInputBytes(input);
    if (bytes > this.maxBytes || this.queue.length >= this.maxEntries || this.queuedBytes + bytes > this.maxBytes) {
      this.drop(input, "capacity");
      return "dropped" as const;
    }

    this.queue.push({
      input: structuredClone(input),
      bytes,
      enqueuedAt: Date.now(),
      attempts: 0
    });
    this.queuedBytes += bytes;
    this.scheduleFlush();
    return "queued" as const;
  }

  stats(): BoundedEventWriterStats {
    const oldest = this.queue[0];
    return {
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      depth: this.queue.length,
      queuedBytes: this.queuedBytes,
      dropped: this.dropped,
      flushFailures: this.flushFailures,
      lastFlushLatencyMs: this.lastFlushLatencyMs,
      oldestEventAgeMs: oldest ? Math.max(0, Date.now() - oldest.enqueuedAt) : 0,
      flushing: this.flushing
    };
  }

  async drain(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    this.scheduleFlush();
    while ((this.queue.length > 0 || this.flushing || this.flushScheduled) && Date.now() < deadline) {
      await sleep(Math.min(10, Math.max(1, deadline - Date.now())));
    }
    return this.stats();
  }

  private scheduleFlush(delayMs = 0) {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    if (delayMs > 0) {
      setTimeout(() => {
        this.flushScheduled = false;
        void this.flush();
      }, delayMs);
      return;
    }
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    let processed = 0;
    try {
      while (this.queue.length > 0 && processed < this.batchSize) {
        const item = this.queue[0];
        const started = Date.now();
        try {
          await this.events.append(item.input);
          this.shift();
          this.lastFlushLatencyMs = Date.now() - started;
          processed += 1;
        } catch (error) {
          item.attempts += 1;
          this.flushFailures += 1;
          this.onFlushFailure?.(error, item.input, item.attempts);
          if (item.attempts > this.maxAttempts) {
            this.shift();
            this.drop(item.input, "retries_exhausted");
            processed += 1;
            continue;
          }
          this.scheduleFlush(this.retryDelayMs);
          return;
        }
      }
    } finally {
      this.flushing = false;
      if (this.queue.length > 0 && !this.flushScheduled) {
        this.scheduleFlush();
      }
    }
  }

  private shift() {
    const item = this.queue.shift();
    if (!item) return;
    this.queuedBytes -= item.bytes;
  }

  private drop(input: AppendEventInput, reason: EventWriterDropReason) {
    this.dropped += 1;
    this.onDrop?.(input, reason);
  }
}

function eventInputBytes(input: AppendEventInput) {
  return Buffer.byteLength(stableJson(input));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ScopeState = {
  sequence: number;
  tenantId: string;
  workspaceId: string;
};

type EventServiceOptions = {
  mirrorLimit?: number;
  scopeLimit?: number;
};

const persistentMirrorLimit = 1_000;
const persistentScopeLimit = 50_000;

export class EventService {
  private readonly events: ProxyEvent[] = [];
  private readonly outbox: OutboxItem[] = [];
  private readonly listeners = new Set<(event: ProxyEvent) => void>();
  // One entry per scope so sequence, tenant, and workspace can never diverge
  // (they are committed and rolled back together).
  private readonly scopes = new Map<string, ScopeState>();

  constructor(
    private readonly filePath?: string,
    private readonly outboxHandler?: (event: ProxyEvent) => Promise<void>,
    private readonly persistentSink?: PersistentEventSink,
    private readonly defaultTenantId = "local",
    private readonly metrics: MetricsCollector = new NoopMetricsCollector(),
    options: EventServiceOptions = {}
  ) {
    this.mirrorLimit = options.mirrorLimit ?? (persistentSink ? persistentMirrorLimit : Number.POSITIVE_INFINITY);
    this.scopeLimit = options.scopeLimit ?? (persistentSink ? persistentScopeLimit : Number.POSITIVE_INFINITY);
  }

  private readonly mirrorLimit: number;
  private readonly scopeLimit: number;

  async append(input: AppendEventInput) {
    const scopeKey = `${input.scopeType}:${input.scopeId}`;
    const previousScope = this.scopes.get(scopeKey);
    const sequence = (previousScope?.sequence ?? 0) + 1;
    const tenantId = input.tenantId ?? previousScope?.tenantId ?? this.defaultTenantId;
    const workspaceId = input.workspaceId ?? previousScope?.workspaceId ?? defaultWorkspaceId(tenantId);
    this.scopes.delete(scopeKey);
    this.scopes.set(scopeKey, { sequence, tenantId, workspaceId });

    const event = this.buildEvent(input, sequence, tenantId, workspaceId);
    const outboxItem = this.buildOutbox(event);
    let appendSucceeded = false;

    try {
      try {
        if (this.persistentSink) {
          const result = await this.persistentSink.append(event, outboxItem);
          if (result) {
            event.sequence = result.sequence;
            this.scopes.set(scopeKey, { sequence: result.sequence, tenantId, workspaceId });
          }
        }
      } catch (error) {
        if (this.scopes.get(scopeKey)?.sequence === sequence) {
          if (previousScope === undefined) {
            this.scopes.delete(scopeKey);
          } else {
            this.scopes.set(scopeKey, previousScope);
          }
        }
        throw error;
      }

      this.recordCommitted(event, outboxItem);

      if (this.filePath) {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${JSON.stringify(event)}\n`);
      }

      if (!this.persistentSink) this.recordOutboxHealth();
      appendSucceeded = true;

      if (this.outboxHandler) {
        await this.processOutbox(this.outboxHandler);
      }

      return event;
    } catch (error) {
      if (!appendSucceeded) {
        this.metrics.incrementCounter("proxy_event_appends_total", { outcome: "failed", error_class: "persistence" });
        if (!this.persistentSink) this.recordOutboxHealth();
      }
      throw error;
    }
  }

  async appendInTransaction(transaction: ProxyTransaction, input: AppendEventInput) {
    if (!this.persistentSink?.appendInTransaction) {
      throw new Error("transactional_event_sink_not_configured");
    }
    const scopeKey = `${input.scopeType}:${input.scopeId}`;
    const previousScope = this.scopes.get(scopeKey);
    const tenantId = input.tenantId ?? previousScope?.tenantId ?? this.defaultTenantId;
    const workspaceId = input.workspaceId ?? previousScope?.workspaceId ?? defaultWorkspaceId(tenantId);
    const event = this.buildEvent(input, (previousScope?.sequence ?? 0) + 1, tenantId, workspaceId);
    const outbox = this.buildOutbox(event);
    const result = await this.persistentSink.appendInTransaction(transaction, event, outbox);
    if (result) event.sequence = result.sequence;
    return { event, outbox } satisfies CommittedTransactionEvent;
  }

  async commitTransactionEvents(committed: readonly CommittedTransactionEvent[]) {
    try {
      await this.persistentSink?.afterTransactionCommit?.(committed);
    } catch {
      this.metrics.incrementCounter("proxy_db_errors_total", {
        operation: "event_append_transaction_commit",
        error_class: "persistence"
      });
    }
    for (const { event, outbox } of committed) {
      this.recordCommitted(event, outbox);
      if (this.filePath) {
        try {
          await mkdir(dirname(this.filePath), { recursive: true });
          await appendFile(this.filePath, `${JSON.stringify(event)}\n`);
        } catch {
          this.metrics.incrementCounter("proxy_event_appends_total", {
            outcome: "failed",
            error_class: "mirror"
          });
        }
      }
    }
    if (this.outboxHandler) {
      try {
        await this.processOutbox(this.outboxHandler);
      } catch {
        this.metrics.incrementCounter("proxy_event_outbox_items_total", {
          outcome: "failed",
          error_class: "handler"
        });
      }
    }
  }

  private buildEvent(
    input: AppendEventInput,
    sequence: number,
    tenantId: string,
    workspaceId: string
  ) {
    const payload = input.payload ?? {};
    return eventSchema.parse({
      eventId: createId("event"),
      sequence,
      schemaVersion: 1,
      tenantId,
      workspaceId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      parentEventId: input.parentEventId,
      causationId: input.causationId,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor ?? { type: "proxy", id: "proxy" },
      producer: input.producer,
      eventType: input.eventType,
      payloadHash: sha256(stableJson(payload)),
      sensitivity: input.sensitivity ?? "internal",
      redactionState: input.redactionState ?? "redacted",
      payload,
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? new Date().toISOString()
    });
  }

  private buildOutbox(event: ProxyEvent): OutboxItem {
    return {
      outboxId: createId("outbox"),
      eventId: event.eventId,
      status: "queued",
      queuedAt: new Date().toISOString()
    };
  }

  private recordCommitted(event: ProxyEvent, outbox: OutboxItem) {
    const scopeKey = `${event.scopeType}:${event.scopeId}`;
    const previous = this.scopes.get(scopeKey);
    if (!previous || event.sequence >= previous.sequence) {
      this.scopes.delete(scopeKey);
      this.scopes.set(scopeKey, {
        sequence: event.sequence,
        tenantId: event.tenantId,
        workspaceId: event.workspaceId
      });
    }
    this.trimMap(this.scopes, this.scopeLimit);
    this.pushMirror(this.events, event);
    this.pushMirror(this.outbox, outbox);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore
      }
    }
    this.metrics.incrementCounter("proxy_event_appends_total", { outcome: "succeeded", error_class: "none" });
    this.metrics.incrementCounter("proxy_event_outbox_items_total", { outcome: "queued", error_class: "none" });
  }

  subscribe(listener: (event: ProxyEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listEvents() {
    return this.events.map((event) => structuredClone(event));
  }

  listOutbox() {
    return this.outbox.map((item) => Object.freeze({ ...item }));
  }

  mirrorIsBounded() {
    return Number.isFinite(this.mirrorLimit);
  }

  async processOutbox(handler: (event: ProxyEvent) => Promise<void>) {
    for (const item of this.outbox) {
      if (item.status !== "queued") continue;
      item.status = "processing";
      this.metrics.incrementCounter("proxy_event_outbox_items_total", { outcome: "processing", error_class: "none" });
      const event = this.events.find((candidate) => candidate.eventId === item.eventId);
      try {
        if (!event) throw new Error("Outbox event not found.");
        await handler(event);
        item.status = "succeeded";
        delete item.error;
        this.metrics.incrementCounter("proxy_event_outbox_items_total", { outcome: "succeeded", error_class: "none" });
      } catch (error) {
        item.status = "failed";
        item.error = error instanceof Error ? error.message : "Outbox handler failed.";
        this.metrics.incrementCounter("proxy_event_outbox_items_total", { outcome: "failed", error_class: "unknown" });
      }
    }
    if (!this.persistentSink) this.recordOutboxHealth();
  }

  private recordOutboxHealth() {
    const queued = this.outbox.filter((item) => item.status === "queued");
    this.metrics.setGauge("proxy_outbox_backlog", queued.length);
    const oldestQueuedAt = queued
      .map((item) => new Date(item.queuedAt).getTime())
      .filter((time) => Number.isFinite(time))
      .sort((left, right) => left - right)[0];
    this.metrics.setGauge(
      "proxy_outbox_oldest_item_age_seconds",
      oldestQueuedAt === undefined ? 0 : Math.max(0, (Date.now() - oldestQueuedAt) / 1000)
    );
  }

  private pushMirror<T>(items: T[], item: T) {
    if (this.mirrorLimit <= 0) return;
    items.push(item);
    while (items.length > this.mirrorLimit) {
      items.shift();
    }
  }

  private trimMap<K, V>(items: Map<K, V>, limit: number) {
    if (!Number.isFinite(limit)) return;
    while (items.size > limit) {
      const oldest = items.keys().next().value;
      if (oldest === undefined) return;
      items.delete(oldest);
    }
  }
}

type ProviderAttemptStoreOptions = {
  maxAttempts?: number;
};

export class ProviderAttemptStore {
  private readonly attempts = new Map<string, ProviderAttempt>();
  private readonly idempotency = new Map<string, string>();
  private readonly attemptIdempotency = new Map<string, string>();

  constructor(private readonly options: ProviderAttemptStoreOptions = {}) {}

  create(input: {
    idempotencyKey: string;
    requestId: string;
    surface: Surface;
    provider: ProviderAttempt["provider"];
    model: string;
    adapterKind?: ProviderAttempt["adapterKind"];
    providerAccountId?: string;
  }) {
    const existingId = this.idempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.attempts.get(existingId);
      if (existing && existing.terminalStatus === "pending") {
        return { attempt: existing, duplicate: true };
      }
    }

    const attempt: ProviderAttempt = {
      id: createId("provider_attempt"),
      requestId: input.requestId,
      surface: input.surface,
      provider: input.provider,
      model: input.model,
      adapterKind: input.adapterKind,
      providerAccountId: input.providerAccountId,
      terminalStatus: "pending"
    };
    this.attempts.set(attempt.id, attempt);
    this.idempotency.set(input.idempotencyKey, attempt.id);
    this.attemptIdempotency.set(attempt.id, input.idempotencyKey);
    this.trim();

    return { attempt, duplicate: false };
  }

  update(id: string, patch: Partial<ProviderAttempt>) {
    const current = this.attempts.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.attempts.set(id, next);
    return next;
  }

  get(id: string) {
    return this.attempts.get(id);
  }

  list() {
    return [...this.attempts.values()];
  }

  private trim() {
    const limit = this.options.maxAttempts ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(limit)) return;
    while (this.attempts.size > limit) {
      const oldestAttemptId = this.attempts.keys().next().value;
      if (oldestAttemptId === undefined) return;
      this.attempts.delete(oldestAttemptId);
      const idempotencyKey = this.attemptIdempotency.get(oldestAttemptId);
      this.attemptIdempotency.delete(oldestAttemptId);
      if (idempotencyKey && this.idempotency.get(idempotencyKey) === oldestAttemptId) {
        this.idempotency.delete(idempotencyKey);
      }
    }
  }
}

export type RequestState = {
  idempotencyKey: string;
  requestId?: string;
  status: "classifying" | "provider_pending" | "completed" | "failed" | "cancelled";
  providerAttemptId?: string;
  usage?: JsonValue;
  upstreamRequestId?: string;
  error?: string;
};

export type RequestStateGate = {
  state: RequestState;
  duplicate: boolean;
};

export type RequestStateStoreLike = {
  begin(idempotencyKey: string, requestId?: string, context?: unknown): RequestStateGate | Promise<RequestStateGate>;
  markProviderPending(idempotencyKey: string, providerAttemptId: string, requestId?: string): RequestState | undefined | Promise<RequestState | undefined>;
  finish(idempotencyKey: string, status: RequestState["status"], patch?: Partial<RequestState>): RequestState | undefined | Promise<RequestState | undefined>;
};

export class RequestStateStore {
  private readonly states = new Map<string, RequestState>();

  begin(idempotencyKey: string, requestId?: string) {
    const existing = this.states.get(idempotencyKey);
    if (existing && (existing.status === "classifying" || existing.status === "provider_pending")) {
      return { state: existing, duplicate: true };
    }

    const state: RequestState = {
      idempotencyKey,
      requestId,
      status: "classifying"
    };
    this.states.set(idempotencyKey, state);
    return { state, duplicate: false };
  }

  markProviderPending(idempotencyKey: string, providerAttemptId: string, requestId?: string) {
    const patch: Partial<RequestState> = {
      status: "provider_pending",
      providerAttemptId
    };
    if (requestId) patch.requestId = requestId;
    return this.patch(idempotencyKey, patch);
  }

  finish(idempotencyKey: string, status: RequestState["status"], patch: Partial<RequestState> = {}) {
    const current = this.states.get(idempotencyKey);
    if (current && isTerminalStatus(status) && isTerminalStatus(current.status)) return current;
    return this.patch(idempotencyKey, {
      ...patch,
      status
    });
  }

  get(idempotencyKey: string) {
    return this.states.get(idempotencyKey);
  }

  private patch(idempotencyKey: string, patch: Partial<RequestState>) {
    const current = this.states.get(idempotencyKey);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.states.set(idempotencyKey, next);
    return next;
  }
}

function isTerminalStatus(status: RequestState["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function jsonPayload(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(jsonPayload);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = jsonPayload(item);
    }
    return result;
  }
  return null;
}
