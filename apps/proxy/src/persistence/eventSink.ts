import { performance } from "node:perf_hooks";

import { and, asc, eq, sql } from "drizzle-orm";

import {
  createPostgresDatabase,
  createTransactionalDatabase,
  eventOutbox,
  events,
  type PromptProxyDatabase,
  type PromptProxyTransaction,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";

import type { OutboxItem, PersistentEventSink, ProxyEvent } from "../events.js";
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

export function createDatabaseEventSink(db: PromptProxyDatabase) {
  return new DatabaseEventSink(createTransactionalDatabase(db), false);
}

export class DatabaseEventSink implements PersistentEventSink {
  constructor(
    private readonly db: PromptProxyTransactionalDatabase,
    private readonly useAdvisoryLocks: boolean,
    private readonly metrics: MetricsCollector = new NoopMetricsCollector()
  ) {}

  async append(event: ProxyEvent, outbox: OutboxItem) {
    const startedAtMs = performance.now();
    try {
      await this.db.transaction(async (tx) => {
        await ensureOrganization(tx, event.tenantId);
        const sequence = await nextEventSequence(tx, event, this.useAdvisoryLocks);
        await projectEvent(tx, event);
        await tx.insert(events).values({
          id: event.eventId,
          sequence,
          schemaVersion: event.schemaVersion,
          organizationId: event.tenantId,
          workspaceId: event.workspaceId,
          scopeType: event.scopeType,
          scopeId: event.scopeId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          parentEventId: event.parentEventId,
          causationId: event.causationId,
          correlationId: event.correlationId,
          idempotencyKey: event.idempotencyKey,
          actorType: event.actor.type,
          actorId: event.actor.id,
          producer: event.producer,
          eventType: event.eventType,
          payloadHash: event.payloadHash,
          sensitivity: event.sensitivity,
          redactionState: event.redactionState,
          payload: event.payload,
          metadata: event.metadata,
          createdAt: new Date(event.createdAt)
        });
        await tx.insert(eventOutbox).values({
          id: outbox.outboxId,
          eventId: event.eventId,
          status: outbox.status
        });
      });
      this.metrics.observeHistogram("prompt_proxy_db_query_duration_seconds", (performance.now() - startedAtMs) / 1000, {
        operation: "event_append",
        outcome: "succeeded"
      });
      await this.recordDurableOutboxHealth();
    } catch (error) {
      this.metrics.observeHistogram("prompt_proxy_db_query_duration_seconds", (performance.now() - startedAtMs) / 1000, {
        operation: "event_append",
        outcome: "failed"
      });
      this.metrics.incrementCounter("prompt_proxy_db_errors_total", {
        operation: "event_append",
        error_class: "persistence"
      });
      throw error;
    }
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

        this.metrics.setGauge("prompt_proxy_outbox_backlog", Number(countRow?.backlog ?? 0));
        const oldestCreatedAt = oldest?.createdAt === undefined
          ? undefined
          : new Date(oldest.createdAt).getTime();
        this.metrics.setGauge(
          "prompt_proxy_outbox_oldest_item_age_seconds",
          oldestCreatedAt === undefined || !Number.isFinite(oldestCreatedAt)
            ? 0
            : Math.max(0, (Date.now() - oldestCreatedAt) / 1000)
        );
      });
    } catch {
      this.metrics.incrementCounter("prompt_proxy_db_errors_total", {
        operation: "outbox_health",
        error_class: "persistence"
      });
    }
  }
}

async function nextEventSequence(
  tx: PromptProxyTransaction,
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
