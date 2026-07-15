import { performance } from "node:perf_hooks";

import { and, asc, eq, sql } from "drizzle-orm";

import {
  createPostgresDatabase,
  createTransactionalDatabase,
  eventOutbox,
  events,
  type ProxyDatabase,
  type ProxyTransaction,
  type ProxyTransactionalDatabase
} from "@proxy/db";

import type {
  CommittedTransactionEvent,
  OutboxItem,
  PersistentEventSink,
  ProxyEvent
} from "../events.js";
import { ensureOrganization } from "./identity.js";
import { projectEvent } from "./eventProjector.js";
import {
  type MetricsCollector,
  NoopMetricsCollector
} from "../metrics.js";

export function createPostgresEventSink(databaseUrl: string) {
  const db = createPostgresDatabase(databaseUrl);
  return new DatabaseEventSink(createTransactionalDatabase(db), true);
}

export function createDatabaseEventSink(db: ProxyDatabase) {
  return new DatabaseEventSink(createTransactionalDatabase(db), false);
}

export class DatabaseEventSink implements PersistentEventSink {
  constructor(
    private readonly db: ProxyTransactionalDatabase,
    private readonly useAdvisoryLocks: boolean,
    private readonly metrics: MetricsCollector = new NoopMetricsCollector()
  ) {}

  async append(event: ProxyEvent, outbox: OutboxItem) {
    const startedAtMs = performance.now();
    let result: { sequence: number };
    try {
      result = await this.db.transaction((tx) => this.appendRows(tx, event, outbox));
      this.metrics.observeHistogram("proxy_db_query_duration_seconds", (performance.now() - startedAtMs) / 1000, {
        operation: "event_append",
        outcome: "succeeded"
      });
      await this.recordDurableOutboxHealth();
    } catch (error) {
      this.metrics.observeHistogram("proxy_db_query_duration_seconds", (performance.now() - startedAtMs) / 1000, {
        operation: "event_append",
        outcome: "failed"
      });
      this.metrics.incrementCounter("proxy_db_errors_total", {
        operation: "event_append",
        error_class: "persistence"
      });
      throw error;
    }
    return result;
  }

  async appendInTransaction(tx: ProxyTransaction, event: ProxyEvent, outbox: OutboxItem) {
    const startedAtMs = performance.now();
    try {
      const result = await this.appendRows(tx, event, outbox);
      this.recordTransactionAppendDuration(startedAtMs, "succeeded");
      return result;
    } catch (error) {
      this.recordTransactionAppendDuration(startedAtMs, "failed");
      this.metrics.incrementCounter("proxy_db_errors_total", {
        operation: "event_append_transaction",
        error_class: "persistence"
      });
      throw error;
    }
  }

  async afterTransactionCommit(committed: readonly CommittedTransactionEvent[]) {
    if (committed.length > 0) await this.recordDurableOutboxHealth();
  }

  private async recordDurableOutboxHealth() {
    try {
      await this.db.transaction(async (tx) => {
        const [countRow] = await tx
          .select({ backlog: sql<number>`count(*)::int` })
          .from(eventOutbox)
          .where(eq(eventOutbox.status, "queued"));
        const [oldest] = await tx
          .select({ createdAt: eventOutbox.createdAt })
          .from(eventOutbox)
          .where(eq(eventOutbox.status, "queued"))
          .orderBy(asc(eventOutbox.createdAt))
          .limit(1);

        this.metrics.setGauge("proxy_outbox_backlog", Number(countRow?.backlog ?? 0));
        const oldestCreatedAt = oldest?.createdAt === undefined
          ? undefined
          : new Date(oldest.createdAt).getTime();
        this.metrics.setGauge(
          "proxy_outbox_oldest_item_age_seconds",
          oldestCreatedAt === undefined || !Number.isFinite(oldestCreatedAt)
            ? 0
            : Math.max(0, (Date.now() - oldestCreatedAt) / 1000)
        );
      });
    } catch {
      this.metrics.incrementCounter("proxy_db_errors_total", {
        operation: "outbox_health",
        error_class: "persistence"
      });
    }
  }

  private async appendRows(tx: ProxyTransaction, event: ProxyEvent, outbox: OutboxItem) {
    await ensureOrganization(tx, event.tenantId);
    const sequence = await nextEventSequence(tx, event, this.useAdvisoryLocks);
    const storedEvent = { ...event, sequence };
    await projectEvent(tx, storedEvent);
    await tx.insert(events).values({
      id: storedEvent.eventId,
      sequence,
      schemaVersion: storedEvent.schemaVersion,
      organizationId: storedEvent.tenantId,
      workspaceId: storedEvent.workspaceId,
      scopeType: storedEvent.scopeType,
      scopeId: storedEvent.scopeId,
      sessionId: storedEvent.sessionId,
      turnId: storedEvent.turnId,
      parentEventId: storedEvent.parentEventId,
      causationId: storedEvent.causationId,
      correlationId: storedEvent.correlationId,
      idempotencyKey: storedEvent.idempotencyKey,
      actorType: storedEvent.actor.type,
      actorId: storedEvent.actor.id,
      producer: storedEvent.producer,
      eventType: storedEvent.eventType,
      payloadHash: storedEvent.payloadHash,
      sensitivity: storedEvent.sensitivity,
      redactionState: storedEvent.redactionState,
      payload: storedEvent.payload,
      metadata: storedEvent.metadata,
      createdAt: new Date(storedEvent.createdAt)
    });
    await tx.insert(eventOutbox).values({
      id: outbox.outboxId,
      eventId: storedEvent.eventId,
      status: outbox.status
    });
    return { sequence };
  }

  private recordTransactionAppendDuration(startedAtMs: number, outcome: "succeeded" | "failed") {
    this.metrics.observeHistogram("proxy_db_query_duration_seconds", (performance.now() - startedAtMs) / 1000, {
      operation: "event_append_transaction",
      outcome
    });
  }
}

async function nextEventSequence(
  tx: ProxyTransaction,
  event: ProxyEvent,
  useAdvisoryLocks: boolean
) {
  if (useAdvisoryLocks) {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtext(${`${event.tenantId}:${event.scopeType}:${event.scopeId}`}))
    `);
  }

  const [row] = await tx
    .select({
      sequence: sql<number>`coalesce(max(${events.sequence}), 0) + 1`
    })
    .from(events)
    .where(and(
      eq(events.organizationId, event.tenantId),
      eq(events.scopeType, event.scopeType),
      eq(events.scopeId, event.scopeId)
    ));

  return Number(row?.sequence ?? event.sequence);
}
