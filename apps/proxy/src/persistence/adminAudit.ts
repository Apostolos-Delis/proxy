import { and, eq, sql } from "drizzle-orm";

import {
  eventOutbox,
  events,
  type PromptProxyTransaction
} from "@prompt-proxy/db";

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

export async function appendAdminAuditEvent(tx: PromptProxyTransaction, input: AdminAuditEventInput) {
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
  tx: PromptProxyTransaction,
  organizationId: string,
  scopeType: string,
  scopeId: string
) {
  // Serializes concurrent same-scope appenders (e.g. parallel agent tool
  // calls) so max+1 cannot collide on events_scope_sequence_idx.
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`${organizationId}:${scopeType}:${scopeId}`}, 0)
    )
  `);
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
