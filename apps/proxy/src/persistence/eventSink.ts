import { and, eq, sql } from "drizzle-orm";

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
import type { ModelPricingTable } from "../pricing.js";
import { ensureOrganization } from "./identity.js";
import { projectEvent } from "./eventProjector.js";

export function createPostgresEventSink(databaseUrl: string, pricing: ModelPricingTable) {
  const db = createPostgresDatabase(databaseUrl);
  return new DatabaseEventSink(createTransactionalDatabase(db), pricing, true);
}

export function createDatabaseEventSink(db: PromptProxyDatabase, pricing: ModelPricingTable) {
  return new DatabaseEventSink(createTransactionalDatabase(db), pricing, false);
}

export class DatabaseEventSink implements PersistentEventSink {
  constructor(
    private readonly db: PromptProxyTransactionalDatabase,
    private readonly pricing: ModelPricingTable,
    private readonly useAdvisoryLocks: boolean
  ) {}

  async append(event: ProxyEvent, outbox: OutboxItem) {
    await this.db.transaction(async (tx) => {
      await ensureOrganization(tx, event.tenantId);
      const sequence = await nextEventSequence(tx, event, this.useAdvisoryLocks);
      await projectEvent(tx, this.pricing, event);
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
