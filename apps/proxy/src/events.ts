import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { JsonObject, JsonValue, ProviderAttempt, Surface } from "./types.js";
import { createId, sha256, stableJson } from "./util.js";

const eventSchema = z.object({
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1),
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
  error?: string;
};

export type PersistentEventSink = {
  append(event: ProxyEvent, outbox: OutboxItem): Promise<void>;
};

export type AppendEventInput = {
  tenantId?: string;
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
};

export class EventService {
  private readonly events: ProxyEvent[] = [];
  private readonly outbox: OutboxItem[] = [];
  private readonly sequences = new Map<string, number>();

  constructor(
    private readonly filePath?: string,
    private readonly outboxHandler?: (event: ProxyEvent) => Promise<void>,
    private readonly persistentSink?: PersistentEventSink,
    private readonly defaultTenantId = "local"
  ) {}

  async append(input: AppendEventInput) {
    const scopeKey = `${input.scopeType}:${input.scopeId}`;
    const previousSequence = this.sequences.get(scopeKey) ?? 0;
    const sequence = previousSequence + 1;
    this.sequences.set(scopeKey, sequence);

    const payload = input.payload ?? {};
    const event = eventSchema.parse({
      eventId: createId("event"),
      sequence,
      schemaVersion: 1,
      tenantId: input.tenantId ?? this.defaultTenantId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      parentEventId: input.parentEventId,
      causationId: input.causationId,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor ?? { type: "proxy", id: "prompt-proxy" },
      producer: input.producer,
      eventType: input.eventType,
      payloadHash: sha256(stableJson(payload)),
      sensitivity: input.sensitivity ?? "internal",
      redactionState: input.redactionState ?? "redacted",
      payload,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString()
    });

    const outboxItem: OutboxItem = { outboxId: createId("outbox"), eventId: event.eventId, status: "queued" };

    try {
      if (this.persistentSink) {
        await this.persistentSink.append(event, outboxItem);
      }
    } catch (error) {
      if (this.sequences.get(scopeKey) === sequence) {
        if (previousSequence === 0) {
          this.sequences.delete(scopeKey);
        } else {
          this.sequences.set(scopeKey, previousSequence);
        }
      }
      throw error;
    }

    this.events.push(event);
    this.outbox.push(outboxItem);

    if (this.filePath) {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`);
    }

    if (this.outboxHandler) {
      await this.processOutbox(this.outboxHandler);
    }

    return event;
  }

  listEvents() {
    return this.events.map((event) => structuredClone(event));
  }

  listOutbox() {
    return this.outbox.map((item) => Object.freeze({ ...item }));
  }

  async processOutbox(handler: (event: ProxyEvent) => Promise<void>) {
    for (const item of this.outbox) {
      if (item.status !== "queued") continue;
      item.status = "processing";
      const event = this.events.find((candidate) => candidate.eventId === item.eventId);
      try {
        if (!event) throw new Error("Outbox event not found.");
        await handler(event);
        item.status = "succeeded";
        delete item.error;
      } catch (error) {
        item.status = "failed";
        item.error = error instanceof Error ? error.message : "Outbox handler failed.";
      }
    }
  }
}

export class ProviderAttemptStore {
  private readonly attempts = new Map<string, ProviderAttempt>();
  private readonly idempotency = new Map<string, string>();

  create(input: {
    idempotencyKey: string;
    requestId: string;
    surface: Surface;
    provider: ProviderAttempt["provider"];
    model: string;
  }) {
    const existingId = this.idempotency.get(input.idempotencyKey);
    if (existingId) return { attempt: this.attempts.get(existingId), duplicate: true };

    const attempt: ProviderAttempt = {
      id: createId("provider_attempt"),
      requestId: input.requestId,
      surface: input.surface,
      provider: input.provider,
      model: input.model,
      terminalStatus: "pending"
    };
    this.attempts.set(attempt.id, attempt);
    this.idempotency.set(input.idempotencyKey, attempt.id);

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
  markProviderPending(idempotencyKey: string, providerAttemptId: string): RequestState | undefined | Promise<RequestState | undefined>;
  finish(idempotencyKey: string, status: RequestState["status"], patch?: Partial<RequestState>): RequestState | undefined | Promise<RequestState | undefined>;
};

export class RequestStateStore {
  private readonly states = new Map<string, RequestState>();

  begin(idempotencyKey: string, requestId?: string) {
    const existing = this.states.get(idempotencyKey);
    if (existing) return { state: existing, duplicate: true };

    const state: RequestState = {
      idempotencyKey,
      requestId,
      status: "classifying"
    };
    this.states.set(idempotencyKey, state);
    return { state, duplicate: false };
  }

  markProviderPending(idempotencyKey: string, providerAttemptId: string) {
    return this.patch(idempotencyKey, {
      status: "provider_pending",
      providerAttemptId
    });
  }

  finish(idempotencyKey: string, status: RequestState["status"], patch: Partial<RequestState> = {}) {
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
