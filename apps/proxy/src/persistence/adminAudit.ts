import { and, eq, sql } from "drizzle-orm";

import {
  eventOutbox,
  events,
  type ProxyTransaction
} from "@proxy/db";

import { createId, sha256, stableJson } from "../util.js";

export type AdminAuditEventInput = {
  organizationId: string;
  // Set for workspace-scoped entities (api keys, routing configs); org-level
  // entities (users, invitations, provider accounts) leave it null.
  workspaceId?: string | null;
  scopeType: string;
  scopeId: string;
  correlationId?: string;
  actorUserId: string;
  producer: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt?: Date;
};

export async function appendAdminAuditEvent(tx: ProxyTransaction, input: AdminAuditEventInput) {
  const createdAt = input.createdAt ?? new Date();
  const eventId = createId("event");
  const payload = input.payload;
  await tx.insert(events).values({
    id: eventId,
    sequence: await nextEventSequence(tx, input.organizationId, input.scopeType, input.scopeId),
    schemaVersion: 1,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId ?? null,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    correlationId: input.correlationId,
    actorType: "user",
    actorId: input.actorUserId,
    producer: input.producer,
    eventType: input.eventType,
    payloadHash: sha256(stableJson(payload)),
    sensitivity: "internal",
    redactionState: "redacted",
    payload,
    metadata: {},
    createdAt
  });
  await tx.insert(eventOutbox).values({
    id: createId("outbox"),
    eventId
  });
}

async function nextEventSequence(
  tx: ProxyTransaction,
  organizationId: string,
  scopeType: string,
  scopeId: string
) {
  const [row] = await tx
    .select({
      sequence: sql<number>`coalesce(max(${events.sequence}), 0) + 1`
    })
    .from(events)
    .where(and(
      eq(events.organizationId, organizationId),
      eq(events.scopeType, scopeType),
      eq(events.scopeId, scopeId)
    ));
  return Number(row?.sequence ?? 1);
}
